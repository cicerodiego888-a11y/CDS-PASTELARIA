/**
 * Sprint 05.78 — Contexto multiempresa da Nova Central (indicadores + troca).
 * Executar: node tests/central-entradas/correcao-contexto-multiempresa-05-78.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { obterIndicadoresCentral } = require('../../backend/services/IndicadoresFiscaisService');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');

const EMP_A = 11;
const EMP_B = 22;

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function criarDb() {
  const db = await openMem();
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT,
      numero TEXT,
      status TEXT,
      valor_total REAL,
      data_emissao TEXT,
      empresa_id INTEGER,
      miip_resumo_json TEXT,
      processado_em TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  await run(db, `
    CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT)
  `);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente', '2')`);
  return db;
}

async function seed(db) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
     VALUES (?, '1', ?, 1000, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
    ['CHAVEA', DocumentoFiscalStatus.SINCRONIZADA, EMP_A]
  );
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
     VALUES (?, '2', ?, 1000, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
    ['CHAVEA2', DocumentoFiscalStatus.EM_REVISAO, EMP_A]
  );
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
     VALUES (?, '3', ?, 250, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
    ['CHAVEB', DocumentoFiscalStatus.PRONTA_IMPORTACAO, EMP_B]
  );
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
     VALUES (?, '4', ?, 80, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
    ['CHAVEB2', DocumentoFiscalStatus.ERRO, EMP_B]
  );
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
     VALUES (?, '9', ?, 9999, '2026-08-10', NULL, '2026-08-10', '2026-08-10')`,
    ['CHAVENULL', DocumentoFiscalStatus.SINCRONIZADA]
  );
}

const rotas = src('backend/rotas/central-entradas.js');
const indSrc = src('backend/services/IndicadoresFiscaisService.js');
const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
const frontSrc = src('frontend/erp/js/central-entradas.js');
const orchSrc = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');

describe('05.78 — indicadores por empresa', () => {
  it('T01 T03 T05 — empresa A: valor e NF-e do mês só A', async () => {
    const db = await criarDb();
    await seed(db);
    const ind = await obterIndicadoresCentral({ ano: 2026, mes: 8, empresaId: EMP_A, db });
    assert.equal(ind.valorMensal, 2000);
    assert.equal(ind.quantidadeMensal, 2);
    assert.ok(ind.valorMensal !== 2000 + 250 + 80 + 9999);
    db.close();
  });

  it('T02 T04 T06 — empresa B: valor e NF-e do ano só B', async () => {
    const db = await criarDb();
    await seed(db);
    const ind = await obterIndicadoresCentral({ ano: 2026, mes: 8, empresaId: EMP_B, db });
    assert.equal(ind.valorAnual, 330);
    assert.equal(ind.quantidadeAnual, 2);
    assert.ok(ind.valorAnual < 1000);
    db.close();
  });

  it('T07 T08 T09 T10 T11 — fila e lista por empresa', async () => {
    const db = await criarDb();
    await seed(db);
    const repo = new CentralDocumentosRepository({ db });
    const a = await repo.contarPorStatus({ empresaId: EMP_A });
    const b = await repo.contarPorStatus({ empresaId: EMP_B });
    assert.equal(a[DocumentoFiscalStatus.EM_REVISAO], 1);
    assert.equal(a[DocumentoFiscalStatus.PRONTA_IMPORTACAO], undefined);
    assert.equal(b[DocumentoFiscalStatus.PRONTA_IMPORTACAO], 1);
    assert.equal(b[DocumentoFiscalStatus.ERRO], 1);
    assert.equal(a[DocumentoFiscalStatus.ERRO], undefined);
    const totalA = Object.values(a).reduce((s, n) => s + Number(n || 0), 0);
    const totalB = Object.values(b).reduce((s, n) => s + Number(n || 0), 0);
    assert.equal(totalA, 2);
    assert.equal(totalB, 2);
    db.close();
  });

  it('T15 T16 — A não recebe B e B não recebe A', async () => {
    const db = await criarDb();
    await seed(db);
    const a = await obterIndicadoresCentral({ ano: 2026, mes: 8, empresaId: EMP_A, db });
    const b = await obterIndicadoresCentral({ ano: 2026, mes: 8, empresaId: EMP_B, db });
    assert.notEqual(a.valorMensal, b.valorMensal);
    assert.equal(a.quantidadeMensal, 2);
    assert.equal(b.quantidadeMensal, 2);
    db.close();
  });

  it('T17 — documento NULL não entra no agregado da empresa', async () => {
    const db = await criarDb();
    await seed(db);
    const a = await obterIndicadoresCentral({ ano: 2026, mes: 8, empresaId: EMP_A, db });
    assert.ok(a.valorMensal < 9999);
    assert.doesNotMatch(indSrc, /COALESCE\(empresa_id/);
    db.close();
  });
});

describe('05.78 — rotas, troca, concorrência', () => {
  it('T12 T13 T24 — troca recarrega e invalida estado', () => {
    assert.match(frontSrc, /function recarregarDadosCentralAposTrocaEmpresa/);
    assert.match(frontSrc, /function invalidarEstadoDadosCentral/);
    assert.match(frontSrc, /ultimoDashboardContadores = null/);
    assert.match(frontSrc, /indicadoresFiscais = null/);
    assert.match(frontSrc, /await Ctx\.selecionar\(id\)/);
  });

  it('T14 T23 — resposta atrasada não sobrescreve', () => {
    assert.match(frontSrc, /contextoSeq/);
    assert.match(frontSrc, /contextoSeqAtualCentral\(\) !== seq/);
    assert.match(frontSrc, /bumpContextoSeqCentral/);
  });

  it('T18 — Todas as empresas usa escopo autorizado, sem empresaId string todas', () => {
    assert.match(frontSrc, /vistaEmpresas = 'todas'/);
    assert.match(frontSrc, /escopo', 'todas'/);
    assert.doesNotMatch(frontSrc, /empresaId:\s*'todas'/);
    assert.match(rotas, /aplicarFiltroLeituraEmpresasCentral/);
  });

  it('T19 T20 — dashboard/saúde/última entrada não reabertos', () => {
    assert.match(rotas, /router\.get\('\/dashboard'[\s\S]{0,400}resolverEmpresaParaCentral/);
    assert.match(src('backend/monitoring/providers/FiscalProvider.js'), /async function ultimaEntradaFiscal\(empresaId/);
    assert.match(repoSrc, /async listarPendentesProcessamento\(limite = 100, empresaId\)/);
  });

  it('T21 — rotas de indicadores exigem empresa', () => {
    assert.match(rotas, /indicadores-fiscais[\s\S]{0,350}resolverEmpresaParaCentral/);
    assert.match(rotas, /inteligencia[\s\S]{0,350}resolverEmpresaParaCentral/);
    assert.match(rotas, /operacional[\s\S]{0,350}resolverEmpresaParaCentral/);
    assert.match(indSrc, /AND empresa_id = \?/);
    assert.match(orchSrc, /empresaId: opcoes\.empresaId/);
  });

  it('T22 T25 — sem fallback de empresa 1; fetch envia X-Empresa-Id', () => {
    assert.doesNotMatch(indSrc, /empresaId \|\| 1|empresa_id \|\| 1/);
    assert.match(frontSrc, /headers\['X-Empresa-Id'\] = String\(emp\)/);
    assert.match(rotas, /aplicarFiltroLeituraEmpresasCentral/);
  });
});
