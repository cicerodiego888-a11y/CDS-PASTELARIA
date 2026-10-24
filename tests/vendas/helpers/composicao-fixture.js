'use strict';

/**
 * Fixture isolado (SQLite em memória) para testes da composição fiscal + cotação.
 * Mesmo schema usado nos testes das Sprints 2.1/2.4. Nunca toca no banco oficial.
 */

const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../../backend/services/empresas/empresasSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaCategoriaFiscalEmpresaAsync } = require('../../../backend/services/vendas/categoriaFiscalEmpresaSchema');
const { garantirSchemaSaldoFiscalCategoriaAsync } = require('../../../backend/services/vendas/saldoFiscalCategoriaSchema');
const { garantirSchemaReservaSaldoFiscalCategoriaAsync } = require('../../../backend/services/vendas/reservaSaldoFiscalCategoriaSchema');
const CategoriaFiscalEmpresaService = require('../../../backend/services/vendas/CategoriaFiscalEmpresaService');
const SaldoFiscalCategoriaService = require('../../../backend/services/vendas/SaldoFiscalCategoriaService');
const ReservaSaldoFiscalCategoriaService = require('../../../backend/services/vendas/ReservaSaldoFiscalCategoriaService');
const Composicao = require('../../../backend/services/vendas/ComposicaoFiscalPedidoService');

const REF = '2026-10-21T12:00:00Z';

function abrirDb() {
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(db)));
  });
}
function run(db, sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function onRun(e) { return e ? rej(e) : res({ lastID: this.lastID }); }));
}
function all(db, sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
}
function fechar(db) {
  return new Promise((res, rej) => db.close((e) => (e ? rej(e) : res())));
}

async function criarProduto(db, e) {
  const volume = e.volume || null;
  return (await run(db,
    `INSERT INTO produtos (nome, unidade, preco_venda, ativo, tipo_operacional, utiliza_volume, volume_valor, volume_unidade)
     VALUES (?, 'UN', ?, 1, 'COMERCIAL', ?, ?, ?)`,
    [e.nome, e.preco, volume ? 1 : 0, volume ? volume.valor : null, volume ? volume.unidade : null])).lastID;
}

async function criarContexto({ totalPedido = 61.98 } = {}) {
  const db = await abrirDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nome TEXT NOT NULL, unidade TEXT,
    preco_venda REAL NOT NULL, ativo INTEGER DEFAULT 1, tipo_operacional TEXT DEFAULT 'COMERCIAL',
    utiliza_volume INTEGER DEFAULT 0, volume_valor REAL, volume_unidade TEXT, estoque_atual REAL DEFAULT 0,
    preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0,
    vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE promocoes (id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER, preco_original REAL,
    preco_promocional REAL, desconto_percentual REAL, data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa')`);
  await run(db, `CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER,
    quantidade_minima INTEGER, preco_atacado REAL)`);
  await garantirSchemaProdutoConversaoAsync(db);
  await garantirSchemaCategoriaFiscalEmpresaAsync(db);
  await garantirSchemaSaldoFiscalCategoriaAsync(db);
  await garantirSchemaReservaSaldoFiscalCategoriaAsync(db);
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, nome TEXT)');
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, data_pedido TEXT NOT NULL,
    cliente_id INTEGER, total REAL NOT NULL, desconto REAL DEFAULT 0, frete REAL DEFAULT 0, status TEXT NOT NULL,
    empresa_id INTEGER NOT NULL, venda_id INTEGER, operador_id INTEGER, representante_id INTEGER,
    representante_nome TEXT, observacao TEXT, created_at TEXT, updated_at TEXT)`);
  await run(db, `CREATE TABLE pedidos_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL, quantidade REAL NOT NULL, preco_unitario REAL NOT NULL,
    desconto_percentual REAL DEFAULT 0, subtotal REAL NOT NULL, tipo_venda TEXT DEFAULT 'UN',
    classificacao_operacional_snapshot TEXT, produto_codigo_snapshot TEXT, produto_nome_snapshot TEXT,
    produto_unidade_snapshot TEXT)`);
  const empresaId = (await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Empresa teste paridade' }, { db }
  )).id;
  const pastel = await criarProduto(db, { nome: 'Pastel', preco: 8.99 });
  const coca = await criarProduto(db, { nome: 'Coca operacional', preco: 18 });
  const pedido = await run(db,
    `INSERT INTO pedidos (codigo, data_pedido, total, desconto, frete, status, empresa_id)
     VALUES ('PED-2-5', '2026-10-21', ?, 0, 0, 'PEDIDO', ?)`, [totalPedido, empresaId]);
  await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (?, ?, 2, 21.99, 43.98)`, [pedido.lastID, pastel]);
  await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (?, ?, 1, 18, ?)`, [pedido.lastID, coca, Number((totalPedido - 43.98).toFixed(2))]);
  return { db, empresaId, pedidoId: pedido.lastID, pastel, coca };
}

async function modelo(ctx, {
  categoria = 'REFRIGERANTE', preco, volumeMl = 1000, atacado = [], promocao = null
}) {
  const id = await criarProduto(ctx.db, { nome: `Modelo ${preco}`, preco, volume: { valor: volumeMl, unidade: 'ML' } });
  await CategoriaFiscalEmpresaService.definirVinculo({
    empresaId: ctx.empresaId, produtoId: id, categoriaFiscal: categoria, elegivelComposicao: true
  }, { db: ctx.db });
  if (atacado.length) {
    await run(ctx.db, 'UPDATE produtos SET venda_atacado = 1 WHERE id = ?', [id]);
    for (const [qmin, p] of atacado) {
      await run(ctx.db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (?,?,?)', [id, qmin, p]);
    }
  }
  if (promocao) {
    await run(ctx.db,
      `INSERT INTO promocoes (produto_id, preco_original, preco_promocional, data_inicio, data_fim, status)
       VALUES (?, ?, ?, ?, ?, 'ativa')`,
      [id, preco, promocao.preco, promocao.inicio, promocao.fim]);
  }
  return id;
}

let seqAbertura = 0;
async function saldo(ctx, categoria, ml) {
  await SaldoFiscalCategoriaService.garantirSaldo({ empresaId: ctx.empresaId, categoriaFiscal: categoria }, { db: ctx.db });
  seqAbertura += 1;
  await SaldoFiscalCategoriaService.registrarAbertura({
    empresaId: ctx.empresaId, categoriaFiscal: categoria, quantidadeMl: ml, usuarioId: 1,
    motivo: 'Abertura sintética para teste isolado', referencia: { tipo: 'TESTE', id: `${ctx.empresaId}-${categoria}-${seqAbertura}` },
    idempotencyKey: `abertura-${ctx.empresaId}-${categoria}-${seqAbertura}`, confirmado: true
  }, { db: ctx.db });
}

let seqReserva = 0;
async function reservar(ctx, { categoria = 'REFRIGERANTE', pedidoId, ml }) {
  seqReserva += 1;
  return ReservaSaldoFiscalCategoriaService.reservar({
    empresaId: ctx.empresaId, categoriaFiscal: categoria, pedidoId, quantidadeMl: ml, usuarioId: 1,
    motivo: 'Reserva sintética para teste isolado', referencia: { tipo: 'TESTE', id: `reserva-${seqReserva}` },
    idempotencyKey: `reserva-teste-${seqReserva}`
  }, { db: ctx.db });
}

async function outroPedido(ctx, total = 1) {
  const r = await run(ctx.db,
    `INSERT INTO pedidos (codigo, data_pedido, total, desconto, frete, status, empresa_id)
     VALUES (?, '2026-10-21', ?, 0, 0, 'PEDIDO', ?)`, [`PED-OUTRO-${seqReserva}-${Math.random()}`, total, ctx.empresaId]);
  await run(ctx.db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (?, ?, 1, ?, ?)`, [r.lastID, ctx.pastel, total, total]);
  return r.lastID;
}

function simular(ctx, extra = {}) {
  return Composicao.simularComposicao({
    empresaId: ctx.empresaId,
    pedidoId: ctx.pedidoId,
    itensFixos: [{ produtoId: ctx.pastel, quantidade: 2 }],
    dataReferencia: REF,
    ...extra
  }, { db: ctx.db });
}

async function comContexto(fn, opcoes) {
  const ctx = await criarContexto(opcoes);
  try { await fn(ctx); } finally { await fechar(ctx.db); }
}

async function snapshotTotal(db) {
  const tabelas = await all(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const out = { schema: await all(db, 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name') };
  for (const { name } of tabelas) out[name] = await all(db, `SELECT * FROM "${name}"`);
  return JSON.stringify(out);
}

module.exports = {
  REF, abrirDb, run, all, fechar, criarProduto, criarContexto, modelo, saldo, reservar, outroPedido,
  simular, comContexto, snapshotTotal, Composicao, SaldoFiscalCategoriaService
};
