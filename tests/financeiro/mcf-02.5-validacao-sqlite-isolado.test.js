/**
 * MCF-02.5 — Validação técnica em SQLite isolado (dados de teste controlados).
 *
 * Premissa do projeto: o banco em uso é exclusivamente de teste/desenvolvimento.
 * Não há dados reais de clientes a preservar. Backup/restauração aqui referem-se
 * apenas à cópia isolada de ensaio — NÃO exigem comprovação de recuperação de produção.
 *
 * Executar: node --test tests/financeiro/mcf-02.5-validacao-sqlite-isolado.test.js
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const ENSAIO_DIR = path.join(ROOT, 'tests', 'fixtures', 'mcf-02.5-ensaio');
const AMBIENTE_ID = 'MCF-02.5-ENSAIO-PRE-MIG';
const DB_PATH = path.join(ENSAIO_DIR, 'ensaio-pre-mig.sqlite');
const BACKUP_PATH = path.join(ENSAIO_DIR, 'ensaio-pre-mig.backup.sqlite');

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const { garantirSchemaMcfMigracaoHistoricaAsync } = require('../../backend/motores/mcf/schema/mcfMigracaoHistoricaSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
const DryRun = require('../../backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService');
const Executor = require('../../backend/motores/mcf/services/ContasPagarMigracaoHistoricaExecutor');
const { ORIGEM_PROJECAO } = require('../../backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard');

const CNPJ = '11222333000181';

function openDbFile(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (err) => (err ? reject(err) : resolve(db)));
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
function allRows(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function criarSchemaBase(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE IF NOT EXISTS fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, cpf_cnpj TEXT
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    categoria TEXT, forma_pagamento TEXT, referencia_id INTEGER,
    referencia_tipo TEXT, status TEXT, origem TEXT, documento TEXT,
    vencimento TEXT, numero_parcela INTEGER, total_parcelas INTEGER,
    compra_id INTEGER, venda_id INTEGER, pessoa_nome TEXT, observacao TEXT,
    baixado_em TEXT, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL
  )`);
  await garantirSchemaMcfAsync(db);
  await garantirSchemaMcfMigracaoHistoricaAsync(db);
}

async function popularDadosTeste(db, empresaId) {
  const compra1 = await run(db, 'INSERT INTO compras (empresa_id) VALUES (?)', [empresaId]);
  const tMatch = await ContasPagarService.criar({
    db, empresaId, valor_original: 100, data_vencimento: '2026-11-10',
    origem: 'compra', referencia_tipo: 'compra', referencia_id: compra1.lastID,
    numero_parcela: 1, total_parcelas: 1, descricao: 'Match exato'
  });
  await run(db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [tMatch.id]);
  await run(db, `DELETE FROM financeiro WHERE origem = ? AND referencia_id = ?`, [ORIGEM_PROJECAO, tMatch.id]);
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
      numero_parcela, vencimento, empresa_id)
     VALUES ('despesa','Legado match',100,'2026-10-01','pendente','compra',?,1,'2026-11-10',?)`,
    [compra1.lastID, empresaId]
  );

  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
     VALUES ('despesa','Criar titulo',200,'2026-09-05','pendente','manual','Fornecedor X','NF-X','2026-10-10',?)`,
    [empresaId]
  );

  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
     VALUES ('despesa','Hist cancel',20,'2026-09-03','cancelado','manual',?)`,
    [empresaId]
  );

  const compra2 = await run(db, 'INSERT INTO compras (empresa_id) VALUES (?)', [empresaId]);
  const tDiv = await ContasPagarService.criar({
    db, empresaId, valor_original: 80, data_vencimento: '2026-11-15',
    origem: 'compra', referencia_tipo: 'compra', referencia_id: compra2.lastID,
    numero_parcela: 1, total_parcelas: 1, descricao: 'Divergente'
  });
  await run(db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [tDiv.id]);
  await run(db, `DELETE FROM financeiro WHERE origem = ? AND referencia_id = ?`, [ORIGEM_PROJECAO, tDiv.id]);
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
      numero_parcela, vencimento, empresa_id)
     VALUES ('despesa','Legado divergente',99,'2026-10-02','pendente','compra',?,1,'2026-12-01',?)`,
    [compra2.lastID, empresaId]
  );

  const tParc = await ContasPagarService.criar({
    db, empresaId, valor_original: 300, data_vencimento: '2026-12-01', descricao: 'MCF parcial'
  });
  await ContasPagarService.baixar({
    db, empresaId, id: tParc.id, valor_pago: 100, idempotency_key: 'pre-mig-parc'
  });

  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
     VALUES ('despesa','Hist pago',40,'2026-09-01','pago','manual',?)`,
    [empresaId]
  );

  return { tMatch, tParc };
}

describe('MCF-02.5 — Validação SQLite isolado (dados de teste)', () => {
  let db;
  let empresaId;
  const evidencia = {
    premissa: {
      ambiente: 'teste_desenvolvimento',
      dados_reais_cliente: false,
      restauracao_producao_exigida: false,
      nota: 'Validação técnica em cópia isolada; backup/restore só da fixture de ensaio.'
    },
    cenarios: {},
    veredito: null
  };

  before(async () => {
    fs.mkdirSync(ENSAIO_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(ENSAIO_DIR, 'README.md'),
      [
        '# MCF-02.5 — Cópia isolada de pré-migração',
        '',
        `- ambiente_id: \`${AMBIENTE_ID}\``,
        '- banco: `ensaio-pre-mig.sqlite`',
        '- backup: `ensaio-pre-mig.backup.sqlite`',
        '',
        'Dados de **teste/desenvolvimento** apenas. Não é banco de cliente nem produção.',
        'Backfill operacional permanece NÃO AUTORIZADO sem autorização específica.',
        ''
      ].join('\n'),
      'utf8'
    );

    for (const p of [DB_PATH, BACKUP_PATH]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    db = await openDbFile(DB_PATH);
    await criarSchemaBase(db);
    const empresa = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ, razao_social: 'Ensaio Pre-Mig MCF-02.5' },
      { db }
    );
    empresaId = empresa.id;
    await popularDadosTeste(db, empresaId);
    await closeDb(db);

    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    fs.writeFileSync(
      path.join(ENSAIO_DIR, 'AMBIENTE.json'),
      JSON.stringify({
        ambiente_id: AMBIENTE_ID,
        db_path: DB_PATH,
        backup_path: BACKUP_PATH,
        criado_em: new Date().toISOString(),
        aviso: 'COPIA_ISOLADA_TESTE — nao operacional / nao cliente / nao producao'
      }, null, 2),
      'utf8'
    );

    db = await openDbFile(DB_PATH);
  });

  after(async () => {
    if (db) await closeDb(db);
    fs.writeFileSync(
      path.join(ENSAIO_DIR, 'EVIDENCIA-PRE-MIG.json'),
      JSON.stringify(evidencia, null, 2),
      'utf8'
    );
  });

  it('1) banco de teste e backup isolado abrem e consultam', async () => {
    assert.ok(fs.existsSync(DB_PATH));
    assert.ok(fs.existsSync(BACKUP_PATH));

    const indDb = await getRow(db, 'SELECT COUNT(*) AS n FROM contas_pagar');
    const indFin = await getRow(db, 'SELECT COUNT(*) AS n FROM financeiro');
    const indPag = await getRow(db, 'SELECT COUNT(*) AS n FROM contas_pagar_pagamentos');
    assert.ok(Number(indDb.n) >= 1);
    assert.ok(Number(indFin.n) >= 1);

    const bak = await openDbFile(BACKUP_PATH);
    try {
      const bCp = await getRow(bak, 'SELECT COUNT(*) AS n FROM contas_pagar');
      const bFin = await getRow(bak, 'SELECT COUNT(*) AS n FROM financeiro');
      const bPag = await getRow(bak, 'SELECT COUNT(*) AS n FROM contas_pagar_pagamentos');
      assert.equal(Number(bCp.n), Number(indDb.n));
      assert.equal(Number(bFin.n), Number(indFin.n));
      assert.equal(Number(bPag.n), Number(indPag.n));
      evidencia.abertura = {
        db_path: DB_PATH,
        backup_path: BACKUP_PATH,
        contas_pagar: Number(indDb.n),
        financeiro: Number(indFin.n),
        pagamentos: Number(indPag.n),
        backup_bate_com_origem: true
      };
    } finally {
      await closeDb(bak);
    }
  });

  it('2) indicadores financeiros antes da execução', async () => {
    const rel = await Executor.gerarRelatorioPreMigracao({ db, empresaId });
    const snap = await Executor.capturarSnapshotVerificacao(db, empresaId);
    evidencia.indicadores_antes = {
      relatorio_pre: {
        fingerprint_origem: rel.fingerprint_origem,
        por_acao: rel.por_acao,
        saldos_nao_verificaveis: rel.saldos_nao_verificaveis,
        possiveis_duplicidades: rel.possiveis_duplicidades,
        titulos_pagamentos_existentes: rel.titulos_pagamentos_existentes,
        criterios_abortar: rel.criterios_abortar
      },
      snapshot: snap
    };
    assert.equal(rel.empresa_id, empresaId);
    assert.ok(rel.fingerprint_origem);
    assert.ok(rel.por_acao.revisao_manual.quantidade >= 1);
    assert.equal(snap.pagamentos_valor, 100);
  });

  it('3–5) migração, interrupção, rollback, retomada, idempotência e comparação', async () => {
    const optsBase = {
      db,
      empresaId,
      ambienteId: AMBIENTE_ID,
      permitirEscritaIsolada: true,
      caminhoDb: DB_PATH
    };

    // --- Rollback simulado em cópia :memory: a partir do backup (não altera DB principal) ---
    const memPath = path.join(ENSAIO_DIR, 'rollback-mem.marker');
    const mem = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(':memory:', (e) => (e ? reject(e) : resolve(d)));
    });
    await criarSchemaBase(mem);
    const empRoll = await EmpresaService.criarEmpresa(
      { cnpj: '04252011000110', razao_social: 'Rollback Isolado' },
      { db: mem }
    );
    await run(mem,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
       VALUES ('despesa','Criar rollback',77,'2026-09-05','pendente','manual','Z','NF-Z','2026-10-10',?)`,
      [empRoll.id]
    );
    const prepRoll = await Executor.prepararLote({
      ...optsBase,
      db: mem,
      empresaId: empRoll.id,
      caminhoDb: memPath
    });
    const cpAntesRoll = Number((await getRow(mem, 'SELECT COUNT(*) AS n FROM contas_pagar')).n);
    const finAntesRoll = Number((await getRow(mem, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    const compatAntesRoll = Number((await getRow(mem, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat')).n);
    const roll = await Executor.executarLote({
      db: mem,
      empresaId: empRoll.id,
      loteId: prepRoll.lote_id,
      ambienteId: AMBIENTE_ID,
      permitirEscritaIsolada: true,
      caminhoDb: memPath,
      falhaAposPasso: 'titulo_criado'
    });
    assert.equal(roll.status, 'abortado');
    assert.equal(Number((await getRow(mem, 'SELECT COUNT(*) AS n FROM contas_pagar')).n), cpAntesRoll);
    assert.equal(Number((await getRow(mem, 'SELECT COUNT(*) AS n FROM financeiro')).n), finAntesRoll);
    assert.equal(Number((await getRow(mem, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat')).n), compatAntesRoll);
    assert.equal(Number((await getRow(mem,
      `SELECT COUNT(*) AS n FROM contas_pagar WHERE origem = 'migracao_historica'`
    )).n), 0);
    evidencia.cenarios.rollback_titulo_criado = {
      status: roll.status,
      erro: roll.erro,
      orfaos: false,
      contagens_preservadas: true
    };
    await closeDb(mem);

    // --- Execução principal no arquivo isolado ---
    const prep = await Executor.prepararLote(optsBase);
    evidencia.lote = {
      lote_id: prep.lote_id,
      fingerprint: prep.fingerprint,
      automaticos: prep.automaticos,
      revisao_manual: prep.revisao_manual
    };

    const snapAntes = await Executor.capturarSnapshotVerificacao(db, empresaId);
    evidencia.snapshot_antes_execucao = snapAntes;

    const idsHistAntes = (await allRows(
      db,
      `SELECT id FROM financeiro WHERE empresa_id = ? AND (origem IS NULL OR origem != ?)`,
      [empresaId, ORIGEM_PROJECAO]
    )).map((r) => r.id);

    const p1 = await Executor.executarLote({
      ...optsBase,
      loteId: prep.lote_id,
      interromperAposN: 1
    });
    assert.equal(p1.status, 'interrupido');
    evidencia.cenarios.interrupcao = {
      status: p1.status,
      processados: p1.processados_nesta_execucao,
      pendentes: p1.pendentes_restantes
    };

    let p2 = await Executor.executarLote({ ...optsBase, loteId: prep.lote_id });
    if (p2.pendentes_restantes > 0) {
      p2 = await Executor.executarLote({ ...optsBase, loteId: prep.lote_id });
    }
    assert.equal(p2.status, 'concluido');
    evidencia.cenarios.retomada = {
      status: p2.status,
      processados: p2.processados_nesta_execucao
    };

    const replay = await Executor.executarLote({ ...optsBase, loteId: prep.lote_id });
    assert.equal(replay.processados_nesta_execucao, 0);
    evidencia.cenarios.replay_idempotente = {
      status: replay.status,
      processados: replay.processados_nesta_execucao
    };

    const snapDepois = await Executor.capturarSnapshotVerificacao(db, empresaId);
    const cmp = Executor.compararSnapshots(snapAntes, snapDepois);
    evidencia.snapshot_depois = snapDepois;
    evidencia.comparacao = cmp;

    assert.equal(cmp.aprovado, true, cmp.divergencias.join('; '));
    assert.equal(snapDepois.pagamentos_valor, snapAntes.pagamentos_valor);
    assert.equal(snapDepois.pagamentos_qtd, snapAntes.pagamentos_qtd);
    assert.ok(cmp.delta.vinculos_compat >= 1);
    assert.ok(cmp.delta.contas_pagar >= 1);
    assert.equal(snapDepois.dry_run_pos.por_acao.vincular.quantidade, 0);
    assert.equal(snapDepois.dry_run_pos.por_acao.criar_titulo.quantidade, 0);

    for (const id of idsHistAntes) {
      const row = await getRow(db, 'SELECT id FROM financeiro WHERE id = ?', [id]);
      assert.ok(row, `histórico ${id} não excluído`);
    }

    // Sem duplicidade de compat por conta
    const dups = await allRows(
      db,
      `SELECT conta_pagar_id, COUNT(*) AS n FROM contas_pagar_financeiro_compat
       WHERE empresa_id = ? GROUP BY conta_pagar_id HAVING n > 1`,
      [empresaId]
    );
    assert.equal(dups.length, 0);
    evidencia.cenarios.sem_duplicidade_compat = true;

    // Relatório pós com fingerprint atual
    const relPos = await Executor.gerarRelatorioPreMigracao({
      db, empresaId, loteId: prep.lote_id
    });
    evidencia.relatorio_pos = {
      fingerprint_origem: relPos.fingerprint_origem,
      por_acao: relPos.por_acao,
      fingerprint_compativel_com_lote: relPos.fingerprint_compativel_com_lote
    };

    evidencia.veredito = {
      resultado: 'aprovado',
      escopo: 'SQLite isolado com dados de teste controlados',
      backfill_operacional: 'NAO_AUTORIZADO',
      restauracao_dados_reais: 'NAO_APLICAVEL'
    };
  });
});
