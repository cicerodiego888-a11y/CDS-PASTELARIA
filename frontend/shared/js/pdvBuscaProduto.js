/**
 * Busca de produto do PDV (MIP → MIB).
 * RC14.15.15 — termo atual é autoridade; PLU numérico = match exato;
 * resultado de termo antigo nunca confirma nem sobrescreve.
 */
(function (global) {
  'use strict';

  const LIMITE_RESULTADOS = 20;
  const DEBOUNCE_MS = 220;

  let resultados = [];
  /** Termo que gerou o array `resultados` atual (autoridade da lista). */
  let termoDosResultados = null;
  let indiceSelecionado = -1;
  let timerBusca = null;
  let requisicaoAtual = 0;
  let dropdownAberto = false;
  /** AbortController da busca MIB em voo (cancela tecla anterior). */
  let abortBuscaAtual = null;
  /** Último resolve MIP da busca instantânea (mesmo fluxo para PLU/EAN/GTIN/interno/balança). */
  let ultimoMipBusca = null;

  function obterInput() {
    return document.getElementById('buscaProdutoPdv');
  }

  function obterLista() {
    return document.getElementById('listaProdutosPdv');
  }

  function obterTermoAtualDoInput() {
    const input = obterInput();
    return input ? String(input.value || '').trim() : '';
  }

  function ehTermoSomenteDigitos(termo) {
    const t = String(termo || '').trim();
    return t.length > 0 && /^\d+$/.test(t);
  }

  /**
   * Compara identificadores numéricos sem substring
   * (39 ≠ 3; 39 ≠ 390; 3 ≠ 103; 039 ≡ 39).
   */
  function identificadoresNumericosIguais(a, b) {
    const da = String(a ?? '').replace(/\D/g, '');
    const db = String(b ?? '').replace(/\D/g, '');
    if (!da || !db) return false;
    const na = da.replace(/^0+(?=\d)/, '') || '0';
    const nb = db.replace(/^0+(?=\d)/, '') || '0';
    return na === nb;
  }

  function produtoCorrespondeAoTermo(produto, termo) {
    if (!produto || !termo) return false;
    const t = String(termo).trim();
    if (!t) return false;

    if (ehTermoSomenteDigitos(t)) {
      // Não usar produto.id: "3" não deve casar com id=3 de outro SKU
      return identificadoresNumericosIguais(produto.plu, t)
        || identificadoresNumericosIguais(produto.codigo, t)
        || identificadoresNumericosIguais(produto.codigo_barras, t);
    }

    const nome = String(produto.nome || '').toLowerCase();
    const codigo = String(produto.codigo || '').toLowerCase();
    const barras = String(produto.codigo_barras || '').toLowerCase();
    const plu = String(produto.plu || '').toLowerCase();
    const tl = t.toLowerCase();
    return codigo === tl
      || barras === tl
      || plu === tl
      || nome.includes(tl);
  }

  /**
   * MIB com termo só dígitos: mantém só matches EXATOS de identificador.
   * Impede confirmação/listagem por plu.includes("3") → 39, 103, 12746.
   */
  function filtrarResultadosParaTermo(lista, termo) {
    const arr = Array.isArray(lista) ? lista : [];
    if (!ehTermoSomenteDigitos(termo)) return arr.slice(0, LIMITE_RESULTADOS);

    const exatos = arr.filter((p) => produtoCorrespondeAoTermo(p, termo));
    return exatos.slice(0, LIMITE_RESULTADOS);
  }

  function resultadoPertenceAoTermoAtual(produto, termoOrigem) {
    const termoAtual = obterTermoAtualDoInput();
    if (!termoAtual) return false;
    if (termoOrigem != null && String(termoOrigem) !== termoAtual) return false;
    if (termoDosResultados != null && termoDosResultados !== termoAtual) return false;
    return produtoCorrespondeAoTermo(produto, termoAtual);
  }

  function invalidarEstadoBusca() {
    resultados = [];
    termoDosResultados = null;
    indiceSelecionado = -1;
    ultimoMipBusca = null;
    requisicaoAtual += 1;
    if (abortBuscaAtual) {
      try { abortBuscaAtual.abort(); } catch (_) { /* ignore */ }
      abortBuscaAtual = null;
    }
  }

  function notificar(mensagem, tipo) {
    if (typeof global.showNotification === 'function') {
      global.showNotification(mensagem, tipo);
    }
  }

  function formatarPrecoProduto(produto) {
    const temPromocao = produto?.tem_promocao === 1 || produto?.tem_promocao === true;
    const precoPromo = Number(produto?.preco_promocional || 0);
    const preco = Number(produto?.preco_venda || 0);
    const precoFinal = temPromocao && precoPromo > 0 ? precoPromo : preco;
    if (typeof global.formatCurrency === 'function') {
      return global.formatCurrency(precoFinal);
    }
    return `R$ ${precoFinal.toFixed(2)}`;
  }

  function obterModoFiscal() {
    if (typeof global.modoFiscalQueryParam === 'function') {
      return global.modoFiscalQueryParam();
    }
    return '0';
  }

  function obterApiUrl() {
    return typeof API_URL !== 'undefined' ? API_URL : '/api';
  }

  function estoqueDisponivel(produto) {
    if (typeof global.pdvEstoqueDisponivel === 'function') {
      return global.pdvEstoqueDisponivel(produto);
    }
    return Number(produto?.estoque_atual ?? produto?.estoque_exibido ?? 0);
  }

  /**
   * Resolve produto no cache local a partir do payload MIP.
   */
  function produtoDoMip(resultado, termo) {
    if (!resultado || !resultado.encontrado) return null;

    const id = resultado.produtoId != null
      ? Number(resultado.produtoId)
      : (resultado.produto && resultado.produto.id != null ? Number(resultado.produto.id) : null);

    if (!id) return null;

    const cache = global.produtosDisponiveis || [];
    const noCache = cache.find((p) => Number(p.id) === id);
    let produto;
    if (noCache) {
      produto = { ...noCache, match_exato: 1, _fonte: 'mip', _termoOrigem: termo };
    } else {
      const base = resultado.produto || { id };
      const normalizado = typeof global.normalizarProdutoPdvLista === 'function'
        ? global.normalizarProdutoPdvLista([base])[0]
        : base;
      produto = { ...normalizado, id, match_exato: 1, _fonte: 'mip', _termoOrigem: termo };
    }

    if (resultado.meta && resultado.meta.plu != null) {
      produto.plu = String(resultado.meta.plu);
    }

    // RC14.15.15 — MIP stale/errado vs termo numérico: não aceitar substring
    if (ehTermoSomenteDigitos(termo) && !produtoCorrespondeAoTermo(produto, termo)) {
      // Ainda pode ser resolve INTERNO/EAN com meta sem plu espelhado — aceitar se meta.plu ou codigoOriginal bate
      const metaPlu = resultado.meta && resultado.meta.plu != null ? String(resultado.meta.plu) : '';
      const orig = resultado.codigoOriginal != null ? String(resultado.codigoOriginal) : '';
      if (
        !identificadoresNumericosIguais(metaPlu, termo)
        && !identificadoresNumericosIguais(orig, termo)
        && !identificadoresNumericosIguais(produto.codigo, termo)
        && !identificadoresNumericosIguais(produto.codigo_barras, termo)
      ) {
        return null;
      }
    }

    return produto;
  }

  /**
   * Identificação oficial via MIP (mesmo endpoint do Enter / carrinho).
   */
  async function identificarViaMip(termo) {
    const codigo = String(termo || '').trim();
    if (!codigo) return null;

    const contexto = { origem: 'pdv' };
    if (global.PDV_ETIQUETA_LAYOUT) {
      contexto.layoutStrategy = String(global.PDV_ETIQUETA_LAYOUT);
    }
    if (global.PDV_BALANCA_EQUIPAMENTO_ID) {
      contexto.equipamentoId = Number(global.PDV_BALANCA_EQUIPAMENTO_ID);
    }

    const response = await fetch(`${obterApiUrl()}/produtos/identificar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token') || ''}`
      },
      body: JSON.stringify({ codigo, contexto })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || (`HTTP ${response.status}`));
    }
    return body;
  }

  /**
   * Busca por nome / parcial via MIB — só quando MIP não resolve.
   * Cancela a requisição HTTP anterior a cada nova digitação.
   */
  async function buscarConsultaNome(termo, signal) {
    const url = `${obterApiUrl()}/produtos/consulta-pdv/buscar?q=${encodeURIComponent(termo)}&modo_fiscal=${obterModoFiscal()}&limite=${LIMITE_RESULTADOS}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('token') || ''}`
      },
      signal
    });
    if (response.status === 499) {
      return [];
    }
    const dados = await response.json().catch(() => []);
    if (!response.ok) {
      throw new Error(dados?.error || 'Erro ao buscar produtos.');
    }
    // MIB-RC2.0 — "Você quis dizer..."
    try {
      const raw = response.headers.get('X-MIB-Sugestao');
      if (raw && typeof global.showNotification === 'function') {
        const sug = JSON.parse(decodeURIComponent(raw));
        if (sug?.mensagem && Array.isArray(sug.sugestoes) && sug.sugestoes.length) {
          global.showNotification(
            `${sug.mensagem} ${sug.sugestoes.slice(0, 3).join(', ')}`,
            'info'
          );
        }
      }
    } catch (_) { /* ignore */ }
    const lista = Array.isArray(dados) ? dados : [];
    return filtrarResultadosParaTermo(lista, termo);
  }

  function notificarSelecaoMib(produtoId, extras) {
    const id = Number(produtoId);
    if (!id) return;
    const input = obterInput();
    const posicao = extras && extras.posicao != null
      ? extras.posicao
      : resultados.findIndex((p) => Number(p.id) === id);
    fetch(`${obterApiUrl()}/produtos/mib/selecao`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token') || ''}`
      },
      body: JSON.stringify({
        produto_id: id,
        texto: input ? input.value.trim() : '',
        posicao: posicao >= 0 ? posicao : null
      })
    }).catch(() => {});
  }

  function renderizarLista() {
    const lista = obterLista();
    if (!lista) return;

    if (!resultados.length) {
      dropdownAberto = false;
      lista.innerHTML = '<p class="vazio">Nenhum produto encontrado.</p>';
      lista.classList.remove('aberta');
      return;
    }

    dropdownAberto = true;
    lista.classList.add('aberta');

    // Destaca o primeiro item habilitado para Tab/Enter funcionarem sem setas
    if (indiceSelecionado < 0 || indiceSelecionado >= resultados.length) {
      const primeiroOk = resultados.findIndex((p) => {
        if (typeof global.pdvValidarEstoqueVenda === 'function') {
          return !!global.pdvValidarEstoqueVenda(p, 1).sucesso;
        }
        return estoqueDisponivel(p) > 0;
      });
      indiceSelecionado = primeiroOk >= 0 ? primeiroOk : 0;
    }

    lista.innerHTML = resultados.map((produto, index) => {
      const ativo = index === indiceSelecionado ? ' ativo' : '';
      const semEstoque = typeof global.pdvValidarEstoqueVenda === 'function'
        ? !global.pdvValidarEstoqueVenda(produto, 1).sucesso
        : estoqueDisponivel(produto) <= 0;
      const promocao = produto.tem_promocao === 1 || produto.tem_promocao === true;
      const codigoExibicao = produto.plu
        || produto.codigo_barras
        || produto.codigo
        || produto.id;
      const nome = typeof global.escapeHtml === 'function'
        ? global.escapeHtml(produto.nome || '-')
        : String(produto.nome || '-');
      const termoOrigemAttr = produto._termoOrigem != null
        ? String(produto._termoOrigem)
        : (termoDosResultados != null ? String(termoDosResultados) : '');

      return `
        <button
          type="button"
          class="pdv-autocomplete-item${ativo}${semEstoque ? ' sem-estoque' : ''}"
          data-index="${index}"
          data-produto-id="${produto.id}"
          data-termo-origem="${termoOrigemAttr.replace(/"/g, '&quot;')}"
          tabindex="-1"
          ${semEstoque ? 'disabled aria-disabled="true"' : ''}
        >
          <span class="pdv-autocomplete-nome">${nome}${promocao ? ' <small class="pdv-autocomplete-promo">PROMO</small>' : ''}</span>
          <span class="pdv-autocomplete-meta">
            <span class="pdv-autocomplete-codigo">${codigoExibicao}</span>
            <strong class="pdv-autocomplete-preco">${formatarPrecoProduto(produto)}</strong>
          </span>
        </button>
      `;
    }).join('');
  }

  function fecharLista(mensagem) {
    invalidarEstadoBusca();
    dropdownAberto = false;
    const lista = obterLista();
    if (lista) {
      lista.classList.remove('aberta');
      lista.innerHTML = `<p class="vazio">${mensagem || 'Digite para buscar por código, PLU ou nome...'}</p>`;
    }
  }

  function limparCampo(opcoes) {
    const opts = opcoes && typeof opcoes === 'object' ? opcoes : {};
    const input = obterInput();
    if (input) input.value = '';
    fecharLista();
    // Não devolver foco à busca quando um modal de quantidade/modo vai abrir
    if (opts.focar === false) return;
    if (typeof global.focarCampoCodigo === 'function') {
      global.focarCampoCodigo();
    }
  }

  function adicionarProdutoSelecionado(produto) {
    if (!produto) return;

    const termoAtual = obterTermoAtualDoInput();
    const origem = produto._termoOrigem != null ? produto._termoOrigem : termoDosResultados;
    if (!resultadoPertenceAoTermoAtual(produto, origem)) {
      notificar('Resultado desatualizado. Buscando novamente…', 'warning');
      if (termoAtual) buscarProdutos(termoAtual);
      return;
    }

    notificarSelecaoMib(produto.id, {});

    let cache = global.produtosDisponiveis || [];
    const existe = cache.find((p) => Number(p.id) === Number(produto.id));
    if (!existe) {
      const normalizado = typeof global.normalizarProdutoPdvLista === 'function'
        ? global.normalizarProdutoPdvLista([produto])[0]
        : produto;
      cache = cache.concat([normalizado]);
      global.produtosDisponiveis = cache;
    }

    if (typeof global.adicionarProdutoConsultaPDV === 'function') {
      global.adicionarProdutoConsultaPDV(produto.id);
      limparCampo({ focar: false });
      return;
    }

    if (typeof global.adicionarProdutoPorCodigo === 'function') {
      // Termo atual (PLU/código digitado) tem prioridade sobre codigo interno do produto
      const codigo = ehTermoSomenteDigitos(termoAtual)
        ? termoAtual
        : (produto.codigo_barras || produto.codigo || String(produto.id));
      global.adicionarProdutoPorCodigo(codigo);
      limparCampo({ focar: false });
    }
  }

  /**
   * Enter: só confirma se o resultado pertence ao termo ATUAL.
   * match_exato / MIP de termo antigo → descartados; re-resolve termoAtual.
   */
  function confirmarEntrada() {
    const input = obterInput();
    if (!input) return;

    const termo = input.value.trim();
    if (!termo) return;

    if (
      ultimoMipBusca
      && ultimoMipBusca.termo === termo
      && ultimoMipBusca.resultado
      && ultimoMipBusca.resultado.encontrado
      && termoDosResultados === termo
    ) {
      if (typeof global.adicionarProdutoPorCodigo === 'function') {
        global.adicionarProdutoPorCodigo(termo);
        limparCampo({ focar: false });
      }
      return;
    }

    // Stale: MIP de outro termo — NÃO usar match_exato antigo
    if (ultimoMipBusca && ultimoMipBusca.termo !== termo) {
      ultimoMipBusca = null;
    }
    if (termoDosResultados != null && termoDosResultados !== termo) {
      resultados = [];
      termoDosResultados = null;
      indiceSelecionado = -1;
    }

    const exatoApi = resultados.find((p) => {
      if (!(p.match_exato === 1 || p.match_exato === true)) return false;
      const origem = p._termoOrigem != null ? p._termoOrigem : termoDosResultados;
      return origem === termo && produtoCorrespondeAoTermo(p, termo);
    });
    if (exatoApi) {
      adicionarProdutoSelecionado(exatoApi);
      return;
    }

    if (dropdownAberto && indiceSelecionado >= 0 && resultados[indiceSelecionado]) {
      const sel = resultados[indiceSelecionado];
      const origem = sel._termoOrigem != null ? sel._termoOrigem : termoDosResultados;
      if (origem === termo && produtoCorrespondeAoTermo(sel, termo)) {
        adicionarProdutoSelecionado(sel);
        return;
      }
    }

    if (resultados.length > 0 && termoDosResultados === termo && indiceSelecionado < 0) {
      // Fallback: escolhe o primeiro da lista (Tab/mouse/Enter)
      if (confirmarItemDaLista(0)) return;
      notificar('Selecione o produto na lista (Tab para navegar, Enter para confirmar ou clique).', 'warning');
      return;
    }

    // Sem resultado válido para o termo atual → resolver pelo termo digitado (MIP no carrinho)
    if (typeof global.adicionarProdutoPorCodigo === 'function') {
      global.adicionarProdutoPorCodigo(termo);
      limparCampo();
    }
  }

  /**
   * Busca instantânea unificada: MIP primeiro (qualquer identificador),
   * depois consulta por nome se MIP não encontrar.
   * RC14.15.15 — descarta resposta se requestId ou termo do input mudou.
   */
  function buscarProdutos(termo) {
    const lista = obterLista();
    const termoDaBusca = String(termo || '').trim();
    if (!termoDaBusca || termoDaBusca.length < 1) {
      fecharLista();
      return;
    }

    if (abortBuscaAtual) {
      try { abortBuscaAtual.abort(); } catch (_) { /* ignore */ }
    }
    abortBuscaAtual = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = abortBuscaAtual ? abortBuscaAtual.signal : undefined;

    const reqId = ++requisicaoAtual;
    // Invalida lista/MIP anteriores imediatamente (não confirma stale enquanto busca)
    resultados = [];
    termoDosResultados = null;
    indiceSelecionado = -1;
    ultimoMipBusca = null;

    if (lista) {
      lista.innerHTML = '<p class="vazio">Buscando...</p>';
      lista.classList.add('aberta');
    }

    function respostaAindaValida() {
      if (reqId !== requisicaoAtual) return false;
      if (obterTermoAtualDoInput() !== termoDaBusca) return false;
      return true;
    }

    Promise.resolve()
      .then(() => identificarViaMip(termoDaBusca))
      .then((mip) => {
        if (!respostaAindaValida()) return null;

        if (mip && mip.encontrado) {
          const produto = produtoDoMip(mip, termoDaBusca);
          if (produto && produto.id) {
            if (!respostaAindaValida()) return null;
            ultimoMipBusca = { termo: termoDaBusca, resultado: mip };
            resultados = [produto];
            termoDosResultados = termoDaBusca;
            indiceSelecionado = 0;
            renderizarLista();
            return { resolvidoMip: true };
          }
        }

        if (!respostaAindaValida()) return null;
        ultimoMipBusca = null;
        return buscarConsultaNome(termoDaBusca, signal).then((produtos) => ({
          resolvidoMip: false,
          produtos
        }));
      })
      .then((out) => {
        if (!out || out.resolvidoMip || !respostaAindaValida()) return;
        const filtrados = (out.produtos || []).map((p) => ({
          ...p,
          _termoOrigem: termoDaBusca,
          // termo numérico: só match_exato se identificador exato
          match_exato: ehTermoSomenteDigitos(termoDaBusca)
            ? (produtoCorrespondeAoTermo(p, termoDaBusca) ? 1 : 0)
            : (p.match_exato === 1 || p.match_exato === true ? 1 : 0)
        })).filter((p) => {
          if (!ehTermoSomenteDigitos(termoDaBusca)) return true;
          return produtoCorrespondeAoTermo(p, termoDaBusca);
        });

        resultados = filtrados;
        termoDosResultados = termoDaBusca;
        const unicoExato = resultados.length === 1
          && (resultados[0].match_exato === 1 || resultados[0].match_exato === true);
        indiceSelecionado = unicoExato ? 0 : (resultados.length === 1 ? 0 : -1);
        renderizarLista();
      })
      .catch((err) => {
        if (err && (err.name === 'AbortError' || err.code === 20)) return;
        if (!respostaAindaValida()) return;
        ultimoMipBusca = null;
        fecharLista('Erro ao buscar produtos.');
        notificar(err.message, 'danger');
      });
  }

  function onInput() {
    const input = obterInput();
    if (!input) return;

    const termo = input.value.trim();
    clearTimeout(timerBusca);

    // Invalidar estado confirmável do termo anterior imediatamente
    if (termoDosResultados != null && termoDosResultados !== termo) {
      resultados = [];
      termoDosResultados = null;
      indiceSelecionado = -1;
      ultimoMipBusca = null;
      requisicaoAtual += 1;
      if (abortBuscaAtual) {
        try { abortBuscaAtual.abort(); } catch (_) { /* ignore */ }
        abortBuscaAtual = null;
      }
      const lista = obterLista();
      if (lista && termo) {
        lista.innerHTML = '<p class="vazio">Buscando...</p>';
        lista.classList.add('aberta');
      }
    }

    if (!termo) {
      fecharLista();
      return;
    }

    timerBusca = setTimeout(() => buscarProdutos(termo), DEBOUNCE_MS);
  }

  function confirmarItemDaLista(index) {
    if (!Number.isFinite(index) || !resultados[index]) return false;

    const produto = resultados[index];
    const termo = obterTermoAtualDoInput();
    const origem = produto._termoOrigem != null
      ? String(produto._termoOrigem)
      : termoDosResultados;

    if (!termo || termoDosResultados !== termo) {
      notificar('Resultado desatualizado. Buscando novamente…', 'warning');
      if (termo) buscarProdutos(termo);
      return false;
    }

    if (origem != null && String(origem) !== termo) {
      notificar('Resultado desatualizado. Buscando novamente…', 'warning');
      if (termo) buscarProdutos(termo);
      return false;
    }

    if (!produtoCorrespondeAoTermo(produto, termo)) {
      notificar('Resultado desatualizado. Buscando novamente…', 'warning');
      if (termo) buscarProdutos(termo);
      return false;
    }

    // Item resolvido via MIP: usa o termo digitado (PLU/EAN/balança)
    if (
      produto._fonte === 'mip'
      && ultimoMipBusca
      && ultimoMipBusca.termo === termo
      && typeof global.adicionarProdutoPorCodigo === 'function'
    ) {
      global.adicionarProdutoPorCodigo(termo);
      limparCampo();
      return true;
    }

    adicionarProdutoSelecionado(produto);
    return true;
  }

  function onKeyDown(event) {
    const input = obterInput();
    if (!input || event.target !== input) return;

    const listaAberta = dropdownAberto && resultados.length > 0
      && termoDosResultados === obterTermoAtualDoInput();

    if (event.key === 'ArrowDown') {
      if (!listaAberta) return;
      event.preventDefault();
      event.stopPropagation();
      indiceSelecionado = Math.min(
        (indiceSelecionado < 0 ? -1 : indiceSelecionado) + 1,
        resultados.length - 1
      );
      renderizarLista();
      return;
    }

    if (event.key === 'ArrowUp') {
      if (!listaAberta) return;
      event.preventDefault();
      event.stopPropagation();
      indiceSelecionado = Math.max(indiceSelecionado < 0 ? 0 : indiceSelecionado - 1, 0);
      renderizarLista();
      return;
    }

    // Tab / Shift+Tab: navega entre os produtos da lista (Enter confirma)
    if (event.key === 'Tab' && listaAberta) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        if (indiceSelecionado < 0) indiceSelecionado = resultados.length - 1;
        else indiceSelecionado = Math.max(indiceSelecionado - 1, 0);
      } else if (indiceSelecionado < 0) {
        indiceSelecionado = 0;
      } else {
        indiceSelecionado = Math.min(indiceSelecionado + 1, resultados.length - 1);
      }
      renderizarLista();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      // Com lista aberta: Enter confirma o item destacado
      if (listaAberta) {
        if (indiceSelecionado < 0) indiceSelecionado = 0;
        if (confirmarItemDaLista(indiceSelecionado)) return;
      }
      confirmarEntrada();
      return;
    }

    if (event.key === 'Escape') {
      if (dropdownAberto || resultados.length) {
        event.preventDefault();
        event.stopPropagation();
        fecharLista();
      }
    }
  }

  function onListaPointer(event) {
    // mousedown: evita perder o clique quando o input perde foco
    if (event.type === 'mousedown' && event.button !== 0) return;

    const botao = event.target.closest('.pdv-autocomplete-item');
    if (!botao || botao.disabled) return;

    event.preventDefault();
    event.stopPropagation();

    const index = Number(botao.dataset.index);
    if (!Number.isFinite(index) || !resultados[index]) return;

    indiceSelecionado = index;
    confirmarItemDaLista(index);
  }

  function inicializar() {
    const input = obterInput();
    const lista = obterLista();
    if (!input || !lista) return;

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeyDown);
    // mousedown: seleção confiável com mouse (evita perder o clique no blur do input)
    lista.addEventListener('mousedown', onListaPointer);

    const btnBuscar = document.getElementById('btnBuscarProdutoPdv');
    if (btnBuscar) {
      btnBuscar.addEventListener('click', () => confirmarEntrada());
    }

    fecharLista();
  }

  global.PdvBuscaProduto = {
    inicializar,
    estaAberto: () => dropdownAberto,
    fechar: fecharLista,
    confirmarEntrada,
    /** Helpers exportados para testes RC14.15.15 (sem alterar contrato MIP). */
    _test: {
      ehTermoSomenteDigitos,
      identificadoresNumericosIguais,
      produtoCorrespondeAoTermo,
      filtrarResultadosParaTermo,
      DEBOUNCE_MS
    }
  };
})(typeof window !== 'undefined' ? window : global);
