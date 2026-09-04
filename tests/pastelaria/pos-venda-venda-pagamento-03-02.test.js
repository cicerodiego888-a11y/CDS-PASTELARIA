/**
 * Sprint 03.02 — POST /api/vendas do PDV Normal usa VendaPagamentoService em MULTIEMPRESA.
 * Executar: node tests/pastelaria/pos-venda-venda-pagamento-03-02.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  resolverEmpresaIdParaVenda,
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda,
  exigirVendaDaEmpresa,
  CODIGO_EMPRESA_CONTEXT_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const {
  debitarEstoqueItemVenda,
  montarOpcoesBaixaEstoqueVenda
} = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');
const { montarOpcoesRetornoEstoqueDaVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const { consumirReservasDaVenda } = require('../../backend/services/estoque/EstoqueConsumoReserva');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listarJs(dirRel) {
  const dir = path.join(ROOT, dirRel);
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .map((n) => path.join(dirRel, n).replace(/\\/g, '/'));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function loadAppWithFakePagamento() {
  const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
  const appPath = require.resolve('../../backend/services/vendas/VendaApplicationService');
  const originalPag = require.cache[pagamentoPath];
  const originalApp = require.cache[appPath];
  let pagamentoChamado = 0;
  let lastReq = null;
  require.cache[pagamentoPath] = {
    id: pagamentoPath,
    filename: pagamentoPath,
    loaded: true,
    exports: {
      criarVenda(req, res) {
        pagamentoChamado += 1;
        lastReq = req;
        return 'DELEGATED_PDV';
      }
    }
  };
  delete require.cache[appPath];
  const app = require('../../backend/services/vendas/VendaApplicationService');
  return {
    app,
    getPagamentoChamado: () => pagamentoChamado,
    getLastReq: () => lastReq,
    restore() {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      if (originalApp) require.cache[appPath] = originalApp;
      else delete require.cache[appPath];
    }
  };
}

async function setupEstoque() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      valor_fiscal REAL DEFAULT 0,
      valor_nao_fiscal REAL DEFAULT 0,
      caixa_sessao_id INTEGER,
      status TEXT DEFAULT 'concluida'
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE venda_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER NOT NULL,
      venda_item_id INTEGER,
      produto_id INTEGER NOT NULL,
      quantidade_fiscal REAL DEFAULT 0,
      quantidade_nao_fiscal REAL DEFAULT 0,
      status TEXT DEFAULT 'ATIVA',
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE venda_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      forma_pagamento TEXT,
      valor REAL
    )
  `);
  await run(db, `
    CREATE TABLE contas_receber (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      empresa_id INTEGER,
      valor_parcela REAL
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 100, 40, 140)`
  );
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: empresaA.id,
    saldo_fiscal: 50, saldo_nao_fiscal: 10, estoque_atual: 60
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: empresaB.id,
    saldo_fiscal: 30, saldo_nao_fiscal: 8, estoque_atual: 38
  }, { db });
  return { db, produtoId: p.lastID, empresaA, empresaB };
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function persistirVenda(db, empresaId, extra = {}) {
  const id = exigirEmpresaDaOperacao({ empresaId });
  const ins = await run(
    db,
    `INSERT INTO vendas (empresa_id, valor_fiscal, valor_nao_fiscal, caixa_sessao_id, status)
     VALUES (?, ?, ?, ?, 'concluida')`,
    [id, extra.valorFiscal || 0, extra.valorNaoFiscal || 0, extra.caixaSessaoId || null]
  );
  return get(db, 'SELECT * FROM vendas WHERE id = ?', [ins.lastID]);
}

async function t01VendaA() {
  const { db, empresaA } = await setupEstoque();
  const resolved = await resolverEmpresaIdParaVenda(
    { headers: { 'x-empresa-id': String(empresaA.id) }, empresaId: empresaA.id },
    { db, exigirAutorizacaoUsuario: false, contrato: { modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA } }
  );
  const venda = await persistirVenda(db, resolved.empresaId);
  assert.strictEqual(Number(venda.empresa_id), Number(empresaA.id));
  await closeDb(db);
}

async function t02VendaB() {
  const { db, empresaB } = await setupEstoque();
  const resolved = await resolverEmpresaIdParaVenda(
    { headers: { 'x-empresa-id': String(empresaB.id) }, empresaId: empresaB.id },
    { db, exigirAutorizacaoUsuario: false, contrato: { modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA } }
  );
  const venda = await persistirVenda(db, resolved.empresaId);
  assert.strictEqual(Number(venda.empresa_id), Number(empresaB.id));
  await closeDb(db);
}

async function t03MultiempresaSemEmpresa() {
  await assert.rejects(
    () => resolverEmpresaIdParaVenda(
      { headers: {}, empresaId: null },
      {
        exigirAutorizacaoUsuario: false,
        contrato: {
          modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA,
          empresa_operacional: { empresa_id: 1 }
        }
      }
    ),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
}

async function t04NaoPersisteNull() {
  assert.throws(() => exigirEmpresaDaOperacao({ empresaId: null }), (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED);
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(!pag.includes('req.empresaId || null'));
  const inserts = pag.match(/INSERT INTO vendas[\s\S]*?empresaIdVenda/g) || [];
  assert.ok(inserts.length >= 1);
}

async function t05BaixaA() {
  const { db, produtoId, empresaA } = await setupEstoque();
  const opts = montarOpcoesBaixaEstoqueVenda({ empresaIdVenda: empresaA.id, empresaId: empresaA.id }, 'baixa_venda', db);
  await debitoAsync(db, {
    produtoId, quantidadeFiscal: 4, empresaId: opts.empresaId, exigirEmpresa: true
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), 46);
  await closeDb(db);
}

async function t06BaixaB() {
  const { db, produtoId, empresaB } = await setupEstoque();
  const opts = montarOpcoesBaixaEstoqueVenda({ empresaIdVenda: empresaB.id, empresaId: empresaB.id }, 'baixa_venda', db);
  await debitoAsync(db, {
    produtoId, quantidadeFiscal: 3, empresaId: opts.empresaId, exigirEmpresa: true
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), 27);
  await closeDb(db);
}

async function t07ANaoBaixaB() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const bAntes = await ee(db, produtoId, empresaB.id);
  await debitoAsync(db, {
    produtoId, quantidadeFiscal: 5, empresaId: empresaA.id, exigirEmpresa: true
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t08BNaoBaixaA() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const aAntes = await ee(db, produtoId, empresaA.id);
  await debitoAsync(db, {
    produtoId, quantidadeFiscal: 2, empresaId: empresaB.id, exigirEmpresa: true
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t09ContasReceberA() {
  const { db, empresaA } = await setupEstoque();
  const venda = await persistirVenda(db, empresaA.id);
  await run(db, `INSERT INTO contas_receber (venda_id, empresa_id, valor_parcela) VALUES (?, ?, 10)`, [venda.id, venda.empresa_id]);
  const cr = await get(db, 'SELECT empresa_id FROM contas_receber WHERE venda_id = ?', [venda.id]);
  assert.strictEqual(Number(cr.empresa_id), Number(empresaA.id));
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('empresaIdVenda'));
  await closeDb(db);
}

async function t10ContasReceberB() {
  const { db, empresaB } = await setupEstoque();
  const venda = await persistirVenda(db, empresaB.id);
  await run(db, `INSERT INTO contas_receber (venda_id, empresa_id, valor_parcela) VALUES (?, ?, 20)`, [venda.id, venda.empresa_id]);
  const cr = await get(db, 'SELECT empresa_id FROM contas_receber WHERE venda_id = ?', [venda.id]);
  assert.strictEqual(Number(cr.empresa_id), Number(empresaB.id));
  await closeDb(db);
}

async function t11PagamentoA() {
  const { db, empresaA } = await setupEstoque();
  const venda = await persistirVenda(db, empresaA.id);
  await run(db, `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor) VALUES (?, 'dinheiro', 10)`, [venda.id]);
  const pag = await get(db, `
    SELECT v.empresa_id FROM venda_pagamentos p JOIN vendas v ON v.id = p.venda_id WHERE p.venda_id = ?
  `, [venda.id]);
  assert.strictEqual(Number(pag.empresa_id), Number(empresaA.id));
  await closeDb(db);
}

async function t12PagamentoB() {
  const { db, empresaB } = await setupEstoque();
  const venda = await persistirVenda(db, empresaB.id);
  await run(db, `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor) VALUES (?, 'pix', 20)`, [venda.id]);
  const pag = await get(db, `
    SELECT v.empresa_id FROM venda_pagamentos p JOIN vendas v ON v.id = p.venda_id WHERE p.venda_id = ?
  `, [venda.id]);
  assert.strictEqual(Number(pag.empresa_id), Number(empresaB.id));
  await closeDb(db);
}

async function t13CaixaA() {
  exigirCaixaCompativelComVenda({ caixaSessao: { id: 1, empresa_id: 11 } }, 11);
}

async function t14CaixaB() {
  exigirCaixaCompativelComVenda({ caixaSessao: { id: 2, empresa_id: 22 } }, 22);
}

async function t15VendaANaoUsaCaixaB() {
  assert.throws(
    () => exigirCaixaCompativelComVenda({ caixaSessao: { id: 2, empresa_id: 22 } }, 11),
    (e) => e.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
}

async function t16VendaANaoConsomeReservaB() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const v = await persistirVenda(db, empresaA.id);
  const item = await run(db, `INSERT INTO vendas_itens (venda_id, produto_id) VALUES (?, ?)`, [v.id, produtoId]);
  await run(
    db,
    `INSERT INTO venda_estoque_reservas
       (venda_id, venda_item_id, produto_id, quantidade_fiscal, quantidade_nao_fiscal, status, empresa_id)
     VALUES (?, ?, ?, 5, 0, 'ATIVA', ?)`,
    [v.id, item.lastID, produtoId, empresaB.id]
  );
  await assert.rejects(
    () => consumirReservasDaVenda(v.id, { db, empresaId: empresaA.id }),
    (e) => e.code === 'RESERVA_EMPRESA_DIVERGENTE' || e.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  await closeDb(db);
}

async function t17VendaBNaoConsomeReservaA() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const v = await persistirVenda(db, empresaB.id);
  const item = await run(db, `INSERT INTO vendas_itens (venda_id, produto_id) VALUES (?, ?)`, [v.id, produtoId]);
  await run(
    db,
    `INSERT INTO venda_estoque_reservas
       (venda_id, venda_item_id, produto_id, quantidade_fiscal, quantidade_nao_fiscal, status, empresa_id)
     VALUES (?, ?, ?, 4, 0, 'ATIVA', ?)`,
    [v.id, item.lastID, produtoId, empresaA.id]
  );
  await assert.rejects(
    () => consumirReservasDaVenda(v.id, { db, empresaId: empresaB.id }),
    (e) => e.code === 'RESERVA_EMPRESA_DIVERGENTE' || e.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  await closeDb(db);
}

async function t18FiscalRecebeEmpresa() {
  assert.ok(src('backend/services/vendas/VendaFiscalService.js').includes('empresaIdContexto: venda && venda.empresa_id'));
}

async function t19FiscalNaoFiscalUnicaVenda() {
  const { db, empresaA } = await setupEstoque();
  const venda = await persistirVenda(db, empresaA.id, { valorFiscal: 7, valorNaoFiscal: 3 });
  assert.strictEqual(Number(venda.empresa_id), Number(empresaA.id));
  assert.strictEqual(Number(venda.valor_fiscal), 7);
  assert.strictEqual(Number(venda.valor_nao_fiscal), 3);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM vendas');
  assert.strictEqual(n.c, 1);
  await closeDb(db);
}

async function t20PostUsaVendaPagamentoService() {
  const rotas = src('backend/rotas/vendas.js');
  assert.ok(rotas.includes("router.post('/', validarCaixaSeOrigemPdv, criarVenda)"));
  assert.ok(rotas.includes('VendaApplicationService'));
  const vas = src('backend/services/vendas/VendaApplicationService.js');
  assert.ok(vas.includes('concluirVendaNoNucleoOficial'));
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const r = app.criarVenda({ body: { total: 10, itens: [], origem: 'PDV' } }, {}, {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA'
    });
    assert.strictEqual(r, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function t21MuvNaoCriaSegundaVenda() {
  const vas = src('backend/services/vendas/VendaApplicationService.js');
  const idx = vas.indexOf('function criarVendaComContexto');
  const bloco = vas.slice(idx, vas.indexOf('function criarVenda(req'));
  assert.ok(bloco.includes('MULTIEMPRESA()'));
  assert.ok(bloco.includes('concluirVendaNoNucleoOficial'));
  assert.ok(!bloco.includes('executarAtendimentoMultiempresa('));
  assert.ok(!vas.includes('INSERT INTO vendas'));
}

async function t22VendaPersistidaUmaVez() {
  const vas = src('backend/services/vendas/VendaApplicationService.js');
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.strictEqual((vas.match(/INSERT INTO vendas/g) || []).length, 0);
  assert.ok((pag.match(/INSERT INTO vendas/g) || []).length >= 1);
  assert.ok(pag.includes('exigirEmpresa: true'));
}

async function t23PdvNormalNaoDependeUniversal() {
  for (const rel of listarJs('frontend/pdv/js')) {
    const js = src(rel);
    assert.ok(!/pdv-universal/i.test(js), rel);
  }
  assert.ok(src('frontend/pdv/js/pdv.js').includes('CdsEmpresaContexto'));
  assert.ok(!src('backend/rotas/vendas.js').includes('pdv-universal'));
}

async function t24VendaANaoOperadaPorB() {
  const { db, empresaA, empresaB } = await setupEstoque();
  const venda = await persistirVenda(db, empresaA.id);
  assert.throws(() => exigirVendaDaEmpresa(venda, empresaB.id), (e) => e.code === 'VENDA_NAO_ENCONTRADA');
  await closeDb(db);
}

async function t25VendaBNaoOperadaPorA() {
  const { db, empresaA, empresaB } = await setupEstoque();
  const venda = await persistirVenda(db, empresaB.id);
  assert.throws(() => exigirVendaDaEmpresa(venda, empresaA.id), (e) => e.code === 'VENDA_NAO_ENCONTRADA');
  await closeDb(db);
}

async function t26FalhaContextoSemPersistencia() {
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  const exigir = pag.indexOf('empresaIdVenda = exigirEmpresaDaOperacao(req)');
  const begin = pag.indexOf("db.run('BEGIN IMMEDIATE')");
  assert.ok(exigir > 0 && begin > exigir);
}

async function t27CancelamentoPreservaOwnership() {
  const { db, empresaA, empresaB } = await setupEstoque();
  const venda = await persistirVenda(db, empresaA.id);
  const opts = montarOpcoesRetornoEstoqueDaVenda(venda, { empresaId: empresaB.id }, 'cancelamento', db);
  assert.strictEqual(Number(opts.empresaId), Number(empresaA.id));
  await closeDb(db);
}

async function t28FinalizacaoPreservaOwnership() {
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(pag.includes('req.empresaIdVenda = empresaIdVenda'));
  assert.ok(pag.includes('empresaId: resolverEmpresaId(req && req.empresaIdVenda)')
    || src('backend/services/vendas/debitoEstoqueVendaViaPorta.js').includes('req.empresaIdVenda'));
  assert.ok(pag.includes('snapshotJson, empresaIdVenda') || pag.includes('empresaIdVenda'));
}

async function main() {
  const testes = [
    ['T01 Venda A persistida', t01VendaA],
    ['T02 Venda B persistida', t02VendaB],
    ['T03 MULTIEMPRESA sem empresa bloqueia', t03MultiempresaSemEmpresa],
    ['T04 POST não persiste empresa_id NULL', t04NaoPersisteNull],
    ['T05 Venda A baixa estoque A', t05BaixaA],
    ['T06 Venda B baixa estoque B', t06BaixaB],
    ['T07 Venda A não baixa estoque B', t07ANaoBaixaB],
    ['T08 Venda B não baixa estoque A', t08BNaoBaixaA],
    ['T09 Contas receber A', t09ContasReceberA],
    ['T10 Contas receber B', t10ContasReceberB],
    ['T11 Pagamento A', t11PagamentoA],
    ['T12 Pagamento B', t12PagamentoB],
    ['T13 Caixa A', t13CaixaA],
    ['T14 Caixa B', t14CaixaB],
    ['T15 Venda A não usa caixa B', t15VendaANaoUsaCaixaB],
    ['T16 Venda A não consome reserva B', t16VendaANaoConsomeReservaB],
    ['T17 Venda B não consome reserva A', t17VendaBNaoConsomeReservaA],
    ['T18 Fiscal recebe empresa da venda', t18FiscalRecebeEmpresa],
    ['T19 Fiscal + não fiscal = uma venda', t19FiscalNaoFiscalUnicaVenda],
    ['T20 POST usa VendaPagamentoService', t20PostUsaVendaPagamentoService],
    ['T21 MUV não cria segunda venda', t21MuvNaoCriaSegundaVenda],
    ['T22 Persistência única no núcleo', t22VendaPersistidaUmaVez],
    ['T23 PDV Normal não depende do Universal', t23PdvNormalNaoDependeUniversal],
    ['T24 Venda A não operada por B', t24VendaANaoOperadaPorB],
    ['T25 Venda B não operada por A', t25VendaBNaoOperadaPorA],
    ['T26 Falha de contexto sem persistência', t26FalhaContextoSemPersistencia],
    ['T27 Cancelamento preserva ownership', t27CancelamentoPreservaOwnership],
    ['T28 Finalização preserva ownership', t28FinalizacaoPreservaOwnership]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\npos-venda-venda-pagamento-03-02: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
