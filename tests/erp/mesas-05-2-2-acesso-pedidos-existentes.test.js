/**
 * MESAS-05.2.2 — abrir a conferência de um pedido que já existe na mesa.
 *
 * Executar: node --test --test-concurrency=1 tests/erp/mesas-05-2-2-acesso-pedidos-existentes.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const conferencia = require('../../frontend/erp/js/mesas-conferencia');
const painel = require('../../frontend/erp/js/mesas-painel');
const lancamento = require('../../frontend/erp/js/mesas-lancamento');

globalThis.CdsMesasConferencia = conferencia;

function memoria() {
  const dados = new Map();
  return {
    setItem(chave, valor) { dados.set(chave, String(valor)); },
    getItem(chave) { return dados.has(chave) ? dados.get(chave) : null; }
  };
}

function pedidoBase(extra) {
  return {
    id: 40,
    codigo: 'PED-1793630753862',
    empresa_id: 1,
    mesa_id: 1,
    mesa_atendimento_id: 9,
    mesa_numero: 1,
    status: 'PEDIDO',
    observacao: 'sem cebola',
    total: 55.98,
    itens: [{ produto_nome: 'Pastel de carne', quantidade: 2, subtotal: 198 }],
    preparacao: { estado: 'NAO_ENVIADO', classificacao: 'NAO_ENVIADO', enviado_em: null },
    ...extra
  };
}

function ocupada() {
  return { empresa_id: 1, mesa_id: 1, numero: 1, situacao: 'OCUPADA', atendimento: { id: 9 } };
}

function htmlMesa(pedidos) {
  return painel.htmlPainel({
    empresaRotulo: 'Esquinao',
    itens: [{ id: 1, numero: 1, ativo: true, situacao: 'OCUPADA', atendimento: { id: 9, aberto_em: '2026-11-02 14:45:18' } }],
    mesaSelecionadaId: 1,
    detalhe: { situacao: 'OCUPADA', numero: 1, atendimento: { id: 9, aberto_em: '2026-11-02 14:45:18' } },
    pedidos,
    destinoId: '',
    clienteId: '',
    aviso: '',
    sucesso: ''
  }, new Date('2026-11-02T14:48:17'));
}

describe('acesso ao pedido existente', () => {
  it('pede conferência do pedido não enviado e abre o mesmo identificador sem criar outro', () => {
    const pedido = pedidoBase();
    const html = htmlMesa([pedido]);
    assert.match(html, /Conferir pedido/);
    assert.match(html, /data-pedido-id="40"/);
    assert.match(html, /data-acao="lancar"/);
    const posts = [];
    const idas = [];
    const control = painel.criarControlador({
      empresaId: 1,
      fetchJson: async (method) => {
        posts.push(method);
        return { atendimento: { id: 9 }, pedidos: [pedido] };
      },
      aoIrParaPedidos(ctx) { idas.push(ctx); }
    });
    control.estado.ativo = true;
    control.estado.itens = [{ id: 1, numero: 1, situacao: 'OCUPADA', atendimento: { id: 9 } }];
    control.estado.mesaSelecionadaId = 1;
    control.estado.pedidos = [pedido];
    const primeira = control.abrirPedidoExistente(40);
    const segunda = control.abrirPedidoExistente(40);
    assert.equal(primeira.ok, true);
    assert.equal(primeira.pedidoId, 40);
    assert.equal(segunda.ignorada, true);
    assert.equal(idas.length, 1);
    assert.equal(idas[0].pedidoId, 40);
    assert.equal(posts.length, 0);

    const storage = memoria();
    lancamento.gravarLancamento(storage, idas[0]);
    const lido = lancamento.lerLancamento(storage, 1);
    assert.equal(lido.pedido_id, 40);
    assert.equal(lido.abrir_modal, false);
    const decisao = conferencia.decidirConsultaPedido(ocupada(), pedido);
    assert.equal(decisao.abrir, true);
    assert.equal(decisao.criarPedido, false);
    assert.equal(decisao.pedidoId, 40);
    const tela = conferencia.criarConferencia({ novaChave: () => 'chave', fetchJson: async () => { posts.push('ENVIO'); return {}; } });
    const aberto = tela.finalizar(pedido, { numero: 1 });
    assert.equal(aberto.pedidoId, 40);
    assert.equal(aberto.enviado, false);
    const conferenciaHtml = tela.html();
    assert.match(conferenciaHtml, /PED-1793630753862/);
    assert.match(conferenciaHtml, /Mesa 1/);
    assert.match(conferenciaHtml, /Pastel de carne/);
    assert.match(conferenciaHtml, /quantidade 2/);
    assert.match(conferenciaHtml, /sem cebola/);
    assert.match(conferenciaHtml, /Total 55.98/);
    assert.equal(conferenciaHtml.includes('Total 198'), false);
    assert.match(conferenciaHtml, /data-acao="enviar"/);
    assert.equal(posts.includes('ENVIO'), false);
  });

  it('mostra o pedido em preparação e o concluído sem editar nem reiniciar o relógio', async () => {
    const emPreparo = pedidoBase({
      preparacao: { estado: 'EM_PREPARACAO', classificacao: 'NORMAL', enviado_em: '2026-11-02 14:47:02', tempo_decorrido_segundos: 75 }
    });
    assert.equal(conferencia.acaoDoPedido(emPreparo).rotulo, 'Ver pedido');
    assert.equal(conferencia.acaoDoPedido(emPreparo).editar, false);
    assert.match(htmlMesa([emPreparo]), /Ver pedido/);
    const fetches = [];
    const tela = conferencia.criarConferencia({
      novaChave: () => 'chave',
      fetchJson: async () => { fetches.push('envio'); return {}; }
    });
    tela.finalizar(emPreparo, { numero: 1 });
    const html = tela.html();
    assert.match(html, /Em preparação/);
    assert.match(html, /2026-11-02 14:47:02/);
    assert.match(html, /NORMAL/);
    assert.equal(html.includes('data-acao="enviar"'), false);
    assert.equal(html.includes('data-acao="corrigir"'), false);
    assert.equal(tela.corrigir().ok, false);
    const repetido = await tela.enviar();
    assert.equal(repetido.codigo, 'PREPARACAO_JA_ENVIADA');
    assert.equal(fetches.length, 0);
    assert.equal(tela.estado.preparacao.enviado_em, '2026-11-02 14:47:02');

    const concluido = pedidoBase({
      preparacao: {
        estado: 'CONCLUIDO',
        classificacao: 'CONCLUIDO',
        enviado_em: '2026-11-02 14:47:02',
        concluido_em: '2026-11-02 14:55:00'
      }
    });
    assert.equal(conferencia.acaoDoPedido(concluido).rotulo, 'Ver pedido');
    const vista = conferencia.criarConferencia({ novaChave: () => 'chave', fetchJson: async () => { fetches.push('envio'); return {}; } });
    vista.finalizar(concluido, { numero: 1 });
    assert.match(vista.html(), /Conclusão 2026-11-02 14:55:00/);
    assert.equal(vista.html().includes('data-acao="enviar"'), false);
    await vista.enviar();
    assert.equal(vista.estado.preparacao.enviado_em, '2026-11-02 14:47:02');
    assert.equal(fetches.length, 0);
  });

  it('bloqueia faturado, cancelado, inexistente, outra empresa, encerrado, rede e resposta atrasada', async () => {
    for (const status of ['FATURADO', 'CANCELADO']) {
      const pedido = pedidoBase({ status, preparacao: { estado: 'NAO_ENVIADO', classificacao: 'NAO_ENVIADO', enviado_em: null } });
      assert.equal(conferencia.acaoDoPedido(pedido).rotulo, 'Ver pedido');
      assert.equal(conferencia.acaoDoPedido(pedido).enviar, false);
      const tela = conferencia.criarConferencia({ novaChave: () => 'chave', fetchJson: async () => { throw new Error('nao enviar'); } });
      tela.finalizar(pedido, { numero: 1 });
      assert.equal(tela.html().includes('data-acao="enviar"'), false);
      assert.equal(tela.html().includes('data-acao="corrigir"'), false);
      assert.match(tela.html(), new RegExp(status));
      const envio = await tela.enviar();
      assert.equal(envio.codigo, 'PREPARACAO_ESTADO_INCOMPATIVEL');
    }

    const ausente = conferencia.decidirConsultaPedido(ocupada(), null);
    assert.equal(ausente.codigo, 'PEDIDO_NAO_ENCONTRADO');
    assert.equal(ausente.abrir, false);
    const outra = conferencia.decidirConsultaPedido(ocupada(), pedidoBase({ empresa_id: 2 }));
    assert.equal(outra.codigo, 'PEDIDO_OUTRA_EMPRESA');
    assert.equal(outra.sucesso, false);
    const encerrado = conferencia.decidirConsultaPedido(
      { empresa_id: 1, mesa_id: 1, numero: 1, situacao: 'LIVRE', atendimento: null },
      pedidoBase()
    );
    assert.equal(encerrado.codigo, 'ATENDIMENTO_JA_ENCERRADO');
    assert.equal(encerrado.criarPedido, false);
    const rede = conferencia.decidirConsultaPedido(ocupada(), pedidoBase(), { rede: true });
    assert.equal(rede.abrir, false);
    assert.equal(rede.sucesso, false);
    const atrasada = conferencia.decidirConsultaPedido(ocupada(), pedidoBase(), { geracao: 1, geracaoAtual: 2 });
    assert.equal(atrasada.obsoleta, true);
    assert.equal(atrasada.abrir, false);
    const tela = conferencia.criarConferencia({ novaChave: () => 'chave', fetchJson: async () => ({}) });
    assert.equal(tela.html(), '');
  });

  it('atualiza a lista da mesa sem duplicar e mantém o lançamento de pedido novo', async () => {
    const pedidos = [pedidoBase()];
    const control = painel.criarControlador({
      empresaId: 1,
      fetchJson: async (method, caminho) => {
        if (method === 'POST') throw new Error('POST ' + caminho);
        if (caminho === '/mesas/situacao') {
          return { itens: [{ id: 1, numero: 1, ativo: true, situacao: 'OCUPADA', atendimento: { id: 9, aberto_em: '2026-11-02 14:45:18' } }] };
        }
        return { atendimento: { id: 9 }, pedidos };
      },
      aoIrParaPedidos() {}
    });
    await control.iniciar();
    await control.selecionar(1);
    const atualizado = control.atualizarPedidos([pedidoBase({
      preparacao: { estado: 'EM_PREPARACAO', classificacao: 'NORMAL', enviado_em: '2026-11-02 14:47:02', tempo_decorrido_segundos: 75 }
    })]);
    assert.equal(atualizado.total, 1);
    assert.equal(control.estado.pedidos.length, 1);
    assert.match(control.html(), /Ver pedido/);
    assert.equal((control.html().match(/data-pedido-id="40"/g) || []).length, 1);
    const lancado = control.lancarPedido();
    assert.equal(lancado.ok, true);
    const fonte = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/pedidos.js'), 'utf8');
    const inicio = fonte.indexOf('async function consultarPedidoDaMesa');
    const fim = fonte.indexOf('async function aplicarLancamentoDaMesa');
    const corpo = fonte.slice(inicio, fim);
    assert.match(corpo, /decidirConsultaPedido/);
    assert.match(corpo, /\/pedidos\/\$\{ctx\.pedido_id\}/);
    assert.match(corpo, /conferencia\.finalizar/);
    assert.doesNotMatch(corpo, /method:\s*'POST'|method:\s*"POST"/);
  });
});
