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
    try {
      if (typeof document !== 'undefined' && document.dispatchEvent) {
        document.dispatchEvent(new CustomEvent('cds-empresa-contexto-alterado', {
          detail: { empresaId: Number(empresa.id) }
        }));
      }
    } catch (_e) { /* ignore */ }
  }

  function limpar() {
    try {
      global.localStorage.removeItem(STORAGE_ID);
      global.localStorage.removeItem(STORAGE_JSON);
    } catch (e) { /* ignore */ }
  }

  /**
   * Cabeçalhos de autenticação + contexto empresarial para /api.
   * Inclui X-Empresa-Id somente quando há empresa selecionada (sem fallback inventado).
   */
  function headersAuth(extra) {
    const h = { Accept: 'application/json' };
    const t = token();
    if (t) h.Authorization = 'Bearer ' + t;
    const id = lerEmpresaId();
    if (id) h[HEADER] = String(id);
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach((k) => {
        if (extra[k] != null) h[k] = extra[k];
      });
    }
    return h;
  }

  function headersJson(extra) {
    return headersAuth(Object.assign({ 'Content-Type': 'application/json' }, extra || {}));
  }

  function temEmpresaSelecionada() {
    return lerEmpresaId() != null;
  }

  function mensagemEmpresaObrigatoria() {
    return 'Selecione a empresa no seletor da barra lateral para continuar.';
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

  async function adotarEmpresaPadrao() {
    const body = await fetchJson(apiUrl() + '/empresas/contexto/padrao', {
      headers: headersJson()
    });
    if (!body || !body.empresa || !body.empresa.id) {
      const err = new Error('A empresa padrão da loja não foi identificada.');
      err.code = 'EMPRESA_PADRAO_AUSENTE';
      throw err;
    }
    persistir(body.empresa);
    return body;
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
      'Você não possui empresa disponível. Peça ao administrador para vincular seu usuário a uma empresa.' +
      '</div>';
  }

  function renderFalha(host) {
    host.hidden = false;
    host.innerHTML =
      '<div class="cds-empresa-seletor__erro small" role="alert">' +
      'Não foi possível carregar as empresas. Verifique a conexão e tente novamente.' +
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

  /** Matriz marcada pelo backend (/empresas/contexto/disponiveis); sem matriz, a primeira da lista. */
  function empresaPadrao(lista) {
    const itens = Array.isArray(lista) ? lista : [];
    return itens.find((e) => e && e.matriz_padrao === true) || itens[0] || null;
  }

  async function inicializar() {
    const host = garantirHost();
    if (!host) return;

    let disponiveis = [];
    try {
      disponiveis = await listarDisponiveis();
    } catch (e) {
      console.error('Contexto empresarial: falha ao carregar empresas.', e);
      limpar();
      renderFalha(host);
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

    if (!atualId && disponiveis.length >= 1) {
      const padrao = empresaPadrao(disponiveis);
      try {
        await selecionar(padrao.id);
        atualId = Number(padrao.id);
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
    headersAuth: headersAuth,
    headersJson: headersJson,
    temEmpresaSelecionada: temEmpresaSelecionada,
    mensagemEmpresaObrigatoria: mensagemEmpresaObrigatoria,
    anexarHeaderXhr: anexarHeaderXhr,
    listarDisponiveis: listarDisponiveis,
    empresaPadrao: empresaPadrao,
    adotarEmpresaPadrao: adotarEmpresaPadrao,
    selecionar: selecionar,
    inicializar: inicializar
  };
})(typeof window !== 'undefined' ? window : globalThis);

// O gateway KDS já disponibiliza este arquivo compartilhado; a monitoração é opt-in.
(function (global) {
  'use strict';

  function criarMonitor(opcoes) {
    let ativo = false;
    let requisicao = null;
    let timer = null;
    let estado = 'procurando';
    let falhas = 0;
    const textos = {
      procurando: 'Procurando servidor…',
      conectado: 'Conectado ao servidor (sessão não verificada)',
      reconectando: 'Reconectando ao servidor…',
      indisponivel: 'Servidor indisponível. Tentando novamente…'
    };

    function publicar(novo) {
      estado = novo;
      opcoes.aoMudar(novo, textos[novo]);
    }

    function agendar() {
      if (ativo && timer == null) timer = global.setTimeout(function () {
        timer = null;
        consultar();
      }, 5000);
    }

    function concluir(ok) {
      if (!ativo || !requisicao) return;
      requisicao = null;
      const recuperou = ok && estado !== 'conectado' && estado !== 'procurando';
      if (ok) {
        falhas = 0;
        publicar('conectado');
      } else {
        falhas += 1;
        publicar(falhas >= 3 ? 'indisponivel' : 'reconectando');
      }
      agendar();
      if (ok && recuperou && opcoes.aoReconectar) opcoes.aoReconectar();
    }

    function consultar() {
      if (!ativo || requisicao) return;
      if (timer != null) global.clearTimeout(timer);
      timer = null;
      try {
        const xhr = new global.XMLHttpRequest();
        requisicao = xhr;
        xhr.open('GET', opcoes.caminho + '?cds_rede=' + Date.now(), true);
        xhr.timeout = 8000;
        xhr.onload = function () {
          if (xhr !== requisicao) return;
          let ok = xhr.status === 200;
          if (ok && xhr.responseURL && global.location) {
            try { ok = new URL(xhr.responseURL).origin === global.location.origin; } catch (_err) { ok = false; }
          }
          if (ok && opcoes.tipo === 'kds') {
            ok = xhr.responseText.indexOf('id="tv-acesso"') !== -1;
          } else if (ok) {
            try { ok = JSON.parse(xhr.responseText).status === 'ok'; } catch (_err) { ok = false; }
          }
          concluir(ok);
        };
        xhr.onerror = xhr.ontimeout = function () { if (xhr === requisicao) concluir(false); };
        xhr.send();
      } catch (err) {
        if (!requisicao) requisicao = {};
        concluir(false);
        if (global.console) global.console.error('[CDS REDE] Falha na consulta de conexão:', err.message);
      }
    }

    function iniciar() {
      if (ativo) return;
      ativo = true;
      publicar('procurando');
      consultar();
    }

    function parar() {
      ativo = false;
      if (timer != null) global.clearTimeout(timer);
      timer = null;
      const anterior = requisicao;
      requisicao = null;
      if (anterior && typeof anterior.abort === 'function') anterior.abort();
    }

    function online() {
      if (!ativo || requisicao) return;
      if (estado !== 'conectado') publicar('reconectando');
      consultar();
    }

    return { iniciar: iniciar, parar: parar, online: online };
  }

  global.CdsEstadoRede = { criarMonitor: criarMonitor };
  const host = global.document && global.document.getElementById('cds-rede-status');
  if (!host) return;
  const tipo = host.getAttribute('data-tipo');
  const monitor = criarMonitor({
    tipo: tipo,
    caminho: tipo === 'kds' ? '/cozinha' : '/api/ping',
    aoMudar: function (estado, texto) {
      host.textContent = texto;
      host.setAttribute('data-estado', estado);
    },
    aoReconectar: function () {
      const painel = global.CdsCozinhaKds;
      if (tipo === 'kds' && painel && typeof painel.atualizar === 'function') {
        Promise.resolve().then(function () {
          if (global.CdsCozinhaKds !== painel || (painel.estado && painel.estado.ativo === false)) return;
          return painel.estado && painel.estado.modo === 'selecao' && painel.estado.selecaoFalhaLista
            ? painel.carregarUnidadesDisponiveis({ forcar: true })
            : painel.atualizar({ silencioso: true, forcar: true });
        }).catch(function (err) {
          if (global.console) global.console.error('[CDS REDE] Falha ao atualizar o painel:', err);
        });
      }
    }
  });
  global.addEventListener('online', monitor.online);
  global.addEventListener('pagehide', monitor.parar);
  global.addEventListener('pageshow', monitor.iniciar);
  monitor.iniciar();
})(typeof window !== 'undefined' ? window : globalThis);
