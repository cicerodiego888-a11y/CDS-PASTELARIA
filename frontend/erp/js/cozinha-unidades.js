/**
 * S07-2 — Gestão administrativa de unidades de cozinha.
 * Menu: Configurações → Gestão de Cozinhas → Unidades
 * Consome GET/POST/PATCH /api/cozinha/unidades. Sem coluna nome.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CdsCozinhaUnidadesApi = api;
    root.loadCozinhaUnidades = function loadCozinhaUnidades() {
      return api.montarNoNavegador(root).iniciar(
        root.document && root.document.getElementById('page-content')
      );
    };
  }
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  function escapar(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function apiBase(global) {
    if (global && typeof global.API_URL === 'string' && global.API_URL.trim()) {
      return global.API_URL.replace(/\/$/, '');
    }
    return '/api';
  }

  function headersJson(global, extra) {
    if (global && global.CdsEmpresaContexto && typeof global.CdsEmpresaContexto.headersJson === 'function') {
      return global.CdsEmpresaContexto.headersJson(extra || {});
    }
    const h = { Accept: 'application/json', 'Content-Type': 'application/json' };
    try {
      const t = global.localStorage && global.localStorage.getItem('token');
      if (t) h.Authorization = 'Bearer ' + t;
    } catch (_e) { /* ignore */ }
    return Object.assign(h, extra || {});
  }

  function temEmpresa(global) {
    if (global && global.CdsEmpresaContexto && typeof global.CdsEmpresaContexto.temEmpresaSelecionada === 'function') {
      return global.CdsEmpresaContexto.temEmpresaSelecionada();
    }
    return true;
  }

  function mensagemEmpresa(global) {
    if (global && global.CdsEmpresaContexto && typeof global.CdsEmpresaContexto.mensagemEmpresaObrigatoria === 'function') {
      return global.CdsEmpresaContexto.mensagemEmpresaObrigatoria();
    }
    return 'Selecione a empresa no seletor da barra lateral para continuar.';
  }

  function montarMarkup() {
    return `
<div class="page-container mt-3 cds-cozinha-unidades" id="cds-cozinha-unidades-root">
  <nav aria-label="breadcrumb" class="mb-2">
    <ol class="breadcrumb mb-1">
      <li class="breadcrumb-item">Configurações</li>
      <li class="breadcrumb-item">Gestão de Cozinhas</li>
      <li class="breadcrumb-item active" aria-current="page">Unidades</li>
    </ol>
  </nav>
  <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
    <div>
      <h3 class="mb-1"><i class="fas fa-utensils" aria-hidden="true"></i> Unidades de Cozinha</h3>
      <p class="text-muted mb-0 small">Cadastre e ative/inative unidades operacionais da empresa selecionada.</p>
    </div>
    <button type="button" class="btn btn-success btn-sm" id="coz-un-btn-nova">
      <i class="fas fa-plus" aria-hidden="true"></i> Nova Unidade
    </button>
  </div>
  <div id="coz-un-feedback" class="alert d-none" role="alert"></div>
  <div class="card mb-3 d-none" id="coz-un-form-card">
    <div class="card-body">
      <h5 class="card-title mb-3">Nova unidade</h5>
      <form id="coz-un-form" autocomplete="off">
        <div class="row g-3 align-items-end">
          <div class="col-md-4">
            <label class="form-label" for="coz-un-codigo">Código <span class="text-danger">*</span></label>
            <input type="text" class="form-control" id="coz-un-codigo" name="codigo" maxlength="64" required placeholder="Ex.: COZ-01">
          </div>
          <div class="col-md-3">
            <div class="form-check mt-4">
              <input class="form-check-input" type="checkbox" id="coz-un-ativo" checked>
              <label class="form-check-label" for="coz-un-ativo">Situação ativa</label>
            </div>
          </div>
          <div class="col-md-5 d-flex gap-2">
            <button type="submit" class="btn btn-primary" id="coz-un-salvar">Salvar</button>
            <button type="button" class="btn btn-outline-secondary" id="coz-un-cancelar">Cancelar</button>
          </div>
        </div>
      </form>
    </div>
  </div>
  <div class="card">
    <div class="table-responsive">
      <table class="table table-hover mb-0" id="coz-un-tabela">
        <thead class="table-dark">
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Código</th>
            <th scope="col">Empresa</th>
            <th scope="col">Situação</th>
            <th scope="col">Ações</th>
          </tr>
        </thead>
        <tbody id="coz-un-tbody">
          <tr><td colspan="5" class="text-center text-muted py-4">Carregando...</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>`;
  }

  function renderLinhas(unidades, empresaId) {
    if (!unidades || !unidades.length) {
      return '<tr><td colspan="5" class="text-center text-muted py-4">Nenhuma unidade cadastrada nesta empresa.</td></tr>';
    }
    return unidades.map((u) => {
      const ativa = u.ativo === true || Number(u.ativo) === 1;
      const badge = ativa
        ? '<span class="badge bg-success">Ativa</span>'
        : '<span class="badge bg-secondary">Inativa</span>';
      const acao = ativa
        ? `<button type="button" class="btn btn-sm btn-outline-warning" data-acao="inativar" data-id="${Number(u.id)}">Inativar</button>`
        : `<button type="button" class="btn btn-sm btn-outline-success" data-acao="ativar" data-id="${Number(u.id)}">Ativar</button>`;
      return `<tr>
        <td>${Number(u.id)}</td>
        <td><code>${escapar(u.codigo)}</code></td>
        <td>${escapar(empresaId != null ? empresaId : u.empresa_id)}</td>
        <td>${badge}</td>
        <td>${acao}</td>
      </tr>`;
    }).join('');
  }

  async function parseResposta(resp) {
    let body = null;
    try { body = await resp.json(); } catch (_e) { body = null; }
    return { ok: resp.ok, status: resp.status, body };
  }

  function montarNoNavegador(global) {
    let host = null;
    let onEmpresa = null;

    function feedback(tipo, mensagem) {
      const el = host && host.querySelector('#coz-un-feedback');
      if (!el) return;
      el.className = 'alert alert-' + (tipo === 'sucesso' ? 'success' : 'danger');
      el.textContent = mensagem || '';
      el.classList.remove('d-none');
    }

    function limparFeedback() {
      const el = host && host.querySelector('#coz-un-feedback');
      if (!el) return;
      el.className = 'alert d-none';
      el.textContent = '';
    }

    function mostrarForm(visivel) {
      const card = host && host.querySelector('#coz-un-form-card');
      if (!card) return;
      card.classList.toggle('d-none', !visivel);
      if (visivel) {
        const input = host.querySelector('#coz-un-codigo');
        if (input) {
          input.value = '';
          input.focus();
        }
        const chk = host.querySelector('#coz-un-ativo');
        if (chk) chk.checked = true;
      }
    }

    async function carregarLista() {
      const tbody = host && host.querySelector('#coz-un-tbody');
      if (!tbody) return;
      if (!temEmpresa(global)) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-warning py-4">${escapar(mensagemEmpresa(global))}</td></tr>`;
        return;
      }
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Carregando...</td></tr>';
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/unidades', {
          method: 'GET',
          headers: headersJson(global)
        });
        const { ok, body } = await parseResposta(resp);
        if (!ok || !body || body.success === false) {
          const msg = (body && (body.mensagem || body.error || body.codigo)) || 'Falha ao listar unidades.';
          tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">${escapar(msg)}</td></tr>`;
          feedback('erro', msg);
          return;
        }
        tbody.innerHTML = renderLinhas(body.unidades || [], body.empresa_id);
      } catch (err) {
        const msg = (err && err.message) || 'Erro de rede ao listar unidades.';
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">${escapar(msg)}</td></tr>`;
        feedback('erro', msg);
      }
    }

    async function salvarNova(ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      limparFeedback();
      if (!temEmpresa(global)) {
        feedback('erro', mensagemEmpresa(global));
        return;
      }
      const codigoEl = host.querySelector('#coz-un-codigo');
      const ativoEl = host.querySelector('#coz-un-ativo');
      const codigo = codigoEl ? String(codigoEl.value || '').trim() : '';
      if (!codigo) {
        feedback('erro', 'Informe o código da unidade.');
        return;
      }
      const btn = host.querySelector('#coz-un-salvar');
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/unidades', {
          method: 'POST',
          headers: headersJson(global),
          body: JSON.stringify({
            codigo,
            ativo: !!(ativoEl && ativoEl.checked)
          })
        });
        const { ok, body } = await parseResposta(resp);
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error)) || 'Não foi possível cadastrar a unidade.');
          return;
        }
        feedback('sucesso', `Unidade ${body.unidade && body.unidade.codigo ? body.unidade.codigo : codigo} cadastrada.`);
        mostrarForm(false);
        await carregarLista();
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao cadastrar.');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function alternarAtivo(id, ativo) {
      limparFeedback();
      if (!temEmpresa(global)) {
        feedback('erro', mensagemEmpresa(global));
        return;
      }
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/unidades/' + Number(id), {
          method: 'PATCH',
          headers: headersJson(global),
          body: JSON.stringify({ ativo: !!ativo })
        });
        const { ok, body } = await parseResposta(resp);
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error)) || 'Não foi possível alterar a situação.');
          return;
        }
        const cod = body.unidade && body.unidade.codigo ? body.unidade.codigo : id;
        feedback('sucesso', `Unidade ${cod} ${ativo ? 'ativada' : 'inativada'}.`);
        await carregarLista();
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao alterar situação.');
      }
    }

    function ligarEventos() {
      const btnNova = host.querySelector('#coz-un-btn-nova');
      const btnCancelar = host.querySelector('#coz-un-cancelar');
      const form = host.querySelector('#coz-un-form');
      const tbody = host.querySelector('#coz-un-tbody');
      if (btnNova) btnNova.addEventListener('click', () => { limparFeedback(); mostrarForm(true); });
      if (btnCancelar) btnCancelar.addEventListener('click', () => mostrarForm(false));
      if (form) form.addEventListener('submit', salvarNova);
      if (tbody) {
        tbody.addEventListener('click', (ev) => {
          const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-acao]') : null;
          if (!btn) return;
          const id = Number(btn.getAttribute('data-id'));
          const acao = btn.getAttribute('data-acao');
          if (!Number.isInteger(id) || id <= 0) return;
          if (acao === 'ativar') alternarAtivo(id, true);
          else if (acao === 'inativar') alternarAtivo(id, false);
        });
      }
      onEmpresa = () => { limparFeedback(); carregarLista(); };
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('cds-empresa-contexto-alterado', onEmpresa);
      }
    }

    function iniciar(container) {
      host = container;
      if (!host) return Promise.resolve();
      host.innerHTML = montarMarkup();
      ligarEventos();
      return carregarLista();
    }

    function destruir() {
      if (onEmpresa && global.document && global.document.removeEventListener) {
        global.document.removeEventListener('cds-empresa-contexto-alterado', onEmpresa);
      }
      onEmpresa = null;
      host = null;
    }

    return { iniciar, destruir, carregarLista, renderLinhas, montarMarkup };
  }

  return {
    montarNoNavegador,
    montarMarkup,
    renderLinhas,
    escapar
  };
}));
