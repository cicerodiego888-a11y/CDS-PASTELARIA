/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-PENDENCIAS-04
 * Alerta informativo: documentos Central sem compra ≠ crédito de estoque.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-pendencias-entrada-04.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-pend-04-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  listarPendenciasEntradaEstoque,
  CLASSIFICACAO
} = require('../../backend/services/estoque/CentralEntradasPendenciasEstoqueService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { exigirSnapshotItensOficiais } = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

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

function get(db, sql, params = []) {
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
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      fornecedor TEXT,
      total REAL,
      status TEXT
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      numero TEXT,
      serie TEXT,
      modelo TEXT DEFAULT '55',
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      data_entrada TEXT,
      valor_total REAL,
      xml TEXT NOT NULL DEFAULT '',
      nsu TEXT,
      origem TEXT NOT NULL DEFAULT 'dfe',
      status TEXT NOT NULL,
      status_detalhe TEXT,
      parse_json TEXT,
      miip_sessao_id TEXT,
      miip_resumo_json TEXT,
      compra_id INTEGER,
      usuario_id INTEGER,
      processado_em DATETIME,
      empresa_id INTEGER,
      tipo_documento TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function inserirDoc(db, dados) {
  const r = await run(
    db,
    `INSERT INTO central_entradas_documentos (
      chave, numero, serie, fornecedor, cnpj_fornecedor, data_emissao,
      valor_total, status, status_detalhe, miip_resumo_json, compra_id, empresa_id, xml
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
    [
      dados.chave,
      dados.numero || '1',
      dados.serie || '1',
      dados.fornecedor || 'Fornecedor X',
      dados.cnpj_fornecedor || '00000000000191',
      dados.data_emissao || '2026-01-10',
      dados.valor_total != null ? dados.valor_total : 100,
      dados.status,
      dados.status_detalhe || null,
      dados.miip_resumo_json || null,
      dados.compra_id != null ? dados.compra_id : null,
      dados.empresa_id != null ? dados.empresa_id : null
    ]
  );
  return r.lastID;
}

async function criarCompra(db, empresaId) {
  const r = await run(
    db,
    `INSERT INTO compras (empresa_id, fornecedor, total, status) VALUES (?, 'F', 10, 'concluida')`,
    [empresaId]
  );
  return r.lastID;
}

describe('CDS-ESTOQUE-CONTAGEM-PENDENCIAS-04', { concurrency: false }, () => {
  it('01 documento sem compra aparece como pendente', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-PEND-01',
      status: DocumentoFiscalStatus.PRONTA_IMPORTACAO,
      empresa_id: empresaA.id,
      fornecedor: 'Distribuidora Alfa'
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.ok, true);
    assert.equal(out.total_pendentes_conversao, 1);
    assert.equal(out.pendentes_conversao[0].classificacao, CLASSIFICACAO.PENDENTE_CONVERSAO);
    assert.equal(out.pendentes_conversao[0].fornecedor, 'Distribuidora Alfa');
    await closeDb(db);
  });

  it('02 documento convertido com compra não aparece como pendente', async () => {
    const { db, empresaA } = await setup();
    const compraId = await criarCompra(db, empresaA.id);
    await inserirDoc(db, {
      chave: 'CHAVE-CONV-02',
      status: DocumentoFiscalStatus.IMPORTADA,
      empresa_id: empresaA.id,
      compra_id: compraId
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 0);
    assert.equal(out.total_nao_confirmadas, 0);
    await closeDb(db);
  });

  it('03 documento cancelado não aparece', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-CANC-03',
      status: DocumentoFiscalStatus.CANCELADA,
      empresa_id: empresaA.id
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 0);
    await closeDb(db);
  });

  it('04 documento rejeitado/denegado não aparece', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-DEN-04',
      status: DocumentoFiscalStatus.DENEGADA,
      empresa_id: empresaA.id
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 0);
    await closeDb(db);
  });

  it('05 documento finalizado (sem política de estoque / descartado) não aparece como crédito pendente', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-FIN-05',
      status: DocumentoFiscalStatus.FINALIZADA,
      empresa_id: empresaA.id
    });
    // Limitação: política de entrada só existe na compra; FINALIZADA/DESCARTADA é excluída.
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 0);
    assert.match(String(out.limitacao || ''), /compra_id|IMPORTADA/i);
    await closeDb(db);
  });

  it('06 documento em revisão (aguardando associação) classificado como pendente', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-REV-06',
      status: DocumentoFiscalStatus.EM_REVISAO,
      empresa_id: empresaA.id,
      miip_resumo_json: JSON.stringify({ resumo: { total_itens: 3 } })
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 1);
    assert.equal(out.pendentes_conversao[0].status, DocumentoFiscalStatus.EM_REVISAO);
    assert.equal(out.pendentes_conversao[0].quantidade_itens, 3);
    await closeDb(db);
  });

  it('07 documento em processamento/importação → NAO_CONFIRMADA', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-PROC-07',
      status: DocumentoFiscalStatus.EM_IMPORTACAO,
      empresa_id: empresaA.id
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 0);
    assert.equal(out.total_nao_confirmadas, 1);
    assert.equal(out.nao_confirmadas[0].classificacao, CLASSIFICACAO.NAO_CONFIRMADA);
    await closeDb(db);
  });

  it('08 documento duplicado (mesma chave) não gera alerta duplicado', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-DUP-08',
      status: DocumentoFiscalStatus.XML_COMPLETO,
      empresa_id: empresaA.id
    });
    await inserirDoc(db, {
      chave: 'CHAVE-DUP-08',
      status: DocumentoFiscalStatus.EM_REVISAO,
      empresa_id: empresaA.id
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 1);
    await closeDb(db);
  });

  it('09 documento da empresa A não aparece na B', async () => {
    const { db, empresaA, empresaB } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-ISO-A-09',
      status: DocumentoFiscalStatus.PRONTA_IMPORTACAO,
      empresa_id: empresaA.id,
      fornecedor: 'Só A'
    });
    const outB = await listarPendenciasEntradaEstoque({ db, empresaId: empresaB.id });
    assert.equal(outB.total_pendentes_conversao, 0);
    const outA = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(outA.total_pendentes_conversao, 1);
    await closeDb(db);
  });

  it('10 consulta respeita empresa destinatária', async () => {
    const { db, empresaA, empresaB } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-DEST-A',
      status: DocumentoFiscalStatus.NOVA,
      empresa_id: empresaA.id
    });
    await inserirDoc(db, {
      chave: 'CHAVE-DEST-B',
      status: DocumentoFiscalStatus.NOVA,
      empresa_id: empresaB.id
    });
    const outA = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(outA.empresa_id, empresaA.id);
    assert.equal(outA.total_pendentes_conversao, 1);
    assert.equal(outA.pendentes_conversao[0].chave, 'CHAVE-DEST-A');
    await closeDb(db);
  });

  it('11 documento sem empresa não é atribuído por fallback', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-SEM-EMP',
      status: DocumentoFiscalStatus.PRONTA_IMPORTACAO,
      empresa_id: null
    });
    const out = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(out.total_pendentes_conversao, 0);
    await closeDb(db);
  });

  it('12 falha de consulta é diferenciada de lista vazia', async () => {
    const { db, empresaA } = await setup();
    const outVazia = await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    assert.equal(outVazia.ok, true);
    assert.equal(outVazia.consulta_disponivel, true);
    assert.equal(outVazia.total_pendentes_conversao, 0);

    await assert.rejects(
      () => listarPendenciasEntradaEstoque({ db: null, empresaId: empresaA.id }),
      (err) => err && err.code === 'DB_OBRIGATORIO'
    );
    await assert.rejects(
      () => listarPendenciasEntradaEstoque({ db, empresaId: null }),
      (err) => err && err.code === 'EMPRESA_OBRIGATORIA'
    );
    await closeDb(db);
  });

  it('13 API/serviço não altera nenhum saldo', async () => {
    const { db, empresaA } = await setup();
    const p = await run(
      db,
      `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('X', 10, 5, 15)`
    );
    await EstoqueEmpresaService.criarRegistro({
      produtoId: p.lastID,
      empresaId: empresaA.id,
      saldo_fiscal: 10,
      saldo_nao_fiscal: 5,
      estoque_atual: 15
    }, { db });
    await inserirDoc(db, {
      chave: 'CHAVE-SALDO-13',
      status: DocumentoFiscalStatus.XML_COMPLETO,
      empresa_id: empresaA.id
    });
    await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    const ee = await get(
      db,
      'SELECT saldo_fiscal, saldo_nao_fiscal, estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
      [p.lastID, empresaA.id]
    );
    assert.equal(Number(ee.saldo_fiscal), 10);
    assert.equal(Number(ee.saldo_nao_fiscal), 5);
    assert.equal(Number(ee.estoque_atual), 15);
    await closeDb(db);
  });

  it('14 API/serviço não cria compra', async () => {
    const { db, empresaA } = await setup();
    await inserirDoc(db, {
      chave: 'CHAVE-COMPRA-14',
      status: DocumentoFiscalStatus.PRONTA_IMPORTACAO,
      empresa_id: empresaA.id
    });
    const antes = await get(db, 'SELECT COUNT(*) AS n FROM compras');
    await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    const depois = await get(db, 'SELECT COUNT(*) AS n FROM compras');
    assert.equal(Number(antes.n), Number(depois.n));
    await closeDb(db);
  });

  it('15 API/serviço não altera estados da Central', async () => {
    const { db, empresaA } = await setup();
    const id = await inserirDoc(db, {
      chave: 'CHAVE-STATUS-15',
      status: DocumentoFiscalStatus.EM_REVISAO,
      empresa_id: empresaA.id
    });
    await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });
    const row = await get(db, 'SELECT status, compra_id FROM central_entradas_documentos WHERE id = ?', [id]);
    assert.equal(row.status, DocumentoFiscalStatus.EM_REVISAO);
    assert.equal(row.compra_id, null);
    await closeDb(db);
  });

  it('16 alerta não bloqueia confirmação da contagem (fonte UI)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/erp/js/contagem-estoque.js'),
      'utf8'
    );
    assert.match(src, /carregarPendenciasEntrada|pendencias-entrada/);
    assert.match(src, /não bloqueia|nao bloqueia|ATENÇÃO — EXISTEM ENTRADAS PENDENTES/i);
    assert.match(src, /central-entradas/);
    // Confirmação permanece independente do alerta de pendências.
    assert.match(src, /async function confirmar/);
    assert.equal(/if\s*\(\s*total_pendentes[\s\S]{0,80}return\s*;/.test(src), false);
  });

  it('17 snapshot da Sprint 03.1 permanece preservado', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/erp/js/contagem-estoque.js'),
      'utf8'
    );
    assert.match(src, /saldo_fiscal_esperado/);
    assert.match(src, /saldo_nao_fiscal_esperado/);
    assert.match(src, /CONTAGEM_DESATUALIZADA/);
    const rotas = fs.readFileSync(
      path.resolve(__dirname, '../../backend/rotas/estoque.js'),
      'utf8'
    );
    assert.match(rotas, /exigirSnapshotItensOficiais/);
    assert.match(rotas, /pendencias-entrada/);
  });

  it('18 CONTAGEM_DESATUALIZADA continua funcionando', async () => {
    const { db, empresaA } = await setup();
    const p = await run(
      db,
      `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('Y', 24000, 0, 24000)`
    );
    await EstoqueEmpresaService.criarRegistro({
      produtoId: p.lastID,
      empresaId: empresaA.id,
      saldo_fiscal: 24000,
      saldo_nao_fiscal: 0,
      estoque_atual: 24000
    }, { db });
    await inserirDoc(db, {
      chave: 'CHAVE-SNAP-18',
      status: DocumentoFiscalStatus.PRONTA_IMPORTACAO,
      empresa_id: empresaA.id
    });
    await listarPendenciasEntradaEstoque({ db, empresaId: empresaA.id });

    const itens = exigirSnapshotItensOficiais([{
      produto_id: p.lastID,
      quantidade_fiscal_contada: 10000,
      quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0
    }]);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      itens,
      chaveIdempotencia: 'pend-18-a'
    });
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        itens: exigirSnapshotItensOficiais([{
          produto_id: p.lastID,
          quantidade_fiscal_contada: 12000,
          quantidade_nao_fiscal_contada: 0,
          saldo_fiscal_esperado: 24000,
          saldo_nao_fiscal_esperado: 0
        }]),
        chaveIdempotencia: 'pend-18-b'
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    await closeDb(db);
  });

  it('rota oficial registra pendencias-entrada antes de :id', () => {
    const rotas = fs.readFileSync(
      path.resolve(__dirname, '../../backend/rotas/estoque.js'),
      'utf8'
    );
    const iPend = rotas.indexOf("'/contagem-fisica/pendencias-entrada'");
    const iId = rotas.indexOf("'/contagem-fisica/:id'");
    assert.ok(iPend > 0 && iId > iPend);
  });
});
