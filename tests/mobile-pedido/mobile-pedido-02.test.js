/**
 * MOBILE-PEDIDO-02 — casca mobile do pedido.
 * Banco temporário só na gravação. Não emite NFC-e, não chama TEF e não abre o PDV.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pedido/mobile-pedido-02.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobped02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const ROOT = path.join(__dirname, '..', '..');

function ler(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function carregar(opcoes = {}) {
  const memoria = new Map(Object.entries(opcoes.storage || {}));
  const contexto = {
    console,
    crypto: opcoes.crypto || crypto,
    URLSearchParams,
    setTimeout: opcoes.setTimeout || setTimeout,
    clearTimeout: opcoes.clearTimeout || clearTimeout,
    API_URL: 'http://cds.test/api',
    localStorage: {
      getItem(chave) { return memoria.has(chave) ? memoria.get(chave) : null; },
      setItem(chave, valor) { memoria.set(chave, String(valor)); },
      removeItem(chave) { memoria.delete(chave); }
    },
    location: {
      origin: 'http://cds.test',
      href: '/mobile-pedido',
      search: opcoes.search || '',
      replace(url) { this.href = url; }
    },
    document: opcoes.document || {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; }
    },
    fetch: opcoes.fetch || (async () => { throw new Error('fetch não configurado'); }),
    CdsEmpresaContexto: opcoes.contexto || null,
    CdsMobileOperacao: opcoes.operacao || null
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(ler('frontend/erp/js/pedidos.js'), contexto);
  vm.runInContext(ler('frontend/mobile-pedido/mobile-pedido.js'), contexto);
  return contexto;
}

function contextoEmpresa(id = 7) {
  return {
    temEmpresaSelecionada() { return true; },
    lerEmpresa() { return { id, nome_fantasia: 'Esquinao', razao_social: 'Esquinao' }; },
    headersJson() {
      return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-mobile',
        'X-Empresa-Id': String(id)
      };
    },
    headersAuth() { return this.headersJson(); }
  };
}

function produtoPedido(extra = {}) {
  return Object.assign({
    id: 747,
    nome: 'Pastel de carne',
    nome_comercial: 'Pastel de carne',
    codigo: '747',
    preco_venda: 8.99,
    preco_pedido: 8.99,
    preco_promocional: null
  }, extra);
}

function telaProdutos() {
  const elementos = new Map();
  const timers = new Map();
  let ultimoTimer = 0;
  const documento = {
    readyState: 'complete',
    activeElement: null,
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!elementos.has(id)) {
        const el = {
          value: '', hidden: false, textContent: '', disabled: false,
          listeners: {},
          classList: { toggle() {} },
          addEventListener(tipo, fn) { this.listeners[tipo] = fn; },
          emit(tipo) { return this.listeners[tipo] && this.listeners[tipo]({ target: this }); },
          focus() { documento.activeElement = this; },
          querySelectorAll(seletor) {
            if (id !== 'mp-produto-lista' || seletor !== 'button') return [];
            return this.botoes;
          },
          set innerHTML(valor) {
            this.html = valor;
            this.botoes = Array.from(valor.matchAll(/data-id="(\d+)"/g), (match) => ({
              listeners: {},
              getAttribute() { return match[1]; },
              addEventListener(tipo, fn) { this.listeners[tipo] = fn; },
              emit(tipo) { return this.listeners[tipo](); }
            }));
          },
          get innerHTML() { return this.html; }
        };
        el.innerHTML = '';
        elementos.set(id, el);
      }
      return elementos.get(id);
    }
  };
  return {
    documento,
    elemento: (id) => documento.getElementById(id),
    setTimeout(fn) { const id = ++ultimoTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    executarBusca() {
      const entrada = timers.entries().next().value;
      assert.ok(entrada, 'Busca agendada');
      timers.delete(entrada[0]);
      return entrada[1]();
    }
  };
}

describe('Mobile Pedido — página e contrato', () => {
  const html = ler('frontend/mobile-pedido/index.html');
  const js = ler('frontend/mobile-pedido/mobile-pedido.js');
  const servidor = ler('backend/server.js');

  it('é uma página própria, sem o modal desktop e sem abrir o PDV', () => {
    assert.match(servidor, /\/mobile-pedido/);
    assert.match(html, /data-painel="cliente"/);
    assert.match(html, /data-painel="produtos"/);
    assert.match(html, /data-painel="carrinho"/);
    assert.match(html, /data-painel="conferencia"/);
    assert.match(html, /Pedido gravado/);
    assert.match(html, /não é uma venda/);
    assert.equal(html.includes('modal-xl'), false);
    assert.equal(html.includes('/pdv'), false);
    assert.equal(js.includes('/pdv'), false);
    assert.equal(js.includes('CARDAPIO_WEB'), false);
    assert.equal(js.includes('PedidoLoader'), false);
    assert.match(js, /\/pedidos/);
    const acesso = require('../../frontend/shared/js/pdv-acesso-oficial');
    assert.equal(acesso.destinoNavegacaoSeguro('/mobile-pedido'), '/mobile-pedido');
    assert.equal(acesso.destinoNavegacaoSeguro('https://evil.example'), null);
  });

  it('exige sessão e bloqueia a gravação sem empresa', async () => {
    const semSessao = carregar();
    assert.equal(semSessao.MobilePedido.exigirSessao(), false);
    assert.equal(semSessao.location.href, '/login?next=/mobile-pedido');

    const comSessao = carregar({
      storage: { token: 'tok-mobile' },
      contexto: contextoEmpresa()
    });
    assert.equal(comSessao.MobilePedido.exigirSessao(), true);

    const estado = comSessao.MobilePedido.criarEstado();
    comSessao.MobilePedido.adicionarItem(estado, {
      produtoId: 747,
      nome: 'Pastel de carne',
      quantidade: 1,
      precoBase: 8.99,
      snapshot: comSessao.cdsPedidoResolverPrecoSugerido(produtoPedido(), 8.99, 'PRECO_VENDA').snapshot
    });
    comSessao.CdsEmpresaContexto = {
      temEmpresaSelecionada() { return false; },
      headersJson() { return { Authorization: 'Bearer tok-mobile' }; }
    };
    let chamadas = 0;
    const resultado = await comSessao.MobilePedido.gravar(estado, async () => { chamadas += 1; });
    assert.equal(resultado.ok, false);
    assert.equal(resultado.codigo, 'EMPRESA_CONTEXT_REQUIRED');
    assert.equal(resultado.mantemCarrinho, true);
    assert.equal(estado.itens.length, 1);
    assert.equal(chamadas, 0);
  });

  it('recupera identificação da mesa e a mantém no pedido sem exigir cadastro', async () => {
    for (const cliente of [{ id: null, nome: 'Visitante' }, { id: 5, nome: 'Ana' }]) {
      const tela = telaProdutos();
      let atual;
      let removida = false;
      const operacao = {
        lerPedido: () => ({ ok: false }),
        salvarPedido: (estado) => { atual = { ...estado }; return { ok: true }; },
        lerClienteMesa: (mesaId, atendimentoId) => {
          assert.equal(mesaId, 2);
          assert.equal(atendimentoId, 9);
          return { ok: true, registro: { cliente } };
        },
        limparClienteMesa: () => { removida = true; return { ok: true }; }
      };
      const ctx = carregar({
        search: '?mesa=2',
        storage: { token: 'tok-mobile' },
        contexto: Object.assign(contextoEmpresa(7), {
          lerEmpresaId: () => 7,
          listarDisponiveis: async () => [{ id: 7 }]
        }),
        operacao,
        document: tela.documento,
        fetch: async () => ({ ok: true, json: async () => ({ situacao: 'OCUPADA', numero: 12, atendimento: { id: 9 } }) })
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tela.elemento('mp-cliente-escolhido').textContent, 'Cliente: ' + cliente.nome);
      assert.equal(removida, true);
      const payload = ctx.MobilePedido.montarPayload(atual);
      assert.equal(payload.mesa_id, 2);
      assert.equal(payload.cliente_id, cliente.id);
      assert.equal(payload.cliente_nome, cliente.id ? undefined : cliente.nome);
    }
  });

  it('pesquisa cliente e produto e mostra o erro em vez de escondê-lo', async () => {
    const ctx = carregar({ storage: { token: 'tok-mobile' }, contexto: contextoEmpresa() });
    const clientes = await ctx.MobilePedido.buscarClientes('ana', async (url) => {
      assert.match(url, /\/clientes\/buscar\?termo=ana/);
      return { ok: true, json: async () => [{ id: 3, nome: 'Ana', cpf_cnpj: '123', telefone: '88' }] };
    }, ctx.CdsEmpresaContexto.headersAuth());
    assert.equal(clientes.itens[0].nome, 'Ana');

    const falhaCliente = await ctx.MobilePedido.buscarClientes('ana', async () => {
      return { ok: false, status: 500, json: async () => ({ error: 'Falha ao buscar clientes' }) };
    }, {});
    assert.equal(falhaCliente.itens.length, 0);
    assert.match(falhaCliente.mensagem, /Falha ao buscar clientes/);

    const produtos = await ctx.MobilePedido.buscarProdutos('pastel', async (url) => {
      assert.match(url, /\/produtos\/consulta-pedido\/buscar\?q=pastel&limite=15/);
      return { ok: true, json: async () => [produtoPedido()] };
    }, ctx.CdsEmpresaContexto.headersAuth());
    assert.equal(produtos.itens[0].nome, 'Pastel de carne');
    assert.equal(produtos.itens[0].preco, 8.99);
    assert.equal(produtos.itens[0].origem, 'PRECO_PEDIDO');

    const falhaProduto = await ctx.MobilePedido.buscarProdutos('x', async () => {
      throw new Error('rede');
    }, {});
    assert.match(falhaProduto.mensagem, /Sem conexão ao pesquisar produtos/);
  });

  it('limpa pesquisa após inclusões confirmadas, preservando o carrinho e falhas', async () => {
    const tela = telaProdutos();
    const produtos = [
      produtoPedido({ id: 747, nome: 'Pastel de carne', nome_comercial: 'Pastel de carne' }),
      produtoPedido({ id: 748, nome: 'Refrigerante', nome_comercial: 'Refrigerante', codigo: '748' })
    ];
    carregar({
      storage: { token: 'tok-mobile' },
      contexto: Object.assign(contextoEmpresa(), {
        listarDisponiveis: async () => [{ id: 7 }],
        adotarEmpresaPadrao: async () => ({ empresa: { id: 7 } })
      }),
      document: tela.documento, setTimeout: tela.setTimeout, clearTimeout: tela.clearTimeout,
      fetch: async (url) => {
        if (url.includes('/consulta-pedido/buscar')) {
          const termo = new URL(url).searchParams.get('q');
          return { ok: true, json: async () => produtos.filter((p) => p.nome.toLowerCase().includes(termo.toLowerCase())) };
        }
        const id = Number(url.match(/\/produtos\/(\d+)$/)[1]);
        return { ok: true, json: async () => produtos.find((p) => p.id === id) };
      }
    });
    const busca = tela.elemento('mp-produto-busca');
    const lista = tela.elemento('mp-produto-lista');
    const quantidade = tela.elemento('mp-produto-qtd');
    const adicionar = tela.elemento('mp-adicionar');
    for (const termo of ['pastel', 'refrigerante']) {
      busca.value = termo;
      busca.emit('input');
      await tela.executarBusca();
      await lista.querySelectorAll('button')[0].emit('click');
      if (termo === 'pastel') {
        quantidade.value = '0';
        adicionar.emit('click');
        assert.equal(busca.value, termo);
        assert.match(lista.innerHTML, /Pastel de carne/);
        assert.match(tela.elemento('mp-alerta').textContent, /quantidade maior que zero/);
        quantidade.value = '2';
      }
      adicionar.emit('click');
      assert.equal(busca.value, '');
      assert.equal(lista.innerHTML, '');
      assert.equal(tela.elemento('mp-produto-status').hidden, true);
      assert.equal(tela.documento.activeElement, busca);
    }
    assert.match(tela.elemento('mp-carrinho-lista').innerHTML, /Pastel de carne/);
    assert.match(tela.elemento('mp-carrinho-lista').innerHTML, /Refrigerante/);
    assert.match(tela.elemento('mp-carrinho-lista').innerHTML, /value="2"/);
    busca.value = 'inexistente';
    busca.emit('input');
    await tela.executarBusca();
    assert.equal(busca.value, 'inexistente');
    assert.match(lista.innerHTML, /Nenhum produto encontrado/);
  });

  it('ignora resposta de pesquisa anterior que chega após a inclusão', async () => {
    const tela = telaProdutos();
    let resolverPesquisa;
    const produto = produtoPedido();
    carregar({
      storage: { token: 'tok-mobile' },
      contexto: Object.assign(contextoEmpresa(), {
        listarDisponiveis: async () => [{ id: 7 }],
        adotarEmpresaPadrao: async () => ({ empresa: { id: 7 } })
      }),
      document: tela.documento, setTimeout: tela.setTimeout, clearTimeout: tela.clearTimeout,
      fetch: async (url) => {
        if (url.includes('/consulta-pedido/buscar')) {
          if (url.includes('q=pendente')) {
            return new Promise((resolve) => { resolverPesquisa = resolve; });
          }
          return { ok: true, json: async () => [produto] };
        }
        return { ok: true, json: async () => produto };
      }
    });
    const busca = tela.elemento('mp-produto-busca');
    const lista = tela.elemento('mp-produto-lista');
    busca.value = 'pastel';
    busca.emit('input');
    await tela.executarBusca();
    await lista.querySelectorAll('button')[0].emit('click');
    busca.value = 'pendente';
    busca.emit('input');
    const pesquisa = tela.executarBusca();
    tela.elemento('mp-adicionar').emit('click');
    resolverPesquisa({ ok: true, json: async () => [produto] });
    await pesquisa;
    assert.equal(busca.value, '');
    assert.equal(lista.innerHTML, '');
    assert.equal(tela.elemento('mp-produto-status').hidden, true);
    assert.match(tela.elemento('mp-carrinho-lista').innerHTML, /Pastel de carne/);
  });

  it('novo pedido de mesa não restaura confirmação anterior nem descarta outro rascunho', () => {
    for (const [salvo, etapaEsperada, itensEsperados] of [
      [{ etapa: 'confirmado', confirmacao: { id: 5 }, itens: [] }, 'cliente', 0],
      [{ etapa: 'produtos', confirmacao: null, itens: [{ editorId: '1', nome: 'Pendente', quantidade: 1, precoUnitario: 10 }] }, 'produtos', 1],
      [{ etapa: 'confirmado', confirmacao: { id: 6 }, itens: [] }, 'confirmado', 0]
    ]) {
      const tela = telaProdutos();
      let gravado;
      const operacao = {
        lerPedido(mesaId) {
          assert.equal(mesaId, 2);
          return { ok: true, registro: { estado: salvo } };
        },
        salvarPedido(estado) {
          gravado = { mesaId: estado.mesaId, etapa: estado.etapa, itens: estado.itens.length };
        }
      };
      carregar({
        search: '?mesa=2&novoApos=5',
        storage: { token: 'tok-mobile' },
        contexto: Object.assign(contextoEmpresa(), {
          listarDisponiveis: async () => [{ id: 7 }],
          adotarEmpresaPadrao: async () => ({ empresa: { id: 7 } })
        }),
        operacao,
        document: tela.documento,
        fetch: async () => ({ ok: true, json: async () => ({ situacao: 'OCUPADA', numero: 2, atendimento: { id: 9 } }) })
      });

      it('oferece seleção de mesa e mostra a mesa durante o pedido e na confirmação', async () => {
        assert.match(html, /href="\/mobile-mesas\/"[^>]*>Selecionar mesa<\/a>/);
        for (const [search, salvo, rotulo, mesa] of [
          ['', null, 'Pedido sem mesa', 'Sem mesa'],
          ['?mesa=2', null, 'Mesa selecionada: 12', '12'],
          ['?mesa=2', { etapa: 'confirmado', confirmacao: { id: 5, codigo: 'PED-5', empresaId: 7, total: 10 }, itens: [] }, 'Mesa selecionada: 12', '12']
        ]) {
          const tela = telaProdutos();
          carregar({
            search,
            storage: { token: 'tok-mobile' },
            contexto: Object.assign(contextoEmpresa(), {
              listarDisponiveis: async () => [{ id: 7 }],
              adotarEmpresaPadrao: async () => ({ empresa: { id: 7 } })
            }),
            operacao: {
              lerPedido: () => salvo ? { ok: true, registro: { estado: salvo } } : { ok: false },
              salvarPedido: () => ({ ok: true })
            },
            document: tela.documento,
            fetch: async () => ({ ok: true, json: async () => ({ situacao: 'OCUPADA', numero: 12, atendimento: { id: 9 } }) })
          });

          it('mantém a empresa selecionada ao abrir pedido de mesa', async () => {
            const tela = telaProdutos();
            let padraoChamado = false;
            let cabecalhoMesa;
            carregar({
              search: '?mesa=2',
              storage: { token: 'tok-mobile' },
              contexto: Object.assign(contextoEmpresa(7), {
                lerEmpresaId: () => 7,
                listarDisponiveis: async () => [{ id: 7 }, { id: 8 }],
                adotarEmpresaPadrao: async () => { padraoChamado = true; }
              }),
              document: tela.documento,
              fetch: async (_url, opcoes) => {
                cabecalhoMesa = opcoes.headers['X-Empresa-Id'];
                return { ok: true, json: async () => ({ situacao: 'OCUPADA', numero: 12, atendimento: { id: 9 } }) };
              }
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(padraoChamado, false);
            assert.equal(cabecalhoMesa, '7');
            assert.equal(tela.elemento('mp-mesa-escolhida').textContent, 'Mesa selecionada: 12');
          });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(tela.elemento('mp-mesa-escolhida').textContent, rotulo);
          assert.match(tela.elemento('mp-resumo').innerHTML, new RegExp('<strong>Mesa</strong><br>' + mesa));
          if (salvo) assert.match(tela.elemento('mp-confirmacao').innerHTML, /<strong>Mesa<\/strong><br>12/);
        }
      });
      assert.deepEqual(gravado, { mesaId: 2, etapa: etapaEsperada, itens: itensEsperados });
    }
  });

  it('aplica preco_pedido, promoção e preco_venda pela regra do ERP', () => {
    const ctx = carregar();
    const pedido = ctx.MobilePedido.precoSugerido(produtoPedido({ preco_pedido: 7, preco_venda: 10, preco_promocional: 8 }));
    assert.equal(pedido.precoInicial, 7);
    assert.equal(pedido.snapshot.origem_preco_sugerido, 'PRECO_PEDIDO');

    const promocao = ctx.MobilePedido.precoSugerido(produtoPedido({
      preco_pedido: null,
      preco_promocional: 8,
      preco_venda: 10
    }));
    assert.equal(promocao.precoInicial, 8);
    assert.equal(promocao.snapshot.origem_preco_sugerido, 'PROMOCAO');

    const venda = ctx.MobilePedido.precoSugerido(produtoPedido({
      preco_pedido: null,
      preco_promocional: null,
      preco_venda: 10
    }));
    assert.equal(venda.precoInicial, 10);
    assert.equal(venda.snapshot.origem_preco_sugerido, 'PRECO_VENDA');
  });

  it('inclui, altera e remove itens e mantém o carrinho ao trocar de etapa', () => {
    const ctx = carregar();
    const estado = ctx.MobilePedido.criarEstado();
    const snapshot = ctx.cdsPedidoResolverPrecoSugerido(produtoPedido(), 8.99, 'PRECO_VENDA').snapshot;
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: 747, nome: 'Pastel de carne', codigo: '747', quantidade: 2, precoBase: 8.99, snapshot
    });
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: 748, nome: 'Refrigerante', codigo: '748', quantidade: 1, precoBase: 12.99,
      snapshot: ctx.cdsPedidoResolverPrecoSugerido(produtoPedido({ id: 748, preco_venda: 12.99, preco_pedido: 12.99 }), 12.99, 'PRECO_VENDA').snapshot
    });
    assert.equal(estado.itens.length, 2);
    assert.equal(estado.itens[0].subtotal, 17.98);
    ctx.MobilePedido.alterarQuantidade(estado, estado.itens[0].editor_id, 3);
    assert.equal(estado.itens[0].quantidade, 3);
    assert.equal(estado.itens[0].subtotal, 26.97);
    ctx.MobilePedido.alterarDescontoItem(estado, estado.itens[1].editor_id, 10);
    assert.equal(estado.itens[1].subtotal, 11.69);
    ctx.MobilePedido.irPara(estado, 'cliente');
    ctx.MobilePedido.irPara(estado, 'produtos');
    ctx.MobilePedido.irPara(estado, 'conferencia');
    assert.equal(estado.itens.length, 2);
    ctx.MobilePedido.removerItem(estado, estado.itens[1].editor_id);
    assert.equal(estado.itens.length, 1);
    const totais = ctx.MobilePedido.calcularTotais(estado);
    assert.equal(totais.subtotal, 26.97);
    assert.equal(totais.total, 26.97);
  });

  it('personaliza o item com a mesma conta de adicionais do ERP', () => {
    const ctx = carregar();
    const estado = ctx.MobilePedido.criarEstado();
    const ficha = {
      itens: [
        { insumo_id: 1, insumo_nome: 'Queijo', quantidade: 1, unidade: 'UN', classificacao_comercial: 'OPCIONAL_COM_ADICIONAL', preco_adicional: 2 },
        { insumo_id: 2, insumo_nome: 'Massa', quantidade: 1, unidade: 'UN', classificacao_comercial: 'OBRIGATORIO_OCULTO', preco_adicional: 0 }
      ]
    };
    const snapshot = ctx.cdsPedidoResolverPrecoSugerido(produtoPedido(), 8.99, 'PRECO_VENDA').snapshot;
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: 747,
      nome: 'Pastel de carne',
      quantidade: 2,
      precoBase: 8.99,
      desconto: 0,
      snapshot,
      personalizado: true,
      ingredientesFicha: ficha.itens,
      selecao: [1],
      ingredientes: ctx.MobilePedido.ingredientesDaFicha(ficha, [1])
    });
    const item = estado.itens[0];
    assert.equal(item.preco_unitario, 10.99);
    assert.equal(item.subtotal, 21.98);
    assert.equal(item.personalizacao_ingredientes_snapshot, 1);
    const apiItem = ctx.MobilePedido.itemParaApi(item);
    assert.deepEqual(apiItem.ingredientes_selecionados, [1]);
    assert.equal(apiItem.preco_base_unitario, 8.99);
    assert.equal(Object.prototype.hasOwnProperty.call(apiItem, 'canal'), false);
  });

  it('envia o payload do ERP com Idempotency-Key, sem canal, e bloqueia o segundo clique', async () => {
    const chamadas = [];
    let liberar;
    const ctx = carregar({
      storage: { token: 'tok-mobile' },
      contexto: contextoEmpresa(4)
    });
    const estado = ctx.MobilePedido.criarEstado();
    ctx.MobilePedido.selecionarCliente(estado, { id: 9, nome: 'Ana' });
    estado.observacao = 'Sem cebola';
    estado.desconto = 1;
    const snapshot = ctx.cdsPedidoResolverPrecoSugerido(produtoPedido(), 8.99, 'PRECO_VENDA').snapshot;
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: 747, nome: 'Pastel de carne', codigo: '747', quantidade: 2, precoBase: 8.99, snapshot
    });
    const fetchLento = (url, opcoes) => {
      chamadas.push({ url, opcoes });
      return new Promise((resolve) => {
        liberar = () => resolve({
          ok: true,
          status: 201,
          json: async () => ({ success: true, pedido: { id: 55, codigo: 'PED-55', origem_canal: 'EQUIPE' } })
        });
      });
    };
    const primeiro = ctx.MobilePedido.gravar(estado, fetchLento);
    const segundo = await ctx.MobilePedido.gravar(estado, fetchLento);
    assert.equal(segundo.bloqueado, true);
    assert.equal(chamadas.length, 1);
    liberar();
    const resultado = await primeiro;
    assert.equal(resultado.ok, true);
    assert.equal(resultado.pedido.codigo, 'PED-55');
    assert.equal(estado.etapa, 'confirmado');
    assert.equal(estado.confirmacao.codigo, 'PED-55');
    assert.equal(estado.confirmacao.cliente.nome, 'Ana');
    assert.equal(estado.itens.length, 0);

    const envio = chamadas[0];
    assert.equal(envio.opcoes.method, 'POST');
    assert.match(envio.url, /\/api\/pedidos$/);
    assert.equal(envio.opcoes.headers['X-Empresa-Id'], '4');
    assert.equal(envio.opcoes.headers.Authorization, 'Bearer tok-mobile');
    assert.ok(envio.opcoes.headers['Idempotency-Key']);
    const corpo = JSON.parse(envio.opcoes.body);
    assert.equal(corpo.cliente_id, 9);
    assert.equal(corpo.status, 'PEDIDO');
    assert.equal(corpo.tipo, 'pedido');
    assert.equal(corpo.observacao, 'Sem cebola');
    assert.equal(corpo.desconto, 1);
    assert.equal(corpo.total, 16.98);
    assert.equal(corpo.itens[0].origem_preco_sugerido, 'PRECO_PEDIDO');
    assert.equal(corpo.itens[0].preco_pedido_snapshot, 8.99);
    assert.equal(corpo.itens[0].preco_sugerido_snapshot, 8.99);
    assert.equal(Object.prototype.hasOwnProperty.call(corpo, 'canal'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(corpo, 'origem_canal'), false);
    assert.equal(JSON.stringify(envio).includes('/pdv'), false);
  });

  it('grava pelo HTTP do celular, onde randomUUID não existe', async () => {
    const chamadas = [];
    const ctx = carregar({
      storage: { token: 'tok-mobile' },
      contexto: contextoEmpresa(4),
      crypto: {
        getRandomValues(buffer) {
          for (let i = 0; i < buffer.length; i += 1) buffer[i] = (i * 17 + 3) & 255;
          return buffer;
        }
      },
      fetch: async (url, opcoes) => {
        chamadas.push({ url, opcoes });
        return {
          ok: true,
          status: 201,
          json: async () => ({ success: true, pedido: { id: 70, codigo: 'PED-70' } })
        };
      }
    });
    const estado = ctx.MobilePedido.criarEstado();
    const snapshot = ctx.cdsPedidoResolverPrecoSugerido(produtoPedido(), 8.99, 'PRECO_VENDA').snapshot;
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: 747, nome: 'Pastel de carne', quantidade: 1, precoBase: 8.99, snapshot
    });
    const resultado = await ctx.MobilePedido.gravar(estado, ctx.fetch);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.pedido.codigo, 'PED-70');
    assert.match(chamadas[0].opcoes.headers['Idempotency-Key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('mantém o carrinho e traduz os erros conhecidos do backend', async () => {
    const ctx = carregar({ storage: { token: 't' }, contexto: contextoEmpresa() });
    const estado = ctx.MobilePedido.criarEstado();
    const snapshot = ctx.cdsPedidoResolverPrecoSugerido(produtoPedido(), 8.99, 'PRECO_VENDA').snapshot;
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: 747, nome: 'Pastel', quantidade: 1, precoBase: 8.99, snapshot
    });
    const casos = [
      ['PEDIDO_TOTAL_INCONSISTENTE', 400],
      ['UNIDADE_ESTOQUE_INVALIDA', 409],
      ['MODULO_NAO_LICENCIADO', 403]
    ];
    for (const [codigo, status] of casos) {
      const resultado = await ctx.MobilePedido.gravar(estado, async () => ({
        ok: false,
        status,
        json: async () => ({ codigo, mensagem: 'detalhe ' + codigo })
      }));
      assert.equal(resultado.ok, false);
      assert.equal(resultado.codigo, codigo);
      assert.equal(resultado.mantemCarrinho, true);
      assert.match(resultado.mensagem, new RegExp(ctx.MobilePedido.MENSAGENS[codigo].slice(0, 18)));
      assert.equal(estado.itens.length, 1);
      assert.equal(estado.etapa, 'cliente');
    }
    const rede = await ctx.MobilePedido.gravar(estado, async () => { throw new Error('offline'); });
    assert.match(rede.mensagem, /Sem conexão/);
    assert.equal(estado.itens.length, 1);
    const auth = await ctx.MobilePedido.gravar(estado, async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 'SESSAO_INVALIDA', error: 'Acesso negado' })
    }));
    assert.equal(auth.autenticacao, true);
    assert.match(auth.mensagem, /Acesso negado/);
  });
});

describe('Mobile Pedido — gravação no banco de testes', () => {
  it('grava pelo canal EQUIPE e recupera o código, sem criar venda', async () => {
    const db = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
      db.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
    const inicioColuna = Date.now();
    let temOrigem = false;
    while (Date.now() - inicioColuna < 20000) {
      const colunas = await new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(pedidos)', (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      if (colunas.some((coluna) => coluna.name === 'origem_canal')) {
        temOrigem = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(temOrigem, true, 'coluna origem_canal no banco de testes');

    const EmpresaService = require('../../backend/services/empresas/EmpresaService');
    const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
    const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
    const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
    const Entrada = require('../../backend/services/pedido/EntradaPedidoService');
    const repo = require('../../backend/services/pedido/PedidoRepository');
    const configService = require('../../backend/services/configuracaoService');

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

    const ctx = carregar();
    const estado = ctx.MobilePedido.criarEstado();
    const sugestao = ctx.MobilePedido.precoSugerido({
      preco_venda: 8.99,
      preco_pedido: 8.99,
      preco_promocional: null
    });
    ctx.MobilePedido.adicionarItem(estado, {
      produtoId: produto,
      nome: 'Pastel de carne',
      codigo: String(produto),
      quantidade: 2,
      precoBase: sugestao.precoInicial,
      snapshot: sugestao.snapshot
    });
    const body = ctx.MobilePedido.montarPayload(estado);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'canal'), false);

    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      const gravado = await Entrada.receber({
        canal: Entrada.CanalOrigem.EQUIPE,
        body,
        empresaId: empresa.id,
        operadorId: null,
        chaveIdempotencia: 'mobile-pedido-02-gravacao'
      });
      assert.equal(gravado.success, true);
      assert.equal(gravado.pedido.origem_canal, 'EQUIPE');
      assert.ok(gravado.pedido.codigo);
      const lido = await repo.obterPorId(gravado.pedido.id, { db, empresaId: empresa.id });
      assert.equal(lido.codigo, gravado.pedido.codigo);
      assert.equal(lido.origem_canal, 'EQUIPE');
      assert.equal(Number(lido.empresa_id), Number(empresa.id));
      assert.equal(lido.cliente_id, null);
      assert.equal(lido.itens.length, 1);
      assert.equal(Number(lido.itens[0].quantidade), 2);
      const vendas = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) AS n FROM vendas', (err, row) => (err ? reject(err) : resolve(row)));
      });
      assert.equal(Number(vendas.n), 0);
    } finally {
      configService.recursoHabilitado = original;
    }
  });
});
