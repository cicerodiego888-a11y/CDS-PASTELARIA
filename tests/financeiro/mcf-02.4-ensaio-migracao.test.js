/**
 * MCF-02.4 — Ensaio controlado de migração histórica (cópia isolada).
 * NÃO usa banco operacional/cliente.
 * Executar: node --test tests/financeiro/mcf-02.4-ensaio-migracao.test.js
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const ENSAIO_DIR = path.join(ROOT, 'tests', 'fixtures', 'mcf-02.4-ensaio');
const AMBIENTE_ID = 'MCF-02.4-ENSAIO-CONTROLADO';
const DB_PATH = path.join(ENSAIO_DIR, 'ensaio-contas-pagar.sqlite');
const BACKUP_PATH = path.join(ENSAIO_DIR, 'ensaio-contas-pagar.backup.sqlite');

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const { garantirSchemaMcfMigracaoHistoricaAsync } = require('../../backend/motores/mcf/schema/mcfMigracaoHistoricaSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
const DryRun = require('../../backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService');
const Executor = require('../../backend/motores/mcf/services/ContasPagarMigracaoHistoricaExecutor');
const { VERSAO_MCF } = require('../../backend/motores/mcf/contracts/constantesMcf');
const { ORIGEM_PROJECAO } = require('../../backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard');

const CNPJ_A = '11222333000181';

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

function garantirDir() {
  fs.mkdirSync(ENSAIO_DIR, { recursive: true });
  const readme = path.join(ENSAIO_DIR, 'README.md');
  fs.writeFileSync(
    readme,
    [
      '# MCF-02.4 — Cópia isolada de ensaio',
      '',
      `- ambiente_id: \`${AMBIENTE_ID}\``,
      `- banco: \`ensaio-contas-pagar.sqlite\``,
      `- backup: \`ensaio-contas-pagar.backup.sqlite\``,
      '',
      '**NÃO é banco operacional nem de cliente.**',
      'Backfill real permanece NÃO AUTORIZADO.',
      ''
    ].join('\n'),
    'utf8'
  );
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

async function popularEnsaio(db, empresaId) {
  // Match vincular
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

  // Criar título
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
     VALUES ('despesa','Criar titulo',200,'2026-09-05','pendente','manual','Fornecedor X','NF-X','2026-10-10',?)`,
    [empresaId]
  );

  // Ignorar cancelado
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
     VALUES ('despesa','Hist cancel',20,'2026-09-03','cancelado','manual',?)`,
    [empresaId]
  );

  // Revisão: divergência
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

  // Parcial MCF com pagamento (preservar)
  const tParc = await ContasPagarService.criar({
    db, empresaId, valor_original: 300, data_vencimento: '2026-12-01', descricao: 'MCF parcial'
  });
  await ContasPagarService.baixar({
    db, empresaId, id: tParc.id, valor_pago: 100, idempotency_key: 'ensaio-parc'
  });

  // Pago legado → revisão (não sintético)
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
     VALUES ('despesa','Hist pago',40,'2026-09-01','pago','manual',?)`,
    [empresaId]
  );

  return { tMatch, tParc };
}

describe('MCF-02.4 — Ensaio migração em cópia isolada', () => {
  let db;
  let empresaId;
  let evidencia = {};

  before(async () => {
    garantirDir();
    for (const p of [DB_PATH, BACKUP_PATH]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    db = await openDbFile(DB_PATH);
    await criarSchemaBase(db);
    const empresa = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Ensaio Isolado MCF-02.4' },
      { db }
    );
    empresaId = empresa.id;
    await popularEnsaio(db, empresaId);
    await closeDb(db);

    // Backup inequívoco
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    fs.writeFileSync(
      path.join(ENSAIO_DIR, 'AMBIENTE.json'),
      JSON.stringify({
        ambiente_id: AMBIENTE_ID,
        db_path: DB_PATH,
        backup_path: BACKUP_PATH,
        criado_em: new Date().toISOString(),
        aviso: 'COPIA_ISOLADA — nao operacional / nao cliente'
      }, null, 2),
      'utf8'
    );

    db = await openDbFile(DB_PATH);
  });

  after(async () => {
    if (db) await closeDb(db);
    fs.writeFileSync(
      path.join(ENSAIO_DIR, 'EVIDENCIA-ENSAIO.json'),
      JSON.stringify(evidencia, null, 2),
      'utf8'
    );
  });

  it('versão e recusa ambiente operacional', () => {
    assert.match(String(VERSAO_MCF.SPRINT), /^MCF-02/);
    assert.throws(
      () => Executor.validarAmbienteEnsaio({
        permitirEscritaIsolada: true,
        ambienteId: 'PRODUCAO',
        caminhoDb: DB_PATH
      }),
      /MCF-02\.[45]-ENSAIO/
    );
    assert.throws(
      () => Executor.validarAmbienteEnsaio({
        permitirEscritaIsolada: true,
        ambienteId: AMBIENTE_ID,
        caminhoDb: 'C:/dados/mercadao.db'
      }),
      /operacional|cliente/i
    );
    assert.throws(
      () => Executor.validarAmbienteEnsaio({
        permitirEscritaIsolada: false,
        ambienteId: AMBIENTE_ID,
        caminhoDb: DB_PATH
      }),
      /permitirEscritaIsolada/
    );
  });

  it('pré-validação: fingerprint estável + preparação do lote', async () => {
    assert.ok(fs.existsSync(BACKUP_PATH));
    const prep = await Executor.prepararLote({
      db,
      empresaId,
      ambienteId: AMBIENTE_ID,
      permitirEscritaIsolada: true,
      caminhoDb: DB_PATH
    });
    evidencia.pre_validacao = {
      lote_id: prep.lote_id,
      fingerprint: prep.fingerprint,
      automaticos: prep.automaticos,
      revisao_manual: prep.revisao_manual,
      cobertura: prep.dry_run.cobertura,
      totais: prep.dry_run.totais_empresa,
      indicadores_antes: prep.indicadores_antes
    };
    assert.ok(prep.fingerprint);
    assert.ok(prep.automaticos >= 3); // vincular + criar + ignorar
    assert.ok(prep.revisao_manual >= 1);
    assert.equal(prep.ambiente_id, AMBIENTE_ID);

    const estavel = await DryRun.executarDryRun({ db, empresaId });
    assert.equal(estavel.fingerprint, prep.fingerprint);
  });

  it('ensaio: interrupção, retomada, idempotência e verificação pós', async () => {
    const loteId = evidencia.pre_validacao.lote_id;
    const snapshotAntes = await Executor.capturarSnapshotVerificacao(db, empresaId);
    evidencia.snapshot_antes = snapshotAntes;

    const optsBase = {
      db,
      empresaId,
      loteId,
      ambienteId: AMBIENTE_ID,
      permitirEscritaIsolada: true,
      caminhoDb: DB_PATH
    };

    // Interrompe após 1 item automático
    const parte1 = await Executor.executarLote({ ...optsBase, interromperAposN: 1 });
    assert.equal(parte1.status, 'interrupido');
    assert.equal(parte1.processados_nesta_execucao, 1);
    assert.ok(parte1.pendentes_restantes >= 1);
    evidencia.interrupcao = parte1;

    // Retomada
    const parte2 = await Executor.executarLote(optsBase);
    assert.ok(['concluido', 'em_andamento'].includes(parte2.status));
    // Se ainda houver pendentes (não deveria), completa
    let final = parte2;
    if (parte2.pendentes_restantes > 0) {
      final = await Executor.executarLote(optsBase);
    }
    assert.equal(final.status, 'concluido');
    evidencia.retomada = final;

    // Repetição idempotente — não duplica
    const replay = await Executor.executarLote(optsBase);
    assert.equal(replay.status, 'concluido');
    assert.equal(replay.processados_nesta_execucao, 0);

    const snapshotDepois = await Executor.capturarSnapshotVerificacao(db, empresaId);
    evidencia.snapshot_depois = snapshotDepois;
    const cmp = Executor.compararSnapshots(snapshotAntes, snapshotDepois);
    evidencia.comparacao = cmp;

    // Pagamentos MCF preservados
    assert.equal(snapshotDepois.pagamentos_valor, snapshotAntes.pagamentos_valor);
    assert.equal(snapshotDepois.pagamentos_qtd, snapshotAntes.pagamentos_qtd);

    // Vínculos aumentaram (vincular + criar)
    assert.ok(cmp.delta.vinculos_compat >= 1);
    // Títulos novos possíveis
    assert.ok(cmp.delta.contas_pagar >= 1);

    // Dry-run pós: sem vincular/criar automáticos restantes
    const pos = snapshotDepois.dry_run_pos.por_acao;
    assert.equal(pos.vincular.quantidade, 0);
    assert.equal(pos.criar_titulo.quantidade, 0);

    // Auditoria registrada
    const aud = await allRows(
      db,
      `SELECT acao FROM contas_pagar_migracao_auditoria WHERE lote_id = ?`,
      [loteId]
    );
    assert.ok(aud.some((a) => a.acao === 'migracao_historica_vincular'));
    assert.ok(aud.some((a) => a.acao === 'migracao_historica_criar'));
    assert.ok(aud.some((a) => a.acao === 'migracao_historica_ignorar'));
    assert.ok(aud.some((a) => a.acao === 'migracao_historica_interrupcao'));
    evidencia.auditoria_acoes = aud.map((a) => a.acao);

    // Sem pagamento sintético nos títulos criados por migração
    const migrados = await allRows(
      db,
      `SELECT conta_pagar_id FROM contas_pagar_migracao_historica
       WHERE lote_id = ? AND acao = 'criar_titulo' AND status = 'ok'`,
      [loteId]
    );
    for (const m of migrados) {
      const pags = await ContasPagarService.listarPagamentos({
        db, empresaId, id: m.conta_pagar_id
      });
      assert.equal(pags.pagamentos.length, 0);
    }

    // Legado match virou projeção
    const finMatch = await getRow(
      db,
      `SELECT origem, referencia_tipo FROM financeiro WHERE descricao = 'Legado match'`
    );
    assert.equal(finMatch.origem, ORIGEM_PROJECAO);
    assert.equal(finMatch.referencia_tipo, 'contas_pagar_mcf');

    assert.equal(cmp.aprovado, true, cmp.divergencias.join('; '));
  });

  it('abortar se origem mudar após fingerprint (item pendente)', async () => {
    // Novo ensaio em memória para isolamento do cenário de abort
    const mem = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(':memory:', (e) => (e ? reject(e) : resolve(d)));
    });
    await criarSchemaBase(mem);
    const emp = await EmpresaService.criarEmpresa(
      { cnpj: '04252011000110', razao_social: 'Abort Test' },
      { db: mem }
    );
    await run(mem,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, pessoa_nome, documento, vencimento, empresa_id)
       VALUES ('despesa','Para criar',55,'2026-09-05','pendente','manual','Y','NF-Y','2026-10-10',?)`,
      [emp.id]
    );
    await run(mem,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa','Para ignorar',10,'2026-09-03','cancelado','manual',?)`,
      [emp.id]
    );
    const prep = await Executor.prepararLote({
      db: mem,
      empresaId: emp.id,
      ambienteId: AMBIENTE_ID,
      permitirEscritaIsolada: true,
      caminhoDb: path.join(ENSAIO_DIR, 'mem-abort.sqlite')
    });
    // Corrompe origem: remove candidato pendente de criar
    await run(mem, `DELETE FROM financeiro WHERE descricao = 'Para criar'`);
    const r = await Executor.executarLote({
      db: mem,
      empresaId: emp.id,
      loteId: prep.lote_id,
      ambienteId: AMBIENTE_ID,
      permitirEscritaIsolada: true,
      caminhoDb: path.join(ENSAIO_DIR, 'mem-abort.sqlite')
    });
    assert.equal(r.status, 'abortado');
    await closeDb(mem);
  });
});
