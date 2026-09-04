/**
 * Sprint 05.60 — Auditoria: leituras de uso/consumo ligadas a compras.
 * Comprova o comportamento ATUAL. Não altera produção.
 * Executar: node tests/auditoria/ownership-uso-consumo-compras-05-60.test.js
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
const PADRAO = 'REVENDA';

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function extrairHandlerRelatorio(rotas) {
  const i = rotas.indexOf("router.get('/relatorio/uso-consumo'");
  assert.ok(i >= 0, 'handler GET /relatorio/uso-consumo ausente');
  const j = rotas.indexOf("router.get('/politicas-entrada'", i);
  assert.ok(j > i, 'fim do handler não localizado');
  return rotas.slice(i, j);
}

function sqlRelatorioProducao() {
  return `
    SELECT
      c.*,
      (SELECT COUNT(*) FROM financeiro f
         WHERE f.compra_id = c.id AND f.empresa_id = c.empresa_id) AS total_financeiro,
      d.id AS central_documento_id,
      d.chave AS central_chave,
      (SELECT usuario_nome FROM auditoria a
         WHERE a.modulo = 'compras' AND a.referencia_tipo = 'compra' AND a.referencia_id = c.id
         AND a.acao IN ('criar_compra', 'criar_uso_consumo', 'criar_nota_fiscal_avulsa')
         AND (
           json_extract(a.detalhes, '$.empresa_id') IS NULL
           OR CAST(json_extract(a.detalhes, '$.empresa_id') AS INTEGER) = c.empresa_id
         )
         ORDER BY a.id DESC LIMIT 1) AS usuario_nome
    FROM compras c
    LEFT JOIN central_entradas_documentos d
           ON d.compra_id = c.id
          AND d.empresa_id = c.empresa_id
    WHERE COALESCE(c.tipo_entrada, '${PADRAO}') = 'USO_CONSUMO' AND c.empresa_id = ?
    ORDER BY COALESCE(c.data_emissao, c.data_entrada, c.data_compra) DESC, c.id DESC
  `;
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
      data_compra DATE,
      data_emissao DATE,
      data_entrada DATE,
      fornecedor TEXT,
      fornecedor_cnpj TEXT,
      numero_nf TEXT,
      serie_nf TEXT,
      chave_acesso TEXT,
      valor_total_nota REAL,
      total REAL,
      status TEXT,
      tipo_entrada TEXT,
      observacao TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      status TEXT,
      vencimento TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modulo TEXT,
      acao TEXT,
      referencia_tipo TEXT,
      referencia_id INTEGER,
      usuario_nome TEXT,
      detalhes TEXT
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      chave TEXT,
      empresa_id INTEGER
    )
  `);
  return db;
}

async function seed(db) {
  await run(db, `
    INSERT INTO compras (id, data_compra, fornecedor, fornecedor_cnpj, numero_nf, valor_total_nota, total, status, tipo_entrada, empresa_id)
    VALUES
    (1, '2026-01-10', 'FORN_A', '11111111000191', '100', 50, 50, 'confirmada', 'USO_CONSUMO', 11),
    (2, '2026-01-11', 'FORN_B', '22222222000182', '200', 80, 80, 'confirmada', 'USO_CONSUMO', 22),
    (3, '2026-01-12', 'FORN_A_REV', '11111111000191', '300', 10, 10, 'confirmada', 'REVENDA', 11),
    (4, '2026-01-13', 'FORN_NULL', '00000000000000', '400', 5, 5, 'confirmada', 'USO_CONSUMO', NULL)
  `);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id) VALUES (1, 'pendente', '2026-02-01', 11)`);
  await run(db, `
    INSERT INTO auditoria (modulo, acao, referencia_tipo, referencia_id, usuario_nome)
    VALUES ('compras', 'criar_uso_consumo', 'compra', 1, 'operador_a')
  `);
  await run(db, `
    INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (99, 1, 'CHAVE_DOC_EMPRESA_B', 22)
  `);
}

function t01rotas() {
  const rotas = src('backend/rotas/compras.js');
  const handler = extrairHandlerRelatorio(rotas);
  assert.ok(rotas.includes("router.get('/relatorio/uso-consumo'"));
  assert.ok(!/router\.get\('\/uso\//.test(rotas));
  assert.ok(!/router\.get\('\/consumo\//.test(rotas));
  assert.ok(handler.includes('resolverEmpresaContextoCompra'));
  assert.ok(handler.includes("AND c.empresa_id = ?"));
  assert.ok(handler.includes("'USO_CONSUMO'"));
  const fe = src('frontend/erp/js/compras.js');
  assert.ok(fe.includes('abrirRelatorioUsoConsumo'));
  assert.ok(fe.includes('/compras/relatorio/uso-consumo'));
  console.log('  T01 rotas: 1 relatório dedicado GET /api/compras/relatorio/uso-consumo; sem GET /uso/:id nem /consumo/:id');
}

function t02writers() {
  const rotas = src('backend/rotas/compras.js');
  const handler = extrairHandlerRelatorio(rotas);
  assert.ok(!/INSERT\s+INTO/i.test(handler));
  assert.ok(!/UPDATE\s+/i.test(handler));
  assert.ok(!/DELETE\s+/i.test(handler));
  assert.ok(rotas.includes("router.post('/',"));
  assert.ok(rotas.includes("isUsoConsumo"));
  assert.ok(rotas.includes("'criar_uso_consumo'"));
  const backend = path.join(ROOT, 'backend');
  let insertsUsoTabela = 0;
  function walk(dir) {
    for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
      if (nome.name === 'node_modules' || nome.name === '.git') continue;
      const full = path.join(dir, nome.name);
      if (nome.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.js$/i.test(nome.name)) continue;
      const texto = fs.readFileSync(full, 'utf8');
      if (/INSERT\s+INTO\s+(uso|consumo|utilizacao)\s*\(/i.test(texto)) insertsUsoTabela += 1;
    }
  }
  walk(backend);
  assert.strictEqual(insertsUsoTabela, 0, 'não deve existir tabela uso/consumo');
  console.log('  T02 writers: 0 INSERT em tabela uso/consumo; 1 POST /compras persiste tipo USO_CONSUMO; relatório sem mutação');
}

async function t03listagem() {
  const db = await criarDb();
  await seed(db);
  const rows = await all(db, sqlRelatorioProducao(), [EMP_A]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 1);
  assert.strictEqual(rows[0].fornecedor, 'FORN_A');
  assert.ok(!rows.some((r) => r.fornecedor === 'FORN_B'));
  db.close();
  console.log('  T03 listagem: contexto A vê só compra USO_CONSUMO da empresa A');
}

async function t04consultaEmpresa() {
  const rotas = src('backend/rotas/compras.js');
  const handler = extrairHandlerRelatorio(rotas);
  assert.ok(!/req\.query\.empresa/.test(handler));
  assert.ok(handler.includes('ctxEmp.empresaId'));
  const params = [EMP_B];
  const db = await criarDb();
  await seed(db);
  const rows = await all(db, sqlRelatorioProducao(), params);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 2);
  db.close();
  console.log('  T04 consulta: empresa vem do contexto, não de query; B lista só id 2');
}

async function t05cruzado() {
  const db = await criarDb();
  await seed(db);
  const daA = await all(db, sqlRelatorioProducao(), [EMP_A]);
  const daB = await all(db, sqlRelatorioProducao(), [EMP_B]);
  assert.strictEqual(daA.length, 1);
  assert.strictEqual(daB.length, 1);
  assert.notStrictEqual(daA[0].id, daB[0].id);
  const compraA = await get(db, 'SELECT * FROM compras WHERE id = 1');
  try {
    exigirCompraParaMutacaoOpaca(compraA, EMP_B, { tratarInexistenteComoNaoEncontrada: true });
    assert.fail('cruzado GET /:id deveria falhar');
  } catch (err) {
    assert.strictEqual(err.code, 'COMPRA_NAO_ENCONTRADA');
  }
  db.close();
  console.log('  T05 cruzado: B não lista A; GET /:id cruzado 404 opaco (05.59)');
}

async function t06legadoNull() {
  const db = await criarDb();
  await seed(db);
  const a = await all(db, sqlRelatorioProducao(), [EMP_A]);
  const b = await all(db, sqlRelatorioProducao(), [EMP_B]);
  assert.ok(!a.some((r) => r.id === 4));
  assert.ok(!b.some((r) => r.id === 4));
  const nulos = await all(db, `SELECT id FROM compras WHERE tipo_entrada = 'USO_CONSUMO' AND empresa_id IS NULL`);
  assert.strictEqual(nulos.length, 1);
  db.close();
  console.log('  T06 LEGADO_NULL: USO_CONSUMO com empresa_id NULL não entra no relatório');
}

async function t07totalizador() {
  const handler = extrairHandlerRelatorio(src('backend/rotas/compras.js'));
  assert.ok(handler.includes('total: (rows || []).length'));
  assert.ok(!/SELECT\s+COUNT\s*\(\s*\*\s*\)\s+FROM\s+compras/i.test(handler));
  assert.ok(!/SELECT\s+SUM\s*\(/i.test(handler.split('FROM compras')[0] + 'FROM compras'));
  assert.ok(!/\bSUM\s*\(/i.test(handler));
  const db = await criarDb();
  await seed(db);
  const rowsA = await all(db, sqlRelatorioProducao(), [EMP_A]);
  const totalA = rowsA.length;
  const globais = await all(db, `SELECT id FROM compras WHERE COALESCE(tipo_entrada, '${PADRAO}') = 'USO_CONSUMO'`);
  assert.strictEqual(totalA, 1);
  assert.ok(globais.length >= 2, 'sem filtro empresarial o COUNT seria maior');
  assert.notStrictEqual(totalA, globais.length);
  db.close();
  console.log('  T07 totalizador: total = rows.length após filtro; não há COUNT(*)/SUM global de compras');
}

function t08exportacao() {
  const handler = extrairHandlerRelatorio(src('backend/rotas/compras.js'));
  const fe = src('frontend/erp/js/compras.js');
  const blocoFe = fe.slice(fe.indexOf('function abrirRelatorioUsoConsumo'), fe.indexOf('function obterHelpersCnpjCompra'));
  assert.ok(!/csv|xlsx|excel|pdf|application\/octet/i.test(handler));
  assert.ok(!/csv|xlsx|excel|\.pdf/i.test(blocoFe));
  assert.ok(blocoFe.includes('relatorioUsoConsumoModal'));
  console.log('  T08 export: sem CSV/Excel/PDF; UI é modal com o mesmo GET');
}

function t09buscaPorId() {
  const rotas = src('backend/rotas/compras.js');
  assert.ok(!/router\.get\('\/uso\/:id'/.test(rotas));
  assert.ok(!/router\.get\('\/consumo\/:id'/.test(rotas));
  const getId = rotas.slice(rotas.indexOf("router.get('/:id'"), rotas.indexOf("router.post('/',"));
  assert.ok(getId.includes('exigirCompraParaMutacaoOpaca'));
  assert.ok(getId.includes("SELECT * FROM compras WHERE id = ?"));
  console.log('  T09 ID: sem rota uso/consumo por id; detalhe é GET /compras/:id com ownership opaco');
}

async function t10scanQueriesFallbacks() {
  const handler = extrairHandlerRelatorio(src('backend/rotas/compras.js'));
  assert.ok(/LEFT JOIN central_entradas_documentos d/.test(handler));
  assert.ok(/d\.empresa_id\s*=\s*c\.empresa_id/.test(handler), '05.61: JOIN exige empresa do documento = empresa da compra');
  assert.ok(handler.includes('ORDER BY a.id DESC LIMIT 1'));
  assert.ok(!/COMPAT/.test(handler));
  assert.ok(!/primeira empresa|ultima empresa|última empresa/i.test(handler));
  assert.ok(!/empresa_id\s*=\s*1\b/.test(handler));
  assert.ok(handler.includes('inicio'));
  assert.ok(handler.includes('fim'));
  const fe = src('frontend/erp/js/compras.js');
  const ajax = fe.match(/abrirRelatorioUsoConsumo[\s\S]{0,400}/)[0];
  assert.ok(ajax.includes("method: 'GET'"));
  assert.ok(!ajax.includes('X-Empresa-Id'));
  const core = src('frontend/shared/js/core.js');
  assert.ok(core.includes('anexarHeaderXhr'));
  const db = await criarDb();
  await seed(db);
  const rows = await all(db, sqlRelatorioProducao(), [EMP_A]);
  assert.strictEqual(rows[0].central_chave, null);
  db.close();
  console.log('  T10 scan: JOIN Central com d.empresa_id = c.empresa_id (05.61); auditoria LIMIT 1; sem COMPAT');
}

async function main() {
  console.log('05.60 auditoria uso/consumo compras');
  t01rotas();
  t02writers();
  await t03listagem();
  await t04consultaEmpresa();
  await t05cruzado();
  await t06legadoNull();
  await t07totalizador();
  t08exportacao();
  t09buscaPorId();
  await t10scanQueriesFallbacks();
  console.log('T01–T10 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
