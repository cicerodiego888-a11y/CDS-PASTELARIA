/**
 * MESAS-05.1 — abertura da mesa e lançamento na tela de Pedidos.
 *
 * Executar: node --test --test-concurrency=1 tests/erp/mesas-05-1-abertura-pedidos.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas051-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const lancamento = require('../../frontend/erp/js/mesas-lancamento.js');
const painel = require('../../frontend/erp/js/mesas-painel.js');
const sqlite3 = require('sqlite3').verbose();
const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');
const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');
const MesaService = require('../../backend/services/pedido/MesaService');
const Atendimento = require('../../backend/services/pedido/MesaAtendimentoService');
const EntradaPedido = require('../../backend/services/pedido/EntradaPedidoService');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

const AGORA = new Date('2026-11-02T12:10:00Z');
const ABERTO = '2026-11-02 12:00:00';

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

function memoria() {
  const map = new Map();
  return {
    setItem(chave, valor) { map.set(String(chave), String(valor)); },
    getItem(chave) { return map.has(String(chave)) ? map.get(String(chave)) : null; }
  };
}

function itensEmpresa() {
  return [
    { id: 1, empresa_id: 1, numero: 5, ativo: true, situacao: 'LIVRE', atendimento: null },
    {
      id: 2, empresa_id: 1, numero: 2, ativo: true, situacao: 'OCUPADA',
      atendimento: { id: 9, estado: 'OCUPADA', cliente_id: 5, operador_abertura_id: 8, aberto_em: ABERTO }
    },
    {
      id: 3, empresa_id: 1, numero: 3, ativo: true, situacao: 'FECHAMENTO',
      atendimento: { id: 10, estado: 'FECHAMENTO', cliente_id: null, operador_abertura_id: 8, aberto_em: ABERTO }
    }
  ];
}

function montar(fetchJson, extra = {}) {
  const idas = [];
  const control = painel.criarControlador({
    empresaId: 1,
    empresaRotulo: 'Pastelaria Centro',
    agora: () => AGORA,
    fetchJson,
    agendar() { return { ativo: true }; },
    cancelar() {},
    aoIrParaPedidos(ctx) { idas.push(ctx); },
    ...extra
  });
  return { control, idas };
}

describe('navegação para Pedidos', () => {
  it('mostra o nome do cliente da mesa e transfere-o para a decisão do pedido', async () => {
    const ctx = await ambiente();
    const cadastro = await run(ctx.db, 'INSERT INTO clientes (nome) VALUES (?)', ['Cliente MESAS051']);
    const clienteId = cadastro.lastID;
    const alvo = await mesa(ctx.db, ctx.a.id, 21);
    await Atendimento.abrir(ctx.a.id, alvo.id, { operadorId: 8, clienteId }, { db: ctx.db });

    const consulta = await Atendimento.consultarAtivo(ctx.a.id, alvo.id, { db: ctx.db });
    const situacao = await Atendimento.listarSituacao(ctx.a.id, { db: ctx.db });
    const item = situacao.itens.find((mesaAtual) => mesaAtual.id === alvo.id);
    assert.equal(consulta.atendimento.cliente_nome, 'Cliente MESAS051');
    assert.equal(item.atendimento.cliente_nome, 'Cliente MESAS051');

    const decisao = lancamento.decidirLancamento(consulta);
    assert.equal(decisao.cliente_id, clienteId);
    assert.equal(decisao.cliente_nome, 'Cliente MESAS051');
    assert.match(lancamento.htmlFaixa(decisao), /Cliente: Cliente MESAS051/);

    const pedidos = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/pedidos.js'),
      'utf8'
    );
    assert.match(pedidos, /clienteSelecionado = \{ id: clienteId, nome: clienteNome \}/);
    assert.match(pedidos, /#pedClienteId'\)\.val\(clienteId\)/);
    assert.match(pedidos, /#pedClienteBusca'\)\.val\(clienteNome\)/);
  });

  it('abre mesa livre, redireciona e não abre de novo ao recarregar', async () => {
    const storage = memoria();
    const posts = [];
    let situacao = itensEmpresa();
    const { control, idas } = montar(async (method, path, corpo) => {
      if (path === '/mesas/situacao') return { itens: situacao };
      if (path === '/mesas/1/atendimento' && method === 'GET') {
        const mesa = situacao.find((item) => item.id === 1);
        return { mesa_id: 1, numero: 5, situacao: mesa.situacao, atendimento: mesa.atendimento };
      }
      if (path === '/mesas/1/atendimento/pedidos') return { pedidos: [] };
      if (method === 'POST' && path === '/mesas/1/atendimento') {
        posts.push(corpo);
        situacao = situacao.map((item) => (item.id === 1 ? {
          ...item,
          situacao: 'OCUPADA',
          atendimento: { id: 15, estado: 'OCUPADA', cliente_id: null, operador_abertura_id: 8, aberto_em: ABERTO }
        } : item));
        return { atendimento: { id: 15, aberto_em: ABERTO, estado: 'OCUPADA' } };
      }
      throw new Error(method + ' ' + path);
    });
    await control.iniciar();
    await control.selecionar(1);
    const primeira = control.abrirAtendimento();
    const segunda = await control.abrirAtendimento();
    assert.deepEqual(segunda, { ok: false, ignorada: true });
    const resultado = await primeira;
    assert.equal(resultado.ok, true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].empresa_id, undefined);
    assert.equal(posts[0].operador_id, undefined);
    assert.equal(idas.length, 1);
    assert.equal(idas[0].mesaId, 1);
    assert.equal(idas[0].atendimentoId, 15);
    lancamento.gravarLancamento(storage, idas[0]);
    const recarga = lancamento.lerLancamento(storage, 1);
    const decisao = lancamento.decidirLancamento({
      mesa_id: 1,
      numero: 5,
      situacao: 'OCUPADA',
      atendimento: { id: 15, cliente_id: null, aberto_em: ABERTO }
    });
    assert.equal(recarga.mesa_id, 1);
    assert.equal(decisao.abrirEditor, true);
    assert.equal(decisao.atendimento_id, 15);
    assert.equal(posts.length, 1);
    assert.match(lancamento.htmlFaixa(decisao), /PEDIDO DA MESA 05/);
    assert.match(lancamento.htmlFaixa(decisao), /Estado OCUPADA/);
    assert.match(lancamento.htmlFaixa(decisao), /Voltar ao Controle de Mesas/);
  });

  it('recupera a mesa ocupada sem criar atendimento e bloqueia fechamento e outra empresa', async () => {
    const posts = [];
    const { control, idas } = montar(async (method, path) => {
      posts.push({ method, path });
      if (path === '/mesas/situacao') return { itens: itensEmpresa() };
      if (path === '/mesas/2/atendimento' && method === 'GET') {
        return { mesa_id: 2, numero: 2, situacao: 'OCUPADA', atendimento: itensEmpresa()[1].atendimento };
      }
      if (path === '/mesas/2/atendimento/pedidos') return { pedidos: [] };
      if (path === '/mesas/3/atendimento' && method === 'GET') {
        return { mesa_id: 3, numero: 3, situacao: 'FECHAMENTO', atendimento: itensEmpresa()[2].atendimento };
      }
      if (path === '/mesas/3/atendimento/pedidos') return { pedidos: [] };
      throw new Error(method + ' ' + path);
    });

    it('abre a lista de Pedidos sem abrir o editor de um novo pedido', () => {
      const storage = memoria();
      const salvo = lancamento.gravarLancamento(storage, {
        mesaId: 2,
        atendimentoId: 9,
        empresaId: 1,
        visualizarPedidos: true
      });
      const recuperado = lancamento.lerLancamento(storage, 1);
      assert.equal(salvo.visualizar_pedidos, true);
      assert.equal(salvo.abrir_modal, false);
      assert.equal(recuperado.visualizar_pedidos, true);
      assert.equal(lancamento.temIntencaoModal(storage, 1), false);
      lancamento.consumirVisualizacaoPedidos(storage);
      assert.equal(lancamento.lerLancamento(storage, 1).visualizar_pedidos, false);
    });
    await control.iniciar();
    await control.selecionar(2);
    const ocupada = control.lancarPedido();
    assert.equal(ocupada.ok, true);
    assert.equal(idas[0].atendimentoId, 9);
    assert.equal(posts.some((item) => item.method === 'POST'), false);

    const storage = memoria();
    lancamento.gravarLancamento(storage, { mesaId: 2, atendimentoId: 99, empresaId: 1 });
    const lido = lancamento.lerLancamento(storage, 1);
    const decisao = lancamento.decidirLancamento({
      mesa_id: 2,
      numero: 2,
      situacao: 'OCUPADA',
      atendimento: { id: 9, cliente_id: 5 }
    });
    assert.equal(lido.atendimento_id, 99);
    assert.equal(decisao.atendimento_id, 9);
    assert.match(lancamento.htmlFaixa(decisao), /Cliente nº 5/);

    await control.selecionar(3);
    const fechamento = control.lancarPedido();
    assert.equal(fechamento.codigo, 'ATENDIMENTO_EM_FECHAMENTO');
    assert.equal(idas.length, 1);
    const faixa = lancamento.decidirLancamento({
      mesa_id: 3, numero: 3, situacao: 'FECHAMENTO', atendimento: { id: 10, cliente_id: null }
    });
    assert.equal(faixa.bloqueado, true);
    assert.equal(faixa.abrirEditor, false);
    assert.match(lancamento.htmlFaixa(faixa), /fechamento/);
    assert.equal(lancamento.lerLancamento(storage, 2), null);

    const livre = painel.htmlPainel({
      empresaRotulo: 'Pastelaria Centro',
      itens: itensEmpresa(),
      mesaSelecionadaId: 3,
      detalhe: { situacao: 'FECHAMENTO', numero: 3, atendimento: itensEmpresa()[2].atendimento },
      pedidos: [],
      destinoId: '',
      clienteId: '',
      aviso: '',
      sucesso: ''
    }, AGORA);
    assert.equal(livre.includes('data-acao="lancar"'), false);
    assert.equal(livre.includes('data-acao="abrir"'), false);
  });

  it('filtra pedidos abertos vigentes pela empresa, mesa e atendimento atual', () => {
    const pedidos = [
      { id: 1, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'PEDIDO' },
      { id: 2, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'ABERTO' },
      { id: 3, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'EM_SEPARACAO' },
      { id: 4, empresa_id: 1, mesa_id: 3, mesa_atendimento_id: 9, status: 'PEDIDO' },
      { id: 5, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 10, status: 'PEDIDO' },
      { id: 6, empresa_id: 2, mesa_id: 2, mesa_atendimento_id: 9, status: 'PEDIDO' },
      { id: 7, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'FATURADO' },
      { id: 8, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'CANCELADO' },
      { id: 9, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'PEDIDO', venda_id: 71 },
      { id: 10, empresa_id: 1, mesa_id: 2, mesa_atendimento_id: 9, status: 'PEDIDO', finalizacao_confirmada: 1 }
    ];
    const filtrados = lancamento.filtrarPedidosAbertosDaMesa(pedidos, {
      empresa_id: 1,
      mesa_id: 2,
      atendimento_id: 9
    });
    assert.deepEqual(filtrados.map((pedido) => pedido.id), [1, 2, 3]);
  });

  it('informa conflito de abertura e não redireciona como sucesso', async () => {
    const { control, idas } = montar(async (method, path) => {
      if (path === '/mesas/situacao') return { itens: itensEmpresa() };
      if (path === '/mesas/1/atendimento' && method === 'GET') {
        return { mesa_id: 1, numero: 5, situacao: 'LIVRE', atendimento: null };
      }
      if (path === '/mesas/1/atendimento/pedidos') return { pedidos: [] };
      if (method === 'POST') {
        const err = new Error('ocupada');
        err.codigo = 'MESA_OCUPADA';
        throw err;
      }
      throw new Error(method + ' ' + path);
    });
    await control.iniciar();
    await control.selecionar(1);
    const resultado = await control.abrirAtendimento();
    assert.equal(resultado.ok, false);
    assert.equal(resultado.codigo, 'MESA_OCUPADA');
    assert.equal(idas.length, 0);
    assert.match(control.html(), /ocupada por outro atendimento/);
  });

  it('liga o ERP sem tratar o atendimento do navegador como autoridade', () => {
    const raiz = path.join(__dirname, '../..');
    const app = fs.readFileSync(path.join(raiz, 'frontend/erp/js/app.js'), 'utf8');
    const pedidos = fs.readFileSync(path.join(raiz, 'frontend/erp/js/pedidos.js'), 'utf8');
    const fonte = fs.readFileSync(path.join(raiz, 'frontend/erp/js/mesas-painel.js'), 'utf8');
    assert.match(app, /pedidos: \['\/erp\/js\/mesas-lancamento\.js'/);
    assert.match(pedidos, /decidirAberturaModal\(data,/);
    assert.match(pedidos, /btnPedVoltarMesas/);
    assert.match(pedidos, /mesa_id: \$\('#pedMesaId'\)/);
    assert.doesNotMatch(pedidos, /mesa_atendimento_id:/);
    assert.doesNotMatch(pedidos, /\/atendimento'/);
    assert.match(fonte, /atendimento\/encerrar/);
    assert.match(fonte, /liberarAtendimento/);
    assert.doesNotMatch(fonte, /empresa_id:/);
    assert.doesNotMatch(fonte, /operador_id:/);
  });
});

function itensDe(produtoId) {
  return [{
    produto_id: produtoId,
    quantidade: 1,
    preco_unitario: 10,
    desconto_percentual: 0,
    subtotal: 10
  }];
}

async function rejeita(fn, codigo, status) {
  await assert.rejects(fn, (err) => {
    assert.equal(err && err.codigo, codigo);
    if (status) assert.equal(err.statusCode, status);
    return true;
  });
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
    VALUES ('Pastel MESAS051', 10, 'UN', 'UN', 0, 500, 500)
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

async function mesa(db, empresaId, numero) {
  return (await MesaService.criar(empresaId, { numero }, { db })).mesa;
}

let chaveSeq = 0;
async function receber(ctx, empresaId, extra = {}) {
  const original = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;
  try {
    const body = {
      itens: itensDe(ctx.produtoId),
      total: 10,
      tipo: 'pedido',
      status: 'PEDIDO'
    };
    if (extra.mesaId !== undefined) body.mesa_id = extra.mesaId;
    if (extra.mesaAtendimentoId !== undefined) body.mesa_atendimento_id = extra.mesaAtendimentoId;
    return await EntradaPedido.receber({
      canal: EntradaPedido.CanalOrigem.EQUIPE,
      body,
      empresaId,
      operadorId: 8,
      chaveIdempotencia: `mesas051-${++chaveSeq}`
    });
  } finally {
    configService.recursoHabilitado = original;
  }
}

describe('pedido no atendimento da mesa', () => {
  it('consulta sem limite apenas os pedidos da mesa e atendimento selecionados', async () => {
    const ctx = await ambiente();
    const alvo = await mesa(ctx.db, ctx.a.id, 12);
    const outraMesa = await mesa(ctx.db, ctx.a.id, 13);
    const atendimento = await Atendimento.abrir(ctx.a.id, alvo.id, { operadorId: 8 }, { db: ctx.db });
    const primeiro = await receber(ctx, ctx.a.id, { mesaId: alvo.id });
    const encerrado = await receber(ctx, ctx.a.id, { mesaId: alvo.id });
    const atendimentoOutraMesa = await Atendimento.abrir(ctx.a.id, outraMesa.id, { operadorId: 8 }, { db: ctx.db });
    await receber(ctx, ctx.a.id, { mesaId: outraMesa.id });
    await run(ctx.db, `UPDATE pedidos SET status = 'FATURADO' WHERE id = ?`, [encerrado.pedido.id]);

    const pedidos = await PedidoRepository.listarPedidos({
      empresaId: ctx.a.id,
      mesaId: alvo.id,
      mesaAtendimentoId: atendimento.atendimento.id,
      status: 'PEDIDO,ABERTO,EM_SEPARACAO',
      db: ctx.db
    });
    assert.deepEqual(pedidos.map((pedido) => pedido.id), [primeiro.pedido.id]);
    assert.notEqual(atendimentoOutraMesa.atendimento.id, atendimento.atendimento.id);
  });

  it('reproduz o 409 sem gravar pedido e grava dois pedidos no mesmo atendimento', async () => {
    const ctx = await ambiente();
    const livre = await mesa(ctx.db, ctx.a.id, 5);
    const antes = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos');
    await rejeita(() => receber(ctx, ctx.a.id, { mesaId: livre.id }), 'ATENDIMENTO_NAO_ABERTO', 409);
    const depois = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos');
    assert.equal(depois.total, antes.total);

    const aberto = await Atendimento.abrir(ctx.a.id, livre.id, { operadorId: 8, clienteId: 4 }, { db: ctx.db });
    const primeiro = await receber(ctx, ctx.a.id, { mesaId: livre.id, mesaAtendimentoId: 999999 });
    const segundo = await receber(ctx, ctx.a.id, { mesaId: livre.id });
    assert.equal(primeiro.success, true);
    assert.notEqual(primeiro.pedido.mesa_atendimento_id, 999999);
    assert.equal(primeiro.pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.equal(segundo.pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.equal(primeiro.pedido.mesa_id, livre.id);
    const atendimento = await get(ctx.db, 'SELECT aberto_em, estado FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    assert.equal(atendimento.estado, 'OCUPADA');
    assert.equal(atendimento.aberto_em, aberto.atendimento.aberto_em);
    const quantidade = await get(ctx.db, 'SELECT COUNT(*) AS total FROM mesa_atendimentos WHERE empresa_id = ? AND mesa_id = ?', [ctx.a.id, livre.id]);
    assert.equal(quantidade.total, 1);
    const fora = await receber(ctx, ctx.a.id);
    assert.equal(fora.pedido.mesa_id, null);
    assert.equal(fora.pedido.mesa_atendimento_id, null);
  });

  it('bloqueia fechamento e outra empresa, e a transferência preserva os pedidos', async () => {
    const ctx = await ambiente();
    const origem = await mesa(ctx.db, ctx.a.id, 8);
    const destino = await mesa(ctx.db, ctx.a.id, 9);
    const aberto = await Atendimento.abrir(ctx.a.id, origem.id, { operadorId: 8 }, { db: ctx.db });
    const primeiro = await receber(ctx, ctx.a.id, { mesaId: origem.id });
    const antes = aberto.atendimento.aberto_em;
    await Atendimento.transferir(
      ctx.a.id,
      origem.id,
      { mesaDestinoId: destino.id, operadorId: 9 },
      { db: ctx.db }
    );
    const pedido = await get(ctx.db, 'SELECT mesa_id, mesa_atendimento_id FROM pedidos WHERE id = ?', [primeiro.pedido.id]);
    assert.equal(pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.equal(pedido.mesa_id, origem.id);
    const depois = await get(ctx.db, 'SELECT aberto_em, mesa_id FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    assert.equal(depois.aberto_em, antes);
    assert.equal(depois.mesa_id, destino.id);
    const novo = await receber(ctx, ctx.a.id, { mesaId: destino.id });
    assert.equal(novo.pedido.mesa_atendimento_id, aberto.atendimento.id);
    assert.equal(novo.pedido.mesa_id, destino.id);

    const fechamento = await mesa(ctx.db, ctx.a.id, 10);
    const emFechamento = await Atendimento.abrir(ctx.a.id, fechamento.id, { operadorId: 8 }, { db: ctx.db });
    await run(ctx.db, `UPDATE mesa_atendimentos SET estado = 'FECHAMENTO' WHERE id = ?`, [emFechamento.atendimento.id]);
    const antesPedidos = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos');
    await rejeita(() => receber(ctx, ctx.a.id, { mesaId: fechamento.id }), 'ATENDIMENTO_EM_FECHAMENTO', 409);
    const outra = await mesa(ctx.db, ctx.b.id, 8);
    await Atendimento.abrir(ctx.b.id, outra.id, { operadorId: 8 }, { db: ctx.db });
    await rejeita(() => receber(ctx, ctx.a.id, { mesaId: outra.id }), 'MESA_NAO_ENCONTRADA', 404);
    const apos = await get(ctx.db, 'SELECT COUNT(*) AS total FROM pedidos');
    assert.equal(apos.total, antesPedidos.total);
  });
});
