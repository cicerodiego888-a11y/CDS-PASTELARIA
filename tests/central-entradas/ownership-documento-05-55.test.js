/**
 * Sprint 05.55 — Ownership de documento da Central de Entradas.
 * Executar: node tests/central-entradas/ownership-documento-05-55.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  exigirDocumentoDaEmpresa,
  exigirDocumentoCompraMesmaEmpresa,
  corpoDocumentoNaoEncontrado,
  responderErroDocumentoCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralDocumentoService = require('../../backend/motores/central-entradas/services/CentralDocumentoService');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const CentralComprasBridgeService = require('../../backend/motores/central-entradas/services/CentralComprasBridgeService');
const { DocumentoFiscalStatus } = require('../../backend/motores/central-entradas/core/DocumentoFiscalStatus');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const EMP_C = 33;

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

async function inserirDoc(db, { id, empresaId, chave, status, parse, fornecedor }) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (id, chave, xml, status, parse_json, empresa_id, fornecedor, cnpj_fornecedor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      chave,
      '<nfe/>',
      status || DocumentoFiscalStatus.XML_COMPLETO,
      parse ? JSON.stringify(parse) : JSON.stringify({ itens: [] }),
      empresaId == null ? null : empresaId,
      fornecedor || `Fornecedor ${chave}`,
      empresaId === EMP_B ? '88888888000191' : '77777777000166'
    ]
  );
}

function naoVaza(payload, docB) {
  const texto = JSON.stringify(payload);
  assert.ok(!texto.includes(String(EMP_B)) || texto === '{"error":"Documento não encontrado","code":"DOCUMENTO_NAO_ENCONTRADO"}');
  assert.ok(!texto.includes('22222222000182'));
  assert.ok(!texto.includes(docB.chave || 'DOC-B'));
  assert.ok(!texto.includes('88888888000191'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'empresa_id'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'cnpj'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'chave'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'fornecedor'));
}

function mockRes() {
  const out = { statusCode: null, body: null };
  return {
    out,
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    }
  };
}

async function setupDocs() {
  const db = await criarDb();
  await inserirDoc(db, { id: 101, empresaId: EMP_A, chave: 'DOC-A', status: DocumentoFiscalStatus.PRONTA_PARA_COMPRA });
  await inserirDoc(db, { id: 202, empresaId: EMP_B, chave: 'DOC-B', status: DocumentoFiscalStatus.PRONTA_PARA_COMPRA });
  await inserirDoc(db, { id: 303, empresaId: EMP_C, chave: 'DOC-C', status: DocumentoFiscalStatus.PRONTA_PARA_COMPRA });
  const repo = new CentralDocumentosRepository({ db });
  return { db, repo };
}

async function t01aConsultaDocA() {
  const { db, repo } = await setupDocs();
  const r = await exigirDocumentoDaEmpresa(
    { documentoId: 101, empresaId: EMP_A },
    { documentosRepository: repo, db }
  );
  assert.strictEqual(r.empresaId, EMP_A);
  assert.strictEqual(r.documento.chave, 'DOC-A');
  db.close();
}

async function t02aConsultaDocB() {
  const { db, repo } = await setupDocs();
  await assert.rejects(
    () => exigirDocumentoDaEmpresa({ documentoId: 202, empresaId: EMP_A }, { documentosRepository: repo, db }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO' && err.statusCode === 404
  );
  const res = mockRes();
  try {
    await exigirDocumentoDaEmpresa({ documentoId: 202, empresaId: EMP_A }, { documentosRepository: repo, db });
  } catch (err) {
    responderErroDocumentoCentral(res, err);
  }
  assert.strictEqual(res.out.statusCode, 404);
  assert.deepStrictEqual(res.out.body, corpoDocumentoNaoEncontrado());
  naoVaza(res.out.body, { chave: 'DOC-B' });
  db.close();
}

async function t03bConsultaDocA() {
  const { db, repo } = await setupDocs();
  await assert.rejects(
    () => exigirDocumentoDaEmpresa({ documentoId: 101, empresaId: EMP_B }, { documentosRepository: repo, db }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  db.close();
}

async function t04cConsultaDocB() {
  const { db, repo } = await setupDocs();
  await assert.rejects(
    () => exigirDocumentoDaEmpresa({ documentoId: 202, empresaId: EMP_C }, { documentosRepository: repo, db }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  db.close();
}

async function t05aProcessaDocA() {
  const { db, repo } = await setupDocs();
  const proc = new CentralProcessamentoService({ documentosRepository: repo });
  const r = await proc.processar(101, { empresaIdContexto: EMP_A });
  assert.strictEqual(r.sucesso, true);
  db.close();
}

async function t06aProcessaDocB() {
  const { db, repo } = await setupDocs();
  const proc = new CentralProcessamentoService({ documentosRepository: repo });
  await assert.rejects(
    () => proc.processar(202, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  db.close();
}

async function t07abrirCompraA() {
  const { db, repo } = await setupDocs();
  const bridge = new CentralComprasBridgeService({ documentosRepository: repo });
  const payload = await bridge.montarPayloadAbrirCompra(101, { empresaIdContexto: EMP_A });
  assert.strictEqual(payload.empresaId, EMP_A);
  assert.strictEqual(payload.dadosCompra.empresa_id, EMP_A);
  await run(
    db,
    `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 1, ?)`,
    [payload.dadosCompra.empresa_id]
  );
  const compra = await get(db, 'SELECT empresa_id FROM compras ORDER BY id DESC LIMIT 1');
  assert.strictEqual(compra.empresa_id, EMP_A);
  db.close();
}

async function t08abrirCompraBBloqueado() {
  const { db, repo } = await setupDocs();
  const before = await all(db, 'SELECT id FROM compras');
  const bridge = new CentralComprasBridgeService({ documentosRepository: repo });
  await assert.rejects(
    () => bridge.montarPayloadAbrirCompra(202, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  await assert.rejects(
    () => bridge.registrarAberturaCompra(202, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  const after = await all(db, 'SELECT id FROM compras');
  assert.strictEqual(after.length, before.length);
  db.close();
}

async function t09documentoNull() {
  const { db, repo } = await setupDocs();
  await inserirDoc(db, { id: 404, empresaId: null, chave: 'DOC-NULL' });
  const statusAntes = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id=404');
  await assert.rejects(
    () => exigirDocumentoDaEmpresa({ documentoId: 404, empresaId: EMP_A }, { documentosRepository: repo, db }),
    (err) => err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  const proc = new CentralProcessamentoService({ documentosRepository: repo });
  await assert.rejects(
    () => proc.processar(404, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  const statusDepois = await get(db, 'SELECT status FROM central_entradas_documentos WHERE id=404');
  assert.strictEqual(statusDepois.status, statusAntes.status);
  const compras = await all(db, 'SELECT id FROM compras');
  assert.strictEqual(compras.length, 0);
  db.close();
}

async function t10docACompraB() {
  const { db, repo } = await setupDocs();
  const ins = await run(
    db,
    `INSERT INTO compras (data_compra, total, empresa_id) VALUES ('2026-08-29', 10, ?)`,
    [EMP_B]
  );
  const bridge = new CentralComprasBridgeService({ documentosRepository: repo });
  await assert.rejects(
    () => bridge.vincularCompra(101, ins.lastID, { empresaIdContexto: EMP_A }),
    (err) => err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  const doc = await get(db, 'SELECT compra_id, status FROM central_entradas_documentos WHERE id=101');
  assert.strictEqual(doc.compra_id, null);
  assert.throws(
    () => exigirDocumentoCompraMesmaEmpresa(EMP_A, EMP_B),
    (err) => err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  db.close();
}

async function t11listarA() {
  const { db, repo } = await setupDocs();
  const svc = new CentralDocumentoService({ documentosRepository: repo });
  const r = await svc.listar({ empresaId: EMP_A, limite: 50 });
  assert.ok((r.documentos || []).length >= 1, 'listagem A vazia');
  assert.ok((r.documentos || []).every((d) => Number(d.empresaId) === EMP_A));
  assert.ok(!(r.documentos || []).some((d) => d.chave === 'DOC-B' || d.chave === 'DOC-C'));
  db.close();
}

async function t12listarB() {
  const { db, repo } = await setupDocs();
  const svc = new CentralDocumentoService({ documentosRepository: repo });
  const r = await svc.listar({ empresaId: EMP_B, limite: 50 });
  assert.ok((r.documentos || []).every((d) => Number(d.empresaId) === EMP_B));
  assert.ok((r.documentos || []).some((d) => d.chave === 'DOC-B' || Number(d.empresaId) === EMP_B));
  db.close();
}

async function t13listarC() {
  const { db, repo } = await setupDocs();
  const svc = new CentralDocumentoService({ documentosRepository: repo });
  const r = await svc.listar({ empresaId: EMP_C, limite: 50 });
  assert.ok((r.documentos || []).every((d) => Number(d.empresaId) === EMP_C));
  db.close();
}

async function t14processarNaoMutaCruzado() {
  const { db, repo } = await setupDocs();
  const antes = await get(db, 'SELECT status, parse_json FROM central_entradas_documentos WHERE id=202');
  const proc = new CentralProcessamentoService({ documentosRepository: repo });
  await assert.rejects(() => proc.processar(202, { empresaIdContexto: EMP_A }));
  const depois = await get(db, 'SELECT status, parse_json FROM central_entradas_documentos WHERE id=202');
  assert.strictEqual(depois.status, antes.status);
  assert.strictEqual(depois.parse_json, antes.parse_json);
  db.close();
}

async function t15revisaoCruzadaNaoMuta() {
  const { db, repo } = await setupDocs();
  await run(db, `UPDATE central_entradas_documentos SET status=? WHERE id=202`, [
    DocumentoFiscalStatus.AGUARDANDO_REVISAO
  ]);
  const antes = await get(db, 'SELECT status, parse_json FROM central_entradas_documentos WHERE id=202');
  const bridge = new CentralComprasBridgeService({ documentosRepository: repo });
  await assert.rejects(
    () => bridge.concluirRevisao(202, { empresaIdContexto: EMP_A, itens: [{ produto: 'x' }] }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  const depois = await get(db, 'SELECT status, parse_json FROM central_entradas_documentos WHERE id=202');
  assert.strictEqual(depois.status, antes.status);
  assert.strictEqual(depois.parse_json, antes.parse_json);
  db.close();
}

function t16todasRotasPorId() {
  const rotas = src('backend/rotas/central-entradas.js');
  const linhas = rotas.split(/\r?\n/);
  const docId = [];
  for (let i = 0; i < linhas.length; i += 1) {
    const l = linhas[i];
    if (!/router\.(get|post|patch|put|delete)\(/.test(l)) continue;
    if (l.includes('/notificacoes/:id')) continue;
    if (
      l.includes('/:id')
      || l.includes("saude/documento/:id")
      || l.includes("homologacao/:id")
    ) {
      const janela = linhas.slice(i, Math.min(linhas.length, i + 14)).join('\n');
      docId.push({ linha: i + 1, trecho: l.trim(), janela });
    }
  }
  assert.ok(docId.length >= 20, `esperado ≥20 rotas por ID, veio ${docId.length}`);
  for (const item of docId) {
    assert.ok(
      item.janela.includes('comDocumentoAutorizado'),
      `rota sem guard (L${item.linha}): ${item.trecho}`
    );
  }
  assert.ok(rotas.includes('exigirDocumentoDaEmpresa') || rotas.includes('autorizarDocumentoCentralHttp'));
  assert.ok(rotas.includes('comDocumentoAutorizado'));
}

const TESTS = [
  ['T01 A consulta DOC-A', t01aConsultaDocA],
  ['T02 A consulta DOC-B → 404', t02aConsultaDocB],
  ['T03 B consulta DOC-A → 404', t03bConsultaDocA],
  ['T04 C consulta DOC-B → 404', t04cConsultaDocB],
  ['T05 A processa DOC-A', t05aProcessaDocA],
  ['T06 A processa DOC-B → 404', t06aProcessaDocB],
  ['T07 A abre compra DOC-A empresa 11', t07abrirCompraA],
  ['T08 A abre compra DOC-B → 404 sem compra', t08abrirCompraBBloqueado],
  ['T09 documento NULL → EMPRESA_DOCUMENTO_NAO_RESOLVIDA', t09documentoNull],
  ['T10 DOC-A + compra B → DIVERGENTE', t10docACompraB],
  ['T11 listagem A', t11listarA],
  ['T12 listagem B', t12listarB],
  ['T13 listagem C', t13listarC],
  ['T14 processar cruzado não muta', t14processarNaoMutaCruzado],
  ['T15 revisão cruzada não muta', t15revisaoCruzadaNaoMuta],
  ['T16 todas as rotas por ID com guard', t16todasRotasPorId]
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
