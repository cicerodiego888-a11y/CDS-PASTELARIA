'use strict';

const { after, before, describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint32-faturamento-'));
process.env.DB_DIR = dbDir;

const db = require('../../backend/database');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const reservasPublico = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const PedidoService = require('../../backend/services/pedido/PedidoService');
const PedidoOperacionalService = require('../../backend/services/pedido/PedidoOperacionalService');
const PedidoConsumoEstoqueService = require('../../backend/services/pedido/PedidoConsumoEstoqueService');
const FaturamentoService = require('../../backend/services/faturamento/FaturamentoService');
const PedidoFaturamentoOperacaoRepository = require('../../backend/services/faturamento/PedidoFaturamentoOperacaoRepository');
const VendaCancelamentoService = require('../../backend/services/vendas/VendaCancelamentoService');
const VendaApplicationService = require('../../backend/services/vendas/VendaApplicationService');
const { criarVendaContract } = require('../../backend/services/vendas/VendaContract');
const { criarVendaContext } = require('../../backend/services/vendas/VendaContext');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const {
  garantirSchemaVendaFichaConsumoAsync
} = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const CanalVendaEmpresaService = require('../../backend/services/vendas/CanalVendaEmpresaService');
const EntradaPedidoService = require('../../backend/services/pedido/EntradaPedidoService');

function whenReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Banco isolado não ficou pronto a tempo.')), 90000);
    db.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

let empresa;
let recursoHabilitadoOriginal;
let modoOperacionalOriginal;

async function criarProduto({ nome, unidade = 'UN', saldo = 20, tipo = 'COMERCIAL', preco = 5 }) {
  const insert = await run(
    `INSERT INTO produtos (
       nome, unidade, tipo_operacional, controla_estoque, saldo_fiscal,
       saldo_nao_fiscal, estoque_atual, preco_venda, ativo
     ) VALUES (?, ?, ?, 1, ?, 0, ?, ?, 1)`,
    [nome, unidade, tipo, saldo, saldo, preco]
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId: insert.lastID,
    empresaId: empresa.id,
    saldo_fiscal: saldo,
    saldo_nao_fiscal: 0,
    estoque_atual: saldo,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  }, { db });
  return insert.lastID;
}

function montarItem(produtoId, quantidade, preco = 5) {
  return {
    produto_id: produtoId,
    quantidade,
    preco_unitario: preco,
    subtotal: Number((quantidade * preco).toFixed(2))
  };
}

async function criarPedido(itens, { legado = false } = {}) {
  const total = Number(itens.reduce((soma, item) => soma + item.subtotal, 0).toFixed(2));
  const codigo = `SPRINT32-${crypto.randomUUID()}`;
  const opcoes = {
    db,
    empresaId: empresa.id,
    chaveIdempotencia: crypto.randomUUID(),
    exigirChaveIdempotencia: true
  };
  const body = {
    codigo,
    ...(legado ? { tipo: 'orcamento' } : {}),
    total,
    itens
  };
  const resultado = legado
    ? await PedidoOperacionalService.criar(body, null, opcoes)
    : await PedidoService.criarPedido(body, null, opcoes);
  const pedido = resultado.pedido;
  if (legado) {
    await run(
      `UPDATE pedidos SET status = 'AGUARDANDO_FATURAMENTO' WHERE id = ?`,
      [pedido.id]
    );
  }
  return pedido;
}

function requestContext() {
  return { empresaId: empresa.id, empresa_id: empresa.id, headers: {} };
}

function faturar(pedido) {
  return FaturamentoService.faturarPedido(
    pedido.id,
    { forma_pagamento: 'dinheiro' },
    requestContext()
  );
}

function criarVendaSemPedido(payload) {
  const req = {
    body: payload,
    empresaId: empresa.id,
    empresa_id: empresa.id,
    headers: {}
  };
  const contract = criarVendaContract({ body: payload });
  const context = criarVendaContext(req, { origem: 'FATURAMENTO' });
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        if (this.statusCode >= 400) reject(Object.assign(new Error(body.error), body));
        else resolve(body);
        return this;
      }
    };
    try {
      const result = VendaApplicationService.criarVendaComContexto(
        contract,
        context,
        req,
        res,
        { obterModoOperacaoVenda: () => 'EMPRESA_UNICA' }
      );
      if (result && typeof result.then === 'function') result.catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

async function saldo(produtoId) {
  return get(
    `SELECT p.saldo_fiscal AS global_fiscal,
            p.saldo_nao_fiscal AS global_nao_fiscal,
            p.estoque_atual AS global_atual,
            e.saldo_fiscal AS empresa_fiscal,
            e.saldo_nao_fiscal AS empresa_nao_fiscal,
            e.estoque_atual AS empresa_atual,
            p.reservado_fiscal AS global_reservado,
            e.reservado_fiscal AS empresa_reservado
       FROM produtos p
       JOIN estoque_empresa e ON e.produto_id = p.id AND e.empresa_id = ?
      WHERE p.id = ?`,
    [empresa.id, produtoId]
  );
}

async function saldoSnapshot(produtoIds) {
  const result = {};
  for (const id of produtoIds) result[id] = await saldo(id);
  return result;
}

async function consumoPedido(pedidoId) {
  return all(
    `SELECT pedido_item_id, produto_id, insumo_id, origem_requisito,
            quantidade, quantidade_fiscal, quantidade_nao_fiscal, unidade
       FROM pedido_estoque_consumo_itens
      WHERE pedido_id = ?
      ORDER BY id`,
    [pedidoId]
  );
}

async function reservasDoPedido(pedidoId) {
  return all(
    `SELECT produto_id, quantidade_fiscal, status
       FROM pedido_estoque_reservas
      WHERE pedido_id = ?
      ORDER BY id`,
    [pedidoId]
  );
}

async function vendaDoPedido(pedidoId) {
  return get(
    'SELECT id, codigo, pedido_id, empresa_id, total, status FROM vendas WHERE pedido_id = ?',
    [pedidoId]
  );
}

async function itensDaVenda(vendaId) {
  return all(
    'SELECT produto_id, quantidade FROM vendas_itens WHERE venda_id = ? ORDER BY id',
    [vendaId]
  );
}

async function estornarConsumoDaVenda(venda) {
  await run('BEGIN IMMEDIATE');
  try {
    const itens = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [venda.id]);
    await new Promise((resolve, reject) => {
      VendaCancelamentoService.devolverEstoqueEEstornarFichaDaVenda(
        itens,
        venda,
        { empresaId: empresa.id, operadorId: 1, user: { id: 1 } },
        db,
        (err) => (err ? reject(err) : resolve())
      );
    });
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
}

async function criarGatilhoSemBaixa(nome, produtoIds) {
  const ids = produtoIds.map(Number).join(', ');
  await run(`
    CREATE TRIGGER ${nome}
    BEFORE UPDATE OF saldo_fiscal ON estoque_empresa
    WHEN OLD.produto_id IN (${ids}) AND NEW.saldo_fiscal < OLD.saldo_fiscal
    BEGIN
      SELECT RAISE(ABORT, '${nome}_segunda_baixa');
    END
  `);
}

describe('Sprint 3.2 — faturamento integrado de Pedido consumido', { concurrency: false }, () => {
  before(async () => {
    recursoHabilitadoOriginal = configService.recursoHabilitado;
    modoOperacionalOriginal = configService.obterModoOperacionalGlobal;
    configService.recursoHabilitado = () => true;
    configService.obterModoOperacionalGlobal = () => 'EMPRESA_SIMPLES';

    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await PedidoConsumoEstoqueService.garantirSchema(db);
    await reservasPublico.garantirSchemaReservas(db);
    await garantirSchemaFichaTecnicaAsync(db);
    await garantirSchemaVendaFichaConsumoAsync(db);

    empresa = await EmpresaService.criarEmpresa({
      cnpj: '11222333000181',
      razao_social: 'Sprint 3.2 — Empresa isolada'
    }, { db });
  });

  after(() => {
    configService.recursoHabilitado = recursoHabilitadoOriginal;
    configService.obterModoOperacionalGlobal = modoOperacionalOriginal;
  });

  it('conexão exclusiva usa o mesmo arquivo, WAL, foreign keys e busy timeout', async () => {
    const exclusiveDb = await db.openExclusiveConnection();
    try {
      assert.notEqual(exclusiveDb, db);
      assert.equal(exclusiveDb.dbPath, db.dbPath);
      const journalMode = await new Promise((resolve, reject) => {
        exclusiveDb.get('PRAGMA journal_mode', (err, row) => (
          err ? reject(err) : resolve(row.journal_mode)
        ));
      });
      const foreignKeys = await new Promise((resolve, reject) => {
        exclusiveDb.get('PRAGMA foreign_keys', (err, row) => (
          err ? reject(err) : resolve(row.foreign_keys)
        ));
      });
      const busyTimeout = await new Promise((resolve, reject) => {
        exclusiveDb.get('PRAGMA busy_timeout', (err, row) => (
          err ? reject(err) : resolve(row.timeout)
        ));
      });
      assert.equal(String(journalMode).toLowerCase(), 'wal');
      assert.equal(Number(foreignKeys), 1);
      assert.ok(Number(busyTimeout) >= 30000);
    } finally {
      await new Promise((resolve, reject) => {
        exclusiveDb.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('código VND mantém o formato base e ganha sufixo em colisões no mesmo segundo', async () => {
    const produtoA = await criarProduto({ nome: 'S32 código único A', saldo: 10 });
    const produtoB = await criarProduto({ nome: 'S32 código único B', saldo: 11 });
    const pedidoA = await criarPedido([montarItem(produtoA, 1)]);
    const pedidoB = await criarPedido([montarItem(produtoB, 1)]);
    const instanteFixo = Date.parse('2026-10-23T15:00:00.000Z');

    mock.timers.enable({ apis: ['Date'], now: instanteFixo });
    try {
      assert.equal((await faturar(pedidoA)).success, true);
      assert.equal((await faturar(pedidoB)).success, true);
    } finally {
      mock.timers.reset();
    }

    const vendas = await all(
      `SELECT codigo FROM vendas
        WHERE pedido_id IN (?, ?)
        ORDER BY id`,
      [pedidoA.id, pedidoB.id]
    );
    assert.deepEqual(vendas.map((venda) => venda.codigo), [
      'VND-20261023120000',
      'VND-20261023120000-01'
    ]);
  });

  it('A — fatura produto simples sem segunda baixa; retry não cria nova venda', async () => {
    const produtoId = await criarProduto({ nome: 'S32 simples', saldo: 10 });
    const pedido = await criarPedido([montarItem(produtoId, 2)]);
    const antes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    assert.equal(Number(antes.global_fiscal), 10);
    assert.equal(Number(antes.empresa_fiscal), 10);
    assert.equal(ledgerAntes.length, 0);

    const resposta = await faturar(pedido);

    assert.equal(resposta.success, true);
    const depois = await saldo(produtoId);
    assert.equal(Number(depois.global_fiscal), 8);
    assert.equal(Number(depois.empresa_fiscal), 8);
    const venda = await vendaDoPedido(pedido.id);
    assert.ok(venda);
    assert.ok(venda.codigo);
    assert.equal(Number(venda.pedido_id), pedido.id);
    assert.equal(Number(venda.empresa_id), empresa.id);
    assert.equal(Number(venda.total), 10);
    assert.equal(venda.status, 'concluida');
    assert.deepEqual(await itensDaVenda(venda.id), [{ produto_id: produtoId, quantidade: 2 }]);
    const itemPersistido = await get(
      `SELECT item_fiscal, quantidade_fiscal, quantidade_nao_fiscal,
              valor_fiscal, valor_nao_fiscal
         FROM vendas_itens
        WHERE venda_id = ? AND produto_id = ?`,
      [venda.id, produtoId]
    );
    assert.equal(Number(itemPersistido.item_fiscal), 1);
    assert.equal(Number(itemPersistido.quantidade_fiscal), 2);
    assert.equal(Number(itemPersistido.quantidade_nao_fiscal), 0);
    assert.equal(Number(itemPersistido.valor_fiscal), 10);
    assert.equal(Number(itemPersistido.valor_nao_fiscal), 0);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
    await criarGatilhoSemBaixa('s32_sem_segunda_baixa_simples', [produtoId]);

    await assert.rejects(faturar(pedido), (err) => err.statusCode === 409);
    assert.equal(await vendaDoPedido(pedido.id).then(Boolean), true);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM vendas WHERE pedido_id = ?',
      [pedido.id]
    )).total), 1);
    assert.deepEqual(await saldo(produtoId), depois);
  });

  it('preserva código do canal e empresa entre pedido e venda faturada', async () => {
    const produtoId = await criarProduto({ nome: 'S32 canal de venda', saldo: 10 });
    const canal = await CanalVendaEmpresaService.cadastrarCanal(db, {
      nome: 'Marketplace S32',
      codigo: 'MKT_S32',
      tipo_origem: 'MARKETPLACE',
      empresa_id: empresa.id
    }, { usuario: { id: 905 } });
    const itens = [montarItem(produtoId, 2)];
    const pedidoCriado = await EntradaPedidoService.receber({
      canal: EntradaPedidoService.CanalOrigem.EQUIPE,
      canalVendaCodigo: canal.codigo,
      usuario: { id: 905, role: 'SUPER_ADMIN' },
      body: { total: 10, itens },
      empresaId: empresa.id,
      operadorId: 905,
      chaveIdempotencia: 's32-pedido-canal-faturamento',
      db
    });
    const pedido = pedidoCriado.pedido;
    assert.equal(pedido.origem_canal, 'MKT_S32');
    assert.equal(Number(pedido.empresa_id), empresa.id);

    const usuarioInserido = await run(
      'INSERT INTO usuarios (username, password_hash, role) VALUES (?, ?, ?)',
      [`s32-canal-${crypto.randomUUID()}`, 'hash-de-teste', 'operador']
    );
    const operadorId = usuarioInserido.lastID;
    await PedidoOperacionalService.enviarParaFaturamento(
      pedido.id,
      {},
      operadorId,
      { db, empresaId: empresa.id }
    );
    await FaturamentoService.faturarPedido(
      pedido.id,
      { forma_pagamento: 'dinheiro' },
      { ...requestContext(), operadorId, user: { id: operadorId } }
    );

    const venda = await vendaDoPedido(pedido.id);
    assert.ok(venda);
    assert.equal(Number(venda.empresa_id), empresa.id);
    const origemPersistida = await get(`
      SELECT p.origem_canal, p.empresa_id AS pedido_empresa_id,
             v.empresa_id AS venda_empresa_id, v.pedido_id
      FROM pedidos p
      JOIN vendas v ON v.pedido_id = p.id
      WHERE p.id = ?
    `, [pedido.id]);
    assert.equal(origemPersistida.origem_canal, 'MKT_S32');
    assert.equal(Number(origemPersistida.pedido_empresa_id), empresa.id);
    assert.equal(Number(origemPersistida.venda_empresa_id), empresa.id);
    assert.equal(Number(origemPersistida.pedido_id), pedido.id);
  });

  it('cancelamento da venda usa o ledger do Pedido e restaura saldo uma única vez', async () => {
    const produtoId = await criarProduto({ nome: 'S32 cancelamento consumo', saldo: 10 });
    const pedido = await criarPedido([montarItem(produtoId, 2)]);
    const saldoInicial = await saldo(produtoId);

    await faturar(pedido);

    const venda = await get('SELECT * FROM vendas WHERE pedido_id = ?', [pedido.id]);
    assert.ok(venda);
    assert.equal(Number(venda.empresa_id), empresa.id);
    assert.equal(Number(venda.pedido_id), pedido.id);
    const saldoAposVenda = await saldo(produtoId);
    assert.equal(Number(saldoAposVenda.global_fiscal), 8);
    assert.equal(Number(saldoAposVenda.global_nao_fiscal), 0);
    assert.equal(Number(saldoAposVenda.global_atual), 8);
    assert.equal(Number(saldoAposVenda.empresa_fiscal), 8);
    assert.equal(Number(saldoAposVenda.empresa_nao_fiscal), 0);
    assert.equal(Number(saldoAposVenda.empresa_atual), 8);
    const itensConsumo = await all(
      `SELECT produto_id, quantidade, empresa_id
         FROM pedido_estoque_consumo_itens
        WHERE pedido_id = ?`,
      [pedido.id]
    );
    assert.deepEqual(itensConsumo.map((linha) => ({
      produto_id: Number(linha.produto_id),
      quantidade: Number(linha.quantidade),
      empresa_id: Number(linha.empresa_id)
    })), [{
      produto_id: produtoId,
      quantidade: 2,
      empresa_id: empresa.id
    }]);
    const finalizacao = await get(
      `SELECT pedido_id, consumo_id, venda_id, empresa_id
         FROM pedido_estoque_consumo_finalizacoes
        WHERE pedido_id = ?`,
      [pedido.id]
    );
    assert.ok(finalizacao);
    assert.equal(Number(finalizacao.venda_id), Number(venda.id));
    assert.equal(Number(finalizacao.empresa_id), empresa.id);

    await estornarConsumoDaVenda(venda);

    const saldoRestaurado = await saldo(produtoId);
    assert.deepEqual(saldoRestaurado, {
      ...saldoInicial,
      global_reservado: 0,
      empresa_reservado: 0
    });
    const estorno = await get(
      `SELECT pedido_id, consumo_id, empresa_id
         FROM pedido_estoque_estornos
        WHERE pedido_id = ?`,
      [pedido.id]
    );
    assert.ok(estorno);
    assert.equal(Number(estorno.pedido_id), pedido.id);
    assert.equal(Number(estorno.empresa_id), empresa.id);
    const movimentos = await all(
      `SELECT produto_id, empresa_id, tipo_saldo, quantidade
         FROM pedido_estoque_estorno_movimentos
        WHERE pedido_id = ?`,
      [pedido.id]
    );
    assert.deepEqual(movimentos.map((movimento) => ({
      produto_id: Number(movimento.produto_id),
      empresa_id: Number(movimento.empresa_id),
      tipo_saldo: movimento.tipo_saldo,
      quantidade: Number(movimento.quantidade)
    })), [{
      produto_id: produtoId,
      empresa_id: empresa.id,
      tipo_saldo: 'FISCAL',
      quantidade: 2
    }]);

    await estornarConsumoDaVenda(venda);

    assert.deepEqual(await saldo(produtoId), {
      ...saldoInicial,
      global_reservado: 0,
      empresa_reservado: 0
    });
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM pedido_estoque_estornos WHERE pedido_id = ?',
      [pedido.id]
    )).total), 1);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM pedido_estoque_estorno_movimentos WHERE pedido_id = ?',
      [pedido.id]
    )).total), 1);
    console.log(`[S32 CANCELAMENTO] ${JSON.stringify({
      pedido_id: pedido.id,
      venda_id: venda.id,
      empresa_id: empresa.id,
      produto_id: produtoId,
      saldo_inicial: saldoInicial,
      saldo_apos_venda: saldoAposVenda,
      saldo_apos_estorno: saldoRestaurado,
      consumo: itensConsumo,
      finalizacao,
      estorno_id: estorno.id,
      movimentos
    })}`);
  });

  it('B — fatura ficha técnica sem baixar ingredientes nem o produto final', async () => {
    const produtoId = await criarProduto({ nome: 'S32 receita', saldo: 15 });
    const farinhaId = await criarProduto({ nome: 'S32 farinha', unidade: 'G', saldo: 1000, tipo: 'INSUMO' });
    const queijoId = await criarProduto({ nome: 'S32 queijo', unidade: 'G', saldo: 500, tipo: 'INSUMO' });
    await FichaTecnicaService.salvar(produtoId, {
      ativo: 1,
      itens: [
        { insumo_id: farinhaId, quantidade: 30, unidade: 'G' },
        { insumo_id: queijoId, quantidade: 10, unidade: 'G' }
      ]
    }, { db });

    const pedido = await criarPedido([montarItem(produtoId, 2)]);
    const ids = [produtoId, farinhaId, queijoId];
    const antes = await saldoSnapshot(ids);
    const ledger = await consumoPedido(pedido.id);
    assert.equal(ledger.length, 0);
    assert.equal(Number(antes[produtoId].empresa_fiscal), 15);
    assert.equal(Number(antes[farinhaId].empresa_fiscal), 1000);
    assert.equal(Number(antes[queijoId].empresa_fiscal), 500);
    const resposta = await faturar(pedido);

    assert.equal(resposta.success, true);
    const depois = await saldoSnapshot(ids);
    assert.equal(Number(depois[produtoId].empresa_fiscal), 15);
    assert.equal(Number(depois[farinhaId].empresa_fiscal), 940);
    assert.equal(Number(depois[queijoId].empresa_fiscal), 480);
    const venda = await vendaDoPedido(pedido.id);
    assert.ok(venda);
    assert.equal((await itensDaVenda(venda.id)).length, 1);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM venda_ficha_consumo WHERE venda_id = ?',
      [venda.id]
    )).total), 0);
    assert.equal((await consumoPedido(pedido.id)).length, 2);
  });

  it('C — mantém saldos e ledger de itens mistos com ingrediente compartilhado', async () => {
    const receitaA = await criarProduto({ nome: 'S32 receita A', saldo: 12 });
    const receitaB = await criarProduto({ nome: 'S32 receita B', saldo: 9 });
    const simples = await criarProduto({ nome: 'S32 item simples', saldo: 20 });
    const ingredienteComum = await criarProduto({ nome: 'S32 ingrediente comum', unidade: 'G', saldo: 1000, tipo: 'INSUMO' });
    const ingredienteA = await criarProduto({ nome: 'S32 ingrediente A', unidade: 'G', saldo: 700, tipo: 'INSUMO' });

    await FichaTecnicaService.salvar(receitaA, {
      ativo: 1,
      itens: [
        { insumo_id: ingredienteComum, quantidade: 10, unidade: 'G' },
        { insumo_id: ingredienteA, quantidade: 5, unidade: 'G' }
      ]
    }, { db });
    await FichaTecnicaService.salvar(receitaB, {
      ativo: 1,
      itens: [{ insumo_id: ingredienteComum, quantidade: 25, unidade: 'G' }]
    }, { db });

    const pedido = await criarPedido([
      montarItem(receitaA, 2),
      montarItem(receitaB, 1),
      montarItem(simples, 3)
    ]);
    const ids = [receitaA, receitaB, simples, ingredienteComum, ingredienteA];
    const antes = await saldoSnapshot(ids);
    const ledger = await consumoPedido(pedido.id);
    assert.equal(ledger.length, 0);
    assert.equal(Number(antes[ingredienteComum].empresa_fiscal), 1000);
    assert.equal(Number(antes[ingredienteA].empresa_fiscal), 700);
    assert.equal(Number(antes[simples].empresa_fiscal), 20);
    const resposta = await faturar(pedido);

    assert.equal(resposta.success, true);
    const depois = await saldoSnapshot(ids);
    assert.equal(Number(depois[receitaA].empresa_fiscal), 12);
    assert.equal(Number(depois[receitaB].empresa_fiscal), 9);
    assert.equal(Number(depois[simples].empresa_fiscal), 17);
    assert.equal(Number(depois[ingredienteComum].empresa_fiscal), 955);
    assert.equal(Number(depois[ingredienteA].empresa_fiscal), 690);
    const venda = await vendaDoPedido(pedido.id);
    assert.ok(venda);
    assert.deepEqual(
      (await itensDaVenda(venda.id)).map((item) => Number(item.produto_id)),
      [receitaA, receitaB, simples]
    );
    assert.equal((await consumoPedido(pedido.id)).length, 4);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM venda_ficha_consumo WHERE venda_id = ?',
      [venda.id]
    )).total), 0);
  });

  it('venda sem Pedido associado continua usando o caminho normal do Núcleo', async () => {
    const produtoId = await criarProduto({ nome: 'S313 venda avulsa', saldo: 8 });
    const resposta = await criarVendaSemPedido({
      origem: 'FATURAMENTO',
      pedido_id: null,
      cliente_id: null,
      tipo_venda: 'BALCAO',
      forma_pagamento: 'dinheiro',
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 5 }],
      total: 5,
      emitir_fiscal: false,
      itens: [montarItem(produtoId, 1)]
    });

    assert.ok(resposta.id);
    const venda = await get('SELECT pedido_id FROM vendas WHERE id = ?', [resposta.id]);
    assert.ok(venda);
    assert.equal(venda.pedido_id, null);
    assert.equal((await itensDaVenda(resposta.id)).length, 1);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM pedido_faturamento_operacoes WHERE venda_id = ?',
      [resposta.id]
    )).total), 0);
  });

  it('D — Pedido legado sem ledger continua baixando no fluxo de venda', async () => {
    const produtoId = await criarProduto({ nome: 'S32 legado', saldo: 11 });
    const pedido = await criarPedido([montarItem(produtoId, 3)], { legado: true });
    const antes = await saldo(produtoId);
    assert.equal((await consumoPedido(pedido.id)).length, 0);
    assert.equal(Number(antes.empresa_fiscal), 11);

    const resposta = await faturar(pedido);

    assert.equal(resposta.success, true);
    assert.equal(Number((await saldo(produtoId)).empresa_fiscal), 8);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
    const venda = await vendaDoPedido(pedido.id);
    assert.ok(venda);
    assert.equal((await itensDaVenda(venda.id)).length, 1);
  });

  it('E0 — falha no INSERT da venda chega ao chamador e reverte a operação', async () => {
    const produtoId = await criarProduto({ nome: 'S32 falha venda', saldo: 12 });
    const pedido = await criarPedido([montarItem(produtoId, 2)]);
    const antes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    const trigger = 's32_falha_insert_vendas';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON vendas
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    try {
      await assert.rejects(
        faturar(pedido),
        (err) => err.statusCode === 500 && err.message.includes(`${trigger}_injetada`)
      );
    } finally {
      await run(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    assert.deepEqual(await saldo(produtoId), antes);
    assert.deepEqual(await consumoPedido(pedido.id), ledgerAntes);
    assert.equal(await vendaDoPedido(pedido.id), null);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'AGUARDANDO_FATURAMENTO');
  });

  it('E1 — falha ao inserir item da venda reverte venda e preserva Pedido e estoque', async () => {
    const produtoId = await criarProduto({ nome: 'S32 falha item', saldo: 12 });
    const pedido = await criarPedido([montarItem(produtoId, 2)]);
    const antes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    const reservasAntes = await reservasDoPedido(pedido.id);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);
    const itensAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total);
    const trigger = 's32_falha_insert_vendas_item';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON vendas_itens
      WHEN NEW.produto_id = ${Number(produtoId)}
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    await assert.rejects(
      faturar(pedido),
      (err) => err.statusCode === 500 && err.message.includes(`${trigger}_injetada`)
    );

    assert.deepEqual(await saldo(produtoId), antes);
    assert.deepEqual(await consumoPedido(pedido.id), ledgerAntes);
    assert.deepEqual(await reservasDoPedido(pedido.id), reservasAntes);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total), itensAntes);
    assert.equal(await vendaDoPedido(pedido.id), null);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'AGUARDANDO_FATURAMENTO');
  });

  it('E1b — falha no segundo item reverte o cabeçalho e o primeiro item inserido', async () => {
    const produtoA = await criarProduto({ nome: 'S32 falha item posterior A', saldo: 15 });
    const produtoB = await criarProduto({ nome: 'S32 falha item posterior B', saldo: 16 });
    const pedido = await criarPedido([
      montarItem(produtoA, 1),
      montarItem(produtoB, 1)
    ]);
    const antes = await saldoSnapshot([produtoA, produtoB]);
    const ledgerAntes = await consumoPedido(pedido.id);
    const reservasAntes = await reservasDoPedido(pedido.id);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);
    const itensAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total);
    const trigger = 's32_falha_insert_segundo_item';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON vendas_itens
      WHEN NEW.produto_id = ${Number(produtoB)}
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    try {
      await assert.rejects(
        faturar(pedido),
        (err) => err.statusCode === 500 && err.message.includes(`${trigger}_injetada`)
      );

      assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
      assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total), itensAntes);
      assert.deepEqual(await saldoSnapshot([produtoA, produtoB]), antes);
      assert.deepEqual(await consumoPedido(pedido.id), ledgerAntes);
      assert.deepEqual(await reservasDoPedido(pedido.id), reservasAntes);
      assert.equal(await vendaDoPedido(pedido.id), null);
      assert.equal(
        (await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status,
        'AGUARDANDO_FATURAMENTO'
      );
    } finally {
      await run(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  });

  it('E2 — falha no débito físico da venda legada reverte o saldo global e empresarial', async () => {
    const produtoId = await criarProduto({ nome: 'S32 falha baixa', saldo: 13 });
    const pedido = await criarPedido([montarItem(produtoId, 2)], { legado: true });
    const antes = await saldo(produtoId);
    const trigger = 's32_falha_debito_empresa';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF saldo_fiscal ON estoque_empresa
      WHEN OLD.produto_id = ${Number(produtoId)} AND NEW.saldo_fiscal < OLD.saldo_fiscal
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    await assert.rejects(faturar(pedido));

    assert.deepEqual(await saldo(produtoId), antes);
    assert.equal(await vendaDoPedido(pedido.id), null);
    assert.equal((await consumoPedido(pedido.id)).length, 0);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'AGUARDANDO_FATURAMENTO');
  });

  it('E3 — falha ao gravar ledger do Pedido reverte venda e todos os débitos da transação', async () => {
    const produtoId = await criarProduto({ nome: 'S32 falha receita', saldo: 14 });
    const insumoId = await criarProduto({ nome: 'S32 falha insumo', unidade: 'G', saldo: 500, tipo: 'INSUMO' });
    await FichaTecnicaService.salvar(produtoId, {
      ativo: 1,
      itens: [{ insumo_id: insumoId, quantidade: 12, unidade: 'G' }]
    }, { db });
    const pedido = await criarPedido([montarItem(produtoId, 2)], { legado: true });
    const antes = await saldoSnapshot([produtoId, insumoId]);
    const trigger = 's32_falha_ledger_ficha';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON pedido_estoque_consumo_itens
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    await assert.rejects(faturar(pedido));

    assert.deepEqual(await saldoSnapshot([produtoId, insumoId]), antes);
    assert.equal(await vendaDoPedido(pedido.id), null);
    assert.equal((await consumoPedido(pedido.id)).length, 0);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM pedido_estoque_consumo_finalizacoes WHERE pedido_id = ?',
      [pedido.id]
    )).total), 0);
    await run(`DROP TRIGGER IF EXISTS ${trigger}`);
  });

  it('E4 — reconcilia reserva ativa e baixa o consumo físico uma única vez', async () => {
    const produtoId = await criarProduto({ nome: 'S32 reserva órfã', saldo: 10 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    await reservasPublico.reservarQuantidade(produtoId, 'FISCAL', 1, {
      db,
      empresaId: empresa.id
    });
    const itemPedido = await get(
      'SELECT id FROM pedidos_itens WHERE pedido_id = ? ORDER BY id LIMIT 1',
      [pedido.id]
    );
    const colunasReservas = new Set(
      (await all('PRAGMA table_info(pedido_estoque_reservas)')).map((coluna) => coluna.name)
    );
    const campos = ['pedido_id', 'pedido_item_id', 'produto_id', 'quantidade_fiscal', 'status'];
    const valores = [pedido.id, itemPedido.id, produtoId, 1, 'ATIVA'];
    if (colunasReservas.has('empresa_id')) {
      campos.push('empresa_id');
      valores.push(empresa.id);
    }
    await run(
      `INSERT INTO pedido_estoque_reservas (${campos.join(', ')})
       VALUES (${campos.map(() => '?').join(', ')})`,
      valores
    );
    const saldoAntes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    await run('UPDATE produtos SET reservado_fiscal = 0 WHERE id = ?', [produtoId]);
    await run(
      'UPDATE estoque_empresa SET reservado_fiscal = 0 WHERE produto_id = ? AND empresa_id = ?',
      [produtoId, empresa.id]
    );

    const resposta = await faturar(pedido);
    assert.equal(resposta.success, true);
    const venda = await get(
      'SELECT id, pedido_id FROM vendas WHERE id = ?',
      [resposta.venda_id]
    );
    assert.ok(venda);
    assert.equal(Number(venda.pedido_id), pedido.id);
    assert.equal((await itensDaVenda(venda.id)).length, 1);
    const reservas = await all(
      'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = ? ORDER BY id',
      [pedido.id]
    );
    assert.ok(reservas.some((reserva) => reserva.status === 'CONSUMIDA'));
    assert.ok(reservas.every((reserva) => ['CONSUMIDA', 'CANCELADA'].includes(reserva.status)));
    const saldoAtual = await saldo(produtoId);
    assert.ok(Number(saldoAntes.global_reservado) > 0);
    assert.ok(Number(saldoAntes.empresa_reservado) > 0);
    assert.equal(Number(saldoAtual.global_reservado), 0);
    assert.equal(Number(saldoAtual.empresa_reservado), 0);
    assert.equal(Number(saldoAtual.global_fiscal), Number(saldoAntes.global_fiscal) - 1);
    assert.equal(Number(saldoAtual.empresa_fiscal), Number(saldoAntes.empresa_fiscal) - 1);
    assert.equal(ledgerAntes.length, 0);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'FATURADO');
    await assert.rejects(faturar(pedido), (err) => err.statusCode === 409);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM vendas WHERE pedido_id = ?',
      [pedido.id]
    )).total), 1);
  });

  it('P1 — falha pós-commit no vínculo propaga erro e retry finaliza a mesma venda', async () => {
    const produtoId = await criarProduto({ nome: 'S312 falha vínculo', saldo: 10 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const saldoAntes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    const reservasAntes = await reservasDoPedido(pedido.id);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);
    const itensAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total);
    const trigger = 's313_falha_vinculo_venda_pedido';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF pedido_id ON vendas
      WHEN NEW.pedido_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    let erroPosCommit;
    await assert.rejects(faturar(pedido), (err) => {
      erroPosCommit = err;
      return err.venda_persistida === true && err.message.includes(`${trigger}_injetada`);
    });

    const vendaInicial = await get(
      'SELECT id, pedido_id FROM vendas WHERE id = (SELECT venda_id FROM pedido_faturamento_operacoes WHERE pedido_id = ?)',
      [pedido.id]
    );
    assert.ok(vendaInicial);
    assert.equal(vendaInicial.pedido_id, null);
    assert.equal(erroPosCommit.venda_id, vendaInicial.id);
    assert.equal((await itensDaVenda(vendaInicial.id)).length, 1);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes + 1);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total), itensAntes + 1);
    assert.equal(
      (await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status,
      'AGUARDANDO_FATURAMENTO'
    );
    const saldoAposVenda = await saldo(produtoId);
    assert.equal(Number(saldoAposVenda.empresa_fiscal), Number(saldoAntes.empresa_fiscal) - 1);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
    assert.ok((await reservasDoPedido(pedido.id)).some((reserva) => reserva.status === 'CONSUMIDA'));
    await run(`DROP TRIGGER IF EXISTS ${trigger}`);

    const respostaRetry = await faturar(pedido);
    const vendaFinal = await get('SELECT id, pedido_id FROM vendas WHERE id = ?', [vendaInicial.id]);
    const pedidoFinal = await get('SELECT status, venda_id FROM pedidos WHERE id = ?', [pedido.id]);
    assert.equal(respostaRetry.venda_id, vendaInicial.id);
    assert.equal(Number(vendaFinal.pedido_id), pedido.id);
    assert.equal(pedidoFinal.status, 'FATURADO');
    assert.equal(Number(pedidoFinal.venda_id), vendaInicial.id);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes + 1);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas_itens')).total), itensAntes + 1);
    assert.deepEqual(await saldo(produtoId), saldoAposVenda);
  });

  it('P2 — falha no status reverte a finalização e retry reutiliza a venda persistida', async () => {
    const produtoId = await criarProduto({ nome: 'S312 falha status', saldo: 12 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const saldoAntes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    const reservasAntes = await reservasDoPedido(pedido.id);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);
    const trigger = 's312_falha_status_pedido';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF status ON pedidos
      WHEN NEW.status = 'FATURADO'
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    let erroPosCommit;
    await assert.rejects(
      faturar(pedido),
      (err) => {
        erroPosCommit = err;
        return err.message.includes(`${trigger}_injetada`);
      }
    );
    assert.equal(erroPosCommit.code, 'SQLITE_CONSTRAINT');
    assert.equal(erroPosCommit.venda_persistida, true);
    assert.ok(erroPosCommit.message.includes(`${trigger}_injetada`));

    const vendaInicial = await get(
      'SELECT id, pedido_id FROM vendas WHERE id = (SELECT venda_id FROM pedido_faturamento_operacoes WHERE pedido_id = ?)',
      [pedido.id]
    );
    assert.ok(vendaInicial);
    assert.equal(vendaInicial.pedido_id, null);
    assert.equal((await itensDaVenda(vendaInicial.id)).length, 1);
    assert.equal(
      (await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status,
      'AGUARDANDO_FATURAMENTO'
    );
    const saldoAposVenda = await saldo(produtoId);
    assert.equal(Number(saldoAposVenda.empresa_fiscal), Number(saldoAntes.empresa_fiscal) - 1);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
    assert.ok((await reservasDoPedido(pedido.id)).some((reserva) => reserva.status === 'CONSUMIDA'));

    await run(`DROP TRIGGER IF EXISTS ${trigger}`);
    const respostaRetry = await faturar(pedido);
    assert.equal(respostaRetry.venda_id, vendaInicial.id);
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM vendas WHERE pedido_id = ?',
      [pedido.id]
    )).total), 1);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes + 1);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'FATURADO');
    assert.deepEqual(await saldo(produtoId), saldoAposVenda);
  });

  it('P3 — falha na reserva reverte counters/tracking e retry conclui sem nova baixa', async () => {
    const produtoId = await criarProduto({ nome: 'S313 falha reserva', saldo: 11 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    await reservasPublico.reservarQuantidade(produtoId, 'FISCAL', 1, {
      db,
      empresaId: empresa.id
    });
    const itemPedido = await get(
      'SELECT id FROM pedidos_itens WHERE pedido_id = ? ORDER BY id LIMIT 1',
      [pedido.id]
    );
    const camposReserva = ['pedido_id', 'pedido_item_id', 'produto_id', 'quantidade_fiscal', 'status', 'empresa_id'];
    await run(`
      INSERT INTO pedido_estoque_reservas (${camposReserva.join(', ')})
      VALUES (?, ?, ?, 1, 'ATIVA', ?)
    `, [pedido.id, itemPedido.id, produtoId, empresa.id]);
    const saldoAntes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    const trigger = 's313_falha_reserva_tracking';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF status ON pedido_estoque_reservas
      WHEN OLD.pedido_id = ${Number(pedido.id)} AND OLD.status = 'ATIVA'
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    await assert.rejects(
      faturar(pedido),
      (err) => err.message.includes(`${trigger}_injetada`)
    );
    const vendaInicial = await get(
      'SELECT id FROM vendas WHERE id = (SELECT venda_id FROM pedido_faturamento_operacoes WHERE pedido_id = ?)',
      [pedido.id]
    );
    assert.equal(vendaInicial, null);
    assert.equal((await get(
      'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = ?',
      [pedido.id]
    )).status, 'ATIVA');
    assert.ok(Number((await saldo(produtoId)).global_reservado) > 0);
    assert.ok(Number((await saldo(produtoId)).empresa_reservado) > 0);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'AGUARDANDO_FATURAMENTO');
    assert.deepEqual(await saldo(produtoId), saldoAntes);
    assert.deepEqual(await consumoPedido(pedido.id), ledgerAntes);
    await run(`DROP TRIGGER IF EXISTS ${trigger}`);

    const respostaRetry = await faturar(pedido);
    assert.ok(Number(respostaRetry.venda_id) > 0);
    const statusReservas = await all(
      'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = ?',
      [pedido.id]
    );
    assert.ok(statusReservas.some((reserva) => reserva.status === 'CONSUMIDA'));
    assert.ok(statusReservas.every((reserva) => ['CONSUMIDA', 'CANCELADA'].includes(reserva.status)));
    const saldoFinal = await saldo(produtoId);
    assert.equal(Number(saldoFinal.global_reservado), 0);
    assert.equal(Number(saldoFinal.empresa_reservado), 0);
    assert.equal(Number(saldoFinal.global_fiscal), Number(saldoAntes.global_fiscal) - 1);
    assert.equal(Number(saldoFinal.empresa_fiscal), Number(saldoAntes.empresa_fiscal) - 1);
    assert.equal(ledgerAntes.length, 0);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
  });

  it('P4 — repetição após falha parcial reutiliza a venda e não duplica itens', async () => {
    const produtoId = await criarProduto({ nome: 'S312 retry pós-commit', saldo: 13 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const saldoAntes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);
    const reservasAntes = await reservasDoPedido(pedido.id);
    const trigger = 's312_falha_status_retry';
    await run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE OF status ON pedidos
      WHEN NEW.status = 'FATURADO'
      BEGIN
        SELECT RAISE(ABORT, '${trigger}_injetada');
      END
    `);

    await assert.rejects(
      faturar(pedido),
      (err) => err.code === 'SQLITE_CONSTRAINT'
        && err.message.includes(`${trigger}_injetada`)
    );
    await run(`DROP TRIGGER IF EXISTS ${trigger}`);

    const respostaRetry = await faturar(pedido);
    const vendasDoPedido = await all(
      'SELECT id, pedido_id FROM vendas WHERE pedido_id = ? ORDER BY id',
      [pedido.id]
    );
    assert.equal(respostaRetry.success, true);
    assert.equal(vendasDoPedido.length, 1);
    assert.equal((await itensDaVenda(vendasDoPedido[0].id)).length, 1);
    assert.equal(Number((await get(
      'SELECT venda_id FROM pedidos WHERE id = ?',
      [pedido.id]
    )).venda_id), Number(vendasDoPedido[0].id));
    const saldoFinal = await saldo(produtoId);
    assert.equal(Number(saldoFinal.global_fiscal), Number(saldoAntes.global_fiscal) - 1);
    assert.equal(Number(saldoFinal.empresa_fiscal), Number(saldoAntes.empresa_fiscal) - 1);
    assert.equal(Number(saldoFinal.global_reservado), 0);
    assert.equal(Number(saldoFinal.empresa_reservado), 0);
    assert.equal(ledgerAntes.length, 0);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
    assert.ok((await reservasDoPedido(pedido.id)).some((reserva) => reserva.status === 'CONSUMIDA'));
  });

  it('P5 — nova tentativa após Pedido faturado retorna 409 sem nova venda ou baixa', async () => {
    const produtoId = await criarProduto({ nome: 'S312 retry faturado', saldo: 14 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const resposta = await faturar(pedido);
    const saldoDepoisDaVenda = await saldo(produtoId);
    const ledgerDepoisDaVenda = await consumoPedido(pedido.id);
    const venda = await vendaDoPedido(pedido.id);

    assert.equal(resposta.success, true);
    await assert.rejects(
      faturar(pedido),
      (err) => err.statusCode === 409 && err.venda_id === venda.id
    );
    assert.equal(Number((await get(
      'SELECT COUNT(*) AS total FROM vendas WHERE pedido_id = ?',
      [pedido.id]
    )).total), 1);
    assert.equal((await itensDaVenda(venda.id)).length, 1);
    assert.deepEqual(await saldo(produtoId), saldoDepoisDaVenda);
    assert.deepEqual(await consumoPedido(pedido.id), ledgerDepoisDaVenda);
  });

  it('PDV — recupera bruto/desconto/total e bloqueia divergência sem finalizar parcialmente', async () => {
    const produtoId = await criarProduto({ nome: 'PDV snapshot desconto', saldo: 18 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    await run(`UPDATE pedidos SET status = 'PEDIDO' WHERE id = ?`, [pedido.id]);
    const snapshot = {
      pedidoId: pedido.id,
      empresaId: empresa.id,
      fingerprint: 'snapshot-pdv-desconto',
      total: 5,
      desconto: 0.5,
      valor_composicao_bruto: 5.5,
      cliente_id: pedido.cliente_id || null,
      itens: [{
        produto_id: produtoId,
        quantidade: 1,
        preco_unitario: 5.5,
        subtotal: 5.5,
        tipo_venda: 'PESO'
      }]
    };
    const preparacao = await PedidoFaturamentoOperacaoRepository.prepararOperacaoPdv(
      pedido.id,
      empresa.id,
      snapshot
    );
    const vendaInserida = await run(`
      INSERT INTO vendas (
        codigo, data_venda, cliente_id, total, desconto, forma_pagamento,
        status, status_pagamento, empresa_id
      ) VALUES (?, DATE('now'), ?, ?, 0, 'dinheiro', 'concluida', 'recebido', ?)
    `, [`PDV-SNAPSHOT-${crypto.randomUUID()}`, pedido.cliente_id || null, snapshot.total, empresa.id]);
    const vendaId = vendaInserida.lastID;
    await run(`
      INSERT INTO vendas_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (?, ?, 1, ?, ?)
    `, [vendaId, produtoId, snapshot.itens[0].preco_unitario, snapshot.itens[0].subtotal]);
    await PedidoFaturamentoOperacaoRepository.registrarVendaCriada(
      db,
      preparacao.operacao.id,
      pedido.id,
      empresa.id,
      vendaId
    );

    const operacaoRecuperada = await PedidoFaturamentoOperacaoRepository.consultarOperacaoPdv(
      pedido.id,
      empresa.id
    );
    assert.equal(operacaoRecuperada.payload.valor_composicao_bruto, 5.5);
    assert.equal(operacaoRecuperada.payload.desconto, 0.5);
    assert.equal(operacaoRecuperada.payload.total, 5);

    const saldoAntesDaRejeicao = await saldo(produtoId);
    await assert.rejects(
      FaturamentoService.finalizarVendaPdvPedido(pedido.id, requestContext()),
      (err) => err.codigo === 'FATURAMENTO_PEDIDO_CONFLITANTE'
        && err.venda_id === vendaId
        && err.venda_persistida === true
    );
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'PEDIDO');
    assert.equal(
      (await get('SELECT status FROM pedido_faturamento_operacoes WHERE id = ?', [preparacao.operacao.id])).status,
      'VENDA_CRIADA'
    );
    assert.deepEqual(await saldo(produtoId), saldoAntesDaRejeicao);

    await run('UPDATE vendas SET desconto = ? WHERE id = ?', [snapshot.desconto, vendaId]);
    const finalizacao = await FaturamentoService.finalizarVendaPdvPedido(pedido.id, requestContext());
    assert.equal(finalizacao.idempotente, false);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'FATURADO');
    assert.equal(
      (await get('SELECT status FROM pedido_faturamento_operacoes WHERE id = ?', [preparacao.operacao.id])).status,
      'FINALIZADA'
    );
    assert.equal(
      Number((await get('SELECT COUNT(*) AS total FROM vendas_itens WHERE venda_id = ?', [vendaId])).total),
      1
    );

    const saldoDepoisDaFinalizacao = await saldo(produtoId);
    const repeticao = await FaturamentoService.finalizarVendaPdvPedido(pedido.id, requestContext());
    assert.equal(repeticao.idempotente, true);
    assert.deepEqual(await saldo(produtoId), saldoDepoisDaFinalizacao);
    assert.equal(
      Number((await get('SELECT COUNT(*) AS total FROM vendas WHERE pedido_id = ?', [pedido.id])).total),
      1
    );
  });

  it('recupera vínculo assimétrico por vendas.pedido_id sem recriar a venda', async () => {
    const produtoId = await criarProduto({ nome: 'S313 vínculo assimétrico', saldo: 14 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const respostaInicial = await faturar(pedido);
    const vendaId = respostaInicial.venda_id;
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);

    await run(
      `UPDATE pedidos
       SET status = 'AGUARDANDO_FATURAMENTO', venda_id = NULL
       WHERE id = ?`,
      [pedido.id]
    );
    await run(
      `UPDATE pedido_faturamento_operacoes
       SET status = 'VENDA_CRIADA'
       WHERE pedido_id = ?`,
      [pedido.id]
    );

    const respostaRetry = await faturar(pedido);
    assert.equal(respostaRetry.venda_id, vendaId);
    assert.equal(Number((await get(
      'SELECT venda_id FROM pedidos WHERE id = ?',
      [pedido.id]
    )).venda_id), vendaId);
    assert.equal(Number((await get(
      'SELECT pedido_id FROM vendas WHERE id = ?',
      [vendaId]
    )).pedido_id), pedido.id);
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
  });

  it('bloqueia venda histórica sem nenhum vínculo conhecido em vez de criar uma duplicata', async () => {
    const produtoId = await criarProduto({ nome: 'S313 venda órfã', saldo: 14 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const resposta = await faturar(pedido);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);

    await run(
      `UPDATE pedidos
       SET status = 'AGUARDANDO_FATURAMENTO', venda_id = NULL
       WHERE id = ?`,
      [pedido.id]
    );
    await run('UPDATE vendas SET pedido_id = NULL WHERE id = ?', [resposta.venda_id]);
    await run('DELETE FROM pedido_faturamento_operacoes WHERE pedido_id = ?', [pedido.id]);

    await assert.rejects(
      faturar(pedido),
      (err) => err.statusCode === 409
        && err.codigo === 'FATURAMENTO_VENDA_ORFA'
        && err.venda_ids_candidatas.includes(resposta.venda_id)
    );
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'AGUARDANDO_FATURAMENTO');
  });

  it('bloqueia múltiplas vendas candidatas sem escolher nem criar outra', async () => {
    const produtoA = await criarProduto({ nome: 'S313 conflito A', saldo: 14 });
    const produtoB = await criarProduto({ nome: 'S313 conflito B', saldo: 15 });
    const pedidoA = await criarPedido([montarItem(produtoA, 1)]);
    const pedidoB = await criarPedido([montarItem(produtoB, 1)]);
    const respostaA = await faturar(pedidoA);
    const respostaB = await faturar(pedidoB);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);

    await run('UPDATE vendas SET pedido_id = ? WHERE id = ?', [pedidoA.id, respostaB.venda_id]);
    await assert.rejects(
      faturar(pedidoA),
      (err) => err.statusCode === 409
        && err.codigo === 'FATURAMENTO_PEDIDO_CONFLITANTE'
        && Array.isArray(err.venda_ids_candidatas)
        && err.venda_ids_candidatas.length === 2
    );

    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
    assert.equal(Number((await get(
      'SELECT venda_id FROM pedidos WHERE id = ?',
      [pedidoA.id]
    )).venda_id), Number(respostaA.venda_id));
  });

  it('bloqueia recuperação quando os itens persistidos divergem do Pedido', async () => {
    const produtoId = await criarProduto({ nome: 'S313 itens divergentes', saldo: 15 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const resposta = await faturar(pedido);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);
    await run(
      'UPDATE vendas_itens SET subtotal = subtotal + 1 WHERE venda_id = ?',
      [resposta.venda_id]
    );

    await assert.rejects(
      faturar(pedido),
      (err) => err.statusCode === 409
        && err.codigo === 'FATURAMENTO_PEDIDO_CONFLITANTE'
        && err.venda_id === resposta.venda_id
        && err.venda_persistida === true
    );
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'FATURADO');
  });

  it('bloqueia reutilização de venda sem ownership compatível com o Pedido', async () => {
    const produtoId = await criarProduto({ nome: 'S313 empresa divergente', saldo: 12 });
    const pedido = await criarPedido([montarItem(produtoId, 1)]);
    const resposta = await faturar(pedido);
    const vendasAntes = Number((await get('SELECT COUNT(*) AS total FROM vendas')).total);
    await run('UPDATE vendas SET empresa_id = NULL WHERE id = ?', [resposta.venda_id]);

    await assert.rejects(
      faturar(pedido),
      (err) => err.statusCode === 409
        && err.codigo === 'FATURAMENTO_PEDIDO_CONFLITANTE'
        && err.venda_id === resposta.venda_id
    );
    assert.equal(Number((await get('SELECT COUNT(*) AS total FROM vendas')).total), vendasAntes);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'FATURADO');
  });

  it('concorrência — duas tentativas simultâneas mantêm uma venda e um único consumo', async () => {
    const produtoId = await criarProduto({ nome: 'S313 faturamento concorrente', saldo: 15 });
    const pedido = await criarPedido([montarItem(produtoId, 2)]);
    const saldoAntes = await saldo(produtoId);
    const ledgerAntes = await consumoPedido(pedido.id);

    const resultados = await Promise.allSettled([faturar(pedido), faturar(pedido)]);
    const respostas = resultados.filter((resultado) => resultado.status === 'fulfilled');
    const erros = resultados.filter((resultado) => resultado.status === 'rejected');
    assert.ok(respostas.length >= 1);
    assert.ok(erros.every((resultado) => resultado.reason.statusCode === 409));

    const vendas = await all(
      'SELECT id, pedido_id FROM vendas WHERE pedido_id = ? ORDER BY id',
      [pedido.id]
    );
    assert.equal(vendas.length, 1);
    assert.equal(Number((await get(
      'SELECT venda_id FROM pedidos WHERE id = ?',
      [pedido.id]
    )).venda_id), Number(vendas[0].id));
    assert.equal(Number(vendas[0].pedido_id), pedido.id);
    assert.equal((await itensDaVenda(vendas[0].id)).length, 1);
    assert.equal((await get('SELECT status FROM pedidos WHERE id = ?', [pedido.id])).status, 'FATURADO');
    const saldoFinal = await saldo(produtoId);
    assert.equal(Number(saldoFinal.global_fiscal), Number(saldoAntes.global_fiscal) - 2);
    assert.equal(Number(saldoFinal.empresa_fiscal), Number(saldoAntes.empresa_fiscal) - 2);
    assert.equal(Number(saldoFinal.global_reservado), 0);
    assert.equal(Number(saldoFinal.empresa_reservado), 0);
    assert.equal(ledgerAntes.length, 0);
    assert.equal((await consumoPedido(pedido.id)).length, 1);
  });
});
