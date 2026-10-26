/**
 * MCF-02.5 — Verificação final pré-migração (identidade, atomicidade, relatório).
 * Executar: node --test tests/financeiro/mcf-02.5-verificacao-pre-migracao.test.js
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
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const { garantirSchemaMcfMigracaoHistoricaAsync } = require('../../backend/motores/mcf/schema/mcfMigracaoHistoricaSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
const Executor = require('../../backend/motores/mcf/services/ContasPagarMigracaoHistoricaExecutor');
const { VERSAO_MCF } = require('../../backend/motores/mcf/contracts/constantesMcf');
const { ORIGEM_PROJECAO } = require('../../backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard');

const AMBIENTE = 'MCF-02.5-ENSAIO-PRE-MIG';
const CNPJ = '11222333000181';

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

async function setup() {
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
  await garantirSchemaMcfMigracaoHistoricaAsync(db);
  const empresa = await EmpresaService.criarEmpresa({ cnpj: CNPJ, razao_social: 'PreMig' }, { db });
  return { db, empresa };
}

async function seedCriarEVincular(db, empresaId) {
  const compra = await run(db, 'INSERT INTO compras (empresa_id) VALUES (?)', [empresaId]);
  const titulo = await ContasPagarService.criar({
    db, empresaId, valor_original: 100, data_vencimento: '2026-11-10',
    origem: 'compra', referencia_tipo: 'compra', referencia_id: compra.lastID,
    numero_parcela: 1, total_parcelas: 1, descricao: 'Match'
  });
  await run(db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [titulo.id]);
  await run(db, `DELETE FROM financeiro WHERE origem = ? AND referencia_id = ?`, [ORIGEM_PROJECAO, titulo.id]);
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
      numero_parcela, vencimento, empresa_id, observacao)
     VALUES ('despesa','Hist match',100,'2026-10-01','pendente','compra',?,1,'2026-11-10',?,'obs-historico')`,
    [compra.lastID, empresaId]
  );
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
     VALUES ('despesa','Hist criar',150,'2026-09-05','pendente','manual','F','NF-1','2026-10-10',?)`,
    [empresaId]
  );
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
     VALUES ('despesa','Hist cancel',10,'2026-09-03','cancelado','manual',?)`,
    [empresaId]
  );
  const tParc = await ContasPagarService.criar({
    db, empresaId, valor_original: 80, data_vencimento: '2026-12-01', descricao: 'Parcial'
  });
  await ContasPagarService.baixar({
    db, empresaId, id: tParc.id, valor_pago: 20, idempotency_key: 'pre-parc'
  });
  return { titulo, tParc };
}

describe('MCF-02.5 — Verificação final pré-migração', () => {
  it('versão e documentos de proteção', () => {
    assert.equal(VERSAO_MCF.SPRINT, 'MCF-02.5');
    assert.ok(ContasPagarService.MARCADOR_PROJECAO_SINTETICA.includes('MCF_PROJECAO_SINTETICA'));
    const plano = fs.readFileSync(
      path.join(ROOT, 'docs/financeiro/MCF-02.5-PLANO-PROTECAO.md'),
      'utf8'
    );
    assert.match(plano, /empresaId/);
    assert.match(plano, /loteId/);
    assert.match(plano, /backup/i);
    assert.match(plano, /restaura/i);
    assert.match(plano, /abort/i);
    assert.match(plano, /MCF_PROJECAO_SINTETICA|PROJECAO_SINTETICA/);
  });

  it('identidade: projeção sintética marcada; histórico nunca removível como sintético', async () => {
    const ctx = await setup();
    const titulo = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresa.id, valor_original: 40, data_vencimento: '2026-11-01'
    });
    const vinculo = await getRow(
      ctx.db,
      'SELECT financeiro_id FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?',
      [titulo.id]
    );
    const proj = await getRow(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [vinculo.financeiro_id]);
    assert.ok(String(proj.observacao).includes(Executor.MARCADOR_PROJECAO_SINTETICA));
    assert.equal(
      Executor.ehProjecaoSinteticaRemovivel(proj, {
        contaPagarId: titulo.id,
        financeiroLegadoId: 999
      }),
      true
    );

    await run(ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id, observacao)
       VALUES ('despesa','Histórico real',55,'2026-09-01','pendente','manual',?,'dado-cliente')`,
      [ctx.empresa.id]
    );
    const hist = await getRow(ctx.db, `SELECT * FROM financeiro WHERE descricao = 'Histórico real'`);
    assert.equal(Executor.ehRegistroHistoricoProtegido(hist), true);
    assert.equal(
      Executor.ehProjecaoSinteticaRemovivel(hist, { contaPagarId: titulo.id, financeiroLegadoId: hist.id }),
      false
    );

    // Troca vínculo para apontar ao histórico e tenta remover — deve recusar
    await run(ctx.db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [titulo.id]);
    await run(ctx.db,
      `INSERT INTO contas_pagar_financeiro_compat (empresa_id, conta_pagar_id, financeiro_id) VALUES (?,?,?)`,
      [ctx.empresa.id, titulo.id, hist.id]
    );
    await assert.rejects(
      () => Executor.removerProjecaoSinteticaComprovada(ctx.db, ctx.empresa.id, titulo.id, 99999),
      /históric|sintética/i
    );

    const ainda = await getRow(ctx.db, 'SELECT id, descricao FROM financeiro WHERE id = ?', [hist.id]);
    assert.ok(ainda);
    assert.equal(ainda.descricao, 'Histórico real');
    await closeDb(ctx.db);
  });

  it('atomicidade: falha após titulo_criado / compat não deixa estado contraditório', async () => {
    const ctx = await setup();
    // Isola só criar_titulo: sem candidato MCF, o gancho titulo_criado é o primeiro passo mutável
    await run(ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
       VALUES ('despesa','Hist criar',150,'2026-09-05','pendente','manual','F','NF-1','2026-10-10',?)`,
      [ctx.empresa.id]
    );
    const prep = await Executor.prepararLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: path.join(ROOT, 'tests/fixtures/mcf-02.5-mem.sqlite')
    });

    const finAntes = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    const cpAntes = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar')).n);
    const compatAntes = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat')).n);
    const pagsAntes = Number((await getRow(ctx.db, 'SELECT COALESCE(SUM(valor_pago),0) AS v FROM contas_pagar_pagamentos')).v);
    const migrAntes = Number((await getRow(ctx.db,
      `SELECT COUNT(*) AS n FROM contas_pagar WHERE origem = 'migracao_historica'`
    )).n);

    const r = await Executor.executarLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      loteId: prep.lote_id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: path.join(ROOT, 'tests/fixtures/mcf-02.5-mem.sqlite'),
      falhaAposPasso: 'titulo_criado'
    });
    assert.equal(r.status, 'abortado');
    assert.match(String(r.erro), /FALHA_SIMULADA/);

    // Rollback: contagens preservadas (sem título órfão / vínculo parcial)
    assert.equal(Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n), finAntes);
    assert.equal(Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar')).n), cpAntes);
    assert.equal(Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat')).n), compatAntes);
    assert.equal(Number((await getRow(ctx.db, 'SELECT COALESCE(SUM(valor_pago),0) AS v FROM contas_pagar_pagamentos')).v), pagsAntes);
    assert.equal(Number((await getRow(ctx.db,
      `SELECT COUNT(*) AS n FROM contas_pagar WHERE origem = 'migracao_historica'`
    )).n), migrAntes);

    // Históricos intactos
    const hist = await getRow(ctx.db, `SELECT origem, observacao FROM financeiro WHERE descricao = 'Hist criar'`);
    assert.equal(hist.origem, 'manual');
    assert.ok(!String(hist.observacao || '').includes(Executor.MARCADOR_HISTORICO_VINCULADO));

    await closeDb(ctx.db);
  });

  it('falha após compat_inserido também reverte; lote abortado exige novo lote', async () => {
    const ctx = await setup();
    await seedCriarEVincular(ctx.db, ctx.empresa.id);
    const prep = await Executor.prepararLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: 'tests/fixtures/mcf-02.5-b.sqlite'
    });
    const finAntes = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    const r = await Executor.executarLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      loteId: prep.lote_id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: 'tests/fixtures/mcf-02.5-b.sqlite',
      falhaAposPasso: 'compat_inserido'
    });
    assert.equal(r.status, 'abortado');
    assert.equal(Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n), finAntes);

    await assert.rejects(
      () => Executor.executarLote({
        db: ctx.db,
        empresaId: ctx.empresa.id,
        loteId: prep.lote_id,
        ambienteId: AMBIENTE,
        permitirEscritaIsolada: true,
        caminhoDb: 'tests/fixtures/mcf-02.5-b.sqlite'
      }),
      /abortado/i
    );
    await closeDb(ctx.db);
  });

  it('execução feliz: preserva pagamentos; histórico não apagado; interrupção/retomada/replay', async () => {
    const ctx = await setup();
    await seedCriarEVincular(ctx.db, ctx.empresa.id);
    const prep = await Executor.prepararLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: 'tests/fixtures/mcf-02.5-c.sqlite'
    });
    const rel = await Executor.gerarRelatorioPreMigracao({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      loteId: prep.lote_id
    });
    assert.equal(rel.empresa_id, ctx.empresa.id);
    assert.equal(rel.lote_id, prep.lote_id);
    assert.equal(rel.fingerprint_origem, prep.fingerprint);
    assert.equal(rel.fingerprint_compativel_com_lote, true);
    assert.ok(rel.por_acao.revisao_manual);
    assert.ok(Array.isArray(rel.criterios_abortar));
    assert.ok(rel.titulos_pagamentos_existentes.mcf_pagamentos.valor >= 20);

    const snapAntes = await Executor.capturarSnapshotVerificacao(ctx.db, ctx.empresa.id);
    const idsHistAntes = (await new Promise((resolve, reject) => {
      ctx.db.all(
        `SELECT id, descricao FROM financeiro WHERE origem IN ('manual','compra')`,
        (e, rows) => (e ? reject(e) : resolve(rows || []))
      );
    })).map((r) => r.id);

    const p1 = await Executor.executarLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      loteId: prep.lote_id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: 'tests/fixtures/mcf-02.5-c.sqlite',
      interromperAposN: 1
    });
    assert.equal(p1.status, 'interrupido');

    let p2 = await Executor.executarLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      loteId: prep.lote_id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: 'tests/fixtures/mcf-02.5-c.sqlite'
    });
    if (p2.pendentes_restantes > 0) {
      p2 = await Executor.executarLote({
        db: ctx.db,
        empresaId: ctx.empresa.id,
        loteId: prep.lote_id,
        ambienteId: AMBIENTE,
        permitirEscritaIsolada: true,
        caminhoDb: 'tests/fixtures/mcf-02.5-c.sqlite'
      });
    }
    assert.equal(p2.status, 'concluido');

    const replay = await Executor.executarLote({
      db: ctx.db,
      empresaId: ctx.empresa.id,
      loteId: prep.lote_id,
      ambienteId: AMBIENTE,
      permitirEscritaIsolada: true,
      caminhoDb: 'tests/fixtures/mcf-02.5-c.sqlite'
    });
    assert.equal(replay.processados_nesta_execucao, 0);

    const snapDepois = await Executor.capturarSnapshotVerificacao(ctx.db, ctx.empresa.id);
    const cmp = Executor.compararSnapshots(snapAntes, snapDepois);
    assert.equal(cmp.aprovado, true, cmp.divergencias.join('; '));
    assert.equal(snapDepois.pagamentos_valor, snapAntes.pagamentos_valor);

    for (const id of idsHistAntes) {
      const row = await getRow(ctx.db, 'SELECT id FROM financeiro WHERE id = ?', [id]);
      assert.ok(row, `histórico ${id} não pode ser excluído`);
    }

    const histMatch = await getRow(ctx.db, `SELECT origem, observacao, descricao, valor FROM financeiro WHERE descricao = 'Hist match'`);
    assert.equal(histMatch.origem, ORIGEM_PROJECAO);
    assert.ok(String(histMatch.observacao).includes(Executor.MARCADOR_HISTORICO_VINCULADO));
    assert.equal(Number(histMatch.valor), 100);

    // exige empresaId/loteId
    await assert.rejects(
      () => Executor.executarLote({
        db: ctx.db,
        loteId: prep.lote_id,
        ambienteId: AMBIENTE,
        permitirEscritaIsolada: true,
        caminhoDb: 'tests/fixtures/mcf-02.5-c.sqlite'
      }),
      /empresaId/
    );

    await closeDb(ctx.db);
  });
});
