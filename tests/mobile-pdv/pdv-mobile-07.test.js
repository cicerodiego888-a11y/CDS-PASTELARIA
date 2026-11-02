/**
 * PDV-MOBILE-07 — autenticação, permanência em Produtos, venda por valor
 * e pagamento sequencial pelo contrato do PDV Desktop.
 * Não abre o banco oficial, não cobra TEF real e não transmite NFC-e.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const raiz = path.join(__dirname, '../..');

function ler(relativo) {
  return fs.readFileSync(path.join(raiz, relativo), 'utf8');
}

function elemento() {
  const el = { hidden: true, textContent: '', value: '', listeners: {} };
  el.addEventListener = (tipo, fn) => { el.listeners[tipo] = fn; };
  return el;
}

function carregarInicio(opcoes) {
  const ids = {};
  const contexto = {
    document: {
      readyState: 'complete',
      getElementById(id) {
        if (!ids[id]) ids[id] = elemento();
        return ids[id];
      },
      addEventListener() {}
    },
    localStorage: opcoes.localStorage,
    location: { href: '/mobile/', replace(url) { this.href = url; } },
    CdsEmpresaContexto: opcoes.contexto || null,
    CdsMobileOperacao: opcoes.operacao || {
      lerPedido() { return { ok: false, codigo: 'AUSENTE' }; },
      lerPdv() { return { ok: false, codigo: 'AUSENTE' }; },
      pedidoEmAndamento() { return false; },
      pdvEmAndamento() { return false; }
    }
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(ler('frontend/mobile/mobile-inicio.js'), contexto);
  return { contexto, ids };
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
  vm.runInContext(ler('frontend/pdv/js/pdv-venda-por-valor.js'), contexto);
  vm.runInContext(ler('frontend/mobile-pdv/mobile-pdv.js'), contexto);
  return contexto;
}

function carregarPedido() {
  const contexto = {
    console,
    document: {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; }
    }
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(ler('frontend/mobile-pedido/mobile-pedido.js'), contexto);
  return contexto.MobilePedido;
}

const itemVenda = {
  produto_id: 11,
  nome: 'Pastel',
  quantidade: 1,
  preco_unitario: 50,
  subtotal: 50
};

describe('autenticação da entrada mobile', () => {
  it('sem sessão envia para o login oficial', async () => {
    const { contexto } = carregarInicio({
      localStorage: { getItem: () => null, removeItem() {} }
    });
    await new Promise((resolver) => setImmediate(resolver));
    assert.equal(contexto.location.href, '/login?next=/mobile/');
  });

  it('sessão expirada na consulta da licença volta ao login', async () => {
    const { contexto } = carregarInicio({
      localStorage: {
        getItem(chave) {
          if (chave === 'token') return 'tok';
          if (chave === 'user') return JSON.stringify({ id: 4, nome: 'Ana' });
          return null;
        },
        removeItem() {}
      },
      contexto: {
        lerEmpresa() { return null; },
        async listarDisponiveis() {
          const erro = new Error('Sessão inválida');
          erro.status = 401;
          throw erro;
        }
      }
    });
    await new Promise((resolver) => setImmediate(resolver));
    assert.equal(contexto.location.href, '/login?next=/mobile/');
  });

  it('licença ausente não apresenta PEDIDO e PDV', async () => {
    const { ids } = carregarInicio({
      localStorage: {
        getItem(chave) {
          if (chave === 'token') return 'tok';
          if (chave === 'user') return JSON.stringify({ id: 4, nome: 'Ana' });
          return null;
        },
        removeItem() {}
      },
      contexto: {
        lerEmpresa() { return { id: 1, nome_fantasia: 'Teste' }; },
        async listarDisponiveis() {
          throw new Error('LICENCA_AUSENTE Sistema não ativado.');
        }
      }
    });
    await new Promise((resolver) => setImmediate(resolver));
    assert.equal(ids['mi-modulos'].hidden, true);
    assert.match(ids['mi-licenca'].textContent, /LICENCA_AUSENTE/);
  });

  it('sair apaga a sessão local e exige novo login', async () => {
    const removidos = [];
    const { contexto, ids } = carregarInicio({
      localStorage: {
        getItem(chave) {
          if (chave === 'token') return 'tok';
          if (chave === 'user') return JSON.stringify({ id: 4, nome: 'Ana' });
          return null;
        },
        removeItem(chave) { removidos.push(chave); }
      },
      contexto: {
        lerEmpresa() { return null; },
        async listarDisponiveis() { return []; }
      }
    });
    await new Promise((resolver) => setImmediate(resolver));
    assert.equal(ids['mi-modulos'].hidden, false);
    ids['mi-sair'].listeners.click();
    assert.deepEqual(removidos.sort(), ['token', 'user']);
    assert.equal(contexto.location.href, '/login?next=/mobile/');
  });

  it('protege as rotas antigas no cliente e os endpoints no servidor', () => {
    const pedido = ler('frontend/mobile-pedido/mobile-pedido.js');
    const pdv = ler('frontend/mobile-pdv/mobile-pdv.js');
    const servidor = ler('backend/server.js');
    const pagamento = ler('backend/services/vendas/VendaPagamentoService.js');
    assert.match(pedido, /\/login\?next=\/mobile-pedido/);
    assert.match(pdv, /\/login\?next=\/mobile-pdv/);
    assert.match(servidor, /app\.use\('\/api\/tef', verificarToken/);
    assert.match(servidor, /app\.use\('\/api\/vendas', verificarToken/);
    assert.match(servidor, /app\.use\('\/api\/pedidos', verificarToken/);
    assert.match(pagamento, /venda_id IS NULL/);
    assert.match(pagamento, /operador_id IS NULL OR operador_id = \?/);
    assert.match(ler('backend/middleware/licencaMiddleware.js'), /LICENCA_AUSENTE/);
  });
});

describe('produtos e venda pelo valor', () => {
  it('incluir produto permanece em Produtos e o carrinho abre pelo botão', () => {
    const pedido = carregarPedido();
    const estado = pedido.criarEstado();
    estado.etapa = 'produtos';
    pedido.adicionarItem(estado, {
      produtoId: 9,
      nome: 'Pastel de carne',
      quantidade: 2,
      precoBase: 12.5,
      desconto: 0
    });
    estado.etapa = pedido.etapaDepoisDeAdicionar();
    const totais = pedido.calcularTotais(estado);
    assert.equal(estado.etapa, 'produtos');
    assert.equal(totais.itens, 1);
    assert.equal(totais.total, 25);
    const pagina = ler('frontend/mobile-pedido/mobile-pedido.js');
    const html = ler('frontend/mobile-pedido/index.html');
    assert.match(pagina, /if \(adicionandoProduto\) return/);
    assert.match(pagina, /mp-ir-carrinho'\)\.addEventListener\('click', \(\) => \{ irPara\(estado, 'carrinho'\)/);
    assert.match(html, /Ver carrinho/);
  });

  it('prepara a venda pelo valor com o mesmo contrato do Desktop', () => {
    const pdv = carregarPdv();
    const oficial = pdv.PdvVendaPorValor.validarEntrada('50,00', '4');
    const mobile = pdv.MobilePdv.prepararVendaPorValor('50,00', '4');
    assert.equal(oficial.ok, true);
    assert.equal(mobile.ok, true);
    assert.equal(mobile.endpoint, pdv.PdvVendaPorValor.ENDPOINT);
    assert.equal(mobile.endpoint, '/pedidos/venda-por-valor-pasteis');
    assert.equal(mobile.corpo.valor_total, oficial.valor);
    assert.equal(mobile.corpo.quantidade_pasteis, oficial.quantidade);
    const recusado = pdv.MobilePdv.prepararVendaPorValor('0', '1');
    assert.equal(recusado.ok, false);
    const html = ler('frontend/mobile-pdv/index.html');
    assert.match(html, /id="mv-venda-valor"/);
    assert.match(html, /pdv-venda-por-valor\.js/);
  });
});

describe('pagamento sequencial', () => {
  let pdv;

  beforeEach(() => {
    pdv = carregarPdv();
    pdv.PagamentoSequencial.reset();
  });

  async function aprovar(forma, valor, transacaoId) {
    return pdv.PagamentoSequencial.adicionar({
      forma,
      valor,
      totalVenda: 50,
      autorizarTef: async () => ({
        aprovado: true,
        status: 'aprovado',
        transacao_id: transacaoId
      })
    });
  }

  it('PIX aprovado entra no saldo e a recusa, a pendência, o timeout e a falha não', async () => {
    const aprovado = await aprovar('pix', 20, 501);
    assert.equal(aprovado.ok, true);
    assert.equal(pdv.PagamentoSequencial.soma(), 20);

    const recusa = await pdv.PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 10,
      totalVenda: 50,
      autorizarTef: async () => ({ aprovado: false, status: 'recusado', mensagem: 'Negado' })
    });
    assert.equal(recusa.ok, false);
    assert.equal(recusa.codigo, 'TEF_REJEITADO');

    const pendente = await pdv.PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 10,
      totalVenda: 50,
      autorizarTef: async () => ({ aprovado: false, status: 'pendente' })
    });
    assert.equal(pendente.ok, false);
    assert.equal(pendente.codigo, 'PENDENTE');

    const timeout = await pdv.PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 10,
      totalVenda: 50,
      autorizarTef: async () => ({ status: 'timeout', codigo: 'TIMEOUT' })
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.codigo, 'TIMEOUT');

    let chamadas = 0;
    const rede = await pdv.PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 10,
      totalVenda: 50,
      autorizarTef: async () => {
        chamadas += 1;
        throw new Error('Falha de comunicação');
      }
    });
    assert.equal(rede.ok, false);
    assert.equal(rede.codigo, 'TEF_FALHA');
    assert.equal(chamadas, 1);
    assert.equal(pdv.PagamentoSequencial.soma(), 20);
    assert.equal(pdv.PagamentoSequencial.autorizacaoDigitalPendente(), true);
  });

  it('PIX e débito aprovados ficam disponíveis para o restante', async () => {
    await aprovar('pix', 20, 601);
    await aprovar('cartao_debito', 15, 602);
    assert.equal(pdv.PagamentoSequencial.soma(), 35);
    assert.equal(pdv.PagamentoSequencial.autorizacaoDigitalPendente(), false);
  });

  it('dinheiro só completa a composição quando o eletrônico está aprovado', async () => {
    await aprovar('pix', 20, 701);
    await pdv.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 30, totalVenda: 50 });
    assert.equal(pdv.PagamentoSequencial.recomposicaoNecessaria(), true);
    assert.equal(pdv.PagamentoSequencial.composicaoValida(), false);
    const registro = pdv.PagamentoSequencial.registrarComposicao({ sucesso: true });
    assert.equal(registro.ok, true);
    assert.equal(pdv.PagamentoSequencial.composicaoValida(), true);

    pdv.PagamentoSequencial.reset();
    await pdv.PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 20,
      totalVenda: 50,
      autorizarTef: async () => ({ status: 'pendente' })
    });
    await pdv.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 30, totalVenda: 50 });
    assert.equal(pdv.PagamentoSequencial.autorizacaoDigitalPendente(), true);
    pdv.PagamentoSequencial.registrarComposicao({ sucesso: true });
    assert.equal(pdv.PagamentoSequencial.composicaoValida(), false);
  });

  it('aceita a sequência PIX, débito e dinheiro e o dinheiro isolado', async () => {
    await aprovar('pix', 20, 801);
    await aprovar('cartao_debito', 15, 802);
    await pdv.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 15, totalVenda: 50 });
    assert.equal(pdv.PagamentoSequencial.soma(), 50);
    pdv.PagamentoSequencial.registrarComposicao({ sucesso: true });
    assert.equal(pdv.PagamentoSequencial.composicaoValida(), true);

    pdv.PagamentoSequencial.reset();
    await pdv.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 50, totalVenda: 50 });
    assert.equal(pdv.PagamentoSequencial.soma(), 50);
    assert.equal(pdv.PagamentoSequencial.composicaoValida(), false);
  });

  it('não registra cobrança sem aprovação, repetida ou já vinculada', async () => {
    const sem = await pdv.MobilePdv.vincularCobrancaConfirmada({
      retorno: { aprovado: false, codigo: 'TRANSACAO_JA_VINCULADA' },
      forma: 'pix',
      valor: 20,
      totalVenda: 50
    });
    assert.equal(sem.ok, false);
    assert.equal(sem.codigo, 'SEM_CONFIRMACAO');
    assert.equal(pdv.PagamentoSequencial.snapshot().length, 0);

    const primeira = await pdv.MobilePdv.vincularCobrancaConfirmada({
      retorno: { aprovado: true, transacao_id: 900, valor: 20, tipo: 'pix' },
      forma: 'pix',
      valor: 20,
      totalVenda: 50
    });
    assert.equal(primeira.ok, true);
    const repetida = await pdv.MobilePdv.vincularCobrancaConfirmada({
      retorno: { aprovado: true, transacao_id: 900, valor: 20, tipo: 'pix' },
      forma: 'pix',
      valor: 20,
      totalVenda: 50
    });
    assert.equal(repetida.codigo, 'TRANSACAO_JA_VINCULADA');
    assert.equal(pdv.PagamentoSequencial.soma(), 20);
  });

  it('o celular não chama o autorizador e o botão abre a digitação', async () => {
    let chamadas = 0;
    const retorno = await pdv.MobilePdv.autorizarEletronico('pix', 20, 'chave', async () => {
      chamadas += 1;
      return { ok: true };
    });
    assert.equal(retorno.codigo, 'TEF_ESTACAO');
    assert.equal(chamadas, 0);
    const js = ler('frontend/mobile-pdv/mobile-pdv.js');
    const html = ler('frontend/mobile-pdv/index.html');
    assert.match(js, /dialogo\.showModal\(\)/);
    assert.match(js, /eletronica && !estacaoComPinpad\(\)/);
    assert.match(html, /id="mv-dialogo-valor"/);
    assert.match(js, /\/vendas\/composicao-sequencial/);
    assert.doesNotMatch(js, /PERCENTUAL_TOLERANCIA|0\.20 \* dinheiro/);
  });
});

describe('fechamento e tolerância oficiais', () => {
  it('bloqueia saldo pendente e repete o fechamento sem outra venda', async () => {
    const pdv = carregarPdv();
    pdv.PagamentoSequencial.reset();
    await pdv.PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 20,
      totalVenda: 50,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 1 })
    });
    let posts = 0;
    const pendente = await pdv.MobilePdv.fechar({
      fetch: async () => {
        posts += 1;
        return { ok: true, json: async () => ({ sucesso: true, valor_fiscal: 20, valor_nao_fiscal: 0 }) };
      },
      itens: [itemVenda],
      total: 50,
      desconto: 0,
      handoff: null,
      chave: 'pdv-07-saldo',
      enviando: false,
      vendaPersistida: null
    });
    assert.equal(pendente.ok, false);
    assert.equal(pendente.codigo, 'SALDO_PENDENTE');

    pdv.PagamentoSequencial.reset();
    await pdv.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 50, totalVenda: 50 });
    pdv.PagamentoSequencial.registrarComposicao({ sucesso: true });
    const urls = [];
    const pago = await pdv.MobilePdv.fechar({
      fetch: async (url) => {
        urls.push(String(url));
        if (String(url).includes('pre-calcular')) {
          return { ok: true, json: async () => ({ sucesso: true, valor_fiscal: 0, valor_nao_fiscal: 50 }) };
        }
        return { ok: true, json: async () => ({ id: 880 }) };
      },
      itens: [itemVenda],
      total: 50,
      desconto: 0,
      handoff: null,
      chave: 'pdv-07-pago',
      enviando: false,
      vendaPersistida: null,
      tefHabilitado: false
    });
    assert.equal(pago.ok, true);
    assert.equal(pago.vendaId, 880);
    assert.equal(pago.corpo.emitir_fiscal, false);
    assert.equal(pago.chave, 'pdv-07-pago');

    const repetido = await pdv.MobilePdv.fechar({
      fetch: async () => { throw new Error('segunda gravação'); },
      itens: [itemVenda],
      total: 50,
      chave: 'pdv-07-pago',
      vendaPersistida: { id: pago.vendaId }
    });
    assert.equal(repetido.ok, false);
    assert.equal(repetido.bloqueado, true);
    assert.match(repetido.mensagem, /já foi registrada/);
    assert.ok(posts >= 1);
  });

  it('distribuição não autorizada não emite e a tolerância continua oficial', () => {
    const pdv = carregarPdv();
    return pdv.MobilePdv.solicitarEmissao({
      vendaId: 10,
      distribuicaoAutorizada: false,
      transmitir: false,
      fetch: async () => { throw new Error('não transmitir'); }
    }).then((pedido) => {
      assert.equal(pedido.codigo, 'DISTRIBUICAO_NAO_AUTORIZADA');
      const tolerancia = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
      const margem = tolerancia.calcularMargemToleranciaDinheiro([
        { forma_pagamento: 'dinheiro', valor: 15 }
      ]);
      assert.equal(margem.percentual, 0.2);
      assert.equal(margem.margem_maxima, 3);
      assert.equal(margem.nao_e_desconto, true);
      const inteiros = tolerancia.listarTotaisFiscaisQuantidadeInteira([
        { quantidade: 2, preco_unitario: 10 }
      ], 2000);
      assert.deepEqual(inteiros, [0, 10, 20]);
      const fracionado = tolerancia.listarTotaisFiscaisQuantidadeInteira([
        { quantidade: 1.5, preco_unitario: 10 }
      ], 2000);
      assert.deepEqual(fracionado, []);
      const rota = ler('backend/rotas/vendas.js');
      assert.match(rota, /integrarPagamentoRecomposicao/);
    });
  });

  it('voltar ao início preserva a operação e não troca o operador', () => {
    const memoria = new Map();
    const local = new Map([['user', JSON.stringify({ id: 8, nome: 'Operador A' })]]);
    global.sessionStorage = {
      getItem(chave) { return memoria.has(chave) ? memoria.get(chave) : null; },
      setItem(chave, valor) { memoria.set(chave, String(valor)); },
      removeItem(chave) { memoria.delete(chave); }
    };
    global.localStorage = {
      getItem(chave) { return local.has(chave) ? local.get(chave) : null; },
      setItem(chave, valor) { local.set(chave, String(valor)); },
      removeItem(chave) { local.delete(chave); }
    };
    delete require.cache[require.resolve('../../frontend/shared/js/cds-mobile-operacao.js')];
    require('../../frontend/shared/js/cds-mobile-operacao.js');
    const operacao = global.CdsMobileOperacao;
    operacao.salvarPdv({
      itens: [{ produto_id: 4, quantidade: 1, subtotal: 20, nome: 'Pastel' }],
      total: 50,
      pagamento: { parcelas: [{ local_id: 1, forma_pagamento: 'pix', valor: 20, status_autorizacao: 'aprovada' }] }
    });
    local.set('user', JSON.stringify({ id: 9, nome: 'Operador B' }));
    const leitura = operacao.lerPdv();
    assert.equal(leitura.codigo, 'OPERADOR_DIVERGENTE');
    assert.equal(operacao.pdvEmAndamento(leitura.registro), true);
    assert.doesNotMatch(ler('frontend/mobile/mobile-inicio.js'), /limparPdv|sessionStorage\.clear/);
  });
});
