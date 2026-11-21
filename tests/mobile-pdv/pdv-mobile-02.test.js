/**
 * PDV-MOBILE-02 — encaminhamento do pedido e fechamento sequencial.
 * Sem TEF real, PIX, adquirente, NFC-e ou banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-02.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobpdv02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const ROOT = path.join(__dirname, '..', '..');

function ler(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function carregarPedido(opcoes = {}) {
  const memoria = new Map(Object.entries(opcoes.storage || {}));
  const sessao = new Map();
  const contexto = {
    console,
    crypto,
    setTimeout,
    clearTimeout,
    API_URL: 'http://cds.test/api',
    localStorage: {
      getItem(chave) { return memoria.has(chave) ? memoria.get(chave) : null; },
      setItem(chave, valor) { memoria.set(chave, String(valor)); },
      removeItem(chave) { memoria.delete(chave); }
    },
    sessionStorage: {
      getItem(chave) { return sessao.has(chave) ? sessao.get(chave) : null; },
      setItem(chave, valor) { sessao.set(chave, String(valor)); },
      removeItem(chave) { sessao.delete(chave); }
    },
    location: { origin: 'http://cds.test', href: '/mobile-pedido', replace() {}, assign(url) { this.href = url; } },
    document: {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; }
    },
    fetch: opcoes.fetch || (async () => { throw new Error('fetch não configurado'); }),
    CdsEmpresaContexto: opcoes.contexto || null
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(ler('frontend/erp/js/pedidos.js'), contexto);
  vm.runInContext(ler('frontend/mobile-pedido/mobile-pedido.js'), contexto);
  return contexto;
}

function carregarPdv() {
  const contexto = {
    console,
    setTimeout,
    clearTimeout,
    API_URL: 'http://cds.test/api',
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'http://cds.test', href: '/mobile-pdv', replace() {}, assign() {} },
    document: {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; }
    },
    fetch: async () => { throw new Error('fetch da página não usado'); }
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(ler('frontend/shared/js/tefFluxoPagamento.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pagamentoSequencial.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/interacaoPagamentoMisto.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pdv-fechamento-oficial.js'), contexto);
  vm.runInContext(ler('frontend/mobile-pdv/mobile-pdv.js'), contexto);
  return contexto;
}

function contextoEmpresa(id = 4) {
  return {
    temEmpresaSelecionada() { return true; },
    lerEmpresaId() { return id; },
    headersJson() {
      return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-mobile',
        'X-Empresa-Id': String(id)
      };
    }
  };
}

function preparacaoOk(extra = {}) {
  return Object.assign({
    success: true,
    pedido_id: 55,
    empresa_id: 4,
    operacao_id: 9,
    venda_id: null,
    venda_concluida: false,
    total: 17.98,
    desconto: 0,
    cliente_id: null,
    itens: [{
      produto_id: 747,
      quantidade: 2,
      preco_unitario: 8.99,
      subtotal: 17.98,
      tipo_venda: 'UNIDADE'
    }]
  }, extra);
}

describe('PDV Mobile — pedido e página', () => {
  const htmlPedido = ler('frontend/mobile-pedido/index.html');
  const htmlPdv = ler('frontend/mobile-pdv/index.html');
  const servidor = ler('backend/server.js');
  const pdvJs = ler('frontend/pdv/js/pdv.js');

  it('abre rota própria e o botão de encaminhamento, sem PDV universal', () => {
    assert.match(servidor, /\/mobile-pdv/);
    assert.match(htmlPedido, /Enviar para o PDV/);
    assert.match(htmlPdv, /Finalizar venda/);
    assert.equal(htmlPdv.includes('/pdv-universal'), false);
    assert.equal(htmlPdv.includes('fiscal/emitir'), false);
    assert.match(pdvJs, /TefFluxoPagamento\.montarParcelasListaSequencial/);
    const acesso = require('../../frontend/shared/js/pdv-acesso-oficial');
    assert.equal(acesso.destinoNavegacaoSeguro('/mobile-pdv'), '/mobile-pdv');
  });

  it('encaminha o pedido novo com o snapshot oficial e a empresa', async () => {
    const chamadas = [];
    const ctx = carregarPedido({
      contexto: contextoEmpresa(4),
      fetch: async (url, opcoes) => {
        chamadas.push({ url, opcoes });
        return { ok: true, status: 200, json: async () => preparacaoOk() };
      }
    });
    const resultado = await ctx.MobilePedido.encaminharPedidoAoPdv(55, {
      fetch: ctx.fetch,
      storage: ctx.sessionStorage,
      contexto: ctx.CdsEmpresaContexto
    });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.destino, '/mobile-pdv');
    assert.match(chamadas[0].url, /\/api\/pedidos\/55\/preparar-venda-pdv$/);
    assert.equal(chamadas[0].opcoes.headers['X-Empresa-Id'], '4');
    assert.equal(chamadas[0].opcoes.headers.Authorization, 'Bearer tok-mobile');
    const guardado = JSON.parse(ctx.sessionStorage.getItem('pdvPedidoHandoff'));
    assert.equal(guardado.operacao_id, 9);
    assert.equal(guardado.itens[0].subtotal, 17.98);
    assert.equal(guardado.empresa_id, 4);
  });

  it('não inicia fechamento de pedido cancelado, faturado ou já vendido', async () => {
    async function resposta(corpo, status) {
      const ctx = carregarPedido({
        contexto: contextoEmpresa(4),
        fetch: async () => ({ ok: status < 400, status, json: async () => corpo })
      });
      return ctx.MobilePedido.encaminharPedidoAoPdv(55, {
        fetch: ctx.fetch,
        storage: ctx.sessionStorage,
        contexto: ctx.CdsEmpresaContexto
      });
    }
    const cancelado = await resposta({ mensagem: 'Pedido no estado CANCELADO não pode iniciar uma venda pelo PDV.', codigo: 'FATURAMENTO_PEDIDO_CONFLITANTE' }, 409);
    assert.equal(cancelado.ok, false);
    assert.match(cancelado.mensagem, /CANCELADO/);
    const faturado = await resposta(preparacaoOk({ venda_concluida: true, venda_id: 80 }), 200);
    assert.equal(faturado.codigo, 'VENDA_JA_CONCLUIDA');
    assert.equal(faturado.ok, false);
    const vendido = await resposta(preparacaoOk({ venda_id: 81 }), 200);
    assert.equal(vendido.codigo, 'VENDA_JA_VINCULADA');
    assert.equal(vendido.ok, false);
  });

  it('repetir a preparação guarda a mesma operação e não cria outra venda', async () => {
    let vezes = 0;
    const ctx = carregarPedido({
      contexto: contextoEmpresa(4),
      fetch: async () => {
        vezes += 1;
        return { ok: true, status: 200, json: async () => preparacaoOk({ recuperacao: vezes > 1 }) };
      }
    });
    const opcoes = { fetch: ctx.fetch, storage: ctx.sessionStorage, contexto: ctx.CdsEmpresaContexto };
    const primeira = await ctx.MobilePedido.encaminharPedidoAoPdv(55, opcoes);
    const segunda = await ctx.MobilePedido.encaminharPedidoAoPdv(55, opcoes);
    assert.equal(primeira.handoff.operacao_id, segunda.handoff.operacao_id);
    assert.equal(vezes, 2);
    assert.equal(JSON.parse(ctx.sessionStorage.getItem('pdvPedidoHandoff')).venda_id, null);
  });

  it('bloqueia composição de outra empresa', async () => {
    const ctx = carregarPedido({
      contexto: contextoEmpresa(4),
      fetch: async () => ({ ok: true, status: 200, json: async () => preparacaoOk({ empresa_id: 9 }) })
    });
    const resultado = await ctx.MobilePedido.encaminharPedidoAoPdv(55, {
      fetch: ctx.fetch,
      storage: ctx.sessionStorage,
      contexto: ctx.CdsEmpresaContexto
    });
    assert.equal(resultado.codigo, 'EMPRESA_DIVERGENTE');
    assert.equal(ctx.sessionStorage.getItem('pdvPedidoHandoff'), null);
  });
});

describe('PDV Mobile — pagamento sequencial', () => {
  function base(ctx) {
    ctx.PagamentoSequencial.reset();
    return {
      fluxo: ctx.TefFluxoPagamento,
      itens: preparacaoOk().itens,
      handoff: preparacaoOk(),
      total: 17.98,
      desconto: 0,
      chave: 'pdv-teste-chave01',
      valorFiscal: 0,
      valorNaoFiscal: 17.98,
      tefHabilitado: false,
      modoConfirmacaoFiscal: 'TEF'
    };
  }

  it('dinheiro confirmado manualmente entra como não fiscal e o PIX aprovado como fiscal', async () => {
    const ctx = carregarPdv();
    const entrada = base(ctx);
    await ctx.PagamentoSequencial.adicionar({ forma: 'pix', valor: 10, totalVenda: 17.98, autorizarTef: async () => ({
      aprovado: true, status: 'aprovado', transacao_id: 501, nsu: 'NSU1', autorizacao: 'AUT1'
    }) });
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 7.98, totalVenda: 17.98 });
    entrada.parcelas = ctx.PagamentoSequencial.exportar();
    const montado = ctx.PdvFechamentoOficial.montarCorpo(entrada);
    assert.equal(montado.ok, true);
    assert.equal(montado.corpo.origem, 'PDV');
    assert.equal(montado.corpo.pedido_id, 55);
    assert.equal(montado.corpo.pedido_faturamento_operacao_id, 9);
    assert.equal(montado.corpo.pagamento_sequencial, true);
    assert.equal(montado.corpo.emitir_fiscal, false);
    assert.equal(montado.corpo.pagamentos[0].forma_pagamento, 'pix');
    assert.equal(montado.corpo.pagamentos[0].tipo_recebimento, 'fiscal');
    assert.equal(montado.corpo.pagamentos[0].tef_transacao_id, 501);
    assert.equal(montado.corpo.pagamentos[0].confirmacao_manual, 0);
    assert.equal(montado.corpo.pagamentos[1].forma_pagamento, 'dinheiro');
    assert.equal(montado.corpo.pagamentos[1].tipo_recebimento, 'nao_fiscal');
    assert.equal(montado.corpo.pagamentos[1].confirmacao_manual, 1);
    assert.equal(montado.corpo.pagamentos[1].nsu, undefined);
    const desktop = ctx.TefFluxoPagamento.montarParcelasListaSequencial(entrada.parcelas);
    assert.deepEqual(montado.corpo.pagamentos, desktop);
  });

  it('a ordem dinheiro depois PIX permanece a ordem enviada', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 5, totalVenda: 17.98 });
    await ctx.PagamentoSequencial.adicionar({ forma: 'pix', valor: 12.98, totalVenda: 17.98, autorizarTef: async () => ({
      aprovado: true, status: 'aprovado', transacao_id: 8, nsu: 'N', autorizacao: 'A'
    }) });
    const parcelas = ctx.PagamentoSequencial.exportar();
    const montado = ctx.PdvFechamentoOficial.montarCorpo({ ...base(ctx), parcelas });
    assert.equal(montado.corpo.pagamentos[0].forma_pagamento, 'dinheiro');
    assert.equal(montado.corpo.pagamentos[1].forma_pagamento, 'pix');
  });

  it('aceita PIX, débito e crédito aprovados em sequência', async () => {
    const ctx = carregarPdv();
    const handoff = preparacaoOk({
      total: 18,
      itens: [{ produto_id: 747, quantidade: 2, preco_unitario: 9, subtotal: 18, tipo_venda: 'UNIDADE' }]
    });
    const entrada = base(ctx);
    entrada.handoff = handoff;
    entrada.itens = handoff.itens;
    entrada.total = 18;
    entrada.valorFiscal = 18;
    entrada.valorNaoFiscal = 0;
    const formas = [['pix', 6], ['cartao_debito', 6], ['cartao_credito', 6]];
    let id = 10;
    for (const [forma, valor] of formas) {
      const resultado = await ctx.PagamentoSequencial.adicionar({
        forma, valor, totalVenda: 18,
        autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: id, nsu: 'N' + id, autorizacao: 'A' + id })
      });
      id += 1;
      assert.equal(resultado.ok, true);
    }
    entrada.parcelas = ctx.PagamentoSequencial.exportar();
    const montado = ctx.PdvFechamentoOficial.montarCorpo(entrada);
    assert.equal(montado.ok, true, montado.mensagem || montado.codigo);
    assert.equal(
      montado.corpo.pagamentos.map((p) => p.forma_pagamento).join(','),
      'pix,cartao_debito,cartao_credito'
    );
    assert.equal(montado.corpo.pagamentos_processados_pdv, true);
  });

  it('impede finalizar com saldo, parcela pendente, recusa ou falha', async () => {
    const ctx = carregarPdv();
    const parcial = ctx.PdvFechamentoOficial.montarCorpo({
      ...base(ctx),
      parcelas: [{ forma_pagamento: 'dinheiro', valor: 5, status_autorizacao: 'informada' }]
    });
    assert.equal(parcial.codigo, 'SALDO_PENDENTE');

    const pendente = ctx.PdvFechamentoOficial.montarCorpo({
      ...base(ctx),
      parcelas: [
        { forma_pagamento: 'pix', valor: 17.98, status_autorizacao: 'pendente' }
      ]
    });
    assert.equal(pendente.codigo, 'PARCELA_NAO_CONFIRMADA');

    ctx.PagamentoSequencial.reset();
    const recusado = await ctx.PagamentoSequencial.adicionar({
      forma: 'pix', valor: 17.98, totalVenda: 17.98,
      autorizarTef: async () => ({ aprovado: false, status: 'negado', mensagem: 'Recusado' })
    });
    assert.equal(recusado.ok, false);
    assert.equal(ctx.PagamentoSequencial.snapshot().length, 0);

    const falha = await ctx.PagamentoSequencial.adicionar({
      forma: 'debito', valor: 17.98, totalVenda: 17.98,
      autorizarTef: async () => { throw new Error('Sem conexão com o autorizador'); }
    });
    assert.equal(falha.codigo, 'TEF_FALHA');
    assert.match(falha.mensagem, /autorizador/);
    assert.equal(ctx.PagamentoSequencial.snapshot().length, 0);
  });

  it('não chama o autorizador quando o celular não é a estação do pinpad', async () => {
    const ctx = carregarPdv();
    let chamadas = 0;
    const retorno = await ctx.MobilePdv.autorizarEletronico('pix', 10, 'chave', async () => {
      chamadas += 1;
      return { ok: true, json: async () => ({}) };
    });
    assert.equal(chamadas, 0);
    assert.equal(retorno.codigo, 'TEF_ESTACAO');
    assert.equal(retorno.aprovado, false);
  });

  it('grava em POST /api/vendas, vincula o pedido e não emite NFC-e', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 17.98, totalVenda: 17.98 });
    ctx.PagamentoSequencial.registrarComposicao({ sucesso: true });
    const urls = [];
    const resultado = await ctx.MobilePdv.fechar({
      fetch: async (url, opcoes) => {
        urls.push({ url, opcoes });
        if (url.endsWith('/configuracoes/modo_dashboard_fiscal')) {
          return { ok: true, json: async () => ({ valor: '0' }) };
        }
        if (url.endsWith('/pre-calcular-distribuicao')) {
          return { ok: true, json: async () => ({ sucesso: true, valor_fiscal: 0, valor_nao_fiscal: 17.98 }) };
        }
        if (url.endsWith('/vendas')) {
          return { ok: true, status: 201, json: async () => ({ id: 90, venda_id: 90, status_pagamento: 'quitada' }) };
        }
        if (url.endsWith('/finalizar-venda-pdv')) {
          return { ok: true, json: async () => ({ success: true, venda_id: 90, idempotente: false }) };
        }
        throw new Error('url inesperada ' + url);
      },
      itens: preparacaoOk().itens,
      total: 17.98,
      desconto: 0,
      handoff: preparacaoOk(),
      chave: 'pdv-teste-chave01'
    });
    assert.equal(resultado.ok, true);
    assert.equal(resultado.vendaId, 90);
    assert.equal(urls.some((c) => c.url.endsWith('/fiscal/emitir/venda/90')), false);
    const gravacao = urls.find((c) => c.url.endsWith('/vendas'));
    const corpo = JSON.parse(gravacao.opcoes.body);
    const preCalculo = urls.find((c) => c.url.endsWith('/pre-calcular-distribuicao'));
    assert.equal(JSON.parse(preCalculo.opcoes.body).emitir_fiscal, false);
    assert.equal(corpo.emitir_fiscal, false);
    assert.equal(corpo.origem, 'PDV');
    assert.equal(corpo.pedido_id, 55);
    assert.equal(corpo.pedido_faturamento_operacao_id, 9);
    assert.equal(corpo.chave_fechamento_pdv, 'pdv-teste-chave01');
    assert.equal(corpo.itens[0].produto_id, 747);
    assert.equal(corpo.itens[0].subtotal, 17.98);
  });

  it('consulta o modo fiscal oficial e recebe emissão pelo finalizador de venda sem chamada duplicada', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 17.98,
      totalVenda: 17.98,
      tefHabilitado: true,
      autorizarTef: async () => ({
        aprovado: true,
        status: 'aprovado',
        transacao_id: 'pix-fiscal-test-1'
      })
    });
    const chamadas = [];
    const resultado = await ctx.MobilePdv.fechar({
      fetch: async (url, opcoes) => {
        chamadas.push({ url: String(url), opcoes });
        if (String(url).endsWith('/configuracoes/modo_dashboard_fiscal')) {
          return { ok: true, json: async () => ({ valor: '1' }) };
        }
        if (String(url).endsWith('/pre-calcular-distribuicao')) {
          return { ok: true, json: async () => ({
            sucesso: true,
            valor_fiscal: 17.98,
            valor_nao_fiscal: 0
          }) };
        }
        if (String(url).endsWith('/vendas')) {
          return { ok: true, status: 201, json: async () => ({
            id: 91,
            venda_id: 91,
            status_pagamento: 'quitada',
            fiscal: { success: true, status: 'autorizada', numero: 14 }
          }) };
        }
        throw new Error('url inesperada ' + url);
      },
      itens: preparacaoOk().itens,
      total: 17.98,
      desconto: 0,
      handoff: null,
      chave: 'pdv-fiscal-teste-01',
      tefHabilitado: true
    });

    assert.equal(resultado.ok, true);
    assert.equal(resultado.vendaId, 91);
    assert.equal(resultado.fiscal.status, 'autorizada');
    const preCalculo = chamadas.find((chamada) => chamada.url.endsWith('/pre-calcular-distribuicao'));
    const venda = chamadas.find((chamada) => chamada.url.endsWith('/vendas'));
    assert.equal(JSON.parse(preCalculo.opcoes.body).emitir_fiscal, true);
    assert.equal(JSON.parse(venda.opcoes.body).emitir_fiscal, true);
    assert.equal(JSON.parse(venda.opcoes.body).valor_fiscal, 17.98);
    assert.equal(chamadas.some((chamada) => chamada.url.includes('/fiscal/emitir/venda/')), false);
  });

  it('não solicita emissão no corpo final se a distribuição não contiver valor fiscal', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 17.98, totalVenda: 17.98 });
    ctx.PagamentoSequencial.registrarComposicao({ sucesso: true });
    const chamadas = [];
    const resultado = await ctx.MobilePdv.fechar({
      fetch: async (url, opcoes) => {
        chamadas.push({ url: String(url), opcoes });
        if (String(url).endsWith('/configuracoes/modo_dashboard_fiscal')) {
          return { ok: true, json: async () => ({ valor: '1' }) };
        }
        if (String(url).endsWith('/pre-calcular-distribuicao')) {
          return { ok: true, json: async () => ({
            sucesso: true,
            valor_fiscal: 0,
            valor_nao_fiscal: 17.98
          }) };
        }
        if (String(url).endsWith('/vendas')) {
          return { ok: true, status: 201, json: async () => ({ id: 92, venda_id: 92 }) };
        }
        throw new Error('url inesperada ' + url);
      },
      itens: preparacaoOk().itens,
      total: 17.98,
      desconto: 0,
      handoff: null,
      chave: 'pdv-fiscal-sem-itens-01',
      tefHabilitado: false
    });

    assert.equal(resultado.ok, true);
    const preCalculo = chamadas.find((chamada) => chamada.url.endsWith('/pre-calcular-distribuicao'));
    const venda = chamadas.find((chamada) => chamada.url.endsWith('/vendas'));
    assert.equal(JSON.parse(preCalculo.opcoes.body).emitir_fiscal, true);
    assert.equal(JSON.parse(venda.opcoes.body).emitir_fiscal, false);
    assert.equal(JSON.parse(venda.opcoes.body).valor_fiscal, 0);
    assert.equal(chamadas.some((chamada) => chamada.url.includes('/fiscal/emitir/venda/')), false);
  });

  it('não envia venda se a configuração fiscal oficial não puder ser consultada', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 17.98, totalVenda: 17.98 });
    ctx.PagamentoSequencial.registrarComposicao({ sucesso: true });
    const chamadas = [];
    const resultado = await ctx.MobilePdv.fechar({
      fetch: async (url) => {
        chamadas.push(String(url));
        return { ok: false, status: 403, json: async () => ({ error: 'Acesso negado.' }) };
      },
      itens: preparacaoOk().itens,
      total: 17.98,
      desconto: 0,
      handoff: null
    });

    assert.equal(resultado.ok, false);
    assert.equal(resultado.codigo, 'HTTP_403');
    assert.equal(chamadas.length, 1);
    assert.ok(chamadas[0].endsWith('/configuracoes/modo_dashboard_fiscal'));
    assert.match(resultado.mensagem, /configuração fiscal oficial/);
  });

  it('bloqueia caixa fechado, segundo clique e venda já persistida', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 17.98, totalVenda: 17.98 });
    ctx.PagamentoSequencial.registrarComposicao({ sucesso: true });
    const comum = {
      itens: preparacaoOk().itens,
      total: 17.98,
      handoff: preparacaoOk(),
      chave: 'pdv-teste-chave01'
    };
    let vendas = 0;
    const semCaixa = await ctx.MobilePdv.fechar({
      ...comum,
      fetch: async (url) => {
        if (String(url).endsWith('/configuracoes/modo_dashboard_fiscal')) {
          return { ok: true, status: 200, json: async () => ({ valor: '0' }) };
        }
        if (url.endsWith('/vendas')) vendas += 1;
        return { ok: false, status: 400, json: async () => ({ error: 'Nenhum caixa aberto.', code: 'CAIXA_NAO_ENCONTRADO' }) };
      }
    });
    assert.equal(semCaixa.ok, false);
    assert.match(semCaixa.mensagem, /caixa/i);
    assert.equal(vendas, 0);

    const ocupado = await ctx.MobilePdv.fechar({ ...comum, enviando: true, fetch: async () => { throw new Error('não'); } });
    assert.equal(ocupado.bloqueado, true);
    const repetida = await ctx.MobilePdv.fechar({
      ...comum,
      vendaPersistida: { id: 90 },
      fetch: async () => { throw new Error('não'); }
    });
    assert.match(repetida.mensagem, /Nenhuma segunda venda/);
  });

  it('o modelo empresa única divergente não carrega o snapshot', () => {
    const oficial = require('../../frontend/pdv/js/pdv-fechamento-oficial');
    const bloqueio = oficial.empresaCompativel(
      { empresa_id: 4 },
      4,
      { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 1 }
    );
    assert.equal(bloqueio.codigo, 'EMPRESA_PDV_UNICA_DIVERGENTE');
    const mesma = oficial.empresaCompativel(
      { empresa_id: 4 },
      4,
      { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 4 }
    );
    assert.equal(mesma.ok, true);
  });
});

describe('PDV Mobile — preparação no banco de testes', () => {
  it('prepara o snapshot uma vez, recupera a mesma operação e recusa o pedido cancelado', async () => {
    const db = require('../../backend/database');
    await db.whenReady;
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
    const inicio = Date.now();
    let temOrigem = false;
    while (Date.now() - inicio < 20000) {
      const colunas = await new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(pedidos)', (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      if (colunas.some((coluna) => coluna.name === 'origem_canal')) {
        temOrigem = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(temOrigem, true);

    const EmpresaService = require('../../backend/services/empresas/EmpresaService');
    const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
    const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
    const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
    const Entrada = require('../../backend/services/pedido/EntradaPedidoService');
    const PedidoOperacional = require('../../backend/services/pedido/PedidoOperacionalService');
    const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
    const operacoes = require('../../backend/services/faturamento/PedidoFaturamentoOperacaoRepository');
    const configService = require('../../backend/services/configuracaoService');
    const oficial = require('../../frontend/pdv/js/pdv-fechamento-oficial');

    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaEstoqueEmpresaAsync(db);
    const empresa = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Mobile', nome_fantasia: 'Mobile' },
      { db }
    );
    const produto = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO produtos (nome, nome_comercial, preco_venda, preco_pedido, unidade, unidade_estoque, ativo)
         VALUES ('Pastel de carne', 'Pastel de carne', 8.99, 8.99, 'UN', 'UN', 1)`,
        function onRun(err) { return err ? reject(err) : resolve(this.lastID); }
      );
    });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: produto,
      empresaId: empresa.id,
      saldo_fiscal: 20,
      saldo_nao_fiscal: 0,
      estoque_atual: 20,
      reservado_fiscal: 0
    }, { db });

    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const gravado = await Entrada.receber({
        canal: Entrada.CanalOrigem.EQUIPE,
        body: {
          cliente_id: null,
          mesa_id: null,
          observacao: null,
          frete: 0,
          desconto: 0,
          total: 17.98,
          tipo: 'pedido',
          status: 'PEDIDO',
          itens: [{
            produto_id: produto,
            quantidade: 2,
            preco_unitario: 8.99,
            desconto_percentual: 0,
            subtotal: 17.98,
            tipo_venda: 'UNIDADE',
            preco_venda_snapshot: 8.99,
            preco_pedido_snapshot: 8.99,
            preco_sugerido_snapshot: 8.99,
            origem_preco_sugerido: 'PRECO_PEDIDO'
          }]
        },
        empresaId: empresa.id,
        operadorId: null,
        chaveIdempotencia: 'mobile-pdv-02-pedido'
      });
      assert.equal(gravado.success, true);
      const composicao = await prepararComposicaoPedidoPdv({
        empresaId: empresa.id,
        pedidoId: gravado.pedido.id
      }, { db });
      const payload = {
        pedidoId: composicao.pedidoId,
        empresaId: composicao.empresaId,
        fingerprint: composicao.fingerprint,
        total: composicao.valorFinalCentavos / 100,
        desconto: composicao.desconto,
        valor_composicao_bruto: composicao.valorCompostoBrutoCentavos / 100,
        cliente_id: composicao.clienteId,
        itens: composicao.itens
      };
      const primeira = await operacoes.prepararOperacaoPdv(gravado.pedido.id, empresa.id, payload);
      const segunda = await operacoes.prepararOperacaoPdv(gravado.pedido.id, empresa.id, payload);
      assert.equal(Number(primeira.operacao.id), Number(segunda.operacao.id));
      const handoff = {
        pedido_id: gravado.pedido.id,
        empresa_id: empresa.id,
        operacao_id: primeira.operacao.id,
        venda_id: null,
        venda_concluida: false,
        total: payload.total,
        desconto: payload.desconto,
        cliente_id: payload.cliente_id,
        itens: payload.itens
      };
      assert.equal(oficial.conferirSnapshot(handoff).ok, true);
      assert.equal(Number(handoff.empresa_id), Number(empresa.id));
      assert.equal(Number(handoff.itens[0].quantidade), 2);
      require('../../frontend/shared/js/tefFluxoPagamento');
      const fluxo = global.TefFluxoPagamento;
      const montado = oficial.montarCorpo({
        fluxo,
        parcelas: [{ forma_pagamento: 'dinheiro', valor: payload.total, status_autorizacao: 'informada' }],
        total: payload.total,
        desconto: payload.desconto,
        itens: payload.itens,
        handoff,
        chave: 'pdv-mob-02-banco01',
        valorFiscal: 0,
        valorNaoFiscal: payload.total,
        tefHabilitado: false
      });
      assert.equal(montado.ok, true);
      assert.equal(montado.corpo.origem, 'PDV');
      assert.equal(montado.corpo.pedido_id, gravado.pedido.id);
      assert.equal(montado.corpo.chave_fechamento_pdv, 'pdv-mob-02-banco01');

      await PedidoOperacional.cancelar(gravado.pedido.id, {
        empresaId: empresa.id,
        usuarioId: null,
        chaveIdempotencia: 'mobile-pdv-02-cancelar'
      });
      await assert.rejects(
        () => operacoes.prepararOperacaoPdv(gravado.pedido.id, empresa.id, payload),
        (erro) => /CANCELADO/.test(erro.message)
      );
      const vendas = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) AS n FROM vendas', (err, row) => (err ? reject(err) : resolve(row)));
      });
      assert.equal(Number(vendas.n), 0);
    } finally {
      configService.recursoHabilitado = original;
    }
  });
});
