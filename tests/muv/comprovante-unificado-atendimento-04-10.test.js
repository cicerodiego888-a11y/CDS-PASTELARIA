/**
 * Sprint 04.10 — comprovante unificado de atendimento (somente leitura).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { STATUS_ATENDIMENTO } = require('../../backend/motores/muv');
const atendimentoService = require('../../backend/motores/muv/AtendimentoMultiempresaService');
const fiscalService = require('../../backend/motores/muv/FiscalizarAtendimentoService');
const comprovanteService = require('../../backend/motores/muv/ComprovanteUnificadoAtendimentoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '65957340000150';

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code || err.codigo, code, err.message);
  }
}

function item(produtoId, empresaId, quantidade, valorUnitario, tipoFiscal) {
  const base = { produtoId, empresaId, quantidade, valorUnitario };
  if (tipoFiscal) base.tipoFiscal = tipoFiscal;
  return base;
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT, unidade TEXT,
      saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1, estoque_atual REAL DEFAULT 0, updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT, data_venda TEXT, total REAL, desconto REAL DEFAULT 0,
      forma_pagamento TEXT, status TEXT, status_pagamento TEXT, origem TEXT,
      valor_fiscal REAL DEFAULT 0, valor_nao_fiscal REAL DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, produto_id INTEGER, quantidade REAL, preco_unitario REAL, subtotal REAL,
      quantidade_fiscal REAL DEFAULT 0, quantidade_nao_fiscal REAL DEFAULT 0,
      valor_fiscal REAL DEFAULT 0, valor_nao_fiscal REAL DEFAULT 0, item_fiscal INTEGER DEFAULT 0
    )
  `);
  await run(db, `CREATE TABLE venda_pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, forma_pagamento TEXT, valor REAL)`);
  await run(db, `CREATE TABLE financeiro (id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, tipo TEXT, origem TEXT, valor REAL, status TEXT)`);
  const p1 = await run(db, `INSERT INTO produtos (nome, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('Suco de Laranja', 'UN', 999, 999, 1998)`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Empresa A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Empresa B' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'Empresa C' }, { db });
  for (const emp of [a, b, c]) {
    await EstoqueEmpresaService.criarRegistro({
      produtoId: p1.lastID, empresaId: emp.id, saldo_fiscal: 30, saldo_nao_fiscal: 10, estoque_atual: 40
    }, { db });
  }
  return { db, produtoId: p1.lastID, empresaA: a, empresaB: b, empresaC: c };
}

async function pipelinePago(ctx, pagamentos) {
  const atd = await atendimentoService.criarAtendimento({
    itens: [
      item(ctx.produtoId, ctx.empresaA.id, 2, 6, 'FISCAL'),
      item(ctx.produtoId, ctx.empresaB.id, 6, 3, 'FISCAL'),
      item(ctx.produtoId, ctx.empresaC.id, 3, 7, 'FISCAL')
    ]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos
  }, { db: ctx.db });
  return atd;
}

async function materializado(ctx, pagamentos) {
  const atd = await pipelinePago(ctx, pagamentos);
  return atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
}

function emitOk(mat, overrides = {}) {
  return {
    async emitirPorVendaId(vendaId) {
      const op = mat.operacoes.find((o) => o.vendaId === vendaId);
      if (overrides[op.empresaId] === 'fail') {
        return { success: false, status: 'rejeitada', message: 'rejeicao' };
      }
      return {
        success: true,
        status: 'autorizada',
        notaId: 700 + Number(vendaId),
        numero: 100 + Number(vendaId),
        chaveAcesso: `CHAVE-${op.empresaId}-${vendaId}`,
        qrCodeUrl: `https://qr.local/${op.empresaId}/${vendaId}`
      };
    }
  };
}

function fiscalDeps(ctx, emit) {
  return {
    db: ctx.db,
    emitirPorVendaId: emit.emitirPorVendaId,
    getFiscalConfig: ({ empresaId }) => ({ fonte: 'EMPRESA', empresaId })
  };
}

function mockRes() {
  const state = { statusCode: null, body: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.body = payload; return payload; }
  };
}

function loadAppWithFakePagamento() {
  const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
  const appPath = path.resolve(__dirname, '../../backend/services/vendas/VendaApplicationService.js');
  const originalPag = require.cache[pagamentoPath];
  const originalApp = require.cache[appPath];
  let pagamentoChamado = 0;
  require.cache[pagamentoPath] = {
    id: pagamentoPath, filename: pagamentoPath, loaded: true,
    exports: { criarVenda() { pagamentoChamado += 1; return 'DELEGATED_PDV'; } }
  };
  delete require.cache[appPath];
  const app = require('../../backend/services/vendas/VendaApplicationService');
  return {
    app,
    getPagamentoChamado: () => pagamentoChamado,
    restore() {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      if (originalApp) require.cache[appPath] = originalApp;
      else delete require.cache[appPath];
    }
  };
}

async function test01ABC() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.tipo, 'COMPROVANTE_UNIFICADO_ATENDIMENTO');
  assert.strictEqual(c.itens.length, 3);
  assert.strictEqual(c.documentos_fiscais.length, 3);
  await closeDb(ctx.db);
}

async function test02Continua() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.itensAgrupadosPorEmpresa, false);
  assert.ok(!Object.prototype.hasOwnProperty.call(c.itens[0], 'empresaId'));
  await closeDb(ctx.db);
}

async function test03TotalOficial() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.total, 51);
  assert.strictEqual(c.totais.atendimento, 51);
  await closeDb(ctx.db);
}

async function test04Misto() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [
    { formaPagamento: 'pix', valor: 30 },
    { formaPagamento: 'credito', valor: 21 }
  ]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.pagamentos.length, 2);
  assert.strictEqual(c.pagamentos[0].formaPagamento, 'pix');
  assert.strictEqual(c.pagamentos[1].valor, 21);
  await closeDb(ctx.db);
}

async function test05RateioNaoFragmenta() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.pagamento.unificado, true);
  assert.strictEqual(c.pagamentos.length, 1);
  await closeDb(ctx.db);
}

async function test06aDoc() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  const a = c.documentos_fiscais.find((d) => d.empresa_id === ctx.empresaA.id);
  assert.strictEqual(a.status, 'AUTORIZADA');
  await closeDb(ctx.db);
}

async function test07bDoc() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.ok(c.documentos_fiscais.find((d) => d.empresa_id === ctx.empresaB.id && d.status === 'AUTORIZADA'));
  await closeDb(ctx.db);
}

async function test08cDoc() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.ok(c.documentos_fiscais.find((d) => d.empresa_id === ctx.empresaC.id && d.status === 'AUTORIZADA'));
  await closeDb(ctx.db);
}

async function test09VariasNfce() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  const nums = c.documentos_fiscais.map((d) => d.documento.numero);
  assert.strictEqual(new Set(nums).size, 3);
  await closeDb(ctx.db);
}

async function test10ParcialMantem() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat, { [ctx.empresaC.id]: 'fail' })));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.fiscal.status, STATUS_ATENDIMENTO.FISCAL_PARCIAL);
  assert.ok(c.documentos_fiscais.filter((d) => d.status === 'AUTORIZADA').length >= 2);
  await closeDb(ctx.db);
}

async function test11ErroNaoBloqueia() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat, {
    [ctx.empresaA.id]: 'fail', [ctx.empresaB.id]: 'fail', [ctx.empresaC.id]: 'fail'
  })));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.fiscal.status, STATUS_ATENDIMENTO.FISCAL_ERRO);
  assert.strictEqual(c.tipo, 'COMPROVANTE_UNIFICADO_ATENDIMENTO');
  await closeDb(ctx.db);
}

async function test12SemDocPendente() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.fiscal.status, 'PENDENTE');
  assert.strictEqual(c.documentos_fiscais.length, 0);
  await closeDb(ctx.db);
}

async function test13SemCertificado() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  const json = JSON.stringify(c);
  assert.ok(!/certificado_senha|certificado_path|pfx/i.test(json));
  await closeDb(ctx.db);
}

async function test14SemCsc() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/ComprovanteUnificadoAtendimentoService.js'),
    'utf8'
  );
  assert.ok(!/token_csc|fiscal_token_csc|CSC/.test(src));
}

async function test15EmpresaDaOperacao() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  for (const d of c.documentos_fiscais) {
    const op = mat.operacoes.find((o) => o.operacaoId === d.operacaoId);
    assert.strictEqual(d.empresa_id, op.empresaId);
  }
  await closeDb(ctx.db);
}

async function test16DocEmpresaErrada() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const opA = mat.operacoes.find((o) => o.empresaId === ctx.empresaA.id);
  await run(
    ctx.db,
    `INSERT INTO atendimento_operacao_documentos (
       atendimento_id, atendimento_operacao_id, empresa_id, venda_id, status, chave_acesso
     ) VALUES (?, ?, ?, ?, 'AUTORIZADA', 'FAKE')`,
    [mat.atendimentoId, opA.operacaoId, ctx.empresaB.id, opA.vendaId]
  );
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.ok(!c.documentos_fiscais.some((d) => d.chaveAcesso === 'FAKE'));
  await closeDb(ctx.db);
}

async function test17Inexistente() {
  const ctx = await setupBase();
  await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12, 'FISCAL')]
  }, { db: ctx.db });
  await assertRejects(
    comprovanteService.obterComprovanteUnificado(9999, { db: ctx.db }),
    'ATENDIMENTO_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test18Cancelado() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12, 'FISCAL')]
  }, { db: ctx.db });
  await atendimentoService.cancelarAtendimento(atd.atendimentoId, { db: ctx.db });
  const c = await comprovanteService.obterComprovanteUnificado(atd.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.atendimento.status, STATUS_ATENDIMENTO.CANCELADO);
  await closeDb(ctx.db);
}

async function test19EmpresaUnica() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const result = app.criarVenda({ body: { total: 10, itens: [] } }, mockRes(), {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function test20SomenteLeitura() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/ComprovanteUnificadoAtendimentoService.js'),
    'utf8'
  );
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/i.test(src));
}

async function test21SomaItens() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.invariantes.somaItens, 51);
  await closeDb(ctx.db);
}

async function test22SomaPagamentos() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.invariantes.somaPagamentos, 51);
  await closeDb(ctx.db);
}

async function test23Ordem() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  const ids = c.itens.map((i) => i.itemId);
  const sorted = ids.slice().sort((a, b) => a - b);
  assert.deepStrictEqual(ids, sorted);
  await closeDb(ctx.db);
}

async function test24MultiplosPagamentos() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [
    { formaPagamento: 'dinheiro', valor: 20 },
    { formaPagamento: 'debito', valor: 31 }
  ]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.pagamento.formas.length, 2);
  await closeDb(ctx.db);
}

async function test25QrSoOficial() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c0 = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.ok(c0.documentos_fiscais.every((d) => !d.qrCodeUrl));
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c1 = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.ok(c1.documentos_fiscais.every((d) => String(d.documento.qr_code_url).startsWith('https://qr.local/')));
  await closeDb(ctx.db);
}

async function test26NaoInventa() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.documentos_fiscais.length, 0);
  await closeDb(ctx.db);
}

async function test27SemEmpresaExterna() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, {
    db: ctx.db, empresaId: 1
  });
  assert.strictEqual(c.atendimento.id, mat.atendimentoId);
  await closeDb(ctx.db);
}

async function test28SemEmpresa1() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/ComprovanteUnificadoAtendimentoService.js'),
    'utf8'
  );
  assert.ok(!src.includes('empresaId === 1') && !src.includes('empresa_id = 1'));
}

async function test29SemConfigGlobal() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../backend/motores/muv/ComprovanteUnificadoAtendimentoService.js'),
    'utf8'
  );
  assert.ok(!src.includes('getFiscalConfig') && !src.includes('configuracoes'));
}

async function test30ContratoImpressao() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.renderizacao.suficienteParaImpressao, true);
  assert.ok(c.cabecalho.codigo);
  assert.ok(Array.isArray(c.itens));
  assert.ok(Array.isArray(c.pagamentos));
  assert.ok(Array.isArray(c.documentos_fiscais));
  await closeDb(ctx.db);
}

async function test31Fiscalizado() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c.fiscal.status, STATUS_ATENDIMENTO.FISCALIZADO);
  await closeDb(ctx.db);
}

async function test32RetryParcial() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat, { [ctx.empresaC.id]: 'fail' })));
  const c1 = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c1.fiscal.status, 'FISCAL_PARCIAL');
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, fiscalDeps(ctx, emitOk(mat)));
  const c2 = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.strictEqual(c2.fiscal.status, 'FISCALIZADO');
  assert.strictEqual(c2.fiscal.quantidade_autorizados, 3);
  await closeDb(ctx.db);
}

async function test33RotaHttp() {
  const src = fs.readFileSync(path.join(__dirname, '../../backend/rotas/atendimentos.js'), 'utf8');
  assert.ok(src.includes('/:id/comprovante'));
  assert.ok(src.includes('obterComprovanteUnificado'));
}

async function test34DescricaoProduto() {
  const ctx = await setupBase();
  const mat = await materializado(ctx, [{ formaPagamento: 'pix', valor: 51 }]);
  const c = await comprovanteService.obterComprovanteUnificado(mat.atendimentoId, { db: ctx.db });
  assert.ok(c.itens.every((i) => i.descricao === 'Suco de Laranja'));
  await closeDb(ctx.db);
}

async function main() {
  const testes = [
    ['01 A/B/C', test01ABC],
    ['02 itens contínuos', test02Continua],
    ['03 total persistido', test03TotalOficial],
    ['04 pagamento misto', test04Misto],
    ['05 rateio não fragmenta', test05RateioNaoFragmenta],
    ['06 doc A', test06aDoc],
    ['07 doc B', test07bDoc],
    ['08 doc C', test08cDoc],
    ['09 várias NFC-e', test09VariasNfce],
    ['10 parcial mantém autorizados', test10ParcialMantem],
    ['11 erro não impede leitura', test11ErroNaoBloqueia],
    ['12 sem doc = PENDENTE', test12SemDocPendente],
    ['13 sem certificado', test13SemCertificado],
    ['14 sem CSC', test14SemCsc],
    ['15 empresa da operação', test15EmpresaDaOperacao],
    ['16 doc empresa errada filtrado', test16DocEmpresaErrada],
    ['17 inexistente', test17Inexistente],
    ['18 cancelado legível', test18Cancelado],
    ['19 EMPRESA_UNICA', test19EmpresaUnica],
    ['20 somente leitura', test20SomenteLeitura],
    ['21 soma itens', test21SomaItens],
    ['22 soma pagamentos', test22SomaPagamentos],
    ['23 ordem determinística', test23Ordem],
    ['24 múltiplos pagamentos', test24MultiplosPagamentos],
    ['25 QR só oficial', test25QrSoOficial],
    ['26 não inventa documento', test26NaoInventa],
    ['27 ignora empresaId externo', test27SemEmpresaExterna],
    ['28 sem empresa 1', test28SemEmpresa1],
    ['29 sem config global', test29SemConfigGlobal],
    ['30 contrato para impressão', test30ContratoImpressao],
    ['31 FISCALIZADO', test31Fiscalizado],
    ['32 retry após parcial', test32RetryParcial],
    ['33 rota HTTP', test33RotaHttp],
    ['34 descrição do produto', test34DescricaoProduto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\ncomprovante-unificado-atendimento-04-10: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
