/**
 * Sprint 05.63 — Auditoria: leitura financeira em GET /compras e GET /compras/:id.
 * Comprova o comportamento ATUAL. Não altera produção.
 * Executar: node tests/auditoria/leitura-financeiro-compras-05-63.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { exigirCompraParaMutacaoOpaca } = require('../../backend/services/compras/ComprasEmpresaContextoService');

const EMP_A = 11;
const EMP_B = 22;

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function rotas() {
  return src('backend/rotas/compras.js');
}

function handlerLista() {
  const t = rotas();
  const i = t.indexOf("router.get('/',");
  const j = t.indexOf("router.get('/:id'", i);
  assert.ok(i >= 0 && j > i);
  return t.slice(i, j);
}

function handlerDetalhe() {
  const t = rotas();
  const i = t.indexOf("router.get('/:id'");
  const j = t.indexOf("router.post('/',", i);
  assert.ok(i >= 0 && j > i);
  return t.slice(i, j);
}

function handlerRelatorio() {
  const t = rotas();
  const i = t.indexOf("router.get('/relatorio/uso-consumo'");
  const j = t.indexOf("router.get('/politicas-entrada'", i);
  return t.slice(i, j);
}

function sqlLista() {
  return `
    SELECT c.*,
      (SELECT COUNT(*) FROM financeiro f
        WHERE f.compra_id = c.id AND f.status = 'pendente' AND f.empresa_id = c.empresa_id) as parcelas_pendentes
    FROM compras c
    WHERE c.empresa_id = ?
    ORDER BY c.data_compra DESC, c.id DESC
  `;
}

function sqlFinanceiroDetalhe(compraId, empresaId) {
  return ['SELECT * FROM financeiro WHERE compra_id = ? AND empresa_id = ? ORDER BY numero_parcela, vencimento', [compraId, empresaId]];
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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
      data_compra DATE,
      fornecedor TEXT,
      total REAL,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      status TEXT,
      vencimento TEXT,
      numero_parcela INTEGER,
      valor REAL,
      pessoa_nome TEXT,
      empresa_id INTEGER
    )
  `);
  return db;
}

async function seed(db) {
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 11), (101, '2026-01-11', 'FORN_B', 80, 22)`);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, numero_parcela, valor, pessoa_nome, empresa_id)
    VALUES
    (100, 'pendente', '2026-02-01', 1, 50, 'FORN_A', 11),
    (100, 'pendente', '2026-03-01', 2, 999, 'FORN_B_VAZADO', 22),
    (100, 'pendente', '2026-04-01', 3, 1, 'LEGADO_NULL', NULL),
    (101, 'pendente', '2026-02-01', 1, 80, 'FORN_B', 22)`);
}

function t01inventarioLista() {
  const h = handlerLista();
  assert.ok(h.includes('resolverEmpresaContextoCompra'));
  assert.ok(h.includes('WHERE c.empresa_id = ?'));
  assert.ok(h.includes("FROM financeiro f WHERE f.compra_id = c.id AND f.status = 'pendente' AND f.empresa_id = c.empresa_id"));
  assert.ok(!/JOIN financeiro/i.test(h));
  const ocorrencias = (h.match(/FROM financeiro/g) || []).length;
  assert.strictEqual(ocorrencias, 1, 'uma subquery financeiro na listagem');
  console.log('  T01 GET / : subquery COUNT pendentes com f.empresa_id = c.empresa_id (05.64)');
}

function t02inventarioDetalhe() {
  const h = handlerDetalhe();
  assert.ok(h.includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(h.includes("SELECT * FROM financeiro WHERE compra_id = ? AND empresa_id = ?"));
  assert.ok(h.includes('[id, compra.empresa_id]'));
  assert.strictEqual((h.match(/FROM financeiro/g) || []).length, 1);
  console.log('  T02 GET /:id : SELECT financeiro por compra_id e empresa_id da compra (05.64)');
}

function t03semHelper() {
  const lista = handlerLista();
  const det = handlerDetalhe();
  assert.ok(!/FinanceiroEmpresaContextoService/.test(lista));
  assert.ok(!/FinanceiroEmpresaContextoService/.test(det));
  assert.ok(!/require\(.*financeiro/.test(lista));
  assert.ok(!/require\(.*financeiro/.test(det));
  console.log('  T03 leitores inline; sem repository/helper financeiro');
}

async function t04listaInflaPendentes() {
  const db = await criarDb();
  await seed(db);
  const rows = await all(db, sqlLista(), [EMP_A]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 100);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 1);
  db.close();
  console.log('  T04 listagem A: parcelas_pendentes = 1 (B e NULL excluídos)');
}

async function t05detalheVazaLinhas() {
  const db = await criarDb();
  await seed(db);
  const [sql, params] = sqlFinanceiroDetalhe(100, EMP_A);
  const fins = await all(db, sql, params);
  assert.strictEqual(fins.length, 1);
  assert.ok(!fins.some((f) => f.pessoa_nome === 'FORN_B_VAZADO'));
  assert.ok(!fins.some((f) => f.empresa_id === EMP_B));
  db.close();
  console.log('  T05 GET /:id equivalente: não devolve lançamento B');
}

async function t06cruzadoCompra() {
  const db = await criarDb();
  await seed(db);
  const listaB = await all(db, sqlLista(), [EMP_B]);
  assert.ok(!listaB.some((r) => r.id === 100));
  const compraA = { id: 100, empresa_id: EMP_A, fornecedor: 'FORN_A' };
  try {
    exigirCompraParaMutacaoOpaca(compraA, EMP_B, { tratarInexistenteComoNaoEncontrada: true });
    assert.fail('cruzado deveria 404');
  } catch (err) {
    assert.strictEqual(err.code, 'COMPRA_NAO_ENCONTRADA');
  }
  db.close();
  console.log('  T06 B não lista compra A; GET /:id cruzado 404 (05.59)');
}

async function t07nullContado() {
  const db = await criarDb();
  await seed(db);
  const rows = await all(db, sqlLista(), [EMP_A]);
  const [sql, params] = sqlFinanceiroDetalhe(100, EMP_A);
  const fins = await all(db, sql, params);
  assert.ok(!fins.some((f) => f.empresa_id == null));
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 1);
  db.close();
  console.log('  T07 financeiro NULL não entra na listagem nem no detalhe isolado');
}

function t08relatorioIntacto() {
  const h = handlerRelatorio();
  const n = (h.match(/f\.empresa_id\s*=\s*c\.empresa_id/g) || []).length;
  assert.strictEqual(n, 3, '05.62 permanece no relatório');
  assert.ok(handlerLista().includes('f.empresa_id = c.empresa_id'));
  console.log('  T08 relatório 05.62 intacto; lista também isola (05.64)');
}

function t09nfeForaEscopo() {
  const h = handlerLista();
  assert.ok(h.includes('nfe_devolucoes_compra'));
  assert.ok(h.includes('compras_itens'));
  console.log('  T09 GET / também agrega NF-e devolução e itens — FORA DO ESCOPO (não financeiro)');
}

function t10writersNaoSaoLeitores() {
  const t = rotas();
  assert.ok(t.includes("DELETE FROM financeiro WHERE compra_id = ?"));
  assert.ok(t.includes('INSERT INTO financeiro'));
  assert.ok(!handlerLista().includes('INSERT INTO financeiro'));
  assert.ok(!handlerDetalhe().includes('INSERT INTO financeiro'));
  console.log('  T10 writers financeiro existem na rota mas fora dos GET de leitura');
}

async function main() {
  console.log('05.63 auditoria leitura financeiro compras');
  t01inventarioLista();
  t02inventarioDetalhe();
  t03semHelper();
  await t04listaInflaPendentes();
  await t05detalheVazaLinhas();
  await t06cruzadoCompra();
  await t07nullContado();
  t08relatorioIntacto();
  t09nfeForaEscopo();
  t10writersNaoSaoLeitores();
  console.log('T01–T10 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
