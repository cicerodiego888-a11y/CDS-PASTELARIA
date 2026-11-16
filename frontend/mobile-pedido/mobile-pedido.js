/**
 * Casca mobile do pedido da equipe.
 * Grava só em POST /api/pedidos. O canal continua sendo definido no servidor (EQUIPE).
 * Não reserva estoque, não abre o PDV e não emite documento fiscal.
 */
(function (root) {
  'use strict';

  const ETAPAS = ['cliente', 'produtos', 'carrinho', 'conferencia'];
  const MENSAGENS = {
    EMPRESA_CONTEXT_REQUIRED: 'Selecione a empresa antes de gravar o pedido.',
    PEDIDO_TOTAL_INCONSISTENTE: 'O total informado não confere com os itens. O pedido não foi gravado.',
    UNIDADE_ESTOQUE_INVALIDA: 'Um produto está sem unidade comercial e de estoque. O pedido não foi gravado.',
    MODULO_NAO_LICENCIADO: 'O módulo Pedidos não está habilitado para esta empresa.',
    MESA_SEM_ATENDIMENTO: 'Esta mesa não tem atendimento aberto para receber pedido. Volte às mesas e confira a situação.',
    ATENDIMENTO_NAO_ABERTO: 'Esta mesa não tem atendimento aberto para receber pedido. Volte às mesas e confira a situação.',
    ATENDIMENTO_EM_FECHAMENTO: 'A mesa está em fechamento e não recebe pedido novo.'
  };

  function arredondar(valor) {
    return Number(Number(valor || 0).toFixed(2));
  }

  function dinheiro(valor) {
    return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function escapar(texto) {
    return String(texto == null ? '' : texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function apiUrl() {
    if (typeof root.API_URL === 'string' && root.API_URL) return root.API_URL;
    if (typeof root.location !== 'undefined' && root.location.origin) {
      return root.location.origin + '/api';
    }
    return '/api';
  }

  function criarEstado() {
    return {
      etapa: 'cliente',
      cliente: null,
      itens: [],
      sequencia: 0,
      desconto: 0,
      observacao: '',
      enviando: false,
      chave: null,
      assinaturaChave: null,
      confirmacao: null,
      mesaId: null,
      mesaNumero: null,
      mesaBloqueada: false,
      produtoPendente: null,
      editandoEditorId: null
    };
  }

  function novaChave() {
    const cryptoApi = typeof root.crypto !== 'undefined' ? root.crypto : null;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
        + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    throw new Error('Este navegador não oferece suporte a chaves de idempotência.');
  }

  function precoSugerido(produto) {
    if (typeof root.cdsPedidoResolverPrecoSugerido !== 'function') {
      throw new Error('A regra de preço do pedido não está disponível.');
    }
    const precoComercial = Number(
      produto.preco_promocional != null ? produto.preco_promocional : (produto.preco_venda || 0)
    );
    const origem = produto.preco_promocional != null ? 'PROMOCAO' : 'PRECO_VENDA';
    return root.cdsPedidoResolverPrecoSugerido(produto, precoComercial, origem);
  }

  function nomeComercial(produto) {
    const comercial = String(produto.nome_comercial || '').trim();
    return comercial || produto.nome || '';
  }

  function recalcularItem(item) {
    const quantidade = Number(item.quantidade);
    const preco = Number(item.preco_unitario);
    const desconto = Number(item.desconto_percentual || 0);
    item.subtotal = arredondar(quantidade * preco * (1 - desconto / 100));
    return item;
  }

  function calcularTotais(estado) {
    const subtotal = arredondar(estado.itens.reduce((soma, item) => soma + Number(item.subtotal || 0), 0));
    const desconto = arredondar(estado.desconto || 0);
    const frete = 0;
    return {
      itens: estado.itens.length,
      subtotal,
      desconto,
      frete,
      total: arredondar(subtotal - desconto + frete)
    };
  }

  function etapaDepoisDeAdicionar() {
    return 'produtos';
  }

  function irPara(estado, etapa) {
    if (ETAPAS.indexOf(etapa) === -1 && etapa !== 'confirmado' && etapa !== 'empresas') {
      throw new Error('Etapa desconhecida.');
    }
    estado.etapa = etapa;
    return estado;
  }

  function selecionarCliente(estado, cliente) {
    estado.cliente = cliente && cliente.id ? { id: Number(cliente.id), nome: cliente.nome || '' } : null;
    return estado;
  }

  function adicionarItem(estado, entrada) {
    const quantidade = Number(entrada.quantidade);
    const personalizado = entrada.personalizado === true;
    if (!(Number(entrada.produtoId) > 0) || !(quantidade > 0)) {
      throw new Error('Selecione um produto e informe uma quantidade maior que zero.');
    }
    let precoUnitario = arredondar(entrada.precoBase);
    let precoAdicionais = 0;
    if (personalizado) {
      if (typeof root.cdsPedidoCalcularTotaisPersonalizacao !== 'function') {
        throw new Error('A regra de personalização do pedido não está disponível.');
      }
      const totais = root.cdsPedidoCalcularTotaisPersonalizacao({
        precoBase: Number(entrada.precoBase),
        quantidade,
        ingredientes: entrada.ingredientesFicha || [],
        ingredientesSelecionados: entrada.selecao || [],
        desconto: Number(entrada.desconto || 0)
      });
      precoUnitario = totais.precoUnitario;
      precoAdicionais = totais.precoAdicionais;
    }
    if (!(precoUnitario >= 0)) {
      throw new Error('O preço do item é inválido.');
    }
    const candidato = {
      produto_id: Number(entrada.produtoId),
      produto_nome: entrada.nome || '',
      produto_codigo: entrada.codigo || '',
      quantidade,
      preco_unitario: precoUnitario,
      desconto_percentual: Number(entrada.desconto || 0),
      tipo_venda: 'PESO',
      personalizacao_ingredientes_snapshot: personalizado ? 1 : 0,
      preco_base_unitario_snapshot: personalizado ? arredondar(entrada.precoBase) : null,
      preco_adicionais_unitario_snapshot: personalizado ? precoAdicionais : null,
      ingredientes_personalizados: personalizado ? (entrada.ingredientes || []) : [],
      ingredientes_selecionados: personalizado ? (entrada.selecao || []).map(Number) : undefined,
      ...(entrada.snapshot || {})
    };
    recalcularItem(candidato);

    let indice = -1;
    if (entrada.editorId) {
      indice = estado.itens.findIndex((item) => item.editor_id === entrada.editorId);
    } else if (personalizado && typeof root.cdsPedidoPersonalizacaoEquivalente === 'function') {
      indice = estado.itens.findIndex((item) => (
        Number(item.personalizacao_ingredientes_snapshot) === 1
        && root.cdsPedidoPersonalizacaoEquivalente(item, candidato)
      ));
    } else if (!personalizado) {
      indice = estado.itens.findIndex((item) => (
        Number(item.produto_id) === Number(entrada.produtoId)
        && Number(item.personalizacao_ingredientes_snapshot) !== 1
      ));
    }
    if (indice >= 0 && !entrada.editorId) {
      candidato.quantidade = arredondarQuantidade(Number(estado.itens[indice].quantidade) + quantidade);
      candidato.editor_id = estado.itens[indice].editor_id;
      recalcularItem(candidato);
      estado.itens[indice] = candidato;
    } else if (indice >= 0) {
      candidato.editor_id = estado.itens[indice].editor_id;
      estado.itens[indice] = candidato;
    } else {
      estado.sequencia += 1;
      candidato.editor_id = 'novo-' + estado.sequencia;
      estado.itens.push(candidato);
    }
    return estado;
  }

  function arredondarQuantidade(valor) {
    const numero = Number(valor);
    if (Number.isInteger(numero)) return numero;
    return Number(numero.toFixed(3));
  }

  function alterarQuantidade(estado, editorId, quantidade) {
    const item = estado.itens.find((linha) => linha.editor_id === editorId);
    if (!item) throw new Error('O item não está mais no carrinho.');
    const qtd = Number(quantidade);
    if (!(qtd > 0)) throw new Error('A quantidade precisa ser maior que zero.');
    item.quantidade = arredondarQuantidade(qtd);
    recalcularItem(item);
    return estado;
  }

  function alterarPreco(estado, editorId, preco) {
    const item = estado.itens.find((linha) => linha.editor_id === editorId);
    if (!item) throw new Error('O item não está mais no carrinho.');
    if (Number(item.personalizacao_ingredientes_snapshot) === 1) {
      throw new Error('O preço do item personalizado é o preço oficial mais os adicionais.');
    }
    const valor = Number(preco);
    if (!(valor >= 0) || !Number.isFinite(valor)) throw new Error('Preço inválido.');
    item.preco_unitario = arredondar(valor);
    recalcularItem(item);
    return estado;
  }

  function alterarDescontoItem(estado, editorId, desconto) {
    const item = estado.itens.find((linha) => linha.editor_id === editorId);
    if (!item) throw new Error('O item não está mais no carrinho.');
    const valor = Number(desconto || 0);
    if (!(valor >= 0) || valor > 100) throw new Error('O desconto do item precisa ficar entre 0 e 100%.');
    item.desconto_percentual = valor;
    recalcularItem(item);
    return estado;
  }

  function removerItem(estado, editorId) {
    estado.itens = estado.itens.filter((item) => item.editor_id !== editorId);
    return estado;
  }

  function itemParaApi(item) {
    const linha = {
      produto_id: Number(item.produto_id),
      quantidade: Number(item.quantidade),
      preco_unitario: Number(item.preco_unitario),
      desconto_percentual: Number(item.desconto_percentual || 0),
      subtotal: Number(item.subtotal),
      tipo_venda: item.tipo_venda || 'PESO',
      preco_venda_snapshot: item.preco_venda_snapshot ?? null,
      preco_pedido_snapshot: item.preco_pedido_snapshot ?? null,
      preco_sugerido_snapshot: item.preco_sugerido_snapshot ?? null,
      origem_preco_sugerido: item.origem_preco_sugerido ?? null
    };
    if (Number(item.personalizacao_ingredientes_snapshot) === 1) {
      linha.preco_base_unitario = item.preco_base_unitario_snapshot;
      linha.ingredientes_selecionados = (item.ingredientes_personalizados || [])
        .filter((ingrediente) => Number(ingrediente.selecionado) === 1
          && ingrediente.classificacao_comercial_snapshot !== 'OBRIGATORIO_OCULTO')
        .map((ingrediente) => Number(ingrediente.insumo_id));
    }
    return linha;
  }

  function montarPayload(estado) {
    const totais = calcularTotais(estado);
    return {
      cliente_id: estado.cliente && estado.cliente.id ? Number(estado.cliente.id) : null,
      mesa_id: estado.mesaId ? Number(estado.mesaId) : null,
      representante_nome: null,
      observacao: estado.observacao ? String(estado.observacao) : null,
      frete: totais.frete,
      desconto: totais.desconto,
      total: totais.total,
      tipo: 'pedido',
      status: 'PEDIDO',
      itens: estado.itens.map(itemParaApi)
    };
  }

  function mensagemErroApi(data, status) {
    const corpo = data && typeof data === 'object' ? data : {};
    const codigo = corpo.codigo || corpo.code || corpo.erro || null;
    const texto = corpo.mensagem || corpo.error || corpo.erro || '';
    if (status === 401 || codigo === 'SESSAO_INVALIDA') {
      return {
        codigo: 'SESSAO_INVALIDA',
        mensagem: typeof texto === 'string' && texto ? texto : 'Sessão expirada. Entre novamente.',
        autenticacao: true
      };
    }
    if (codigo && MENSAGENS[codigo]) {
      return { codigo, mensagem: MENSAGENS[codigo], detalhe: typeof texto === 'string' ? texto : '' };
    }
    return {
      codigo,
      mensagem: typeof texto === 'string' && texto
        ? texto
        : ('Não foi possível concluir a operação (HTTP ' + status + ').')
    };
  }

  function headersGravacao(estado) {
    const contexto = root.CdsEmpresaContexto;
    if (!contexto || typeof contexto.temEmpresaSelecionada !== 'function' || !contexto.temEmpresaSelecionada()) {
      return null;
    }
    if (typeof contexto.headersJson !== 'function') return null;
    const headers = contexto.headersJson();
    if (!headers['X-Empresa-Id']) return null;
    const payload = montarPayload(estado);
    const assinatura = JSON.stringify(payload);
    if (!estado.chave || estado.assinaturaChave !== assinatura) {
      estado.chave = novaChave();
      estado.assinaturaChave = assinatura;
    }
    headers['Idempotency-Key'] = estado.chave;
    return { headers, payload };
  }

  async function gravar(estado, fetchFn) {
    if (estado.enviando) {
      return { ok: false, bloqueado: true, mantemCarrinho: true, mensagem: 'O pedido já está sendo gravado.' };
    }
    if (!estado.itens.length) {
      return { ok: false, mantemCarrinho: true, mensagem: 'Adicione ao menos um item.' };
    }
    if (estado.mesaBloqueada) {
      return { ok: false, mantemCarrinho: true, mensagem: MENSAGENS.MESA_SEM_ATENDIMENTO };
    }
    const totais = calcularTotais(estado);
    if (!(totais.subtotal > 0) || !(totais.total >= 0)) {
      return {
        ok: false,
        codigo: 'PEDIDO_TOTAL_INCONSISTENTE',
        mantemCarrinho: true,
        mensagem: MENSAGENS.PEDIDO_TOTAL_INCONSISTENTE
      };
    }
    let pacote;
    try {
      pacote = headersGravacao(estado);
    } catch (erro) {
      return {
        ok: false,
        mantemCarrinho: true,
        mensagem: (erro && erro.message) || 'Não foi possível preparar a gravação.'
      };
    }
    if (!pacote) {
      return {
        ok: false,
        codigo: 'EMPRESA_CONTEXT_REQUIRED',
        mantemCarrinho: true,
        mensagem: MENSAGENS.EMPRESA_CONTEXT_REQUIRED
      };
    }
    estado.enviando = true;
    try {
      const resp = await fetchFn(apiUrl() + '/pedidos', {
        method: 'POST',
        headers: pacote.headers,
        body: JSON.stringify(pacote.payload)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const erro = mensagemErroApi(data, resp.status);
        return Object.assign({ ok: false, mantemCarrinho: true }, erro);
      }
      const pedido = data.pedido || {};
      estado.confirmacao = {
        id: pedido.id,
        codigo: pedido.codigo || ('#' + pedido.id),
        cliente: estado.cliente,
        empresaId: pacote.headers['X-Empresa-Id'],
        total: pacote.payload.total
      };
      estado.itens = [];
      estado.cliente = null;
      estado.desconto = 0;
      estado.observacao = '';
      estado.chave = null;
      estado.assinaturaChave = null;
      estado.etapa = 'confirmado';
      return { ok: true, pedido, confirmacao: estado.confirmacao };
    } catch (_erro) {
      return {
        ok: false,
        mantemCarrinho: true,
        mensagem: 'Sem conexão com o CDS. O carrinho foi mantido.'
      };
    } finally {
      estado.enviando = false;
    }
  }

  async function buscarClientes(termo, fetchFn, headers) {
    const texto = String(termo || '').trim();
    if (texto.length < 2) return { itens: [] };
    let resp;
    try {
      resp = await fetchFn(apiUrl() + '/clientes/buscar?termo=' + encodeURIComponent(texto), { headers });
    } catch (_erro) {
      return { itens: [], mensagem: 'Sem conexão ao pesquisar clientes.' };
    }
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const erro = mensagemErroApi(data, resp.status);
      return { itens: [], mensagem: erro.mensagem, codigo: erro.codigo, autenticacao: erro.autenticacao };
    }
    if (!Array.isArray(data)) {
      return { itens: [], mensagem: 'A pesquisa de clientes não retornou uma lista.' };
    }
    return { itens: data };
  }

  async function buscarProdutos(termo, fetchFn, headers) {
    const texto = String(termo || '').trim();
    if (!texto) return { itens: [] };
    let resp;
    try {
      resp = await fetchFn(
        apiUrl() + '/produtos/consulta-pedido/buscar?q=' + encodeURIComponent(texto) + '&limite=15',
        { headers }
      );
    } catch (_erro) {
      return { itens: [], mensagem: 'Sem conexão ao pesquisar produtos.' };
    }
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const erro = mensagemErroApi(data, resp.status);
      return { itens: [], mensagem: erro.mensagem, codigo: erro.codigo, autenticacao: erro.autenticacao };
    }
    if (!Array.isArray(data)) {
      return { itens: [], mensagem: 'A pesquisa de produtos não retornou uma lista.' };
    }
    return {
      itens: data.map((produto) => {
        const sugestao = precoSugerido(produto);
        return {
          id: produto.id,
          nome: nomeComercial(produto),
          codigo: produto.codigo || '',
          preco: sugestao.precoInicial,
          origem: sugestao.snapshot.origem_preco_sugerido
        };
      })
    };
  }

  async function carregarProduto(id, fetchFn, headers) {
    const resp = await fetchFn(apiUrl() + '/produtos/' + id, { headers });
    const produto = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const erro = mensagemErroApi(produto, resp.status);
      throw Object.assign(new Error(erro.mensagem), erro);
    }
    let ficha = null;
    if (Number(produto.permite_personalizacao_ingredientes) === 1) {
      const fichaResp = await fetchFn(apiUrl() + '/produtos/' + id + '/ficha-tecnica', { headers });
      const fichaCorpo = await fichaResp.json().catch(() => ({}));
      if (!fichaResp.ok) {
        throw new Error(fichaCorpo.error || fichaCorpo.mensagem || 'Falha ao carregar as opções de ingredientes.');
      }
      if (!fichaCorpo || Number(fichaCorpo.ativo) !== 1 || !Array.isArray(fichaCorpo.itens) || !fichaCorpo.itens.length) {
        throw new Error('O produto permite personalização, mas não possui ficha técnica ativa e válida.');
      }
      ficha = fichaCorpo;
    }
    return {
      produto,
      nome: nomeComercial(produto),
      sugestao: precoSugerido(produto),
      ficha
    };
  }

  function ingredientesDaFicha(ficha, selecao) {
    const escolhidos = new Set((selecao || []).map(Number));
    return (ficha.itens || []).map((item) => {
      const obrigatorio = item.classificacao_comercial === 'OBRIGATORIO_OCULTO';
      const selecionado = obrigatorio || escolhidos.has(Number(item.insumo_id));
      return {
        insumo_id: Number(item.insumo_id),
        insumo_nome_snapshot: String(item.insumo_nome || ('#' + item.insumo_id)),
        quantidade_snapshot: Number(item.quantidade),
        unidade_snapshot: String(item.unidade || ''),
        classificacao_comercial_snapshot: item.classificacao_comercial,
        selecionado: selecionado ? 1 : 0,
        preco_adicional_snapshot: Number(item.preco_adicional || 0)
      };
    });
  }

  function conferenciaHandoff(preparacao) {
    if (!preparacao || preparacao.venda_concluida) {
      return {
        ok: false,
        codigo: 'VENDA_JA_CONCLUIDA',
        vendaId: preparacao && preparacao.venda_id,
        mensagem: 'Este pedido já possui a venda ' + ((preparacao && preparacao.venda_id) || '') + ' concluída.'
      };
    }
    if (Number(preparacao && preparacao.venda_id) > 0) {
      return {
        ok: false,
        codigo: 'VENDA_JA_VINCULADA',
        vendaId: Number(preparacao.venda_id),
        mensagem: 'A venda ' + preparacao.venda_id + ' já foi registrada para este pedido. Nenhum outro fechamento foi iniciado.'
      };
    }
    if (!Number.isInteger(Number(preparacao.pedido_id)) || !Number.isInteger(Number(preparacao.operacao_id))
      || !Array.isArray(preparacao.itens) || !preparacao.itens.length) {
      return { ok: false, mensagem: 'A preparação do pedido veio incompleta.' };
    }
    return { ok: true };
  }

  async function encaminharPedidoAoPdv(pedidoId, opcoes) {
    const id = Number(pedidoId);
    const fetchFn = opcoes && opcoes.fetch;
    const storage = opcoes && opcoes.storage;
    const contexto = opcoes && opcoes.contexto;
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, mensagem: 'Pedido sem identificação para o PDV.' };
    }
    if (!fetchFn || !storage || !contexto || typeof contexto.headersJson !== 'function') {
      return { ok: false, mensagem: 'A sessão do PDV não está disponível.' };
    }
    if (typeof contexto.temEmpresaSelecionada === 'function' && !contexto.temEmpresaSelecionada()) {
      return {
        ok: false,
        codigo: 'EMPRESA_CONTEXT_REQUIRED',
        mensagem: 'Selecione a empresa antes de enviar o pedido ao PDV.'
      };
    }
    const headers = contexto.headersJson();
    if (!headers['X-Empresa-Id']) {
      return {
        ok: false,
        codigo: 'EMPRESA_CONTEXT_REQUIRED',
        mensagem: 'Selecione a empresa antes de enviar o pedido ao PDV.'
      };
    }
    let resp;
    try {
      resp = await fetchFn(apiUrl() + '/pedidos/' + id + '/preparar-venda-pdv', {
        method: 'POST',
        headers,
        body: '{}'
      });
    } catch (_erro) {
      return { ok: false, mensagem: 'Sem conexão ao preparar a venda no PDV. O pedido foi mantido.' };
    }
    const preparacao = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const erro = mensagemErroApi(preparacao, resp.status);
      return {
        ok: false,
        codigo: erro.codigo,
        mensagem: preparacao.mensagem || preparacao.error || erro.mensagem,
        autenticacao: erro.autenticacao
      };
    }
    if (String(preparacao.empresa_id) !== String(headers['X-Empresa-Id'])) {
      return {
        ok: false,
        codigo: 'EMPRESA_DIVERGENTE',
        mensagem: 'A composição pertence a outra empresa. O pedido não foi encaminhado.'
      };
    }
    const conferencia = conferenciaHandoff(preparacao);
    if (!conferencia.ok) return conferencia;
    const usuario = opcoes && opcoes.usuario;
    const operadorId = Number(usuario && (usuario.id || usuario.usuario_id));
    const envelope = Object.assign({}, preparacao);
    if (operadorId > 0) envelope.sessao_operador_id = operadorId;
    storage.setItem('pdvPedidoHandoff', JSON.stringify(envelope));
    return { ok: true, handoff: preparacao, destino: '/mobile-pdv' };
  }

  function novoPedido(estado) {
    const seguinte = criarEstado();
    estado.etapa = seguinte.etapa;
    estado.cliente = null;
    estado.itens = [];
    estado.sequencia = 0;
    estado.desconto = 0;
    estado.observacao = '';
    estado.enviando = false;
    estado.chave = null;
    estado.assinaturaChave = null;
    estado.confirmacao = null;
    estado.produtoPendente = null;
    estado.editandoEditorId = null;
    return estado;
  }

  const api = {
    ETAPAS,
    MENSAGENS,
    criarEstado,
    irPara,
    etapaDepoisDeAdicionar,
    selecionarCliente,
    adicionarItem,
    alterarQuantidade,
    alterarPreco,
    alterarDescontoItem,
    removerItem,
    calcularTotais,
    montarPayload,
    itemParaApi,
    gravar,
    buscarClientes,
    buscarProdutos,
    carregarProduto,
    ingredientesDaFicha,
    precoSugerido,
    nomeComercial,
    mensagemErroApi,
    novoPedido,
    encaminharPedidoAoPdv,
    dinheiro
  };
  root.MobilePedido = api;

  function documentoAtual() {
    return root.document;
  }

  function $(id) {
    return documentoAtual().getElementById(id);
  }

  function mostrarAlerta(texto) {
    const el = $('mp-alerta');
    if (!el) return;
    if (!texto) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = texto;
  }

  function exigirSessao() {
    let token = '';
    try { token = root.localStorage.getItem('token') || ''; } catch (_e) { token = ''; }
    if (token) return true;
    if (root.location && typeof root.location.replace === 'function') {
      root.location.replace('/login?next=/mobile-pedido');
    }
    return false;
  }
  api.exigirSessao = exigirSessao;

  function nomeEmpresaAtual() {
    const contexto = root.CdsEmpresaContexto;
    if (!contexto || typeof contexto.lerEmpresa !== 'function') return '';
    const empresa = contexto.lerEmpresa();
    if (!empresa) return '';
    return empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id);
  }

  function usuarioSessao() {
    try {
      return JSON.parse(root.localStorage.getItem('user') || 'null');
    } catch (_erro) {
      return null;
    }
  }

  function pintarEmpresa() {
    const el = $('mp-empresa');
    if (!el) return;
    const nome = nomeEmpresaAtual();
    el.textContent = nome || 'Empresa não selecionada';
    const operador = $('mp-operador');
    if (operador) {
      const usuario = usuarioSessao();
      const nomeOperador = usuario && (usuario.nome || usuario.username);
      operador.textContent = nomeOperador ? ('Operador: ' + nomeOperador) : '';
    }
  }

  function pintarEtapas(estado) {
    documentoAtual().querySelectorAll('#mp-etapas button').forEach((botao) => {
      botao.classList.toggle('is-ativa', botao.getAttribute('data-etapa') === estado.etapa);
      botao.disabled = estado.etapa === 'confirmado';
    });
    documentoAtual().querySelectorAll('[data-painel]').forEach((painel) => {
      painel.hidden = painel.getAttribute('data-painel') !== estado.etapa;
    });
    const nav = $('mp-etapas');
    if (nav) nav.hidden = estado.etapa === 'confirmado' || estado.etapa === 'empresas';
  }

  function pintarCarrinho(estado) {
    const lista = $('mp-carrinho-lista');
    if (!lista) return;
    if (!estado.itens.length) {
      lista.innerHTML = '<p class="mp-ajuda">Nenhum item. Volte aos produtos para adicionar.</p>';
    } else {
      lista.innerHTML = estado.itens.map((item) => `
        <article class="mp-item" data-editor="${escapar(item.editor_id)}">
          <strong>${escapar(item.produto_nome)}</strong>
          <small>${escapar(item.produto_codigo || '')}</small>
          <div class="mp-linha">
            <label>Qtd
              <input class="mp-campo mp-edit-qtd" data-editor="${escapar(item.editor_id)}" type="number" min="1" step="1" value="${escapar(item.quantidade)}">
            </label>
            <label>Valor
              <input class="mp-campo mp-edit-preco" data-editor="${escapar(item.editor_id)}" type="number" min="0" step="0.01" value="${escapar(item.preco_unitario)}" ${Number(item.personalizacao_ingredientes_snapshot) === 1 ? 'readonly' : ''}>
            </label>
          </div>
          <div class="mp-linha">
            <label>Desc. %
              <input class="mp-campo mp-edit-desc" data-editor="${escapar(item.editor_id)}" type="number" min="0" max="100" step="0.01" value="${escapar(item.desconto_percentual || 0)}">
            </label>
            <span>Subtotal <strong>${dinheiro(item.subtotal)}</strong></span>
          </div>
          <button type="button" class="mp-btn mp-remover" data-editor="${escapar(item.editor_id)}">Remover</button>
        </article>
      `).join('');
    }
    const totais = calcularTotais(estado);
    const parcial = $('mp-total-parcial');
    const final = $('mp-total-final');
    if (parcial) parcial.textContent = dinheiro(totais.subtotal);
    if (final) final.textContent = dinheiro(totais.total);
  }

  function pintarConferencia(estado) {
    const resumo = $('mp-resumo');
    if (!resumo) return;
    const totais = calcularTotais(estado);
    const linhas = estado.itens.map((item) => (
      '<li>' + escapar(item.quantidade) + ' × ' + escapar(item.produto_nome)
      + ' — ' + dinheiro(item.subtotal) + '</li>'
    )).join('');
    resumo.innerHTML = `
      <p><strong>Empresa</strong><br>${escapar(nomeEmpresaAtual() || 'Não selecionada')}</p>
      <p><strong>Cliente</strong><br>${escapar(estado.cliente ? estado.cliente.nome : 'Sem cliente')}</p>
      <ul>${linhas || '<li>Nenhum item</li>'}</ul>
      <p>Subtotal ${dinheiro(totais.subtotal)}</p>
      <p>Desconto ${dinheiro(totais.desconto)}</p>
      <p>Total ${dinheiro(totais.total)}</p>
    `;
    const campoDesc = $('mp-desconto');
    const campoObs = $('mp-observacao');
    if (campoDesc && documentoAtual().activeElement !== campoDesc) campoDesc.value = estado.desconto;
    if (campoObs && documentoAtual().activeElement !== campoObs) campoObs.value = estado.observacao || '';
    const final = $('mp-total-final');
    if (final) final.textContent = dinheiro(totais.total);
  }

  function pintarConfirmacao(estado) {
    const box = $('mp-confirmacao');
    if (!box || !estado.confirmacao) return;
    const conf = estado.confirmacao;
    box.innerHTML = `
      <p><strong>Código</strong><br>${escapar(conf.codigo)}</p>
      <p><strong>Empresa</strong><br>${escapar(nomeEmpresaAtual() || ('#' + conf.empresaId))}</p>
      <p><strong>Cliente</strong><br>${escapar(conf.cliente ? conf.cliente.nome : 'Sem cliente')}</p>
      <p><strong>Total</strong><br>${dinheiro(conf.total)}</p>
    `;
  }

  function pintar(estado) {
    pintarEmpresa();
    pintarEtapas(estado);
    const escolhido = $('mp-cliente-escolhido');
    if (escolhido) {
      escolhido.textContent = estado.cliente
        ? ('Cliente: ' + estado.cliente.nome)
        : 'Nenhum cliente selecionado';
    }
    pintarCarrinho(estado);
    pintarConferencia(estado);
    const verCarrinho = $('mp-ir-carrinho');
    if (verCarrinho) {
      const totais = calcularTotais(estado);
      verCarrinho.textContent = totais.itens
        ? ('Ver carrinho (' + totais.itens + ') · ' + dinheiro(totais.total))
        : 'Ver carrinho';
    }
    pintarConfirmacao(estado);
    pintarMesa(estado);
    if (root.CdsMobileOperacao) root.CdsMobileOperacao.salvarPedido(estado);
    const gravarBtn = $('mp-gravar');
    if (gravarBtn) {
      gravarBtn.disabled = estado.enviando;
      gravarBtn.textContent = estado.enviando ? 'Gravando…' : 'Gravar pedido';
    }
  }

  function headersLeitura() {
    const contexto = root.CdsEmpresaContexto;
    if (contexto && typeof contexto.headersAuth === 'function') return contexto.headersAuth();
    const headers = {};
    try {
      const token = root.localStorage.getItem('token');
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch (_e) { /* sem storage */ }
    return headers;
  }

  function tratarAutenticacao(resultado) {
    if (resultado && resultado.autenticacao && root.location) {
      root.location.replace('/login?next=/mobile-pedido');
    }
  }

  function mesaDaUrl() {
    try {
      const bruto = new root.URLSearchParams(root.location.search).get('mesa');
      const id = Number(bruto);
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch (_erro) {
      return null;
    }
  }

  // O servidor decide se a mesa recebe pedido; esta consulta só evita montar um carrinho inútil.
  async function consultarMesa(mesaId, fetchFn, headers) {
    let resp;
    try {
      resp = await fetchFn(apiUrl() + '/mesas/' + mesaId + '/atendimento', { headers });
    } catch (_erro) {
      return { ok: false, rede: true, mensagem: 'Sem conexão para confirmar a mesa. O pedido não será gravado até a confirmação.' };
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const erro = mensagemErroApi(data, resp.status);
      return Object.assign({ ok: false }, erro);
    }
    if (data.situacao === 'FECHAMENTO') {
      return { ok: false, codigo: 'ATENDIMENTO_EM_FECHAMENTO', mensagem: MENSAGENS.ATENDIMENTO_EM_FECHAMENTO, numero: data.numero };
    }
    if (data.situacao !== 'OCUPADA' || !data.atendimento) {
      return { ok: false, codigo: 'MESA_SEM_ATENDIMENTO', mensagem: MENSAGENS.MESA_SEM_ATENDIMENTO, numero: data.numero };
    }
    return { ok: true, numero: data.numero };
  }
  api.consultarMesa = consultarMesa;

  async function validarMesaDoPedido(estado) {
    if (!estado.mesaId) return;
    const resultado = await consultarMesa(estado.mesaId, root.fetch.bind(root), headersLeitura());
    tratarAutenticacao(resultado);
    if (resultado.numero != null) estado.mesaNumero = resultado.numero;
    estado.mesaBloqueada = !resultado.ok;
    mostrarAlerta(resultado.ok ? '' : resultado.mensagem);
  }

  function pintarMesa(estado) {
    const faixa = $('mp-mesa-faixa');
    const confirmado = estado.etapa === 'confirmado';
    if (faixa) {
      faixa.hidden = !estado.mesaId;
      const rotulo = $('mp-mesa-rotulo');
      if (rotulo) {
        rotulo.textContent = estado.mesaId
          ? ('Pedido da mesa ' + (estado.mesaNumero != null ? estado.mesaNumero : estado.mesaId))
          : '';
      }
    }
    const pdv = $('mp-enviar-pdv');
    if (pdv) pdv.hidden = !!estado.mesaId;
    const acoes = $('mp-mesa-acoes');
    if (acoes) acoes.hidden = !(estado.mesaId && confirmado);
    const conferir = $('mp-mesa-conferir');
    if (conferir && estado.confirmacao && estado.mesaId) {
      conferir.href = '/mobile-mesas/?mesa=' + encodeURIComponent(estado.mesaId)
        + '&pedido=' + encodeURIComponent(estado.confirmacao.id);
    }
    const voltar = $('mp-mesa-voltar');
    if (voltar && estado.mesaId) voltar.href = '/mobile-mesas/?mesa=' + encodeURIComponent(estado.mesaId);
    const voltarFim = $('mp-mesa-voltar-fim');
    if (voltarFim && estado.mesaId) voltarFim.href = '/mobile-mesas/?mesa=' + encodeURIComponent(estado.mesaId);
  }

  async function iniciar() {
    if (!documentoAtual() || !$('mp-app')) return;
    if (!exigirSessao()) return;
    const estado = criarEstado();
    estado.mesaId = mesaDaUrl();
    const guardado = root.CdsMobileOperacao ? root.CdsMobileOperacao.lerPedido(estado.mesaId) : null;
    if (guardado && guardado.ok && guardado.registro && guardado.registro.estado) {
      const salvo = guardado.registro.estado;
      if (ETAPAS.indexOf(salvo.etapa) >= 0 || salvo.etapa === 'confirmado') estado.etapa = salvo.etapa;
      estado.cliente = salvo.cliente || null;
      estado.itens = Array.isArray(salvo.itens) ? salvo.itens : [];
      estado.sequencia = Number(salvo.sequencia) || 0;
      estado.desconto = Number(salvo.desconto) || 0;
      estado.observacao = salvo.observacao || '';
      estado.chave = salvo.chave || null;
      estado.assinaturaChave = salvo.assinaturaChave || null;
      estado.confirmacao = salvo.confirmacao || null;
    } else if (guardado && guardado.codigo === 'OPERADOR_DIVERGENTE') {
      mostrarAlerta('Há um pedido em andamento de outro operador. Ele foi mantido e não foi aberto.');
    }
    pintar(estado);

    async function prepararEmpresa() {
      const contexto = root.CdsEmpresaContexto;
      if (!contexto) {
        mostrarAlerta('O contexto de empresa do CDS não está disponível.');
        return;
      }
      let lista = [];
      try {
        lista = await contexto.listarDisponiveis();
      } catch (erro) {
        mostrarAlerta(erro.message || 'Não foi possível carregar as empresas.');
        return;
      }
      if (!Array.isArray(lista) || !lista.length) {
        mostrarAlerta('Você não possui empresa disponível.');
        return;
      }
      if (typeof contexto.adotarEmpresaPadrao !== 'function') {
        mostrarAlerta('A resolução da empresa padrão não está disponível.');
        return;
      }
      await contexto.adotarEmpresaPadrao();
      mostrarAlerta('');
      await validarMesaDoPedido(estado);
      pintar(estado);
    }

    function abrirEmpresas(lista) {
      const host = $('mp-empresa-lista');
      host.innerHTML = lista.map((empresa) => {
        const nome = empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id);
        const cnpj = root.CdsEmpresaContexto.formatarCnpj
          ? root.CdsEmpresaContexto.formatarCnpj(empresa.cnpj)
          : (empresa.cnpj || '');
        return '<button type="button" data-empresa="' + empresa.id + '"><strong>'
          + escapar(nome) + '</strong><small>' + escapar(cnpj) + '</small></button>';
      }).join('');
      estado.etapa = 'empresas';
      pintar(estado);
      host.querySelectorAll('button').forEach((botao) => {
        botao.addEventListener('click', async () => {
          try {
            await root.CdsEmpresaContexto.selecionar(Number(botao.getAttribute('data-empresa')));
            mostrarAlerta('');
            estado.etapa = 'cliente';
            pintar(estado);
          } catch (erro) {
            mostrarAlerta(erro.message || 'Não foi possível selecionar a empresa.');
          }
        });
      });
    }

    $('mp-trocar-empresa').addEventListener('click', async () => {
      try {
        const lista = await root.CdsEmpresaContexto.listarDisponiveis();
        abrirEmpresas(lista || []);
      } catch (erro) {
        mostrarAlerta(erro.message || 'Não foi possível carregar as empresas.');
      }
    });

    documentoAtual().querySelectorAll('#mp-etapas button').forEach((botao) => {
      botao.addEventListener('click', () => {
        irPara(estado, botao.getAttribute('data-etapa'));
        mostrarAlerta('');
        pintar(estado);
      });
    });

    $('mp-sem-cliente').addEventListener('click', () => {
      selecionarCliente(estado, null);
      irPara(estado, 'produtos');
      pintar(estado);
    });
    $('mp-cliente-seguir').addEventListener('click', () => {
      irPara(estado, 'produtos');
      pintar(estado);
    });
    $('mp-voltar-cliente').addEventListener('click', () => { irPara(estado, 'cliente'); pintar(estado); });
    $('mp-ir-carrinho').addEventListener('click', () => { irPara(estado, 'carrinho'); pintar(estado); });
    $('mp-voltar-produtos').addEventListener('click', () => { irPara(estado, 'produtos'); pintar(estado); });
    $('mp-ir-conferencia').addEventListener('click', () => { irPara(estado, 'conferencia'); pintar(estado); });
    $('mp-voltar-carrinho').addEventListener('click', () => { irPara(estado, 'carrinho'); pintar(estado); });

    let timerCliente = null;
    $('mp-cliente-busca').addEventListener('input', () => {
      clearTimeout(timerCliente);
      const termo = $('mp-cliente-busca').value;
      timerCliente = setTimeout(async () => {
        const status = $('mp-cliente-status');
        status.hidden = false;
        status.textContent = 'Buscando clientes…';
        const resultado = await buscarClientes(termo, root.fetch.bind(root), headersLeitura());
        tratarAutenticacao(resultado);
        if (resultado.mensagem) {
          status.textContent = resultado.mensagem;
          $('mp-cliente-lista').innerHTML = '';
          return;
        }
        status.hidden = true;
        const rows = resultado.itens || [];
        $('mp-cliente-lista').innerHTML = rows.length
          ? rows.map((cliente) => (
            '<button type="button" data-id="' + cliente.id + '" data-nome="' + escapar(cliente.nome) + '">'
            + '<strong>' + escapar(cliente.nome) + '</strong>'
            + '<small>' + escapar(cliente.cpf_cnpj || '') + ' ' + escapar(cliente.telefone || '') + '</small>'
            + '</button>'
          )).join('')
          : '<p class="mp-ajuda">Nenhum cliente encontrado.</p>';
        $('mp-cliente-lista').querySelectorAll('button').forEach((botao) => {
          botao.addEventListener('click', () => {
            selecionarCliente(estado, { id: botao.getAttribute('data-id'), nome: botao.getAttribute('data-nome') });
            pintar(estado);
          });
        });
      }, 250);
    });

    let timerProduto = null;
    $('mp-produto-busca').addEventListener('input', () => {
      clearTimeout(timerProduto);
      const termo = $('mp-produto-busca').value;
      timerProduto = setTimeout(async () => {
        const status = $('mp-produto-status');
        status.hidden = false;
        status.textContent = 'Buscando produtos…';
        const resultado = await buscarProdutos(termo, root.fetch.bind(root), headersLeitura());
        tratarAutenticacao(resultado);
        if (resultado.mensagem) {
          status.textContent = resultado.mensagem;
          $('mp-produto-lista').innerHTML = '';
          return;
        }
        status.hidden = true;
        const rows = resultado.itens || [];
        $('mp-produto-lista').innerHTML = rows.length
          ? rows.map((produto) => (
            '<button type="button" data-id="' + produto.id + '">'
            + '<strong>' + escapar(produto.codigo || produto.id) + ' — ' + escapar(produto.nome) + '</strong>'
            + '<small>' + dinheiro(produto.preco) + '</small>'
            + '</button>'
          )).join('')
          : '<p class="mp-ajuda">Nenhum produto encontrado.</p>';
        $('mp-produto-lista').querySelectorAll('button').forEach((botao) => {
          botao.addEventListener('click', () => escolherProduto(Number(botao.getAttribute('data-id'))));
        });
      }, 250);
    });

    async function escolherProduto(id) {
      const status = $('mp-produto-status');
      status.hidden = false;
      status.textContent = 'Carregando produto…';
      try {
        const carregado = await carregarProduto(id, root.fetch.bind(root), headersLeitura());
        estado.produtoPendente = carregado;
        estado.editandoEditorId = null;
        $('mp-produto-nome').textContent = carregado.nome;
        $('mp-produto-preco').textContent = dinheiro(carregado.sugestao.precoInicial);
        $('mp-produto-qtd').value = '1';
        const painel = $('mp-personalizacao');
        if (carregado.ficha) {
          painel.hidden = false;
          $('mp-opcionais').innerHTML = carregado.ficha.itens
            .filter((item) => item.classificacao_comercial !== 'OBRIGATORIO_OCULTO')
            .map((item) => (
              '<label class="mp-check"><input type="checkbox" value="' + Number(item.insumo_id) + '">'
              + '<span><strong>' + escapar(item.insumo_nome || ('#' + item.insumo_id)) + '</strong>'
              + (Number(item.preco_adicional || 0) > 0
                ? '<small>+ ' + dinheiro(item.preco_adicional) + ' por unidade</small>'
                : '<small>Sem adicional</small>')
              + '</span></label>'
            )).join('');
          atualizarPreviaPersonalizacao();
          $('mp-opcionais').addEventListener('change', atualizarPreviaPersonalizacao);
        } else {
          painel.hidden = true;
          $('mp-opcionais').innerHTML = '';
        }
        $('mp-produto-escolha').hidden = false;
        status.hidden = true;
      } catch (erro) {
        status.textContent = erro.message || 'Falha ao carregar o produto.';
      }
    }

    function atualizarPreviaPersonalizacao() {
      const pendente = estado.produtoPendente;
      if (!pendente || !pendente.ficha) return;
      const selecao = Array.from($('mp-opcionais').querySelectorAll('input:checked')).map((input) => Number(input.value));
      const totais = root.cdsPedidoCalcularTotaisPersonalizacao({
        precoBase: pendente.sugestao.precoInicial,
        quantidade: Number($('mp-produto-qtd').value || 1),
        ingredientes: pendente.ficha.itens,
        ingredientesSelecionados: selecao,
        desconto: 0
      });
      $('mp-personalizacao-total').textContent = 'Unitário ' + dinheiro(totais.precoUnitario)
        + ' · Item ' + dinheiro(totais.subtotal);
    }

    $('mp-produto-qtd').addEventListener('input', atualizarPreviaPersonalizacao);
    $('mp-qtd-menos').addEventListener('click', () => {
      const campo = $('mp-produto-qtd');
      campo.value = String(Math.max(1, Number(campo.value || 1) - 1));
      atualizarPreviaPersonalizacao();
    });
    $('mp-qtd-mais').addEventListener('click', () => {
      const campo = $('mp-produto-qtd');
      campo.value = String(Math.max(1, Number(campo.value || 1) + 1));
      atualizarPreviaPersonalizacao();
    });

    let adicionandoProduto = false;
    $('mp-adicionar').addEventListener('click', () => {
      if (adicionandoProduto) return;
      const pendente = estado.produtoPendente;
      if (!pendente) {
        mostrarAlerta('Selecione um produto.');
        return;
      }
      adicionandoProduto = true;
      try {
        const selecao = pendente.ficha
          ? Array.from($('mp-opcionais').querySelectorAll('input:checked')).map((input) => Number(input.value))
          : [];
        adicionarItem(estado, {
          produtoId: pendente.produto.id,
          nome: pendente.nome,
          codigo: pendente.produto.codigo || '',
          quantidade: Number($('mp-produto-qtd').value),
          precoBase: pendente.sugestao.precoInicial,
          desconto: 0,
          snapshot: pendente.sugestao.snapshot,
          personalizado: !!pendente.ficha,
          ingredientesFicha: pendente.ficha ? pendente.ficha.itens : [],
          selecao,
          ingredientes: pendente.ficha ? ingredientesDaFicha(pendente.ficha, selecao) : []
        });
        estado.produtoPendente = null;
        $('mp-produto-escolha').hidden = true;
        $('mp-produto-qtd').value = '1';
        mostrarAlerta('Item incluído. Você continua em Produtos.');
        estado.etapa = etapaDepoisDeAdicionar();
        pintar(estado);
      } catch (erro) {
        mostrarAlerta(erro.message || 'Não foi possível adicionar o item.');
      } finally {
        adicionandoProduto = false;
      }
    });

    $('mp-carrinho-lista').addEventListener('click', (evento) => {
      const botao = evento.target.closest('.mp-remover');
      if (!botao) return;
      removerItem(estado, botao.getAttribute('data-editor'));
      pintar(estado);
    });
    $('mp-carrinho-lista').addEventListener('change', (evento) => {
      const campo = evento.target;
      const editor = campo.getAttribute('data-editor');
      if (!editor) return;
      try {
        if (campo.classList.contains('mp-edit-qtd')) alterarQuantidade(estado, editor, campo.value);
        if (campo.classList.contains('mp-edit-preco')) alterarPreco(estado, editor, campo.value);
        if (campo.classList.contains('mp-edit-desc')) alterarDescontoItem(estado, editor, campo.value);
        mostrarAlerta('');
      } catch (erro) {
        mostrarAlerta(erro.message);
      }
      pintar(estado);
    });

    $('mp-desconto').addEventListener('input', () => {
      estado.desconto = Number($('mp-desconto').value || 0);
      pintarConferencia(estado);
    });
    $('mp-observacao').addEventListener('input', () => {
      estado.observacao = $('mp-observacao').value;
    });

    $('mp-gravar').addEventListener('click', async () => {
      estado.desconto = Number($('mp-desconto').value || 0);
      estado.observacao = $('mp-observacao').value;
      const antes = estado.itens.slice();
      pintar(estado);
      let resultado;
      try {
        resultado = await gravar(estado, root.fetch.bind(root));
      } catch (erro) {
        estado.itens = antes.length ? antes : estado.itens;
        mostrarAlerta(erro.message || 'O pedido não foi gravado.');
        pintar(estado);
        return;
      }
      if (!resultado.ok) {
        if (resultado.mantemCarrinho) estado.itens = antes.length ? antes : estado.itens;
        mostrarAlerta(resultado.mensagem || 'O pedido não foi gravado.');
        tratarAutenticacao(resultado);
        pintar(estado);
        return;
      }
      mostrarAlerta('');
      pintar(estado);
    });

    $('mp-enviar-pdv').addEventListener('click', async () => {
      const botao = $('mp-enviar-pdv');
      if (!estado.confirmacao || !(Number(estado.confirmacao.id) > 0)) {
        mostrarAlerta('Grave o pedido antes de enviá-lo ao PDV.');
        return;
      }
      if (botao.disabled) return;
      botao.disabled = true;
      try {
        const resultado = await encaminharPedidoAoPdv(estado.confirmacao.id, {
          fetch: root.fetch.bind(root),
          storage: root.sessionStorage,
          contexto: root.CdsEmpresaContexto,
          usuario: usuarioSessao()
        });
        if (!resultado.ok) {
          mostrarAlerta(resultado.mensagem || 'O pedido não foi encaminhado ao PDV.');
          tratarAutenticacao(resultado);
          botao.disabled = false;
          return;
        }
        root.location.assign(resultado.destino);
      } catch (erro) {
        mostrarAlerta(erro.message || 'O pedido não foi encaminhado ao PDV.');
        botao.disabled = false;
      }
    });

    $('mp-novo').addEventListener('click', () => {
      novoPedido(estado);
      $('mp-cliente-busca').value = '';
      $('mp-produto-busca').value = '';
      $('mp-cliente-lista').innerHTML = '';
      $('mp-produto-lista').innerHTML = '';
      $('mp-produto-escolha').hidden = true;
      mostrarAlerta('');
      pintar(estado);
    });

    await prepararEmpresa();
  }

  if (typeof root.document !== 'undefined') {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => { iniciar().catch((erro) => mostrarAlerta(erro.message)); });
    } else {
      iniciar().catch((erro) => mostrarAlerta(erro.message));
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
