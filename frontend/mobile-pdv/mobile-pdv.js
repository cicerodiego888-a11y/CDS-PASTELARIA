/**
 * PDV no celular. O fechamento usa o pagamento sequencial e o POST /api/vendas
 * do PDV do computador. Não há outro motor de preço, estoque ou fiscal.
 */
(function (root) {
  'use strict';

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
    if (contexto && typeof contexto.headersJson === 'function') return contexto.headersJson();
    const token = root.localStorage ? (root.localStorage.getItem('token') || '') : '';
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: token ? 'Bearer ' + token : ''
    };
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
    let distribuicao;
    try {
      const resp = await fetchFn(apiUrl() + '/vendas/pre-calcular-distribuicao', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          itens: oficial.itensParaApi(entrada.itens),
          emitir_fiscal: false,
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
    const montado = oficial.montarCorpo({
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
      modoConfirmacaoFiscal: entrada.modoConfirmacaoFiscal || 'TEF',
      tefHabilitado: entrada.tefHabilitado === true
    });
    if (!montado.ok) return montado;
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
    prepararVendaPorValor,
    autorizarEletronico,
    precoAvulso,
    identificarProduto,
    cotarProduto,
    acompanharCobranca,
    vincularCobrancaConfirmada,
    solicitarEmissao,
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
    $('mv-operador').textContent = nomeOperador() ? ('Operador: ' + nomeOperador()) : 'Operador da sessão atual';

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
            const respModelo = await root.fetch(apiUrl() + '/vendas/pdv-modelo-empresa', { headers: headers() });
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
        const cotacao = await cotarProduto(item.produto_id, quantidade, root.fetch.bind(root));
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
      $('mv-informado').textContent = 'Registrado: ' + dinheiro(root.PagamentoSequencial.soma());
      $('mv-restante').textContent = 'Restante: ' + dinheiro(Math.max(0, total - root.PagamentoSequencial.soma()));
      $('mv-itens').innerHTML = itens.length
        ? '<ul>' + itens.map((item, indice) => (
          '<li>' + escapar(item.quantidade) + ' × ' + escapar(item.nome || item.produto_nome || item.produto_id)
          + ' — ' + dinheiro(item.subtotal)
          + (handoffValido ? '' : ' <button type="button" data-qtd="' + indice + '" data-delta="-1">−</button><button type="button" data-qtd="' + indice + '" data-delta="1">+</button>')
          + '</li>'
        )).join('') + '</ul>'
        : '<p>Nenhum item.</p>';
      $('mv-itens').querySelectorAll('button[data-qtd]').forEach((botao) => {
        botao.addEventListener('click', () => {
          alterarQuantidade(Number(botao.getAttribute('data-qtd')), Number(botao.getAttribute('data-delta')));
        });
      });
      $('mv-parcelas').innerHTML = (visao.parcelas || []).map((parcela) => (
        '<p><strong>' + escapar(parcela.forma_pagamento) + '</strong> '
        + dinheiro(parcela.valor) + ' · ' + escapar(parcela.status_autorizacao || 'pendente') + '</p>'
      )).join('') || '<p>Nenhuma parcela.</p>';
      $('mv-finalizar').disabled = enviando;
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
      const resp = await root.fetch(apiUrl() + '/vendas/composicao-sequencial', {
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
    if ($('mv-vv-cancelar')) {
      $('mv-vv-cancelar').addEventListener('click', () => {
        const dialogo = $('mv-dialogo-venda-valor');
        if (dialogo && typeof dialogo.close === 'function') dialogo.close();
      });
    }

    $('mv-confirmar-parcela').addEventListener('click', async () => {
      const botao = $('mv-confirmar-parcela');
      if (botao.disabled) return;
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
        const valorInformado = Number($('mv-valor').value || 0);
        const eletronica = root.PagamentoSequencial.formaExigeAutorizador(forma);
        if (eletronica && !estacaoComPinpad()) {
          const chaveCobranca = 'pdv-mob-' + Date.now().toString(36) + '-' + forma + '-' + valorInformado.toFixed(2);
          $('mv-correlacao').value = chaveCobranca;
          $('mv-estado-transacao').textContent = 'Aguardando a estação. Nada foi recebido.';
          alerta('A cobrança de ' + forma + ' precisa ser executada na estação com a chave exibida. Consulte quando ela confirmar.');
          const dialogo = $('mv-dialogo-valor');
          if (dialogo && typeof dialogo.close === 'function') dialogo.close();
          pintar();
          return;
        }
        const resultado = await entradaInteracao.confirmarValor(valorInformado, {
          formaUsaTef: (nome) => root.PagamentoSequencial.formaExigeAutorizador(nome),
          autorizarTef: (nome, valor, chaveParcela) => autorizarEletronico(nome, valor, chaveParcela, root.fetch.bind(root))
        });
        if (!resultado.ok) {
          $('mv-estado-transacao').textContent = resultado.mensagem || 'A parcela não foi confirmada.';
          alerta(resultado.mensagem || 'A parcela não foi confirmada.');
        } else {
          alerta('');
          $('mv-valor').value = '';
          forma = '';
          $('mv-estado-transacao').textContent = 'Parcela registrada. Escolha a próxima forma.';
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
        const resp = await root.fetch(apiUrl() + '/produtos/consulta-pdv/buscar?q=' + encodeURIComponent(termo) + '&limite=15', { headers: headers() });
        const data = await resp.json().catch(() => []);
        if (!resp.ok || !Array.isArray(data)) {
          alerta((data && (data.mensagem || data.error)) || 'A pesquisa de produtos falhou.');
          return;
        }
        let identificado = { ok: false };
        try {
          identificado = await identificarProduto(termo, root.fetch.bind(root));
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
            const cotacao = await cotarProduto(Number(botao.getAttribute('data-id')), 1, root.fetch.bind(root));
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
      const retorno = await acompanharCobranca($('mv-correlacao').value, root.fetch.bind(root));
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
        const resp = await root.fetch(apiUrl() + preparado.endpoint, {
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

    if ($('mv-emitir')) {
      $('mv-emitir').addEventListener('click', async () => {
        const pedido = await solicitarEmissao({
          vendaId: vendaPersistida && vendaPersistida.id,
          distribuicaoAutorizada: false,
          transmitir: false
        });
        alerta(pedido.mensagem || 'A emissão não foi solicitada.');
      });
    }

    $('mv-finalizar').addEventListener('click', async () => {
      if (enviando) return;
      enviando = true;
      pintar();
      const resultado = await fechar({
        fetch: root.fetch.bind(root),
        itens,
        total,
        desconto,
        handoff: handoffValido,
        clienteId: handoffValido && handoffValido.cliente_id,
        chave,
        enviando: false,
        vendaPersistida,
        modoConfirmacaoFiscal: 'TEF',
        tefHabilitado: false
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
      $('mv-painel-venda').hidden = true;
      $('mv-painel-resultado').hidden = false;
      if (retornoMesa && $('mv-voltar-mesa-fim')) {
        $('mv-voltar-mesa-fim').href = retornoMesa;
        $('mv-voltar-mesa-fim').hidden = false;
      }
      const fiscal = resultado.fiscal;
      $('mv-resultado').innerHTML = '<p><strong>Venda</strong><br>#' + resultado.vendaId + '</p>'
        + '<p><strong>Pedido</strong><br>' + (handoffValido ? ('#' + handoffValido.pedido_id) : 'Sem pedido') + '</p>'
        + '<p><strong>Empresa</strong><br>' + escapar($('mv-empresa').textContent) + '</p>'
        + '<p><strong>Fiscal</strong><br>' + escapar(fiscal ? (fiscal.status || fiscal.message || 'Retorno do servidor') : 'NFC-e não solicitada nesta tela.') + '</p>';
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
