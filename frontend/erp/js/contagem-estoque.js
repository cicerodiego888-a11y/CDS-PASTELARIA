/**
 * Contagem física mínima F×NF — CDS-ESTOQUE-MANUAL-01.
 * CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03.1 — preserva snapshot do preview na confirmação.
 * CDS-ESTOQUE-CONTAGEM-PENDENCIAS-04 — alerta informativo de entradas da Central sem compra.
 * CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05 — periodicidade informativa por empresa.
 * CDS-ESTOQUE-CONTAGEM-UX-PERMISSOES-05.1 — menu Estoque + pesquisa por nome/código/barras.
 * CDS-ESTOQUE-CONTAGEM-CONVERSAO-UNIDADES-F12-05.2 — conversão MUC + campo NF conforme F12.
 */
(function (root) {
  'use strict';

  function authHeaders(extra) {
    const h = Object.assign({
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (localStorage.getItem('token') || '')
    }, extra || {});
    if (root.CdsEmpresaContexto && typeof root.CdsEmpresaContexto.headersJson === 'function') {
      const ctx = root.CdsEmpresaContexto.headersJson();
      if (ctx['X-Empresa-Id']) h['X-Empresa-Id'] = ctx['X-Empresa-Id'];
    }
    return h;
  }

  function empresaIdAtual() {
    if (root.CdsEmpresaContexto) {
      if (typeof root.CdsEmpresaContexto.lerEmpresaId === 'function') {
        const idLer = Number(root.CdsEmpresaContexto.lerEmpresaId());
        if (Number.isInteger(idLer) && idLer > 0) return idLer;
      }
      if (typeof root.CdsEmpresaContexto.getEmpresaId === 'function') {
        const id = Number(root.CdsEmpresaContexto.getEmpresaId());
        if (Number.isInteger(id) && id > 0) return id;
      }
    }
    const h = authHeaders();
    const fromHeader = Number(h['X-Empresa-Id']);
    return Number.isInteger(fromHeader) && fromHeader > 0 ? fromHeader : null;
  }

  function empresaLabelAtual() {
    const id = empresaIdAtual();
    let nome = '';
    if (root.CdsEmpresaContexto && typeof root.CdsEmpresaContexto.lerEmpresa === 'function') {
      const emp = root.CdsEmpresaContexto.lerEmpresa();
      if (emp) nome = String(emp.nome_fantasia || emp.razao_social || '').trim();
    }
    if (id == null) return 'não selecionada';
    return nome ? (nome + ' (#' + id + ')') : ('Empresa #' + id);
  }

  function podeAcessarContagem() {
    if (typeof root.podeAjustarEstoque === 'function') return !!root.podeAjustarEstoque();
    if (typeof root.usuarioTemPermissao === 'function') return !!root.usuarioTemPermissao('contagem-estoque');
    return false;
  }

  function notify(msg, tipo) {
    if (typeof root.showNotification === 'function') root.showNotification(msg, tipo || 'info');
    else window.alert(msg);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Linhas com snapshot imutável do preview (não recalcular no browser). */
  let linhas = [];
  let confirmacaoEmAndamento = false;
  let aguardandoNovoPreview = false;
  /** @type {{ id: number, nome: string, codigo?: string|null, codigo_barras?: string|null, unidade?: string }|null} */
  let produtoSelecionado = null;
  let buscaTimer = null;
  let buscaSeq = 0;
  let listenerSugestoesDoc = false;
  /** Modo F12 capturado ao abrir/atualizar a tela — mudança exige novo preview. */
  let modoFiscalSessao = null;

  function lerModoFiscalAtivo() {
    if (typeof root.modoFiscalAtivoSistema === 'function') return !!root.modoFiscalAtivoSistema();
    if (typeof root.modoFiscalQueryParam === 'function') return root.modoFiscalQueryParam() === '1';
    try {
      return localStorage.getItem('pdv_modo_fiscal_ativo') === '1';
    } catch (_) {
      return true;
    }
  }

  function sincronizarModoFiscalSessao() {
    modoFiscalSessao = lerModoFiscalAtivo();
    return modoFiscalSessao;
  }

  function modoFiscalMudou() {
    return modoFiscalSessao != null && lerModoFiscalAtivo() !== modoFiscalSessao;
  }

  function snapshotDaLinha(preview, metaProduto) {
    const meta = metaProduto || {};
    return {
      produto_id: Number(preview.produto_id),
      produto_nome: meta.nome || preview.produto_nome || ('Produto #' + preview.produto_id),
      produto_codigo: meta.codigo != null ? meta.codigo : (preview.produto_codigo || null),
      empresa_id: preview.empresa_id != null ? Number(preview.empresa_id) : null,
      unidade_informada: preview.unidade_informada || meta.unidade || meta.unidade_comercial || null,
      unidade_base: preview.unidade_base || meta.unidade_base || null,
      fator_total: preview.fator_total != null ? preview.fator_total : meta.fator_conversao,
      quantidade_fiscal_informada: preview.quantidade_fiscal_informada,
      quantidade_nao_fiscal_informada: preview.quantidade_nao_fiscal_informada,
      quantidade_fiscal_contada: preview.quantidade_fiscal_contada,
      quantidade_nao_fiscal_contada: preview.quantidade_nao_fiscal_contada,
      omitir_nao_fiscal: !!preview.omitir_nao_fiscal,
      modo_fiscal: preview.modo_fiscal || (preview.omitir_nao_fiscal ? '1' : '0'),
      mensagem_conversao_fiscal: preview.mensagem_conversao_fiscal || null,
      saldo_fiscal_anterior: preview.saldo_fiscal_anterior,
      saldo_nao_fiscal_anterior: preview.saldo_nao_fiscal_anterior,
      // Valores originais do preview — nunca substituir por quantidade física.
      saldo_fiscal_esperado: preview.saldo_fiscal_esperado != null
        ? preview.saldo_fiscal_esperado
        : preview.saldo_fiscal_anterior,
      saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado != null
        ? preview.saldo_nao_fiscal_esperado
        : preview.saldo_nao_fiscal_anterior,
      diferenca_fiscal: preview.diferenca_fiscal,
      diferenca_nao_fiscal: preview.diferenca_nao_fiscal
    };
  }

  /** Contrato Sprint 03.1 — valores do preview (unidade-base) + snapshot. */
  function itemConfirmacao(l) {
    return {
      produto_id: l.produto_id,
      quantidade_fiscal_contada: l.quantidade_fiscal_contada,
      quantidade_nao_fiscal_contada: l.quantidade_nao_fiscal_contada,
      saldo_fiscal_esperado: l.saldo_fiscal_esperado,
      saldo_nao_fiscal_esperado: l.saldo_nao_fiscal_esperado
    };
  }

  /**
   * Payload de confirmação 05.2: preserva snapshot 03.1 e envia quantidades
   * comerciais informadas para reconversão oficial no backend.
   * Com F12 ON (omitir_nao_fiscal), não envia quantidade NF (ausência ≠ zero).
   */
  function itemConfirmacaoApi(l) {
    const item = itemConfirmacao(l);
    const omitirNf = !!l.omitir_nao_fiscal;
    item.modo_fiscal = l.modo_fiscal || (omitirNf ? '1' : '0');
    item.omitir_nao_fiscal = omitirNf;
    item.quantidade_fiscal_informada = l.quantidade_fiscal_informada != null
      ? l.quantidade_fiscal_informada
      : l.quantidade_fiscal_contada;
    if (l.unidade_informada) item.unidade_informada = l.unidade_informada;
    if (omitirNf) {
      delete item.quantidade_nao_fiscal_contada;
    } else {
      item.quantidade_nao_fiscal_informada = l.quantidade_nao_fiscal_informada != null
        ? l.quantidade_nao_fiscal_informada
        : l.quantidade_nao_fiscal_contada;
    }
    return item;
  }

  function limparSugestoes() {
    const box = document.getElementById('cef-produtos-sugestoes');
    if (box) {
      box.innerHTML = '';
      box.classList.add('d-none');
    }
  }

  function definirProdutoSelecionado(item) {
    produtoSelecionado = item
      ? {
        id: Number(item.id || item.produto_id),
        nome: item.nome || '',
        codigo: item.codigo || item.codigo_interno || null,
        codigo_barras: item.codigo_barras || null,
        unidade: item.unidade_comercial || item.unidade || 'UN',
        unidade_comercial: item.unidade_comercial || item.unidade || 'UN',
        unidade_base: item.unidade_base || null,
        utiliza_conversao: !!item.utiliza_conversao,
        fator_conversao: item.fator_conversao != null ? item.fator_conversao : null,
        apresentacao_id: item.apresentacao_id != null ? Number(item.apresentacao_id) : null
      }
      : null;
    const input = document.getElementById('cef-produto-busca');
    const sel = document.getElementById('cef-produto-selecionado');
    if (input && produtoSelecionado) {
      input.value = produtoSelecionado.nome;
    }
    if (sel) {
      if (!produtoSelecionado) {
        sel.textContent = 'Nenhum produto selecionado.';
        sel.className = 'small text-muted mt-1';
      } else {
        let extra = '';
        if (produtoSelecionado.codigo) {
          extra += ' · cód. ' + escapeHtml(produtoSelecionado.codigo);
        }
        extra += ' · comercial ' + escapeHtml(produtoSelecionado.unidade_comercial || 'UN');
        if (produtoSelecionado.unidade_base) {
          extra += ' · estoque ' + escapeHtml(produtoSelecionado.unidade_base);
        }
        if (produtoSelecionado.fator_conversao != null && produtoSelecionado.utiliza_conversao) {
          extra += ' · fator ' + escapeHtml(produtoSelecionado.fator_conversao);
        }
        sel.innerHTML = 'Selecionado: <strong>' + escapeHtml(produtoSelecionado.nome) + '</strong>' + extra;
        sel.className = 'small text-success mt-1';
      }
    }
    limparSugestoes();
  }

  function aplicarVisibilidadeF12() {
    const wrapNf = document.getElementById('cef-wrap-qnf');
    const inputNf = document.getElementById('cef-qnf');
    const badge = document.getElementById('cef-f12-badge');
    const f12On = !!modoFiscalSessao;
    if (wrapNf) {
      if (f12On) wrapNf.classList.add('d-none');
      else wrapNf.classList.remove('d-none');
    }
    if (inputNf && f12On) inputNf.value = '';
    if (badge) {
      badge.textContent = f12On
        ? 'F12 ON — somente quantidade fiscal (saldo não fiscal preservado)'
        : 'F12 OFF — quantidades fiscal e não fiscal';
      badge.className = f12On ? 'badge text-bg-warning' : 'badge text-bg-secondary';
    }
  }

  function renderSugestoes(itens) {
    const box = document.getElementById('cef-produtos-sugestoes');
    if (!box) return;
    if (!itens || !itens.length) {
      box.classList.remove('d-none');
      box.innerHTML = '<div class="list-group-item text-muted small">'
        + 'Nenhum produto encontrado. Verifique o nome, código de barras ou código interno.'
        + '</div>';
      return;
    }
    box.classList.remove('d-none');
        box.innerHTML = itens.map(function (p) {
      return '<button type="button" class="list-group-item list-group-item-action py-2" data-cef-prod-id="'
        + escapeHtml(p.id) + '">'
        + '<div class="fw-semibold">' + escapeHtml(p.nome || '—') + '</div>'
        + '<div class="small text-muted">'
        + (p.codigo ? 'Cód. interno: ' + escapeHtml(p.codigo) + ' · ' : '')
        + (p.codigo_barras ? 'Barras: ' + escapeHtml(p.codigo_barras) + ' · ' : '')
        + 'Comercial: ' + escapeHtml(p.unidade_comercial || p.unidade || 'UN')
        + (p.unidade_base ? ' · Estoque: ' + escapeHtml(p.unidade_base) : '')
        + (p.fator_conversao != null && p.utiliza_conversao
          ? ' · Fator: ' + escapeHtml(p.fator_conversao)
          : '')
        + '</div></button>';
    }).join('');
    box.querySelectorAll('[data-cef-prod-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = Number(btn.getAttribute('data-cef-prod-id'));
        const hit = itens.find(function (x) { return Number(x.id) === id; });
        if (hit) definirProdutoSelecionado(hit);
      });
    });
  }

  async function pesquisarProdutos(termo) {
    const q = String(termo || '').trim();
    const seq = ++buscaSeq;
    if (q.length < 1) {
      limparSugestoes();
      return;
    }
    try {
      const res = await fetch(
        '/api/estoque/contagem-fisica/produtos-busca?q=' + encodeURIComponent(q) + '&limite=20',
        { method: 'GET', headers: authHeaders() }
      );
      const data = await res.json().catch(function () { return {}; });
      if (seq !== buscaSeq) return;
      if (res.status === 403) {
        notify(data.error || 'Acesso não autorizado à pesquisa de produtos.', 'warning');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Falha na pesquisa de produtos');
      renderSugestoes(Array.isArray(data.itens) ? data.itens : []);
    } catch (err) {
      if (seq !== buscaSeq) return;
      notify(err.message || 'Falha na pesquisa', 'danger');
    }
  }

  function agendarPesquisa() {
    const input = document.getElementById('cef-produto-busca');
    if (!input) return;
    // Digitação após seleção limpa o vínculo interno até nova escolha explícita.
    if (produtoSelecionado && input.value.trim() !== produtoSelecionado.nome) {
      produtoSelecionado = null;
      const sel = document.getElementById('cef-produto-selecionado');
      if (sel) {
        sel.textContent = 'Selecione um produto na lista de sugestões.';
        sel.className = 'small text-muted mt-1';
      }
    }
    if (buscaTimer) clearTimeout(buscaTimer);
    buscaTimer = setTimeout(function () {
      pesquisarProdutos(input.value);
    }, 280);
  }

  function render() {
    const rootEl = document.getElementById('page-content');
    if (!rootEl) return;

    if (!podeAcessarContagem()) {
      rootEl.innerHTML = `
        <div class="container-fluid py-3">
          <div class="alert alert-warning" role="alert">
            <strong>Acesso não autorizado.</strong>
            Contagem Física exige perfil autorizado a ajustar estoque (ADMIN ou SUPER_ADMIN).
            Nenhuma movimentação foi realizada.
          </div>
        </div>`;
      return;
    }

    sincronizarModoFiscalSessao();
    const empLabel = empresaLabelAtual();
    const f12On = !!modoFiscalSessao;
    rootEl.innerHTML = `
      <div class="container-fluid py-3">
        <h2 class="h4">Contagem física de estoque</h2>
        <p class="text-muted mb-1">Informe a quantidade física na unidade comercial; o sistema converte para a unidade de estoque.</p>
        <p class="small mb-2">Empresa selecionada: <strong>${escapeHtml(empLabel)}</strong>
          · <span id="cef-f12-badge" class="badge ${f12On ? 'text-bg-warning' : 'text-bg-secondary'}">${
            f12On
              ? 'F12 ON — somente quantidade fiscal (saldo não fiscal preservado)'
              : 'F12 OFF — quantidades fiscal e não fiscal'
          }</span>
        </p>
        <div id="cef-alerta-periodicidade" class="alert alert-secondary d-none" role="status"></div>
        <div id="cef-alerta-pendencias" class="alert alert-info d-none" role="status"></div>
        <div id="cef-alerta-desatualizada" class="alert alert-warning d-none" role="alert"></div>
        <div class="card mb-3"><div class="card-body">
          <h3 class="h6">Periodicidade da contagem (informativo)</h3>
          <p class="small text-muted mb-2">Não impede contagens fora da data. Serve para organização e acompanhamento.</p>
          <div class="row g-2 align-items-end">
            <div class="col-md-4">
              <label class="form-label">Periodicidade</label>
              <select id="cef-periodicidade" class="form-select">
                <option value="SEMANAL">Semanal (7 dias)</option>
                <option value="QUINZENAL">Quinzenal (15 dias)</option>
                <option value="SOB_DEMANDA">Sob demanda</option>
              </select>
            </div>
            <div class="col-md-3">
              <div class="form-check mt-4">
                <input class="form-check-input" type="checkbox" id="cef-period-ativo" checked>
                <label class="form-check-label" for="cef-period-ativo">Alertas ativos</label>
              </div>
            </div>
            <div class="col-md-5">
              <button type="button" class="btn btn-outline-primary" id="cef-salvar-periodicidade">Salvar periodicidade</button>
              <button type="button" class="btn btn-outline-secondary" id="cef-atualizar-status">Atualizar status</button>
            </div>
          </div>
          <div id="cef-period-detalhes" class="small mt-3 text-muted"></div>
        </div></div>
        <div class="card mb-3"><div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-5 position-relative">
              <label class="form-label" for="cef-produto-busca">Pesquisar produto</label>
              <input id="cef-produto-busca" class="form-control" type="text" autocomplete="off"
                placeholder="Digite o nome, código de barras ou código interno">
              <div id="cef-produtos-sugestoes" class="list-group position-absolute w-100 shadow-sm d-none"
                style="z-index:20; max-height:16rem; overflow:auto;"></div>
              <div id="cef-produto-selecionado" class="small text-muted mt-1">Nenhum produto selecionado.</div>
            </div>
            <div class="col-md-2"><label class="form-label" id="cef-label-qf">Qtd fiscal contada</label>
              <input id="cef-qf" class="form-control" type="number" min="0" step="0.000001" value="0"></div>
            <div class="col-md-2 ${f12On ? 'd-none' : ''}" id="cef-wrap-qnf">
              <label class="form-label">Qtd não fiscal contada</label>
              <input id="cef-qnf" class="form-control" type="number" min="0" step="0.000001" value="0"></div>
            <div class="col-md-3"><label class="form-label">Observação (opcional)</label>
              <input id="cef-obs" class="form-control" maxlength="500"></div>
          </div>
          <div class="mt-3">
            <button type="button" class="btn btn-outline-primary" id="cef-preview">Calcular diferenças</button>
            <button type="button" class="btn btn-outline-secondary" id="cef-add">Incluir na lista</button>
            <button type="button" class="btn btn-link btn-sm" id="cef-atualizar-f12">Atualizar contexto F12</button>
          </div>
          <div id="cef-conv-box" class="mt-2 small text-muted"></div>
          <div id="cef-preview-box" class="mt-2 small text-muted"></div>
        </div></div>
        <div class="table-responsive">
          <table class="table table-sm align-middle">
            <thead><tr>
              <th>Produto</th><th>Saldo F ant.</th><th>Saldo NF ant.</th>
              <th>Contado F (base)</th><th>Contado NF (base)</th><th>Dif. F</th><th>Dif. NF</th><th></th>
            </tr></thead>
            <tbody id="cef-tbody"></tbody>
          </table>
        </div>
        <button type="button" class="btn btn-primary" id="cef-confirmar">Confirmar contagem</button>
        <button type="button" class="btn btn-outline-warning d-none" id="cef-atualizar-preview">Atualizar pré-visualização</button>
        <div id="cef-resultado" class="mt-3"></div>
        <div class="card mt-3"><div class="card-body">
          <h3 class="h6">Histórico recente</h3>
          <div class="table-responsive">
            <table class="table table-sm">
              <thead><tr>
                <th>ID</th><th>Data</th><th>Operador</th><th>Produtos</th><th>Resultado</th>
              </tr></thead>
              <tbody id="cef-historico-tbody"></tbody>
            </table>
          </div>
        </div></div>
      </div>`;
    document.getElementById('cef-preview').addEventListener('click', previewLinha);
    document.getElementById('cef-add').addEventListener('click', adicionarLinha);
    document.getElementById('cef-confirmar').addEventListener('click', confirmar);
    document.getElementById('cef-atualizar-preview').addEventListener('click', atualizarPreviewsDaLista);
    document.getElementById('cef-salvar-periodicidade').addEventListener('click', salvarPeriodicidade);
    document.getElementById('cef-atualizar-status').addEventListener('click', carregarStatusPeriodicidade);
    const btnF12 = document.getElementById('cef-atualizar-f12');
    if (btnF12) {
      btnF12.addEventListener('click', function () {
        sincronizarModoFiscalSessao();
        aplicarVisibilidadeF12();
        if (linhas.length) {
          aguardandoNovoPreview = true;
          sincronizarEstadoConflito();
          notify('Contexto F12 atualizado. Atualize a pré-visualização antes de confirmar.', 'warning');
        }
      });
    }
    aplicarVisibilidadeF12();
    const busca = document.getElementById('cef-produto-busca');
    if (busca) {
      busca.addEventListener('input', agendarPesquisa);
      busca.addEventListener('focus', function () {
        if (busca.value.trim().length >= 1 && !produtoSelecionado) pesquisarProdutos(busca.value);
      });
      busca.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') limparSugestoes();
      });
    }
    if (!listenerSugestoesDoc) {
      listenerSugestoesDoc = true;
      document.addEventListener('click', function onDocClick(ev) {
        const wrap = document.getElementById('cef-produtos-sugestoes');
        const inp = document.getElementById('cef-produto-busca');
        if (!wrap || !inp) return;
        if (wrap.contains(ev.target) || inp.contains(ev.target)) return;
        limparSugestoes();
      });
    }
    pintarTabela();
    sincronizarEstadoConflito();
    carregarPendenciasEntrada();
    carregarStatusPeriodicidade();
    carregarHistorico();
  }

  function formatarBrData(iso) {
    if (!iso) return '—';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return escapeHtml(iso);
    return m[3] + '/' + m[2] + '/' + m[1];
  }

  async function carregarStatusPeriodicidade() {
    const alerta = document.getElementById('cef-alerta-periodicidade');
    const detalhes = document.getElementById('cef-period-detalhes');
    const sel = document.getElementById('cef-periodicidade');
    const chk = document.getElementById('cef-period-ativo');
    if (!alerta) return;
    try {
      const res = await fetch('/api/estoque/contagem-fisica/status-periodicidade', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 403) {
        alerta.classList.remove('d-none');
        alerta.className = 'alert alert-warning';
        alerta.textContent = data.error || 'Acesso não autorizado.';
        return;
      }
      if (!res.ok || data.consulta_disponivel === false) {
        alerta.classList.remove('d-none');
        alerta.className = 'alert alert-secondary';
        alerta.textContent = data.error
          || 'Não foi possível consultar a periodicidade. Não assumindo situação em dia.';
        return;
      }
      if (sel && data.configuracao) {
        sel.value = data.configuracao.periodicidade || 'SEMANAL';
      }
      if (chk && data.configuracao) {
        chk.checked = data.configuracao.ativo !== false;
      }
      const cls = data.status === 'ATRASADA'
        ? 'alert alert-warning'
        : (data.status === 'PROXIMA_DO_VENCIMENTO' || data.status === 'PRIMEIRA_CONTAGEM_PENDENTE'
          ? 'alert alert-info'
          : 'alert alert-secondary');
      alerta.classList.remove('d-none');
      alerta.className = cls;
      alerta.innerHTML = '<strong>' + escapeHtml(data.status || '—') + '</strong> — '
        + escapeHtml(data.mensagem || '')
        + ' <span class="small">(a contagem continua disponível a qualquer momento)</span>';
      if (detalhes) {
        detalhes.innerHTML = 'Última contagem: <strong>'
          + formatarBrData(data.ultima_contagem_data)
          + '</strong> · Próxima prevista: <strong>'
          + (data.proxima_contagem_data ? formatarBrData(data.proxima_contagem_data) : 'sem vencimento')
          + '</strong> · Periodicidade: <strong>'
          + escapeHtml((data.configuracao && data.configuracao.periodicidade) || '—')
          + '</strong>';
      }
    } catch (err) {
      alerta.classList.remove('d-none');
      alerta.className = 'alert alert-secondary';
      alerta.textContent = 'Não foi possível consultar a periodicidade. Não assumindo situação em dia.';
    }
  }

  async function salvarPeriodicidade() {
    const sel = document.getElementById('cef-periodicidade');
    const chk = document.getElementById('cef-period-ativo');
    try {
      const res = await fetch('/api/estoque/contagem-fisica/periodicidade', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          periodicidade: sel ? sel.value : 'SEMANAL',
          ativo: chk ? !!chk.checked : true
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha ao salvar periodicidade');
      notify('Periodicidade atualizada.', 'success');
      await carregarStatusPeriodicidade();
    } catch (err) {
      notify(err.message, 'danger');
    }
  }

  async function carregarHistorico() {
    const tb = document.getElementById('cef-historico-tbody');
    if (!tb) return;
    try {
      const res = await fetch('/api/estoque/contagem-fisica/historico?limite=15', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha no histórico');
      const itens = Array.isArray(data.itens) ? data.itens : [];
      tb.innerHTML = itens.map(function (h) {
        return '<tr><td>' + escapeHtml(h.id)
          + '</td><td>' + escapeHtml(h.criado_em || '—')
          + '</td><td>' + escapeHtml(h.usuario_nome || h.usuario_id || '—')
          + '</td><td>' + escapeHtml(h.quantidade_produtos)
          + '</td><td>' + escapeHtml(h.resultado || 'CONFIRMADA')
          + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="text-muted">Nenhuma contagem confirmada ainda.</td></tr>';
    } catch (err) {
      tb.innerHTML = '<tr><td colspan="5" class="text-muted">'
        + escapeHtml(err.message || 'Histórico indisponível') + '</td></tr>';
    }
  }

  function formatarDataCurta(valor) {
    if (!valor) return '—';
    const s = String(valor);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  /**
   * Alerta informativo — não bloqueia confirmação e não altera estoque/snapshot.
   */
  async function carregarPendenciasEntrada() {
    const box = document.getElementById('cef-alerta-pendencias');
    if (!box) return;
    box.classList.add('d-none');
    box.innerHTML = '';
    const emp = empresaIdAtual();
    if (emp == null) {
      box.classList.remove('d-none');
      box.className = 'alert alert-secondary';
      box.textContent = 'Selecione a empresa do contexto para verificar entradas pendentes na Central.';
      return;
    }
    try {
      const res = await fetch('/api/estoque/contagem-fisica/pendencias-entrada', {
        method: 'GET',
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || data.consulta_disponivel === false) {
        box.classList.remove('d-none');
        box.className = 'alert alert-secondary';
        box.innerHTML = '<strong>Não foi possível verificar as entradas pendentes.</strong> '
          + escapeHtml(data.error || 'Tente novamente ou consulte a Central Inteligente.')
          + ' Esta falha <em>não</em> significa ausência de documentos.';
        return;
      }
      const total = Number(data.total_pendentes_conversao || 0);
      const naoConf = Number(data.total_nao_confirmadas || 0);
      if (total <= 0 && naoConf <= 0) {
        box.classList.add('d-none');
        return;
      }
      const fornecedores = Array.isArray(data.fornecedores) ? data.fornecedores : [];
      const lista = Array.isArray(data.pendentes_conversao) ? data.pendentes_conversao : [];
      const linhasHtml = lista.slice(0, 8).map(function (doc) {
        return '<li><strong>NF '
          + escapeHtml(doc.numero || '—')
          + (doc.serie ? '/' + escapeHtml(doc.serie) : '')
          + '</strong> · '
          + escapeHtml(doc.fornecedor || 'Fornecedor não informado')
          + ' · recebida '
          + escapeHtml(formatarDataCurta(doc.data_recebimento))
          + ' · status <em>'
          + escapeHtml(doc.status_label || doc.status || '—')
          + '</em>'
          + (doc.chave_curta ? ' · chave ' + escapeHtml(doc.chave_curta) : '')
          + '</li>';
      }).join('');
      box.classList.remove('d-none');
      box.className = 'alert alert-warning';
      box.innerHTML = '<strong>ATENÇÃO — EXISTEM ENTRADAS PENDENTES</strong>'
        + '<p class="mb-2 mt-2">Foram encontrados <strong>'
        + total
        + '</strong> documento(s) fiscal(is) recebidos pela Central Inteligente que ainda '
        + '<strong>não possuem compra efetivamente registrada</strong>. '
        + 'Esses documentos <strong>ainda não representam crédito de estoque</strong>.</p>'
        + (fornecedores.length
          ? '<p class="mb-1 small">Fornecedores: <strong>'
            + escapeHtml(fornecedores.join(', '))
            + '</strong></p>'
          : '')
        + (naoConf > 0
          ? '<p class="mb-1 small text-muted">' + naoConf
            + ' documento(s) em situação não confirmada (ex.: em importação/erro) — verifique na Central.</p>'
          : '')
        + (linhasHtml ? '<ul class="mb-2 small">' + linhasHtml + '</ul>' : '')
        + '<p class="mb-2 small">Verifique as entradas pendentes antes de confirmar sua contagem física. '
        + 'Este aviso <strong>não bloqueia</strong> a confirmação.</p>'
        + '<button type="button" class="btn btn-sm btn-outline-primary" id="cef-abrir-central">'
        + 'Abrir Central Inteligente</button> '
        + '<button type="button" class="btn btn-sm btn-outline-secondary" id="cef-atualizar-pendencias">'
        + 'Atualizar alerta</button>';
      const btnCentral = document.getElementById('cef-abrir-central');
      if (btnCentral) {
        btnCentral.addEventListener('click', function () {
          if (typeof root.loadPage === 'function') root.loadPage('central-entradas');
        });
      }
      const btnAtt = document.getElementById('cef-atualizar-pendencias');
      if (btnAtt) btnAtt.addEventListener('click', carregarPendenciasEntrada);
    } catch (err) {
      box.classList.remove('d-none');
      box.className = 'alert alert-secondary';
      box.innerHTML = '<strong>Não foi possível verificar as entradas pendentes.</strong> '
        + escapeHtml(err && err.message ? err.message : 'Erro de rede.')
        + ' Esta falha <em>não</em> significa ausência de documentos.';
    }
  }

  function sincronizarEstadoConflito() {
    const alerta = document.getElementById('cef-alerta-desatualizada');
    const btnAtualizar = document.getElementById('cef-atualizar-preview');
    const btnConfirmar = document.getElementById('cef-confirmar');
    if (!alerta || !btnAtualizar || !btnConfirmar) return;
    if (aguardandoNovoPreview) {
      alerta.classList.remove('d-none');
      btnAtualizar.classList.remove('d-none');
      btnConfirmar.disabled = true;
    } else {
      alerta.classList.add('d-none');
      btnAtualizar.classList.add('d-none');
      btnConfirmar.disabled = false;
    }
  }

  function rotuloProdutoLinha(l) {
    const nome = l.produto_nome || ('Produto #' + l.produto_id);
    const codigo = l.produto_codigo ? (' · ' + l.produto_codigo) : '';
    const un = l.unidade_base ? (' <span class="small text-muted">(' + escapeHtml(l.unidade_base) + ')</span>') : '';
    return escapeHtml(nome) + (codigo ? '<span class="small text-muted">' + escapeHtml(codigo) + '</span>' : '') + un;
  }

  function fmtBase(valor, unidade, omitido) {
    if (omitido) return '<span class="text-muted">não contado</span>';
    if (valor == null) return '—';
    return escapeHtml(String(valor)) + (unidade ? ' <span class="small text-muted">' + escapeHtml(unidade) + '</span>' : '');
  }

  function pintarTabela() {
    const tb = document.getElementById('cef-tbody');
    if (!tb) return;
    tb.innerHTML = linhas.map(function (l, idx) {
      const un = l.unidade_base || '';
      return `<tr>
        <td>${rotuloProdutoLinha(l)}</td>
        <td>${fmtBase(l.saldo_fiscal_esperado, un, false)}</td>
        <td>${fmtBase(l.saldo_nao_fiscal_esperado, un, false)}</td>
        <td>${fmtBase(l.quantidade_fiscal_contada, un, false)}</td>
        <td>${fmtBase(l.quantidade_nao_fiscal_contada, un, !!l.omitir_nao_fiscal)}</td>
        <td>${fmtBase(l.diferenca_fiscal, un, false)}</td>
        <td>${fmtBase(l.diferenca_nao_fiscal, un, l.omitir_nao_fiscal || l.diferenca_nao_fiscal == null)}</td>
        <td><button type="button" class="btn btn-sm btn-outline-danger" data-cef-rm="${idx}">Remover</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="text-muted">Nenhum produto na contagem.</td></tr>';
    tb.querySelectorAll('[data-cef-rm]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        linhas.splice(Number(btn.getAttribute('data-cef-rm')), 1);
        pintarTabela();
      });
    });
  }

  async function previewLinha() {
    const box = document.getElementById('cef-preview-box');
    const convBox = document.getElementById('cef-conv-box');
    if (modoFiscalMudou()) {
      const msg = 'O estado F12 mudou desde a abertura desta tela. Clique em "Atualizar contexto F12" e refaça a pré-visualização.';
      if (box) box.textContent = msg;
      notify(msg, 'warning');
      return null;
    }
    if (!produtoSelecionado || !Number.isInteger(produtoSelecionado.id) || produtoSelecionado.id <= 0) {
      const msg = 'Selecione um produto na pesquisa antes de calcular as diferenças.';
      if (box) box.textContent = msg;
      notify(msg, 'warning');
      return null;
    }
    const produtoId = produtoSelecionado.id;
    const qf = document.getElementById('cef-qf').value;
    const qnfEl = document.getElementById('cef-qnf');
    const f12On = !!modoFiscalSessao;
    const body = {
      produto_id: produtoId,
      quantidade_fiscal_informada: qf,
      unidade_informada: produtoSelecionado.unidade_comercial || produtoSelecionado.unidade,
      apresentacao_id: produtoSelecionado.apresentacao_id || undefined,
      modo_fiscal: f12On ? '1' : '0',
      omitir_nao_fiscal: f12On
    };
    if (!f12On) {
      body.quantidade_nao_fiscal_informada = qnfEl ? qnfEl.value : 0;
    }
    try {
      const res = await fetch('/api/estoque/contagem-fisica/preview', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 403) {
        throw new Error(data.error || 'Acesso não autorizado.');
      }
      if (!res.ok) throw new Error(data.error || 'Falha no preview');
      data.produto_nome = produtoSelecionado.nome;
      data.produto_codigo = produtoSelecionado.codigo;
      if (convBox) {
        const msgs = [];
        if (data.mensagem_conversao_fiscal) msgs.push('Fiscal: ' + data.mensagem_conversao_fiscal);
        if (data.mensagem_conversao_nao_fiscal) msgs.push('Não fiscal: ' + data.mensagem_conversao_nao_fiscal);
        if (data.omitir_nao_fiscal) msgs.push('Não fiscal: não contado (F12 ON — saldo preservado).');
        convBox.innerHTML = msgs.length
          ? '<strong>Conversão:</strong> ' + msgs.map(escapeHtml).join(' · ')
          : '';
      }
      const un = data.unidade_base ? (' ' + data.unidade_base) : '';
      box.innerHTML = `Produto: <strong>${escapeHtml(produtoSelecionado.nome)}</strong> · `
        + `Saldo esperado F/NF: <strong>${data.saldo_fiscal_esperado}</strong> /
        <strong>${data.saldo_nao_fiscal_esperado}</strong>${escapeHtml(un)} · Contado base: <strong>${data.quantidade_fiscal_contada}</strong> /
        <strong>${data.omitir_nao_fiscal ? '—' : data.quantidade_nao_fiscal_contada}</strong> · Diferença: <strong>${data.diferenca_fiscal}</strong> /
        <strong>${data.omitir_nao_fiscal ? '—' : data.diferenca_nao_fiscal}</strong>`;
      return data;
    } catch (err) {
      box.textContent = err.message;
      if (convBox) convBox.textContent = '';
      notify(err.message, 'danger');
      return null;
    }
  }

  async function adicionarLinha() {
    const data = await previewLinha();
    if (!data) return;
    if (
      data.saldo_fiscal_esperado == null
      || data.saldo_nao_fiscal_esperado == null
    ) {
      notify('Preview sem snapshot de saldo. Atualize e tente novamente.', 'danger');
      return;
    }
    if (linhas.some(function (l) { return Number(l.produto_id) === Number(data.produto_id); })) {
      notify('Produto já está na lista.', 'warning');
      return;
    }
    linhas.push(snapshotDaLinha(data, produtoSelecionado || {}));
    pintarTabela();
  }

  /**
   * Após CONTAGEM_DESATUALIZADA: novo preview por item, preservando quantidades contadas.
   * Não confirma automaticamente.
   */
  async function atualizarPreviewsDaLista() {
    if (!linhas.length) return;
    if (modoFiscalMudou()) {
      notify('O estado F12 mudou. Atualize o contexto F12 antes de recalcular.', 'warning');
      return;
    }
    const atualizadas = [];
    const f12On = !!modoFiscalSessao;
    for (let i = 0; i < linhas.length; i += 1) {
      const atual = linhas[i];
      try {
        const body = {
          produto_id: atual.produto_id,
          quantidade_fiscal_informada: atual.quantidade_fiscal_informada != null
            ? atual.quantidade_fiscal_informada
            : atual.quantidade_fiscal_contada,
          unidade_informada: atual.unidade_informada || undefined,
          modo_fiscal: f12On ? '1' : '0',
          omitir_nao_fiscal: f12On || !!atual.omitir_nao_fiscal
        };
        if (!body.omitir_nao_fiscal) {
          body.quantidade_nao_fiscal_informada = atual.quantidade_nao_fiscal_informada != null
            ? atual.quantidade_nao_fiscal_informada
            : atual.quantidade_nao_fiscal_contada;
        }
        const res = await fetch('/api/estoque/contagem-fisica/preview', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ('Falha no preview do produto ' + atual.produto_id));
        atualizadas.push(snapshotDaLinha(data, {
          nome: atual.produto_nome,
          codigo: atual.produto_codigo,
          unidade_base: atual.unidade_base
        }));
      } catch (err) {
        notify(err.message, 'danger');
        return;
      }
    }
    linhas = atualizadas;
    aguardandoNovoPreview = false;
    const alerta = document.getElementById('cef-alerta-desatualizada');
    if (alerta) {
      alerta.textContent = '';
      alerta.classList.add('d-none');
    }
    pintarTabela();
    sincronizarEstadoConflito();
    notify('Pré-visualização atualizada. Revise as diferenças e confirme novamente.', 'info');
  }

  function marcarDesatualizada(data) {
    aguardandoNovoPreview = true;
    const alerta = document.getElementById('cef-alerta-desatualizada');
    if (alerta) {
      alerta.classList.remove('d-none');
      alerta.innerHTML = '<strong>Estoque alterado desde a pré-visualização.</strong> '
        + escapeHtml(data.error || 'A observação está desatualizada.')
        + ' Atualize a pré-visualização, revise as diferenças e confirme novamente. '
        + 'A confirmação automática com dados antigos foi bloqueada.';
    }
    sincronizarEstadoConflito();
  }

  async function confirmar() {
    if (confirmacaoEmAndamento) return;
    if (modoFiscalMudou()) {
      notify('O estado F12 mudou. Atualize o contexto e a pré-visualização antes de confirmar.', 'warning');
      aguardandoNovoPreview = true;
      sincronizarEstadoConflito();
      return;
    }
    if (aguardandoNovoPreview) {
      notify('Atualize a pré-visualização antes de confirmar.', 'warning');
      return;
    }
    if (!linhas.length) {
      notify('Inclua ao menos um produto.', 'warning');
      return;
    }
    for (let i = 0; i < linhas.length; i += 1) {
      const l = linhas[i];
      if (l.saldo_fiscal_esperado == null || l.saldo_nao_fiscal_esperado == null) {
        notify('Há itens sem snapshot. Remova-os e inclua novamente via preview.', 'danger');
        return;
      }
    }
    const obs = (document.getElementById('cef-obs').value || '').trim();
    const chave = 'contagem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const f12On = !!modoFiscalSessao;
    confirmacaoEmAndamento = true;
    try {
      const res = await fetch('/api/estoque/contagem-fisica', {
        method: 'POST',
        headers: Object.assign(authHeaders(), { 'Idempotency-Key': chave }),
        body: JSON.stringify({
          observacao: obs || undefined,
          chave_idempotencia: chave,
          modo_fiscal: f12On ? '1' : '0',
          omitir_nao_fiscal: f12On,
          itens: linhas.map(itemConfirmacaoApi)
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.status === 409 && data.code === 'CONTAGEM_DESATUALIZADA') {
        // Não gera nova chave nem reenvia automaticamente os mesmos dados.
        marcarDesatualizada(data);
        notify(data.error || 'Contagem desatualizada. Atualize o preview.', 'warning');
        return;
      }
      if (res.status === 403) {
        throw new Error(data.error || 'Acesso não autorizado.');
      }
      if (!res.ok) throw new Error(data.error || 'Falha ao confirmar contagem');
      const box = document.getElementById('cef-resultado');
      box.innerHTML = `<div class="alert alert-success">Contagem #${escapeHtml(data.id)} registrada em ${escapeHtml(data.criado_em || '')}
        por ${escapeHtml(data.usuario_nome || data.usuario_id || '—')}.</div>
        <pre class="small bg-light p-2">${escapeHtml(JSON.stringify(data.itens, null, 2))}</pre>`;
      linhas = [];
      aguardandoNovoPreview = false;
      definirProdutoSelecionado(null);
      const busca = document.getElementById('cef-produto-busca');
      if (busca) busca.value = '';
      pintarTabela();
      sincronizarEstadoConflito();
      notify('Contagem confirmada.', 'success');
      carregarStatusPeriodicidade();
      carregarHistorico();
    } catch (err) {
      notify(err.message, 'danger');
    } finally {
      confirmacaoEmAndamento = false;
    }
  }

  function loadContagemEstoque() {
    linhas = [];
    confirmacaoEmAndamento = false;
    aguardandoNovoPreview = false;
    produtoSelecionado = null;
    sincronizarModoFiscalSessao();
    render();
  }

  root.loadContagemEstoque = loadContagemEstoque;
  // Expostos para testes de contrato do fluxo oficial.
  root.__cdsContagemEstoqueTest = {
    snapshotDaLinha: snapshotDaLinha,
    itemConfirmacao: itemConfirmacao,
    itemConfirmacaoApi: itemConfirmacaoApi
  };
})(typeof window !== 'undefined' ? window : globalThis);
