/**
 * Sprint 05.79 — Todas as empresas (IN autorizado) + layout da lista.
 * Executar: node tests/central-entradas/todas-empresas-inbox-05-79.test.js
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
const {
  aplicarFiltroLeituraEmpresasCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const EMP_A = 11;
const EMP_B = 22;
const EMP_C = 33;

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
  await run(db, `INSERT INTO central_entradas_documentos
    (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
    VALUES ('A1', '1', ?, 100, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
  [DocumentoFiscalStatus.SINCRONIZADA, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos
    (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
    VALUES ('B1', '2', ?, 250, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
  [DocumentoFiscalStatus.EM_REVISAO, EMP_B]);
  await run(db, `INSERT INTO central_entradas_documentos
    (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
    VALUES ('C1', '3', ?, 9000, '2026-08-10', ?, '2026-08-10', '2026-08-10')`,
  [DocumentoFiscalStatus.PRONTA_IMPORTACAO, EMP_C]);
  await run(db, `INSERT INTO central_entradas_documentos
    (chave, numero, status, valor_total, data_emissao, empresa_id, created_at, updated_at)
    VALUES ('N1', '9', ?, 9999, '2026-08-10', NULL, '2026-08-10', '2026-08-10')`,
  [DocumentoFiscalStatus.SINCRONIZADA]);
}

const frontSrc = src('frontend/erp/js/central-entradas.js');
const cssSrc = src('frontend/css/central-entradas-05-77.css');
const rotas = src('backend/rotas/central-entradas.js');
const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');

describe('05.79 — isolamento lista', () => {
  it('T01 — empresa A não lista B/C/NULL', async () => {
    const db = await criarDb();
    await seed(db);
    const repo = new CentralDocumentosRepository({ db });
    const a = await repo.contarPorStatus({ empresaId: EMP_A });
    const totalA = Object.values(a).reduce((s, n) => s + Number(n || 0), 0);
    assert.equal(totalA, 1);
    assert.equal(a[DocumentoFiscalStatus.SINCRONIZADA], 1);
    db.close();
  });

  it('T02 T03 T04 — IN A+B inclui A e B, exclui C e NULL', async () => {
    const db = await criarDb();
    await seed(db);
    const repo = new CentralDocumentosRepository({ db });
    const ab = await repo.contarPorStatus({ empresaIds: [EMP_A, EMP_B] });
    const c = await repo.contarPorStatus({ empresaId: EMP_C });
    const nulo = await repo.contarPorStatus({ empresaId: EMP_A });
    const totalAb = Object.values(ab).reduce((s, n) => s + Number(n || 0), 0);
    const totalC = Object.values(c).reduce((s, n) => s + Number(n || 0), 0);
    assert.equal(totalAb, 2);
    assert.equal(ab[DocumentoFiscalStatus.SINCRONIZADA], 1);
    assert.equal(ab[DocumentoFiscalStatus.EM_REVISAO], 1);
    assert.equal(ab[DocumentoFiscalStatus.PRONTA_IMPORTACAO], undefined);
    assert.equal(totalC, 1);
    assert.ok(nulo[DocumentoFiscalStatus.SINCRONIZADA] === 1);
    db.close();
  });

  it('T05 — string todas sem IDs não vaza SELECT global', async () => {
    const db = await criarDb();
    await seed(db);
    const repo = new CentralDocumentosRepository({ db });
    const r = await repo.contarPorStatus({ empresaId: 'todas' });
    const total = Object.values(r).reduce((s, n) => s + Number(n || 0), 0);
    assert.equal(total, 0);
    db.close();
  });

  it('T06 — IN vazio retorna vazio', async () => {
    const db = await criarDb();
    await seed(db);
    const repo = new CentralDocumentosRepository({ db });
    const r = await repo.contarPorStatus({ empresaIds: [] });
    const total = Object.values(r).reduce((s, n) => s + Number(n || 0), 0);
    assert.equal(total, 0);
    db.close();
  });

  it('T07 — indicadores IN A+B somam só autorizadas', async () => {
    const db = await criarDb();
    await seed(db);
    const ind = await obterIndicadoresCentral({
      ano: 2026,
      mes: 8,
      empresaIds: [EMP_A, EMP_B],
      db
    });
    assert.equal(ind.valorMensal, 350);
    assert.equal(ind.quantidadeMensal, 2);
    db.close();
  });
});

describe('05.79 — filtro de leitura HTTP', () => {
  it('T08 — sem escopo todas usa empresa do contexto', async () => {
    const dest = {};
    const visao = await aplicarFiltroLeituraEmpresasCentral({
      req: { query: {} },
      ctx: { empresaId: EMP_A, modo: ModoOperacionalGlobal.MULTIEMPRESA },
      dest
    });
    assert.equal(visao.visao, 'empresa');
    assert.equal(dest.empresaId, EMP_A);
    assert.equal(dest.empresaIds, undefined);
  });

  it('T09 — escopo todas usa só IDs permitidos (mock)', async () => {
    const dest = {};
    const visao = await aplicarFiltroLeituraEmpresasCentral({
      req: { query: { escopo: 'todas' }, user: { id: 7 } },
      ctx: { empresaId: EMP_A, modo: ModoOperacionalGlobal.MULTIEMPRESA },
      dest
    }, {
      UsuarioEmpresaService: {
        listarEmpresasPermitidas: async () => [{ id: EMP_A }, { id: EMP_B }]
      }
    });
    assert.equal(visao.visao, 'todas');
    assert.deepEqual(dest.empresaIds, [EMP_A, EMP_B]);
    assert.equal(dest.empresaId, null);
  });
});

describe('05.79 — UI e contrato', () => {
  it('T10 — tabela sem grid rc40 na linha', () => {
    assert.match(frontSrc, /central-0577-doc-row/);
    assert.doesNotMatch(frontSrc, /<tr class="central-rc40-doc-row/);
    assert.match(cssSrc, /display:\s*table-row/);
    assert.match(cssSrc, /display:\s*table-cell/);
  });

  it('T11 — um GET com escopo, sem loop por empresa', () => {
    assert.match(frontSrc, /escopo', 'todas'/);
    assert.match(frontSrc, /recarregarDadosCentralAposTrocaEmpresa/);
    assert.doesNotMatch(frontSrc, /empresasPermitidas\.forEach\([\s\S]{0,180}centralEntradasFetch/);
    assert.match(rotas, /aplicarFiltroLeituraEmpresasCentral/);
    assert.match(repoSrc, /empresa_id IN/);
  });

  it('T12 — detalhe alinha contexto ao documento na vista todas', () => {
    assert.match(frontSrc, /function alinharContextoComDocumentoCentral/);
    assert.match(frontSrc, /alinharContextoComDocumentoCentral\(docLista\)/);
  });
});
