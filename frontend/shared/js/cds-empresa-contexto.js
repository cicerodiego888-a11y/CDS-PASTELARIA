/**
 * Contexto empresarial da sessão (Fase 2 / 03.2).
 * Persistência: localStorage (mesmo mecanismo do token).
 * Header: X-Empresa-Id nas chamadas /api.
 * Não altera JWT. Autorização: vínculo usuario_empresas no backend.
 */
(function (global) {
  'use strict';

  const STORAGE_ID = 'cds_empresa_id';
  const STORAGE_JSON = 'cds_empresa';
  const HEADER = 'X-Empresa-Id';

  function apiUrl() {
    return typeof API_URL !== 'undefined' ? API_URL : '/api';
  }

  function token() {
    try {
      return global.localStorage.getItem('token') || '';
    } catch (e) {
      return '';
    }
  }

  function formatarCnpj(valor) {
    const d = String(valor == null ? '' : valor).replace(/\D/g, '');
    if (d.length !== 14) return valor == null ? '' : String(valor);
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }

  function rotuloEmpresa(empresa) {
    if (!empresa) return '';
    const nome = String(empresa.nome_fantasia || empresa.razao_social || '').trim();
    const cnpj = formatarCnpj(empresa.cnpj);
    if (nome && cnpj) return nome + '\n' + cnpj;
    return nome || cnpj || ('Empresa #' + empresa.id);
  }

  function lerEmpresaId() {
    try {
      const n = Number(global.localStorage.getItem(STORAGE_ID));
      if (!Number.isInteger(n) || n <= 0) return null;
      return n;
    } catch (e) {
      return null;
    }
  }

  function lerEmpresa() {
    try {
      const raw = global.localStorage.getItem(STORAGE_JSON);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || !obj.id) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  function persistir(empresa) {
    if (!empresa || !empresa.id) {
      limpar();
      return;
    }
    global.localStorage.setItem(STORAGE_ID, String(empresa.id));
    global.localStorage.setItem(STORAGE_JSON, JSON.stringify(empresa));
  }

  function limpar() {
    try {
      global.localStorage.removeItem(STORAGE_ID);
      global.localStorage.removeItem(STORAGE_JSON);
    } catch (e) { /* ignore */ }
  }

  function headersJson() {
    const h = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    const id = lerEmpresaId();
    if (id) h[HEADER] = String(id);
    return h;
  }

  async function fetchJson(url, opcoes) {
    const resp = await fetch(url, opcoes);
    let body = null;
    try { body = await resp.json(); } catch (e) { body = null; }
    if (!resp.ok) {
      const err = new Error((body && (body.error || body.erro)) || ('HTTP ' + resp.status));
      err.code = body && body.code;
      err.status = resp.status;
      throw err;
    }
    return body;
  }

  async function listarDisponiveis() {
    return fetchJson(apiUrl() + '/empresas/contexto/disponiveis', {
      headers: headersJson()
    });
  }

  async function selecionar(empresaId) {
    const body = await fetchJson(apiUrl() + '/empresas/contexto', {
      method: 'POST',
      headers: headersJson(),
      body: JSON.stringify({ empresaId: Number(empresaId) })
    });
    if (body && body.empresa) persistir(body.empresa);
    return body;
  }

  function anexarHeaderXhr(xhr) {
    const id = lerEmpresaId();
    if (id) xhr.setRequestHeader(HEADER, String(id));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function garantirHost() {
    let host = document.getElementById('cds-empresa-seletor');
    if (host) return host;
    const footer = document.querySelector('.sidebar-footer');
    if (!footer) return null;
    host = document.createElement('div');
    host.id = 'cds-empresa-seletor';
    host.className = 'cds-empresa-seletor mb-2';
    footer.insertBefore(host, footer.firstChild);
    return host;
  }

  function renderVazio(host) {
    host.hidden = false;
    host.innerHTML =
      '<div class="cds-empresa-seletor__vazio text-muted small">' +
      'Você não possui empresa disponível.' +
      '</div>';
  }

  function renderLista(host, empresas, selecionadaId) {
    host.hidden = false;
    const opts = empresas.map((e) => {
      const nome = escapeHtml(e.nome_fantasia || e.razao_social || ('Empresa #' + e.id));
      const cnpj = escapeHtml(formatarCnpj(e.cnpj));
      const sel = Number(e.id) === Number(selecionadaId) ? ' selected' : '';
      return '<option value="' + e.id + '"' + sel + '>' + nome + ' — ' + cnpj + '</option>';
    }).join('');

    host.innerHTML =
      '<label class="cds-empresa-seletor__label small text-muted mb-1" for="cds-empresa-select">Empresa</label>' +
      '<select id="cds-empresa-select" class="form-select form-select-sm cds-empresa-seletor__select" aria-label="Empresa corrente">' +
      opts +
      '</select>';

    const select = host.querySelector('#cds-empresa-select');
    select.addEventListener('change', function () {
      const anterior = selecionadaId;
      selecionar(select.value).then(function () {
        selecionadaId = Number(select.value);
      }).catch(function (err) {
        select.value = anterior != null ? String(anterior) : '';
        if (typeof showNotification === 'function') {
          showNotification(err.message || 'Não foi possível selecionar a empresa.', 'error');
        }
      });
    });
  }

  async function inicializar() {
    const host = garantirHost();
    if (!host) return;

    let disponiveis = [];
    try {
      disponiveis = await listarDisponiveis();
    } catch (e) {
      renderVazio(host);
      return;
    }

    if (!Array.isArray(disponiveis) || disponiveis.length === 0) {
      limpar();
      renderVazio(host);
      return;
    }

    let atualId = lerEmpresaId();
    const ids = disponiveis.map((e) => Number(e.id));
    if (atualId && ids.indexOf(atualId) === -1) {
      limpar();
      atualId = null;
    }

    if (!atualId && disponiveis.length === 1) {
      try {
        await selecionar(disponiveis[0].id);
        atualId = disponiveis[0].id;
      } catch (e) {
        renderLista(host, disponiveis, null);
        return;
      }
    }

    renderLista(host, disponiveis, atualId);
  }

  global.CdsEmpresaContexto = {
    STORAGE_ID: STORAGE_ID,
    HEADER: HEADER,
    formatarCnpj: formatarCnpj,
    rotuloEmpresa: rotuloEmpresa,
    lerEmpresaId: lerEmpresaId,
    lerEmpresa: lerEmpresa,
    persistir: persistir,
    limpar: limpar,
    headersJson: headersJson,
    anexarHeaderXhr: anexarHeaderXhr,
    listarDisponiveis: listarDisponiveis,
    selecionar: selecionar,
    inicializar: inicializar
  };
})(typeof window !== 'undefined' ? window : this);
