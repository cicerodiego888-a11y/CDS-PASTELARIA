/**
 * RC8.5.1 / FIN-UX-05 — Cadastro de Condições de Pagamento (aba Financeiro)
 * Preserva contratos: GET/POST/PUT/DELETE /api/condicoes-pagamento
 */
function __headersFin(extra) {
  if (typeof headersFinanceiro === 'function') return headersFinanceiro(extra || {});
  if (typeof CdsEmpresaContexto !== 'undefined' && typeof CdsEmpresaContexto.headersAuth === 'function') {
    return CdsEmpresaContexto.headersAuth(extra || {});
  }
  return Object.assign({
    Accept: 'application/json',
    Authorization: 'Bearer ' + (localStorage.getItem('token') || '')
  }, extra || {});
}

(function (global) {
  'use strict';

  let listaCondicoesCache = [];

  const TIPOS_LABEL = Object.freeze({
    avista: 'À vista',
    prazo: 'À prazo',
    entrada: 'Entrada + parcelas'
  });

  function apiUrl() {
    return (typeof API_URL !== 'undefined' ? API_URL : '/api') + '/condicoes-pagamento';
  }

  function formatarDias(dias) {
    if (!Array.isArray(dias) || !dias.length) return '—';
    return dias.join('/');
  }

  function rotuloTipo(tipo) {
    const key = String(tipo || '').toLowerCase();
    return TIPOS_LABEL[key] || (tipo ? String(tipo) : '—');
  }

  function escapeHtml(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setEstado(tipo, mensagem) {
    const el = document.getElementById('condicoesPagamentoEstado');
    const tabelaWrap = document.getElementById('condicoesPagamentoTabelaWrap');
    if (!el) return;
    el.hidden = false;
    el.className = 'financeiro-condicoes-estado';
    el.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
    if (tipo === 'carregando') {
      el.classList.add('financeiro-condicoes-estado--carregando');
      el.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Carregando condições…</span>';
      if (tabelaWrap) tabelaWrap.hidden = true;
      return;
    }
    if (tipo === 'vazio') {
      el.classList.add('financeiro-condicoes-estado--vazio');
      el.innerHTML =
        '<i class="fas fa-file-invoice" aria-hidden="true"></i>' +
        '<div><strong>Nenhuma condição cadastrada</strong>' +
        '<p>Cadastre modelos reutilizáveis (ex.: 30/60/90) para o lançamento de compras.</p></div>';
      if (tabelaWrap) tabelaWrap.hidden = true;
      return;
    }
    if (tipo === 'erro') {
      el.classList.add('financeiro-condicoes-estado--erro');
      el.innerHTML =
        '<i class="fas fa-exclamation-circle" aria-hidden="true"></i>' +
        '<div><strong>Não foi possível carregar</strong><p></p></div>';
      const p = el.querySelector('p');
      if (p) p.textContent = String(mensagem || 'Erro ao listar condições.');
      if (tabelaWrap) tabelaWrap.hidden = true;
      return;
    }
    el.hidden = true;
    el.innerHTML = '';
    if (tabelaWrap) tabelaWrap.hidden = false;
  }

  function renderCondicoesPagamento() {
    const conteudo = document.getElementById('financeiroConteudo');
    if (!conteudo) return;

    conteudo.innerHTML = `
      <section class="financeiro-condicoes" aria-labelledby="financeiroCondicoesTitulo">
        <header class="financeiro-condicoes-cabecalho">
          <div>
            <span class="financeiro-condicoes-eyebrow">CADASTROS · COMPRAS</span>
            <h2 id="financeiroCondicoesTitulo">Condições de Pagamento</h2>
            <p>Catálogo compartilhado entre empresas para o lançamento de compras (ex.: 30/60/90).</p>
          </div>
          <div class="financeiro-condicoes-acoes">
            <button type="button" class="btn btn-primary" id="btnNovaCondicaoPagamento">
              <i class="fas fa-plus" aria-hidden="true"></i> Nova condição
            </button>
          </div>
        </header>

        <div id="condicoesPagamentoEstado" class="financeiro-condicoes-estado" role="status" aria-live="polite" hidden></div>

        <div class="financeiro-condicoes-tabela-wrap" id="condicoesPagamentoTabelaWrap" hidden>
          <div class="table-responsive">
            <table class="financeiro-condicoes-tabela" id="tabelaCondicoesPagamento">
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Parcelas (dias)</th>
                  <th scope="col">Entrada</th>
                  <th scope="col">Status</th>
                  <th scope="col" class="financeiro-condicoes-col-acoes">Ações</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </div>
      </section>
    `;

    document.getElementById('btnNovaCondicaoPagamento')?.addEventListener('click', () => abrirModalCondicao());
    carregarListaCondicoes();
  }

  function renderLinhas(lista) {
    const tbody = document.querySelector('#tabelaCondicoesPagamento tbody');
    if (!tbody) return;

    tbody.innerHTML = lista.map((c) => {
      const sistemaBadge = c.sistema
        ? ' <span class="financeiro-condicoes-badge financeiro-condicoes-badge--sistema">sistema</span>'
        : '';
      const statusBadge = c.ativo
        ? '<span class="financeiro-condicoes-badge financeiro-condicoes-badge--ativa">Ativa</span>'
        : '<span class="financeiro-condicoes-badge financeiro-condicoes-badge--inativa">Inativa</span>';
      const btnExcluir = c.sistema
        ? ''
        : `<button type="button" class="btn btn-sm btn-outline-danger" data-del="${c.id}" title="Excluir" aria-label="Excluir condição">
             <i class="fas fa-trash" aria-hidden="true"></i>
           </button>`;
      return `
        <tr>
          <td>
            <span class="financeiro-condicoes-nome">${escapeHtml(c.nome)}</span>${sistemaBadge}
          </td>
          <td><span class="financeiro-condicoes-tipo">${escapeHtml(rotuloTipo(c.tipo))}</span></td>
          <td><span class="financeiro-condicoes-dias">${escapeHtml(formatarDias(c.dias_parcelas))}</span></td>
          <td>${c.tem_entrada ? 'Sim' : 'Não'}</td>
          <td>${statusBadge}</td>
          <td class="financeiro-condicoes-col-acoes">
            <div class="financeiro-condicoes-acoes-linha">
              <button type="button" class="btn btn-sm btn-outline-primary" data-edit="${c.id}" title="Editar" aria-label="Editar condição">
                <i class="fas fa-edit" aria-hidden="true"></i>
              </button>
              ${btnExcluir}
            </div>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-edit'));
        const row = listaCondicoesCache.find((x) => Number(x.id) === id);
        abrirModalCondicao(row);
      });
    });
    tbody.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.getAttribute('data-del'));
        if (!window.confirm('Excluir esta condição?')) return;
        try {
          const r = await fetch(`${apiUrl()}/${id}`, {
            method: 'DELETE',
            headers: __headersFin()
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            if (typeof showNotification === 'function') {
              showNotification(body.error || 'Erro ao excluir', 'danger');
            }
            return;
          }
          carregarListaCondicoes();
        } catch (err) {
          if (typeof showNotification === 'function') {
            showNotification(err.message || 'Erro ao excluir', 'danger');
          }
        }
      });
    });
  }

  async function carregarListaCondicoes() {
    setEstado('carregando');
    try {
      const resp = await fetch(apiUrl() + '?todas=1', {
        headers: __headersFin()
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Erro ao listar condições');
      if (!Array.isArray(data)) {
        throw new Error('Resposta inválida do servidor ao listar condições.');
      }
      listaCondicoesCache = data;
      if (!listaCondicoesCache.length) {
        setEstado('vazio');
        return;
      }
      setEstado('ok');
      renderLinhas(listaCondicoesCache);
    } catch (err) {
      listaCondicoesCache = [];
      setEstado('erro', err.message || 'Erro ao listar condições');
    }
  }

  function abrirModalCondicao(row) {
    $('#modalCondicaoPagamentoCds').remove();
    const isEdit = !!(row && row.id);
    const diasStr = Array.isArray(row?.dias_parcelas) ? row.dias_parcelas.join('/') : '';
    const html = `
      <div class="modal fade" id="modalCondicaoPagamentoCds" tabindex="-1" aria-labelledby="modalCondicaoPagamentoTitulo">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content financeiro-condicoes-modal">
            <div class="modal-header">
              <div>
                <span class="financeiro-condicoes-eyebrow">${isEdit ? 'EDIÇÃO' : 'NOVA CONDIÇÃO'}</span>
                <h5 class="modal-title" id="modalCondicaoPagamentoTitulo">${isEdit ? 'Editar' : 'Nova'} condição de pagamento</h5>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
            </div>
            <div class="modal-body">
              <input type="hidden" id="condPagId" value="${isEdit ? row.id : ''}">
              <div class="mb-3">
                <label class="form-label" for="condPagNome">Nome *</label>
                <input type="text" class="form-control" id="condPagNome" value="${escapeHtml(row?.nome || '')}" placeholder="Ex.: 30/60/90" autocomplete="off">
              </div>
              <div class="mb-3">
                <label class="form-label" for="condPagTipo">Tipo</label>
                <select class="form-select" id="condPagTipo">
                  <option value="avista" ${row?.tipo === 'avista' ? 'selected' : ''}>À vista</option>
                  <option value="prazo" ${!row || row?.tipo === 'prazo' ? 'selected' : ''}>À prazo</option>
                  <option value="entrada" ${row?.tipo === 'entrada' ? 'selected' : ''}>Entrada + parcelas</option>
                </select>
              </div>
              <div class="mb-3">
                <label class="form-label" for="condPagDias">Dias de cada parcela</label>
                <input type="text" class="form-control" id="condPagDias" value="${escapeHtml(diasStr)}" placeholder="Ex.: 30/60/90" autocomplete="off">
                <small class="text-muted">Separe por barra. Contados a partir da data-base da compra.</small>
              </div>
              <div class="financeiro-condicoes-checks">
                <div class="form-check">
                  <input class="form-check-input" type="checkbox" id="condPagEntrada" ${row?.tem_entrada ? 'checked' : ''}>
                  <label class="form-check-label" for="condPagEntrada">Possui entrada</label>
                </div>
                <div class="form-check">
                  <input class="form-check-input" type="checkbox" id="condPagAtivo" ${row?.ativo !== 0 ? 'checked' : ''}>
                  <label class="form-check-label" for="condPagAtivo">Ativa</label>
                </div>
              </div>
              <div id="condPagErroForm" class="financeiro-condicoes-form-erro" role="alert" hidden></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-primary" id="btnSalvarCondPag">Salvar</button>
            </div>
          </div>
        </div>
      </div>`;
    $('body').append(html);
    const el = document.getElementById('modalCondicaoPagamentoCds');
    const modal = bootstrap.Modal.getOrCreateInstance(el);
    const erroForm = document.getElementById('condPagErroForm');

    function mostrarErroForm(msg) {
      if (!erroForm) return;
      erroForm.hidden = false;
      erroForm.textContent = String(msg || '');
    }

    $('#btnSalvarCondPag').on('click', async () => {
      if (erroForm) {
        erroForm.hidden = true;
        erroForm.textContent = '';
      }
      const nome = String($('#condPagNome').val() || '').trim();
      if (!nome) {
        mostrarErroForm('Informe o nome da condição.');
        $('#condPagNome').trigger('focus');
        return;
      }
      const diasRaw = String($('#condPagDias').val() || '').trim();
      const dias = diasRaw
        ? diasRaw.split(/[\/|,;\s]+/).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n))
        : [];
      const payload = {
        id: $('#condPagId').val() || undefined,
        nome,
        tipo: $('#condPagTipo').val(),
        dias_parcelas: dias,
        tem_entrada: $('#condPagEntrada').is(':checked') ? 1 : 0,
        ativo: $('#condPagAtivo').is(':checked') ? 1 : 0
      };
      const method = payload.id ? 'PUT' : 'POST';
      const url = payload.id ? `${apiUrl()}/${payload.id}` : apiUrl();
      const btn = document.getElementById('btnSalvarCondPag');
      if (btn) btn.disabled = true;
      try {
        const r = await fetch(url, {
          method,
          headers: __headersFin({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload)
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
          mostrarErroForm(body.error || 'Erro ao salvar');
          if (typeof showNotification === 'function') showNotification(body.error || 'Erro ao salvar', 'danger');
          return;
        }
        modal.hide();
        carregarListaCondicoes();
        if (typeof showNotification === 'function') showNotification('Condição salva.', 'success');
      } catch (err) {
        mostrarErroForm(err.message || 'Erro ao salvar');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    $(el).on('hidden.bs.modal', () => $(el).remove());
    modal.show();
  }

  /** Lista ativa para select de compras */
  async function listarCondicoesAtivasParaCompra() {
    const resp = await fetch(apiUrl(), {
      headers: __headersFin()
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Erro ao carregar condições');
    return Array.isArray(data) ? data : [];
  }

  global.renderCondicoesPagamento = renderCondicoesPagamento;
  global.listarCondicoesAtivasParaCompra = listarCondicoesAtivasParaCompra;
})(typeof window !== 'undefined' ? window : global);
