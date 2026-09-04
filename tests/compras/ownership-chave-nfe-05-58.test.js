/**
 * Sprint 05.58 — Ownership PUT chave NF-e da compra.
 * Executar: node tests/compras/ownership-chave-nfe-05-58.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  exigirCompraDaEmpresa,
  exigirCompraParaMutacaoOpaca,
  atualizarChaveNfeFornecedorCompra
} = require('../../backend/services/compras/ComprasEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_ANTIGA = '11111111111111111111111111111111111111111111';
const CHAVE_NOVA = '22222222222222222222222222222222222222222222';
const CHAVE_C = '33333333333333333333333333333333333333333333';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

function putChave(db, { compraId, empresaId, chave, empresaIdBody }) {
  return new Promise((resolve, reject) => {
    atualizarChaveNfeFornecedorCompra(db, {
      compraId,
      empresaId,
      chave,
      empresa_id: empresaIdBody,
      empresaIdBody
    }, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function semVazamento(err) {
  const texto = JSON.stringify(err);
  assert.ok(!Object.prototype.hasOwnProperty.call(err, 'compra_empresa_id'));
  assert.ok(!Object.prototype.hasOwnProperty.call(err, 'empresa_id') || err.code === 'COMPRA_AUSENTE');
  assert.ok(!texto.includes('CHAVE_ANTIGA'));
  assert.ok(!texto.includes(CHAVE_ANTIGA));
  return true;
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fornecedor TEXT,
      chave_acesso TEXT,
      empresa_id INTEGER,
      total REAL
    )
  `);
  return db;
}

async function inserirCompra(db, { empresaId, chave, fornecedor }) {
  const r = await run(
    db,
    `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, total) VALUES (?, ?, ?, 10)`,
    [fornecedor || 'Forn A', chave, empresaId == null ? null : empresaId]
  );
  return r.lastID;
}

async function t01compraAContextoA() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_A, chave: CHAVE_ANTIGA });
  const r = await putChave(db, { compraId: id, empresaId: EMP_A, chave: CHAVE_NOVA });
  assert.strictEqual(r.success, true);
  const row = await get(db, 'SELECT chave_acesso, empresa_id FROM compras WHERE id=?', [id]);
  assert.strictEqual(row.chave_acesso, CHAVE_NOVA);
  assert.strictEqual(row.empresa_id, EMP_A);
  db.close();
}

async function t02compraAContextoB() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_A, chave: CHAVE_ANTIGA, fornecedor: 'Segredo A' });
  await assert.rejects(
    () => putChave(db, { compraId: id, empresaId: EMP_B, chave: CHAVE_NOVA }),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA' && err.statusCode === 404 && semVazamento(err)
  );
  db.close();
}

async function t03compraBContextoA() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_B, chave: CHAVE_ANTIGA });
  await assert.rejects(
    () => putChave(db, { compraId: id, empresaId: EMP_A, chave: CHAVE_NOVA }),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA' && err.statusCode === 404
  );
  db.close();
}

async function t04crossNaoAltera() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_A, chave: CHAVE_ANTIGA, fornecedor: 'Forn Imutavel' });
  const antes = await get(db, 'SELECT * FROM compras WHERE id=?', [id]);
  await assert.rejects(
    () => putChave(db, { compraId: id, empresaId: EMP_B, chave: CHAVE_NOVA }),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  const depois = await get(db, 'SELECT * FROM compras WHERE id=?', [id]);
  assert.deepStrictEqual(depois, antes);
  db.close();
}

async function t05empresaNull() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: null, chave: CHAVE_ANTIGA });
  await assert.rejects(
    () => putChave(db, { compraId: id, empresaId: EMP_A, chave: CHAVE_NOVA }),
    (err) => err.code === 'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const row = await get(db, 'SELECT chave_acesso, empresa_id FROM compras WHERE id=?', [id]);
  assert.strictEqual(row.chave_acesso, CHAVE_ANTIGA);
  assert.strictEqual(row.empresa_id, null);
  db.close();
}

async function t06bodyNaoSubstitui() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_A, chave: CHAVE_ANTIGA });
  await putChave(db, {
    compraId: id,
    empresaId: EMP_A,
    chave: CHAVE_NOVA,
    empresaIdBody: EMP_B
  });
  const row = await get(db, 'SELECT chave_acesso, empresa_id FROM compras WHERE id=?', [id]);
  assert.strictEqual(row.empresa_id, EMP_A);
  assert.strictEqual(row.chave_acesso, CHAVE_NOVA);
  db.close();
}

async function t07contextoABodyBNaoAtravessa() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_B, chave: CHAVE_ANTIGA });
  await assert.rejects(
    () => putChave(db, {
      compraId: id,
      empresaId: EMP_A,
      chave: CHAVE_NOVA,
      empresaIdBody: EMP_B
    }),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  const row = await get(db, 'SELECT chave_acesso, empresa_id FROM compras WHERE id=?', [id]);
  assert.strictEqual(row.chave_acesso, CHAVE_ANTIGA);
  assert.strictEqual(row.empresa_id, EMP_B);
  db.close();
}

async function t08centralAContextoA() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_A, chave: CHAVE_ANTIGA });
  await putChave(db, { compraId: id, empresaId: EMP_A, chave: CHAVE_C });
  const row = await get(db, 'SELECT empresa_id, chave_acesso FROM compras WHERE id=?', [id]);
  assert.strictEqual(row.empresa_id, EMP_A);
  assert.strictEqual(row.chave_acesso, CHAVE_C);
  db.close();
}

async function t09centralAContextoB() {
  const db = await criarDb();
  const id = await inserirCompra(db, { empresaId: EMP_A, chave: CHAVE_ANTIGA });
  await assert.rejects(
    () => putChave(db, { compraId: id, empresaId: EMP_B, chave: CHAVE_NOVA }),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  const row = await get(db, 'SELECT chave_acesso FROM compras WHERE id=?', [id]);
  assert.strictEqual(row.chave_acesso, CHAVE_ANTIGA);
  db.close();
}

async function t10inexistente() {
  const db = await criarDb();
  await assert.rejects(
    () => putChave(db, { compraId: 99999, empresaId: EMP_A, chave: CHAVE_NOVA }),
    (err) => err.code === 'COMPRA_AUSENTE' && err.statusCode === 404
      && err.message === 'Compra não encontrada.'
  );
  assert.throws(
    () => exigirCompraDaEmpresa({ id: 1, empresa_id: EMP_A }, EMP_B),
    (err) => err.code === 'COMPRA_EMPRESA_INCOMPATIVEL' && err.statusCode === 403
  );
  assert.throws(
    () => exigirCompraParaMutacaoOpaca({ id: 1, empresa_id: EMP_A }, EMP_B),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  const rotas = src('backend/rotas/compras.js');
  const put = rotas.indexOf("router.put('/:id/chave-nfe-fornecedor'");
  const bloco = rotas.slice(put, put + 1800);
  assert.ok(bloco.includes('resolverEmpresaContextoCompra'));
  assert.ok(bloco.includes('atualizarChaveNfeFornecedorCompra'));
  assert.ok(!bloco.includes('body.empresa_id'));
  db.close();
}

const TESTS = [
  ['T01 compra A + contexto A altera chave', t01compraAContextoA],
  ['T02 compra A + contexto B → 404', t02compraAContextoB],
  ['T03 compra B + contexto A → 404', t03compraBContextoA],
  ['T04 cruzado não muta', t04crossNaoAltera],
  ['T05 empresa_id NULL → EMPRESA_OWNERSHIP_REQUIRED', t05empresaNull],
  ['T06 body B não substitui ownership A', t06bodyNaoSubstitui],
  ['T07 contexto A + body B não atravessa compra B', t07contextoABodyBNaoAtravessa],
  ['T08 Central/compra A + contexto A permite', t08centralAContextoA],
  ['T09 Central/compra A + contexto B → 404', t09centralAContextoB],
  ['T10 inexistente COMPRA_AUSENTE; GET permanece 403', t10inexistente]
];

(async () => {
  let ok = 0;
  let fail = 0;
  for (const [nome, fn] of TESTS) {
    try {
      await fn();
      ok += 1;
      console.log(`  OK  ${nome}`);
    } catch (err) {
      fail += 1;
      console.error(`  FAIL ${nome}:`, err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
