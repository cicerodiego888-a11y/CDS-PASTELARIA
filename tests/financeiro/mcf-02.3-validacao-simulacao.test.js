/**
 * MCF-02.3 — Validação dry-run + simulação reconciliação (sem persistência).
 * Executar: node --test tests/financeiro/mcf-02.3-validacao-simulacao.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
const DryRun = require('../../backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService');
const Simulacao = require('../../backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaSimulacaoService');
const { sqlExcluirProjecaoMcf } = require('../../backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard');
const { VERSAO_MCF, STATUS_CONTA_PAGAR } = require('../../backend/motores/mcf/contracts/constantesMcf');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function getRow(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function instrumentarEscritas(db) {
  const escritas = [];
  const originalRun = db.run.bind(db);
  db.run = function(sql, ...args) {
    const s = String(sql || '').trim().toUpperCase();
    if (/^(INSERT|UPDATE|DELETE|REPLACE)/.test(s)) escritas.push(String(sql).slice(0, 120));
    return originalRun(sql, ...args);
  };
  return {
    escritas,
    restaurar() { db.run = originalRun; }
  };
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, cpf_cnpj TEXT
  )`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    categoria TEXT, forma_pagamento TEXT, referencia_id INTEGER,
    referencia_tipo TEXT, status TEXT, origem TEXT, documento TEXT,
    vencimento TEXT, numero_parcela INTEGER, total_parcelas INTEGER,
    compra_id INTEGER, venda_id INTEGER, pessoa_nome TEXT, observacao TEXT,
    baixado_em TEXT, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL
  )`);
  await garantirSchemaMcfAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  return { db, empresaA, empresaB };
}

/**
 * Fixture representativa: match exato, divergência, ambiguidade, pago/parcial/cancelado,
 * projeção, título MCF aberto/parcial/quitado, histórico B isolado.
 */
async function popularFixtureRepresentativa(ctx) {
  const { db, empresaA, empresaB } = ctx;

  // --- Compra 1: título MCF sem projeção + legado exact match → vincular
  const compra1 = await run(db, 'INSERT INTO compras (empresa_id) VALUES (?)', [empresaA.id]);
  const tMatch = await ContasPagarService.criar({
    db, empresaId: empresaA.id, valor_original: 100, data_vencimento: '2026-11-10',
    origem: 'compra', referencia_tipo: 'compra', referencia_id: compra1.lastID,
    numero_parcela: 1, total_parcelas: 1, descricao: 'Match exato'
  });
  await run(db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [tMatch.id]);
  await run(db, `DELETE FROM financeiro WHERE origem = 'mcf_compatibilidade' AND referencia_id = ?`, [tMatch.id]);
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
      numero_parcela, vencimento, empresa_id)
     VALUES ('despesa','Legado match',100,'2026-10-01','pendente','compra',?,1,'2026-11-10',?)`,
    [compra1.lastID, empresaA.id]
  );

  // --- Compra 2: divergência valor/vencimento → revisao
  const compra2 = await run(db, 'INSERT INTO compras (empresa_id) VALUES (?)', [empresaA.id]);
  const tDiv = await ContasPagarService.criar({
    db, empresaId: empresaA.id, valor_original: 80, data_vencimento: '2026-11-15',
    origem: 'compra', referencia_tipo: 'compra', referencia_id: compra2.lastID,
    numero_parcela: 1, total_parcelas: 1, descricao: 'Divergente'
  });
  await run(db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [tDiv.id]);
  await run(db, `DELETE FROM financeiro WHERE origem = 'mcf_compatibilidade' AND referencia_id = ?`, [tDiv.id]);
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
      numero_parcela, vencimento, empresa_id)
     VALUES ('despesa','Legado divergente',99,'2026-10-02','pendente','compra',?,1,'2026-12-01',?)`,
    [compra2.lastID, empresaA.id]
  );

  // --- Compra 3: ambiguidade (2 financeiros → 1 título)
  const compra3 = await run(db, 'INSERT INTO compras (empresa_id) VALUES (?)', [empresaA.id]);
  const tAmb = await ContasPagarService.criar({
    db, empresaId: empresaA.id, valor_original: 50, data_vencimento: '2026-11-01',
    origem: 'compra', referencia_tipo: 'compra', referencia_id: compra3.lastID,
    numero_parcela: 1, total_parcelas: 1, descricao: 'Ambiguo'
  });
  await run(db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [tAmb.id]);
  await run(db, `DELETE FROM financeiro WHERE origem = 'mcf_compatibilidade' AND referencia_id = ?`, [tAmb.id]);
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
      numero_parcela, vencimento, empresa_id)
     VALUES ('despesa','Amb A',50,'2026-10-03','pendente','compra',?,1,'2026-11-01',?),
            ('despesa','Amb B',50,'2026-10-04','pendente','compra',?,1,'2026-11-01',?)`,
    [compra3.lastID, empresaA.id, compra3.lastID, empresaA.id]
  );

  // --- Históricos sem MCF: pago, parcial, cancelado, pendente sem identidade, pendente com fornecedor
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
     VALUES
     ('despesa','Hist pago',40,'2026-09-01','pago','manual',NULL,NULL,NULL,?),
     ('despesa','Hist parcial',60,'2026-09-02','parcial','manual',NULL,NULL,NULL,?),
     ('despesa','Hist cancel',20,'2026-09-03','cancelado','manual',NULL,NULL,NULL,?),
     ('despesa','Sem identidade',15,'2026-09-04','pendente','manual',NULL,NULL,NULL,?),
     ('despesa','Criar titulo',200,'2026-09-05','pendente','manual','Fornecedor X','NF-X','2026-10-10',?)`,
    [empresaA.id, empresaA.id, empresaA.id, empresaA.id, empresaA.id]
  );

  // --- Título MCF parcial com pagamento + projeção (não deve entrar no dry-run candidato)
  const tParc = await ContasPagarService.criar({
    db, empresaId: empresaA.id, valor_original: 300, data_vencimento: '2026-12-01',
    descricao: 'MCF parcial'
  });
  await ContasPagarService.baixar({
    db, empresaId: empresaA.id, id: tParc.id, valor_pago: 100, idempotency_key: 'mcf23-parc'
  });

  // --- Título quitado
  const tQuit = await ContasPagarService.criar({
    db, empresaId: empresaA.id, valor_original: 25, data_vencimento: '2026-08-01',
    descricao: 'MCF quitado'
  });
  await ContasPagarService.baixar({
    db, empresaId: empresaA.id, id: tQuit.id, valor_pago: 25, idempotency_key: 'mcf23-quit'
  });

  // --- Empresa B isolada
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, empresa_id)
     VALUES ('despesa','Só B',44,'2026-09-01','pendente','manual','Forn B',?)`,
    [empresaB.id]
  );

  return {
    tMatch, tDiv, tAmb, tParc, tQuit,
    compra1: compra1.lastID, compra2: compra2.lastID, compra3: compra3.lastID
  };
}

describe('MCF-02.3 — Validação e simulação', () => {
  it('versão MCF-02.x e serviços somente leitura (código)', () => {
    assert.match(String(VERSAO_MCF.SPRINT), /^MCF-02/);
    for (const rel of [
      'ContasPagarReconciliacaoHistoricaSimulacaoService.js',
      'ContasPagarReconciliacaoHistoricaDryRunService.js'
    ]) {
      const src = fs.readFileSync(
        path.join(ROOT, 'backend/motores/mcf/services', rel),
        'utf8'
      );
      const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(codigo, /\bINSERT\s+INTO\b/i);
      assert.doesNotMatch(codigo, /\bUPDATE\s+\w+/i);
      assert.doesNotMatch(codigo, /\bDELETE\s+FROM\b/i);
    }
  });

  it('dry-run: cobertura, totais, estabilidade e classificação representativa', async () => {
    const ctx = await setupBase();
    await popularFixtureRepresentativa(ctx);
    const mon = instrumentarEscritas(ctx.db);
    const rel1 = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    const est = await Simulacao.validarEstabilidadeDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    mon.restaurar();
    assert.equal(mon.escritas.length, 0, mon.escritas.join('|'));
    assert.equal(est.estavel, true);
    assert.ok(rel1.fingerprint);
    assert.ok(rel1.cobertura);
    assert.equal(rel1.cobertura.candidatos_elegiveis, rel1.itens.length);
    assert.ok(rel1.cobertura.projecoes_excluidas >= 1);
    assert.ok(rel1.cobertura.despesas_totais_empresa >= rel1.itens.length);

    const porAcao = rel1.totais_empresa.por_acao;
    assert.ok(porAcao.vincular.quantidade >= 1);
    assert.ok(porAcao.revisao_manual.quantidade >= 1);
    assert.ok(porAcao.ignorar.quantidade >= 1);
    assert.ok(porAcao.criar_titulo.quantidade >= 1);

    const match = rel1.itens.find((i) => i.descricao === 'Legado match');
    assert.equal(match.acao_sugerida, DryRun.ACOES.VINCULAR);
    assert.equal(match.confianca, 'alta');

    const div = rel1.itens.find((i) => i.descricao === 'Legado divergente');
    assert.equal(div.acao_sugerida, DryRun.ACOES.REVISAO_MANUAL);

    const amb = rel1.itens.filter((i) => i.descricao === 'Amb A' || i.descricao === 'Amb B');
    assert.equal(amb.length, 2);
    assert.ok(amb.every((i) => i.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL));

    const pago = rel1.itens.find((i) => i.descricao === 'Hist pago');
    assert.equal(pago.acao_sugerida, DryRun.ACOES.REVISAO_MANUAL);
    assert.equal(pago.saldo_verificavel, false);
    assert.equal(pago.saldo_conhecido, null);

    const cancel = rel1.itens.find((i) => i.descricao === 'Hist cancel');
    assert.equal(cancel.acao_sugerida, DryRun.ACOES.IGNORAR);

    // Isolamento: não inclui Só B
    assert.equal(rel1.itens.some((i) => i.descricao === 'Só B'), false);

    // Totais: soma quantidade = itens
    const somaQ = Object.values(porAcao).reduce((s, b) => s + b.quantidade, 0);
    assert.equal(somaQ, rel1.itens.length);

    await closeDb(ctx.db);
  });

  it('correspondências: fornecedor/documento; ambíguo nunca auto-aprovado', async () => {
    const ctx = await setupBase();
    // Título MCF com documento para match médio
    const titulo = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 77,
      data_vencimento: '2026-11-20', documento: 'DOC-77', pessoa_nome: 'Alpha Ltda',
      descricao: 'Doc match'
    });
    await run(ctx.db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [titulo.id]);
    await run(ctx.db, `DELETE FROM financeiro WHERE origem = 'mcf_compatibilidade'`);
    await run(ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, documento, vencimento, empresa_id)
       VALUES ('despesa','Por documento',77,'2026-10-01','pendente','manual','DOC-77','2026-11-20',?)`,
      [ctx.empresaA.id]
    );
    // Fornecedor+valor+data diferente → sem match do doc; outro registro
    await run(ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, vencimento, empresa_id)
       VALUES ('despesa','Por fornecedor',77,'2026-10-01','pendente','manual','Alpha Ltda','2026-11-20',?)`,
      [ctx.empresaA.id]
    );

    const rel = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    const porDoc = rel.itens.find((i) => i.descricao === 'Por documento');
    assert.ok(porDoc);
    // Ambos podem casar no mesmo título → ambiguidade inversa → revisao
    // ou o primeiro vincular e o segundo revisao
    assert.ok(
      porDoc.acao_sugerida === DryRun.ACOES.VINCULAR
      || porDoc.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL
    );
    if (porDoc.acao_sugerida === DryRun.ACOES.VINCULAR) {
      assert.equal(porDoc.candidato_mcf.conta_pagar_id, titulo.id);
    }
    const aprovadosAmbiguos = rel.itens.filter(
      (i) => i.candidatos_ambiguidade && i.candidatos_ambiguidade.length > 1
        && i.acao_sugerida === DryRun.ACOES.VINCULAR
    );
    assert.equal(aprovadosAmbiguos.length, 0);
    await closeDb(ctx.db);
  });

  it('simulação: estado esperado sem persistir; anti-dupla-contagem', async () => {
    const ctx = await setupBase();
    await popularFixtureRepresentativa(ctx);
    const antesCompat = Number((await getRow(
      ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat WHERE empresa_id = ?',
      [ctx.empresaA.id]
    )).n);
    const antesFin = Number((await getRow(
      ctx.db, 'SELECT COUNT(*) AS n FROM financeiro WHERE empresa_id = ?', [ctx.empresaA.id]
    )).n);
    const antesCp = Number((await getRow(
      ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar WHERE empresa_id = ?', [ctx.empresaA.id]
    )).n);

    const mon = instrumentarEscritas(ctx.db);
    const sim = await Simulacao.executarSimulacao({ db: ctx.db, empresaId: ctx.empresaA.id });
    mon.restaurar();

    assert.equal(mon.escritas.length, 0);
    assert.equal(sim.somente_leitura, true);
    assert.equal(sim.modo, 'simulacao');
    assert.equal(sim.reconciliacao_totais.batimento_quantidade, true);
    assert.ok(sim.simulacao.vinculados.length >= 1);
    assert.ok(sim.simulacao.criar_titulo.length >= 1);
    assert.ok(sim.simulacao.ignorados.length >= 1);
    assert.ok(sim.simulacao.revisao_manual.length >= 1);

    // Vincular não altera saldo MCF nem cria pagamento sintético
    for (const v of sim.simulacao.vinculados) {
      assert.equal(v.estado_esperado.cria_pagamento_sintetico, false);
      assert.equal(v.estado_esperado.altera_saldo_mcf, false);
      assert.equal(v.estado_esperado.preserva_pagamentos_mcf_existentes, true);
    }
    for (const c of sim.simulacao.criar_titulo) {
      assert.equal(c.estado_esperado.cria_pagamento_sintetico, false);
      assert.equal(c.estado_esperado.status_titulo_proposto, 'aberto');
      assert.equal(c.estado_esperado.exige_evidencia_pagamento_antes_baixa, true);
    }
    for (const r of sim.simulacao.revisao_manual) {
      assert.equal(r.estado_esperado.aprovacao_automatica, false);
    }

    assert.equal(sim.simulacao.anti_duplicidade.nao_soma_projecoes, true);
    assert.equal(sim.simulacao.anti_duplicidade.nao_cria_pagamento_sintetico, true);

    // Persistência inalterada
    assert.equal(Number((await getRow(
      ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat WHERE empresa_id = ?',
      [ctx.empresaA.id]
    )).n), antesCompat);
    assert.equal(Number((await getRow(
      ctx.db, 'SELECT COUNT(*) AS n FROM financeiro WHERE empresa_id = ?', [ctx.empresaA.id]
    )).n), antesFin);
    assert.equal(Number((await getRow(
      ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar WHERE empresa_id = ?', [ctx.empresaA.id]
    )).n), antesCp);

    // Indicadores: total a pagar sem dupla = MCF saldo + legado sem projeção
    const ind = sim.indicadores_antes;
    assert.equal(
      ind.total_a_pagar_sem_dupla_contagem,
      Math.round((ind.mcf_abertos.saldo_confirmado + ind.legado_historico_aberto_sem_projecao.valor_conhecido) * 100) / 100
    );
    // Projeções existem mas não entram no legado_historico
    assert.ok(ind.projecoes_compat.quantidade >= 1);
    const somaComProj = Number((await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor),0) AS t FROM financeiro
       WHERE empresa_id=? AND tipo='despesa' AND status NOT IN ('pago','recebido','cancelado')`,
      [ctx.empresaA.id]
    )).t);
    assert.ok(somaComProj > ind.legado_historico_aberto_sem_projecao.valor_conhecido);

    await closeDb(ctx.db);
  });

  it('indicadores: aberto/parcial/quitado/cancelado + projeção sem dupla contagem', async () => {
    const ctx = await setupBase();
    const aberto = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 100, data_vencimento: '2026-11-01'
    });
    const parcial = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 200, data_vencimento: '2026-11-02'
    });
    await ContasPagarService.baixar({
      db: ctx.db, empresaId: ctx.empresaA.id, id: parcial.id, valor_pago: 50, idempotency_key: 'ind-parc'
    });
    const quit = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 30, data_vencimento: '2026-11-03'
    });
    await ContasPagarService.baixar({
      db: ctx.db, empresaId: ctx.empresaA.id, id: quit.id, valor_pago: 30, idempotency_key: 'ind-quit'
    });
    const canc = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 40, data_vencimento: '2026-11-04'
    });
    await ContasPagarService.cancelar({
      db: ctx.db, empresaId: ctx.empresaA.id, id: canc.id, motivo: 'teste',
      usuario_id: 1, idempotency_key: 'ind-canc'
    });
    await run(ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa','Hist aberto',70,'2026-09-01','pendente','manual',?)`,
      [ctx.empresaA.id]
    );

    const ind = await Simulacao.capturarIndicadoresAtuais(ctx.db, ctx.empresaA.id);
    assert.equal(ind.mcf_abertos.saldo_confirmado, 250); // 100 + 150
    assert.equal(ind.mcf_quitados.quantidade, 1);
    assert.equal(ind.mcf_cancelados.quantidade, 1);
    assert.equal(ind.mcf_pagamentos.valor, 80); // 50+30
    assert.equal(ind.legado_historico_aberto_sem_projecao.valor_conhecido, 70);
    assert.equal(ind.total_a_pagar_sem_dupla_contagem, 320); // 250+70
    // Projeções: 4 títulos criados → 4 projeções (cancelado ainda tem projeção sync)
    assert.ok(ind.projecoes_compat.quantidade >= 3);

    // Relatório legado excluindo projeções não inclui valor das projeções
    const legadoSemProj = Number((await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor),0) AS t FROM financeiro f
       WHERE f.empresa_id=? AND f.tipo='despesa' AND f.status NOT IN ('pago','recebido','cancelado')
       ${sqlExcluirProjecaoMcf('f')}`,
      [ctx.empresaA.id]
    )).t);
    assert.equal(legadoSemProj, 70);

    const tAberto = await ContasPagarService.obter({ db: ctx.db, empresaId: ctx.empresaA.id, id: aberto.id });
    assert.equal(tAberto.status, STATUS_CONTA_PAGAR.ABERTA);
    await closeDb(ctx.db);
  });

  it('plano de migração documentado e rota de simulação registrada', () => {
    const plano = fs.readFileSync(
      path.join(ROOT, 'docs/financeiro/MCF-02.3-PLANO-MIGRACAO.md'),
      'utf8'
    );
    assert.match(plano, /idempot/i);
    assert.match(plano, /auditoria/i);
    assert.match(plano, /interrup/i);
    assert.match(plano, /sem backfill|não.*backfill|Nenhum backfill/i);
    const rota = fs.readFileSync(
      path.join(ROOT, 'backend/rotas/contas_pagar.js'),
      'utf8'
    );
    assert.match(rota, /reconciliacao-historica\/simulacao/);
  });
});
