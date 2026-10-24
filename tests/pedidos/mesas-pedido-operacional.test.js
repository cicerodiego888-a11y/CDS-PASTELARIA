/**
 * Mesas por empresa + vínculo do pedido operacional.
 * Executar com DB_DIR temporário:
 *   $env:DB_DIR = <dir temporário>; node tests/pedidos/mesas-pedido-operacional.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const MesaService = require('../../backend/services/pedido/MesaService');
const repo = require('../../backend/services/pedido/PedidoRepository');
const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
const configService = require('../../backend/services/configuracaoService');
const MotorComercial = require('../../backend/motores/comercial');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function run(db, sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function cb(e) { return e ? rej(e) : res(this); }));
}
function get(db, sql, params = []) {
  return new Promise((res, rej) => db.get(sql, params, (e, r) => (e ? rej(e) : res(r || null))));
}
function openDb() {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(d)));
  });
}
function closeDb(db) { return new Promise((r) => db.close(() => r())); }

async function criarDbPedidos({ migrar = true } = {}) {
  const db = await openDb();
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nome TEXT, unidade TEXT, tipo_operacional TEXT DEFAULT 'COMERCIAL')`);
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, data_pedido TEXT, cliente_id INTEGER, total REAL DEFAULT 0, desconto REAL DEFAULT 0, frete REAL DEFAULT 0, status TEXT, representante_id INTEGER, representante_nome TEXT, observacao TEXT, operador_id INTEGER, venda_id INTEGER, empresa_id INTEGER, updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE pedidos_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL, quantidade REAL NOT NULL, preco_unitario REAL NOT NULL, desconto_percentual REAL DEFAULT 0, subtotal REAL NOT NULL, tipo_venda TEXT DEFAULT 'PESO')`);
  await run(db, `CREATE TABLE clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)`);
  await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, nome TEXT)`);
  await run(db, `INSERT INTO produtos (codigo, nome, unidade) VALUES ('A','Pastel','UN')`);
  if (migrar) await garantirSchemaMesas(db);
  return db;
}

function pedidoBase(db, empresaId, extra = {}) {
  return repo.criarPedido({
    db,
    codigo: extra.codigo || `P-${Math.random().toString(16).slice(2, 8)}`,
    dataPedido: '2026-01-01',
    clienteId: null,
    total: 20,
    desconto: 0,
    frete: 0,
    status: 'PEDIDO',
    empresaId,
    mesaId: extra.mesaId,
    itens: [{ produto_id: 1, quantidade: 2, preco_unitario: 10, desconto_percentual: 0, subtotal: 20 }]
  });
}

async function rejeita(fn, codigo) {
  await assert.rejects(fn, (e) => e && (e.codigo === codigo || e.code === codigo), `esperado ${codigo}`);
}

describe('Migração de mesas (aditiva e idempotente)', () => {
  it('cria mesas, adiciona mesa_id e preserva pedidos existentes', async () => {
    const db = await criarDbPedidos({ migrar: false });
    try {
      const antigo = await pedidoBase(db, 1, { codigo: 'ANTIGO' });
      const r1 = await garantirSchemaMesas(db);
      const r2 = await garantirSchemaMesas(db);
      assert.equal(r1.colunaAdicionada, true);
      assert.equal(r2.colunaAdicionada, false);
      const p = await repo.obterPorId(antigo, { db });
      assert.equal(p.codigo, 'ANTIGO');
      assert.equal(p.mesa_id, null);
      assert.equal(p.mesa_numero, null);
      assert.equal(p.itens.length, 1);
    } finally { await closeDb(db); }
  });

  it('database.js encadeia a migração de mesas', () => {
    assert.match(src('backend/database.js'), /garantirSchemaMesas\(db\)/);
  });
});

describe('Cadastro de mesas por empresa', () => {
  it('cadastra em empresas distintas; mesma numeração em empresas diferentes; duplicada na mesma é rejeitada', async () => {
    const db = await criarDbPedidos();
    try {
      const a1 = await MesaService.criar(1, { numero: 1 }, { db });
      const b1 = await MesaService.criar(2, { numero: 1 }, { db });
      assert.equal(a1.mesa.nome, 'Mesa 1');
      assert.equal(a1.mesa.empresa_id, 1);
      assert.equal(b1.mesa.empresa_id, 2);
      assert.notEqual(a1.mesa.id, b1.mesa.id);
      await rejeita(() => MesaService.criar(1, { numero: '1' }, { db }), 'MESA_NUMERO_DUPLICADO');
      // índice único também protege contra corrida (sem passar pelo pré-check)
      await assert.rejects(run(db, 'INSERT INTO mesas (empresa_id, numero) VALUES (1, 1)'), /UNIQUE/);
    } finally { await closeDb(db); }
  });

  it('valida número, exige empresa explícita e não impõe limite fixo', async () => {
    const db = await criarDbPedidos();
    try {
      for (const ruim of ['', 'abc', '0', '-1', '1.5', null]) {
        await rejeita(() => MesaService.criar(1, { numero: ruim }, { db }), 'MESA_NUMERO_INVALIDO');
      }
      await rejeita(() => MesaService.criar(null, { numero: 1 }, { db }), 'EMPRESA_CONTEXT_REQUIRED');
      await rejeita(() => MesaService.listar(undefined, { db }), 'EMPRESA_CONTEXT_REQUIRED');
      for (let n = 1; n <= 150; n += 1) await MesaService.criar(1, { numero: n }, { db });
      const l = await MesaService.listar(1, { db });
      assert.equal(l.itens.length, 150);
      assert.equal(l.itens[0].numero, 1);
      assert.equal(l.itens[149].numero, 150);
    } finally { await closeDb(db); }
  });

  it('edita número respeitando unicidade e ativa/desativa', async () => {
    const db = await criarDbPedidos();
    try {
      const m1 = (await MesaService.criar(1, { numero: 1 }, { db })).mesa;
      await MesaService.criar(1, { numero: 2 }, { db });
      await rejeita(() => MesaService.atualizar(1, m1.id, { numero: 2 }, { db }), 'MESA_NUMERO_DUPLICADO');
      const ok = await MesaService.atualizar(1, m1.id, { numero: 7 }, { db });
      assert.equal(ok.mesa.numero, 7);
      assert.equal((await MesaService.atualizar(1, m1.id, { numero: 7 }, { db })).mesa.numero, 7);
      assert.equal((await MesaService.atualizar(1, m1.id, { ativo: false }, { db })).mesa.ativo, false);
      assert.equal((await MesaService.listar(1, { db, somenteAtivas: true })).itens.length, 1);
      assert.equal((await MesaService.atualizar(1, m1.id, { ativo: true }, { db })).mesa.ativo, true);
    } finally { await closeDb(db); }
  });

  it('impede acesso cruzado entre empresas', async () => {
    const db = await criarDbPedidos();
    try {
      const m1 = (await MesaService.criar(1, { numero: 1 }, { db })).mesa;
      await MesaService.criar(2, { numero: 1 }, { db });
      await rejeita(() => MesaService.obterDaEmpresa(2, m1.id, { db }), 'MESA_NAO_ENCONTRADA');
      await rejeita(() => MesaService.atualizar(2, m1.id, { ativo: false }, { db }), 'MESA_NAO_ENCONTRADA');
      await rejeita(() => MesaService.validarMesaDoPedido(2, m1.id, { db }), 'MESA_NAO_ENCONTRADA');
      assert.equal((await MesaService.listar(2, { db })).itens.every((m) => m.empresa_id === 2), true);
      assert.equal((await MesaService.obterDaEmpresa(1, m1.id, { db })).ativo, true);
    } finally { await closeDb(db); }
  });

  it('mesa inativa não é aceita para novos pedidos', async () => {
    const db = await criarDbPedidos();
    try {
      const m = (await MesaService.criar(1, { numero: 3 }, { db })).mesa;
      assert.equal(await MesaService.validarMesaDoPedido(1, m.id, { db }), m.id);
      assert.equal(await MesaService.validarMesaDoPedido(1, null, { db }), null);
      await MesaService.atualizar(1, m.id, { ativo: false }, { db });
      await rejeita(() => MesaService.validarMesaDoPedido(1, m.id, { db }), 'MESA_INATIVA');
      assert.equal(await MesaService.validarMesaDoPedido(1, m.id, { db, permitirInativa: true }), m.id);
    } finally { await closeDb(db); }
  });
});

describe('Pedido vinculado à mesa (repositório)', () => {
  it('vincula, consulta, lista, altera mesa e preserva histórico ao desativar', async () => {
    const db = await criarDbPedidos();
    try {
      const m1 = (await MesaService.criar(1, { numero: 5 }, { db })).mesa;
      const m2 = (await MesaService.criar(1, { numero: 6 }, { db })).mesa;
      const comMesa = await pedidoBase(db, 1, { mesaId: m1.id });
      const semMesa = await pedidoBase(db, 1);

      let p = await repo.obterPorId(comMesa, { db });
      assert.equal(p.mesa_id, m1.id);
      assert.equal(p.mesa_numero, 5);
      assert.equal(p.cliente_id, null);
      assert.equal((await repo.obterPorId(semMesa, { db })).mesa_id, null);

      const lista = await repo.listarPedidos({ db, empresaId: 1 });
      assert.equal(lista.find((x) => x.id === comMesa).mesa_numero, 5);
      assert.equal(lista.find((x) => x.id === semMesa).mesa_numero, null);

      await repo.substituirPedido({
        pedidoId: comMesa, clienteId: null, total: 20, desconto: 0, frete: 0, observacao: null, empresaId: 1, mesaId: m2.id, db,
        itens: [{ produto_id: 1, quantidade: 2, preco_unitario: 10, desconto_percentual: 0, subtotal: 20 }]
      });
      assert.equal((await repo.obterPorId(comMesa, { db })).mesa_numero, 6);

      // mesaId ausente preserva a mesa atual; null remove
      await repo.substituirPedido({
        pedidoId: comMesa, clienteId: null, total: 20, desconto: 0, frete: 0, observacao: null, empresaId: 1, db,
        itens: [{ produto_id: 1, quantidade: 2, preco_unitario: 10, desconto_percentual: 0, subtotal: 20 }]
      });
      assert.equal((await repo.obterPorId(comMesa, { db })).mesa_id, m2.id);

      await MesaService.atualizar(1, m2.id, { ativo: false }, { db });
      p = await repo.obterPorId(comMesa, { db });
      assert.equal(p.mesa_numero, 6, 'histórico mantém a mesa desativada');
      assert.equal((await get(db, 'SELECT COUNT(*) n FROM pedidos')).n, 2);
    } finally { await closeDb(db); }
  });

  it('pedido de uma empresa não resolve mesa de outra no join', async () => {
    const db = await criarDbPedidos();
    try {
      const mB = (await MesaService.criar(2, { numero: 9 }, { db })).mesa;
      const id = await pedidoBase(db, 1);
      await run(db, 'UPDATE pedidos SET mesa_id = ? WHERE id = ?', [mB.id, id]);
      assert.equal((await repo.obterPorId(id, { db })).mesa_numero, null);
    } finally { await closeDb(db); }
  });
});

describe('Pedido operacional + mesas + estoque (serviço real, banco isolado)', () => {
  async function prepararBanco() {
    const db = require('../../backend/database');
    await new Promise((r) => db.whenReady(() => r()));
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaMesas(db);
    const a = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db });
    const b = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db });
    const prod = await run(db, `INSERT INTO produtos (nome, preco_venda, saldo_fiscal, estoque_atual) VALUES ('Pastel MESA', 10, 100, 100)`);
    for (const e of [a, b]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId: prod.lastID, empresaId: e.id, saldo_fiscal: 100, saldo_nao_fiscal: 0, estoque_atual: 100, reservado_fiscal: 0
      }, { db });
    }
    return { db, produtoId: prod.lastID, a, b };
  }

  it('cria pedido sem cliente com mesa, valida empresa/mesa e mantém reserva idêntica ao fluxo sem mesa', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const { db, produtoId, a, b } = await prepararBanco();
      const mA = (await MesaService.criar(a.id, { numero: 1 })).mesa;
      const mB = (await MesaService.criar(b.id, { numero: 1 })).mesa;
      const itens = [{ produto_id: produtoId, quantidade: 4, preco_unitario: 10, desconto_percentual: 0, subtotal: 40 }];

      const comMesa = await PedidoOperacional.criar({ itens, total: 40, mesa_id: mA.id }, null, { empresaId: a.id });
      assert.equal(comMesa.pedido.mesa_id, mA.id);
      assert.equal(comMesa.pedido.mesa_numero, 1);
      assert.equal(comMesa.pedido.cliente_id, null);
      assert.equal(comMesa.pedido.status, 'PEDIDO');

      const semMesa = await PedidoOperacional.criar({ itens, total: 40 }, null, { empresaId: a.id });
      assert.equal(semMesa.pedido.mesa_id, null);

      const r = await get(db, `SELECT
          (SELECT COALESCE(SUM(quantidade_fiscal),0) FROM pedido_estoque_reservas WHERE pedido_id = ?) AS comMesa,
          (SELECT COALESCE(SUM(quantidade_fiscal),0) FROM pedido_estoque_reservas WHERE pedido_id = ?) AS semMesa`,
      [comMesa.pedido.id, semMesa.pedido.id]);
      assert.equal(Number(r.comMesa), 4);
      assert.equal(Number(r.semMesa), 4);
      const ee = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [a.id]);
      assert.equal(Number(ee.reservado_fiscal), 8, 'reserva total = soma dos dois pedidos, como antes das mesas');
      const eeB = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [b.id]);
      assert.equal(Number(eeB.reservado_fiscal), 0);

      // mesa de outra empresa e inexistente
      await rejeita(() => PedidoOperacional.criar({ itens, total: 40, mesa_id: mB.id }, null, { empresaId: a.id }), 'MESA_NAO_ENCONTRADA');
      await rejeita(() => PedidoOperacional.criar({ itens, total: 40, mesa_id: 99999 }, null, { empresaId: a.id }), 'MESA_NAO_ENCONTRADA');
      // sem empresa de contexto
      await assert.rejects(PedidoOperacional.criar({ itens, total: 40, mesa_id: mA.id }, null, {}), (e) => e.statusCode === 400);

      // mesa inativa não aceita novo pedido; pedido existente mantém a mesa
      await MesaService.atualizar(a.id, mA.id, { ativo: false });
      await rejeita(() => PedidoOperacional.criar({ itens, total: 40, mesa_id: mA.id }, null, { empresaId: a.id }), 'MESA_INATIVA');
      const mantido = await PedidoOperacional.atualizar(comMesa.pedido.id, { itens, total: 40, mesa_id: mA.id }, { empresaId: a.id });
      assert.equal(mantido.pedido.mesa_numero, 1);
      await rejeita(() => PedidoOperacional.atualizar(semMesa.pedido.id, { itens, total: 40, mesa_id: mA.id }, { empresaId: a.id }), 'MESA_INATIVA');
      const hist = await PedidoOperacional.obter(comMesa.pedido.id, { empresaId: a.id });
      assert.equal(hist.pedido.mesa_numero, 1);

      // pedido não pode ser lido por outra empresa
      await assert.rejects(PedidoOperacional.obter(comMesa.pedido.id, { empresaId: b.id }), (e) => e.statusCode === 404);

      // pedido criado antes das mesas (sem mesa_id) continua legível
      await run(db, `INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id) VALUES ('LEG-MESA','2026-01-01',10,'PEDIDO',?)`, [a.id]);
      const lista = await PedidoOperacional.listar({ empresaId: a.id });
      const leg = lista.itens.find((x) => x.codigo === 'LEG-MESA');
      assert.ok(leg);
      assert.equal(leg.mesa_numero, null);
    } finally {
      configService.recursoHabilitado = original;
    }
  });

  it('a migração real do database.js cria a tabela mesas e a coluna mesa_id', async () => {
    const db = require('../../backend/database');
    await new Promise((r) => db.whenReady(() => r()));
    const t = await get(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='mesas'`);
    assert.ok(t);
    const col = await new Promise((res, rej) => db.all('PRAGMA table_info(pedidos)', (e, r) => (e ? rej(e) : res(r))));
    assert.ok(col.some((c) => c.name === 'mesa_id'));
  });
});

describe('Rotas e interface (código-fonte; sem navegador)', () => {
  it('monta /api/mesas com token e recurso de pedidos, sem DELETE', () => {
    assert.match(src('backend/server.js'), /app\.use\('\/api\/mesas', verificarToken, exigirRecurso\('pedidos'\), mesasRoutes\)/);
    const r = src('backend/rotas/mesas.js');
    assert.match(r, /criarMiddlewareContextoEmpresa/);
    assert.match(r, /empresaIdDoReqPedido/);
    assert.doesNotMatch(r, /router\.delete/);
  });
  it('tela de Pedidos usa mesa, contexto de empresa e mantém cliente opcional', () => {
    const ui = src('frontend/erp/js/pedidos.js');
    assert.match(ui, /pedMesaId/);
    assert.match(ui, /mesa_id:/);
    assert.match(ui, /\/mesas/);
    assert.match(ui, /btnPedMesas/);
    assert.match(ui, /opcional/);
    assert.match(ui, /Nenhuma mesa cadastrada/);
    assert.match(ui, /Falha ao carregar mesas/);
    assert.match(ui, /Carregando mesas/);
    assert.doesNotMatch(ui, /data-aba="(orcamentos|expedidos|aguardando)/);
    assert.doesNotMatch(ui, /transferir mesa|juntar mesa|dividir conta|fechar conta|ocupa(ç|c)ão/i);
  });
});
