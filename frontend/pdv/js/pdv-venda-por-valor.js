/**
 * CDS-PDV-VALOR-PASTEIS-02 — Venda por valor no PDV Express.
 * Reutiliza POST /api/pedidos/venda-por-valor-pasteis e o handoff oficial do PDV.
 * Não altera motor de composição nem motor de vendas.
 */
(function (global) {
  'use strict';

  const ENDPOINT = '/pedidos/venda-por-valor-pasteis';
  const MODAL_ENTRADA_ID = 'pdvVendaPorValorModal';
  const MODAL_CONF_ID = 'pdvVendaPorValorConfModal';

  let emProcessamento = false;
  let ultimaComposicao = null;
  let produtoPastelIdSelecionado = null;

  function apiBase() {
    if (typeof API_URL === 'string' && API_URL) return API_URL.replace(/\/$/, '');
    return '/api';
  }

  function headersJson() {
    if (global.CdsEmpresaContexto && typeof CdsEmpresaContexto.headersJson === 'function') {
      return CdsEmpresaContexto.headersJson();
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token') || ''}`
    };
  }

  /** Aceita padrão BR (10,50 / 1.234,56) e ponto decimal. */
  function parseValorMonetarioBr(raw) {
    const s = String(raw == null ? '' : raw).trim().replace(/\s/g, '');
    if (!s) return NaN;
    if (s.includes(',') && s.includes('.')) {
      return Number(s.replace(/\./g, '').replace(',', '.'));
    }
    if (s.includes(',')) {
      return Number(s.replace(',', '.'));
    }
    return Number(s);
  }

  function parseQuantidadeInteira(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d+$/.test(s)) return NaN;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n <= 0) return NaN;
    return n;
  }

  function validarEntrada(valorRaw, qtdRaw) {
    const valor = parseValorMonetarioBr(valorRaw);
    const quantidade = parseQuantidadeInteira(qtdRaw);
    if (!Number.isFinite(valor) || valor <= 0) {
      return {
        ok: false,
        message: 'Informe um valor total positivo (ex.: 50,00).'
      };
    }
    const centavos = Math.round(valor * 100);
    if (!Number.isSafeInteger(centavos) || centavos <= 0) {
      return { ok: false, message: 'Valor total inválido.' };
    }
    if (Math.abs(valor * 100 - centavos) > 1e-6) {
      return {
        ok: false,
        message: 'O valor total deve ter no máximo duas casas decimais.'
      };
    }
    if (!Number.isSafeInteger(quantidade) || quantidade <= 0) {
      return {
        ok: false,
        message: 'A quantidade de pastéis deve ser um número inteiro positivo.'
      };
    }
    return { ok: true, valor, quantidade };
  }

  function formatarMoeda(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'R$ —';
    return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function novaChaveIdempotencia() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `vv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function notificar(msg, tipo) {
    if (typeof showNotification === 'function') {
      showNotification(msg, tipo || 'info');
      return;
    }
    // Fallback mínimo
    console.warn('[VendaPorValor]', tipo, msg);
  }

  function mostrarModal(el) {
    if (!el) return;
    if (global.bootstrap && bootstrap.Modal) {
      bootstrap.Modal.getOrCreateInstance(el).show();
    } else if (global.$) {
      $(el).modal('show');
    }
  }

  function ocultarModal(el) {
    if (!el) return;
    if (global.bootstrap && bootstrap.Modal) {
      const inst = bootstrap.Modal.getInstance(el);
      if (inst) inst.hide();
      else bootstrap.Modal.getOrCreateInstance(el).hide();
    } else if (global.$) {
      $(el).modal('hide');
    }
  }

  function garantirContainer() {
    let c = document.getElementById('modal-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'modal-container';
      document.body.appendChild(c);
    }
    return c;
  }

  function montarHtmlEntrada() {
    return `
      <div class="modal fade" id="${MODAL_ENTRADA_ID}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Venda por valor</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
            </div>
            <div class="modal-body">
              <p class="text-muted small mb-3">
                Informe o valor total do pedido e a quantidade de pastéis.
                A composição usa o motor oficial já existente.
              </p>
              <div id="pdvVvErro" class="alert alert-warning py-2 d-none" role="alert"></div>
              <div class="mb-3">
                <label class="form-label" for="pdvVvValor">Valor total do pedido (R$)</label>
                <input type="text" class="form-control" id="pdvVvValor" inputmode="decimal"
                  placeholder="Ex.: 50,00" autocomplete="off">
              </div>
              <div class="mb-3">
                <label class="form-label" for="pdvVvQtd">Quantidade de pastéis</label>
                <input type="number" class="form-control" id="pdvVvQtd" min="1" step="1" value="1" inputmode="numeric">
              </div>
              <div class="mb-0 d-none" id="pdvVvPastelBox">
                <label class="form-label" for="pdvVvPastelId">Pastel (selecione quando houver mais de um)</label>
                <select class="form-select" id="pdvVvPastelId"></select>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" id="pdvVvCancelar">Cancelar</button>
              <button type="button" class="btn btn-success" id="pdvVvContinuar">Continuar</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function montarHtmlConferencia(data) {
    const itens = Array.isArray(data.itens) ? data.itens : [];
    const linhas = itens.map((it) => {
      const nome = it.nome || it.produto_nome || `Produto #${it.produto_id}`;
      const qtd = Number(it.quantidade);
      const sub = formatarMoeda(it.subtotal);
      return `<tr>
        <td>${escapeHtml(nome)}</td>
        <td class="text-end">${Number.isFinite(qtd) ? qtd : '—'}</td>
        <td class="text-end">${sub}</td>
      </tr>`;
    }).join('');
    const modo = data.modo_composicao ? ` · modo ${escapeHtml(String(data.modo_composicao))}` : '';
    return `
      <div class="modal fade" id="${MODAL_CONF_ID}" tabindex="-1" aria-hidden="true" data-bs-backdrop="static">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Conferência — Pedido #${Number(data.pedido_id) || ''}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar" id="pdvVvConfFechar"></button>
            </div>
            <div class="modal-body">
              <p class="small text-muted mb-2">
                Pastel: <strong>${escapeHtml(data.produto_pastel_nome || String(data.produto_pastel_id || ''))}</strong>
                · Qtd informada: <strong>${Number(data.quantidade_pasteis) || '—'}</strong>
                · Valor informado: <strong>${formatarMoeda(data.valor_total_informado)}</strong>${modo}
              </p>
              <div class="table-responsive">
                <table class="table table-sm table-striped mb-2">
                  <thead><tr><th>Item</th><th class="text-end">Qtd</th><th class="text-end">Subtotal</th></tr></thead>
                  <tbody>${linhas || '<tr><td colspan="3" class="text-muted">Sem itens</td></tr>'}</tbody>
                </table>
              </div>
              <div class="d-flex justify-content-between align-items-center">
                <span>Desconto composição: <strong>${formatarMoeda(data.desconto || 0)}</strong></span>
                <span class="fs-5">Total: <strong>${formatarMoeda(data.total)}</strong></span>
              </div>
              <p class="small text-muted mt-2 mb-0">
                Confirmar carrega os itens no PDV para pagamento. Cancelar não finaliza a venda.
              </p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" id="pdvVvConfCancelar">Cancelar</button>
              <button type="button" class="btn btn-primary" id="pdvVvConfirmar">Confirmar e carregar no PDV</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function exibirErroEntrada(msg) {
    const box = document.getElementById('pdvVvErro');
    if (!box) {
      notificar(msg, 'warning');
      return;
    }
    box.textContent = msg;
    box.classList.remove('d-none');
  }

  function limparErroEntrada() {
    const box = document.getElementById('pdvVvErro');
    if (!box) return;
    box.textContent = '';
    box.classList.add('d-none');
  }

  function setProcessando(ativo) {
    emProcessamento = !!ativo;
    const btn = document.getElementById('pdvVvContinuar');
    if (btn) {
      btn.disabled = emProcessamento;
      btn.textContent = emProcessamento ? 'Processando…' : 'Continuar';
    }
  }

  function abrirModalEntrada() {
    if (typeof global.carrinho !== 'undefined' && Array.isArray(global.carrinho) && global.carrinho.length) {
      notificar('Limpe o carrinho antes de iniciar uma venda por valor.', 'warning');
      return;
    }
    if (global.pdvPedidoHandoff) {
      notificar('Já existe um pedido em preparação no PDV.', 'warning');
      return;
    }

    produtoPastelIdSelecionado = null;
    ultimaComposicao = null;
    const container = garantirContainer();
    container.innerHTML = montarHtmlEntrada();
    const el = document.getElementById(MODAL_ENTRADA_ID);
    const btnCont = document.getElementById('pdvVvContinuar');
    if (btnCont) {
      btnCont.addEventListener('click', onContinuar);
    }
    const valorInput = document.getElementById('pdvVvValor');
    const qtdInput = document.getElementById('pdvVvQtd');
    if (valorInput) {
      valorInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onContinuar();
        }
      });
    }
    if (qtdInput) {
      qtdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onContinuar();
        }
      });
    }
    mostrarModal(el);
    setTimeout(() => {
      if (valorInput) valorInput.focus();
    }, 200);
  }

  function aplicarCandidatosPastel(candidatos) {
    const box = document.getElementById('pdvVvPastelBox');
    const sel = document.getElementById('pdvVvPastelId');
    if (!box || !sel || !Array.isArray(candidatos) || !candidatos.length) return;
    sel.innerHTML = candidatos.map((c) =>
      `<option value="${Number(c.id)}">${escapeHtml(c.nome || `Pastel #${c.id}`)}</option>`
    ).join('');
    box.classList.remove('d-none');
    produtoPastelIdSelecionado = Number(candidatos[0].id);
    sel.onchange = () => {
      produtoPastelIdSelecionado = Number(sel.value) || null;
    };
  }

  async function onContinuar() {
    if (emProcessamento) return;
    limparErroEntrada();

    const valorRaw = (document.getElementById('pdvVvValor') || {}).value;
    const qtdRaw = (document.getElementById('pdvVvQtd') || {}).value;
    const valid = validarEntrada(valorRaw, qtdRaw);
    if (!valid.ok) {
      exibirErroEntrada(valid.message);
      return;
    }

    const pastelBox = document.getElementById('pdvVvPastelBox');
    const pastelSel = document.getElementById('pdvVvPastelId');
    if (pastelBox && pastelSel && !pastelBox.classList.contains('d-none')) {
      produtoPastelIdSelecionado = Number(pastelSel.value) || null;
    }

    const corpo = {
      valor_total: valid.valor,
      quantidade_pasteis: valid.quantidade
    };
    if (produtoPastelIdSelecionado) {
      corpo.produto_pastel_id = produtoPastelIdSelecionado;
    }

    setProcessando(true);
    try {
      const resp = await fetch(`${apiBase()}${ENDPOINT}`, {
        method: 'POST',
        headers: Object.assign({}, headersJson(), {
          'Idempotency-Key': novaChaveIdempotencia()
        }),
        body: JSON.stringify(corpo)
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const code = data.code || data.codigo || '';
        if (code === 'PASTEL_CADASTRO_AMBIGUO' && data.detalhes && data.detalhes.candidatos) {
          aplicarCandidatosPastel(data.detalhes.candidatos);
          exibirErroEntrada(
            data.mensagem || data.error || 'Há mais de um pastel elegível. Selecione o produto e continue.'
          );
          return;
        }
        exibirErroEntrada(data.mensagem || data.error || `Falha ao compor (${resp.status}).`);
        return;
      }

      if (data.venda_concluida) {
        exibirErroEntrada(
          `Pedido #${data.pedido_id} já possui venda concluída (#${data.venda_id}).`
        );
        return;
      }

      ultimaComposicao = data;
      ocultarModal(document.getElementById(MODAL_ENTRADA_ID));
      abrirModalConferencia(data);
    } catch (err) {
      exibirErroEntrada(err.message || 'Falha de rede ao iniciar venda por valor.');
    } finally {
      setProcessando(false);
    }
  }

  function abrirModalConferencia(data) {
    const container = garantirContainer();
    container.innerHTML = montarHtmlConferencia(data);
    const el = document.getElementById(MODAL_CONF_ID);
    document.getElementById('pdvVvConfirmar')?.addEventListener('click', onConfirmarHandoff);
    document.getElementById('pdvVvConfCancelar')?.addEventListener('click', onCancelarConferencia);
    document.getElementById('pdvVvConfFechar')?.addEventListener('click', onCancelarConferencia);
    mostrarModal(el);
  }

  function onCancelarConferencia() {
    ocultarModal(document.getElementById(MODAL_CONF_ID));
    ultimaComposicao = null;
    notificar('Venda por valor cancelada. O pedido não foi carregado no caixa.', 'info');
  }

  function onConfirmarHandoff() {
    const data = ultimaComposicao;
    if (!data || !Array.isArray(data.itens) || !data.itens.length) {
      notificar('Composição inválida para carregar no PDV.', 'danger');
      return;
    }
    // Não altera empresa_id — handoff preserva o contrato do servidor.
    try {
      sessionStorage.setItem('pdvPedidoHandoff', JSON.stringify(data));
    } catch (err) {
      notificar('Não foi possível preparar o handoff do pedido.', 'danger');
      return;
    }
    ocultarModal(document.getElementById(MODAL_CONF_ID));
    if (typeof global.aplicarHandoffPedidoPdv === 'function') {
      global.aplicarHandoffPedidoPdv();
    } else {
      notificar(
        `Pedido #${data.pedido_id} preparado. Recarregue o PDV se os itens não aparecerem.`,
        'warning'
      );
    }
    ultimaComposicao = null;
  }

  function ligarAbertura(el) {
    if (!el || el.dataset.vvBound === '1') return;
    el.dataset.vvBound = '1';
    const abrir = (e) => {
      if (e) e.preventDefault();
      abrirModalEntrada();
    };
    el.addEventListener('click', abrir);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') abrir(e);
    });
  }

  function initUi() {
    ligarAbertura(document.getElementById('btnVendaPorValorPdv'));
    ligarAbertura(document.getElementById('btnVendaPorValorPdvTopo'));
    ligarAbertura(document.getElementById('atalhoVendaPorValorPdv'));
  }

  global.PdvVendaPorValor = {
    initUi,
    abrirModalEntrada,
    parseValorMonetarioBr,
    parseQuantidadeInteira,
    validarEntrada,
    ENDPOINT,
    MODAL_ENTRADA_ID,
    MODAL_CONF_ID
  };
})(typeof window !== 'undefined' ? window : globalThis);
