/**
 * S07-1 painel KDS e controles operacionais de preparação.
 * Banco isolado. Sem impressão física.
 *
 * Executar:
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   node --test --test-concurrency=1 tests/cozinha/sprint07-s07-1-painel-kds-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_TEST_ISOLATION = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const kds = require('../../frontend/erp/js/cozinha-kds.js');

const AGORA = new Date('2026-11-17T21:10:00-03:00');

function fixtureRodadas() {
  return [
    {
      id: 10,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 2,
      mesa_numero: '5',
      atendimento_id: 9,
      numero_rodada: 1,
      sequencia_global: 2,
      estado_preparacao: 'EM_PREPARACAO',
      enviada_em: '2026-11-17 20:58:00',
      created_at: '2026-11-17 20:58:00',
      itens: [
        {
          id: 101,
          numero_comanda: 44,
          tipo_item: 'PASTEL',
          estado_preparacao: 'AGUARDANDO',
          sequencia_global: 2,
          qty_solicitada: '2',
          produto_nome_snapshot: 'Pastel de carne',
          observacoes_snapshot: 'Sem cebola'
        },
        {
          id: 102,
          numero_comanda: 44,
          tipo_item: 'BEBIDA',
          estado_preparacao: 'EM_PREPARACAO',
          sequencia_global: 3,
          qty_solicitada: '1',
          produto_nome_snapshot: 'Refrigerante 200ml',
          observacoes_snapshot: null
        }
      ]
    },
    {
      id: 11,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 1,
      mesa_numero: '1',
      atendimento_id: 8,
      numero_rodada: 2,
      sequencia_global: 1,
      estado_preparacao: 'AGUARDANDO',
      enviada_em: '2026-11-17 20:55:00',
      created_at: '2026-11-17 20:55:00',
      itens: [
        {
          id: 201,
          numero_comanda: 12,
          tipo_item: 'PASTEL',
          estado_preparacao: 'AGUARDANDO',
          sequencia_global: 1,
          qty_solicitada: '3',
          produto_nome_snapshot: 'Pastel de queijo',
          observacoes_snapshot: 'Bem passado'
        }
      ]
    },
    {
      id: 12,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 7,
      mesa_numero: '07',
      atendimento_id: 15,
      numero_rodada: 3,
      sequencia_global: 3,
      estado_preparacao: 'PRONTA',
      operador_envio_id: 6,
      enviada_em: '2026-11-17 20:50:00',
      rodada_pronta_em: '2026-11-17 21:00:00',
      retirada_estado: 'PENDENTE',
      created_at: '2026-11-17 20:50:00',
      itens: [
        {
          id: 301,
          numero_comanda: 99,
          tipo_item: 'OUTRO',
          estado_preparacao: 'PRONTO',
          sequencia_global: 4,
          qty_solicitada: '1.5',
          produto_nome_snapshot: 'Porção batata',
          observacoes_snapshot: '',
          pronto_em: '2026-11-17 20:49:00',
          operador_pronto_id: 7
        }
      ]
    }
  ];
}

function adiar() {
  let resolver;
  let rejeitar;
  const promise = new Promise((resolve, reject) => {
    resolver = resolve;
    rejeitar = reject;
  });
  return { promise, resolver, rejeitar };
}

function montar(fetchJson, extra = {}) {
  const fila = [];
  const control = kds.criarControlador({
    empresaId: 1,
    empresaRotulo: 'Pastelaria Centro',
    agora: () => AGORA,
    intervaloMs: 5000,
    // S07-2: painel só inicia com JWT contextualizado.
    lerUnidadeJwt: () => 3,
    fetchJson,
    agendar(fn, ms) {
      const item = { fn, ms, ativo: true };
      fila.push(item);
      return item;
    },
    cancelar(item) { if (item) item.ativo = false; },
    ...extra
  });
  return { control, fila };
}

describe('S07-1 — distribuição e FIFO', () => {
  it('distribui cartões por estado do item e ordena FIFO', () => {
    const dist = kds.distribuirPorEstado(fixtureRodadas());
    assert.equal(dist.AGUARDANDO.length, 2);
    assert.equal(dist.EM_PREPARACAO.length, 1);
    assert.equal(dist.PRONTO.length, 1);
    // FIFO: sequencia_global 1 antes de 2
    assert.equal(dist.AGUARDANDO[0].id, 11);
    assert.equal(dist.AGUARDANDO[1].id, 10);
    assert.equal(dist.AGUARDANDO[0].itens[0].produto_nome_snapshot, 'Pastel de queijo');
    assert.equal(dist.EM_PREPARACAO[0].itens[0].produto_nome_snapshot, 'Refrigerante 200ml');
    assert.deepEqual(kds.contadores(dist), {
      AGUARDANDO: 2,
      EM_PREPARACAO: 1,
      PRONTO: 1
    });
  });

  it('renderiza cabeçalho, colunas, itens e observações', () => {
    const dist = kds.distribuirPorEstado(fixtureRodadas());
    const html = kds.htmlPainel({
      empresaId: 1,
      empresaRotulo: 'Pastelaria Centro',
      unidadeId: 3,
      rodadas: fixtureRodadas(),
      distribuicao: dist,
      carregando: false,
      erro: '',
      ultimaAtualizacao: AGORA
    }, AGORA);
    assert.match(html, /Cozinha/);
    assert.match(html, /\(KDS\)/);
    assert.match(html, /Pastelaria Centro/);
    assert.match(html, /Unidade #3/);
    assert.match(html, /Aguardando/);
    assert.match(html, /Em preparação/);
    assert.match(html, /Prontos/);
    assert.match(html, /Pastel de carne/);
    assert.match(html, /Sem cebola/);
    assert.match(html, /Bem passado/);
    assert.match(html, /Mesa 05|Mesa 5/);
    assert.match(html, /Comanda 44/);
    assert.match(html, /data-acao="atualizar"/);
    assert.match(html, /data-acao="trocar-unidade"/);
    assert.match(html, /Trocar unidade/);
    assert.match(html, /data-acao="iniciar-preparo"/);
    assert.match(html, /INICIAR PREPARO/);
    assert.match(html, /data-acao="marcar-pronto"/);
    assert.match(html, /MARCAR COMO PRONTO/);
    assert.match(html, /Concluído às/);
    assert.match(html, /Operador #7/);
    assert.match(html, /CDS Sistemas/);
    assert.match(html, /Tempo total/);
    assert.match(html, /Espera do garçom/);
    assert.match(html, /data-acao="confirmar-retirada"/);
    assert.match(html, /CONFIRMAR RETIRADA/);
    assert.match(html, /Responsável #6/);
    assert.doesNotMatch(html, /dual-write/i);
  });

  it('oferece retorno somente para item em preparação e atualiza o painel sem confirmação', async () => {
    const rodadas = fixtureRodadas();
    const rodada = rodadas.find((r) => r.id === 10);
    rodada.retirada_estado = 'PENDENTE';
    const item = rodada.itens.find((i) => i.id === 102);
    item.iniciado_em = '2026-11-17 21:00:00';
    item.operador_inicio_id = 8;
    const chamadas = [];
    const confirmacoes = [];
    const { control } = montar(async (method, path, body) => {
      chamadas.push({ method, path, body });
      if (method === 'GET') return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
      return {
        success: true, operador_id: 8,
        item: { id: 102, estado_preparacao: 'AGUARDANDO' },
        rodada: { id: 10, estado_preparacao: 'AGUARDANDO' }
      };
    }, {
      confirmar: (mensagem) => { confirmacoes.push(mensagem); return true; },
      gerarChaveIdempotencia: (acao, id) => `teste:${acao}:${id}`
    });
    await control.iniciar();
    assert.match(control.html(), /data-acao="voltar-aguardando" data-item-id="102"/);
    assert.doesNotMatch(control.html(), /data-acao="voltar-aguardando" data-item-id="101"/);
    assert.equal((await control.operarItem(102, 'voltar')).ok, true);
    const post = chamadas.find((chamada) => chamada.method === 'POST');
    assert.equal(post.path, '/cozinha/itens/102/aguardando');
    assert.equal(post.body.idempotency_key, 'teste:voltar:102');
    assert.deepEqual(confirmacoes, []);
    assert.equal(item.estado_preparacao, 'AGUARDANDO');
    assert.equal(item.iniciado_em, null);
    assert.equal(item.operador_inicio_id, null);
    assert.equal(rodada.itens.find((i) => i.id === 101).estado_preparacao, 'AGUARDANDO');
    assert.doesNotMatch(control.html(), /data-acao="voltar-aguardando" data-item-id="102"/);
  });

  it('apresenta retirados e histórico separado de cancelados com tempos encerrados', async () => {
    const rodadas = fixtureRodadas();
    const retirada = rodadas.find((r) => r.id === 12);
    retirada.retirada_estado = 'RETIRADA';
    retirada.retirada_em = '2026-11-17T21:10:00Z';
    retirada.retirada_por = 7;
    const cancelada = {
      ...rodadas[0], estado_preparacao: 'CANCELADA', retirada_estado: 'PENDENTE',
      cancelamento_motivo: 'OUTRO', cancelamento_justificativa: 'Faltou massa',
      cancelamento_por: 8, cancelamento_em: '2026-11-17T21:04:00Z',
      cancelamento_etapa: 'EM_PREPARACAO',
      itens: [{
        ...rodadas[0].itens[1], estado_preparacao: 'CANCELADO',
        estado_anterior: 'EM_PREPARACAO', iniciado_em: '2026-11-17T21:00:00Z',
        cancelamento_motivo: 'OUTRO', cancelamento_justificativa: 'Faltou massa',
        cancelamento_por: 8, cancelamento_etapa: 'EM_PREPARACAO',
        cancelamento_em: '2026-11-17T21:04:00Z', qty_preparada: '0', qty_cancelada: '0'
      }]
    };
    const { control } = montar(async () => ({
      success: true, empresa_id: 1, unidade_id: 3, rodadas: [rodadas[1]],
      historico_retirados: { rodadas: [retirada], total: 1 },
      historico_cancelados: { rodadas: [cancelada], total: 1 }
    }));
    await control.iniciar();
    assert.match(control.html(), /data-coluna="RETIRADO"/);
    assert.match(control.html(), /Retirada confirmada às 21:10:00 UTC/);
    assert.match(control.html(), /Retirado na rodada às 21:10:00 UTC/);
    assert.match(control.html(), /Responsável #7/);
    assert.doesNotMatch(control.html(), /Faltou massa/);
    await control.alternarHistoricoCancelados();
    const html = control.html();
    assert.match(html, /data-coluna="CANCELADO"/);
    assert.match(html, /Faltou massa/);
    assert.match(html, /Estado anterior: EM_PREPARACAO/);
    assert.match(html, /Operador: #8/);
    assert.match(html, /17\/11\/2026 21:04:00 UTC/);
    const tempos = kds.calcularTemposItem(control.estado.cancelados[0], control.estado.cancelados[0].itens[0], AGORA);
    assert.equal(tempos.chegadaFim, '2026-11-17T21:04:00Z');
    assert.equal(tempos.preparoFim, '2026-11-17T21:04:00Z');
    assert.equal(tempos.preparo, 240);
  });

  it('envia motivo e justificativa nas rotas distintas de cancelamento', async () => {
    const rodadas = fixtureRodadas();
    rodadas[0].retirada_estado = 'PENDENTE';
    rodadas[1].retirada_estado = 'PENDENTE';
    const respostas = [
      { motivo: 'OUTRO', justificativa: 'Motivo detalhado' },
      { motivo: 'FALTA_PRODUTO', justificativa: '' }
    ];
    const posts = [];
    const { control } = montar(async (method, path, body) => {
      if (method === 'GET') return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
      posts.push({ path, body });
      if (path.includes('/itens/')) {
        return { success: true, item: { id: 102, estado_preparacao: 'CANCELADO' },
          rodada: { id: 10, estado_preparacao: 'AGUARDANDO' } };
      }
      return { success: true, rodada: { id: 11, estado_preparacao: 'CANCELADA' } };
    }, {
      solicitarCancelamento: () => respostas.shift(),
      gerarChaveIdempotencia: (tipo, id) => `${tipo}:${id}`
    });
    await control.iniciar();
    assert.equal((await control.cancelarItem(102)).ok, true);
    assert.equal((await control.cancelarRodada(11)).ok, true);
    assert.deepEqual(posts, [
      { path: '/cozinha/itens/102/cancelar', body: { idempotency_key: 'cancelamento-item:102', motivo: 'OUTRO', justificativa: 'Motivo detalhado' } },
      { path: '/cozinha/rodadas/11/cancelar', body: { idempotency_key: 'cancelamento-rodada:11', motivo: 'FALTA_PRODUTO', justificativa: null } }
    ]);
  });

  it('impede envio duplicado enquanto o formulário está aberto e aborta ao mudar de unidade', async () => {
    const rodadas = fixtureRodadas();
    rodadas[1].retirada_estado = 'PENDENTE';
    const dialogo = adiar();
    const posts = [];
    const { control } = montar(async (method) => {
      if (method === 'POST') posts.push(method);
      return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
    }, { solicitarCancelamento: () => dialogo.promise });
    await control.iniciar();
    const primeira = control.cancelarRodada(11);
    assert.equal((await control.cancelarRodada(11)).sobreposta, true);
    control.estado.unidadeId = 4;
    dialogo.resolver({ motivo: 'FALTA_PRODUTO' });
    assert.ok((await primeira).erro);
    assert.match(control.estado.feedback, /contexto da cozinha mudou/i);
    assert.equal(posts.length, 0);
  });

  it('apresenta erro se o formulário falhar ou retornar motivo inválido', async () => {
    const rodadas = fixtureRodadas();
    rodadas[1].retirada_estado = 'PENDENTE';
    let resposta = () => { throw new Error('Falha ao abrir formulário'); };
    const posts = [];
    const { control } = montar(async (method) => {
      if (method === 'POST') posts.push(method);
      return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
    }, { solicitarCancelamento: () => resposta() });
    await control.iniciar();
    assert.ok((await control.cancelarRodada(11)).erro);
    assert.match(control.estado.feedback, /Falha ao abrir formulário/);
    resposta = () => ({ motivo: 'OUTRO', justificativa: '  ' });
    assert.ok((await control.cancelarRodada(11)).erro);
    assert.match(control.estado.feedback, /Justificativa obrigatória/);
    resposta = () => ({ motivo: 'INVALIDO' });
    assert.ok((await control.cancelarRodada(11)).erro);
    assert.match(control.estado.feedback, /Motivo inválido/);
    resposta = () => null;
    assert.equal((await control.cancelarRodada(11)).cancelada, true);
    assert.equal(posts.length, 0);
  });

  it('não envia cancelamento se a rodada for retirada enquanto o formulário estiver aberto', async () => {
    const rodadas = fixtureRodadas();
    rodadas[1].retirada_estado = 'PENDENTE';
    const dialogo = adiar();
    const posts = [];
    const { control } = montar(async (method) => {
      if (method === 'POST') posts.push(method);
      return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
    }, { solicitarCancelamento: () => dialogo.promise });
    await control.iniciar();
    const cancelamento = control.cancelarRodada(11);
    control.estado.rodadas.find((rodada) => rodada.id === 11).retirada_estado = 'RETIRADA';
    dialogo.resolver({ motivo: 'FALTA_PRODUTO' });
    assert.ok((await cancelamento).erro);
    assert.match(control.estado.feedback, /não está mais disponível/);
    assert.equal(posts.length, 0);
  });

  it('oferece formulário próprio com validação, fechamento e justificativa', async () => {
    function elemento() {
      const listeners = {};
      return {
        value: '', textContent: '', listeners,
        addEventListener(tipo, fn) { listeners[tipo] = fn; },
        focus() {},
        disparar(tipo) { listeners[tipo]({ preventDefault() {} }); }
      };
    }
    const form = elemento();
    const motivo = elemento();
    const justificativa = elemento();
    const erro = elemento();
    const voltar = elemento();
    const dialogo = {
      ...elemento(),
      setAttribute() {},
      querySelector(seletor) {
        return {
          form, '#kds-cancelamento-motivo': motivo,
          '#kds-cancelamento-justificativa': justificativa,
          '.kds-dialogo-cancelamento__erro': erro, '[data-acao="fechar"]': voltar
        }[seletor];
      },
      showModal() { this.open = true; },
      close() { this.open = false; },
      remove() { this.removido = true; }
    };
    const global = { document: { createElement: () => dialogo, body: { appendChild() {} } } };
    const solicitador = kds.criarSolicitadorCancelamento(global);
    const resultado = solicitador.solicitar('rodada');
    assert.match(dialogo.innerHTML, /Cancelar rodada/);
    assert.match(dialogo.innerHTML, /FALTA_PRODUTO/);
    form.disparar('submit');
    assert.match(erro.textContent, /Selecione um motivo/);
    motivo.value = 'OUTRO';
    form.disparar('submit');
    assert.match(erro.textContent, /Informe a justificativa/);
    justificativa.value = '  Justificativa  ';
    form.disparar('submit');
    assert.deepEqual(await resultado, { motivo: 'OUTRO', justificativa: 'Justificativa' });
    assert.equal(dialogo.removido, true);
    const cancelado = solicitador.solicitar('item');
    assert.match(dialogo.innerHTML, /Cancelar item/);
    voltar.disparar('click');
    assert.equal(await cancelado, null);
    const encerrado = solicitador.solicitar('rodada');
    solicitador.fechar();
    assert.equal(await encerrado, null);
  });

  it('associa um único clique de cancelamento de item independentemente das rodadas exibidas', async () => {
    let quantidadeRodadas = 2;
    let raiz;
    function botao(id) {
      return {
        listeners: [],
        addEventListener(_tipo, fn) { this.listeners.push(fn); },
        getAttribute() { return String(id); }
      };
    }
    const host = {
      set innerHTML(_html) {
        const botoesRodada = Array.from({ length: quantidadeRodadas }, (_, i) => botao(i + 10));
        const botaoItem = botao(101);
        raiz = {
          botaoItem,
          querySelector() { return null; },
          querySelectorAll(seletor) {
            if (seletor === '[data-acao="cancelar-rodada"]') return botoesRodada;
            if (seletor === '[data-acao="cancelar-item"]') return [botaoItem];
            return [];
          }
        };
      },
      querySelector(seletor) { return seletor === '[data-painel-kds]' ? raiz : null; },
      querySelectorAll() { return []; }
    };
    const token = `x.${Buffer.from(JSON.stringify({ unidade_cozinha_id: 3 })).toString('base64')}.x`;
    const global = {
      document: { getElementById: () => host },
      localStorage: { getItem: () => token },
      fetch: async () => ({ ok: true, json: async () => ({
        success: true, empresa_id: 1, unidade_id: 3, rodadas: fixtureRodadas()
      }) }),
      setTimeout: () => 1,
      clearTimeout() {}
    };
    const control = kds.montarNoNavegador(global);
    await control.iniciar(host);
    const chamadas = [];
    control.cancelarItem = (id) => chamadas.push(id);
    assert.equal(raiz.botaoItem.listeners.length, 1);
    raiz.botaoItem.listeners[0]();
    quantidadeRodadas = 0;
    await control.atualizar();
    assert.equal(raiz.botaoItem.listeners.length, 1);
    raiz.botaoItem.listeners[0]();
    assert.deepEqual(chamadas, ['101', '101']);
    control.parar();
  });
  it('atualiza o histórico depois do cancelamento da própria rodada', async () => {
    const rodada = fixtureRodadas()[1];
    rodada.retirada_estado = 'PENDENTE';
    const item = rodada.itens[0];
    let cancelada = false;
    const chamadas = [];
    const { control } = montar(async (method, path) => {
      chamadas.push({ method, path });
      if (method === 'POST') {
        cancelada = true;
        return { success: true, rodada: { id: rodada.id, estado_preparacao: 'CANCELADA' } };
      }
      const visivel = cancelada && !path.includes('cursor_cancelados=antigo');
      return {
        success: true, empresa_id: 1, unidade_id: 3, rodadas: cancelada ? [] : [rodada],
        historico_cancelados: {
          rodadas: visivel ? [{ ...rodada, estado_preparacao: 'CANCELADA',
            cancelamento_evento: { motivo: 'FALTA_PRODUTO', item_ids: [item.id] },
            itens: [{ ...item, estado_preparacao: 'CANCELADO', pedido_id: 42 }] }] : [],
          total: visivel ? 1 : 0, cursor_atual: visivel ? 'novo' : 'antigo'
        }
      };
    }, { solicitarCancelamento: () => ({ motivo: 'FALTA_PRODUTO' }) });
    await control.iniciar();
    assert.equal((await control.cancelarRodada(rodada.id)).ok, true);
    assert.doesNotMatch(chamadas[chamadas.length - 1].path, /cursor_cancelados=antigo/);
    await control.alternarHistoricoCancelados();
    assert.match(control.html(), /Cancelamento da rodada/);
    assert.match(control.html(), /Pedido #42/);
    control.parar();
  });

  it('permite paginar separadamente os históricos de retirada e cancelamento', async () => {
    const chamadas = [];
    const { control } = montar(async (method, path) => {
      chamadas.push(path);
      return {
        success: true, empresa_id: 1, unidade_id: 3, rodadas: [],
        historico_retirados: { rodadas: [], total: 201, cursor_atual: 'ret-atual', cursor_proximo: 'ret-proximo' },
        historico_cancelados: { rodadas: [], total: 101, cursor_atual: 'can-atual', cursor_proximo: 'can-proximo' }
      };
    });
    await control.iniciar();
    await control.mudarPaginaHistorico('retirados', 1);
    assert.match(chamadas[1], /cursor_retirados=ret-proximo/);
    assert.match(chamadas[1], /cursor_cancelados=can-atual/);
    await control.mudarPaginaHistorico('cancelados', 1);
    assert.match(chamadas[2], /cursor_retirados=ret-atual/);
    assert.match(chamadas[2], /cursor_cancelados=can-proximo/);
    assert.match(control.html(), /Página 2 · 201 rodadas no snapshot/);
    await control.mudarPaginaHistorico('retirados', -1);
    assert.match(chamadas[3], /cursor_retirados=ret-atual/);
    await control.atualizarHistoricos();
    assert.doesNotMatch(chamadas[4], /cursor_retirados|cursor_cancelados/);
  });

  it('ao abrir cancelados inicia novo snapshot sem alterar o de retirados', async () => {
    let novoCancelamento = false;
    const chamadas = [];
    const registro = {
      ...fixtureRodadas()[1],
      estado_preparacao: 'CANCELADA',
      retirada_estado: 'PENDENTE',
      itens: [{ ...fixtureRodadas()[1].itens[0], estado_preparacao: 'CANCELADO',
        pedido_id: 42, cancelamento_motivo: 'FALTA_PRODUTO' }]
    };
    const { control } = montar(async (_method, path) => {
      chamadas.push(path);
      const cursorAntigo = path.includes('cursor_cancelados=antigo');
      const visivel = novoCancelamento && !cursorAntigo;
      return {
        success: true, empresa_id: 1, unidade_id: 3, rodadas: [],
        historico_retirados: { rodadas: [], cursor_atual: 'ret-atual' },
        historico_cancelados: {
          rodadas: visivel ? [registro] : [],
          total: visivel ? 1 : 0,
          cursor_atual: visivel ? 'novo' : 'antigo'
        }
      };
    });
    await control.iniciar();
    novoCancelamento = true;
    await control.atualizar();
    assert.equal(control.estado.cancelados.length, 0);
    await control.alternarHistoricoCancelados();
    assert.match(chamadas[chamadas.length - 1], /cursor_retirados=ret-atual/);
    assert.doesNotMatch(chamadas[chamadas.length - 1], /cursor_cancelados=/);
    assert.match(control.html(), /Pedido #42/);
    assert.match(control.html(), /FALTA_PRODUTO/);
    await control.atualizar();
    assert.match(chamadas[chamadas.length - 1], /cursor_cancelados=novo/);
    control.parar();
  });

  it('descarta resposta do snapshot antigo ao abrir cancelados durante uma atualização', async () => {
    const antiga = adiar();
    const nova = adiar();
    let chamadas = 0;
    const base = { success: true, empresa_id: 1, unidade_id: 3, rodadas: [] };
    const { control } = montar(async () => {
      chamadas += 1;
      if (chamadas === 1) return {
        ...base, historico_cancelados: { rodadas: [], cursor_atual: 'antigo' }
      };
      return chamadas === 2 ? antiga.promise : nova.promise;
    });
    await control.iniciar();
    const poll = control.atualizar();
    await control.alternarHistoricoCancelados();
    const obsoleto = {
      ...fixtureRodadas()[1],
      itens: [{ ...fixtureRodadas()[1].itens[0], estado_preparacao: 'CANCELADO' }]
    };
    antiga.resolver({ ...base, historico_cancelados: { rodadas: [obsoleto], total: 1, cursor_atual: 'antigo' } });
    await poll;
    assert.equal(control.estado.cancelados.length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chamadas, 3);
    nova.resolver({ ...base, historico_cancelados: { rodadas: [obsoleto], total: 1, cursor_atual: 'novo' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(control.estado.cancelados.length, 1);
    assert.equal(control.estado.paginasCancelados.cursores[0], 'novo');
    control.parar();
  });
  it('apresenta histórico legado separado, com lacunas e paginação própria', async () => {
    const chamadas = [];
    const registro = {
      id: 8, mesa_numero: '4', numero_rodada: 2, estado_preparacao: 'CANCELADA',
      enviada_em: '2026-01-01T20:00:00Z', retirada_estado: 'PENDENTE',
      cancelamento_sem_evento: 1, cancelamento_motivo: 'OUTRO',
      cancelamento_justificativa: 'Somente na rodada', cancelamento_por: 7,
      cancelamento_em: '2026-01-01T20:10:00Z', cancelamento_etapa: 'EM_PREPARACAO',
      itens: [{ id: 99, numero_comanda: 11, pedido_id: 42, produto_nome_snapshot: 'Pastel',
        tipo_item: 'PASTEL', estado_preparacao: 'CANCELADO', qty_solicitada: '2',
        qty_preparada: '0', qty_cancelada: '0', motivo_cancelamento: 'FALTA_PRODUTO',
        operador_cancelamento_id: 3, cancelamento_em: '2026-01-01T20:05:00Z',
        cancelamento_sem_evento: 1, cancelamento_justificativa: null, eventos_preparacao: [] }]
    };
    const { control } = montar(async (_method, path) => {
      chamadas.push(path);
      if (path.includes('historico=legado')) {
        return { registros: [registro], cursor_atual: 'leg-atual', cursor_proximo: 'leg-proximo' };
      }
      return { empresa_id: 1, unidade_id: 3, rodadas: [] };
    });
    await control.iniciar();
    assert.equal(chamadas.some((path) => path.includes('historico=legado')), false);
    await control.alternarHistoricoLegado();
    const html = control.html();
    assert.match(html, /Histórico legado/);
    assert.match(html, /Cancelamento da rodada — evento ausente/);
    assert.match(html, /Cancelamento do item — evento ausente/);
    assert.match(html, /Justificativa: Somente na rodada/);
    assert.match(html, /Justificativa: Não disponível/);
    assert.match(html, /Espera: Não reconstruível/);
    assert.match(html, /Preparação: Não reconstruível/);
    assert.match(html, /Total: 00:10:00/);
    const semEventos = kds.htmlPainel({ mostrarLegado: true, paginasLegado: { indice: 0 },
      rodadas: [], legado: [{ ...registro, retirada_estado: 'RETIRADA',
        retirada_em: '2026-01-01T20:14:00Z', itens: [{ ...registro.itens[0],
          estado_preparacao: 'AGUARDANDO', cancelamento_sem_evento: 0, eventos_preparacao: [] }] }] }, AGORA);
    assert.match(semEventos, /Espera: Não reconstruível/);
    assert.match(semEventos, /Preparação: Não reconstruível/);
    await control.mudarPaginaHistorico('legado', 1);
    assert.match(chamadas[chamadas.length - 1], /historico=legado.*cursor=leg-proximo/);
    await control.atualizarHistoricos();
    assert.doesNotMatch(chamadas[chamadas.length - 1], /cursor=/);
    control.parar();
  });

  it('mantém o painel ativo quando a consulta do legado falha', async () => {
    const { control } = montar(async (_method, path) => {
      if (path.includes('historico=legado')) throw new Error('Falha no histórico legado');
      return { empresa_id: 1, unidade_id: 3, rodadas: fixtureRodadas() };
    });
    await control.iniciar();
    await control.alternarHistoricoLegado();
    assert.equal(control.estado.erro, '');
    assert.match(control.html(), /Falha no histórico legado/);
    assert.ok(control.estado.rodadas.length);
    control.parar();
  });

  it('cronometra garçom ativo e congela retirada sem sobrepor períodos', () => {
    const card = { enviada_em: '2026-01-01T20:00:00Z', rodada_pronta_em: '2026-01-01T20:12:00Z',
      retirada_estado: 'PENDENTE' };
    const eventos = [
      { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:02:00Z' },
      { tipo: 'PREPARACAO_REVERTIDA', em: '2026-01-01T20:05:00Z' },
      { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:08:00Z' },
      { tipo: 'ITEM_PRONTO', em: '2026-01-01T20:12:00Z' }
    ];
    const item = { estado_preparacao: 'PRONTO', eventos_preparacao: eventos };
    const aguardando = kds.calcularTemposItem(card, item, new Date('2026-01-01T20:13:00Z'));
    assert.equal(aguardando.esperaGarcom, 60);
    assert.equal(aguardando.esperaGarcomAtiva, true);
    assert.equal(aguardando.espera, 300);
    assert.equal(aguardando.preparo, 420);
    assert.equal(aguardando.espera + aguardando.preparo, 12 * 60);
    const retirado = { ...card, retirada_estado: 'RETIRADA', retirada_em: '2026-01-01T20:14:00Z' };
    for (const instante of ['2026-01-01T20:14:00Z', '2026-01-01T21:00:00Z']) {
      const tempos = kds.calcularTemposItem(retirado, item, new Date(instante));
      assert.equal(tempos.esperaGarcom, 120);
      assert.equal(tempos.esperaGarcomAtiva, false);
      assert.equal(tempos.espera, 300);
      assert.equal(tempos.preparo, 420);
      assert.equal(tempos.chegada, 840);
    }
    const paralelo = kds.calcularTemposItem(retirado, { estado_preparacao: 'PRONTO',
      eventos_preparacao: [
        { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:01:00Z' },
        { tipo: 'ITEM_PRONTO', em: '2026-01-01T20:09:00Z' }
      ] }, new Date('2026-01-01T21:00:00Z'));
    assert.equal(paralelo.espera, 60);
    assert.equal(paralelo.preparo, 480);
    assert.equal(paralelo.chegada, 840);
    for (const eventosInvalidos of [
      eventos.slice(1),
      [eventos[0], eventos[0], eventos[3]],
      [eventos[0], { tipo: 'PREPARACAO_REVERTIDA', em: '2026-01-01T20:01:00Z' }, eventos[2], eventos[3]]
    ]) {
      const tempos = kds.calcularTemposItem(retirado,
        { ...item, eventos_preparacao: eventosInvalidos }, new Date('2026-01-01T21:00:00Z'));
      assert.equal(tempos.periodos.valido, false);
      assert.equal(tempos.espera, null);
      assert.equal(tempos.preparo, null);
    }
  });

  it('soma tentativas, congela retirada e identifica lacunas nos eventos', () => {
    const card = { enviada_em: '2026-01-01T20:00:00Z', rodada_pronta_em: '2026-01-01T20:12:00Z',
      retirada_estado: 'RETIRADA', retirada_em: '2026-01-01T20:15:00Z' };
    const eventos = [
      { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:02:00Z' },
      { tipo: 'PREPARACAO_REVERTIDA', em: '2026-01-01T20:05:00Z' },
      { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:08:00Z' },
      { tipo: 'ITEM_PRONTO', em: '2026-01-01T20:12:00Z' }
    ];
    const item = { estado_preparacao: 'PRONTO', eventos_preparacao: eventos };
    const tempos = kds.calcularTemposItem(card, item, new Date('2026-01-01T21:00:00Z'));
    assert.equal(tempos.espera, 300);
    assert.equal(tempos.preparo, 420);
    assert.equal(tempos.chegada, 900);
    assert.equal(tempos.esperaGarcom, 180);
    const aguardando = kds.calcularTemposItem({ ...card, retirada_estado: 'PENDENTE', retirada_em: null },
      { estado_preparacao: 'AGUARDANDO', eventos_preparacao: eventos.slice(0, 2) },
      new Date('2026-01-01T20:07:00Z'));
    assert.equal(aguardando.espera, 240);
    assert.equal(aguardando.preparo, 180);
    const ativo = kds.calcularTemposItem({ ...card, retirada_estado: 'PENDENTE', retirada_em: null },
      { ...item, estado_preparacao: 'EM_PREPARACAO', eventos_preparacao: eventos.slice(0, 3) },
      new Date('2026-01-01T20:10:00Z'));
    assert.equal(ativo.espera, 300);
    assert.equal(ativo.preparo, 300);
    const elemento = {
      textContent: '',
      getAttribute(nome) {
        return { 'data-inicio': '2026-01-01T20:08:00Z', 'data-fim': '', 'data-base-ms': '180000' }[nome];
      }
    };
    kds.atualizarCronometros({ querySelectorAll: () => [elemento] }, Date.parse('2026-01-01T20:10:00Z'));
    assert.equal(elemento.textContent, '00:05:00');
    const cancelado = kds.calcularTemposItem({
      ...card, retirada_estado: 'PENDENTE', historico_cancelamento: true, cancelamento_em: '2026-01-01T20:10:00Z'
    }, { estado_preparacao: 'CANCELADO', eventos_preparacao: [
      ...eventos.slice(0, 3), { tipo: 'ITEM_CANCELADO', em: '2026-01-01T20:10:00Z', estado_anterior: 'EM_PREPARACAO' }
    ] }, new Date('2026-01-01T21:00:00Z'));
    assert.equal(cancelado.espera, 300);
    assert.equal(cancelado.preparo, 300);
    const faltante = kds.calcularTemposItem(card,
      { estado_preparacao: 'PRONTO', eventos_preparacao: eventos.slice(1) }, new Date('2026-01-01T21:00:00Z'));
    assert.equal(faltante.preparo, null);
    assert.equal(faltante.periodos.valido, false);
    const anteriorAusente = kds.calcularTemposItem({
      enviada_em: '2026-01-01T20:00:00Z', historico_cancelamento: true,
      cancelamento_em: '2026-01-01T20:05:00Z'
    }, { estado_preparacao: 'CANCELADO', eventos_preparacao: [
      { tipo: 'ITEM_CANCELADO', em: '2026-01-01T20:05:00Z', estado_anterior: 'EM_PREPARACAO' }
    ] }, new Date('2026-01-01T21:00:00Z'));
    assert.equal(anteriorAusente.espera, null);
    assert.equal(anteriorAusente.preparo, null);
    const fracionado = kds.calcularTemposItem({ enviada_em: '2026-01-01T20:00:00Z' }, {
      estado_preparacao: 'PRONTO', eventos_preparacao: [
        { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:00:00.100Z' },
        { tipo: 'PREPARACAO_REVERTIDA', em: '2026-01-01T20:00:01.000Z' },
        { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:00:01.100Z' },
        { tipo: 'ITEM_PRONTO', em: '2026-01-01T20:00:02.000Z' }
      ]
    }, new Date('2026-01-01T21:00:00Z'));
    assert.equal(fracionado.preparo, 1);
    const rodadaRenderizada = { ...fixtureRodadas()[2], ...card, itens: [{
      ...fixtureRodadas()[2].itens[0], ...item
    }] };
    const html = kds.htmlPainel({ rodadas: [rodadaRenderizada],
      distribuicao: kds.distribuirPorEstado([rodadaRenderizada]) }, new Date('2026-01-01T21:00:00Z'));
    assert.match(html, /00:07:00/);
    assert.match(html, /00:05:00/);
    const paralelo = kds.calcularTemposItem(card, {
      estado_preparacao: 'PRONTO', eventos_preparacao: [
        { tipo: 'PREPARACAO_INICIADA', em: '2026-01-01T20:01:00Z' },
        { tipo: 'ITEM_PRONTO', em: '2026-01-01T20:09:00Z' }
      ]
    }, new Date('2026-01-01T21:00:00Z'));
    assert.equal(paralelo.preparo, 480);
    assert.equal(paralelo.chegada, 900);
  });

  it('mantém justificativas e retirada identificadas por evento', async () => {
    const rodada = {
      ...fixtureRodadas()[0], estado_preparacao: 'CANCELADA', retirada_estado: 'PENDENTE',
      cancelamento_justificativa: 'Justificativa da rodada',
      cancelamento_evento: { id: 20, motivo: 'OUTRO', justificativa: 'Justificativa da rodada',
        operador_id: 8, em: '2026-11-17T21:05:00Z', etapa: 'EM_PREPARACAO', item_ids: [102] },
      itens: [
        { ...fixtureRodadas()[0].itens[0], estado_preparacao: 'CANCELADO',
          cancelamento_motivo: 'FALTA_PRODUTO', cancelamento_justificativa: null,
          cancelamento_em: '2026-11-17T21:01:00Z', cancelamento_por: 7, cancelamento_etapa: 'AGUARDANDO' },
        { ...fixtureRodadas()[0].itens[1], estado_preparacao: 'CANCELADO',
          cancelamento_motivo: 'OUTRO', cancelamento_justificativa: 'Justificativa da rodada',
          cancelamento_em: '2026-11-17T21:05:00Z', cancelamento_por: 8, cancelamento_etapa: 'EM_PREPARACAO' }
      ]
    };
    const { control } = montar(async () => ({ success: true, rodadas: [],
      historico_retirados: { rodadas: [], total: 0 }, historico_cancelados: { rodadas: [rodada], total: 1 } }));
    await control.iniciar();
    const itemAntigo = control.estado.cancelados.find((c) => c.historico_tipo === 'item' && c.itens[0].id === 101);
    assert.equal(itemAntigo.cancelamento_justificativa, null);
    const eventoRodada = control.estado.cancelados.find((c) => c.historico_tipo === 'rodada');
    assert.equal(eventoRodada.cancelamento_justificativa, 'Justificativa da rodada');
    rodada.retirada_estado = 'RETIRADA';
    rodada.retirada_em = '2026-11-17T21:10:00Z';
    rodada.cancelamento_evento = null;
    await control.atualizarHistoricos();
    await control.alternarHistoricoCancelados();
    assert.match(control.html(), /item cancelado não retirado/);
    assert.doesNotMatch(control.html(), /Retirada confirmada às/);
  });

  it('calcula durações usando timestamps UTC sem somar tempos paralelos', () => {
    assert.equal(kds.formatarHora('2026-11-17 20:58:00'), '20:58:00');
    assert.equal(kds.formatarHora('2026-11-17T17:58:00-03:00'), '20:58:00');
    assert.equal(kds.segundosEntre(
      '2026-11-17 20:00:00',
      '2026-11-17 20:05:00'
    ), 300);
    assert.equal(kds.formatarDuracao(7322), '02:02:02');

    const tempos = kds.calcularTemposItem({
      enviada_em: '2026-11-17 20:00:00',
      rodada_pronta_em: '2026-11-17 20:20:00',
      retirada_estado: 'RETIRADA',
      retirada_em: '2026-11-17 20:24:00'
    }, {
      estado_preparacao: 'PRONTO',
      iniciado_em: '2026-11-17 20:05:00',
      pronto_em: '2026-11-17 20:15:00'
    }, new Date('2026-11-17T20:25:00Z'));
    assert.equal(tempos.chegada, 1440);
    assert.equal(tempos.espera, 300);
    assert.equal(tempos.preparo, 600);
    assert.equal(tempos.esperaGarcom, 240);
    assert.equal(kds.calcularTemposItem({
      created_at: '2026-11-17 20:00:00'
    }, {
      estado_preparacao: 'AGUARDANDO'
    }, new Date('2026-11-17T20:05:00Z')).chegada, null);
  });

  it('renderiza uma única ação de retirada por rodada com vários estados de item', () => {
    const rodadas = fixtureRodadas();
    rodadas.find((rodada) => rodada.id === 12).itens.push({
      id: 302,
      numero_comanda: 99,
      tipo_item: 'BEBIDA',
      estado_preparacao: 'AGUARDANDO',
      qty_solicitada: '1',
      produto_nome_snapshot: 'Suco',
      observacoes_snapshot: null
    });
    const html = kds.htmlPainel({
      empresaId: 1,
      unidadeId: 3,
      rodadas,
      carregando: false,
      erro: ''
    }, AGORA);
    assert.equal(
      [...html.matchAll(/data-acao="confirmar-retirada" data-rodada-id="12"/g)].length,
      1
    );
  });

  it('estado vazio exibe mensagem por coluna', () => {
    const html = kds.htmlPainel({
      empresaRotulo: 'X',
      unidadeId: 1,
      rodadas: [],
      distribuicao: kds.distribuirPorEstado([]),
      carregando: false,
      erro: '',
      ultimaAtualizacao: AGORA
    }, AGORA);
    assert.match(html, /Nenhum pedido/);
  });
});

describe('S07-1 — consumo API e atualização', () => {
  it('carrega painel via GET /cozinha/preparacao/painel', async () => {
    const chamadas = [];
    const { control, fila } = montar(async (method, path) => {
      chamadas.push({ method, path });
      return {
        success: true,
        empresa_id: 1,
        unidade_id: 3,
        total: 3,
        limite: 100,
        offset: 0,
        ordenacao: 'FIFO_SEQUENCIA_GLOBAL',
        rodadas: fixtureRodadas()
      };
    });
    await control.iniciar();
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].method, 'GET');
    assert.match(chamadas[0].path, /^\/cozinha\/preparacao\/painel\?/);
    assert.match(chamadas[0].path, /limite=100/);
    assert.equal(control.estado.unidadeId, 3);
    assert.equal(control.estado.rodadas.length, 3);
    assert.equal(control.estado.distribuicao.AGUARDANDO.length, 2);
    assert.ok(fila.length >= 1);
    assert.equal(fila[0].ms, 5000);
  });

  it('inicia e conclui sem confirmação e atualiza o painel', async () => {
    let rodadas = fixtureRodadas();
    const chamadas = [];
    const confirmacoes = [];
    const { control } = montar(async (method, path, body) => {
      chamadas.push({ method, path, body });
      if (method === 'GET') {
        return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
      }
      if (path.endsWith('/iniciar')) {
        rodadas = fixtureRodadas();
        const item = rodadas.find((r) => r.id === 11).itens[0];
        item.estado_preparacao = 'EM_PREPARACAO';
        item.iniciado_em = '2026-11-17 21:00:00';
        item.operador_inicio_id = 8;
        return {
          success: true,
          operador_id: 8,
          iniciado_em: item.iniciado_em,
          item: { id: 201, estado_preparacao: 'EM_PREPARACAO' },
          rodada: { id: 11, estado_preparacao: 'EM_PREPARACAO' }
        };
      }
      rodadas = fixtureRodadas();
      const item = rodadas.find((r) => r.id === 11).itens[0];
      item.estado_preparacao = 'PRONTO';
      item.pronto_em = '2026-11-17 21:05:00';
      item.operador_pronto_id = 9;
      return {
        success: true,
        operador_id: 9,
        pronto_em: item.pronto_em,
        item: { id: 201, estado_preparacao: 'PRONTO', pronto_em: item.pronto_em },
        rodada: { id: 11, estado_preparacao: 'PRONTA' }
      };
    }, {
      confirmar: (mensagem) => {
        confirmacoes.push(mensagem);
        return true;
      },
      gerarChaveIdempotencia: (acao, itemId) => `teste:${acao}:${itemId}`
    });

    await control.iniciar();
    const inicio = await control.operarItem(201, 'iniciar');
    assert.equal(inicio.ok, true);
    assert.deepEqual(confirmacoes, []);
    assert.equal(control.estado.distribuicao.AGUARDANDO.length, 1);
    assert.equal(control.estado.distribuicao.EM_PREPARACAO.length, 2);
    assert.match(control.html(), /MARCAR COMO PRONTO/);
    const chamadaInicio = chamadas.find((c) => c.path.endsWith('/iniciar'));
    assert.equal(chamadaInicio.method, 'POST');
    assert.equal(chamadaInicio.body.idempotency_key, 'teste:iniciar:201');

    const pronto = await control.operarItem(201, 'pronto');
    assert.equal(pronto.ok, true);
    assert.equal(control.estado.distribuicao.EM_PREPARACAO.length, 1);
    assert.equal(control.estado.distribuicao.PRONTO.length, 2);
    assert.match(control.html(), /Concluído às/);
    assert.match(control.html(), /Operador #9/);
    assert.match(control.html(), /Item marcado como pronto/);
    assert.equal(chamadas.filter((c) => c.method === 'GET').length, 3);
    assert.deepEqual(confirmacoes, []);
  });

  it('conclusão e retirada ocorrem sem solicitar confirmação', async () => {
    const rodadas = fixtureRodadas();
    const posts = [];
    const confirmacoes = [];
    const { control } = montar(async (method, path, body) => {
      if (method === 'GET') return { success: true, empresa_id: 1, unidade_id: 3, rodadas };
      posts.push({ path, body });
      if (path.endsWith('/pronto')) {
        const item = rodadas.find((r) => r.id === 10).itens.find((i) => i.id === 102);
        item.estado_preparacao = 'PRONTO';
        return { success: true, item: { id: 102, estado_preparacao: 'PRONTO' } };
      }
      const rodada = rodadas.find((r) => r.id === 12);
      rodada.retirada_estado = 'RETIRADA';
      rodada.retirada_em = '2026-11-17 21:10:00';
      rodada.retirada_por = 7;
      return { success: true, rodada: {
        id: 12, estado_preparacao: 'PRONTA', retirada_estado: 'RETIRADA',
        retirada_em: rodada.retirada_em, retirada_por: 7
      } };
    }, {
      confirmar: mensagem => { confirmacoes.push(mensagem); return false; },
      gerarChaveIdempotencia: (acao, id) => `teste:${acao}:${id}`
    });

    await control.iniciar();
    assert.equal((await control.operarItem(102, 'pronto')).ok, true);
    assert.equal((await control.confirmarRetirada(12)).ok, true);
    assert.deepEqual(posts.map((post) => post.path), [
      '/cozinha/itens/102/pronto', '/cozinha/rodadas/12/retirada'
    ]);
    assert.equal(posts[1].body.idempotency_key, 'teste:retirada:12');
    assert.deepEqual(confirmacoes, []);
    assert.equal(control.estado.distribuicao.RETIRADO[0].retirada_estado, 'RETIRADA');
    assert.equal(control.estado.distribuicao.RETIRADO[0].retirada_por, 7);
  });

  it('ignora clique duplo enquanto a operação está em curso', async () => {
    const pendente = adiar();
    let posts = 0;
    const { control } = montar(async (method) => {
      if (method === 'GET') {
        return { success: true, empresa_id: 1, unidade_id: 3, rodadas: fixtureRodadas() };
      }
      posts += 1;
      return pendente.promise;
    }, { confirmar: () => true });
    await control.iniciar();
    const primeira = control.operarItem(201, 'iniciar');
    const segunda = await control.operarItem(201, 'iniciar');
    assert.equal(segunda.sobreposta, true);
    assert.equal(posts, 1);
    assert.match(control.html(), /PROCESSANDO/);
    pendente.resolver({
      success: true,
      operador_id: 8,
      iniciado_em: '2026-11-17 21:00:00',
      item: { id: 201, estado_preparacao: 'EM_PREPARACAO' },
      rodada: { id: 11, estado_preparacao: 'EM_PREPARACAO' }
    });
    const resultado = await primeira;
    assert.equal(resultado.ok, true);
    assert.equal(posts, 1);
  });

  it('atualização manual dispara novo GET', async () => {
    let n = 0;
    const { control } = montar(async () => {
      n += 1;
      return {
        success: true,
        empresa_id: 1,
        unidade_id: 3,
        total: 0,
        rodadas: n === 1 ? fixtureRodadas() : []
      };
    });
    await control.iniciar();
    await control.atualizar({ silencioso: false });
    assert.equal(n, 2);
    assert.equal(control.estado.rodadas.length, 0);
  });

  it('evita sobreposição de requisições', async () => {
    const pendente = adiar();
    let iniciadas = 0;
    const { control } = montar(() => {
      iniciadas += 1;
      return pendente.promise;
    });
    control.estado.ativo = true;
    const p1 = control.atualizar({ silencioso: false });
    const p2 = control.atualizar({ silencioso: true });
    const r2 = await p2;
    assert.equal(r2.ignorada, true);
    assert.equal(r2.sobreposta, true);
    assert.equal(iniciadas, 1);
    pendente.resolver({
      success: true,
      empresa_id: 1,
      unidade_id: 3,
      rodadas: []
    });
    await p1;
  });

  it('em erro preserva últimos dados válidos', async () => {
    let n = 0;
    const { control } = montar(async () => {
      n += 1;
      if (n === 1) {
        return {
          success: true,
          empresa_id: 1,
          unidade_id: 3,
          rodadas: fixtureRodadas()
        };
      }
      const err = new Error('Rede indisponível');
      err.codigo = 'REDE';
      throw err;
    });
    await control.iniciar();
    assert.equal(control.estado.rodadas.length, 3);
    const r = await control.atualizar({ silencioso: true });
    assert.ok(r.erro);
    assert.equal(r.preservouDados, true);
    assert.equal(control.estado.rodadas.length, 3);
    assert.match(control.estado.erro, /Rede indisponível/);
    const html = control.html();
    assert.match(html, /Pastel de carne/);
    assert.match(html, /Falha na atualização|Rede indisponível/);
  });

  it('poll automático usa intervalo de 5s', async () => {
    const { control, fila } = montar(async () => ({
      success: true,
      empresa_id: 1,
      unidade_id: 3,
      rodadas: []
    }));
    await control.iniciar();
    assert.equal(fila[0].ms, kds.INTERVALO_MS);
    assert.equal(kds.INTERVALO_MS, 5000);
    control.parar();
    assert.equal(fila[0].ativo, false);
  });

  it('parar impede redesenho posterior (não invade outra página)', async () => {
    let mudancas = 0;
    const { control } = montar(async () => ({
      success: true,
      empresa_id: 1,
      unidade_id: 3,
      rodadas: []
    }), {
      aoMudar: () => { mudancas += 1; }
    });
    await control.iniciar();
    const antes = mudancas;
    control.parar();
    control.definirUnidadeSelecionada(1);
    assert.equal(mudancas, antes, 'aoMudar não deve disparar com painel parado');
  });

  it('voltarParaSelecao para o poll e exibe tela de unidades', async () => {
    const chamadas = [];
    const { control, fila } = montar(async (method, path) => {
      chamadas.push({ method, path });
      if (String(path).includes('unidades-disponiveis')) {
        return { success: true, unidades: [{ id: 3, codigo: 'UA' }, { id: 7, codigo: 'UB' }] };
      }
      return {
        success: true,
        empresa_id: 1,
        unidade_id: 3,
        rodadas: []
      };
    });
    await control.iniciar();
    assert.equal(control.estado.modo, 'painel');
    assert.ok(fila.some((f) => f.ativo));
    await control.voltarParaSelecao();
    assert.equal(control.estado.modo, 'selecao');
    assert.ok(fila.every((f) => f.ativo === false));
    assert.ok(chamadas.some((c) => String(c.path).includes('/cozinha/unidades-disponiveis')));
    assert.match(control.html(), /data-painel-kds-selecao|Confirmar unidade|kds-selecao/);
  });
});

describe('S07-1 — registro no ERP (sem tocar S06/PDV)', () => {
  it('menu, scripts, ACL e catálogo apontam para cozinha-kds', () => {
    const raiz = path.resolve(__dirname, '../..');
    const indexHtml = fs.readFileSync(path.join(raiz, 'frontend/erp/index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(raiz, 'frontend/erp/js/app.js'), 'utf8');
    const acl = fs.readFileSync(path.join(raiz, 'frontend/shared/js/access-control.js'), 'utf8');
    const core = fs.readFileSync(path.join(raiz, 'frontend/shared/js/core.js'), 'utf8');
    assert.match(indexHtml, /data-page="cozinha-kds"/);
    assert.match(indexHtml, /cozinha-kds\.css/);
    assert.match(appJs, /'cozinha-kds':\s*\['\/erp\/js\/cozinha-kds\.js'\]/);
    assert.match(appJs, /case 'cozinha-kds'/);
    assert.match(appJs, /loadCozinhaKds/);
    assert.match(acl, /'cozinha-kds':\s*'vendas'/);
    assert.match(core, /page:\s*'cozinha-kds'/);
    assert.match(core, /p === 'cozinha-kds'/);
  });

  it('ações usam as rotas KDS existentes e não acessam impressão S06', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/cozinha-kds.js'),
      'utf8'
    );
    assert.match(src, /\/cozinha\/itens\/\$\{itemId\}\/\$\{operacao\.caminho\}/);
    assert.match(src, /data-acao="iniciar-preparo"/);
    assert.match(src, /data-acao="marcar-pronto"/);
    assert.doesNotMatch(src, /\/impressao\/fila/);
    assert.match(src, /\/cozinha\/preparacao\/painel/);
    // S07-2 permite POST apenas para /cozinha/sessao/unidade (contexto JWT).
    assert.match(src, /\/cozinha\/sessao\/unidade/);
  });

  it('ERP para o poll do KDS ao trocar de página (não sobrescreve Pedidos)', () => {
    const appJs = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/app.js'),
      'utf8'
    );
    const kdsSrc = fs.readFileSync(
      path.join(__dirname, '../../frontend/erp/js/cozinha-kds.js'),
      'utf8'
    );
    assert.match(appJs, /CdsCozinhaKds\.parar/);
    assert.match(kdsSrc, /CDS_ERP_ACTIVE_PAGE\s*!==\s*'cozinha-kds'/);
  });
});
