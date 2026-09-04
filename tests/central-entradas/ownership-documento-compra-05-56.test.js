/**
 * Sprint 05.56 — Ownership documento → compra (Central).
 * Executar: node tests/central-entradas/ownership-documento-compra-05-56.test.js
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const {
  exigirDocumentoDaEmpresa
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const { resolverEmpresaDaCompra } = require('../../backend/services/compras/ComprasEmpresaContextoService');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralComprasBridgeService = require('../../backend/motores/central-entradas/services/CentralComprasBridgeService');
const CentralHistoricoRepository = require('../../backend/motores/central-entradas/repositories/CentralHistoricoRepository');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;

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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1),
    (33, '33333333000173', 'Empresa C', 1)
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_compra TEXT,
      fornecedor TEXT,
      total REAL,
      status TEXT,
      valor_total_nota REAL,
      empresa_id INTEGER,
      tipo_entrada TEXT,
      tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL,
      tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT UNIQUE,
      numero TEXT,
      serie TEXT,
      modelo TEXT,
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      data_entrada TEXT,
      valor_total REAL,
      xml TEXT,
      nsu TEXT,
      origem TEXT DEFAULT 'dfe',
      status TEXT,
      status_detalhe TEXT,
      tipo_documento TEXT,
      parse_json TEXT,
      miip_sessao_id TEXT,
      miip_resumo_json TEXT,
      compra_id INTEGER,
      usuario_id INTEGER,
      processado_em TEXT,
      empresa_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER,
      status_anterior TEXT,
      status_novo TEXT,
      detalhe TEXT,
      usuario_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

async function inserirDoc(db, { id, empresaId, chave, compraId }) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (id, chave, xml, status, parse_json, empresa_id, compra_id, fornecedor)
     VALUES (?, ?, '<nfe/>', ?, ?, ?, ?, ?)`,
    [
      id,
      chave,
      DocumentoFiscalStatus.PRONTA_PARA_COMPRA,
      JSON.stringify({ itens: [] }),
      empresaId == null ? null : empresaId,
      compraId == null ? null : compraId,
      `Forn ${chave}`
    ]
  );
}

async function setup() {
  const db = await criarDb();
  await inserirDoc(db, { id: 101, empresaId: EMP_A, chave: 'DOC-A' });
  await inserirDoc(db, { id: 202, empresaId: EMP_B, chave: 'DOC-B' });
  const repo = new CentralDocumentosRepository({ db });
  const historicoRepository = new CentralHistoricoRepository({ db });
  const bridge = new CentralComprasBridgeService({ documentosRepository: repo, historicoRepository });
  return { db, repo, bridge };
}

function depsResolver(db, documento) {
  return {
    db,
    contrato: {
      modo_operacional: 'MULTIEMPRESA',
      empresa_operacional: { empresa_id: EMP_A }
    },
    obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
    buscarDocumentoCentral: async () => documento
  };
}

async function t01criaCompraA() {
  const { db, repo, bridge } = await setup();
  const doc = await repo.buscarPorId(101);
  const resolvida = await resolverEmpresaDaCompra(
    { empresaId: EMP_A },
    { centralDocumentoId: 101, empresaIdBody: EMP_B },
    depsResolver(db, doc)
  );
  assert.strictEqual(resolvida.empresaId, EMP_A);
  assert.strictEqual(resolvida.origem, 'DOCUMENTO_CENTRAL');
  const ins = await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 10, ?)`, [
    resolvida.empresaId
  ]);
  await bridge.vincularCompra(101, ins.lastID, { empresaIdContexto: EMP_A });
  const compra = await get(db, 'SELECT empresa_id FROM compras WHERE id=?', [ins.lastID]);
  const docApos = await get(db, 'SELECT compra_id FROM central_entradas_documentos WHERE id=101');
  assert.strictEqual(compra.empresa_id, EMP_A);
  assert.strictEqual(docApos.compra_id, ins.lastID);
  db.close();
}

async function t02docAContextoB() {
  const { db, repo, bridge } = await setup();
  const antes = await all(db, 'SELECT id FROM compras');
  const doc = await repo.buscarPorId(101);
  await assert.rejects(
    () => resolverEmpresaDaCompra({ empresaId: EMP_B }, { centralDocumentoId: 101 }, depsResolver(db, doc)),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO' && err.statusCode === 404
  );
  await assert.rejects(
    () => bridge.montarPayloadAbrirCompra(101, { empresaIdContexto: EMP_B }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  assert.strictEqual((await all(db, 'SELECT id FROM compras')).length, antes.length);
  const docApos = await get(db, 'SELECT status, compra_id FROM central_entradas_documentos WHERE id=101');
  assert.strictEqual(docApos.compra_id, null);
  db.close();
}

async function t03docBContextoA() {
  const { db, repo, bridge } = await setup();
  const doc = await repo.buscarPorId(202);
  await assert.rejects(
    () => resolverEmpresaDaCompra({ empresaId: EMP_A }, { centralDocumentoId: 202 }, depsResolver(db, doc)),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  await assert.rejects(
    () => bridge.registrarAberturaCompra(202, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  assert.strictEqual((await all(db, 'SELECT id FROM compras')).length, 0);
  db.close();
}

async function t04documentoNull() {
  const { db, repo, bridge } = await setup();
  await inserirDoc(db, { id: 404, empresaId: null, chave: 'DOC-NULL' });
  const doc = await repo.buscarPorId(404);
  await assert.rejects(
    () => exigirDocumentoDaEmpresa({ documento: doc, empresaId: EMP_A }, { db }),
    (err) => err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  await assert.rejects(
    () => resolverEmpresaDaCompra({ empresaId: EMP_A }, { centralDocumentoId: 404 }, depsResolver(db, doc)),
    (err) => err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  await assert.rejects(
    () => bridge.montarPayloadAbrirCompra(404, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  assert.strictEqual((await all(db, 'SELECT id FROM compras')).length, 0);
  db.close();
}

async function t05vinculoAA() {
  const { db, bridge } = await setup();
  const ins = await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 1, ?)`, [EMP_A]);
  const r = await bridge.vincularCompra(101, ins.lastID, { empresaIdContexto: EMP_A });
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.compraId, ins.lastID);
  db.close();
}

async function t06docACompraB() {
  const { db, bridge } = await setup();
  const ins = await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 1, ?)`, [EMP_B]);
  const statusAntes = await get(db, 'SELECT status, compra_id FROM central_entradas_documentos WHERE id=101');
  await assert.rejects(
    () => bridge.vincularCompra(101, ins.lastID, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  const statusDepois = await get(db, 'SELECT status, compra_id FROM central_entradas_documentos WHERE id=101');
  assert.strictEqual(statusDepois.status, statusAntes.status);
  assert.strictEqual(statusDepois.compra_id, statusAntes.compra_id);
  const compra = await get(db, 'SELECT empresa_id FROM compras WHERE id=?', [ins.lastID]);
  assert.strictEqual(compra.empresa_id, EMP_B);
  db.close();
}

async function t07callerBNaoVinculaA() {
  const { db, bridge } = await setup();
  const ins = await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 1, ?)`, [EMP_A]);
  await assert.rejects(
    () => bridge.vincularCompra(101, ins.lastID, { empresaIdContexto: EMP_B }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  const doc = await get(db, 'SELECT compra_id FROM central_entradas_documentos WHERE id=101');
  assert.strictEqual(doc.compra_id, null);
  db.close();
}

async function t08payloadEmpresaA() {
  const { db, bridge } = await setup();
  const payload = await bridge.montarPayloadAbrirCompra(101, { empresaIdContexto: EMP_A });
  assert.strictEqual(payload.empresaId, EMP_A);
  assert.strictEqual(payload.dadosCompra.empresa_id, EMP_A);
  assert.strictEqual(payload.dadosCompra.empresaId, EMP_A);
  db.close();
}

async function t09callerNaoMudaPayload() {
  const { db, repo, bridge } = await setup();
  const payload = await bridge.montarPayloadAbrirCompra(101, {
    empresaIdContexto: EMP_A,
    empresaId: EMP_B,
    empresa_id: EMP_B
  });
  assert.strictEqual(payload.empresaId, EMP_A);
  assert.notStrictEqual(payload.empresaId, EMP_B);
  const doc = await repo.buscarPorId(101);
  const resolvida = await resolverEmpresaDaCompra(
    { empresaId: EMP_A },
    { centralDocumentoId: 101, empresaIdBody: EMP_B },
    depsResolver(db, doc)
  );
  assert.strictEqual(resolvida.empresaId, EMP_A);
  db.close();
}

async function t10segundoVinculoInconsistente() {
  const { db, bridge } = await setup();
  const a = await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 1, ?)`, [EMP_A]);
  await bridge.vincularCompra(101, a.lastID, { empresaIdContexto: EMP_A });
  const b = await run(db, `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 2, ?)`, [EMP_B]);
  const docAntes = await get(db, 'SELECT compra_id, status FROM central_entradas_documentos WHERE id=101');
  await assert.rejects(
    () => bridge.vincularCompra(101, b.lastID, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  const docDepois = await get(db, 'SELECT compra_id, status FROM central_entradas_documentos WHERE id=101');
  assert.strictEqual(docDepois.compra_id, docAntes.compra_id);
  assert.strictEqual(docDepois.status, docAntes.status);
  db.close();
}

const TESTS = [
  ['T01 Documento A + contexto A → compra A', t01criaCompraA],
  ['T02 Documento A + contexto B → 404', t02docAContextoB],
  ['T03 Documento B + contexto A → 404', t03docBContextoA],
  ['T04 Documento NULL → EMPRESA_DOCUMENTO_NAO_RESOLVIDA', t04documentoNull],
  ['T05 Documento A + compra A → vínculo', t05vinculoAA],
  ['T06 Documento A + compra B → DIVERGENTE', t06docACompraB],
  ['T07 Caller B não vincula documento A', t07callerBNaoVinculaA],
  ['T08 Payload A → empresaId 11', t08payloadEmpresaA],
  ['T09 Body/opcoes B não mudam empresa do payload', t09callerNaoMudaPayload],
  ['T10 Segundo vínculo inconsistente bloqueado', t10segundoVinculoInconsistente]
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
