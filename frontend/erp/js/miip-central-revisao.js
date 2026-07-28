/**
 * Central de Revisão MIIP — Sprint 6B
 * Módulo independente do fluxo de Compras.
 *
 * Uso:
 *   MiipCentralRevisao.iniciar({ dadosImportacao, apiUrl, produtos, onConcluir, onCancelar, ... })
 */
(function initMiipCentralRevisao(global) {
  'use strict';

  const MOTOR_LABELS = {
    motor_gtin: 'Código de barras',
    motor_associacao_fornecedor: 'Histórico do fornecedor'
  };

  let estado = null;

  function escapeHtml(texto) {
    return String(texto ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatarMoeda(valor) {
    const numero = Number(valor || 0);
    if (typeof formatCurrency === 'function') return formatCurrency(numero);
    return numero.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function formatarTempo(ms) {
    const totalSeg = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(totalSeg / 3600);
    const m = Math.floor((totalSeg % 3600) / 60);
    const s = totalSeg % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  function calcularPrecisao(resumo, confirmadosManualmente) {
    const total = Number(resumo?.totalItens ?? 0);
    if (total <= 0) return 0;
    const auto = Number(resumo?.identificadosAutomaticamente ?? 0);
    const conf = Number(confirmadosManualmente ?? 0);
    return Math.round(((auto + conf) / total) * 100);
  }

  function extrairPendencias(resultados) {
    return (resultados || []).filter((r) => r.precisaConfirmacao || r.precisaCadastro);
  }

  function ordenarPendencias(pendencias) {
    return [...pendencias].sort((a, b) => {
      const semA = Boolean(a.precisaCadastro && !a.produtoEncontrado);
      const semB = Boolean(b.precisaCadastro && !b.produtoEncontrado);
      if (semA && !semB) return 1;
      if (!semA && semB) return -1;
      return Number(b.score ?? 0) - Number(a.score ?? 0);
    });
  }

  function extrairEvidencias(candidato, motor) {
    const lista = [];
    if (motor && MOTOR_LABELS[motor]) lista.push(MOTOR_LABELS[motor]);
    (candidato?.evidencias || []).forEach((ev) => {
      const t = ev?.descricao || ev?.tipo || ev?.valor;
      if (t && !lista.includes(t)) lista.push(String(t));
    });
    if (candidato?.produto?.marca && !lista.includes('Marca')) lista.push('Marca');
    return lista;
  }

  function montarSessao(dadosImportacao) {
    const miip = dadosImportacao?.miip_importacao || {};
    const resultados = miip.resultados || [];
    const itens = (dadosImportacao?.itens || []).map((item) => ({ ...item }));

    return {
      dadosImportacao,
      operacaoId: miip.operacaoId || dadosImportacao?.chave_acesso || null,
      resumo: {
        totalItens: Number(miip.resumo?.totalItens ?? itens.length),
        identificadosAutomaticamente: Number(miip.resumo?.identificadosAutomaticamente ?? 0),
        precisamConfirmacao: Number(miip.resumo?.precisamConfirmacao ?? 0),
        precisamCadastro: Number(miip.resumo?.precisamCadastro ?? 0),
        tempoProcessamento: Number(miip.resumo?.tempoProcessamento ?? 0)
      },
      fornecedor: dadosImportacao?.fornecedor || '',
      fornecedorCnpj: dadosImportacao?.fornecedor_cnpj || '',
      pendencias: ordenarPendencias(extrairPendencias(resultados)),
      itens,
      indiceAtual: 0,
      resolvidas: [],
      ignoradas: [],
      aprendizados: 0,
      confirmadosManualmente: 0,
      fase: 'revisao'
    };
  }

  function pendenciaAberta(sessao, pendencia) {
    return !sessao.resolvidas.includes(pendencia.indice)
      && !sessao.ignoradas.includes(pendencia.indice);
  }

  function contarAbertas(sessao) {
    return sessao.pendencias.filter((p) => pendenciaAberta(sessao, p)).length;
  }

  function proximaAberta(sessao, direcao) {
    const total = sessao.pendencias.length;
    let idx = sessao.indiceAtual;
    for (let i = 0; i < total; i += 1) {
      idx = (idx + direcao + total) % total;
      if (pendenciaAberta(sessao, sessao.pendencias[idx])) {
        sessao.indiceAtual = idx;
        return;
      }
    }
  }

  function notificar(mensagem, tipo) {
    if (typeof showNotification === 'function') {
      showNotification(mensagem, tipo || 'info');
    }
  }

  function mostrarAprendizado() {
    const toast = document.getElementById('miipCentralAprendizadoToast');
    if (!toast) return;
    toast.classList.add('miip-central-toast--visivel');
    setTimeout(() => toast.classList.remove('miip-central-toast--visivel'), 4200);
  }

  function enviarAprendizado(pendencia, produtoId, produto) {
    const { opcoes, sessao } = estado;
    const item = sessao.itens[pendencia.indice] || pendencia.produtoXML || {};
    const usuario = opcoes.obterUsuario ? opcoes.obterUsuario() : null;
    const fornecedorCnpj = sessao.fornecedorCnpj;

    if (!fornecedorCnpj || !item.codigo_fornecedor) return Promise.resolve(false);

    return $.ajax({
      url: `${opcoes.apiUrl}/miip/feedback`,
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({
        confirmado: true,
        produtoId: Number(produtoId),
        fornecedorCnpj,
        codigoFornecedor: item.codigo_fornecedor,
        fornecedorNome: sessao.fornecedor,
        nomeItem: item.produto_nome,
        codigoBarras: item.codigo_barras,
        ncm: item.ncm,
        unidade: item.unidade,
        usuarioId: usuario?.id ?? null,
        operacaoId: pendencia.operacaoId || sessao.operacaoId,
        origem: 'central_revisao_miip',
        item
      })
    }).then(() => true).catch(() => false);
  }

  function renderResumoTopo(sessao) {
    const precisao = calcularPrecisao(sessao.resumo, sessao.confirmadosManualmente);
    return `
      <div class="miip-central-resumo-grid">
        <div class="miip-central-metrica"><span>Itens da Nota</span><strong>${sessao.resumo.totalItens}</strong></div>
        <div class="miip-central-metrica miip-central-metrica--ok"><span>Associados automaticamente</span><strong>${sessao.resumo.identificadosAutomaticamente}</strong></div>
        <div class="miip-central-metrica miip-central-metrica--warn"><span>Precisam confirmação</span><strong>${sessao.resumo.precisamConfirmacao}</strong></div>
        <div class="miip-central-metrica miip-central-metrica--alert"><span>Precisam cadastro</span><strong>${sessao.resumo.precisamCadastro}</strong></div>
        <div class="miip-central-metrica"><span>Precisão desta importação</span><strong>${precisao}%</strong></div>
        <div class="miip-central-metrica"><span>Tempo de processamento</span><strong>${formatarTempo(sessao.resumo.tempoProcessamento)}</strong></div>
      </div>
    `;
  }

  function statusPendencia(sessao, pendencia) {
    if (sessao.resolvidas.includes(pendencia.indice)) return 'resolvida';
    if (sessao.ignoradas.includes(pendencia.indice)) return 'ignorada';
    return 'aberta';
  }

  function renderListaPendencias(sessao) {
    return sessao.pendencias.map((pendencia, idx) => {
      const status = statusPendencia(sessao, pendencia);
      const ativo = idx === sessao.indiceAtual ? ' miip-central-lista-item--ativo' : '';
      const tipo = pendencia.precisaCadastro && !pendencia.produtoEncontrado ? 'cadastro' : 'confirmacao';
      const nome = pendencia.produtoXML?.produto_nome || 'Item sem nome';
      const score = Number(pendencia.score ?? 0);

      return `
        <button type="button" class="miip-central-lista-item${ativo}" data-lista-idx="${idx}">
          <div class="miip-central-lista-titulo">${escapeHtml(nome)}</div>
          <div class="miip-central-lista-meta">
            <span class="miip-central-tag miip-central-tag--${tipo}">${tipo === 'cadastro' ? 'Cadastro' : 'Confirmação'}</span>
            <span>${score > 0 ? `${score}%` : 'Sem candidato'}</span>
            ${status === 'resolvida' ? '<i class="fas fa-check-circle text-success"></i>' : ''}
            ${status === 'ignorada' ? '<i class="fas fa-ban text-muted"></i>' : ''}
          </div>
        </button>
      `;
    }).join('');
  }

  function renderDetalhes(pendencia, sessao) {
    const xml = pendencia.produtoXML || sessao.itens[pendencia.indice] || {};
    return `
      <div class="miip-central-detalhe-bloco">
        <h6>Produto do XML</h6>
        <p class="miip-central-detalhe-nome">${escapeHtml(xml.produto_nome || '-')}</p>
        <dl class="miip-central-dl">
          <dt>Fornecedor</dt><dd>${escapeHtml(sessao.fornecedor || '-')}</dd>
          <dt>Código fornecedor</dt><dd>${escapeHtml(xml.codigo_fornecedor || '-')}</dd>
          <dt>Quantidade</dt><dd>${escapeHtml(xml.quantidade ?? '-')} ${escapeHtml(xml.unidade || '')}</dd>
          <dt>Valor</dt><dd>${formatarMoeda(xml.preco_unitario || xml.subtotal)}</dd>
          <dt>Descrição completa</dt><dd>${escapeHtml(xml.produto_nome || '-')}</dd>
        </dl>
      </div>
    `;
  }

  function renderCandidato(pendencia) {
    const produto = pendencia.produtoEncontrado;
    if (!produto) {
      return `
        <div class="miip-central-candidato miip-central-candidato--vazio">
          <h6>Melhor candidato</h6>
          <p>Nenhum candidato confiável encontrado. Cadastre um novo produto ou escolha manualmente.</p>
        </div>
      `;
    }

    const score = Number(pendencia.score ?? 0);
    const evidencias = extrairEvidencias(pendencia.candidatoSelecionado, pendencia.motor);

    return `
      <div class="miip-central-candidato">
        <h6>Produto CDS</h6>
        <p class="miip-central-candidato-nome">${escapeHtml(produto.nome || '-')}</p>
        <div class="miip-central-candidato-score">
          <span>Nível de Certeza</span>
          <strong>${score}%</strong>
        </div>
        <div class="miip-central-evidencias">
          <span>Baseado em</span>
          <ul>${evidencias.map((ev) => `<li><i class="fas fa-check"></i> ${escapeHtml(ev)}</li>`).join('')}</ul>
        </div>
      </div>
    `;
  }

  function renderTelaRevisao() {
    const { sessao } = estado;
    const pendencia = sessao.pendencias[sessao.indiceAtual];
    const abertas = contarAbertas(sessao);

    $('#miipCentralResumo').html(renderResumoTopo(sessao));
    $('#miipCentralLista').html(renderListaPendencias(sessao));
    $('#miipCentralDetalhes').html(renderDetalhes(pendencia, sessao));
    $('#miipCentralCandidato').html(renderCandidato(pendencia));
    $('#miipCentralContador').text(`${sessao.indiceAtual + 1} / ${sessao.pendencias.length} pendências (${abertas} abertas)`);

    if (abertas === 0) {
      mostrarTelaFinal();
    }
  }

  function renderTelaFinal() {
    const { sessao } = estado;
    sessao.fase = 'final';
    const precisao = calcularPrecisao(sessao.resumo, sessao.confirmadosManualmente);

    $('#miipCentralCorpo').html(`
      <div class="miip-central-final">
        ${renderResumoTopo(sessao)}
        <div class="miip-central-final-msg">
          <i class="fas fa-check-circle"></i>
          <h4>Importação concluída.</h4>
          <p>MIIP identificou automaticamente: <strong>${sessao.resumo.identificadosAutomaticamente}</strong> produtos</p>
          <p>Aprendeu: <strong>${sessao.aprendizados}</strong> novas associações.</p>
          <p>Precisão desta importação: <strong>${precisao}%</strong></p>
          <p class="miip-central-final-sub">Agora a compra será aberta para conferência final.</p>
          <button type="button" class="btn btn-primary btn-lg" id="miipCentralBtnConcluir">Abrir tela de Compras</button>
        </div>
      </div>
    `);
  }

  function renderSemPendencias() {
    const { sessao } = estado;
    sessao.fase = 'final';
    renderTelaFinal();
  }

  function renderModal() {
    const html = `
      <div class="modal fade miip-central-modal" id="miipCentralRevisaoModal" tabindex="-1" data-bs-backdrop="static" data-bs-keyboard="false">
        <div class="modal-dialog modal-fullscreen">
          <div class="modal-content miip-central-content">
            <div class="modal-header miip-central-header">
              <div>
                <h5 class="modal-title"><i class="fas fa-robot"></i> Central de Revisão MIIP</h5>
                <small id="miipCentralContador" class="text-muted"></small>
              </div>
              <button type="button" class="btn btn-sm btn-outline-light" id="miipCentralBtnCancelar" title="ESC — Cancelar revisão">
                <i class="fas fa-times"></i> Cancelar (ESC)
              </button>
            </div>
            <div class="modal-body p-0" id="miipCentralCorpo">
              <div id="miipCentralResumo" class="miip-central-resumo"></div>
              <div class="miip-central-layout">
                <aside class="miip-central-lista" id="miipCentralLista"></aside>
                <section class="miip-central-painel">
                  <div id="miipCentralDetalhes"></div>
                  <div id="miipCentralCandidato"></div>
                  <div class="miip-central-acoes">
                    <button type="button" class="btn btn-success" id="miipCentralBtnConfirmar"><i class="fas fa-check"></i> Confirmar Produto <small>(Enter)</small></button>
                    <button type="button" class="btn btn-primary" id="miipCentralBtnEscolher"><i class="fas fa-search"></i> Escolher outro <small>(F2)</small></button>
                    <button type="button" class="btn btn-warning" id="miipCentralBtnCadastrar"><i class="fas fa-plus"></i> Cadastrar Novo <small>(F3)</small></button>
                    <button type="button" class="btn btn-outline-secondary" id="miipCentralBtnIgnorar"><i class="fas fa-ban"></i> Ignorar Item</button>
                  </div>
                  <div class="miip-central-atalhos">
                    <span><kbd>Enter</kbd> Confirmar</span>
                    <span><kbd>Tab</kbd> Próximo</span>
                    <span><kbd>Shift</kbd>+<kbd>Tab</kbd> Anterior</span>
                    <span><kbd>F2</kbd> Pesquisar</span>
                    <span><kbd>F3</kbd> Cadastrar</span>
                    <span><kbd>Esc</kbd> Cancelar</span>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="miipCentralAprendizadoToast" class="miip-central-toast">
        <i class="fas fa-check"></i>
        <div>
          <strong>MIIP aprendeu esta associação.</strong>
          <span>Próximas importações serão automáticas.</span>
        </div>
      </div>
      <div class="modal fade" id="miipCentralBuscaModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title">Pesquisar produto (F2)</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
              <input type="text" class="form-control mb-2" id="miipCentralBuscaInput" placeholder="Nome, código ou GTIN...">
              <div id="miipCentralBuscaResultados" class="miip-central-busca-lista"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    $('#miipCentralRevisaoRoot').remove();
    $('body').append(`<div id="miipCentralRevisaoRoot">${html}</div>`);
  }

  function abrirModal() {
    renderModal();
    const modal = new bootstrap.Modal(document.getElementById('miipCentralRevisaoModal'));
    estado.modal = modal;
    modal.show();
    bindEventos();
  }

  function fecharModal() {
    if (estado?.modal) estado.modal.hide();
    $('#miipCentralRevisaoRoot').remove();
    $(document).off('.miipCentral');
    $(document).off('.miipCentralCadastro');
  }

  function confirmarAtual() {
    const pendencia = estado.sessao.pendencias[estado.sessao.indiceAtual];
    if (!pendencia || !pendenciaAberta(estado.sessao, pendencia)) return;

    const produtoId = pendencia.produtoEncontrado?.id;
    if (!produtoId) {
      notificar('Nenhum candidato para confirmar. Use F2 ou cadastre um novo produto.', 'warning');
      return;
    }

    aplicarConfirmacao(pendencia, produtoId, pendencia.produtoEncontrado);
  }

  function aplicarConfirmacao(pendencia, produtoId, produto, aprendeuExplicito) {
    const item = estado.sessao.itens[pendencia.indice];
    if (item) {
      item.produto_id = Number(produtoId);
      item.miip_revisao_status = 'confirmado';
    }

    estado.sessao.resolvidas.push(pendencia.indice);
    estado.sessao.confirmadosManualmente += 1;

    const promessa = aprendeuExplicito === false
      ? Promise.resolve(false)
      : enviarAprendizado(pendencia, produtoId, produto);

    promessa.then((aprendeu) => {
      if (aprendeu) {
        estado.sessao.aprendizados += 1;
        mostrarAprendizado();
      }
      proximaAberta(estado.sessao, 1);
      renderTelaRevisao();
    });
  }

  function ignorarAtual() {
    const pendencia = estado.sessao.pendencias[estado.sessao.indiceAtual];
    if (!pendencia || !pendenciaAberta(estado.sessao, pendencia)) return;
    estado.sessao.ignoradas.push(pendencia.indice);
    proximaAberta(estado.sessao, 1);
    renderTelaRevisao();
  }

  function abrirBuscaProduto() {
    const produtos = estado.opcoes.produtos || [];
    const modalEl = document.getElementById('miipCentralBuscaModal');
    if (!modalEl) return;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    elevarModalSobreMiip(modalEl);
    const renderBusca = (termo) => {
      const lower = String(termo || '').toLowerCase().trim();
      const filtrados = produtos.filter((p) => {
        if (!lower) return true;
        return String(p.nome || '').toLowerCase().includes(lower)
          || String(p.codigo || '').includes(lower)
          || String(p.codigo_barras || '').includes(lower)
          || String(p.plu || '').includes(lower);
      }).slice(0, 30);

      $('#miipCentralBuscaResultados').html(filtrados.map((p) => `
        <button type="button" class="miip-central-busca-item" data-produto-id="${p.id}">
          <strong>${escapeHtml(p.nome)}</strong>
          <small>${escapeHtml(p.codigo_barras || p.codigo || '')}</small>
        </button>
      `).join('') || '<p class="text-muted p-2">Nenhum produto encontrado.</p>');
    };

    $('#miipCentralBuscaInput').val('').off('input.miip').on('input.miip', function onBusca() {
      renderBusca(this.value);
    });
    $('#miipCentralBuscaResultados').off('click.miip').on('click.miip', '.miip-central-busca-item', function onSelect() {
      const produtoId = Number($(this).data('produto-id'));
      const produto = produtos.find((p) => Number(p.id) === produtoId);
      const pendencia = estado.sessao.pendencias[estado.sessao.indiceAtual];
      modal.hide();
      if (produto && pendencia) {
        aplicarConfirmacao(pendencia, produtoId, { id: produtoId, nome: produto.nome });
      }
    });

    renderBusca('');
    modal.show();
    setTimeout(() => $('#miipCentralBuscaInput').trigger('focus'), 200);
  }

  function elevarModalSobreMiip(modalEl) {
    if (!modalEl) return;
    modalEl.style.zIndex = '21000';
    requestAnimationFrame(() => {
      const backdrops = document.querySelectorAll('.modal-backdrop');
      const last = backdrops[backdrops.length - 1];
      if (last) last.style.zIndex = '20990';
    });
  }

  function preencherCamposCadastroProduto(item) {
    const xml = item || {};
    const nome = xml.produto_nome || xml.descricao || xml.nome || '';
    if ($('#nome').length) $('#nome').val(nome);
    if ($('#codigo_barras').length) $('#codigo_barras').val(xml.codigo_barras || xml.gtin || '');
    if ($('#ncm').length) $('#ncm').val(xml.ncm || '');
    if ($('#unidade').length) $('#unidade').val(xml.unidade || 'UN');
    if ($('#preco_compra').length && (xml.preco_unitario != null || xml.valor_unitario != null)) {
      $('#preco_compra').val(Number(xml.preco_unitario ?? xml.valor_unitario ?? 0));
    }
    if ($('#codigo').length && xml.codigo_fornecedor) {
      $('#codigo').val(String(xml.codigo_fornecedor));
    }
  }

  async function resolverProdutoRecemCadastrado(nomeHint) {
    try {
      const token = localStorage.getItem('token') || '';
      const resp = await fetch(`${estado.opcoes.apiUrl}/produtos`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!resp.ok) return null;
      const lista = await resp.json().catch(() => []);
      if (!Array.isArray(lista) || !lista.length) return null;

      const hint = String(nomeHint || '').trim().toLowerCase();
      if (hint) {
        const porNome = [...lista].reverse().find((p) =>
          String(p.nome || '').trim().toLowerCase() === hint
        );
        if (porNome) return porNome;
      }

      return lista.reduce((a, b) => (Number(a?.id || 0) > Number(b?.id || 0) ? a : b));
    } catch (_) {
      return null;
    }
  }

  /**
   * Abre o cadastro de produto acima da Central MIIP (fullscreen).
   * Sem isso o modal de produto fica invisível atrás da revisão.
   */
  function abrirCadastroProdutoPadrao(item, callback) {
    if (typeof showProdutoModal !== 'function') {
      notificar('Cadastre o produto em Produtos e selecione-o com F2.', 'info');
      abrirBuscaProduto();
      if (typeof callback === 'function') callback(null);
      return;
    }

    showProdutoModal(null);

    const el = document.getElementById('produtoModal');
    if (!el) {
      notificar('Não foi possível abrir o cadastro de produto.', 'danger');
      if (typeof callback === 'function') callback(null);
      return;
    }

    // Garante exibição no Bootstrap 5 (jQuery .modal pode não existir).
    try {
      bootstrap.Modal.getOrCreateInstance(el).show();
    } catch (_) { /* ignore */ }

    elevarModalSobreMiip(el);

    const onShown = () => {
      elevarModalSobreMiip(el);
      preencherCamposCadastroProduto(item);
      setTimeout(() => {
        const campo = document.getElementById('nome');
        if (campo) campo.focus();
      }, 50);
    };

    el.addEventListener('shown.bs.modal', onShown, { once: true });
    if (el.classList.contains('show')) onShown();

    el.addEventListener('hidden.bs.modal', async () => {
      const nomeHint = item?.produto_nome || item?.descricao || item?.nome || '';
      const produto = await resolverProdutoRecemCadastrado(nomeHint);
      if (typeof callback === 'function') callback(produto || null);
      if (!produto) {
        notificar('Se o produto foi salvo, use F2 para selecioná-lo.', 'info');
      }
    }, { once: true });
  }

  function cadastrarNovo() {
    const pendencia = estado.sessao.pendencias[estado.sessao.indiceAtual];
    if (!pendencia || !pendenciaAberta(estado.sessao, pendencia)) {
      notificar('Selecione um item pendente para cadastrar.', 'warning');
      return;
    }

    const item = estado.sessao.itens[pendencia.indice] || pendencia.produtoXML || {};
    const aoCadastrar = (produto) => {
      if (produto?.id) {
        aplicarConfirmacao(pendencia, produto.id, produto, false);
      }
    };

    if (typeof estado.opcoes.abrirCadastroProduto === 'function') {
      try {
        estado.opcoes.abrirCadastroProduto(item, aoCadastrar);
        // Se o callback externo abriu o modal, ainda elevamos o z-index.
        setTimeout(() => elevarModalSobreMiip(document.getElementById('produtoModal')), 80);
        return;
      } catch (err) {
        console.warn('[MIIP] abrirCadastroProduto falhou, usando fallback:', err);
      }
    }

    abrirCadastroProdutoPadrao(item, aoCadastrar);
  }

  function concluirRevisao() {
    const { sessao, opcoes } = estado;
    const resultado = {
      itens: sessao.itens,
      estatisticas: {
        identificadosAutomaticamente: sessao.resumo.identificadosAutomaticamente,
        aprendeu: sessao.aprendizados,
        precisao: calcularPrecisao(sessao.resumo, sessao.confirmadosManualmente),
        confirmadosManualmente: sessao.confirmadosManualmente
      }
    };

    fecharModal();
    estado = null;
    if (typeof opcoes.onConcluir === 'function') opcoes.onConcluir(resultado);
  }

  function cancelarRevisao() {
    const cb = estado?.opcoes?.onCancelar;
    fecharModal();
    estado = null;
    if (typeof cb === 'function') cb();
  }

  function onKeydown(event) {
    if (!estado || !document.getElementById('miipCentralRevisaoModal')?.classList.contains('show')) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      cancelarRevisao();
      return;
    }

    if (estado.sessao.fase === 'final') return;

    if (event.key === 'Enter' && !$(event.target).is('input, textarea, select')) {
      event.preventDefault();
      confirmarAtual();
      return;
    }

    if (event.key === 'F2') {
      event.preventDefault();
      abrirBuscaProduto();
      return;
    }

    if (event.key === 'F3') {
      event.preventDefault();
      cadastrarNovo();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      proximaAberta(estado.sessao, event.shiftKey ? -1 : 1);
      renderTelaRevisao();
    }
  }

  function bindEventos() {
    $(document).off('.miipCentral');
    $(document).off('.miipCentralCadastro');
    $(document).on('keydown.miipCentral', onKeydown);

    $('#miipCentralBtnConfirmar').on('click', confirmarAtual);
    $('#miipCentralBtnEscolher').on('click', abrirBuscaProduto);
    $(document).off('click.miipCentralCadastro').on('click.miipCentralCadastro', '#miipCentralBtnCadastrar', function (e) {
      e.preventDefault();
      cadastrarNovo();
    });
    $('#miipCentralBtnIgnorar').on('click', ignorarAtual);
    $('#miipCentralBtnCancelar').on('click', cancelarRevisao);

    $('#miipCentralLista').on('click', '.miip-central-lista-item', function onListaClick() {
      estado.sessao.indiceAtual = Number($(this).data('lista-idx'));
      renderTelaRevisao();
    });

    $(document).on('click.miipCentral', '#miipCentralBtnConcluir', concluirRevisao);
  }

  function iniciar(opcoes) {
    if (!opcoes?.dadosImportacao?.miip_importacao?.usarMiipImportacaoXML) {
      if (typeof opcoes.onConcluir === 'function') {
        opcoes.onConcluir({ itens: opcoes.dadosImportacao?.itens || [], estatisticas: {} });
      }
      return;
    }

    estado = {
      opcoes: {
        apiUrl: opcoes.apiUrl || (typeof API_URL !== 'undefined' ? API_URL : '/api'),
        produtos: opcoes.produtos || [],
        obterUsuario: opcoes.obterUsuario || (() => null),
        abrirCadastroProduto: opcoes.abrirCadastroProduto || null,
        onConcluir: opcoes.onConcluir,
        onCancelar: opcoes.onCancelar
      },
      sessao: montarSessao(opcoes.dadosImportacao),
      modal: null
    };

    abrirModal();

    if (estado.sessao.pendencias.length === 0) {
      renderSemPendencias();
      return;
    }

    renderTelaRevisao();
  }

  global.MiipCentralRevisao = {
    iniciar,
    _test: {
      montarSessao,
      ordenarPendencias,
      extrairPendencias,
      calcularPrecisao
    }
  };
})(typeof window !== 'undefined' ? window : global);
