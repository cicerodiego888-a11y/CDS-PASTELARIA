/**
 * Sprint 05.66 — Ownership das rotas de NF-e de devolução de compra.
 * Executar: node tests/compras/ownership-nfe-devolucao-compra-05-66.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  carregarCompraAutorizadaP,
  jsonErroCompraOpaca
} = require('../../backend/services/compras/ComprasEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function rotasNfe() {
  const t = src('backend/rotas/compras.js');
  const i = t.indexOf('function autorizarCompraParaNfeDevolucao');
  const j = t.indexOf("router.put('/:id/chave-nfe-fornecedor'");
  assert.ok(i >= 0 && j > i);
  return t.slice(i, j);
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
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY,
      fornecedor TEXT,
      chave_acesso TEXT,
      empresa_id INTEGER,
      status TEXT
    )
  `);
  return db;
}

function t01prepararHistoricoEmitir() {
  const t = src('backend/rotas/compras.js');
  assert.ok(t.includes("await autorizarCompraParaNfeDevolucao(req, Number(req.params.id))"));
  assert.ok(t.includes('await autorizarCompraParaNfeDevolucao(req, compraId)'));
  const n = (t.match(/autorizarCompraParaNfeDevolucao/g) || []).length;
  assert.ok(n >= 4);
  console.log('  T01 preparar/historico/emitir chamam autorizarCompraParaNfeDevolucao');
}

function t02notaIdAntesDoXml() {
  const xml = rotasNfe().slice(rotasNfe().indexOf("router.get('/nfe-devolucao/:notaId/xml'"));
  const auth = xml.indexOf('autorizarNotaNfeDevolucaoCompra');
  const vers = xml.indexOf('obterXmlVersionado');
  assert.ok(auth >= 0 && vers > auth, 'autoriza antes de ler XML');
  console.log('  T02 XML: ownership antes de obterXmlVersionado');
}

function t03todasNotaId() {
  const bloco = rotasNfe();
  const rotas = [
    "router.get('/nfe-devolucao/:notaId/xml'",
    "router.get('/nfe-devolucao/:notaId/danfe'",
    "router.get('/nfe-devolucao/:notaId/status'",
    "router.get('/nfe-devolucao/:notaId/eventos'",
    "router.post('/nfe-devolucao/:notaId/consultar'",
    "router.post('/nfe-devolucao/:notaId/reenviar'",
    "router.post('/nfe-devolucao/:notaId/cancelar'"
  ];
  for (const r of rotas) {
    const i = bloco.indexOf(r);
    assert.ok(i >= 0, r);
    const trecho = bloco.slice(i, i + 450);
    assert.ok(trecho.includes('autorizarNotaNfeDevolucaoCompra'), r);
  }
  console.log('  T03 todas as rotas por notaId autorizam compra da nota');
}

async function t04contextoA() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (100, 'FORN_A', 'CHAVEA', 11, 'concluida')`);
  const compra = await carregarCompraAutorizadaP(db, { compraId: 100, empresaId: EMP_A });
  assert.strictEqual(compra.fornecedor, 'FORN_A');
  db.close();
  console.log('  T04 compra A + contexto A autoriza');
}

async function t05contextoBOpaco() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (100, 'FORN_A_SECRETO', 'CHAVEA', 11, 'concluida')`);
  try {
    await carregarCompraAutorizadaP(db, { compraId: 100, empresaId: EMP_B });
    assert.fail('deveria 404');
  } catch (err) {
    const body = jsonErroCompraOpaca(err);
    assert.strictEqual(body.code, 'COMPRA_NAO_ENCONTRADA');
    assert.ok(!JSON.stringify(body).includes('FORN_A_SECRETO'));
    assert.ok(!JSON.stringify(body).includes('CHAVEA'));
  }
  db.close();
  console.log('  T05 contexto B → 404 opaco, sem vazar fornecedor/chave');
}

async function t06notaCompraA() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, empresa_id) VALUES (100, 'FORN_A', 11)`);
  const nota = { id: 200, compra_id: 100 };
  try {
    await carregarCompraAutorizadaP(db, { compraId: nota.compra_id, empresaId: EMP_B });
    assert.fail('nota de A no contexto B');
  } catch (err) {
    assert.strictEqual(err.code, 'COMPRA_NAO_ENCONTRADA');
  }
  db.close();
  console.log('  T06 nota.compra_id A + contexto B bloqueado');
}

async function t07null() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, empresa_id) VALUES (103, 'NULL', NULL)`);
  try {
    await carregarCompraAutorizadaP(db, { compraId: 103, empresaId: EMP_A });
    assert.fail('NULL');
  } catch (err) {
    assert.strictEqual(err.code, 'EMPRESA_OWNERSHIP_REQUIRED');
  }
  db.close();
  console.log('  T07 compra NULL → EMPRESA_OWNERSHIP_REQUIRED');
}

function t08naoAlteraChaveGlobal() {
  const t = src('backend/rotas/compras.js');
  assert.ok(t.includes("SELECT id, status FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1"));
  assert.ok(!t.includes("SELECT id, status FROM compras WHERE chave_acesso = ? LIMIT 1"));
  const persist = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  assert.ok(persist.includes('SELECT id FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1'));
  const cab = src('backend/services/fiscal/nfeDevolucaoCompra.js');
  assert.ok(cab.includes('WHERE c.id = ?'));
  console.log('  T08 Central existeCompraComChave e carregarCompraCabecalho internos intactos');
}

async function main() {
  console.log('05.66 ownership NF-e devolução compra');
  t01prepararHistoricoEmitir();
  t02notaIdAntesDoXml();
  t03todasNotaId();
  await t04contextoA();
  await t05contextoBOpaco();
  await t06notaCompraA();
  await t07null();
  t08naoAlteraChaveGlobal();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
