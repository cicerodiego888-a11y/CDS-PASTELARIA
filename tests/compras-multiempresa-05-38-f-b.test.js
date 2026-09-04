/**
 * Sprint 05.38.F.B — Compras por empresa.
 * Executar: node tests/compras-multiempresa-05-38-f-b.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..');
const configService = require('../backend/services/configuracaoService');
const { ModoOperacionalGlobal } = require('../backend/core/modo-operacional');
const {
  resolverEmpresaDaCompra,
  resolverEmpresaContextoCompra,
  exigirCompraDaEmpresa
} = require('../backend/services/compras/ComprasEmpresaContextoService');
const {
  migrarEmpresaIdCompras,
  backfillComprasEmpresaId,
  resolverEmpresaIdBackfillCompras
} = require('../backend/utils/comprasEmpresaHelpers');
const { garantirSchemaEmpresasAsync } = require('../backend/services/empresas/empresasSchema');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-0538fb-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  const finish = () => {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function writeConfig(dbDir, obj) {
  const p = path.join(dbDir, 'config', 'configuracoes.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_compra TEXT,
      total REAL,
      status TEXT DEFAULT 'concluida',
      chave_acesso TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT,
      xml TEXT DEFAULT '<n/>',
      status TEXT DEFAULT 'PRONTA_PARA_COMPRA',
      compra_id INTEGER,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      valor REAL,
      status TEXT DEFAULT 'pendente',
      empresa_id INTEGER
    )
  `);
  return db;
}

async function seedEmpresas(db, lista) {
  for (const e of lista) {
    await run(
      db,
      `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
       VALUES (?, ?, ?, ?, ?)`,
      [e.id, e.cnpj, e.razao_social, e.nome_fantasia || e.razao_social, e.ativo != null ? e.ativo : 1]
    );
  }
}

const EMP_A = { id: 10, cnpj: '11111111000191', razao_social: 'Empresa A SA', ativo: 1 };
const EMP_B = { id: 20, cnpj: '22222222000182', razao_social: 'Empresa B SA', ativo: 1 };
const EMP_INATIVA = { id: 30, cnpj: '33333333000173', razao_social: 'Inativa', ativo: 0 };

async function testSchemaEstrutural() {
  const dbSrc = src('backend/database.js');
  assert.ok(dbSrc.includes('compras') && dbSrc.includes('empresa_id'));
  assert.ok(src('backend/utils/comprasEmpresaHelpers.js').includes('idx_compras_empresa_id'));
  assert.ok(src('backend/rotas/compras.js').includes('empresa_id'));
  assert.ok(src('backend/rotas/compras.js').includes('resolverEmpresaDaCompra'));
  const insert = src('backend/rotas/compras.js');
  assert.ok(insert.includes('escrituracao_motivo, empresa_id'));
  assert.ok(insert.includes('empresaCompraId'));
}

async function testMigrationIdempotente() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A]);
  const r1 = await migrarEmpresaIdCompras(db, {
    resolverEmpresaIdBackfill: async () => EMP_A.id
  });
  const r2 = await migrarEmpresaIdCompras(db, {
    resolverEmpresaIdBackfill: async () => EMP_A.id
  });
  assert.strictEqual(r2.added, false);
  assert.ok(r1.added === false || r1.added === true);
  db.close();
}

async function testBackfillCentral() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A, EMP_B]);
  await run(db, `INSERT INTO compras (id, data_compra, total, empresa_id) VALUES (1, '2026-01-01', 10, NULL)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, empresa_id) VALUES (1, 1, ?)`, [EMP_A.id]);
  const fill = await backfillComprasEmpresaId(db, null);
  assert.ok(fill.fromCentral >= 1);
  const row = await get(db, `SELECT empresa_id FROM compras WHERE id=1`);
  assert.strictEqual(row.empresa_id, EMP_A.id);
  db.close();
}

async function testBackfillFinanceiro() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A, EMP_B]);
  await run(db, `INSERT INTO compras (id, data_compra, total, empresa_id) VALUES (2, '2026-01-01', 20, NULL)`);
  await run(db, `INSERT INTO financeiro (compra_id, valor, empresa_id) VALUES (2, 20, ?)`, [EMP_B.id]);
  const fill = await backfillComprasEmpresaId(db, null);
  assert.ok(fill.fromFinanceiro >= 1);
  const row = await get(db, `SELECT empresa_id FROM compras WHERE id=2`);
  assert.strictEqual(row.empresa_id, EMP_B.id);
  db.close();
}

async function testBackfillSimplesSeguro() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A]);
    await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-01-01', 5, NULL)`);
    const info = await migrarEmpresaIdCompras(db);
    assert.ok(info.fromOperacional >= 1 || info.empresaId === EMP_A.id);
    const row = await get(db, `SELECT empresa_id FROM compras LIMIT 1`);
    assert.strictEqual(row.empresa_id, EMP_A.id);
    db.close();
  });
}

async function testBackfillMultiAmbiguoNull() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-01-01', 5, NULL)`);
    const seguro = await resolverEmpresaIdBackfillCompras(db);
    assert.strictEqual(seguro, null);
    await backfillComprasEmpresaId(db, null);
    const row = await get(db, `SELECT empresa_id FROM compras LIMIT 1`);
    assert.strictEqual(row.empresa_id, null);
    db.close();
  });
}

async function testBackfillNaoSobrescreve() {
  const db = await criarDb();
  await seedEmpresas(db, [EMP_A, EMP_B]);
  await run(db, `INSERT INTO compras (id, data_compra, total, empresa_id) VALUES (9, '2026-01-01', 1, ?)`, [EMP_A.id]);
  await run(db, `INSERT INTO central_entradas_documentos (compra_id, empresa_id) VALUES (9, ?)`, [EMP_B.id]);
  await backfillComprasEmpresaId(db, EMP_B.id);
  const row = await get(db, `SELECT empresa_id FROM compras WHERE id=9`);
  assert.strictEqual(row.empresa_id, EMP_A.id);
  db.close();
}

async function testSimplesResolveSemHeader() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A]);
    const r = await resolverEmpresaDaCompra({}, {}, {
      db,
      listarEmpresasAtivas: async () => [EMP_A]
    });
    assert.strictEqual(r.empresaId, EMP_A.id);
    assert.strictEqual(r.modo, ModoOperacionalGlobal.EMPRESA_SIMPLES);
    db.close();
  });
}

async function testMultiComHeader() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const r = await resolverEmpresaDaCompra({ empresaId: EMP_A.id }, {}, { db });
    assert.strictEqual(r.empresaId, EMP_A.id);
    assert.strictEqual(r.exigirEmpresaEstoque, true);
    db.close();
  });
}

async function testMultiSemContextoErro() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A]);
    await assert.rejects(
      () => resolverEmpresaDaCompra({}, {}, { db }),
      (err) => err && err.code === 'EMPRESA_COMPRA_AUSENTE'
    );
    db.close();
  });
}

async function testDocumentoAContextoBBloqueado() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    await assert.rejects(
      () => resolverEmpresaDaCompra(
        { empresaId: EMP_B.id },
        { centralDocumentoId: 77 },
        {
          db,
          buscarDocumentoCentral: async () => ({ id: 77, empresaId: EMP_A.id, status: 'PRONTA_PARA_COMPRA' })
        }
      ),
      (err) => err && err.code === 'DOCUMENTO_NAO_ENCONTRADO'
    );
    db.close();
  });
}

async function testDocumentoAContextoAOk() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const r = await resolverEmpresaDaCompra(
      { empresaId: EMP_A.id },
      { centralDocumentoId: 78 },
      {
        db,
        buscarDocumentoCentral: async () => ({ id: 78, empresaId: EMP_A.id, status: 'PRONTA_PARA_COMPRA' })
      }
    );
    assert.strictEqual(r.empresaId, EMP_A.id);
    assert.strictEqual(r.origem, 'DOCUMENTO_CENTRAL');
    db.close();
  });
}

async function testOwnership() {
  assert.throws(
    () => exigirCompraDaEmpresa({ id: 1, empresa_id: EMP_A.id }, EMP_B.id),
    (err) => err && err.code === 'COMPRA_EMPRESA_INCOMPATIVEL'
  );
  assert.doesNotThrow(() => exigirCompraDaEmpresa({ id: 1, empresa_id: EMP_A.id }, EMP_A.id));
  assert.throws(
    () => exigirCompraDaEmpresa({ id: 2, empresa_id: null }, EMP_A.id, {
      modo: ModoOperacionalGlobal.MULTIEMPRESA
    }),
    (err) => err && err.code === 'EMPRESA_COMPRA_NAO_RESOLVIDA'
  );
}

async function testListagemIsoladaContexto() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_A, EMP_B]);
    const ctx = await resolverEmpresaContextoCompra({ empresaId: EMP_A.id }, { db });
    assert.strictEqual(ctx.empresaId, EMP_A.id);
    db.close();
  });
}

async function testConsistenciaCodigo() {
  const rotas = src('backend/rotas/compras.js');
  assert.ok(rotas.includes('empresaCompraId'));
  assert.ok(rotas.includes('exigirEmpresa: exigirEmpresaEstoque') || rotas.includes('exigirEmpresaEstoque'));
  assert.ok(rotas.includes('WHERE c.empresa_id = ?'));
  assert.ok(rotas.includes('exigirCompraDaEmpresa'));
  assert.ok(!rotas.includes('compraEmpresaId || documento.empresaId'));
  const bridge = src('backend/motores/central-entradas/services/CentralComprasBridgeService.js');
  assert.ok(bridge.includes('EMPRESA_COMPRA_AUSENTE') || bridge.includes('exigirDocumentoCompraMesmaEmpresa'));
  const fe = src('frontend/erp/js/compras.js');
  assert.ok(fe.includes('centralEmpresaIdAtual') || fe.includes('empresa_id'));
}

async function testEmpresaInativaBloqueada() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, [EMP_INATIVA]);
    await assert.rejects(
      () => resolverEmpresaDaCompra({ empresaId: EMP_INATIVA.id }, {}, { db }),
      (err) => err && (err.code === 'EMPRESA_INATIVA' || err.code === 'EMPRESA_OPERACIONAL_INVALIDA'
        || err.statusCode === 400)
    );
    db.close();
  });
}

async function main() {
  const testes = [
    ['Schema / INSERT estrutural', testSchemaEstrutural],
    ['Migration idempotente', testMigrationIdempotente],
    ['Backfill via Central', testBackfillCentral],
    ['Backfill via financeiro', testBackfillFinanceiro],
    ['Backfill EMPRESA_SIMPLES seguro', testBackfillSimplesSeguro],
    ['Backfill MULTI ambíguo NULL', testBackfillMultiAmbiguoNull],
    ['Backfill não sobrescreve', testBackfillNaoSobrescreve],
    ['SIMPLES resolve sem header', testSimplesResolveSemHeader],
    ['MULTI com X-Empresa-Id', testMultiComHeader],
    ['MULTI sem contexto → erro', testMultiSemContextoErro],
    ['Documento A + contexto B bloqueado', testDocumentoAContextoBBloqueado],
    ['Documento A + contexto A OK', testDocumentoAContextoAOk],
    ['Ownership compra', testOwnership],
    ['Contexto listagem', testListagemIsoladaContexto],
    ['Consistência estoque/fin/Central no código', testConsistenciaCodigo],
    ['Empresa inativa bloqueada', testEmpresaInativaBloqueada]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      console.log(`PASS — ${nome}`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL — ${nome}`);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nOK ${ok}/${testes.length} testes 05.38.F.B`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
