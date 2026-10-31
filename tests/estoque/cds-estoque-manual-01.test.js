/**
 * CDS-ESTOQUE-MANUAL-01 — modo global por empresa + contagem física F×NF.
 * Executar: node tests/estoque/cds-estoque-manual-01.test.js
 * Isolamento: DB_DIR temporário. Sem banco oficial / SEFAZ.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-estoque-manual-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('../../backend/services/empresas/empresasConfiguracaoEstoqueSchema');
const {
  garantirSchemaEstoqueContagemFisicaAsync
} = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaVendaFichaConsumoAsync } = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  consumirFichaTecnicaDaVenda
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const {
  reduzirEstoqueDistribuido
} = require('../../backend/services/vendas/VendaPagamentoService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

function reduzirAsync(vendaItemId, produtoId, qF, qNf, opcoes) {
  return new Promise((resolve, reject) => {
    reduzirEstoqueDistribuido(vendaItemId, produtoId, qF, qNf, (err) => {
      if (err) reject(err);
      else resolve();
    }, opcoes);
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      ativo INTEGER DEFAULT 1,
      unidade TEXT DEFAULT 'UN',
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      controlar_validade INTEGER DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, 'CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER)');
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, saldoF = 0, saldoNf = 0, tipo = 'COMERCIAL') {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, 'UN', ?, ?, ?)`,
    [nome, tipo, saldoF, saldoNf, saldoF + saldoNf]
  );
  return ins.lastID;
}

async function espelhar(db, produtoId, empresaId, saldoF, saldoNf) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoF,
    saldo_nao_fiscal: saldoNf,
    estoque_atual: saldoF + saldoNf
  }, { db });
}

function ee(db, produtoId, empresaId) {
  return get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [produtoId, empresaId]);
}

async function t01LegadoPadraoAutomatico() {
  const { db, empresaA } = await setup();
  const cfg = await EmpresaModoEstoqueService.obterModoEstoqueEmpresa(db, empresaA.id);
  assert.strictEqual(cfg.modo, 'AUTOMATICO');
  assert.strictEqual(cfg.permite_baixa_automatica, true);
  assert.strictEqual(cfg.origem, 'PADRAO_LEGADO');
  await closeDb(db);
}

async function t02AutomaticoBaixaDireta() {
  const { db, empresaA } = await setup();
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresaA.id, 'AUTOMATICO');
  const pid = await criarProduto(db, 'Refri', 10, 0);
  await espelhar(db, pid, empresaA.id, 10, 0);
  await reduzirAsync(1, pid, 2, 0, { db, empresaId: empresaA.id, baixaAutomatica: true });
  const row = await ee(db, pid, empresaA.id);
  assert.strictEqual(Number(row.saldo_fiscal), 8);
  await closeDb(db);
}

async function t03AutomaticoFicha() {
  const { db, empresaA } = await setup();
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresaA.id, 'AUTOMATICO');
  const pastel = await criarProduto(db, 'Pastel', 0, 0, 'COMERCIAL');
  const massa = await criarProduto(db, 'Massa', 10, 0, 'INSUMO');
  await espelhar(db, massa, empresaA.id, 10, 0);
  await FichaTecnicaService.salvar(pastel, {
    ativo: 1,
    itens: [{ insumo_id: massa, quantidade: 2, unidade: 'UN' }]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  await consumirFichaTecnicaDaVenda({
    vendaId: venda.lastID,
    empresaId: empresaA.id,
    itens: [{ produto_id: pastel, quantidade: 1 }],
    db
  });
  assert.strictEqual(Number((await ee(db, massa, empresaA.id)).saldo_fiscal), 8);
  await closeDb(db);
}

async function t04ManualSemBaixaDireta() {
  const { db, empresaA } = await setup();
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresaA.id, 'MANUAL');
  const pid = await criarProduto(db, 'Refri', 10, 0);
  await espelhar(db, pid, empresaA.id, 10, 0);
  await reduzirAsync(1, pid, 3, 0, { db, empresaId: empresaA.id });
  assert.strictEqual(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 10);
  await closeDb(db);
}

async function t05ManualSemFicha() {
  const { db, empresaA } = await setup();
  await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, empresaA.id, 'MANUAL');
  const pastel = await criarProduto(db, 'Pastel', 0, 0, 'COMERCIAL');
  const massa = await criarProduto(db, 'Massa', 10, 0, 'INSUMO');
  await espelhar(db, massa, empresaA.id, 10, 0);
  await FichaTecnicaService.salvar(pastel, {
    ativo: 1,
    itens: [{ insumo_id: massa, quantidade: 2, unidade: 'UN' }]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const r = await consumirFichaTecnicaDaVenda({
    vendaId: venda.lastID,
    empresaId: empresaA.id,
    itens: [{ produto_id: pastel, quantidade: 1 }],
    db
  });
  assert.strictEqual(r.modo_estoque, 'MANUAL');
  assert.strictEqual(r.consumido, false);
  assert.strictEqual(Number((await ee(db, massa, empresaA.id)).saldo_fiscal), 10);
  await closeDb(db);
}

async function t06ManualPedidoGateFonte() {
  const src = fs.readFileSync(
    path.join(ROOT, 'backend/services/pedido/PedidoConsumoEstoqueService.js'),
    'utf8'
  );
  assert.match(src, /empresaPermiteBaixaAutomaticaEstoque/);
  assert.match(src, /modo_estoque:\s*'MANUAL'/);
}

async function t07ContagemCalculaDiferencas() {
  const { db, empresaA } = await setup();
  const pid = await criarProduto(db, 'Cebola', 50, 30);
  await espelhar(db, pid, empresaA.id, 50, 30);
  const preview = await EstoqueContagemFisicaService.previsualizarContagem({
    db,
    empresaId: empresaA.id,
    produtoId: pid,
    quantidade_fiscal_contada: 45,
    quantidade_nao_fiscal_contada: 25
  });
  assert.strictEqual(preview.diferenca_fiscal, -5);
  assert.strictEqual(preview.diferenca_nao_fiscal, -5);
  await closeDb(db);
}

async function t08ContagemSemMotivo() {
  const { db, empresaA } = await setup();
  const pid = await criarProduto(db, 'Cebola', 50, 30);
  await espelhar(db, pid, empresaA.id, 50, 30);
  const out = await EstoqueContagemFisicaService.registrarContagemFisica({
    db,
    empresaId: empresaA.id,
    usuarioId: 9,
    usuarioNome: 'operador',
    itens: [{
      produto_id: pid,
      quantidade_fiscal_contada: 45,
      quantidade_nao_fiscal_contada: 25
    }]
  });
  assert.ok(out.id > 0);
  assert.strictEqual(out.observacao, null);
  assert.strictEqual(out.itens[0].diferenca_fiscal, -5);
  assert.strictEqual(out.itens[0].diferenca_nao_fiscal, -5);
  assert.strictEqual(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 45);
  assert.strictEqual(Number((await ee(db, pid, empresaA.id)).saldo_nao_fiscal), 25);
  await closeDb(db);
}

async function t09HistoricoContagem() {
  const { db, empresaA } = await setup();
  const pid = await criarProduto(db, 'Cebola', 10, 5);
  await espelhar(db, pid, empresaA.id, 10, 5);
  const out = await EstoqueContagemFisicaService.registrarContagemFisica({
    db,
    empresaId: empresaA.id,
    usuarioId: 3,
    usuarioNome: 'cicero',
    observacao: null,
    itens: [{
      produto_id: pid,
      quantidade_fiscal_contada: 8,
      quantidade_nao_fiscal_contada: 5
    }]
  });
  const hist = await EstoqueContagemFisicaService.obterContagemPorId(db, out.id, empresaA.id);
  assert.strictEqual(hist.empresa_id, empresaA.id);
  assert.strictEqual(hist.usuario_id, 3);
  assert.strictEqual(hist.usuario_nome, 'cicero');
  assert.ok(hist.criado_em);
  assert.strictEqual(hist.itens[0].saldo_fiscal_anterior, 10);
  assert.strictEqual(hist.itens[0].quantidade_fiscal_contada, 8);
  assert.strictEqual(hist.itens[0].diferenca_fiscal, -2);
  await closeDb(db);
}

async function t10IsolamentoEmpresa() {
  const { db, empresaA, empresaB } = await setup();
  const pid = await criarProduto(db, 'Farinha', 20, 10);
  await espelhar(db, pid, empresaA.id, 20, 10);
  await espelhar(db, pid, empresaB.id, 99, 88);
  await EstoqueContagemFisicaService.registrarContagemFisica({
    db,
    empresaId: empresaA.id,
    usuarioId: 1,
    usuarioNome: 'op',
    itens: [{
      produto_id: pid,
      quantidade_fiscal_contada: 15,
      quantidade_nao_fiscal_contada: 10
    }]
  });
  assert.strictEqual(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 15);
  assert.strictEqual(Number((await ee(db, pid, empresaB.id)).saldo_fiscal), 99);
  assert.strictEqual(Number((await ee(db, pid, empresaB.id)).saldo_nao_fiscal), 88);
  await closeDb(db);
}

async function t11FalhaNaoParcial() {
  const { db, empresaA } = await setup();
  const p1 = await criarProduto(db, 'Ok', 5, 0);
  await espelhar(db, p1, empresaA.id, 5, 0);
  let falhou = false;
  try {
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      usuarioId: 1,
      usuarioNome: 'op',
      itens: [
        { produto_id: p1, quantidade_fiscal_contada: 4, quantidade_nao_fiscal_contada: 0 },
        { produto_id: 999999, quantidade_fiscal_contada: 1, quantidade_nao_fiscal_contada: 0 }
      ]
    });
  } catch (err) {
    falhou = true;
    assert.ok(err.code === 'PRODUTO_NAO_ENCONTRADO' || /não encontrado/i.test(err.message));
  }
  assert.ok(falhou, 'deveria falhar');
  assert.strictEqual(Number((await ee(db, p1, empresaA.id)).saldo_fiscal), 5);
  const contagens = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(Number(contagens.n), 0);
  await closeDb(db);
}

async function t12IdempotenciaContagem() {
  const { db, empresaA } = await setup();
  const pid = await criarProduto(db, 'Item', 10, 0);
  await espelhar(db, pid, empresaA.id, 10, 0);
  const payload = {
    db,
    empresaId: empresaA.id,
    usuarioId: 1,
    usuarioNome: 'op',
    chaveIdempotencia: 'chave-unica-1',
    itens: [{ produto_id: pid, quantidade_fiscal_contada: 9, quantidade_nao_fiscal_contada: 0 }]
  };
  const a = await EstoqueContagemFisicaService.registrarContagemFisica(payload);
  const b = await EstoqueContagemFisicaService.registrarContagemFisica(payload);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 9);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 legado AUTOMATICO', t01LegadoPadraoAutomatico],
    ['02 AUTOMATICO baixa direta', t02AutomaticoBaixaDireta],
    ['03 AUTOMATICO ficha', t03AutomaticoFicha],
    ['04 MANUAL sem baixa direta', t04ManualSemBaixaDireta],
    ['05 MANUAL sem ficha', t05ManualSemFicha],
    ['06 MANUAL gate pedido (fonte)', t06ManualPedidoGateFonte],
    ['07 contagem diferenças', t07ContagemCalculaDiferencas],
    ['08 contagem sem motivo', t08ContagemSemMotivo],
    ['09 histórico', t09HistoricoContagem],
    ['10 isolamento empresa', t10IsolamentoEmpresa],
    ['11 falha sem parcial', t11FalhaNaoParcial],
    ['12 idempotência', t12IdempotenciaContagem]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    try {
      await fn();
      console.log(`OK  ${nome}`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL ${nome}:`, err && err.stack ? err.stack : err);
    }
  }
  console.log(`\ncds-estoque-manual-01: ${ok}/${testes.length} OK`);
  if (ok !== testes.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
