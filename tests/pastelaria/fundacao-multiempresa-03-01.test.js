/**
 * Sprint 03.01 — Fundação multiempresa da operação Pastelaria (PDV Normal).
 * Executar: node tests/pastelaria/fundacao-multiempresa-03-01.test.js
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
  exigirVendaDaEmpresa,
  CODIGO_EMPRESA_CONTEXT_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { exigirSessaoDaEmpresa } = require('../../backend/services/caixa/CaixaEmpresaContextoService');
const {
  debitarEstoqueItemVenda,
  montarOpcoesBaixaEstoqueVenda
} = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');
const {
  creditarEstoqueItemVenda,
  montarOpcoesRetornoEstoqueDaVenda
} = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
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

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
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
      peso_medio_unidade REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
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
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      empresa_id INTEGER,
      valor REAL
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, peso_medio_unidade)
     VALUES ('Copo', 100, 40, 140, 0.2)`
  );
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: empresaA.id,
    saldo_fiscal: 50, saldo_nao_fiscal: 10, estoque_atual: 60
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: empresaB.id,
    saldo_fiscal: 30, saldo_nao_fiscal: 8, estoque_atual: 35
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

async function persistirVendaDaEmpresa(db, empresaId) {
  const id = exigirEmpresaDaOperacao({ empresaId });
  const ins = await run(db, `INSERT INTO vendas (empresa_id, status) VALUES (?, 'concluida')`, [id]);
  return get(db, 'SELECT id, empresa_id FROM vendas WHERE id = ?', [ins.lastID]);
}

async function t01EmpresaACriaVenda() {
  const { db, empresaA } = await setupEstoque();
  const resolved = await resolverEmpresaIdParaVenda(
    { headers: { 'x-empresa-id': String(empresaA.id) }, empresaId: empresaA.id },
    {
      db,
      exigirAutorizacaoUsuario: false,
      contrato: { modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA }
    }
  );
  assert.strictEqual(Number(resolved.empresaId), Number(empresaA.id));
  const venda = await persistirVendaDaEmpresa(db, resolved.empresaId);
  assert.strictEqual(Number(venda.empresa_id), Number(empresaA.id));
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('empresaIdVenda'));
  assert.ok(/INSERT INTO vendas[\s\S]*empresa_id/.test(src('backend/services/vendas/VendaPagamentoService.js')));
  await closeDb(db);
}

async function t02EmpresaBCriaVenda() {
  const { db, empresaB } = await setupEstoque();
  const resolved = await resolverEmpresaIdParaVenda(
    { headers: { 'x-empresa-id': String(empresaB.id) }, empresaId: empresaB.id },
    {
      db,
      exigirAutorizacaoUsuario: false,
      contrato: { modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA }
    }
  );
  assert.strictEqual(Number(resolved.empresaId), Number(empresaB.id));
  const venda = await persistirVendaDaEmpresa(db, resolved.empresaId);
  assert.strictEqual(Number(venda.empresa_id), Number(empresaB.id));
  await closeDb(db);
}

async function t03VendaANaoAlteraEstoqueB() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const req = { empresaIdVenda: empresaA.id, empresaId: empresaA.id };
  const opts = montarOpcoesBaixaEstoqueVenda(req, 'baixa_venda', db);
  assert.strictEqual(Number(opts.empresaId), Number(empresaA.id));
  const bAntes = await ee(db, produtoId, empresaB.id);
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 4,
    empresaId: opts.empresaId,
    exigirEmpresa: true,
    origem: 'baixa_venda'
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t04VendaBNaoAlteraEstoqueA() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const aAntes = await ee(db, produtoId, empresaA.id);
  const opts = montarOpcoesBaixaEstoqueVenda(
    { empresaIdVenda: empresaB.id, empresaId: empresaB.id },
    'baixa_venda',
    db
  );
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 3,
    empresaId: opts.empresaId,
    exigirEmpresa: true,
    origem: 'baixa_venda'
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t05PagamentoAPertenceA() {
  const { db, empresaA } = await setupEstoque();
  const venda = await persistirVendaDaEmpresa(db, empresaA.id);
  await run(
    db,
    `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor) VALUES (?, 'dinheiro', 10)`,
    [venda.id]
  );
  const pag = await get(db, `
    SELECT p.id, v.empresa_id
    FROM venda_pagamentos p
    JOIN vendas v ON v.id = p.venda_id
    WHERE p.venda_id = ?
  `, [venda.id]);
  assert.strictEqual(Number(pag.empresa_id), Number(empresaA.id));
  await closeDb(db);
}

async function t06PagamentoBPertenceB() {
  const { db, empresaB } = await setupEstoque();
  const venda = await persistirVendaDaEmpresa(db, empresaB.id);
  await run(
    db,
    `INSERT INTO venda_pagamentos (venda_id, forma_pagamento, valor) VALUES (?, 'pix', 20)`,
    [venda.id]
  );
  const pag = await get(db, `
    SELECT p.id, v.empresa_id
    FROM venda_pagamentos p
    JOIN vendas v ON v.id = p.venda_id
    WHERE p.venda_id = ?
  `, [venda.id]);
  assert.strictEqual(Number(pag.empresa_id), Number(empresaB.id));
  await closeDb(db);
}

async function t07FinanceiroAPertenceA() {
  const { db, empresaA } = await setupEstoque();
  const venda = await persistirVendaDaEmpresa(db, empresaA.id);
  await run(db, `INSERT INTO financeiro (venda_id, empresa_id, valor) VALUES (?, ?, 10)`, [venda.id, venda.empresa_id]);
  const fin = await get(db, 'SELECT empresa_id FROM financeiro WHERE venda_id = ?', [venda.id]);
  assert.strictEqual(Number(fin.empresa_id), Number(empresaA.id));
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('empresaIdVenda'));
  await closeDb(db);
}

async function t08FinanceiroBPertenceB() {
  const { db, empresaB } = await setupEstoque();
  const venda = await persistirVendaDaEmpresa(db, empresaB.id);
  await run(db, `INSERT INTO financeiro (venda_id, empresa_id, valor) VALUES (?, ?, 20)`, [venda.id, venda.empresa_id]);
  const fin = await get(db, 'SELECT empresa_id FROM financeiro WHERE venda_id = ?', [venda.id]);
  assert.strictEqual(Number(fin.empresa_id), Number(empresaB.id));
  await closeDb(db);
}

async function t09CaixaANaoAceitaB() {
  assert.throws(
    () => exigirSessaoDaEmpresa({ id: 1, empresa_id: 11 }, 22),
    (e) => e.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
}

async function t10CaixaBNaoAceitaA() {
  assert.throws(
    () => exigirSessaoDaEmpresa({ id: 2, empresa_id: 22 }, 11),
    (e) => e.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
}

async function t11EmpresaAusenteBloqueia() {
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
  assert.throws(
    () => exigirEmpresaDaOperacao({ empresaId: null }),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
}

async function t12ProdutoCompartilhado() {
  const produtos = src('backend/database.js');
  const m = produtos.match(
    /CREATE TABLE IF NOT EXISTS produtos \(([\s\S]*?)FOREIGN KEY \(subcategoria_id\) REFERENCES subcategorias\(id\)/
  );
  assert.ok(m, 'DDL de produtos não encontrado');
  assert.ok(m[1].includes('nome VARCHAR(200) NOT NULL'));
  assert.ok(!/\bempresa_id\b/.test(m[1]));
  assert.ok(!src('frontend/pdv/js/pdv.js').includes('produto_empresa'));
}

async function t13EstoqueSeparado() {
  const schema = src('backend/services/estoque/estoqueEmpresaSchema.js');
  assert.ok(schema.includes('estoque_empresa'));
  assert.ok(schema.includes('empresa_id'));
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.notStrictEqual(Number(a.saldo_fiscal), Number(b.saldo_fiscal));
  await closeDb(db);
}

async function t14ConversaoUsaEstoqueDaEmpresa() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const prod = await get(db, 'SELECT peso_medio_unidade FROM produtos WHERE id = ?', [produtoId]);
  const qtdVendaUnidades = 1;
  const qtdEstoque = Number(qtdVendaUnidades) * Number(prod.peso_medio_unidade);
  assert.strictEqual(qtdEstoque, 0.2);
  assert.ok(src('frontend/pdv/js/pdv.js').includes('obterQuantidadeEstoqueParaVenda'));
  const bAntes = await ee(db, produtoId, empresaB.id);
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: qtdEstoque,
    empresaId: empresaA.id,
    exigirEmpresa: true,
    origem: 'baixa_venda'
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.saldo_fiscal), 49.8);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t15CancelamentoRetornaEstoqueA() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  await debitoAsync(db, {
    produtoId, quantidadeFiscal: 5, empresaId: empresaA.id, exigirEmpresa: true
  });
  const bAntes = await ee(db, produtoId, empresaB.id);
  const opts = montarOpcoesRetornoEstoqueDaVenda(
    { id: 9, empresa_id: empresaA.id },
    { empresaId: empresaB.id },
    'cancelamento',
    db
  );
  assert.strictEqual(Number(opts.empresaId), Number(empresaA.id));
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 5,
    empresaId: opts.empresaId,
    exigirEmpresa: true,
    origem: 'cancelamento'
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.saldo_fiscal), 50);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t16CancelamentoRetornaEstoqueB() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  await debitoAsync(db, {
    produtoId, quantidadeFiscal: 2, empresaId: empresaB.id, exigirEmpresa: true
  });
  const aAntes = await ee(db, produtoId, empresaA.id);
  const opts = montarOpcoesRetornoEstoqueDaVenda(
    { id: 8, empresa_id: empresaB.id },
    { empresaId: empresaA.id },
    'cancelamento',
    db
  );
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 2,
    empresaId: opts.empresaId,
    exigirEmpresa: true,
    origem: 'cancelamento'
  });
  const b = await ee(db, produtoId, empresaB.id);
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(b.saldo_fiscal), 30);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t17VendaANaoConsomeReservaB() {
  const { db, produtoId, empresaA, empresaB } = await setupEstoque();
  const v = await run(db, `INSERT INTO vendas (empresa_id, status) VALUES (?, 'aberta')`, [empresaA.id]);
  const item = await run(db, `INSERT INTO vendas_itens (venda_id, produto_id) VALUES (?, ?)`, [v.lastID, produtoId]);
  await run(
    db,
    `INSERT INTO venda_estoque_reservas
       (venda_id, venda_item_id, produto_id, quantidade_fiscal, quantidade_nao_fiscal, status, empresa_id)
     VALUES (?, ?, ?, 5, 0, 'ATIVA', ?)`,
    [v.lastID, item.lastID, produtoId, empresaB.id]
  );
  const bAntes = await ee(db, produtoId, empresaB.id);
  await assert.rejects(
    () => consumirReservasDaVenda(v.lastID, { db, empresaId: empresaA.id }),
    (e) => e.code === 'RESERVA_EMPRESA_DIVERGENTE' || e.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t18ContextoNaoSubstituiOwnership() {
  const { db, empresaA, empresaB } = await setupEstoque();
  const venda = await persistirVendaDaEmpresa(db, empresaA.id);
  assert.throws(
    () => exigirVendaDaEmpresa(venda, empresaB.id),
    (e) => e.code === 'VENDA_NAO_ENCONTRADA' || e.code === 'VENDA_EMPRESA_DIVERGENTE'
  );
  const opts = montarOpcoesRetornoEstoqueDaVenda(venda, { empresaId: empresaB.id }, 'cancelamento', db);
  assert.strictEqual(Number(opts.empresaId), Number(empresaA.id));
  await closeDb(db);
}

async function t19PdvNormalNaoDependeDoUniversal() {
  for (const rel of listarJs('frontend/pdv/js')) {
    const js = src(rel);
    assert.ok(!/pdv-universal/i.test(js), `dependência Universal em ${rel}`);
    assert.ok(!/PDVUniversal/i.test(js), `dependência Universal em ${rel}`);
  }
  const rotas = src('backend/rotas/vendas.js');
  assert.ok(!rotas.includes('pdv-universal'));
  assert.ok(src('backend/rotas/vendas.js').includes('VendaApplicationService'));
}

async function t20PdvUniversalCongelado() {
  const arquivos = [
    'backend/rotas/pdv-universal.js',
    'backend/motores/pdv-universal/PDVUniversalApplicationService.js',
    'frontend/pdv-universal/pdv-universal.js',
    'frontend/shared/js/pdv-acesso-oficial.js'
  ];
  for (const rel of arquivos) {
    assert.ok(src(rel).includes('CONGELADO'), `falta STATUS CONGELADO em ${rel}`);
  }
  assert.ok(src('backend/services/vendas/VendaFiscalService.js').includes('empresaIdContexto: venda && venda.empresa_id'));
}

async function main() {
  const testes = [
    ['T01 Empresa A cria venda', t01EmpresaACriaVenda],
    ['T02 Empresa B cria venda', t02EmpresaBCriaVenda],
    ['T03 Venda A não altera estoque B', t03VendaANaoAlteraEstoqueB],
    ['T04 Venda B não altera estoque A', t04VendaBNaoAlteraEstoqueA],
    ['T05 Pagamento A pertence à A', t05PagamentoAPertenceA],
    ['T06 Pagamento B pertence à B', t06PagamentoBPertenceB],
    ['T07 Financeiro A pertence à A', t07FinanceiroAPertenceA],
    ['T08 Financeiro B pertence à B', t08FinanceiroBPertenceB],
    ['T09 Caixa A não aceita operação B', t09CaixaANaoAceitaB],
    ['T10 Caixa B não aceita operação A', t10CaixaBNaoAceitaA],
    ['T11 Empresa ausente em MULTIEMPRESA bloqueia', t11EmpresaAusenteBloqueia],
    ['T12 Produto continua compartilhado', t12ProdutoCompartilhado],
    ['T13 Estoque continua separado', t13EstoqueSeparado],
    ['T14 Conversão usa estoque da empresa', t14ConversaoUsaEstoqueDaEmpresa],
    ['T15 Cancelamento A retorna estoque A', t15CancelamentoRetornaEstoqueA],
    ['T16 Cancelamento B retorna estoque B', t16CancelamentoRetornaEstoqueB],
    ['T17 Venda A não consome reserva B', t17VendaANaoConsomeReservaB],
    ['T18 Contexto HTTP não substitui ownership', t18ContextoNaoSubstituiOwnership],
    ['T19 PDV Normal não depende do Universal', t19PdvNormalNaoDependeDoUniversal],
    ['T20 PDV Universal continua congelado', t20PdvUniversalCongelado]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nfundacao-multiempresa-03-01: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
