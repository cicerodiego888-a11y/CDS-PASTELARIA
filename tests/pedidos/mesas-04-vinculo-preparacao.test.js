/**
 * MESAS-04 — vínculo do pedido ao atendimento e preparação, sem venda e sem banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/pedidos/mesas-04-vinculo-preparacao.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas04-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const MesaService = require('../../backend/services/pedido/MesaService');
const Atendimento = require('../../backend/services/pedido/MesaAtendimentoService');
const Preparacao = require('../../backend/services/pedido/PedidoPreparacaoService');
const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { LIMITES_PREPARACAO_MINUTOS } = require('../../backend/services/pedido/preparacaoLimites');

const T0 = '2026-11-02 12:00:00';
const T4 = '2026-11-02 12:04:59';
const T5 = '2026-11-02 12:05:00';
const T19 = '2026-11-02 12:19:59';
const T20 = '2026-11-02 12:20:00';

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

function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function rejeita(fn, codigo) {
  await assert.rejects(fn, (err) => err && err.codigo === codigo, `esperado ${codigo}`);
}

async function memoria() {
  const db = await open();
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT, status TEXT, empresa_id INTEGER, total REAL DEFAULT 0,
    mesa_id INTEGER, mesa_atendimento_id INTEGER, venda_id INTEGER
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER)`);
  await garantirSchemaMesas(db);
  return db;
}

async function mesa(db, empresaId, numero) {
  return (await MesaService.criar(empresaId, { numero }, { db })).mesa;
}

async function semearPedido(db, { empresaId, mesaId, atendimentoId, status, codigo, total }) {
  const ins = await run(db, `
    INSERT INTO pedidos (codigo, status, empresa_id, total, mesa_id, mesa_atendimento_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [codigo, status, empresaId, total, mesaId, atendimentoId]);
  await run(db, `
    INSERT INTO pedidos_itens (pedido_id, quantidade, preco_unitario, subtotal) VALUES (?, 2, 10, 20)
  `, [ins.lastID]);
  if (atendimentoId != null) {
    await Preparacao.registrarNaoEnviado({
      db, empresaId, pedidoId: ins.lastID, atendimentoId
    });
  }
  return ins.lastID;
}

let ambientePronto;
function ambiente() {
  if (!ambientePronto) ambientePronto = montarAmbiente();
  return ambientePronto;
}

async function montarAmbiente() {
  const db = require('../../backend/database');
  await new Promise((resolve) => db.whenReady(() => resolve()));
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaMesas(db);
  const a = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'Salao A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'Salao B' }, { db });
  const prod = await run(db, `
    INSERT INTO produtos (nome, preco_venda, unidade, unidade_estoque, utiliza_conversao, saldo_fiscal, estoque_atual)
    VALUES ('Pastel MESAS04', 10, 'UN', 'UN', 0, 500, 500)
  `);
  for (const empresa of [a, b]) {
    await EstoqueEmpresaService.criarRegistro({
      produtoId: prod.lastID,
      empresaId: empresa.id,
      saldo_fiscal: 500,
      saldo_nao_fiscal: 0,
      estoque_atual: 500,
      reservado_fiscal: 0
    }, { db });
  }
  return { db, produtoId: prod.lastID, a, b };
}

function itensDe(produtoId, quantidade = 1) {
  return [{
    produto_id: produtoId,
    quantidade,
    preco_unitario: 10,
    desconto_percentual: 0,
    subtotal: quantidade * 10
  }];
}

async function criarNoSalao(ctx, empresaId, mesaId, extra = {}) {
  const original = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;
  try {
    return await PedidoOperacional.criar({
      itens: itensDe(ctx.produtoId, extra.quantidade || 1),
      total: (extra.quantidade || 1) * 10,
      mesa_id: mesaId,
      mesa_atendimento_id: extra.mesaAtendimentoId,
      status: extra.status,
      tipo: extra.tipo,
      observacao: extra.observacao || null
    }, extra.operadorId || 8, { empresaId, db: ctx.db });
  } finally {
    configService.recursoHabilitado = original;
  }
}

describe('vínculo pelo fluxo real de criação', () => {
  it('vincula o pedido novo ao atendimento ativo e ignora o identificador enviado', async () => {
    const ctx = await ambiente();
    const ocupada = await mesa(ctx.db, ctx.a.id, 1);
    const aberto = await Atendimento.abrir(ctx.a.id, ocupada.id, { operadorId: 8, clienteId: 5 }, { db: ctx.db });
    const criado = await criarNoSalao(ctx, ctx.a.id, ocupada.id, { mesaAtendimentoId: 999999 });
    assert.equal(criado.pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.notEqual(criado.pedido.mesa_atendimento_id, 999999);
    assert.equal(criado.pedido.mesa_id, ocupada.id);
    assert.equal(criado.pedido.status, 'PEDIDO');
    const prep = await get(ctx.db, 'SELECT estado, enviado_em FROM pedido_preparacoes WHERE pedido_id = ?', [criado.pedido.id]);
    assert.equal(prep.estado, 'NAO_ENVIADO');
    assert.equal(prep.enviado_em, null);
    const vendas = await get(ctx.db, 'SELECT COUNT(*) AS total FROM vendas');
    assert.equal(vendas.total, 0);
  });

  it('recusa mesa livre, atendimento encerrado, fechamento e mesa de outra empresa', async () => {
    const ctx = await ambiente();
    const livre = await mesa(ctx.db, ctx.a.id, 2);
    const antes = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos');
    await rejeita(() => criarNoSalao(ctx, ctx.a.id, livre.id), 'ATENDIMENTO_NAO_ABERTO');

    const encerrada = await mesa(ctx.db, ctx.a.id, 3);
    await Atendimento.abrir(ctx.a.id, encerrada.id, { operadorId: 8 }, { db: ctx.db });
    await Atendimento.encerrar(ctx.a.id, encerrada.id, { operadorId: 8 }, { db: ctx.db });
    await rejeita(() => criarNoSalao(ctx, ctx.a.id, encerrada.id), 'ATENDIMENTO_JA_ENCERRADO');

    const fechamento = await mesa(ctx.db, ctx.a.id, 4);
    const emFechamento = await Atendimento.abrir(ctx.a.id, fechamento.id, { operadorId: 8 }, { db: ctx.db });
    await run(ctx.db, `UPDATE mesa_atendimentos SET estado = 'FECHAMENTO' WHERE id = ?`, [emFechamento.atendimento.id]);
    await rejeita(() => criarNoSalao(ctx, ctx.a.id, fechamento.id), 'ATENDIMENTO_EM_FECHAMENTO');

    const outra = await mesa(ctx.db, ctx.b.id, 1);
    await Atendimento.abrir(ctx.b.id, outra.id, { operadorId: 8 }, { db: ctx.db });
    await rejeita(
      () => criarNoSalao(ctx, ctx.a.id, outra.id, { mesaAtendimentoId: emFechamento.atendimento.id }),
      'MESA_NAO_ENCONTRADA'
    );
    const depois = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos');
    assert.equal(depois.total, antes.total);
  });

  it('preserva pedido sem mesa, pedido legado e o vínculo depois da transferência', async () => {
    const ctx = await ambiente();
    const origem = await mesa(ctx.db, ctx.a.id, 11);
    const destino = await mesa(ctx.db, ctx.a.id, 15);
    const legado = await run(ctx.db, `
      INSERT INTO pedidos (codigo, data_pedido, status, empresa_id, mesa_id, total)
      VALUES ('ANTIGO-04', '2026-01-01', 'PEDIDO', ?, ?, 15)
    `, [ctx.a.id, origem.id]);
    const aberto = await Atendimento.abrir(ctx.a.id, origem.id, { operadorId: 8 }, { db: ctx.db });
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    let fora;
    let criado;
    try {
      fora = await PedidoOperacional.criar({
        itens: itensDe(ctx.produtoId),
        total: 10
      }, 8, { empresaId: ctx.a.id, db: ctx.db });
      criado = await criarNoSalao(ctx, ctx.a.id, origem.id);
    } finally {
      configService.recursoHabilitado = original;
    }
    assert.equal(fora.pedido.mesa_id, null);
    assert.equal(fora.pedido.mesa_atendimento_id, null);
    const semPrep = await get(ctx.db, 'SELECT id FROM pedido_preparacoes WHERE pedido_id = ?', [fora.pedido.id]);
    assert.equal(semPrep, null);

    await Preparacao.enviar(ctx.a.id, criado.pedido.id, { operadorId: 9 }, { db: ctx.db, agora: T0 });
    const enviadoAntes = (await get(ctx.db, 'SELECT enviado_em FROM pedido_preparacoes WHERE pedido_id = ?', [criado.pedido.id])).enviado_em;
    await Atendimento.transferir(ctx.a.id, origem.id, { mesaDestinoId: destino.id, operadorId: 9 }, { db: ctx.db });
    const pedido = await get(ctx.db, 'SELECT mesa_id, mesa_atendimento_id, total, status FROM pedidos WHERE id = ?', [criado.pedido.id]);
    assert.equal(pedido.mesa_id, origem.id);
    assert.equal(pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.equal(pedido.total, 10);
    assert.equal(pedido.status, 'PEDIDO');
    const legadoDepois = await get(ctx.db, 'SELECT mesa_id, mesa_atendimento_id, status, total FROM pedidos WHERE id = ?', [legado.lastID]);
    assert.equal(legadoDepois.mesa_id, origem.id);
    assert.equal(legadoDepois.mesa_atendimento_id, null);
    assert.equal(legadoDepois.status, 'PEDIDO');
    assert.equal(legadoDepois.total, 15);

    const novo = await criarNoSalao(ctx, ctx.a.id, destino.id);
    assert.equal(novo.pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.equal(novo.pedido.mesa_id, destino.id);
    const lista = await Preparacao.listarPorMesa(ctx.a.id, destino.id, { db: ctx.db, agora: T5 });
    assert.equal(lista.atendimento_id, aberto.atendimento.id);
    const porId = new Map(lista.pedidos.map((item) => [item.id, item]));
    assert.equal(porId.get(criado.pedido.id).preparacao.enviado_em, enviadoAntes);
    assert.equal(porId.get(criado.pedido.id).preparacao.classificacao, 'ATRASADO');
    assert.equal(porId.get(novo.pedido.id).preparacao.classificacao, 'NAO_ENVIADO');
    assert.equal(lista.pedidos.some((item) => item.id === legado.lastID), false);
    await rejeita(() => Preparacao.listarPorMesa(ctx.b.id, destino.id, { db: ctx.db }), 'MESA_NAO_ENCONTRADA');
  });

  it('editar o pedido não inicia o relógio', async () => {
    const ctx = await ambiente();
    const ocupada = await mesa(ctx.db, ctx.a.id, 21);
    await Atendimento.abrir(ctx.a.id, ocupada.id, { operadorId: 8 }, { db: ctx.db });
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const criado = await criarNoSalao(ctx, ctx.a.id, ocupada.id, { tipo: 'orcamento' });
      assert.equal(criado.pedido.status, 'ORCAMENTO');
      const editado = await PedidoOperacional.atualizar(criado.pedido.id, {
        itens: itensDe(ctx.produtoId),
        total: 10,
        mesa_id: ocupada.id,
        observacao: 'sem envio'
      }, { empresaId: ctx.a.id, db: ctx.db });
      assert.equal(editado.pedido.id, criado.pedido.id);
      assert.equal(editado.pedido.mesa_atendimento_id, criado.pedido.mesa_atendimento_id);
      const prep = await get(ctx.db, 'SELECT estado, enviado_em FROM pedido_preparacoes WHERE pedido_id = ?', [criado.pedido.id]);
      assert.equal(prep.estado, 'NAO_ENVIADO');
      assert.equal(prep.enviado_em, null);
      await rejeita(
        () => Preparacao.enviar(ctx.a.id, criado.pedido.id, { operadorId: 9 }, { db: ctx.db }),
        'PREPARACAO_ESTADO_INCOMPATIVEL'
      );
    } finally {
      configService.recursoHabilitado = original;
    }
  });
});

describe('preparação e tempo', () => {
  it('envio e conclusão usam o horário do servidor e a repetição não reinicia', async () => {
    const db = await memoria();
    try {
      const ocupada = await mesa(db, 1, 1);
      const aberto = await Atendimento.abrir(1, ocupada.id, { operadorId: 8 }, { db });
      const pedidoId = await semearPedido(db, {
        empresaId: 1, mesaId: ocupada.id, atendimentoId: aberto.atendimento.id,
        status: 'PEDIDO', codigo: 'PED-1', total: 20
      });
      const antes = await get(db, 'SELECT COUNT(*) AS total FROM pedidos_itens WHERE pedido_id = ?', [pedidoId]);
      const envio = await Preparacao.enviar(1, pedidoId, { operadorId: 9, idempotencyKey: 'env-1' }, { db, agora: T0 });
      assert.equal(envio.repetida, false);
      assert.equal(envio.preparacao.estado, 'EM_PREPARACAO');
      assert.equal(envio.preparacao.enviado_em, T0);
      assert.equal(envio.preparacao.classificacao, 'NORMAL');
      const repetido = await Preparacao.enviar(1, pedidoId, { operadorId: 9, idempotencyKey: 'env-1' }, { db, agora: T20 });
      assert.equal(repetido.repetida, true);
      assert.equal(repetido.preparacao.enviado_em, T0);
      const linhas = await get(db, 'SELECT COUNT(*) AS total FROM pedido_preparacoes WHERE pedido_id = ?', [pedidoId]);
      assert.equal(linhas.total, 1);
      const pedido = await get(db, 'SELECT status, total, venda_id FROM pedidos WHERE id = ?', [pedidoId]);
      assert.equal(pedido.status, 'PEDIDO');
      assert.equal(pedido.total, 20);
      assert.equal(pedido.venda_id, null);
      const itens = await get(db, 'SELECT COUNT(*) AS total FROM pedidos_itens WHERE pedido_id = ?', [pedidoId]);
      assert.equal(itens.total, antes.total);
      const vendas = await get(db, 'SELECT COUNT(*) AS total FROM vendas');
      assert.equal(vendas.total, 0);

      const outro = await semearPedido(db, {
        empresaId: 1, mesaId: ocupada.id, atendimentoId: aberto.atendimento.id,
        status: 'PEDIDO', codigo: 'PED-2', total: 20
      });
      await rejeita(() => Preparacao.concluir(1, outro, { operadorId: 4 }, { db }), 'PREPARACAO_NAO_ENVIADA');

      const fim = await Preparacao.concluir(1, pedidoId, { operadorId: 4 }, { db, agora: T5 });
      assert.equal(fim.preparacao.estado, 'CONCLUIDO');
      assert.equal(fim.preparacao.concluido_em, T5);
      assert.equal(fim.preparacao.enviado_em, T0);
      const deNovo = await Preparacao.concluir(1, pedidoId, { operadorId: 7 }, { db, agora: T20 });
      assert.equal(deNovo.repetida, true);
      assert.equal(deNovo.preparacao.concluido_em, T5);
      const atendimento = await get(db, 'SELECT estado, mesa_id FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
      assert.equal(atendimento.estado, 'OCUPADA');
      assert.equal(atendimento.mesa_id, ocupada.id);
    } finally { await close(db); }
  });

  it('classifica 5 e 20 minutos sem gravar o relógio a cada consulta', async () => {
    assert.equal(LIMITES_PREPARACAO_MINUTOS.atraso, 5);
    assert.equal(LIMITES_PREPARACAO_MINUTOS.critico, 20);
    const db = await memoria();
    try {
      const ocupada = await mesa(db, 1, 1);
      const aberto = await Atendimento.abrir(1, ocupada.id, { operadorId: 8 }, { db });
      const pedidoId = await semearPedido(db, {
        empresaId: 1, mesaId: ocupada.id, atendimentoId: aberto.atendimento.id,
        status: 'PEDIDO', codigo: 'PED-T', total: 20
      });
      let lista = await Preparacao.listarPorMesa(1, ocupada.id, { db, agora: T0 });
      assert.equal(lista.pedidos[0].preparacao.classificacao, 'NAO_ENVIADO');
      assert.equal(lista.pedidos[0].preparacao.tempo_decorrido_segundos, null);
      await Preparacao.enviar(1, pedidoId, { operadorId: 9 }, { db, agora: T0 });
      const atualizacoes = async () => (await get(db, 'SELECT updated_at FROM pedido_preparacoes WHERE pedido_id = ?', [pedidoId])).updated_at;
      const marco = await atualizacoes();
      for (const [quando, classe, segundos] of [
        [T4, 'NORMAL', 299],
        [T5, 'ATRASADO', 300],
        [T19, 'ATRASADO', 1199],
        [T20, 'CRITICO', 1200]
      ]) {
        lista = await Preparacao.listarPorMesa(1, ocupada.id, { db, agora: quando });
        assert.equal(lista.pedidos[0].preparacao.classificacao, classe);
        assert.equal(lista.pedidos[0].preparacao.tempo_decorrido_segundos, segundos);
        assert.equal(lista.pedidos[0].preparacao.enviado_em, T0);
      }
      assert.equal(await atualizacoes(), marco);
      await Preparacao.concluir(1, pedidoId, { operadorId: 4 }, { db, agora: T5 });
      lista = await Preparacao.listarPorMesa(1, ocupada.id, { db, agora: T20 });
      assert.equal(lista.pedidos[0].preparacao.classificacao, 'CONCLUIDO');
      assert.equal(lista.pedidos[0].preparacao.tempo_decorrido_segundos, 300);
      assert.equal(lista.pedidos[0].preparacao.concluido_em, T5);
      await rejeita(() => Preparacao.listarPorMesa(2, ocupada.id, { db }), 'MESA_NAO_ENCONTRADA');
    } finally { await close(db); }
  });

  it('recusa envio incompatível e não revela pedido de outra empresa', async () => {
    const db = await memoria();
    try {
      const ocupada = await mesa(db, 1, 1);
      const aberto = await Atendimento.abrir(1, ocupada.id, { operadorId: 8 }, { db });
      const cancelado = await semearPedido(db, {
        empresaId: 1, mesaId: ocupada.id, atendimentoId: aberto.atendimento.id,
        status: 'CANCELADO', codigo: 'PED-C', total: 20
      });
      await rejeita(() => Preparacao.enviar(1, cancelado, { operadorId: 9 }, { db }), 'PREPARACAO_ESTADO_INCOMPATIVEL');
      const fora = await semearPedido(db, {
        empresaId: 1, mesaId: null, atendimentoId: null, status: 'PEDIDO', codigo: 'BALCAO', total: 20
      });
      await rejeita(() => Preparacao.enviar(1, fora, { operadorId: 9 }, { db }), 'PEDIDO_FORA_DO_SALAO');
      await rejeita(() => Preparacao.enviar(2, cancelado, { operadorId: 9 }, { db }), 'PEDIDO_NAO_ENCONTRADO');
    } finally { await close(db); }
  });

  it('duas conexões não duplicam envio nem conclusão', async () => {
    const arquivo = path.join(dbDir, 'preparacao.db');
    const a = await open(arquivo);
    const b = await open(arquivo);
    try {
      await run(a, 'PRAGMA busy_timeout = 8000');
      await run(b, 'PRAGMA busy_timeout = 8000');
      await run(a, `CREATE TABLE pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, status TEXT, empresa_id INTEGER,
        total REAL, mesa_id INTEGER, mesa_atendimento_id INTEGER, venda_id INTEGER
      )`);
      await run(a, `CREATE TABLE pedidos_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, quantidade REAL, preco_unitario REAL, subtotal REAL
      )`);
      await garantirSchemaMesas(a);
      const ocupada = await mesa(a, 1, 1);
      const aberto = await Atendimento.abrir(1, ocupada.id, { operadorId: 8 }, { db: a });
      const pedidoId = await semearPedido(a, {
        empresaId: 1, mesaId: ocupada.id, atendimentoId: aberto.atendimento.id,
        status: 'PEDIDO', codigo: 'PED-R', total: 20
      });
      const envios = await Promise.allSettled([
        Preparacao.enviar(1, pedidoId, { operadorId: 9, idempotencyKey: 'env-race' }, { db: a }),
        Preparacao.enviar(1, pedidoId, { operadorId: 9, idempotencyKey: 'env-race' }, { db: b })
      ]);
      assert.equal(envios.filter((item) => item.status === 'rejected').length, 0);
      const gravado = await get(a, 'SELECT COUNT(*) AS total, MIN(enviado_em) AS inicio, MAX(enviado_em) AS fim FROM pedido_preparacoes WHERE pedido_id = ?', [pedidoId]);
      assert.equal(gravado.total, 1);
      assert.equal(gravado.inicio, gravado.fim);
      const conclusoes = await Promise.allSettled([
        Preparacao.concluir(1, pedidoId, { operadorId: 4, idempotencyKey: 'fim-race' }, { db: a }),
        Preparacao.concluir(1, pedidoId, { operadorId: 4, idempotencyKey: 'fim-race' }, { db: b })
      ]);
      assert.equal(conclusoes.filter((item) => item.status === 'rejected').length, 0);
      const final = await get(a, `SELECT estado, concluido_em FROM pedido_preparacoes WHERE pedido_id = ?`, [pedidoId]);
      assert.equal(final.estado, 'CONCLUIDO');
      assert.ok(final.concluido_em);
      const repetidas = conclusoes.filter((item) => item.value && item.value.repetida).length;
      assert.equal(repetidas, 1);
    } finally {
      await close(a);
      await close(b);
    }
  });
});

describe('rotas', () => {
  it('não aceita atendimento, empresa ou operador vindos do corpo', () => {
    const operacional = fs.readFileSync(path.join(__dirname, '../../backend/services/pedido/PedidoOperacionalService.js'), 'utf8');
    assert.match(operacional, /resolverParaNovoPedido/);
    assert.doesNotMatch(operacional, /body\.mesa_atendimento_id/);
    assert.doesNotMatch(operacional, /cab\.mesaAtendimentoId/);
    const pedidos = fs.readFileSync(path.join(__dirname, '../../backend/rotas/pedidos.js'), 'utf8');
    assert.match(pedidos, /router\.post\('\/:id\/preparacao\/enviar'/);
    assert.match(pedidos, /router\.post\('\/:id\/preparacao\/concluir'/);
    assert.doesNotMatch(pedidos, /body\.empresa_id/);
    assert.doesNotMatch(pedidos, /body\.operador_id/);
    assert.doesNotMatch(pedidos, /body\.mesa_atendimento_id/);
    const mesas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/mesas.js'), 'utf8');
    assert.match(mesas, /router\.get\('\/:id\/atendimento\/pedidos'/);
    const preparacao = fs.readFileSync(path.join(__dirname, '../../backend/services/pedido/PedidoPreparacaoService.js'), 'utf8');
    assert.doesNotMatch(preparacao, /UPDATE pedidos SET status/i);
    assert.doesNotMatch(preparacao, /INSERT INTO vendas/i);
  });
});
