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

  function precoAvulso(produto) {
    if (produto.preco_promocional != null && produto.preco_promocional !== '') {
      return Number(produto.preco_promocional);
    }
    return Number(produto.preco_venda || 0);
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
    autorizarEletronico,
    precoAvulso,
    fechar,
    estacaoComPinpad
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
    if (root.PagamentoSequencial) root.PagamentoSequencial.reset();
    const handoff = lerHandoff(root.sessionStorage);
    if (handoff) $('mv-busca-livre').hidden = true;
    const contexto = root.CdsEmpresaContexto;
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
      const conferencia = root.PdvFechamentoOficial.conferirSnapshot(handoff);
      if (!conferencia.ok) {
        alerta(conferencia.mensagem);
      } else {
        let modelo = null;
        try {
          const respModelo = await root.fetch(apiUrl() + '/vendas/pdv-modelo-empresa', { headers: headers() });
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
    } else {
      $('mv-pedido').textContent = 'Venda avulsa, sem pedido.';
    }

    const interacao = root.InteracaoPagamentoMisto.criar({
      totalVenda: total,
      sequencial: root.PagamentoSequencial
    });
    let forma = '';
    let enviando = false;
    let vendaPersistida = null;
    let chave = null;

    function pintar() {
      const visao = handoffValido || itens.length
        ? { informado: root.PagamentoSequencial.soma(), restante: Math.round((total - root.PagamentoSequencial.soma()) * 100) / 100, parcelas: root.PagamentoSequencial.snapshot() }
        : interacao.visao();
      $('mv-total').textContent = dinheiro(total);
      $('mv-informado').textContent = 'Registrado: ' + dinheiro(root.PagamentoSequencial.soma());
      $('mv-restante').textContent = 'Restante: ' + dinheiro(Math.max(0, total - root.PagamentoSequencial.soma()));
      $('mv-itens').innerHTML = itens.length
        ? '<ul>' + itens.map((item) => (
          '<li>' + escapar(item.quantidade) + ' × ' + escapar(item.nome || item.produto_nome || item.produto_id)
          + ' — ' + dinheiro(item.subtotal) + '</li>'
        )).join('') + '</ul>'
        : '<p>Nenhum item.</p>';
      $('mv-parcelas').innerHTML = (visao.parcelas || []).map((parcela) => (
        '<p><strong>' + escapar(parcela.forma_pagamento) + '</strong> '
        + dinheiro(parcela.valor) + ' · ' + escapar(parcela.status_autorizacao || 'pendente') + '</p>'
      )).join('') || '<p>Nenhuma parcela.</p>';
      $('mv-finalizar').disabled = enviando;
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
        if (!resultado.ok) alerta('A venda já está completa.');
        else alerta('');
      });
    });

    let entradaInteracao = interacao;

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
        const resultado = await entradaInteracao.confirmarValor(Number($('mv-valor').value || 0), {
          formaUsaTef: (nome) => root.PagamentoSequencial.formaExigeAutorizador(nome),
          autorizarTef: (nome, valor, chaveParcela) => autorizarEletronico(nome, valor, chaveParcela, root.fetch.bind(root))
        });
        if (!resultado.ok) {
          alerta(resultado.mensagem || 'A parcela não foi confirmada.');
        } else {
          alerta('');
          $('mv-valor').value = '';
          forma = '';
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
        $('mv-produto-lista').innerHTML = data.map((produto) => (
          '<button type="button" data-id="' + produto.id + '" data-nome="' + escapar(produto.nome_comercial || produto.nome) + '" data-preco="' + precoAvulso(produto) + '">'
          + '<strong>' + escapar(produto.nome_comercial || produto.nome) + '</strong><small>' + dinheiro(precoAvulso(produto)) + '</small></button>'
        )).join('');
        $('mv-produto-lista').querySelectorAll('button').forEach((botao) => {
          botao.addEventListener('click', () => {
            const preco = Number(botao.getAttribute('data-preco'));
            itens.push({
              produto_id: Number(botao.getAttribute('data-id')),
              nome: botao.getAttribute('data-nome'),
              quantidade: 1,
              preco_unitario: preco,
              subtotal: preco,
              tipo_venda: 'UNIDADE'
            });
            total = Math.round(itens.reduce((soma, item) => soma + Number(item.subtotal || 0), 0) * 100) / 100;
            pintar();
          });
        });
      }, 250);
    });

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
      $('mv-painel-venda').hidden = true;
      $('mv-painel-resultado').hidden = false;
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
