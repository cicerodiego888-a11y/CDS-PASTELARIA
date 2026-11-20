/**
 * MESAS-05.2 — conferência e envio explícito à preparação.
 *
 * Executar: node --test --test-concurrency=1 tests/erp/mesas-05-2-envio-preparacao.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mesas052-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const conferenciaApi = require('../../frontend/erp/js/mesas-conferencia.js');
const Preparacao = require('../../backend/services/pedido/PedidoPreparacaoService');
const EntradaPedido = require('../../backend/services/pedido/EntradaPedidoService');
const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
const Atendimento = require('../../backend/services/pedido/MesaAtendimentoService');
const MesaService = require('../../backend/services/pedido/MesaService');
const configService = require('../../backend/services/configuracaoService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaMesas } = require('../../backend/utils/mesasSchema');

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

function adiar() {
  let resolver;
  const promise = new Promise((resolve) => { resolver = resolve; });
  return { promise, resolver };
}

function pedidoSalao(extra = {}) {
  return {
    id: 40,
    codigo: 'PED-40',
    status: 'PEDIDO',
    mesa_id: 5,
    mesa_numero: 5,
    mesa_atendimento_id: 9,
    observacao: 'sem cebola',
    total: 30,
    itens: [{ produto_nome: 'Pastel de carne', quantidade: 2, preco_unitario: 99, subtotal: 198 }],
    ...extra
  };
}

function criar(fetchJson, extra = {}) {
  let n = 0;
  return conferenciaApi.criarConferencia({
    novaChave: () => `chave-${++n}`,
    fetchJson,
    ...extra
  });
}

describe('conferência na tela', () => {
  it('salva e finaliza sem enviar, e a conferência usa o pedido persistido', () => {
    const chamadas = [];
    const control = criar((method, path) => {
      chamadas.push({ method, path });
      return {};
    });
    assert.equal(conferenciaApi.fluxoDoPedido({ id: 1 }), 'legado');
    assert.equal(conferenciaApi.fluxoDoPedido(pedidoSalao()), 'salao');
    assert.equal(conferenciaApi.metodoPersistencia(null), 'POST');
    assert.equal(conferenciaApi.metodoPersistencia(40), 'PUT');
    const primeira = control.finalizar(pedidoSalao());
    const segunda = control.finalizar(pedidoSalao());
    assert.equal(primeira.enviado, false);
    assert.equal(segunda.pedidoId, 40);
    assert.equal(chamadas.length, 0);
    const html = control.html();
    assert.match(html, /Conferência do pedido/);
    assert.match(html, /Mesa 5/);
    assert.match(html, /PED-40/);
    assert.match(html, /Pastel de carne/);
    assert.match(html, /quantidade 2/);
    assert.match(html, /sem cebola/);
    assert.match(html, /Total 30/);
    assert.equal(html.includes('Total 198'), false);
    assert.match(html, /Enviar ao KDS e iniciar preparação/);
    assert.match(html, /Corrigir lançamento/);
    assert.equal(html.includes('Enviado para preparação'), false);
  });

  it('envia só na confirmação, ignora o segundo clique e não reinicia o horário', async () => {
    const chamadas = [];
    const control = criar(async (method, path, chave) => {
      chamadas.push({ method, path, chave });
      return {
        success: true,
        preparacao: {
          estado: 'EM_PREPARACAO',
          classificacao: 'NORMAL',
          enviado_em: '2026-11-02 12:00:00',
          tempo_decorrido_segundos: 0
        },
        despacho: {
          success: true,
          status: 'CONCLUIDO',
          unidade_id: 3,
          rodada_id: 9
        }
      };
    });
    control.finalizar(pedidoSalao());
    const primeiro = control.enviar();
    const segundo = await control.enviar();
    assert.equal(segundo.ignorada, true);
    const resultado = await primeiro;
    assert.equal(resultado.ok, true);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].path, '/pedidos/40/preparacao/enviar');
    assert.equal(chamadas[0].chave, 'chave-1');
    assert.match(control.html(), /Pedido enviado ao KDS/);
    assert.match(control.html(), /2026-11-02 12:00:00/);
    assert.match(control.html(), /NORMAL/);
    assert.match(control.html(), /KDS:<\/strong> Enviado ao KDS/);
    assert.equal(control.html().includes('data-acao="enviar"'), false);
    const repetido = await control.enviar();
    assert.equal(repetido.codigo, 'DESPACHO_JA_CONCLUIDO');
    assert.equal(chamadas.length, 1);
    assert.equal(control.estado.preparacao.enviado_em, '2026-11-02 12:00:00');
    const correcao = control.corrigir();
    assert.equal(correcao.ok, false);
  });

  it('mantém a preparação ERP e permite reprocessar KDS após bloqueio', async () => {
    let tentativas = 0;
    const control = criar(async () => {
      tentativas += 1;
      return {
        success: true,
        preparacao: {
          estado: 'EM_PREPARACAO',
          classificacao: 'NORMAL',
          enviado_em: '2026-11-02 12:10:00'
        },
        despacho: tentativas === 1
          ? {
            success: false,
            status: 'BLOQUEADO',
            codigo: 'DESPACHO_REQUER_RESOLVIDO',
            mensagem: 'Destino pendente.'
          }
          : {
            success: true,
            status: 'CONCLUIDO',
            unidade_id: 3,
            rodada_id: 10
          }
      };
    });
    control.finalizar(pedidoSalao());

    const primeira = await control.enviar();
    assert.equal(primeira.ok, false);
    assert.equal(control.estado.preparacao.estado, 'EM_PREPARACAO');
    assert.equal(control.podeEnviar().ok, true);
    assert.match(control.html(), /Preparação ERP registrada/);
    assert.match(control.html(), /KDS:<\/strong> Bloqueado/);
    assert.match(control.html(), /DESPACHO_REQUER_RESOLVIDO/);
    assert.match(control.html(), /Reprocessar envio ao KDS/);

    const retry = await control.enviar();
    assert.equal(retry.ok, true);
    assert.equal(retry.despacho.status, 'CONCLUIDO');
    assert.equal(tentativas, 2);
    assert.match(control.html(), /Pedido enviado ao KDS/);
    assert.equal(control.html().includes('data-acao="enviar"'), false);
  });

  it('permite corrigir antes do envio e trata falha, resposta inválida e troca de tela', async () => {
    const editavel = criar(async () => {
      throw new Error('não deveria enviar');
    });
    editavel.finalizar(pedidoSalao());
    const correcao = editavel.corrigir();
    assert.equal(correcao.ok, true);
    assert.equal(correcao.pedidoId, 40);
    assert.equal(editavel.html(), '');

    const rede = criar(async () => {
      const err = new Error('falhou');
      err.rede = true;
      throw err;
    });
    rede.finalizar(pedidoSalao());
    const falha = await rede.enviar();
    assert.equal(falha.ok, false);
    assert.equal(falha.codigo, 'REDE');
    assert.equal(rede.estado.sucesso, '');
    assert.equal(rede.estado.pedido.id, 40);
    assert.match(rede.html(), /pedido foi preservado/);
    assert.equal(rede.html().includes('alert-success'), false);

    const invalida = criar(async () => ({ success: true }));
    invalida.finalizar(pedidoSalao());
    const ruim = await invalida.enviar();
    assert.equal(ruim.codigo, 'RESPOSTA_INVALIDA');
    assert.equal(invalida.estado.sucesso, '');
    assert.equal(invalida.estado.etapa, 'conferencia');

    const pendente = adiar();
    const troca = criar(() => pendente.promise);
    troca.finalizar(pedidoSalao());
    const envio = troca.enviar();
    troca.parar();
    pendente.resolver({
      preparacao: { estado: 'EM_PREPARACAO', enviado_em: '2026-11-02 12:04:00', classificacao: 'NORMAL' }
    });
    const resultado = await envio;
    assert.equal(resultado.obsoleta, true);
    assert.equal(troca.estado.sucesso, '');
    assert.notEqual(troca.estado.etapa, 'enviado');
  });

  it('bloqueia na tela o envio incompatível e preserva o fluxo sem mesa', async () => {
    const chamadas = [];
    const control = criar((method, path) => {
      chamadas.push(path);
      return {};
    });
    for (const status of ['CANCELADO', 'ORCAMENTO']) {
      control.finalizar(pedidoSalao({ status }));
      const resultado = await control.enviar();
      assert.equal(resultado.codigo, 'PREPARACAO_ESTADO_INCOMPATIVEL');
      assert.equal(control.estado.sucesso, '');
    }
    control.finalizar(pedidoSalao({ mesa_atendimento_id: null }));
    const semVinculo = await control.enviar();
    assert.equal(semVinculo.codigo, 'PEDIDO_FORA_DO_SALAO');
    assert.equal(chamadas.length, 0);
    const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
    const modulo = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/mesas-conferencia.js'), 'utf8');
    const mobile = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-pedido/mobile-pedido.js'), 'utf8');
    assert.match(fonte, /A preparação ainda não foi acionada/);
    assert.match(fonte, /if \(salao && conferencia\)/);
    assert.match(fonte, /btnPedFinalizar/);
    assert.match(fonte, /conferencia\.enviar/);
    assert.match(modulo, /preparacao\/enviar/);
    assert.match(mobile, /mesa_id: estado\.mesaId \? Number\(estado\.mesaId\) : null/);
    assert.doesNotMatch(mobile, /mesa_atendimento_id:/);
  });

  it('permite enviar pedido faturado sem despacho, sem permitir edição', async () => {
    let chamadas = 0;
    const control = criar(async () => {
      chamadas += 1;
      return {
        preparacao: { estado: 'EM_PREPARACAO', enviado_em: '2026-11-02 12:10:00' },
        despacho: { success: false, status: 'BLOQUEADO', codigo: 'SCHEMA_COMANDA_INDISPONIVEL', mensagem: 'Migration ausente.' }
      };
    }, {
      listarPedidos: async () => ({ pedidos: [{ id: 40, despacho: { status: null, codigo: null } }] })
    });

    it('preserva a conferência anterior quando a consulta da mesa falha', async () => {
      const control = criar(async () => ({}));
      control.finalizar(pedidoSalao());
      const antes = control.html();
      let faixa;
      const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
      const inicio = fonte.indexOf('async function consultarPedidoDaMesa');
      const fim = fonte.indexOf('async function aplicarLancamentoDaMesa', inicio);
      assert.ok(inicio >= 0 && fim > inicio);
      const contexto = {
        window: { CdsMesasConferencia: conferenciaApi },
        cdsConsultaPedidoSeq: 0,
        conferencia: control,
        requisitarMesas: async () => { throw new Error('Rede indisponível'); },
        pintarFaixaMesa: (valor) => { faixa = valor; }
      };
      const consultar = vm.runInNewContext(`(${fonte.slice(inicio, fim).trim()})`, contexto);
      await consultar({ mesa_id: 8, pedido_id: 41 });
      assert.equal(control.html(), antes);
      assert.match(faixa.mensagem, /conferência anterior foi mantida/);
    });
    control.finalizar(pedidoSalao({ status: 'FATURADO' }));
    assert.match(control.html(), /data-acao="enviar"/);
    assert.doesNotMatch(control.html(), /data-acao="corrigir"/);
    const resposta = await control.enviar();
    assert.equal(resposta.ok, false);
    assert.equal(chamadas, 1);
    assert.equal(control.estado.pedido.status, 'FATURADO');
    assert.equal(control.estado.pedido.despacho.status, 'BLOQUEADO');
    assert.match(control.html(), /SCHEMA_COMANDA_INDISPONIVEL/);
    assert.match(control.html(), /Migration ausente/);
    assert.doesNotMatch(control.html(), /Pedido enviado ao KDS/);
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

async function comModulo(fn) {
  const original = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;
  try {
    return await fn();
  } finally {
    configService.recursoHabilitado = original;
  }
}

async function rejeita(fn, codigo) {
  await assert.rejects(fn, (err) => {
    assert.equal(err && err.codigo, codigo);
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
  const prod = await run(db, `
    INSERT INTO produtos (nome, preco_venda, unidade, unidade_estoque, utiliza_conversao, saldo_fiscal, estoque_atual)
    VALUES ('Pastel MESAS052', 10, 'UN', 'UN', 0, 500, 500)
  `);
  await EstoqueEmpresaService.criarRegistro({
    produtoId: prod.lastID,
    empresaId: a.id,
    saldo_fiscal: 500,
    saldo_nao_fiscal: 0,
    estoque_atual: 500,
    reservado_fiscal: 0
  }, { db });
  return { db, produtoId: prod.lastID, a };
}

let chaveSeq = 0;
async function receber(ctx, extra = {}) {
  return comModulo(() => EntradaPedido.receber({
    canal: EntradaPedido.CanalOrigem.EQUIPE,
    body: {
      itens: itensDe(ctx.produtoId),
      total: 10,
      tipo: 'pedido',
      status: 'PEDIDO',
      observacao: extra.observacao || null,
      ...(extra.mesaId !== undefined ? { mesa_id: extra.mesaId } : {})
    },
    empresaId: ctx.a.id,
    operadorId: 8,
    chaveIdempotencia: `mesas052-${++chaveSeq}`
  }));
}

describe('envio no atendimento', () => {
  it('não envia ao salvar, repete o horário e mantém o atendimento para o pedido seguinte', async () => {
    const ctx = await ambiente();
    const mesa = (await MesaService.criar(ctx.a.id, { numero: 5 }, { db: ctx.db })).mesa;
    const aberto = await Atendimento.abrir(ctx.a.id, mesa.id, { operadorId: 8 }, { db: ctx.db });
    const primeiro = await receber(ctx, { mesaId: mesa.id, observacao: 'sem cebola' });
    const prepInicial = await get(ctx.db, 'SELECT estado, enviado_em FROM pedido_preparacoes WHERE pedido_id = ?', [primeiro.pedido.id]);
    assert.equal(prepInicial.estado, 'NAO_ENVIADO');
    assert.equal(prepInicial.enviado_em, null);
    const editado = await comModulo(() => PedidoOperacional.atualizar(primeiro.pedido.id, {
      itens: itensDe(ctx.produtoId),
      total: 10,
      mesa_id: mesa.id,
      observacao: 'corrigido'
    }, { empresaId: ctx.a.id, db: ctx.db }));
    assert.equal(editado.pedido.id, primeiro.pedido.id);
    const prepEditada = await get(ctx.db, 'SELECT estado, enviado_em FROM pedido_preparacoes WHERE pedido_id = ?', [primeiro.pedido.id]);
    assert.equal(prepEditada.estado, 'NAO_ENVIADO');
    assert.equal(prepEditada.enviado_em, null);

    const envio = await Preparacao.enviar(ctx.a.id, primeiro.pedido.id, { operadorId: 8, idempotencyKey: 'envio-1' }, { db: ctx.db });
    const repetido = await Preparacao.enviar(ctx.a.id, primeiro.pedido.id, { operadorId: 8, idempotencyKey: 'envio-1' }, { db: ctx.db });
    assert.equal(repetido.repetida, true);
    assert.equal(repetido.preparacao.enviado_em, envio.preparacao.enviado_em);
    assert.equal(repetido.preparacao.estado, 'EM_PREPARACAO');
    const atendimento = await get(ctx.db, 'SELECT aberto_em, estado FROM mesa_atendimentos WHERE id = ?', [aberto.atendimento.id]);
    assert.equal(atendimento.estado, 'OCUPADA');
    assert.equal(atendimento.aberto_em, aberto.atendimento.aberto_em);

    const segundo = await receber(ctx, { mesaId: mesa.id });
    assert.equal(segundo.pedido.id !== primeiro.pedido.id, true);
    assert.equal(segundo.pedido.mesa_atendimento_id, aberto.atendimento.id);
    const lista = await Preparacao.listarPorMesa(ctx.a.id, mesa.id, { db: ctx.db });
    const porId = new Map(lista.pedidos.map((item) => [item.id, item]));
    assert.equal(porId.get(primeiro.pedido.id).preparacao.estado, 'EM_PREPARACAO');
    assert.equal(porId.get(primeiro.pedido.id).preparacao.enviado_em, envio.preparacao.enviado_em);
    assert.equal(porId.get(segundo.pedido.id).preparacao.estado, 'NAO_ENVIADO');
    const vendas = await get(ctx.db, 'SELECT COUNT(*) AS total FROM vendas');
    assert.equal(vendas.total, 0);
    const fora = await receber(ctx);
    assert.equal(fora.pedido.mesa_atendimento_id, null);
    await rejeita(
      () => Preparacao.enviar(ctx.a.id, fora.pedido.id, { operadorId: 8, idempotencyKey: 'fora' }, { db: ctx.db }),
      'PEDIDO_FORA_DO_SALAO'
    );
  });

  it('aceita faturado e recusa cancelado e mesa em fechamento', async () => {
    const ctx = await ambiente();
    const mesa = (await MesaService.criar(ctx.a.id, { numero: 8 }, { db: ctx.db })).mesa;
    const aberto = await Atendimento.abrir(ctx.a.id, mesa.id, { operadorId: 8 }, { db: ctx.db });
    const cancelado = await receber(ctx, { mesaId: mesa.id });
    await run(ctx.db, `UPDATE pedidos SET status = 'CANCELADO' WHERE id = ?`, [cancelado.pedido.id]);
    await rejeita(
      () => Preparacao.enviar(ctx.a.id, cancelado.pedido.id, { operadorId: 8, idempotencyKey: 'canc' }, { db: ctx.db }),
      'PREPARACAO_ESTADO_INCOMPATIVEL'
    );
    const faturado = await receber(ctx, { mesaId: mesa.id });
    await run(ctx.db, `UPDATE pedidos SET status = 'FATURADO' WHERE id = ?`, [faturado.pedido.id]);
    const faturadoEnviado = await Preparacao.enviar(ctx.a.id, faturado.pedido.id, { operadorId: 8, idempotencyKey: 'fat' }, { db: ctx.db });
    assert.equal(faturadoEnviado.preparacao.estado, 'EM_PREPARACAO');
    assert.equal((await get(ctx.db, 'SELECT status FROM pedidos WHERE id = ?', [faturado.pedido.id])).status, 'FATURADO');
    const abertoAinda = await receber(ctx, { mesaId: mesa.id });
    await run(ctx.db, `UPDATE mesa_atendimentos SET estado = 'FECHAMENTO' WHERE id = ?`, [aberto.atendimento.id]);
    await rejeita(
      () => Preparacao.enviar(ctx.a.id, abertoAinda.pedido.id, { operadorId: 8, idempotencyKey: 'fecha' }, { db: ctx.db }),
      'ATENDIMENTO_EM_FECHAMENTO'
    );
    const prep = await get(ctx.db, 'SELECT estado, enviado_em FROM pedido_preparacoes WHERE pedido_id = ?', [abertoAinda.pedido.id]);
    assert.equal(prep.estado, 'NAO_ENVIADO');
    assert.equal(prep.enviado_em, null);
  });
});
