/**
 * Sprint 05.59 — GET / cancelar / devolver: cruzado → 404 opaco.
 * Executar: node tests/compras/ownership-leitura-mutacao-05-59.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  exigirCompraParaMutacaoOpaca,
  carregarCompraAutorizada,
  jsonErroCompraOpaca,
  atualizarChaveNfeFornecedorCompra
} = require('../../backend/services/compras/ComprasEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_A = '11111111111111111111111111111111111111111111';
const CHAVE_NOVA = '22222222222222222222222222222222222222222222';

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function carregar(db, compraId, empresaId) {
  return new Promise((resolve, reject) => {
    carregarCompraAutorizada(db, { compraId, empresaId }, (err, compra) => {
      if (err) reject(err);
      else resolve(compra);
    });
  });
}

function corpoErro(err) {
  return jsonErroCompraOpaca(err);
}

function naoVaza(payload, compraA) {
  const texto = JSON.stringify(payload);
  assert.strictEqual(payload.code, 'COMPRA_NAO_ENCONTRADA');
  assert.ok(!texto.includes('FORNECEDOR_A'));
  assert.ok(!texto.includes(CHAVE_A));
  assert.ok(!texto.includes('11111111000191'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'empresa_id'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'fornecedor'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'chave_acesso'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'status'));
  assert.ok(!texto.includes('"id":' + compraA.id) || texto === JSON.stringify({
    error: 'Compra não encontrada.',
    code: 'COMPRA_NAO_ENCONTRADA'
  }));
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
      status TEXT,
      total REAL
    )
  `);
  await run(db, `
    CREATE TABLE compras_devolucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      quantidade REAL
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      valor REAL
    )
  `);
  return db;
}

async function seedCompraA(db) {
  const r = await run(
    db,
    `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status, total)
     VALUES (100, 'FORNECEDOR_A', ?, 11, 'concluida', 99.5)`,
    [CHAVE_A]
  );
  await run(db, `INSERT INTO financeiro (compra_id, valor) VALUES (100, 99.5)`);
  return { id: 100, lastID: r.lastID };
}

async function t01getAA() {
  const db = await criarDb();
  await seedCompraA(db);
  const compra = await carregar(db, 100, EMP_A);
  assert.strictEqual(compra.id, 100);
  assert.strictEqual(compra.empresa_id, EMP_A);
  assert.strictEqual(compra.fornecedor, 'FORNECEDOR_A');
  db.close();
}

async function t02getAB() {
  const db = await criarDb();
  await seedCompraA(db);
  await assert.rejects(
    () => carregar(db, 100, EMP_B),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA' && err.statusCode === 404
  );
  db.close();
}

async function t03getBA() {
  const db = await criarDb();
  await run(
    db,
    `INSERT INTO compras (id, fornecedor, empresa_id, status, total)
     VALUES (200, 'FORNECEDOR_B', 22, 'concluida', 10)`
  );
  await assert.rejects(
    () => carregar(db, 200, EMP_A),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  db.close();
}

async function t04getNaoVaza() {
  const db = await criarDb();
  await seedCompraA(db);
  try {
    await carregar(db, 100, EMP_B);
    assert.fail('deveria 404');
  } catch (err) {
    const payload = corpoErro(err);
    naoVaza(payload, { id: 100 });
  }
  db.close();
}

async function t05cancelarAA() {
  const db = await criarDb();
  await seedCompraA(db);
  const compra = await carregar(db, 100, EMP_A);
  exigirCompraParaMutacaoOpaca(compra, EMP_A, { tratarInexistenteComoNaoEncontrada: true });
  await run(db, `UPDATE compras SET status = 'cancelada' WHERE id = ? AND empresa_id = ?`, [100, EMP_A]);
  const row = await get(db, 'SELECT status FROM compras WHERE id=100');
  assert.strictEqual(row.status, 'cancelada');
  db.close();
}

async function t06cancelarAB() {
  const db = await criarDb();
  await seedCompraA(db);
  await assert.rejects(
    () => carregar(db, 100, EMP_B),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  db.close();
}

async function t07cancelarSemMutacao() {
  const db = await criarDb();
  await seedCompraA(db);
  const antesCompra = await get(db, 'SELECT * FROM compras WHERE id=100');
  const antesFin = await all(db, 'SELECT * FROM financeiro WHERE compra_id=100');
  try {
    await carregar(db, 100, EMP_B);
    assert.fail('404');
  } catch (err) {
    assert.strictEqual(err.code, 'COMPRA_NAO_ENCONTRADA');
  }
  const depoisCompra = await get(db, 'SELECT * FROM compras WHERE id=100');
  const depoisFin = await all(db, 'SELECT * FROM financeiro WHERE compra_id=100');
  assert.deepStrictEqual(depoisCompra, antesCompra);
  assert.deepStrictEqual(depoisFin, antesFin);
  db.close();
}

async function t08devolverAA() {
  const db = await criarDb();
  await seedCompraA(db);
  const compra = await carregar(db, 100, EMP_A);
  exigirCompraParaMutacaoOpaca(compra, EMP_A, { tratarInexistenteComoNaoEncontrada: true });
  await run(db, `INSERT INTO compras_devolucoes (compra_id, quantidade) VALUES (100, 1)`);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM compras_devolucoes WHERE compra_id=100');
  assert.strictEqual(n.c, 1);
  db.close();
}

async function t09devolverAB() {
  const db = await criarDb();
  await seedCompraA(db);
  const antes = await all(db, 'SELECT * FROM compras_devolucoes');
  await assert.rejects(() => carregar(db, 100, EMP_B), (err) => err.code === 'COMPRA_NAO_ENCONTRADA');
  const depois = await all(db, 'SELECT * FROM compras_devolucoes');
  assert.deepStrictEqual(depois, antes);
  const compra = await get(db, 'SELECT status FROM compras WHERE id=100');
  assert.strictEqual(compra.status, 'concluida');
  db.close();
}

async function t10null() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(
    db,
    `INSERT INTO compras (id, fornecedor, empresa_id, status, total)
     VALUES (300, 'LEGADO', NULL, 'concluida', 1)`
  );
  await assert.rejects(
    () => carregar(db, 300, EMP_A),
    (err) => err.code === 'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const legado = await get(db, 'SELECT status, empresa_id FROM compras WHERE id=300');
  assert.strictEqual(legado.status, 'concluida');
  assert.strictEqual(legado.empresa_id, null);

  await assert.rejects(
    () => new Promise((resolve, reject) => {
      atualizarChaveNfeFornecedorCompra(db, {
        compraId: 100,
        empresaId: EMP_B,
        chave: CHAVE_NOVA
      }, (err, r) => (err ? reject(err) : resolve(r)));
    }),
    (err) => err.code === 'COMPRA_NAO_ENCONTRADA'
  );
  const chave = await get(db, 'SELECT chave_acesso FROM compras WHERE id=100');
  assert.strictEqual(chave.chave_acesso, CHAVE_A);

  const rotas = src('backend/rotas/compras.js');
  const getBlk = rotas.slice(rotas.indexOf("router.get('/:id'"), rotas.indexOf("router.get('/:id'") + 2200);
  assert.ok(getBlk.includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(rotas.includes("router.post('/:id/cancelar'"));
  assert.ok(rotas.includes("router.post('/:id/devolver'"));
  db.close();
}

const TESTS = [
  ['T01 GET A + contexto A', t01getAA],
  ['T02 GET A + contexto B → 404', t02getAB],
  ['T03 GET B + contexto A → 404', t03getBA],
  ['T04 GET cruzado não vaza dados', t04getNaoVaza],
  ['T05 cancelar A + contexto A', t05cancelarAA],
  ['T06 cancelar A + contexto B → 404', t06cancelarAB],
  ['T07 cancelar cruzado não muta', t07cancelarSemMutacao],
  ['T08 devolver A + contexto A', t08devolverAA],
  ['T09 devolver A + contexto B → 404', t09devolverAB],
  ['T10 NULL → EMPRESA_OWNERSHIP_REQUIRED; PUT 05.58 ok', t10null]
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 10).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
