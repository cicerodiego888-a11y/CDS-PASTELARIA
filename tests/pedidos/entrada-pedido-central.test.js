/**
 * Camada central de entrada de pedidos (EntradaPedidoService) — banco temporário, dados sintéticos.
 * Executar com DB_DIR temporário:
 *   $env:DB_DIR = <dir temporário>; node tests/pedidos/entrada-pedido-central.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '..', '..');
const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const { garantirSchemaOrigemPedidos } = require('../../backend/utils/pedidosOrigemSchema');
const repo = require('../../backend/services/pedido/PedidoRepository');
const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
const Entrada = require('../../backend/services/pedido/EntradaPedidoService');
const MesaService = require('../../backend/services/pedido/MesaService');
const configService = require('../../backend/services/configuracaoService');
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
function all(db, sql, params = []) {
  return new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r || []))));
}
function openMem() {
  return new Promise((res, rej) => {
    const d = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(d)));
  });
}
async function rejeita(fn, codigo) {
  await assert.rejects(fn, (e) => e && (e.codigo === codigo || e.code === codigo), `esperado ${codigo}`);
}

describe('Migração de origem_canal (aditiva e idempotente)', () => {
  it('adiciona a coluna, preserva pedidos antigos com origem NULL e é idempotente', async () => {
    const db = await openMem();
    await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, status TEXT, empresa_id INTEGER)`);
    await run(db, `INSERT INTO pedidos (codigo, status, empresa_id) VALUES ('ANTIGO','PEDIDO',1)`);
    const r1 = await garantirSchemaOrigemPedidos(db);
    const r2 = await garantirSchemaOrigemPedidos(db);
    assert.equal(r1.colunaAdicionada, true);
    assert.equal(r2.colunaAdicionada, false);
    const antigo = await get(db, `SELECT codigo, origem_canal FROM pedidos`);
    assert.equal(antigo.codigo, 'ANTIGO');
    assert.equal(antigo.origem_canal, null);
    assert.equal((await garantirSchemaOrigemPedidos(null)).skipped, true);
    db.close();
  });

  it('database.js encadeia a migração e a migração real cria a coluna', async () => {
    assert.match(src('backend/database.js'), /garantirSchemaOrigemPedidos\(db\)/);
    const db = require('../../backend/database');
    await new Promise((r) => db.whenReady(() => r()));
    let cols = [];
    for (let i = 0; i < 50; i += 1) {
      cols = await all(db, 'PRAGMA table_info(pedidos)');
      if (cols.some((c) => c.name === 'origem_canal')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(cols.some((c) => c.name === 'origem_canal'));
  });
});

describe('Contrato de canais', () => {
  it('só EQUIPE está habilitado; demais canais fazem parte do contrato mas são recusados', () => {
    assert.deepEqual([...Entrada.CANAIS_HABILITADOS], ['EQUIPE']);
    assert.equal(Entrada.validarCanal('equipe'), 'EQUIPE');
    for (const c of ['BALCAO', 'MESA', 'CARDAPIO_WEB']) {
      assert.throws(() => Entrada.validarCanal(c), (e) => e.codigo === 'CANAL_ORIGEM_NAO_HABILITADO' && e.statusCode === 403);
    }
    for (const c of ['', null, undefined, 'WHATSAPP']) {
      assert.throws(() => Entrada.validarCanal(c), (e) => e.codigo === 'CANAL_ORIGEM_INVALIDO' && e.statusCode === 400);
    }
  });
});

describe('Entrada central + Pedido Operacional (serviço real, banco isolado)', () => {
  let fixture = null;
  async function preparar() {
    if (fixture) return fixture;
    const db = require('../../backend/database');
    await new Promise((r) => db.whenReady(() => r()));
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaMesas(db);
    await garantirSchemaOrigemPedidos(db);
    const a = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db });
    const b = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db });
    const prod = await run(db, `INSERT INTO produtos (nome, preco_venda, unidade, saldo_fiscal, estoque_atual) VALUES ('Pastel ENTRADA', 10, 'UN', 100, 100)`);
    for (const e of [a, b]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId: prod.lastID, empresaId: e.id, saldo_fiscal: 100, saldo_nao_fiscal: 0, estoque_atual: 100, reservado_fiscal: 0
      }, { db });
    }
    fixture = { db, produtoId: prod.lastID, a, b };
    return fixture;
  }

  async function contagens(db, produtoId) {
    const q = async (sql, p = []) => Number((await get(db, sql, p)).n);
    return {
      pedidos: await q('SELECT COUNT(*) AS n FROM pedidos'),
      itens: await q('SELECT COUNT(*) AS n FROM pedidos_itens'),
      vendas: await q('SELECT COUNT(*) AS n FROM vendas'),
      reservas: await q('SELECT COUNT(*) AS n FROM pedido_estoque_reservas'),
      saldoFiscal: await q('SELECT COALESCE(SUM(saldo_fiscal),0) AS n FROM estoque_empresa WHERE produto_id = ?', [produtoId]),
      estoqueAtual: await q('SELECT COALESCE(SUM(estoque_atual),0) AS n FROM estoque_empresa WHERE produto_id = ?', [produtoId])
    };
  }

  it('cria um pedido pelo caminho central e consome o estoque da empresa correta', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const { db, produtoId, a, b } = await preparar();
      const itens = [{ produto_id: produtoId, quantidade: 3, preco_unitario: 10, desconto_percentual: 0, subtotal: 30 }];
      const antes = await contagens(db, produtoId);

      // origem informada no corpo é ignorada: quem define o canal é o adaptador
      const out = await Entrada.receber({
        canal: Entrada.CanalOrigem.EQUIPE,
        body: { itens, total: 30, origem_canal: 'CARDAPIO_WEB', canal: 'CARDAPIO_WEB', origem: 'MESA' },
        empresaId: a.id,
        operadorId: null,
        chaveIdempotencia: 'entrada-central-pedido-1'
      });
      assert.equal(out.success, true);
      assert.ok(out.pedido.id);
      assert.equal(out.pedido.origem_canal, 'EQUIPE');
      assert.equal(out.pedido.status, 'PEDIDO');
      assert.equal(out.pedido.empresa_id, a.id);
      assert.equal(out.pedido.cliente_id, null);

      const depois = await contagens(db, produtoId);
      assert.equal(depois.pedidos, antes.pedidos + 1, 'exatamente um pedido');
      assert.equal(depois.itens, antes.itens + 1);
      assert.equal(depois.vendas, antes.vendas, 'sem venda');
      assert.equal(depois.reservas, antes.reservas + 1, 'a reserva consumida permanece rastreável');
      assert.equal(depois.saldoFiscal, antes.saldoFiscal - 3, 'baixa operacional aplicada');
      assert.equal(depois.estoqueAtual, antes.estoqueAtual - 3, 'estoque reduzido pela quantidade pedida');
      const res = await get(db, 'SELECT SUM(quantidade_fiscal) AS q FROM pedido_estoque_reservas WHERE pedido_id = ?', [out.pedido.id]);
      assert.equal(Number(res.q), 3);
      const saldoA = await EstoqueEmpresaService.consultarSaldo(
        { produtoId, empresaId: a.id },
        { db }
      );
      const saldoB = await EstoqueEmpresaService.consultarSaldo(
        { produtoId, empresaId: b.id },
        { db }
      );
      assert.equal(Number(saldoA.saldo_fiscal), 97);
      assert.equal(Number(saldoB.saldo_fiscal), 100);

      // equivalência com a criação direta anterior à camada (sem origem)
      const direto = await PedidoOperacional.criar({ itens, total: 30 }, null, { empresaId: a.id });
      assert.equal(direto.pedido.origem_canal, null);
      assert.equal(direto.pedido.status, out.pedido.status);
      assert.equal(Number(direto.pedido.total), Number(out.pedido.total));

      // consulta e listagem
      const consulta = await PedidoOperacional.obter(out.pedido.id, { empresaId: a.id });
      assert.equal(consulta.pedido.origem_canal, 'EQUIPE');
      const lista = await PedidoOperacional.listar({ empresaId: a.id });
      assert.equal(lista.itens.find((x) => x.id === out.pedido.id).origem_canal, 'EQUIPE');

      // isolamento
      await assert.rejects(PedidoOperacional.obter(out.pedido.id, { empresaId: b.id }), (e) => e.statusCode === 404);
      assert.equal((await PedidoOperacional.listar({ empresaId: b.id })).itens.length, 0);

      // mesa continua opcional e validada pela empresa
      const mesaB = (await MesaService.criar(b.id, { numero: 7 })).mesa;
      await rejeita(() => Entrada.receber({
        canal: 'EQUIPE',
        body: { itens, total: 30, mesa_id: mesaB.id },
        empresaId: a.id,
        chaveIdempotencia: 'entrada-central-mesa-invalida'
      }), 'MESA_NAO_ENCONTRADA');
      const mesaA = (await MesaService.criar(a.id, { numero: 7 })).mesa;
      const comMesa = await Entrada.receber({
        canal: 'EQUIPE',
        body: { itens, total: 30, mesa_id: mesaA.id },
        empresaId: a.id,
        chaveIdempotencia: 'entrada-central-mesa-valida'
      });
      assert.equal(comMesa.pedido.mesa_numero, 7);
      assert.equal(comMesa.pedido.origem_canal, 'EQUIPE');
    } finally {
      configService.recursoHabilitado = original;
    }
  });

  it('rejeita canal inválido/desabilitado e empresa ausente sem criar nada', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const { db, produtoId, a } = await preparar();
      const itens = [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 }];
      const antes = await contagens(db, produtoId);
      await rejeita(() => Entrada.receber({ canal: 'CARDAPIO_WEB', body: { itens, total: 10 }, empresaId: a.id }), 'CANAL_ORIGEM_NAO_HABILITADO');
      await rejeita(() => Entrada.receber({ canal: 'XPTO', body: { itens, total: 10 }, empresaId: a.id }), 'CANAL_ORIGEM_INVALIDO');
      await rejeita(() => Entrada.receber({ body: { itens, total: 10 }, empresaId: a.id }), 'CANAL_ORIGEM_INVALIDO');
      for (const emp of [undefined, null, '', 0, -1, 'abc']) {
        await rejeita(() => Entrada.receber({ canal: 'EQUIPE', body: { itens, total: 10 }, empresaId: emp }), 'EMPRESA_CONTEXT_REQUIRED');
      }
      assert.deepEqual(await contagens(db, produtoId), antes);
    } finally {
      configService.recursoHabilitado = original;
    }
  });

  it('rejeita itens, quantidades e totais inválidos sem criar pedido nem reserva', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const { db, produtoId, a } = await preparar();
      const antes = await contagens(db, produtoId);
      const item = (extra = {}) => ({ produto_id: produtoId, quantidade: 2, preco_unitario: 10, desconto_percentual: 0, subtotal: 20, ...extra });
      const invalidos = [
        { itens: [], total: 0 },
        { itens: [item({ quantidade: 0, subtotal: 0 })], total: 0 },
        { itens: [item({ quantidade: -1, subtotal: -10 })], total: -10 },
        { itens: [item({ preco_unitario: -5, subtotal: -10 })], total: -10 },
        { itens: [item({ produto_id: null })], total: 20 },
        { itens: [item()], total: 999 }
      ];
      for (const body of invalidos) {
        await assert.rejects(
          Entrada.receber({ canal: 'EQUIPE', body, empresaId: a.id }),
          (e) => e && e.statusCode >= 400 && e.statusCode < 500,
          `deveria rejeitar ${JSON.stringify(body)}`
        );
      }
      assert.deepEqual(await contagens(db, produtoId), antes);
    } finally {
      configService.recursoHabilitado = original;
    }
  });

  it('duplicar pedido continua funcionando (sem origem, sem regressão)', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const { produtoId, a } = await preparar();
      const itens = [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 }];
      const base = await Entrada.receber({
        canal: 'EQUIPE',
        body: { itens, total: 10 },
        empresaId: a.id,
        chaveIdempotencia: 'entrada-central-pedido-duplicar'
      });
      const copia = await PedidoOperacional.duplicar(base.pedido.id, null, { empresaId: a.id });
      assert.notEqual(copia.pedido.id, base.pedido.id);
      assert.equal(copia.pedido.origem_canal, null);
    } finally {
      configService.recursoHabilitado = original;
    }
  });
});

describe('Rollback do pedido e dos itens (transação existente do repositório)', () => {
  it('falha na gravação de item desfaz cabeçalho, origem e itens', async () => {
    const db = await openMem();
    await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nome TEXT, unidade TEXT, tipo_operacional TEXT DEFAULT 'COMERCIAL')`);
    await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, data_pedido TEXT, cliente_id INTEGER, total REAL DEFAULT 0, desconto REAL DEFAULT 0, frete REAL DEFAULT 0, status TEXT, representante_id INTEGER, representante_nome TEXT, observacao TEXT, operador_id INTEGER, venda_id INTEGER, empresa_id INTEGER, updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    await run(db, `CREATE TABLE pedidos_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL, quantidade REAL NOT NULL, preco_unitario REAL NOT NULL, desconto_percentual REAL DEFAULT 0, subtotal REAL NOT NULL, tipo_venda TEXT DEFAULT 'PESO')`);
    await run(db, `CREATE TABLE clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)`);
    await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, nome TEXT)`);
    await run(db, `INSERT INTO produtos (codigo, nome, unidade) VALUES ('A','Pastel','UN')`);
    await garantirSchemaMesas(db);
    await garantirSchemaOrigemPedidos(db);
    const base = {
      db, dataPedido: '2026-01-01', total: 20, desconto: 0, frete: 0, status: 'PEDIDO', empresaId: 1, origemCanal: 'EQUIPE'
    };
    await assert.rejects(repo.criarPedido({
      ...base,
      codigo: 'RB-1',
      itens: [
        { produto_id: 1, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 },
        { produto_id: null, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 }
      ]
    }));
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM pedidos')).n), 0);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM pedidos_itens')).n), 0);

    const id = await repo.criarPedido({
      ...base,
      codigo: 'OK-1',
      itens: [{ produto_id: 1, quantidade: 1, preco_unitario: 10, desconto_percentual: 0, subtotal: 10 }]
    });
    const p = await repo.obterPorId(id, { db });
    assert.equal(p.origem_canal, 'EQUIPE');

    // schema sem a coluna: falha explícita e nada gravado
    const db2 = await openMem();
    await run(db2, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, empresa_id INTEGER)`);
    await run(db2, `CREATE TABLE pedidos_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, produto_id INTEGER)`);
    await run(db2, `CREATE TABLE produtos (id INTEGER PRIMARY KEY)`);
    await assert.rejects(repo.criarPedido({ ...base, db: db2, codigo: 'X', itens: [] }), /origem_canal/);
    assert.equal(Number((await get(db2, 'SELECT COUNT(*) AS n FROM pedidos')).n), 0);
    db.close();
    db2.close();
  });
});

describe('Rotas e compatibilidade (código-fonte)', () => {
  it('POST /api/pedidos passa pela camada central; sem endpoint público; legado intacto', () => {
    const rota = src('backend/rotas/pedidos.js');
    assert.match(rota, /EntradaPedido\.receber\(/);
    assert.match(rota, /CanalOrigem\.EQUIPE/);
    assert.doesNotMatch(rota, /req\.body[^;\n]*(origem|canal)/i, 'canal não pode vir do corpo');
    const server = src('backend/server.js');
    assert.doesNotMatch(server, /entrada-?pedido|api\/entrada|api\/publico\/pedidos|cardapio/i);
    // legado (faturamento) continua usando o PedidoService, sem passar pela camada
    assert.doesNotMatch(src('backend/rotas/faturamento.js'), /EntradaPedido/);
    const entrada = src('backend/services/pedido/EntradaPedidoService.js');
    assert.doesNotMatch(entrada, /INSERT INTO|FaturamentoService|MotorComercial|body\.(origem|canal)/);
  });
});
