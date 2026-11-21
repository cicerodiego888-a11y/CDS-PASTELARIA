/**
 * PDV no celular. O fechamento usa o pagamento sequencial e o POST /api/vendas
 * do PDV do computador. Não há outro motor de preço, estoque ou fiscal.
 */
(function (root) {
  'use strict';

  const MOBILE_INSTALLATION_KEY = 'cds_mobile_installation_id_v1';
  const MOBILE_TERMINAL_HEARTBEAT_MS = 2 * 60 * 1000;

  function apiUrl() {
    if (typeof root.API_URL === 'string' && root.API_URL) return root.API_URL;
    if (root.location && root.location.origin) return root.location.origin + '/api';
    return '/api';
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

  function headers() {
    const contexto = root.CdsEmpresaContexto;
    const h = contexto && typeof contexto.headersJson === 'function'
      ? contexto.headersJson()
      : null;
    const token = root.localStorage ? (root.localStorage.getItem('token') || '') : '';
    const resultado = h || {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: token ? 'Bearer ' + token : ''
    };
    const installationId = root.__cdsMobileInstallationId;
    const terminalId = Number(root.__cdsMobileTerminalId);
    if (installationId) resultado['X-Mobile-Installation-Id'] = installationId;
    if (Number.isInteger(terminalId) && terminalId > 0) {
      resultado['X-Terminal-Id'] = String(terminalId);
    }
    return resultado;
  }

  function atualizarStatusTerminalMobile(texto) {
    const el = root.document && root.document.getElementById('mv-terminal-status');
    if (el) el.textContent = texto;
  }

  function atualizarStatusCaixaMobile(texto) {
    const el = root.document && root.document.getElementById('mv-caixa-status');
    if (el) el.textContent = texto;
  }

  function marcarSessaoMobileExpirada() {
    root.__cdsMobileSessionValid = false;
    atualizarStatusTerminalMobile('Sessão expirada. Entre novamente para continuar.');
    const abrir = root.document && root.document.getElementById('mv-abrir-caixa');
    const fechar = root.document && root.document.getElementById('mv-fechar-caixa');
    const finalizar = root.document && root.document.getElementById('mv-finalizar');
    if (abrir) abrir.disabled = true;
    if (fechar) fechar.disabled = true;
    if (finalizar) finalizar.disabled = true;
    if (root.location && typeof root.location.replace === 'function') {
      root.location.replace('/login?next=/mobile-pdv');
    }
  }

  async function fetchMobileMonitorado(fetchFn, url, opcoes = {}) {
    const resposta = await fetchFn(url, {
      ...opcoes,
      headers: Object.assign({}, headers(), opcoes.headers || {})
    });
    let erroSessao = resposta && resposta.status === 401;
    if (!erroSessao && resposta && resposta.status === 403 && typeof resposta.clone === 'function') {
      const corpo = await resposta.clone().json().catch(() => null);
      erroSessao = Boolean(corpo && corpo.code === 'SESSAO_INVALIDA');
    }
    if (erroSessao) marcarSessaoMobileExpirada();
    return resposta;
  }

  function fetchPdv(url, opcoes) {
    return fetchMobileMonitorado(root.fetch.bind(root), url, opcoes);
  }

  async function requisicaoJsonMobile(fetchFn, caminho, metodo = 'GET', corpo) {
    const opcoes = { method: metodo, headers: headers() };
    if (corpo !== undefined) {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }
    const resposta = await fetchMobileMonitorado(
      fetchFn,
      apiUrl() + caminho,
      opcoes
    );
    const dados = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      const err = new Error(dados.error || dados.mensagem || ('HTTP ' + resposta.status));
      err.status = resposta.status;
      err.code = dados.code || dados.codigo;
      err.body = dados;
      throw err;
    }
    return dados;
  }

  async function obterModoFiscalOperacao(fetchFn) {
    const configuracao = await requisicaoJsonMobile(
      fetchFn,
      '/configuracoes/modo_dashboard_fiscal'
    );
    if (!configuracao || configuracao.valor == null) {
      const erro = new Error('O servidor não retornou o modo fiscal configurado.');
      erro.code = 'MODO_FISCAL_AUSENTE';
      throw erro;
    }

    const valor = configuracao.valor;
    if (valor === true || valor === 1 || valor === '1' || String(valor).toLowerCase() === 'true') {
      return true;
    }
    if (valor === false || valor === 0 || valor === '0' || String(valor).toLowerCase() === 'false') {
      return false;
    }

    const erro = new Error('O servidor retornou um modo fiscal inválido.');
    erro.code = 'MODO_FISCAL_INVALIDO';
    throw erro;
  }

  function gerarUuidSeguro(cryptoApi) {
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
      const erro = new Error('Este navegador não oferece geração segura de identidade Mobile.');
      erro.code = 'IDENTIDADE_SEGURA_INDISPONIVEL';
      throw erro;
    }
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join('-');
  }

  function obterIdentidadeInstalacao(storage, cryptoApi) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      throw new Error('O armazenamento local não está disponível para identificar esta instalação.');
    }
    const salvo = String(storage.getItem(MOBILE_INSTALLATION_KEY) || '').trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(salvo)) {
      return salvo;
    }
    const cryptoDisponivel = cryptoApi || root.crypto;
    const identidade = cryptoDisponivel && typeof cryptoDisponivel.randomUUID === 'function'
      ? cryptoDisponivel.randomUUID().toLowerCase()
      : gerarUuidSeguro(cryptoDisponivel);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identidade)) {
      throw new Error('O navegador gerou uma identidade Mobile inválida.');
    }
    storage.setItem(MOBILE_INSTALLATION_KEY, identidade);
    return identidade;
  }

  function lerHandoff(storage) {
    if (!storage) return null;
    const bruto = storage.getItem('pdvPedidoHandoff');
    if (!bruto) return null;
    try {
      return JSON.parse(bruto);
    } catch (_erro) {
      return { invalido: true };
    }
  }

  function usuarioSessao() {
    try {
      return JSON.parse(root.localStorage.getItem('user') || 'null');
    } catch (_erro) {
      return null;
    }
  }

  function destinoRetornoMesa(storage, empresaId, pedidoId) {
    if (!storage) return null;
    let registro;
    try { registro = JSON.parse(storage.getItem('cdsMesaRetorno') || 'null'); } catch (_erro) { return null; }
    const mesa = Number(registro && registro.mesa_id);
    if (!Number.isInteger(mesa) || mesa <= 0) return null;
    if (empresaId && registro.empresa != null && String(registro.empresa) !== String(empresaId)) return null;
    if (pedidoId && Number(registro.pedido_id) !== Number(pedidoId)) return null;
    return '/mobile-mesas/?mesa=' + mesa;
  }

  function handoffCompativelComSessao(handoff, usuario, empresaId) {
    if (!handoff || handoff.invalido) {
      return { ok: false, codigo: 'HANDOFF_INVALIDO', mensagem: 'Os dados do pedido não puderam ser lidos.' };
    }
    const operadorHandoff = Number(handoff.sessao_operador_id);
    const operadorAtual = Number(usuario && (usuario.id || usuario.usuario_id));
    if (operadorHandoff > 0 && operadorAtual > 0 && operadorHandoff !== operadorAtual) {
      return {
        ok: false,
        codigo: 'OPERADOR_DIVERGENTE',
        mensagem: 'Este pedido foi preparado por outro operador. A operação não foi aberta.'
      };
    }
    if (empresaId && handoff.empresa_id != null && String(handoff.empresa_id) !== String(empresaId)) {
      return {
        ok: false,
        codigo: 'EMPRESA_DIVERGENTE',
        mensagem: 'Este pedido pertence a outra empresa. A operação não foi aberta.'
      };
    }
    return { ok: true };
  }

  function nomeOperador() {
    try {
      const user = JSON.parse(root.localStorage.getItem('user') || 'null');
      return (user && (user.nome || user.username)) || '';
    } catch (_erro) {
      return '';
    }
  }

  function estacaoComPinpad() {
    return Boolean(root.electronAPI);
  }

  async function obterConfiguracaoPagamento(fetchFn, precisaPix) {
    const resposta = await fetchFn(apiUrl() + '/tef/fluxo-pdv', { headers: headers() });
    if (!resposta.ok) throw new Error('Não foi possível verificar a configuração de pagamento.');
    const fluxo = await resposta.json();
    if (!fluxo || typeof fluxo.tefHabilitado !== 'boolean') {
      throw new Error('Configuração de TEF inválida. Pagamento não iniciado.');
    }
    let pixIntegracaoHabilitada = false;
    if (!fluxo.tefHabilitado && precisaPix) {
      const respostaPix = await fetchFn(apiUrl() + '/pix/config', { headers: headers() });
      if (!respostaPix.ok) throw new Error('Não foi possível verificar a configuração do PIX.');
      const pix = await respostaPix.json();
      if (!pix || pix.success !== true || !pix.config || typeof pix.config !== 'object'
        || Array.isArray(pix.config)
        || (pix.config.ativo != null && typeof pix.config.ativo !== 'boolean')) {
        throw new Error('Configuração de PIX inválida. Pagamento não iniciado.');
      }
      pixIntegracaoHabilitada = pix.config.ativo === true;
    }
    return {
      tefHabilitado: fluxo.tefHabilitado,
      modoConfirmacaoFiscal: fluxo.modoConfirmacaoFiscal,
      pixIntegracaoHabilitada
    };
  }

  function textoSmartPosSimulado(retorno) {
    if (!retorno || (retorno.simulado !== true && retorno.modo !== 'simulacao')) return '';
    return 'Simulação de Smart POS. Este resultado não é um recebimento real.';
  }

  async function autorizarEletronico(forma, valor, chave, fetchFn) {
    if (!estacaoComPinpad()) {
      return {
        aprovado: false,
        status: 'erro',
        codigo: 'TEF_ESTACAO',
        mensagem: 'PIX, débito e crédito são confirmados na estação com o pinpad. Este celular não autoriza o pagamento.'
      };
    }
    const fluxo = root.TefFluxoPagamento;
    const resp = await fetchFn(apiUrl() + '/tef/pagar', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        tipo: fluxo.normalizarTipoTef(forma),
        valor: Number(valor),
        parcelas: 1,
        idempotency_key: chave
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        aprovado: false,
        status: data.status || (data.codigo === 'TIMEOUT' ? 'timeout' : 'erro'),
        codigo: data.codigo || 'ERRO',
        tipo_erro: data.tipo_erro || null,
        mensagem: data.mensagem || data.error || 'Pagamento não aprovado.',
        transacao_id: data.transacao_id || null
      };
    }
    return data;
  }

  function prepararVendaPorValor(valorRaw, quantidadeRaw) {
    const oficial = root.PdvVendaPorValor;
    if (!oficial || typeof oficial.validarEntrada !== 'function') {
      return { ok: false, mensagem: 'A venda por valor do PDV não está disponível.' };
    }
    const validacao = oficial.validarEntrada(valorRaw, quantidadeRaw);
    if (!validacao.ok) return { ok: false, mensagem: validacao.message };
    return {
      ok: true,
      endpoint: oficial.ENDPOINT,
      corpo: {
        valor_total: validacao.valor,
        quantidade_pasteis: validacao.quantidade
      }
    };
  }

  function precoAvulso(produto) {
    if (produto.preco_promocional != null && produto.preco_promocional !== '') {
      return Number(produto.preco_promocional);
    }
    return Number(produto.preco_venda || 0);
  }

  async function identificarProduto(codigo, fetchFn) {
    const resp = await fetchFn(apiUrl() + '/produtos/identificar', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ codigo: String(codigo || '').trim(), contexto: { origem: 'pdv' } })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, mensagem: data.error || data.mensagem || 'A identificação do produto falhou.' };
    }
    return { ok: true, encontrado: data.encontrado === true, produtoId: data.produtoId || null };
  }

  async function cotarProduto(produtoId, quantidade, fetchFn) {
    const pedido = fetchFn || root.fetch.bind(root);
    const h = headers();
    const produtoResp = await pedido(apiUrl() + '/produtos/' + produtoId, { headers: h });
    const produto = await produtoResp.json().catch(() => ({}));
    if (!produtoResp.ok) {
      return { ok: false, mensagem: produto.error || produto.mensagem || 'O produto não foi carregado.' };
    }
    const promoResp = await pedido(apiUrl() + '/produtos/' + produtoId + '/promocao-ativa', { headers: h });
    const promocao = await promoResp.json().catch(() => null);
    const faixaResp = await pedido(apiUrl() + '/produtos/' + produtoId + '/atacado', { headers: h });
    const faixas = await faixaResp.json().catch(() => []);
    if (!root.PdvPrecoComercial || typeof root.PdvPrecoComercial.montarLinha !== 'function') {
      return { ok: false, mensagem: 'O motor de preço do PDV não está disponível nesta tela.' };
    }
    return {
      ok: true,
      linha: root.PdvPrecoComercial.montarLinha({
        produto,
        quantidade,
        precoInformado: produto.preco_venda,
        promocao: promocao && promocao.id ? promocao : null,
        faixas: Array.isArray(faixas) ? faixas : []
      })
    };
  }

  async function acompanharCobranca(chave, fetchFn) {
    const correlacao = String(chave || '').trim();
    if (!correlacao) {
      return { aprovado: false, status: 'erro', codigo: 'CORRELACAO_AUSENTE', mensagem: 'Informe o identificador da cobrança.' };
    }
    const resp = await fetchFn(apiUrl() + '/tef/acompanhamento?idempotency_key=' + encodeURIComponent(correlacao), {
      headers: headers()
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        aprovado: false,
        status: data.status || 'erro',
        codigo: data.code || 'ERRO',
        mensagem: data.error || 'Falha ao consultar a estação.',
        autenticacao: resp.status === 401
      };
    }
    if (data.aprovado !== true || !data.transacao_id) {
      return {
        aprovado: false,
        status: data.status || 'pendente',
        codigo: 'AGUARDANDO_ESTACAO',
        transacao_id: data.transacao_id || null,
        mensagem: 'A cobrança ainda não foi confirmada na estação. A parcela não entrou.'
      };
    }
    return {
      aprovado: true,
      status: 'aprovado',
      transacao_id: data.transacao_id,
      valor: Number(data.valor),
      tipo: data.tipo || null
    };
  }

  function formaDaTransacao(tipo) {
    const nome = String(tipo || '').toLowerCase();
    if (nome === 'pix' || nome === 'pix_tef') return 'pix';
    if (nome === 'debito' || nome === 'cartao_debito') return 'cartao_debito';
    if (nome === 'credito' || nome === 'cartao_credito') return 'cartao_credito';
    return '';
  }

  async function vincularCobrancaConfirmada(entrada) {
    const retorno = entrada.retorno;
    if (!retorno || retorno.aprovado !== true || !retorno.transacao_id) {
      return { ok: false, codigo: 'SEM_CONFIRMACAO', mensagem: 'Pagamento sem confirmação da estação não é registrado.' };
    }
    const sequencial = root.PagamentoSequencial;
    const repetida = sequencial.exportar().some((parcela) => String(parcela.tef_transacao_id) === String(retorno.transacao_id));
    if (repetida) {
      return { ok: false, codigo: 'TRANSACAO_JA_VINCULADA', mensagem: 'Essa cobrança já está na venda.' };
    }
    const forma = formaDaTransacao(retorno.tipo) || entrada.forma;
    const valor = Number.isFinite(Number(retorno.valor)) ? Number(retorno.valor) : Number(entrada.valor);
    return sequencial.adicionar({
      forma,
      valor,
      totalVenda: entrada.totalVenda,
      tefHabilitado: true,
      autorizarTef: async () => ({
        aprovado: true,
        status: 'aprovado',
        transacao_id: retorno.transacao_id
      })
    });
  }

  async function solicitarEmissao(entrada) {
    if (!entrada || !entrada.vendaId) {
      return { ok: false, codigo: 'VENDA_AUSENTE', mensagem: 'A venda ainda não foi registrada.' };
    }
    if (entrada.distribuicaoAutorizada !== true) {
      return { ok: false, codigo: 'DISTRIBUICAO_NAO_AUTORIZADA', mensagem: 'A emissão fica bloqueada sem a distribuição autorizada.' };
    }
    if (entrada.transmitir !== true) {
      return {
        ok: false,
        codigo: 'EMISSAO_NAO_LIBERADA',
        mensagem: 'A transmissão à SEFAZ não está liberada nesta etapa.'
      };
    }
    const resp = await entrada.fetch(apiUrl() + '/fiscal/emitir/venda/' + entrada.vendaId, {
      method: 'POST',
      headers: entrada.headers || headers(),
      body: '{}'
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  }

  function descreverSituacaoFiscal(resultado = {}) {
    const venda = resultado.venda && typeof resultado.venda === 'object'
      ? resultado.venda
      : {};
    const fiscal = resultado.fiscal && typeof resultado.fiscal === 'object'
      ? resultado.fiscal
      : (venda.fiscal && typeof venda.fiscal === 'object' ? venda.fiscal : null);
    const documentoFiscal = venda.documento_fiscal && typeof venda.documento_fiscal === 'object'
      ? venda.documento_fiscal
      : null;
    const emissaoSolicitada = Boolean(
      (resultado.corpo && resultado.corpo.emitir_fiscal === true)
      || venda.emitir_fiscal === true
    );

    if (documentoFiscal && documentoFiscal.bloqueado === true) {
      const motivo = documentoFiscal.motivo || documentoFiscal.codigo || '';
      return {
        situacao: 'Solicitação fiscal bloqueada',
        detalhe: String(motivo),
        emissao: String(motivo || 'A emissão foi bloqueada pelo servidor.')
      };
    }

    if (fiscal) {
      const status = String(fiscal.status || '').trim().toLowerCase();
      const mensagem = String(fiscal.message || fiscal.mensagem || '').trim();
      let situacao = status;
      if (status === 'autorizada') situacao = 'Autorizada';
      else if (status.startsWith('rejeitada')) situacao = 'Rejeitada';
      else if (['xml_preparado', 'soap_enviado', 'em_processamento', 'processando'].includes(status)) {
        situacao = 'Em processamento';
      } else if (['solicitada', 'aguardando_pagamento'].includes(status)) {
        situacao = status === 'solicitada' ? 'Fiscal solicitada' : 'Pendente de processamento';
      } else if (['pendente', 'enfileirada', 'aguardando_processamento'].includes(status)) {
        situacao = 'Pendente de processamento';
      } else if (status === 'sem_itens_fiscais') {
        situacao = 'Não fiscal';
      } else if (status === 'configuracao_pendente') {
        situacao = 'Configuração fiscal pendente';
      } else if (status === 'erro_emissao') {
        situacao = 'Erro na emissão';
      } else if (status === 'erro_transmissao') {
        situacao = 'Erro na transmissão';
      } else if (status === 'erro_validacao') {
        situacao = 'Erro de validação fiscal';
      } else if (status === 'recomposicao_bloqueada') {
        situacao = 'Emissão bloqueada';
      } else if (!status && emissaoSolicitada) {
        situacao = 'Fiscal solicitada';
      } else if (!status) {
        situacao = 'Situação fiscal não informada pelo servidor';
      }

      const numero = fiscal.numero != null ? 'NFC-e #' + String(fiscal.numero) : '';
      const emissao = [numero, mensagem].filter(Boolean).join(' · ');
      return {
        situacao: situacao || 'Situação fiscal não informada pelo servidor',
        detalhe: mensagem,
        emissao: situacao === 'Não fiscal' ? '' : (emissao || situacao)
      };
    }

    const valorFiscal = venda.valor_fiscal == null || venda.valor_fiscal === ''
      ? NaN
      : Number(venda.valor_fiscal);
    const valorNaoFiscal = venda.valor_nao_fiscal == null || venda.valor_nao_fiscal === ''
      ? NaN
      : Number(venda.valor_nao_fiscal);
    const situacaoVenda = String(venda.situacao_fiscal || venda.status_fiscal || '')
      .trim()
      .toLowerCase();
    if (situacaoVenda === 'nao_fiscal' || situacaoVenda === 'não fiscal'
      || (Number.isFinite(valorFiscal) && valorFiscal <= 0
        && Number.isFinite(valorNaoFiscal) && valorNaoFiscal > 0)) {
      return { situacao: 'Não fiscal', detalhe: '', emissao: '' };
    }
    if (emissaoSolicitada) {
      return {
        situacao: 'Fiscal solicitada',
        detalhe: 'O servidor ainda não retornou o resultado da emissão.',
        emissao: 'Solicitação enviada; resultado de emissão ainda não retornado.'
      };
    }
    if (resultado.corpo && resultado.corpo.emitir_fiscal === false) {
      return {
        situacao: 'Fiscal não solicitada',
        detalhe: Number.isFinite(valorFiscal) && valorFiscal > 0
          ? 'A resposta informa valor fiscal, mas não contém solicitação de emissão.'
          : 'A requisição de venda não solicitou emissão fiscal.',
        emissao: ''
      };
    }
    return {
      situacao: 'Situação fiscal não informada pelo servidor',
      detalhe: 'A resposta da venda não trouxe dados suficientes para determinar o estado fiscal.',
      emissao: ''
    };
  }

  function valorTotalRetornado(venda) {
    if (!venda || typeof venda !== 'object') return null;
    const raw = venda.total != null ? venda.total : venda.valor_total;
    if (raw == null || raw === '') return null;
    const total = Number(raw);
    return Number.isFinite(total) ? total : null;
  }

  async function fechar(entrada) {
    if (entrada.vendaPersistida && entrada.vendaPersistida.id) {
      return {
        ok: false,
        bloqueado: true,
        mensagem: 'Venda ' + entrada.vendaPersistida.id + ' já foi registrada. Nenhuma segunda venda foi criada.'
      };
    }
    if (entrada.enviando) {
      return { ok: false, bloqueado: true, mensagem: 'A venda já está sendo processada.' };
    }
    const oficial = root.PdvFechamentoOficial;
    const sequencial = root.PagamentoSequencial;
    const fluxo = root.TefFluxoPagamento;
    const fetchFn = entrada.fetch;
    const parcelas = sequencial.exportar();
    const total = Number(entrada.total);
    if (sequencial.recomposicaoNecessaria()) {
      if (sequencial.autorizacaoDigitalPendente() || Math.abs(sequencial.soma() - total) > 0.009) {
        return { ok: false, codigo: 'SALDO_PENDENTE', mensagem: 'A composição em dinheiro ainda aguarda os pagamentos. A venda não foi finalizada.' };
      }
      if (!sequencial.composicaoValida()) {
        return { ok: false, codigo: 'COMPOSICAO_INVALIDA', mensagem: 'A composição dos pagamentos não foi validada. A venda não foi finalizada.' };
      }
    }
    let modoFiscalAtivo;
    try {
      modoFiscalAtivo = await obterModoFiscalOperacao(fetchFn);
    } catch (erro) {
      return {
        ok: false,
        codigo: erro.code || (erro.status ? 'HTTP_' + erro.status : 'MODO_FISCAL_INDISPONIVEL'),
        mensagem: 'Não foi possível consultar a configuração fiscal oficial. A venda não foi enviada. '
          + (erro.message || '')
      };
    }
    let distribuicao;
    try {
      const resp = await fetchFn(apiUrl() + '/vendas/pre-calcular-distribuicao', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          itens: oficial.itensParaApi(entrada.itens),
          emitir_fiscal: modoFiscalAtivo,
          pagamentos: parcelas,
          desconto: Number(entrada.desconto || 0),
          acrescimo: 0
        })
      });
      distribuicao = await resp.json().catch(() => ({}));
      if (!resp.ok || !distribuicao.sucesso) {
        return {
          ok: false,
          codigo: distribuicao.code || distribuicao.codigo || 'CAIXA_OU_DISTRIBUICAO',
          mensagem: distribuicao.error || distribuicao.mensagem || 'A distribuição oficial não autorizou a venda.'
        };
      }
    } catch (_erro) {
      return { ok: false, mensagem: 'Sem conexão ao calcular a distribuição. A venda não foi enviada.' };
    }
    const dadosFechamento = {
      fluxo,
      parcelas,
      total,
      desconto: entrada.desconto || 0,
      itens: entrada.itens,
      handoff: entrada.handoff,
      clienteId: entrada.clienteId || null,
      chave: entrada.chave,
      valorFiscal: distribuicao.valor_fiscal,
      valorNaoFiscal: distribuicao.valor_nao_fiscal,
      modoFiscalAtivo,
      modoConfirmacaoFiscal: entrada.modoConfirmacaoFiscal || 'TEF',
      tefHabilitado: entrada.tefHabilitado === true
    };
    let montado = oficial.montarCorpo(dadosFechamento);
    if (montado.codigo === 'CONFIRMACAO_MANUAL_NECESSARIA' && typeof entrada.confirmarRecebimento === 'function') {
      let confirmado;
      try {
        confirmado = await entrada.confirmarRecebimento(parcelas);
      } catch (erro) {
        return {
          ok: false,
          codigo: 'CONFIRMACAO_INDISPONIVEL',
          mensagem: 'Não foi possível abrir a confirmação dos recebimentos. A venda não foi enviada. '
            + (erro && erro.message ? erro.message : '')
        };
      }
      if (!confirmado) {
        return { ok: false, codigo: 'CONFIRMACAO_CANCELADA', mensagem: 'Recebimento não confirmado. A venda não foi finalizada.' };
      }
      montado = oficial.montarCorpo({ ...dadosFechamento, confirmacaoManual: true });
    }
    if (!montado.ok) return montado;
    if (sequencial.assinatura() !== entrada.assinatura && entrada.assinatura != null) {
      return { ok: false, codigo: 'PAGAMENTOS_ALTERADOS', mensagem: 'Os pagamentos foram alterados. Confira e finalize novamente.' };
    }
    let respVenda;
    try {
      respVenda = await fetchFn(apiUrl() + '/vendas', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(montado.corpo)
      });
    } catch (_erro) {
      return { ok: false, mensagem: 'Sem conexão ao gravar a venda. Confira o histórico antes de tentar de novo.', chave: montado.corpo.chave_fechamento_pdv };
    }
    const venda = await respVenda.json().catch(() => ({}));
    if (!respVenda.ok) {
      return {
        ok: false,
        codigo: venda.code || venda.codigo,
        mensagem: venda.mensagem || venda.error || 'A venda não foi gravada.',
        chave: montado.corpo.chave_fechamento_pdv
      };
    }
    const vendaId = Number(venda.venda_id || venda.id);
    if (!(vendaId > 0)) {
      return { ok: false, mensagem: 'A venda não foi concluída: a resposta não trouxe o identificador.', chave: montado.corpo.chave_fechamento_pdv };
    }
    let vinculo = null;
    if (entrada.handoff && entrada.handoff.pedido_id) {
      const respVinculo = await fetchFn(apiUrl() + '/pedidos/' + entrada.handoff.pedido_id + '/finalizar-venda-pdv', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ venda_id: vendaId })
      });
      vinculo = await respVinculo.json().catch(() => ({}));
      if (!respVinculo.ok || Number(vinculo.venda_id) !== vendaId) {
        return {
          ok: false,
          vendaId,
          codigo: vinculo.codigo,
          mensagem: vinculo.mensagem || vinculo.error || 'A venda ' + vendaId + ' foi gravada, mas o pedido não foi vinculado.',
          chave: montado.corpo.chave_fechamento_pdv
        };
      }
    }
    return {
      ok: true,
      vendaId,
      venda,
      vinculo,
      fiscal: venda.fiscal || null,
      chave: montado.corpo.chave_fechamento_pdv,
      corpo: montado.corpo
    };
  }

  const api = {
    lerHandoff,
    destinoRetornoMesa,
    handoffCompativelComSessao,
    obterIdentidadeInstalacao,
    requisicaoJsonMobile,
    MOBILE_INSTALLATION_KEY,
    MOBILE_TERMINAL_HEARTBEAT_MS,
    prepararVendaPorValor,
    autorizarEletronico,
    obterConfiguracaoPagamento,
    precoAvulso,
    identificarProduto,
    cotarProduto,
    acompanharCobranca,
    vincularCobrancaConfirmada,
    obterModoFiscalOperacao,
    solicitarEmissao,
    descreverSituacaoFiscal,
    valorTotalRetornado,
    fechar,
    estacaoComPinpad,
    textoSmartPosSimulado
  };
  root.MobilePdv = api;

  function $(id) {
    return root.document.getElementById(id);
  }

  function alerta(texto) {
    const el = $('mv-alerta');
    if (!el) return;
    el.hidden = !texto;
    el.textContent = texto || '';
  }

  let resolverConfirmacaoMobile = null;
  let resolverSenhaAdminMobile = null;

  function rotuloFormaPagamentoMobile(forma) {
    const formaNormalizada = String(forma || '').toLowerCase().trim();
    const rotulos = {
      pix: 'PIX',
      pix_tef: 'PIX',
      cartao_debito: 'Débito',
      debito: 'Débito',
      cartao_credito: 'Crédito',
      credito: 'Crédito',
      dinheiro: 'Dinheiro'
    };
    return rotulos[formaNormalizada] || 'Pagamento eletrônico';
  }

  function rotuloStatusPagamentoMobile(status) {
    const statusNormalizado = String(status || '').toLowerCase();
    const rotulos = {
      informada: 'Informado',
      pendente: 'Pendente',
      aprovada: 'Aprovado',
      aprovado: 'Aprovado',
      rejeitada: 'Rejeitado',
      rejeitado: 'Rejeitado',
      erro: 'Falha',
      timeout: 'Tempo esgotado'
    };
    return rotulos[statusNormalizado] || 'Pendente';
  }

  function solicitarConfirmacaoMobile(opcoes = {}) {
    const dialogo = $('mv-dialogo-confirmacao');
    const titulo = $('mv-confirmacao-titulo');
    const descricao = $('mv-confirmacao-descricao');
    const contexto = $('mv-confirmacao-contexto');
    const lista = $('mv-confirmacao-lista');
    const linhaTotal = $('mv-confirmacao-total-linha');
    const rotuloTotal = $('mv-confirmacao-total-label');
    const total = $('mv-confirmacao-total');
    const botaoCancelar = $('mv-confirmacao-cancelar');
    const botaoConfirmar = $('mv-confirmacao-confirmar');
    if (!dialogo || typeof dialogo.showModal !== 'function') {
      return Promise.reject(new Error('A confirmação não está disponível neste navegador.'));
    }
    if (resolverConfirmacaoMobile) {
      return Promise.reject(new Error('Já existe uma confirmação em andamento.'));
    }

    const itens = Array.isArray(opcoes.itens) ? opcoes.itens : [];
    const mostrarLista = opcoes.mostrarLista === true && itens.length > 0;
    const soma = itens.reduce((valor, item) => valor + Number(item.valor || 0), 0);
    titulo.textContent = opcoes.titulo || 'Confirmar recebimento';
    descricao.textContent = opcoes.descricao || '';
    contexto.textContent = opcoes.contexto || '';
    contexto.hidden = !opcoes.contexto;
    lista.hidden = !mostrarLista;
    lista.innerHTML = mostrarLista
      ? itens.map((item) => (
        '<div class="mp-confirmacao-linha"><span>'
        + escapar(rotuloFormaPagamentoMobile(item.forma_pagamento))
        + '</span><strong>' + escapar(dinheiro(item.valor)) + '</strong></div>'
      )).join('')
      : '';
    linhaTotal.hidden = itens.length === 0;
    rotuloTotal.textContent = opcoes.rotuloTotal || 'Total a confirmar';
    total.textContent = dinheiro(soma);
    botaoCancelar.textContent = opcoes.botaoCancelar || 'Cancelar';
    botaoConfirmar.textContent = opcoes.botaoConfirmar || 'Confirmar recebimentos';
    botaoConfirmar.disabled = false;
    dialogo.returnValue = '';

    return new Promise((resolve, reject) => {
      resolverConfirmacaoMobile = resolve;
      try {
        dialogo.showModal();
      } catch (erro) {
        resolverConfirmacaoMobile = null;
        reject(erro);
      }
    });
  }

  function concluirConfirmacaoMobile(confirmado) {
    if (!resolverConfirmacaoMobile) return;
    const resolver = resolverConfirmacaoMobile;
    resolverConfirmacaoMobile = null;
    resolver(confirmado);
    const dialogo = $('mv-dialogo-confirmacao');
    if (dialogo && dialogo.open && typeof dialogo.close === 'function') {
      dialogo.close(confirmado ? 'confirmado' : 'cancelado');
    }
  }

  function solicitarSenhaAdminMobile() {
    const dialogo = $('mv-dialogo-senha-admin');
    const input = $('mv-senha-admin');
    const erro = $('mv-senha-admin-erro');
    if (!dialogo || typeof dialogo.showModal !== 'function') {
      return Promise.reject(new Error('A autorização administrativa não está disponível neste navegador.'));
    }
    if (resolverSenhaAdminMobile) {
      return Promise.reject(new Error('Já existe uma solicitação de autorização em andamento.'));
    }
    input.value = '';
    erro.hidden = true;
    erro.textContent = '';
    $('mv-senha-admin-confirmar').disabled = false;
    return new Promise((resolve, reject) => {
      resolverSenhaAdminMobile = resolve;
      try {
        dialogo.showModal();
        if (typeof input.focus === 'function') input.focus();
      } catch (falha) {
        resolverSenhaAdminMobile = null;
        reject(falha);
      }
    });
  }

  function concluirSenhaAdminMobile(senha) {
    if (!resolverSenhaAdminMobile) return;
    const resolver = resolverSenhaAdminMobile;
    resolverSenhaAdminMobile = null;
    resolver(senha);
    const dialogo = $('mv-dialogo-senha-admin');
    if (dialogo && dialogo.open && typeof dialogo.close === 'function') {
      dialogo.close(senha ? 'confirmado' : 'cancelado');
    }
  }

  async function iniciar() {
    if (!root.document || !$('mv-app')) return;
    let token = '';
    try { token = root.localStorage.getItem('token') || ''; } catch (_e) { token = ''; }
    if (!token) {
      root.location.replace('/login?next=/mobile-pdv');
      return;
    }
    let operacaoSalva = null;
    if (root.CdsMobileOperacao) {
      const leitura = root.CdsMobileOperacao.lerPdv();
      if (leitura && leitura.ok) operacaoSalva = leitura.registro;
      else if (leitura && leitura.codigo === 'OPERADOR_DIVERGENTE') {
        alerta('Há um pagamento em andamento de outro operador. Ele foi mantido e não foi aberto.');
      }
    }
    if (root.PagamentoSequencial) {
      if (operacaoSalva && operacaoSalva.pagamento && typeof root.PagamentoSequencial.reidratar === 'function') {
        root.PagamentoSequencial.reidratar(operacaoSalva.pagamento);
      } else {
        root.PagamentoSequencial.reset();
      }
    }
    const handoff = lerHandoff(root.sessionStorage);
    if (handoff) $('mv-busca-livre').hidden = true;
    const contexto = root.CdsEmpresaContexto;
    if (contexto && typeof contexto.adotarEmpresaPadrao === 'function') {
      try {
        await contexto.adotarEmpresaPadrao();
      } catch (erro) {
        if (erro && erro.status === 401 && root.location) {
          root.location.replace('/login?next=/mobile-pdv');
          return;
        }
        alerta((erro && erro.message) || 'A empresa padrão da loja não pôde ser usada.');
      }
    }
    const empresaId = contexto && contexto.lerEmpresaId ? contexto.lerEmpresaId() : null;
    const empresa = contexto && contexto.lerEmpresa ? contexto.lerEmpresa() : null;
    $('mv-empresa').textContent = empresa
      ? (empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id))
      : 'Empresa não selecionada';
    $('mv-operador-nome').textContent = nomeOperador() || 'Operador da sessão atual';

    let mobileInstallationId = null;
    let mobileTerminalId = null;
    let mobileTerminalReady = false;
    let mobileHeartbeatOk = false;
    let mobileSessionValid = true;
    let caixaMobileAtual = null;
    let operacaoCaixaEmCurso = false;
    let heartbeatMobileTimer = null;
    let heartbeatMobileEmCurso = false;

    root.__cdsMobileSessionValid = true;
    root.__cdsMobileInstallationId = null;
    root.__cdsMobileTerminalId = null;

    function operacaoCaixaDisponivel() {
      return mobileSessionValid
        && root.__cdsMobileSessionValid !== false
        && mobileTerminalReady
        && mobileHeartbeatOk
        && !(root.navigator && root.navigator.onLine === false)
        && Boolean(caixaMobileAtual);
    }

    function atualizarPainelTerminalCaixa() {
      const estadoTerminal = !mobileSessionValid
        ? 'Sessão expirada.'
        : !mobileTerminalReady
          ? 'Identificando terminal Mobile…'
          : !mobileHeartbeatOk || root.navigator && root.navigator.onLine === false
            ? 'Sem conexão com o servidor.'
            : 'Terminal Mobile reconhecido.';
      atualizarStatusTerminalMobile(estadoTerminal);
      const terminalResumo = $('mv-terminal-resumo');
      if (terminalResumo) {
        terminalResumo.textContent = mobileTerminalId
          ? 'Terminal Mobile #' + mobileTerminalId
          : 'Terminal Mobile';
      }

      const estadoCaixa = !mobileTerminalReady
        ? 'Aguardando reconhecimento do terminal.'
        : !mobileHeartbeatOk || root.navigator && root.navigator.onLine === false
          ? 'Caixa indisponível sem conexão confirmada.'
          : caixaMobileAtual
            ? 'Caixa aberto neste terminal.'
            : 'Caixa não aberto. A abertura criará um caixa exclusivo para este Mobile.';
      atualizarStatusCaixaMobile(estadoCaixa);
      const resumoStatus = $('mv-caixa-resumo-status');
      if (resumoStatus) {
        const estadoResumo = caixaMobileAtual
          ? 'aberto'
          : !mobileTerminalReady || !mobileHeartbeatOk || root.navigator && root.navigator.onLine === false
            ? 'indisponivel'
            : 'fechado';
        resumoStatus.textContent = estadoResumo === 'aberto'
          ? 'Caixa aberto'
          : estadoResumo === 'fechado'
            ? 'Caixa não aberto'
            : 'Caixa indisponível';
        if (typeof resumoStatus.setAttribute === 'function') {
          resumoStatus.setAttribute('data-estado', estadoResumo);
        }
      }
      const resumoDetalhe = $('mv-caixa-resumo-detalhe');
      if (resumoDetalhe) {
        const sessao = caixaMobileAtual && caixaMobileAtual.sessao || {};
        resumoDetalhe.textContent = caixaMobileAtual
          ? 'Caixa #' + (caixaMobileAtual.id || sessao.caixa_turno_id || '—')
          + ' · Sessão #' + (sessao.id || '—')
          : '';
      }

      const painelAbrir = $('mv-caixa-abrir');
      const painelAberto = $('mv-caixa-aberto');
      const botaoAbrir = $('mv-abrir-caixa');
      const botaoFechar = $('mv-fechar-caixa');
      const detalhe = $('mv-caixa-detalhe');
      if (painelAbrir) painelAbrir.hidden = Boolean(caixaMobileAtual);
      if (painelAberto) painelAberto.hidden = !caixaMobileAtual;
      if (botaoAbrir) {
        botaoAbrir.disabled = !mobileSessionValid
          || !mobileTerminalReady
          || !mobileHeartbeatOk
          || root.navigator && root.navigator.onLine === false
          || Boolean(caixaMobileAtual)
          || operacaoCaixaEmCurso;
      }
      if (botaoFechar) {
        botaoFechar.disabled = !operacaoCaixaDisponivel() || operacaoCaixaEmCurso;
      }
      if (detalhe && caixaMobileAtual) {
        const sessao = caixaMobileAtual.sessao || {};
        detalhe.textContent = 'Sessão #' + (sessao.id || '—')
          + ' · Caixa #' + (caixaMobileAtual.id || sessao.caixa_turno_id || '—');
      }
      const saldo = $('mv-caixa-saldo');
      if (saldo) saldo.textContent = caixaMobileAtual && caixaMobileAtual.saldo_geral != null
        ? dinheiro(caixaMobileAtual.saldo_geral)
        : '—';
      const recebido = $('mv-caixa-recebido');
      if (recebido) recebido.textContent = caixaMobileAtual && caixaMobileAtual.total_recebido != null
        ? dinheiro(caixaMobileAtual.total_recebido)
        : '—';

      const podePagar = operacaoCaixaDisponivel();
      if (typeof root.document.querySelectorAll === 'function') {
        root.document.querySelectorAll('#mv-formas button').forEach((botao) => {
          botao.disabled = !podePagar || operacaoCaixaEmCurso;
        });
      }
      const finalizar = $('mv-finalizar');
      if (finalizar) finalizar.disabled = !podePagar || operacaoCaixaEmCurso;
    }

    function tratarFalhaTerminalMobile(erro) {
      const status = Number(erro && erro.status);
      if (status === 401 || (status === 403 && erro.code === 'SESSAO_INVALIDA')) {
        mobileSessionValid = false;
        marcarSessaoMobileExpirada();
        atualizarPainelTerminalCaixa();
        return;
      }
      if (!status || status >= 500) {
        mobileHeartbeatOk = false;
        atualizarStatusTerminalMobile('Sem conexão com o servidor.');
      } else {
        atualizarStatusTerminalMobile(erro.message || 'Terminal não autorizado.');
      }
      atualizarPainelTerminalCaixa();
    }

    async function consultarCaixaMobile() {
      const resumo = await requisicaoJsonMobile(
        root.fetch.bind(root),
        '/caixa/aberto'
      );
      caixaMobileAtual = resumo || null;
      atualizarPainelTerminalCaixa();
      if (caixaMobileAtual && !$('mv-caixa-painel').hidden) {
        await consultarMovimentacoesCaixaMobile();
      } else if (!caixaMobileAtual) {
        const lista = $('mv-caixa-movimentacoes');
        const status = $('mv-caixa-movimentacoes-status');
        if (lista) lista.innerHTML = '';
        if (status) status.textContent = 'Abra um caixa para consultar as movimentações.';
      }
      return caixaMobileAtual;
    }

    async function consultarMovimentacoesCaixaMobile() {
      const lista = $('mv-caixa-movimentacoes');
      const status = $('mv-caixa-movimentacoes-status');
      if (!caixaMobileAtual || !caixaMobileAtual.id) {
        if (lista) lista.innerHTML = '';
        if (status) status.textContent = 'Nenhum caixa aberto neste terminal.';
        return;
      }
      if (status) status.textContent = 'Consultando movimentações…';
      try {
        const movimentacoes = await requisicaoJsonMobile(
          root.fetch.bind(root),
          '/caixa/movimentacoes/' + encodeURIComponent(String(caixaMobileAtual.id))
        );
        if (!Array.isArray(movimentacoes)) {
          throw new Error('O servidor retornou movimentações em formato inválido.');
        }
        if (lista) {
          lista.innerHTML = movimentacoes.map((movimentacao) => {
            const nome = movimentacao.motivo || movimentacao.tipo_movimentacao
              || movimentacao.tipo || 'Movimentação';
            const data = movimentacao.criado_em || movimentacao.created_at || '';
            return '<li><div><span>' + escapar(nome) + '</span><span>'
              + escapar(data) + '</span></div><strong>'
              + escapar(dinheiro(movimentacao.valor)) + '</strong></li>';
          }).join('');
        }
        if (status) status.textContent = movimentacoes.length
          ? movimentacoes.length + ' movimentação(ões).'
          : 'Nenhuma movimentação registrada.';
      } catch (erro) {
        if (status) status.textContent = erro.message
          || 'Não foi possível consultar as movimentações do caixa.';
        tratarFalhaTerminalMobile(erro);
      }
    }

    async function registrarIdentidadeMobile() {
      if (!mobileInstallationId) {
        throw new Error('Não foi possível gerar uma identidade segura para esta instalação.');
      }
      if (!empresaId) {
        throw new Error('Selecione uma empresa autorizada antes de registrar o terminal Mobile.');
      }
      const resposta = await requisicaoJsonMobile(
        root.fetch.bind(root),
        '/terminais/mobile/registro',
        'POST',
        { installation_id: mobileInstallationId }
      );
      const id = Number(resposta.id);
      if (!Number.isInteger(id) || id <= 0 || resposta.tipo !== 'mobile') {
        throw new Error('O servidor não retornou um terminal Mobile válido.');
      }
      mobileTerminalId = id;
      mobileTerminalReady = true;
      mobileHeartbeatOk = true;
      root.__cdsMobileInstallationId = mobileInstallationId;
      root.__cdsMobileTerminalId = mobileTerminalId;
      atualizarPainelTerminalCaixa();
      return resposta;
    }

    async function enviarHeartbeatMobile() {
      if (heartbeatMobileEmCurso || !mobileSessionValid
        || root.__cdsMobileSessionValid === false || !mobileInstallationId) return;
      heartbeatMobileEmCurso = true;
      try {
        if (!mobileTerminalReady) {
          await registrarIdentidadeMobile();
          return;
        }
        await requisicaoJsonMobile(
          root.fetch.bind(root),
          '/terminais/mobile/heartbeat',
          'POST',
          {
            installation_id: mobileInstallationId,
            terminal_id: mobileTerminalId
          }
        );
        mobileHeartbeatOk = true;
        atualizarPainelTerminalCaixa();
      } catch (erro) {
        tratarFalhaTerminalMobile(erro);
      } finally {
        heartbeatMobileEmCurso = false;
      }
    }

    function iniciarHeartbeatMobile() {
      if (!heartbeatMobileTimer && typeof root.setInterval === 'function') {
        heartbeatMobileTimer = root.setInterval(
          enviarHeartbeatMobile,
          MOBILE_TERMINAL_HEARTBEAT_MS
        );
      }
      if (typeof root.addEventListener === 'function') {
        root.addEventListener('offline', () => {
          mobileHeartbeatOk = false;
          atualizarPainelTerminalCaixa();
        });
        root.addEventListener('online', async () => {
          await enviarHeartbeatMobile();
          if (mobileHeartbeatOk && mobileTerminalReady) {
            try { await consultarCaixaMobile(); } catch (erro) { tratarFalhaTerminalMobile(erro); }
          }
        });
      }
    }

    try {
      mobileInstallationId = obterIdentidadeInstalacao(root.localStorage, root.crypto);
      root.__cdsMobileInstallationId = mobileInstallationId;
      atualizarStatusTerminalMobile('Identificando terminal Mobile…');
      await registrarIdentidadeMobile();
      await consultarCaixaMobile();
    } catch (erro) {
      tratarFalhaTerminalMobile(erro);
    }
    iniciarHeartbeatMobile();

    async function requisitarOperacaoCaixa(caminho, corpo, senhaAdmin) {
      let senha = senhaAdmin || null;
      for (let tentativa = 0; tentativa < 2; tentativa += 1) {
        const payload = Object.assign({}, corpo);
        if (senha) payload.senha_admin = senha;
        try {
          const resposta = await requisicaoJsonMobile(
            root.fetch.bind(root),
            caminho,
            'POST',
            payload
          );
          return { resposta, senhaAdmin: senha };
        } catch (erro) {
          if (tentativa === 0 && erro.status === 403
            && erro.body && erro.body.requer_senha_admin === true) {
            senha = await solicitarSenhaAdminMobile();
            if (!senha) throw erro;
            continue;
          }
          throw erro;
        }
      }
      throw new Error('Não foi possível autorizar a operação de caixa.');
    }

    async function abrirCaixaMobile() {
      const valorInicial = Number($('mv-caixa-valor-inicial').value || 0);
      if (!Number.isFinite(valorInicial) || valorInicial < 0) {
        alerta('Informe um valor inicial válido.');
        return;
      }
      if (!mobileSessionValid || !mobileTerminalReady || !mobileHeartbeatOk) {
        alerta('O terminal Mobile precisa estar autenticado e conectado antes de abrir o caixa.');
        return;
      }
      if (root.navigator && root.navigator.onLine === false) {
        alerta('Sem conexão com o servidor. Reconecte antes de abrir o caixa.');
        return;
      }
      operacaoCaixaEmCurso = true;
      atualizarPainelTerminalCaixa();
      let senhaAdmin = null;
      try {
        const config = await requisitarOperacaoCaixa(
          '/terminais/mobile/caixa-config',
          {
            installation_id: mobileInstallationId,
            terminal_id: mobileTerminalId
          },
          senhaAdmin
        );
        senhaAdmin = config.senhaAdmin;
        await requisitarOperacaoCaixa(
          '/caixa/abrir',
          { valor_inicial: valorInicial },
          senhaAdmin
        );
        alerta('');
        await consultarCaixaMobile();
      } catch (erro) {
        alerta(erro.message || 'Não foi possível abrir o caixa Mobile.');
        tratarFalhaTerminalMobile(erro);
        if (mobileTerminalReady && mobileHeartbeatOk && mobileSessionValid) {
          try { await consultarCaixaMobile(); } catch (_consultaErro) { /* erro já apresentado */ }
        }
      } finally {
        operacaoCaixaEmCurso = false;
        atualizarPainelTerminalCaixa();
      }
    }

    async function fecharCaixaMobile() {
      const valorInformado = Number($('mv-caixa-valor-fechamento').value);
      if (!Number.isFinite(valorInformado) || valorInformado < 0) {
        alerta('Informe o valor contado para fechar o caixa.');
        return;
      }
      if (!operacaoCaixaDisponivel()) {
        alerta('O caixa Mobile não está autenticado ou conectado.');
        return;
      }
      operacaoCaixaEmCurso = true;
      atualizarPainelTerminalCaixa();
      try {
        const confirmado = await solicitarConfirmacaoMobile({
          titulo: 'Confirmar fechamento do caixa',
          descricao: 'Confira o valor contado e confirme o encerramento da sessão deste terminal Mobile.',
          botaoConfirmar: 'Confirmar fechamento'
        });
        if (!confirmado) return;
        await requisitarOperacaoCaixa('/caixa/fechar', {
          valor_informado: valorInformado,
          observacao: String($('mv-caixa-observacao').value || '')
        });
        alerta('');
        await consultarCaixaMobile();
      } catch (erro) {
        alerta(erro.message || 'Não foi possível fechar o caixa Mobile.');
        tratarFalhaTerminalMobile(erro);
      } finally {
        operacaoCaixaEmCurso = false;
        atualizarPainelTerminalCaixa();
      }
    }

    if ($('mv-abrir-caixa')) {
      $('mv-abrir-caixa').addEventListener('click', abrirCaixaMobile);
    }
    if ($('mv-fechar-caixa')) {
      $('mv-fechar-caixa').addEventListener('click', fecharCaixaMobile);
    }
    $('mv-dialogo-confirmacao').addEventListener('close', () => {
      if (resolverConfirmacaoMobile) concluirConfirmacaoMobile(false);
    });
    $('mv-dialogo-confirmacao').addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        concluirConfirmacaoMobile(false);
      }
    });
    $('mv-confirmacao-cancelar').addEventListener('click', () => concluirConfirmacaoMobile(false));
    $('mv-confirmacao-confirmar').addEventListener('click', () => {
      const botao = $('mv-confirmacao-confirmar');
      if (botao.disabled || !resolverConfirmacaoMobile) return;
      botao.disabled = true;
      concluirConfirmacaoMobile(true);
    });
    const dialogoSenhaAdmin = $('mv-dialogo-senha-admin');
    dialogoSenhaAdmin.addEventListener('close', () => {
      if (resolverSenhaAdminMobile) concluirSenhaAdminMobile(null);
    });
    dialogoSenhaAdmin.addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape') {
        evento.preventDefault();
        concluirSenhaAdminMobile(null);
      } else if (evento.key === 'Enter' && evento.target.id === 'mv-senha-admin') {
        evento.preventDefault();
        $('mv-senha-admin-confirmar').click();
      }
    });
    $('mv-senha-admin-cancelar').addEventListener('click', () => concluirSenhaAdminMobile(null));
    $('mv-senha-admin-confirmar').addEventListener('click', () => {
      const input = $('mv-senha-admin');
      if (!input.value) {
        $('mv-senha-admin-erro').textContent = 'Informe a senha administrativa.';
        $('mv-senha-admin-erro').hidden = false;
        input.focus();
        return;
      }
      concluirSenhaAdminMobile(input.value);
    });
    $('mv-ir-caixa').addEventListener('click', async () => {
      $('mv-painel-venda').hidden = true;
      $('mv-caixa-painel').hidden = false;
      if (caixaMobileAtual) await consultarMovimentacoesCaixaMobile();
    });
    $('mv-voltar-pdv').addEventListener('click', () => {
      $('mv-caixa-painel').hidden = true;
      $('mv-painel-venda').hidden = false;
    });

    let itens = [];
    let desconto = 0;
    let total = 0;
    let handoffValido = null;
    if (handoff && handoff.invalido) {
      alerta('Os dados do pedido não puderam ser lidos.');
    } else if (handoff) {
      const sessaoOk = handoffCompativelComSessao(handoff, usuarioSessao(), empresaId);
      if (!sessaoOk.ok) {
        alerta(sessaoOk.mensagem);
      } else {
        const conferencia = root.PdvFechamentoOficial.conferirSnapshot(handoff);
        if (!conferencia.ok) {
          alerta(conferencia.mensagem);
        } else {
          let modelo = null;
          try {
            const respModelo = await fetchPdv(apiUrl() + '/vendas/pdv-modelo-empresa', { headers: headers() });
            if (respModelo.status === 401) {
              root.location.replace('/login?next=/mobile-pdv');
              return;
            }
            modelo = await respModelo.json().catch(() => null);
          } catch (_erro) {
            modelo = null;
          }
          const empresaOk = root.PdvFechamentoOficial.empresaCompativel(handoff, empresaId, modelo);
          if (!empresaOk.ok) {
            alerta(empresaOk.mensagem);
          } else {
            handoffValido = handoff;
            itens = handoff.itens.slice();
            desconto = Number(handoff.desconto || 0);
            total = Number(handoff.total);
            $('mv-pedido').textContent = 'Pedido #' + handoff.pedido_id;
            $('mv-busca-livre').hidden = true;
          }
        }
      }
    } else {
      $('mv-pedido').textContent = 'Venda avulsa, sem pedido.';
      if (operacaoSalva && Array.isArray(operacaoSalva.itens) && operacaoSalva.itens.length) {
        itens = operacaoSalva.itens.slice();
        desconto = Number(operacaoSalva.desconto || 0);
        total = Number(operacaoSalva.total || 0);
      }
    }

    const retornoMesa = destinoRetornoMesa(root.sessionStorage, empresaId, handoffValido && handoffValido.pedido_id);
    if (retornoMesa && $('mv-voltar-mesa')) {
      $('mv-voltar-mesa').href = retornoMesa;
      $('mv-voltar-mesa').hidden = false;
    }

    const interacao = root.InteracaoPagamentoMisto.criar({
      totalVenda: total,
      sequencial: root.PagamentoSequencial
    });
    let forma = '';
    let enviando = false;
    let vendaPersistida = operacaoSalva && operacaoSalva.vendaPersistida ? operacaoSalva.vendaPersistida : null;
    let chave = operacaoSalva && operacaoSalva.chave ? operacaoSalva.chave : null;

    async function alterarQuantidade(indice, delta) {
      if (handoffValido) return;
      const item = itens[indice];
      if (!item) return;
      const quantidade = Math.round((Number(item.quantidade) + delta) * 100) / 100;
      if (quantidade <= 0) {
        itens.splice(indice, 1);
      } else {
        const cotacao = await cotarProduto(item.produto_id, quantidade, fetchPdv);
        if (!cotacao.ok) {
          alerta(cotacao.mensagem || 'A quantidade não foi atualizada.');
          return;
        }
        itens[indice] = cotacao.linha;
      }
      total = Math.round(itens.reduce((soma, atual) => soma + Number(atual.subtotal || 0), 0) * 100) / 100;
      root.PagamentoSequencial.invalidarComposicao();
      alerta('');
      pintar();
    }

    function pintar() {
      const visao = handoffValido || itens.length
        ? { informado: root.PagamentoSequencial.soma(), restante: Math.round((total - root.PagamentoSequencial.soma()) * 100) / 100, parcelas: root.PagamentoSequencial.snapshot() }
        : interacao.visao();
      $('mv-total').textContent = dinheiro(total);
      $('mv-informado-valor').textContent = dinheiro(root.PagamentoSequencial.soma());
      $('mv-restante-valor').textContent = dinheiro(Math.max(0, total - root.PagamentoSequencial.soma()));
      $('mv-itens').innerHTML = itens.length
        ? '<ul>' + itens.map((item, indice) => (
          '<li class="mp-item-venda"><div class="mp-item-venda-info"><strong>'
          + escapar(item.nome || item.produto_nome || item.produto_id)
          + '</strong><span>' + escapar(item.quantidade) + ' unidade(s)</span></div>'
          + '<div class="mp-item-venda-acoes"><strong>' + dinheiro(item.subtotal) + '</strong>'
          + (handoffValido ? '' : '<button type="button" class="mp-btn mp-qtd-btn" aria-label="Diminuir quantidade" data-qtd="' + indice + '" data-delta="-1">−</button><button type="button" class="mp-btn mp-qtd-btn" aria-label="Aumentar quantidade" data-qtd="' + indice + '" data-delta="1">+</button>')
          + '</div></li>'
        )).join('') + '</ul>'
        : '<p class="mp-itens-vazio"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10h5l4 23h21l5-17H15"></path><circle cx="20" cy="40" r="2"></circle><circle cx="35" cy="40" r="2"></circle><path d="M25 5v6m8-3-3 5m-13-5 3 5"></path></svg><strong>Nenhum item adicionado</strong><span>Adicione produtos ou use Venda pelo Valor.</span></p>';
      $('mv-itens').querySelectorAll('button[data-qtd]').forEach((botao) => {
        botao.addEventListener('click', () => {
          alterarQuantidade(Number(botao.getAttribute('data-qtd')), Number(botao.getAttribute('data-delta')));
        });
      });
      const parcelasVisiveis = visao.parcelas || [];
      $('mv-parcelas').hidden = parcelasVisiveis.length === 0;
      $('mv-parcelas').innerHTML = parcelasVisiveis.map((parcela) => (
        '<p class="mp-parcela"><strong>' + escapar(rotuloFormaPagamentoMobile(parcela.forma_pagamento))
        + '</strong><span>' + dinheiro(parcela.valor) + '</span><small>'
        + escapar(rotuloStatusPagamentoMobile(parcela.status_autorizacao)) + '</small></p>'
      )).join('');
      const pagamentoDisponivel = operacaoCaixaDisponivel();
      $('mv-finalizar').disabled = enviando || !pagamentoDisponivel;
      root.document.querySelectorAll('#mv-formas button').forEach((botao) => {
        botao.disabled = !pagamentoDisponivel || operacaoCaixaEmCurso;
      });
      if (root.CdsMobileOperacao && root.PagamentoSequencial) {
        root.CdsMobileOperacao.salvarPdv({
          itens: itens.slice(),
          desconto,
          total,
          chave,
          vendaPersistida,
          pagamento: {
            parcelas: root.PagamentoSequencial.snapshot(),
            composicao: root.PagamentoSequencial.composicaoAtual()
          }
        });
      }
    }

    async function avaliarComposicao() {
      const lista = root.PagamentoSequencial.exportar();
      const temDinheiro = lista.some((parcela) => parcela.forma_pagamento === 'dinheiro');
      if (!temDinheiro || root.PagamentoSequencial.autorizacaoDigitalPendente()
        || Math.abs(root.PagamentoSequencial.soma() - total) > 0.009) {
        root.PagamentoSequencial.invalidarComposicao();
        $('mv-composicao').hidden = true;
        return;
      }
      const resp = await fetchPdv(apiUrl() + '/vendas/composicao-sequencial', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          total,
          pagamentos: lista,
          itens: root.PdvFechamentoOficial.itensParaComposicao(itens)
        })
      });
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok || dados.sucesso !== true) {
        root.PagamentoSequencial.invalidarComposicao();
        alerta(dados.error || 'A composição dos pagamentos não foi validada.');
        return;
      }
      const documento = dados.documento_fiscal;
      if (documento && documento.bloqueado && documento.codigo !== 'REFERENCIA_FISCAL_ZERO') {
        root.PagamentoSequencial.invalidarComposicao();
        alerta(documento.motivo || 'A recomposição não autorizou o documento fiscal.');
        $('mv-composicao').hidden = false;
        $('mv-composicao').textContent = documento.codigo + ': ' + (documento.motivo || '');
        return;
      }
      root.PagamentoSequencial.registrarComposicao(dados);
      const fiscal = dados.composicao_fiscal || {};
      $('mv-composicao').hidden = false;
      $('mv-composicao').textContent = 'Composição oficial. Fiscal '
        + dinheiro(fiscal.valor_fiscal != null ? fiscal.valor_fiscal : dados.valor_fiscal_referencia)
        + '. Dinheiro fora da NFC-e '
        + dinheiro(fiscal.valor_nao_fiscal != null ? fiscal.valor_nao_fiscal : dados.valor_nao_fiscal_referencia)
        + '.';
      alerta('');
    }

    root.document.querySelectorAll('#mv-formas button').forEach((botao) => {
      botao.addEventListener('click', () => {
        if (!operacaoCaixaDisponivel()) {
          alerta('Abra o caixa exclusivo do terminal Mobile antes de receber pagamentos.');
          return;
        }
        if (!itens.length) {
          alerta('Inclua os itens antes do pagamento.');
          return;
        }
        if (!handoffValido) {
          total = itens.reduce((soma, item) => soma + Number(item.subtotal || 0), 0);
        }
        forma = botao.getAttribute('data-forma');
        const escolha = root.InteracaoPagamentoMisto.criar({
          totalVenda: total,
          sequencial: root.PagamentoSequencial
        });
        entradaInteracao = escolha;
        const resultado = escolha.escolherForma(forma);
        if (!resultado.ok) {
          alerta('A venda já está completa.');
          return;
        }
        const titulos = {
          pix: 'PIX',
          cartao_debito: 'Débito',
          cartao_credito: 'Crédito',
          dinheiro: 'Dinheiro'
        };
        const titulo = $('mv-dialogo-titulo');
        if (titulo) titulo.textContent = titulos[forma] || forma;
        $('mv-valor').value = '';
        const estadoTx = $('mv-estado-transacao');
        if (estadoTx) estadoTx.textContent = '';
        const dialogo = $('mv-dialogo-valor');
        if (dialogo && typeof dialogo.showModal === 'function') dialogo.showModal();
        else alerta('Informe o valor da parcela.');
      });
    });

    let entradaInteracao = interacao;

    if ($('mv-dialogo-cancelar')) {
      $('mv-dialogo-cancelar').addEventListener('click', () => {
        const dialogo = $('mv-dialogo-valor');
        if (dialogo && typeof dialogo.close === 'function') dialogo.close();
      });
    }
    function confirmarPixManual(valor) {
      return solicitarConfirmacaoMobile({
        titulo: 'Confirmar recebimento',
        descricao: 'Confirme se o cliente realizou o pagamento PIX fora do sistema.',
        contexto: $('mv-pedido').textContent,
        itens: [{ forma_pagamento: 'pix', valor }],
        rotuloTotal: 'Valor do PIX',
        botaoConfirmar: 'Confirmar PIX'
      });
    }

    if ($('mv-vv-cancelar')) {
      $('mv-vv-cancelar').addEventListener('click', () => {
        const dialogo = $('mv-dialogo-venda-valor');
        if (dialogo && typeof dialogo.close === 'function') dialogo.close();
      });
    }

    $('mv-confirmar-parcela').addEventListener('click', async () => {
      const botao = $('mv-confirmar-parcela');
      if (botao.disabled) return;
      if (!operacaoCaixaDisponivel()) {
        alerta('Abra o caixa exclusivo do terminal Mobile antes de receber pagamentos.');
        return;
      }
      botao.disabled = true;
      try {
        if (!handoffValido) {
          total = Math.round(itens.reduce((soma, item) => soma + Number(item.subtotal || 0), 0) * 100) / 100;
        }
        entradaInteracao = root.InteracaoPagamentoMisto.criar({
          totalVenda: total,
          sequencial: root.PagamentoSequencial
        });
        if (forma) entradaInteracao.escolherForma(forma);
        const formaSelecionada = forma;
        const interacaoSelecionada = entradaInteracao;
        const valorInformado = Number($('mv-valor').value || 0);
        const eletronica = root.PagamentoSequencial.formaExigeAutorizador(forma);
        let configuracao = { tefHabilitado: false, pixIntegracaoHabilitada: false };
        if (eletronica) {
          try {
            configuracao = await obterConfiguracaoPagamento(fetchPdv, forma === 'pix');
          } catch (erro) {
            alerta(erro.message || 'Não foi possível verificar a configuração de pagamento.');
            return;
          }
          if (forma !== formaSelecionada || entradaInteracao !== interacaoSelecionada) {
            alerta('A forma de pagamento foi alterada. Confirme o valor novamente.');
            return;
          }
          $('mv-area-estacao').hidden = !configuracao.tefHabilitado;
          if (configuracao.pixIntegracaoHabilitada) {
            alerta('PIX automático está ativo e não está disponível nesta tela. Use o PDV desktop.');
            return;
          }
        }
        if (eletronica && configuracao.tefHabilitado && !estacaoComPinpad()) {
          const chaveCobranca = 'pdv-mob-' + Date.now().toString(36) + '-' + forma + '-' + valorInformado.toFixed(2);
          $('mv-correlacao').value = chaveCobranca;
          $('mv-estado-transacao').textContent = 'Aguardando a estação. Nada foi recebido.';
          alerta('A cobrança de ' + forma + ' precisa ser executada na estação com a chave exibida. Consulte quando ela confirmar.');
          const dialogo = $('mv-dialogo-valor');
          if (dialogo && typeof dialogo.close === 'function') dialogo.close();
          pintar();
          return;
        }
        const valorArredondado = Math.round((valorInformado + Number.EPSILON) * 100) / 100;
        if (forma === 'pix' && !configuracao.tefHabilitado
          && valorArredondado > 0 && valorArredondado - entradaInteracao.visao().restante <= 0.009) {
          let confirmado;
          try {
            confirmado = await confirmarPixManual(valorArredondado);
          } catch (erro) {
            alerta(erro.message || 'Não foi possível abrir a confirmação de PIX.');
            return;
          }
          if (!confirmado) {
            alerta('Recebimento PIX não confirmado. A parcela não foi registrada.');
            return;
          }
          if (forma !== formaSelecionada || entradaInteracao !== interacaoSelecionada) {
            alerta('A forma de pagamento foi alterada. Confirme o valor novamente.');
            return;
          }
        }
        const resultado = await entradaInteracao.confirmarValor(valorInformado, {
          tefHabilitado: configuracao.tefHabilitado,
          pixIntegracaoHabilitada: configuracao.pixIntegracaoHabilitada,
          formaUsaTef: (nome) => configuracao.tefHabilitado && root.PagamentoSequencial.formaExigeAutorizador(nome),
          autorizarTef: (nome, valor, chaveParcela) => autorizarEletronico(nome, valor, chaveParcela, fetchPdv)
        });
        if (!resultado.ok) {
          $('mv-estado-transacao').textContent = resultado.mensagem || 'A parcela não foi confirmada.';
          alerta(resultado.mensagem || 'A parcela não foi confirmada.');
        } else {
          alerta('');
          $('mv-valor').value = '';
          forma = '';
          $('mv-estado-transacao').textContent = resultado.mensagem || 'Parcela registrada. Escolha a próxima forma.';
          const dialogo = $('mv-dialogo-valor');
          if (dialogo && typeof dialogo.close === 'function') dialogo.close();
          await avaliarComposicao();
        }
        pintar();
      } finally {
        botao.disabled = false;
      }
    });

    $('mv-produto-busca').addEventListener('input', () => {
      clearTimeout($('mv-produto-busca')._timer);
      $('mv-produto-busca')._timer = setTimeout(async () => {
        const termo = $('mv-produto-busca').value.trim();
        if (termo.length < 2) return;
        const resp = await fetchPdv(apiUrl() + '/produtos/consulta-pdv/buscar?q=' + encodeURIComponent(termo) + '&limite=15', { headers: headers() });
        const data = await resp.json().catch(() => []);
        if (!resp.ok || !Array.isArray(data)) {
          alerta((data && (data.mensagem || data.error)) || 'A pesquisa de produtos falhou.');
          return;
        }
        let identificado = { ok: false };
        try {
          identificado = await identificarProduto(termo, fetchPdv);
        } catch (erro) {
          alerta(erro && erro.message ? erro.message : 'A identificação do produto falhou.');
        }
        const lista = Array.isArray(data) ? data.slice() : [];
        if (identificado.ok && identificado.encontrado && identificado.produtoId
          && !lista.some((produto) => Number(produto.id) === Number(identificado.produtoId))) {
          lista.unshift({ id: identificado.produtoId, nome: 'Produto ' + identificado.produtoId });
        }
        $('mv-produto-lista').innerHTML = lista.map((produto) => (
          '<button type="button" data-id="' + produto.id + '">'
          + '<strong>' + escapar(produto.nome_comercial || produto.nome) + '</strong></button>'
        )).join('');
        $('mv-produto-lista').querySelectorAll('button').forEach((botao) => {
          botao.addEventListener('click', async () => {
            const cotacao = await cotarProduto(Number(botao.getAttribute('data-id')), 1, fetchPdv);
            if (!cotacao.ok) {
              alerta(cotacao.mensagem || 'O preço do produto não foi calculado.');
              return;
            }
            itens.push(cotacao.linha);
            total = Math.round(itens.reduce((soma, item) => soma + Number(item.subtotal || 0), 0) * 100) / 100;
            alerta('');
            pintar();
          });
        });
      }, 250);
    });

    $('mv-consultar-estacao').addEventListener('click', async () => {
      const retorno = await acompanharCobranca($('mv-correlacao').value, fetchPdv);
      if (retorno.autenticacao) {
        root.location.replace('/login?next=/mobile-pdv');
        return;
      }
      if (retorno.aprovado !== true) {
        alerta(retorno.mensagem || 'A cobrança não foi confirmada.');
        return;
      }
      const vinculo = await vincularCobrancaConfirmada({
        retorno,
        forma: forma || 'pix',
        valor: Number($('mv-valor').value || 0),
        totalVenda: total
      });
      if (!vinculo.ok) {
        alerta(vinculo.mensagem || 'A parcela não foi confirmada.');
        return;
      }
      alerta('');
      $('mv-valor').value = '';
      forma = '';
      $('mv-estado-transacao').textContent = 'Parcela aprovada. Escolha a próxima forma.';
      await avaliarComposicao();
      pintar();
    });

    if ($('mv-venda-valor')) {
      $('mv-venda-valor').addEventListener('click', () => {
        if (itens.length || handoffValido) {
          alerta('A venda por valor começa com a venda vazia.');
          return;
        }
        const dialogo = $('mv-dialogo-venda-valor');
        if (dialogo && typeof dialogo.showModal === 'function') dialogo.showModal();
      });
    }
    if ($('mv-vv-continuar')) {
      $('mv-vv-continuar').addEventListener('click', async () => {
        const preparado = prepararVendaPorValor($('mv-vv-valor').value, $('mv-vv-qtd').value);
        if (!preparado.ok) {
          alerta(preparado.mensagem);
          return;
        }
        const resp = await fetchPdv(apiUrl() + preparado.endpoint, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', 'Idempotency-Key': 'pdv-vv-' + Date.now().toString(36) }, headers()),
          body: JSON.stringify(preparado.corpo)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          alerta(data.mensagem || data.message || 'A venda por valor não foi calculada.');
          return;
        }
        if (root.sessionStorage && Array.isArray(data.itens) && data.itens.length) {
          const usuario = usuarioSessao();
          const operadorId = Number(usuario && (usuario.id || usuario.usuario_id));
          const envelope = Object.assign({}, data);
          if (operadorId > 0) envelope.sessao_operador_id = operadorId;
          root.sessionStorage.setItem('pdvPedidoHandoff', JSON.stringify(envelope));
        }
        const dialogo = $('mv-dialogo-venda-valor');
        if (dialogo && typeof dialogo.close === 'function') dialogo.close();
        root.location.reload();
      });
    }

    $('mv-finalizar').addEventListener('click', async () => {
      if (enviando) return;
      if (!operacaoCaixaDisponivel()) {
        alerta('Abra o caixa exclusivo do terminal Mobile antes de finalizar a venda.');
        return;
      }
      enviando = true;
      pintar();
      const assinatura = root.PagamentoSequencial.assinatura();
      const parcelasAtuais = root.PagamentoSequencial.exportar();
      const eletronicas = parcelasAtuais.filter((parcela) => root.PagamentoSequencial.formaExigeAutorizador(parcela.forma_pagamento));
      let configuracao = { tefHabilitado: false, modoConfirmacaoFiscal: 'TEF' };
      if (eletronicas.length) {
        try {
          configuracao = await obterConfiguracaoPagamento(fetchPdv, eletronicas.some((parcela) => parcela.forma_pagamento === 'pix' && !parcela.tef_transacao_id && !parcela.pix_confirmado));
          if (configuracao.pixIntegracaoHabilitada) {
            throw new Error('PIX automático está ativo e não está disponível nesta tela. Use o PDV desktop.');
          }
        } catch (erro) {
          enviando = false;
          alerta(erro.message || 'Não foi possível verificar a configuração de pagamento.');
          pintar();
          return;
        }
      }
      if (assinatura !== root.PagamentoSequencial.assinatura()) {
        enviando = false;
        alerta('Os pagamentos foram alterados. Confira e finalize novamente.');
        pintar();
        return;
      }
      const resultado = await fechar({
        fetch: fetchPdv,
        itens,
        total,
        desconto,
        handoff: handoffValido,
        clienteId: handoffValido && handoffValido.cliente_id,
        chave,
        enviando: false,
        vendaPersistida,
        modoConfirmacaoFiscal: configuracao.modoConfirmacaoFiscal,
        tefHabilitado: configuracao.tefHabilitado,
        assinatura,
        confirmarRecebimento: (parcelas) => {
          const pagamentosExternos = parcelas.filter((parcela) => (
            root.PagamentoSequencial.formaExigeAutorizador(parcela.forma_pagamento)
            && !parcela.tef_transacao_id
            && !parcela.pix_confirmado
          ));
          return solicitarConfirmacaoMobile({
            titulo: 'Confirmar recebimentos',
            descricao: 'Confirme que estes pagamentos foram recebidos fora do CDS. Nenhuma cobrança será iniciada por esta confirmação.',
            itens: pagamentosExternos,
            mostrarLista: true,
            botaoConfirmar: 'Confirmar recebimentos'
          });
        }
      });
      enviando = false;
      if (resultado.chave) chave = resultado.chave;
      if (!resultado.ok) {
        if (resultado.vendaId) vendaPersistida = { id: resultado.vendaId };
        alerta(resultado.mensagem || 'A venda não foi finalizada.');
        pintar();
        return;
      }
      vendaPersistida = { id: resultado.vendaId };
      if (root.sessionStorage) root.sessionStorage.removeItem('pdvPedidoHandoff');
      if (root.CdsMobileOperacao) root.CdsMobileOperacao.limparPdv();
      alerta('');
      $('mv-caixa-painel').hidden = true;
      $('mv-painel-venda').hidden = true;
      $('mv-painel-resultado').hidden = false;
      const venda = resultado.venda || {};
      $('mv-resultado-venda').textContent = '#' + resultado.vendaId;
      const pedidoId = venda.pedido_id || (handoffValido && handoffValido.pedido_id);
      $('mv-resultado-pedido').textContent = pedidoId ? '#' + pedidoId : 'Venda avulsa';
      $('mv-resultado-empresa').textContent = venda.empresa_nome
        || (venda.empresa && (venda.empresa.nome_fantasia || venda.empresa.razao_social))
        || $('mv-empresa').textContent;
      const valorTotal = valorTotalRetornado(venda);
      $('mv-resultado-total-linha').hidden = valorTotal == null;
      if (valorTotal != null) $('mv-resultado-total').textContent = dinheiro(valorTotal);
      const situacaoFiscal = descreverSituacaoFiscal(resultado);
      $('mv-resultado-fiscal-status').textContent = situacaoFiscal.situacao;
      $('mv-resultado-emissao-linha').hidden = !situacaoFiscal.emissao;
      $('mv-resultado-emissao').textContent = situacaoFiscal.emissao;
    });

    pintar();
  }

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', () => { iniciar().catch((erro) => alerta(erro.message)); });
    } else {
      iniciar().catch((erro) => alerta(erro.message));
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
