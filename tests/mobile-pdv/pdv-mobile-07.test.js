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
  vm.runInContext(ler('frontend/pdv/js/decisaoConfirmacaoPagamento.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pagamentoSequencial.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/interacaoPagamentoMisto.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pdv-fechamento-oficial.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pdv-venda-por-valor.js'), contexto);
  vm.runInContext(ler('frontend/mobile-pdv/mobile-pdv.js'), contexto);
  return contexto;
}

async function carregarTelaPagamento(opcoes = {}) {
  const ids = {};
  const botoes = ['pix', 'cartao_debito', 'cartao_credito', 'dinheiro'].map((forma) => {
    const botao = elemento();
    botao.getAttribute = () => forma;
    return botao;
  });
  const chamadas = [];
  const estado = {
    tef: false, pix: false, modoFiscal: true, confirmar: true, pixAuto: true,
    confirmacaoAuto: true, caixaAberto: true, confirmacoesNativas: 0, ...opcoes
  };
  const contexto = {
    console, setTimeout, clearTimeout,
    API_URL: 'http://cds.test/api',
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'http://cds.test', replace() {} },
    crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' },
    CdsEmpresaContexto: {
      headersJson: () => ({ Accept: 'application/json', Authorization: 'Bearer tok', 'X-Empresa-Id': '1' }),
      async adotarEmpresaPadrao() {},
      lerEmpresaId: () => 1,
      lerEmpresa: () => ({ id: 1, nome_fantasia: 'Teste' })
    },
    confirm: () => { estado.confirmacoesNativas += 1; return estado.confirmar; },
    electronAPI: estado.electron ? {} : undefined,
    CdsMobileOperacao: {
      lerPdv: () => ({ ok: true, registro: { itens: [itemVenda], total: 50 } }),
      salvarPdv() {},
      limparPdv() {}
    },
    document: {
      readyState: 'complete',
      getElementById(id) {
        if (!ids[id]) {
          ids[id] = elemento();
          ids[id].querySelectorAll = () => [];
          ids[id].removeEventListener = (tipo, fn) => {
            if (ids[id].listeners[tipo] === fn) delete ids[id].listeners[tipo];
          };
          ids[id].showModal = () => {
            ids[id].open = true;
            if (id === 'mv-dialogo-confirmacao') {
              const pix = ids['mv-confirmacao-titulo'].textContent === 'Confirmar recebimento';
              const auto = pix ? estado.pixAuto : estado.confirmacaoAuto;
              if (auto) {
                Promise.resolve().then(() => {
                  const botao = ids[estado.confirmar
                    ? 'mv-confirmacao-confirmar'
                    : 'mv-confirmacao-cancelar'];
                  if (botao.listeners.click) botao.listeners.click();
                });
              }
            } else if (id === 'mv-dialogo-senha-admin' && estado.senhaAdminAuto !== false) {
              ids['mv-senha-admin'].value = estado.senhaAdmin || 'senha-teste';
              Promise.resolve().then(() => ids['mv-senha-admin-confirmar'].listeners.click());
            }
          };
          ids[id].close = (valor = '') => {
            if (!ids[id].open) return;
            ids[id].open = false;
            ids[id].returnValue = valor;
            const fechar = ids[id].listeners.close;
            if (fechar) fechar();
          };
        }
        return ids[id];
      },
      querySelectorAll: () => botoes,
      addEventListener() {}
    },
    fetch: async (url, opts = {}) => {
      chamadas.push({ url: String(url), method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
      if (String(url).endsWith('/terminais/mobile/registro')) {
        return { ok: true, status: 201, json: async () => ({ id: 77, tipo: 'mobile', caixa_id: 7 }) };
      }
      if (String(url).endsWith('/configuracoes/modo_dashboard_fiscal')) {
        return { ok: true, status: 200, json: async () => ({ valor: estado.modoFiscal ? '1' : '0' }) };
      }
      if (String(url).endsWith('/caixa/aberto')) {
        const caixa = estado.caixaAberto
          ? { id: 71, saldo_geral: 50, total_recebido: 50, sessao: { id: 81, caixa_turno_id: 71 } }
          : null;
        return { ok: true, status: 200, json: async () => caixa };
      }
      if (String(url).includes('/caixa/movimentacoes/')) {
        return { ok: true, status: 200, json: async () => estado.movimentacoes || [] };
      }
      if (String(url).endsWith('/caixa/fechar')) {
        const requisicao = chamadas[chamadas.length - 1];
        if (estado.adminObrigatorio && !(requisicao.body && requisicao.body.senha_admin)) {
          return {
            ok: false,
            status: 403,
            json: async () => ({ mensagem: 'Autorização administrativa necessária.', requer_senha_admin: true })
          };
        }
        estado.adminObrigatorio = false;
        estado.caixaAberto = false;
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (String(url).endsWith('/tef/fluxo-pdv')) {
        if (estado.falhaConfig) throw new Error('Rede indisponível');
        if (estado.aguardarConfig) await estado.aguardarConfig;
        return { ok: true, json: async () => ({ tefHabilitado: estado.tef, modoConfirmacaoFiscal: 'TEF' }) };
      }
      if (String(url).endsWith('/pix/config')) {
        return { ok: true, json: async () => estado.pixResposta || { success: true, config: { ativo: estado.pix } } };
      }
      if (String(url).endsWith('/tef/pagar')) {
        return { ok: true, json: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 501 }) };
      }
      if (String(url).endsWith('/vendas/composicao-sequencial')) {
        return { ok: true, json: async () => ({ sucesso: true, valor_fiscal_referencia: 20, valor_nao_fiscal_referencia: 30 }) };
      }
      if (String(url).endsWith('/vendas/pre-calcular-distribuicao')) {
        return { ok: true, json: async () => ({ sucesso: true, valor_fiscal: 50, valor_nao_fiscal: 0 }) };
      }
      if (String(url).endsWith('/vendas')) {
        return { ok: true, status: 200, json: async () => estado.respostaVenda || ({ id: 880 }) };
      }
      throw new Error('Requisição inesperada: ' + url);
    }
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  for (const arquivo of [
    'frontend/shared/js/tefFluxoPagamento.js',
    'frontend/pdv/js/decisaoConfirmacaoPagamento.js',
    'frontend/pdv/js/pagamentoSequencial.js',
    'frontend/pdv/js/interacaoPagamentoMisto.js',
    'frontend/pdv/js/pdv-fechamento-oficial.js',
    'frontend/mobile-pdv/mobile-pdv.js'
  ]) vm.runInContext(ler(arquivo), contexto);
  await new Promise((resolve) => setImmediate(resolve));
  return { contexto, ids, botoes, chamadas, estado };
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

describe('identidade da instalação Mobile', () => {
  it('persiste UUID e usa getRandomValues quando randomUUID não está disponível', () => {
    const mobile = carregarPdv().MobilePdv;
    const memoria = new Map();
    const storage = {
      getItem(chave) { return memoria.has(chave) ? memoria.get(chave) : null; },
      setItem(chave, valor) { memoria.set(chave, String(valor)); }
    };
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    const primeira = mobile.obterIdentidadeInstalacao(storage, {
      randomUUID: () => uuid
    });
    const reutilizada = mobile.obterIdentidadeInstalacao(storage, {
      getRandomValues() { throw new Error('não deve gerar novamente'); }
    });
    assert.equal(primeira, uuid);
    assert.equal(reutilizada, uuid);

    memoria.set(mobile.MOBILE_INSTALLATION_KEY, 'valor inválido');
    const fallback = mobile.obterIdentidadeInstalacao(storage, {
      getRandomValues(bytes) { bytes.fill(0x12); return bytes; }
    });
    assert.match(fallback, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(memoria.get(mobile.MOBILE_INSTALLATION_KEY), fallback);
    assert.throws(
      () => mobile.obterIdentidadeInstalacao({ getItem: () => null, setItem() {} }, {}),
      (erro) => erro.code === 'IDENTIDADE_SEGURA_INDISPONIVEL'
    );
  });
});

describe('situação fiscal no resultado da venda', () => {
  it('classifica somente com base nos campos retornados pela venda e pelo fiscal', () => {
    const mobile = carregarPdv().MobilePdv;
    const casos = [
      [{ venda: { valor_fiscal: 0, valor_nao_fiscal: 50 } }, 'Não fiscal'],
      [{ venda: { valor_fiscal: 50 }, corpo: { emitir_fiscal: true } }, 'Fiscal solicitada'],
      [{ fiscal: { status: 'xml_preparado' } }, 'Em processamento'],
      [{ fiscal: { status: 'autorizada' } }, 'Autorizada'],
      [{ fiscal: { status: 'rejeitada_duplicidade' } }, 'Rejeitada'],
      [{ fiscal: { status: 'pendente' } }, 'Pendente de processamento'],
      [{ fiscal: { status: 'erro_transmissao' } }, 'Erro na transmissão'],
      [{ fiscal: { status: 'erro_emissao' } }, 'Erro na emissão'],
      [{ venda: { valor_fiscal: 50 }, corpo: { emitir_fiscal: false } }, 'Fiscal não solicitada'],
      [{
        venda: { documento_fiscal: { bloqueado: true, motivo: 'Sem autorização fiscal.' } }
      }, 'Solicitação fiscal bloqueada'],
      [{ venda: {} }, 'Situação fiscal não informada pelo servidor']
    ];
    for (const [resultado, esperado] of casos) {
      assert.equal(mobile.descreverSituacaoFiscal(resultado).situacao, esperado);
    }
    assert.equal(mobile.valorTotalRetornado({ total: 25 }), 25);
    assert.equal(mobile.valorTotalRetornado({ valor_total: '25.50' }), 25.5);
    assert.equal(mobile.valorTotalRetornado({ valor_fiscal: 25, valor_nao_fiscal: 0 }), null);
  });

  it('exibe somente o resumo após a venda e mantém o caixa aberto ao continuar', async () => {
    const tela = await carregarTelaPagamento({
      respostaVenda: {
        id: 880,
        total: 50,
        valor_fiscal: 0,
        valor_nao_fiscal: 50,
        fiscal: null,
        documento_fiscal: null
      }
    });
    tela.botoes.find((botao) => botao.getAttribute() === 'dinheiro').listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    await tela.ids['mv-finalizar'].listeners.click();

    assert.equal(tela.ids['mv-painel-resultado'].hidden, false);
    assert.equal(tela.ids['mv-painel-venda'].hidden, true);
    assert.equal(tela.ids['mv-caixa-painel'].hidden, true);
    assert.equal(tela.ids['mv-resultado-venda'].textContent, '#880');
    assert.equal(tela.ids['mv-resultado-empresa'].textContent, 'Teste');
    assert.match(tela.ids['mv-resultado-total'].textContent, /50,00/);
    assert.equal(tela.ids['mv-resultado-fiscal-status'].textContent, 'Não fiscal');
    assert.equal(tela.ids['mv-resultado-emissao-linha'].hidden, true);
    assert.match(
      ler('frontend/mobile-pdv/index.html'),
      /id="mv-continuar-pdv"[^>]*href="\/mobile-pdv\/"/
    );
    assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/vendas')).length, 1);
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/caixa/fechar')), false);

    await tela.ids['mv-finalizar'].listeners.click();
    assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/vendas')).length, 1);
  });
});

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
      tefHabilitado: true,
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
      tefHabilitado: true,
      autorizarTef: async () => ({ aprovado: false, status: 'recusado', mensagem: 'Negado' })
    });
    assert.equal(recusa.ok, false);
    assert.equal(recusa.codigo, 'TEF_REJEITADO');

    const pendente = await pdv.PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 10,
      totalVenda: 50,
      tefHabilitado: true,
      autorizarTef: async () => ({ aprovado: false, status: 'pendente' })
    });
    assert.equal(pendente.ok, false);
    assert.equal(pendente.codigo, 'PENDENTE');

    const timeout = await pdv.PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 10,
      totalVenda: 50,
      tefHabilitado: true,
      autorizarTef: async () => ({ status: 'timeout', codigo: 'TIMEOUT' })
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.codigo, 'TIMEOUT');

    let chamadas = 0;
    const rede = await pdv.PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 10,
      totalVenda: 50,
      tefHabilitado: true,
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
      tefHabilitado: true,
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

  it('o celular não chama o autorizador e não usa confirmações nativas', async () => {
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
    assert.match(js, /configuracao\.tefHabilitado && !estacaoComPinpad\(\)/);
    assert.match(html, /id="mv-dialogo-valor"/);
    assert.match(js, /\/vendas\/composicao-sequencial/);
    assert.doesNotMatch(js, /root\.(confirm|alert|prompt)|window\.(confirm|alert|prompt)/);
    assert.doesNotMatch(js, /PERCENTUAL_TOLERANCIA|0\.20 \* dinheiro/);
  });
});

describe('pagamento manual no mobile', () => {
  it('confirma parcelas eletrônicas em modal próprio com valores, total e proteção contra duplicidade', async () => {
    const tela = await carregarTelaPagamento({ confirmacaoAuto: false });
    for (const pagamento of [
      { forma: 'cartao_debito', valor: '12.34' },
      { forma: 'cartao_credito', valor: '37.66' }
    ]) {
      tela.botoes.find((botao) => botao.getAttribute() === pagamento.forma).listeners.click();
      tela.ids['mv-valor'].value = pagamento.valor;
      await tela.ids['mv-confirmar-parcela'].listeners.click();
    }

    const finalizar = tela.ids['mv-finalizar'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tela.ids['mv-confirmacao-titulo'].textContent, 'Confirmar recebimentos');
    assert.match(tela.ids['mv-confirmacao-descricao'].textContent, /fora do CDS/);
    assert.match(tela.ids['mv-confirmacao-lista'].innerHTML, /Débito/);
    assert.match(tela.ids['mv-confirmacao-lista'].innerHTML, /Crédito/);
    assert.match(tela.ids['mv-confirmacao-lista'].innerHTML, /12,34/);
    assert.match(tela.ids['mv-confirmacao-lista'].innerHTML, /37,66/);
    assert.match(tela.ids['mv-confirmacao-total'].textContent, /50,00/);
    assert.doesNotMatch(tela.ids['mv-confirmacao-lista'].innerHTML, /cartao_/);

    await tela.ids['mv-finalizar'].listeners.click();
    assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/vendas')).length, 0);
    tela.ids['mv-confirmacao-confirmar'].listeners.click();
    await finalizar;

    assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/vendas')).length, 1);
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/tef/pagar')), false);
    assert.equal(tela.estado.confirmacoesNativas, 0);
  });

  it('modal PIX exibe valor parcial e pedido, cancela sem registrar e mantém o valor', async () => {
    const tela = await carregarTelaPagamento({ pixAuto: false });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '12.99';
    const registro = tela.ids['mv-confirmar-parcela'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tela.ids['mv-dialogo-confirmacao'].open, true);
    assert.equal(tela.ids['mv-confirmacao-total-label'].textContent, 'Valor do PIX');
    assert.match(tela.ids['mv-confirmacao-total'].textContent, /R\$\s*12,99/);
    assert.equal(tela.ids['mv-confirmacao-contexto'].textContent, 'Venda avulsa, sem pedido.');
    assert.equal(tela.estado.confirmacoesNativas, 0);
    tela.ids['mv-confirmacao-cancelar'].listeners.click();
    await registro;
    assert.equal(tela.ids['mv-dialogo-confirmacao'].open, false);
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.equal(tela.ids['mv-valor'].value, '12.99');
  });

  it('confirma PIX parcial uma vez mesmo com cliques repetidos e mantém confirmação final', async () => {
    const tela = await carregarTelaPagamento({ pixAuto: false });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '20';
    const registro = tela.ids['mv-confirmar-parcela'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    tela.ids['mv-confirmacao-confirmar'].listeners.click();
    tela.ids['mv-confirmacao-confirmar'].listeners.click();
    await registro;
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 1);
    assert.equal(tela.contexto.PagamentoSequencial.soma(), 20);
    assert.equal(tela.estado.confirmacoesNativas, 0);
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '30';
    const restante = tela.ids['mv-confirmar-parcela'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    tela.ids['mv-confirmacao-confirmar'].listeners.click();
    await restante;
    tela.estado.confirmar = false;
    await tela.ids['mv-finalizar'].listeners.click();
    assert.equal(tela.estado.confirmacoesNativas, 0);
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/vendas')), false);
  });

  describe('separação do Meu Caixa Mobile', () => {
    it('navegar não altera a sessão e o fechamento só é enviado após confirmação em Meu Caixa', async () => {
      const tela = await carregarTelaPagamento();
      const consultasAntes = tela.chamadas.filter((chamada) => chamada.url.endsWith('/caixa/aberto')).length;

      await tela.ids['mv-ir-caixa'].listeners.click();
      assert.equal(tela.ids['mv-painel-venda'].hidden, true);
      assert.equal(tela.ids['mv-caixa-painel'].hidden, false);
      assert.equal(tela.ids['mv-caixa-saldo'].textContent, 'R$ 50,00');
      assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/caixa/aberto')).length, consultasAntes);
      assert.equal(tela.chamadas.some((chamada) => (
        chamada.url.endsWith('/caixa/abrir') || chamada.url.endsWith('/caixa/fechar')
      )), false);

      tela.ids['mv-voltar-pdv'].listeners.click();
      assert.equal(tela.ids['mv-painel-venda'].hidden, false);
      assert.equal(tela.ids['mv-caixa-painel'].hidden, true);
      assert.equal(tela.chamadas.some((chamada) => (
        chamada.url.endsWith('/caixa/abrir') || chamada.url.endsWith('/caixa/fechar')
      )), false);

      await tela.ids['mv-ir-caixa'].listeners.click();
      tela.ids['mv-caixa-valor-fechamento'] = tela.contexto.document.getElementById('mv-caixa-valor-fechamento');
      tela.ids['mv-caixa-valor-fechamento'].value = '50';
      tela.estado.confirmacaoAuto = false;
      const fechar = tela.ids['mv-fechar-caixa'].listeners.click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tela.ids['mv-confirmacao-titulo'].textContent, 'Confirmar fechamento do caixa');
      assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/caixa/fechar')), false);
      tela.ids['mv-confirmacao-cancelar'].listeners.click();
      await fechar;
      assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/caixa/fechar')), false);

      tela.estado.confirmacaoAuto = true;
      tela.estado.adminObrigatorio = true;
      await tela.ids['mv-fechar-caixa'].listeners.click();
      const chamadasFechamento = tela.chamadas.filter((chamada) => chamada.url.endsWith('/caixa/fechar'));
      assert.equal(chamadasFechamento.length, 2);
      assert.match(ler('frontend/mobile-pdv/index.html'), /<h2 id="mv-senha-admin-titulo">Autorização administrativa<\/h2>/);
      assert.equal(chamadasFechamento[1].body.senha_admin, 'senha-teste');
      assert.equal(tela.ids['mv-caixa-painel'].hidden, false);
      assert.equal(tela.ids['mv-caixa-resumo-detalhe'].textContent, '');

      const html = ler('frontend/mobile-pdv/index.html');
      const venda = html.slice(html.indexOf('id="mv-painel-venda"'), html.indexOf('id="mv-caixa-painel"'));
      const meuCaixa = html.slice(html.indexOf('id="mv-caixa-painel"'), html.indexOf('id="mv-painel-resultado"'));
      assert.doesNotMatch(venda, /Valor contado para fechamento|Observação do fechamento|Fechar meu caixa/);
      assert.match(meuCaixa, /Valor contado para fechamento|Observação do fechamento|Fechar meu caixa/);
    });
  });

  it('Escape fecha o modal sem registrar PIX', async () => {
    const tela = await carregarTelaPagamento({ pixAuto: false });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '50';
    const registro = tela.ids['mv-confirmar-parcela'].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    let prevenido = false;
    tela.ids['mv-dialogo-confirmacao'].listeners.keydown({ key: 'Escape', preventDefault() { prevenido = true; } });
    await registro;
    assert.equal(prevenido, true);
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
  });

  it('não registra PIX se não for possível abrir o modal', async () => {
    const tela = await carregarTelaPagamento({ pixAuto: false });
    tela.ids['mv-dialogo-confirmacao'].showModal = () => { throw new Error('Modal indisponível'); };
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.equal(tela.ids['mv-confirmar-parcela'].disabled, false);
    assert.match(tela.ids['mv-alerta'].textContent, /Modal indisponível/);
  });

  for (const forma of ['pix', 'cartao_debito', 'cartao_credito']) {
    it(forma + ' informado sem TEF exige confirmação antes de gravar', async () => {
      const tela = await carregarTelaPagamento();
      tela.botoes.find((botao) => botao.getAttribute() === forma).listeners.click();
      tela.ids['mv-valor'].value = '50';
      await tela.ids['mv-confirmar-parcela'].listeners.click();
      const parcela = tela.contexto.PagamentoSequencial.exportar()[0];
      assert.equal(parcela.status_autorizacao, 'informada');
      assert.equal(parcela.recebimento_confirmado, false);
      assert.equal(parcela.tef_transacao_id, null);
      assert.equal(tela.contexto.InteracaoPagamentoMisto.modoConfirmacaoDireta(forma, { tefHabilitado: false }), 'informado');
      const desktop = carregarPdv();
      const interacao = desktop.InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: desktop.PagamentoSequencial });
      interacao.escolherForma(forma);
      let autorizacoes = 0;
      const registroDesktop = await interacao.confirmarValor(50, {
        tefHabilitado: false,
        pixIntegracaoHabilitada: false,
        formaUsaTef: () => false,
        autorizarTef: async () => { autorizacoes += 1; }
      });
      assert.equal(registroDesktop.ok, true);
      assert.equal(registroDesktop.parcela.status_autorizacao, parcela.status_autorizacao);
      assert.equal(autorizacoes, 0);
      tela.estado.confirmar = false;
      await tela.ids['mv-finalizar'].listeners.click();
      assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/vendas')).length, 0);
      assert.match(tela.ids['mv-alerta'].textContent, /não confirmado/);
      tela.estado.confirmar = true;
      await tela.ids['mv-finalizar'].listeners.click();
      const venda = tela.chamadas.find((chamada) => chamada.url.endsWith('/vendas'));
      assert.ok(venda);
      assert.equal(venda.body.pagamentos[0].forma_pagamento, forma);
      assert.equal(venda.body.pagamentos[0].valor, 50);
      assert.equal(venda.body.pagamentos[0].confirmacao_manual, 1);
      assert.equal(venda.body.pagamentos[0].confirmacao_operacional_externa, true);
      assert.equal(venda.body.confirmacao_fiscal_manual, true);
      assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/tef/pagar')), false);
      assert.equal(tela.chamadas.some((chamada) => chamada.url.includes('/pix/criar-cobranca')), false);
    });
  }

  it('aceita o contrato do serviço sem chave de ativação e confirma o PIX manual', async () => {
    const db = { get(_sql, _params, callback) { callback(null, undefined); } };
    const modulo = { exports: {} };
    vm.runInNewContext(ler('backend/services/pix/pixService.js'), {
      module: modulo,
      require: (nome) => nome === '../../database' ? db : {}
    });
    const config = await modulo.exports.buscarConfigPix();
    const resposta = JSON.parse(JSON.stringify({ success: true, config }));
    assert.equal(Object.prototype.hasOwnProperty.call(resposta.config, 'ativo'), false);

    const tela = await carregarTelaPagamento({ pixResposta: resposta });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot()[0].status_autorizacao, 'informada');
    await tela.ids['mv-finalizar'].listeners.click();
    const venda = tela.chamadas.find((chamada) => chamada.url.endsWith('/vendas'));
    assert.equal(venda.body.pagamentos[0].confirmacao_operacional_externa, true);
    assert.equal(tela.chamadas.some((chamada) => /\/tef\/pagar|\/pix\/(criar-cobranca|status)/.test(chamada.url)), false);
  });

  it('cancelar confirmação do PIX não registra parcela, inclusive em valor parcial', async () => {
    const tela = await carregarTelaPagamento({ confirmar: false, pixResposta: { success: true, config: { ativo: null } } });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '20';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.match(tela.ids['mv-alerta'].textContent, /parcela não foi registrada/);
    await tela.ids['mv-finalizar'].listeners.click();
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/vendas')), false);

    tela.estado.confirmar = true;
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.soma(), 20);
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '30';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.soma(), 50);
    await tela.ids['mv-finalizar'].listeners.click();
    const venda = tela.chamadas.find((chamada) => chamada.url.endsWith('/vendas'));
    assert.deepEqual(Array.from(venda.body.pagamentos, (parcela) => parcela.valor), [20, 30]);
    assert.equal(tela.chamadas.some((chamada) => /\/tef\/pagar|\/pix\/(criar-cobranca|status)/.test(chamada.url)), false);
  });

  it('continua bloqueando configuração PIX malformada', async () => {
    const tela = await carregarTelaPagamento({ pixResposta: { success: true, config: { ativo: 'false' } } });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.match(tela.ids['mv-alerta'].textContent, /Configuração de PIX inválida/);
  });

  it('não registra PIX com configuração de outra forma durante consulta pendente', async () => {
    let liberar;
    const aguardarConfig = new Promise((resolve) => { liberar = resolve; });
    const tela = await carregarTelaPagamento({ pix: true, aguardarConfig });
    tela.botoes[1].listeners.click();
    tela.ids['mv-valor'].value = '50';
    const confirmacao = tela.ids['mv-confirmar-parcela'].listeners.click();
    tela.botoes[0].listeners.click();
    liberar();
    await confirmacao;
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.match(tela.ids['mv-alerta'].textContent, /forma de pagamento foi alterada/);
  });

  it('mantém a exigência de estação com TEF ligado e bloqueia configuração indisponível', async () => {
    const tela = await carregarTelaPagamento({ tef: true });
    tela.botoes[1].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.match(tela.ids['mv-alerta'].textContent, /estação/);
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/tef/pagar')), false);
    tela.estado.falhaConfig = true;
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.match(tela.ids['mv-alerta'].textContent, /Rede indisponível/);
  });

  it('não substitui PIX automático por confirmação manual', async () => {
    const tela = await carregarTelaPagamento({ pix: true });
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.contexto.PagamentoSequencial.snapshot().length, 0);
    assert.match(tela.ids['mv-alerta'].textContent, /PIX automático/);
    assert.equal(tela.chamadas.some((chamada) => chamada.url.includes('/pix/criar-cobranca')), false);
  });

  it('preserva autorização simulada na estação quando TEF está ligado', async () => {
    const tela = await carregarTelaPagamento({ tef: true, electron: true });
    tela.botoes[1].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    assert.equal(tela.chamadas.filter((chamada) => chamada.url.endsWith('/tef/pagar')).length, 1);
    assert.equal(tela.contexto.PagamentoSequencial.exportar()[0].tef_transacao_id, 501);
  });

  it('não finaliza eletrônicos manuais se o TEF for ligado antes do fechamento', async () => {
    const tela = await carregarTelaPagamento();
    tela.botoes[2].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    tela.estado.tef = true;
    await tela.ids['mv-finalizar'].listeners.click();
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/vendas')), false);
    assert.match(tela.ids['mv-alerta'].textContent, /sem autorização/);
  });

  it('bloqueia a finalização quando PIX automático é ligado após informar PIX', async () => {
    const tela = await carregarTelaPagamento();
    tela.botoes[0].listeners.click();
    tela.ids['mv-valor'].value = '50';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    tela.estado.pix = true;
    await tela.ids['mv-finalizar'].listeners.click();
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/vendas')), false);
    assert.match(tela.ids['mv-alerta'].textContent, /PIX automático/);
  });

  it('preserva a composição oficial de cartão e dinheiro', async () => {
    const tela = await carregarTelaPagamento();
    tela.botoes[1].listeners.click();
    tela.ids['mv-valor'].value = '20';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    tela.botoes[3].listeners.click();
    tela.ids['mv-valor'].value = '30';
    await tela.ids['mv-confirmar-parcela'].listeners.click();
    const composicao = tela.chamadas.find((chamada) => chamada.url.endsWith('/vendas/composicao-sequencial'));
    assert.ok(composicao);
    assert.equal(composicao.body.pagamentos[0].recebimento_confirmado, false);
    await tela.ids['mv-finalizar'].listeners.click();
    const venda = tela.chamadas.find((chamada) => chamada.url.endsWith('/vendas'));
    assert.ok(venda);
    assert.equal(venda.body.pagamentos[0].valor, 20);
    assert.equal(venda.body.pagamentos[1].valor, 30);
    assert.equal(venda.body.pagamentos[0].confirmacao_operacional_externa, true);
    assert.equal(tela.chamadas.some((chamada) => chamada.url.endsWith('/tef/pagar')), false);
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
      tefHabilitado: true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 1 })
    });
    let posts = 0;
    const pendente = await pdv.MobilePdv.fechar({
      fetch: async (url) => {
        posts += 1;
        if (String(url).endsWith('/configuracoes/modo_dashboard_fiscal')) {
          return { ok: true, json: async () => ({ valor: '1' }) };
        }
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
        if (String(url).endsWith('/configuracoes/modo_dashboard_fiscal')) {
          return { ok: true, json: async () => ({ valor: '0' }) };
        }
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
