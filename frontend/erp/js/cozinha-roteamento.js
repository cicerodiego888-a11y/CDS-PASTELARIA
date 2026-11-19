/**
 * S07-3B/3C — Gestão de Roteamento de Cozinhas (UI).
 * Configurações Avançadas / Gestão de Cozinhas → Roteamento.
 * S07-3A: modo + cozinha padrão. S07-3C: canais dinâmicos + destino por canal.
 * Sem DDL, sem despacho, sem Pedidos→KDS, sem integração iFood.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.CdsCozinhaRoteamentoApi = api;
    root.loadCozinhaRoteamento = function loadCozinhaRoteamento() {
      return api.montarNoNavegador(root).iniciar(
        root.document && root.document.getElementById('page-content')
      );
    };
  }
}(typeof window !== 'undefined' ? window : globalThis, function factory() {
  'use strict';

  const MODO_PADRAO = 'COZINHA_PADRAO';
  const MODO_SEGMENTO = 'COZINHA_POR_SEGMENTO';
  /** Compat S07-3B — segmentos fixos só para prévia/legado; UI operacional usa canais. */
  const SEGMENTOS_FALLBACK = Object.freeze(['LOJA', 'IFOOD', 'PEDIDO_ONLINE']);
  const UNIDADES_DEMO_PREVIA = Object.freeze([
    { id: -901, codigo: '[DEMO] COZINA-A', ativo: 1 },
    { id: -902, codigo: '[DEMO] COZINA-B', ativo: 1 },
    { id: -903, codigo: '[DEMO] COZINA-C', ativo: 1 }
  ]);

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

  function labelModo(modo) {
    if (modo === MODO_PADRAO) return 'Cozinha padrão';
    if (modo === MODO_SEGMENTO) return 'Cozinha por segmento';
    return modo || '—';
  }

  function labelSegmento(seg) {
    const map = { LOJA: 'Loja (balcão / mesas)', IFOOD: 'iFood', PEDIDO_ONLINE: 'Pedido online' };
    return map[seg] || seg;
  }

  function mensagemSchemaIndisponivel(body) {
    const base = 'A configuração persistente de roteamento ainda depende da aplicação controlada do schema (migration S07-3A).';
    const extra = body && body.mensagem ? String(body.mensagem) : '';
    return extra ? `${base} ${extra}` : `${base} Contate o administrador técnico antes de usar esta tela em produção.`;
  }

  function mensagemSchemaCanais(body) {
    const base = 'O cadastro de canais depende da aplicação controlada do schema (migration S07-3C).';
    const extra = body && body.mensagem ? String(body.mensagem) : '';
    return extra ? `${base} ${extra}` : base;
  }

  function montarMarkup() {
    return `
<div class="page-container mt-3 cds-cozinha-roteamento" id="cds-cozinha-roteamento-root">
  <nav aria-label="breadcrumb" class="mb-2">
    <ol class="breadcrumb mb-1">
      <li class="breadcrumb-item">Configurações Avançadas</li>
      <li class="breadcrumb-item">Gestão de Cozinhas</li>
      <li class="breadcrumb-item active" aria-current="page">Roteamento</li>
    </ol>
  </nav>
  <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
    <div>
      <h3 class="mb-1"><i class="fas fa-route" aria-hidden="true"></i> Gestão de Roteamento de Cozinhas</h3>
      <p class="text-muted mb-0 small">
        Configure a cozinha padrão e cadastre canais de pedidos (Loja e canais manuais),
        vinculando cada canal a uma unidade ativa. Sem despacho e sem integração externa nesta etapa.
      </p>
    </div>
    <button type="button" class="btn btn-outline-secondary btn-sm" id="coz-rot-btn-recarregar">
      <i class="fas fa-sync-alt" aria-hidden="true"></i> Recarregar
    </button>
  </div>

  <div id="coz-rot-schema-alerta" class="alert alert-warning d-none" role="alert"></div>
  <div id="coz-rot-schema-canais-alerta" class="alert alert-warning d-none" role="alert"></div>
  <div id="coz-rot-previa-alerta" class="alert alert-info d-none" role="status"></div>
  <div id="coz-rot-feedback" class="alert d-none" role="alert"></div>
  <div id="coz-rot-bloqueio" class="alert alert-danger d-none" role="alert"></div>

  <div id="coz-rot-conteudo" class="d-none">
    <div class="card mb-3" id="coz-rot-card-modo">
      <div class="card-body">
        <h5 class="card-title mb-3">Modo de distribuição</h5>
        <div class="form-check mb-2">
          <input class="form-check-input" type="radio" name="coz-rot-modo" id="coz-rot-modo-padrao" value="${MODO_PADRAO}">
          <label class="form-check-label" for="coz-rot-modo-padrao">
            <strong>Cozinha padrão</strong>
            <span class="d-block small text-muted">Todos os pedidos vão para uma única unidade ativa.</span>
          </label>
        </div>
        <div class="form-check mb-3">
          <input class="form-check-input" type="radio" name="coz-rot-modo" id="coz-rot-modo-segmento" value="${MODO_SEGMENTO}">
          <label class="form-check-label" for="coz-rot-modo-segmento">
            <strong>Cozinha por canal / segmento</strong>
            <span class="d-block small text-muted">Destinos conforme canais cadastrados (evolução S07-3C).</span>
          </label>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="coz-rot-btn-salvar-modo" data-coz-rot-gravacao="1">
          Salvar modo
        </button>
      </div>
    </div>

    <div class="card mb-3" id="coz-rot-card-padrao">
      <div class="card-body">
        <h5 class="card-title mb-3">Cozinha padrão</h5>
        <div class="row g-3 align-items-end">
          <div class="col-md-6">
            <label class="form-label" for="coz-rot-unidade-padrao">Unidade de destino</label>
            <select class="form-select" id="coz-rot-unidade-padrao" data-coz-rot-gravacao="1">
              <option value="">Selecione uma unidade ativa…</option>
            </select>
          </div>
          <div class="col-md-6">
            <button type="button" class="btn btn-primary btn-sm" id="coz-rot-btn-salvar-padrao" data-coz-rot-gravacao="1">
              Salvar cozinha padrão
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="card mb-3" id="coz-rot-card-canais">
      <div class="card-body">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
          <div>
            <h5 class="card-title mb-1">Canais de pedidos</h5>
            <p class="small text-muted mb-0">
              Cadastre canais e vincule cada um a uma unidade. Canais manuais não são integrações ativas.
            </p>
          </div>
          <button type="button" class="btn btn-success btn-sm" id="coz-rot-btn-novo-canal" data-coz-rot-canais-gravacao="1">
            <i class="fas fa-plus" aria-hidden="true"></i> Novo canal
          </button>
        </div>

        <div class="card border mb-3 d-none" id="coz-rot-form-canal-card">
          <div class="card-body py-3">
            <label class="form-label" for="coz-rot-canal-nome">Nome do canal</label>
            <div class="row g-2 align-items-end">
              <div class="col-md-8">
                <input type="text" class="form-control" id="coz-rot-canal-nome" maxlength="80" placeholder="Ex.: WhatsApp, App próprio">
              </div>
              <div class="col-md-4 d-flex gap-2">
                <button type="button" class="btn btn-primary btn-sm" id="coz-rot-btn-criar-canal" data-coz-rot-canais-gravacao="1">Salvar canal</button>
                <button type="button" class="btn btn-outline-secondary btn-sm" id="coz-rot-btn-cancelar-canal">Cancelar</button>
              </div>
            </div>
            <p class="small text-muted mb-0 mt-2">O código técnico é gerado automaticamente pelo servidor e não pode ser alterado depois.</p>
          </div>
        </div>

        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0" id="coz-rot-tabela-canais">
            <thead class="table-light">
              <tr>
                <th scope="col">Canal</th>
                <th scope="col">Origem</th>
                <th scope="col">Situação</th>
                <th scope="col">Unidade de cozinha</th>
                <th scope="col" style="width:11rem">Ações</th>
              </tr>
            </thead>
            <tbody id="coz-rot-tbody-canais">
              <tr><td colspan="5" class="text-muted text-center py-3">Carregando…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="small text-muted" id="coz-rot-meta"></div>
  </div>
</div>`;
  }

  function opcoesUnidadesHtml(unidades, selecionadaId) {
    const ativas = (unidades || []).filter((u) => u.ativo === true || Number(u.ativo) === 1);
    const opts = ['<option value="">Selecione uma unidade ativa…</option>'];
    ativas.forEach((u) => {
      const id = Number(u.id);
      const sel = selecionadaId != null && Number(selecionadaId) === id ? ' selected' : '';
      opts.push(`<option value="${id}"${sel}>${escapar(u.codigo)} (#${id})</option>`);
    });
    if (!ativas.length) {
      opts.push('<option value="" disabled>Nenhuma unidade ativa cadastrada</option>');
    }
    return opts.join('');
  }

  function renderLinhasSegmentos(segmentosPermitidos, mapaAtual, unidades) {
    const segs = (segmentosPermitidos && segmentosPermitidos.length)
      ? segmentosPermitidos
      : SEGMENTOS_FALLBACK.slice();
    if (!segs.length) {
      return '<tr><td colspan="3" class="text-muted text-center py-3">Nenhum segmento permitido.</td></tr>';
    }
    return segs.map((seg) => {
      const atual = (mapaAtual || []).find((s) => String(s.segmento) === String(seg));
      const unidadeId = atual && atual.unidade_id != null ? Number(atual.unidade_id) : null;
      return `<tr data-segmento="${escapar(seg)}">
        <td><strong>${escapar(labelSegmento(seg))}</strong><div class="small text-muted"><code>${escapar(seg)}</code></div></td>
        <td>
          <select class="form-select form-select-sm coz-rot-seg-unidade" data-segmento="${escapar(seg)}" data-coz-rot-gravacao="1" aria-label="Unidade para ${escapar(seg)}">
            ${opcoesUnidadesHtml(unidades, unidadeId)}
          </select>
        </td>
        <td>
          <button type="button" class="btn btn-sm btn-outline-primary" data-acao="salvar-segmento" data-segmento="${escapar(seg)}" data-coz-rot-gravacao="1">Salvar</button>
        </td>
      </tr>`;
    }).join('');
  }

  function renderLinhasCanais(canais, unidades) {
    if (!canais || !canais.length) {
      return '<tr><td colspan="5" class="text-muted text-center py-3">Nenhum canal cadastrado.</td></tr>';
    }
    return canais.map((c) => {
      const id = Number(c.id);
      const sistema = !!c.sistema || String(c.origem_tipo) === 'SISTEMA';
      const ativo = c.ativo === true || Number(c.ativo) === 1;
      const destId = c.destino && c.destino.unidade_id != null ? Number(c.destino.unidade_id) : null;
      const badgeOrigem = sistema
        ? '<span class="badge bg-dark">Sistema</span>'
        : '<span class="badge bg-secondary">Manual</span>';
      const badgeAtivo = ativo
        ? '<span class="badge bg-success">Ativo</span>'
        : '<span class="badge bg-secondary">Inativo</span>';
      const semDestino = destId == null
        ? '<div class="small text-warning mt-1">Sem destino configurado</div>'
        : '';
      const btnAtivo = sistema
        ? '<button type="button" class="btn btn-sm btn-outline-secondary" disabled title="Canal de sistema protegido">LOJA</button>'
        : (ativo
          ? `<button type="button" class="btn btn-sm btn-outline-warning" data-acao="desativar-canal" data-id="${id}" data-coz-rot-canais-gravacao="1">Desativar</button>`
          : `<button type="button" class="btn btn-sm btn-outline-success" data-acao="ativar-canal" data-id="${id}" data-coz-rot-canais-gravacao="1">Ativar</button>`);
      return `<tr data-canal-id="${id}">
        <td>
          <input type="text" class="form-control form-control-sm coz-rot-canal-nome-edit" data-id="${id}" value="${escapar(c.nome)}" maxlength="80" data-coz-rot-canais-gravacao="1" aria-label="Nome do canal ${escapar(c.codigo)}">
          <div class="small text-muted mt-1"><code>${escapar(c.codigo)}</code></div>
        </td>
        <td>${badgeOrigem}</td>
        <td>${badgeAtivo}</td>
        <td>
          <select class="form-select form-select-sm coz-rot-canal-unidade" data-id="${id}" data-coz-rot-canais-gravacao="1" aria-label="Unidade do canal ${escapar(c.codigo)}">
            ${opcoesUnidadesHtml(unidades, destId)}
          </select>
          ${semDestino}
        </td>
        <td class="d-flex flex-wrap gap-1">
          <button type="button" class="btn btn-sm btn-outline-primary" data-acao="salvar-nome-canal" data-id="${id}" data-coz-rot-canais-gravacao="1">Nome</button>
          <button type="button" class="btn btn-sm btn-primary" data-acao="salvar-destino-canal" data-id="${id}" data-coz-rot-canais-gravacao="1">Destino</button>
          ${btnAtivo}
        </td>
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
    let estado = {
      unidades: [],
      config: null,
      canais: [],
      schemaIndisponivel: false,
      schemaCanaisIndisponivel: false,
      previaVisual: false,
      bloqueado: false
    };

    function el(sel) {
      return host && host.querySelector(sel);
    }

    function feedback(tipo, mensagem) {
      const box = el('#coz-rot-feedback');
      if (!box) return;
      box.className = 'alert alert-' + (tipo === 'sucesso' ? 'success' : tipo === 'aviso' ? 'warning' : 'danger');
      box.textContent = mensagem || '';
      box.classList.remove('d-none');
    }

    function limparFeedback() {
      const box = el('#coz-rot-feedback');
      if (!box) return;
      box.className = 'alert d-none';
      box.textContent = '';
    }

    function mostrarAlerta(sel, visivel, html, tone) {
      const box = el(sel);
      if (!box) return;
      if (!visivel) {
        box.classList.add('d-none');
        box.textContent = '';
        return;
      }
      box.className = `alert alert-${tone || 'warning'}`;
      box.innerHTML = html;
      box.classList.remove('d-none');
    }

    function mostrarSchemaAlerta(visivel, mensagem) {
      mostrarAlerta(
        '#coz-rot-schema-alerta',
        visivel,
        `<strong>Schema de roteamento indisponível.</strong> ${escapar(mensagem || mensagemSchemaIndisponivel(null))}`,
        'warning'
      );
    }

    function mostrarSchemaCanaisAlerta(visivel, mensagem) {
      mostrarAlerta(
        '#coz-rot-schema-canais-alerta',
        visivel,
        `<strong>Schema de canais indisponível.</strong> ${escapar(mensagem || mensagemSchemaCanais(null))}`,
        'warning'
      );
    }

    function mostrarPreviaAlerta(visivel) {
      mostrarAlerta(
        '#coz-rot-previa-alerta',
        visivel,
        [
          '<strong>Prévia visual apenas.</strong>',
          ' Nenhuma configuração de roteamento foi carregada do servidor.',
          ' A gravação de modo/padrão permanece bloqueada até a migration S07-3A.'
        ].join(''),
        'info'
      );
    }

    function mostrarBloqueio(mensagem) {
      estado.bloqueado = true;
      const box = el('#coz-rot-bloqueio');
      const conteudo = el('#coz-rot-conteudo');
      if (box) {
        box.className = 'alert alert-danger';
        box.textContent = mensagem || 'Você não tem permissão para gerenciar o roteamento de cozinhas.';
        box.classList.remove('d-none');
      }
      if (conteudo) conteudo.classList.add('d-none');
      mostrarPreviaAlerta(false);
    }

    function aplicarVisibilidadeModo() {
      const modo = modoSelecionado();
      const cardPadrao = el('#coz-rot-card-padrao');
      const cardCanais = el('#coz-rot-card-canais');
      if (cardPadrao) cardPadrao.classList.toggle('opacity-50', modo === MODO_SEGMENTO);
      if (cardCanais) cardCanais.classList.toggle('opacity-50', modo === MODO_PADRAO);
    }

    function modoSelecionado() {
      const marcado = host && host.querySelector('input[name="coz-rot-modo"]:checked');
      return marcado ? String(marcado.value) : null;
    }

    function preencherModo(modo) {
      const p = el('#coz-rot-modo-padrao');
      const s = el('#coz-rot-modo-segmento');
      if (p) p.checked = modo === MODO_PADRAO || !modo;
      if (s) s.checked = modo === MODO_SEGMENTO;
      aplicarVisibilidadeModo();
    }

    function preencherSelectPadrao(unidadeId) {
      const sel = el('#coz-rot-unidade-padrao');
      if (!sel) return;
      sel.innerHTML = opcoesUnidadesHtml(estado.unidades, unidadeId);
    }

    function preencherCanais() {
      const tbody = el('#coz-rot-tbody-canais');
      if (!tbody) return;
      if (estado.schemaCanaisIndisponivel) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-warning text-center py-3">Schema de canais indisponível — migration S07-3C pendente.</td></tr>';
        return;
      }
      tbody.innerHTML = renderLinhasCanais(estado.canais, estado.unidades);
    }

    function preencherMeta(config, { previa } = {}) {
      const meta = el('#coz-rot-meta');
      if (!meta) return;
      if (previa) {
        meta.textContent = 'Prévia visual — sem configuração persistida de roteamento no servidor.';
        return;
      }
      const partes = [];
      if (config && config.configurado) {
        partes.push(`Modo: ${labelModo(config.modo)}`);
        if (config.updated_at) partes.push(`Roteamento em: ${config.updated_at}`);
      } else {
        partes.push('Roteamento: sem configuração salva');
      }
      partes.push(`Canais: ${estado.canais.length}`);
      meta.textContent = partes.join(' · ');
    }

    function definirPainelVisivel(visivel) {
      const conteudo = el('#coz-rot-conteudo');
      if (!conteudo) return;
      conteudo.classList.toggle('d-none', !visivel);
    }

    function definirGravacaoRoteamento(habilitada) {
      const conteudo = el('#coz-rot-conteudo');
      if (!conteudo) return;
      conteudo.querySelectorAll('[data-coz-rot-gravacao="1"], input[name="coz-rot-modo"]').forEach((node) => {
        node.disabled = !habilitada;
      });
    }

    function definirGravacaoCanais(habilitada) {
      const conteudo = el('#coz-rot-conteudo');
      if (!conteudo) return;
      conteudo.querySelectorAll('[data-coz-rot-canais-gravacao="1"]').forEach((node) => {
        node.disabled = !habilitada;
      });
    }

    function mostrarFormCanal(visivel) {
      const card = el('#coz-rot-form-canal-card');
      if (!card) return;
      card.classList.toggle('d-none', !visivel);
      if (visivel) {
        const input = el('#coz-rot-canal-nome');
        if (input) {
          input.value = '';
          input.focus();
        }
      }
    }

    function aplicarPreviaSchemaIndisponivel() {
      estado.previaVisual = true;
      estado.config = null;
      definirPainelVisivel(true);
      mostrarPreviaAlerta(true);
      const unidadesParaSelect = (estado.unidades && estado.unidades.length)
        ? estado.unidades
        : UNIDADES_DEMO_PREVIA.slice();
      preencherModo(MODO_PADRAO);
      const selPadrao = el('#coz-rot-unidade-padrao');
      if (selPadrao) selPadrao.innerHTML = opcoesUnidadesHtml(unidadesParaSelect, null);
      preencherMeta(null, { previa: true });
      definirGravacaoRoteamento(false);
    }

    async function carregarUnidades() {
      const resp = await global.fetch(apiBase(global) + '/cozinha/unidades', {
        method: 'GET',
        headers: headersJson(global)
      });
      const { ok, status, body } = await parseResposta(resp);
      if (status === 403 && body && (body.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO' || body.erro === 'MODULO_NAO_LICENCIADO')) {
        const msg = body.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO'
          ? 'Somente administrador operacional pode gerenciar o roteamento de cozinhas.'
          : (body.mensagem || 'Módulo Pedidos não licenciado para esta instalação.');
        mostrarBloqueio(msg);
        return null;
      }
      if (!ok || !body || body.success === false) {
        throw new Error((body && (body.mensagem || body.error)) || 'Falha ao carregar unidades de cozinha.');
      }
      estado.unidades = body.unidades || [];
      return estado.unidades;
    }

    async function carregarConfig() {
      const resp = await global.fetch(apiBase(global) + '/cozinha/roteamento', {
        method: 'GET',
        headers: headersJson(global)
      });
      const { ok, status, body } = await parseResposta(resp);
      if (status === 503 && body && body.codigo === 'SCHEMA_ROTEAMENTO_INDISPONIVEL') {
        estado.schemaIndisponivel = true;
        mostrarSchemaAlerta(true, mensagemSchemaIndisponivel(body));
        return null;
      }
      if (status === 403 && body && body.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO') {
        mostrarBloqueio('Somente administrador operacional pode gerenciar o roteamento de cozinhas.');
        return null;
      }
      if (status === 403 && body && body.erro === 'MODULO_NAO_LICENCIADO') {
        mostrarBloqueio(body.mensagem || 'Módulo Pedidos não licenciado.');
        return null;
      }
      if (!ok || !body || body.success === false) {
        throw new Error((body && (body.mensagem || body.error || body.codigo)) || 'Falha ao carregar roteamento.');
      }
      estado.schemaIndisponivel = false;
      estado.previaVisual = false;
      mostrarSchemaAlerta(false);
      mostrarPreviaAlerta(false);
      estado.config = body;
      return body;
    }

    async function carregarCanais() {
      const resp = await global.fetch(apiBase(global) + '/cozinha/canais', {
        method: 'GET',
        headers: headersJson(global)
      });
      const { ok, status, body } = await parseResposta(resp);
      if (status === 503 && body && body.codigo === 'SCHEMA_CANAIS_INDISPONIVEL') {
        estado.schemaCanaisIndisponivel = true;
        estado.canais = [];
        mostrarSchemaCanaisAlerta(true, mensagemSchemaCanais(body));
        return null;
      }
      if (status === 403 && body && body.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO') {
        mostrarBloqueio('Somente administrador operacional pode gerenciar canais de pedidos.');
        return null;
      }
      if (!ok || !body || body.success === false) {
        throw new Error((body && (body.mensagem || body.error || body.codigo)) || 'Falha ao carregar canais.');
      }
      estado.schemaCanaisIndisponivel = false;
      mostrarSchemaCanaisAlerta(false);
      estado.canais = body.canais || [];
      return estado.canais;
    }

    function aplicarConfigNaTela(config) {
      estado.previaVisual = false;
      mostrarPreviaAlerta(false);
      definirPainelVisivel(true);
      preencherModo(config && config.modo);
      preencherSelectPadrao(config && config.unidade_padrao_id);
      preencherCanais();
      preencherMeta(config);
      definirGravacaoRoteamento(!estado.schemaIndisponivel);
      definirGravacaoCanais(!estado.schemaCanaisIndisponivel);
    }

    async function recarregar() {
      limparFeedback();
      estado.bloqueado = false;
      estado.schemaIndisponivel = false;
      estado.schemaCanaisIndisponivel = false;
      estado.previaVisual = false;
      const bloqueio = el('#coz-rot-bloqueio');
      if (bloqueio) {
        bloqueio.className = 'alert d-none';
        bloqueio.textContent = '';
      }
      mostrarSchemaAlerta(false);
      mostrarSchemaCanaisAlerta(false);
      mostrarPreviaAlerta(false);
      mostrarFormCanal(false);

      if (!temEmpresa(global)) {
        definirPainelVisivel(false);
        definirGravacaoRoteamento(false);
        definirGravacaoCanais(false);
        feedback('aviso', mensagemEmpresa(global));
        return;
      }

      try {
        await carregarUnidades();
        if (estado.bloqueado) return;
        const config = await carregarConfig();
        if (estado.bloqueado) return;
        await carregarCanais();
        if (estado.bloqueado) return;

        definirPainelVisivel(true);
        if (estado.schemaIndisponivel) {
          aplicarPreviaSchemaIndisponivel();
        } else {
          aplicarConfigNaTela(config || { configurado: false });
        }
        preencherCanais();
        definirGravacaoCanais(!estado.schemaCanaisIndisponivel);
        if (!estado.schemaIndisponivel) preencherMeta(estado.config);
      } catch (err) {
        definirPainelVisivel(false);
        definirGravacaoRoteamento(false);
        definirGravacaoCanais(false);
        feedback('erro', (err && err.message) || 'Erro ao carregar a tela de roteamento.');
      }
    }

    async function salvarModo() {
      limparFeedback();
      if (estado.schemaIndisponivel) {
        feedback('aviso', mensagemSchemaIndisponivel(null));
        return;
      }
      const modo = modoSelecionado();
      if (!modo) {
        feedback('erro', 'Selecione o modo de distribuição.');
        return;
      }
      const btn = el('#coz-rot-btn-salvar-modo');
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/roteamento/modo', {
          method: 'PUT',
          headers: headersJson(global),
          body: JSON.stringify({ modo })
        });
        const { ok, status, body } = await parseResposta(resp);
        if (status === 503 && body && body.codigo === 'SCHEMA_ROTEAMENTO_INDISPONIVEL') {
          estado.schemaIndisponivel = true;
          mostrarSchemaAlerta(true, mensagemSchemaIndisponivel(body));
          aplicarPreviaSchemaIndisponivel();
          return;
        }
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || 'Não foi possível salvar o modo.');
          return;
        }
        estado.config = body;
        aplicarConfigNaTela(body);
        feedback('sucesso', `Modo salvo: ${labelModo(body.modo)}.`);
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao salvar modo.');
      } finally {
        if (btn) btn.disabled = !!estado.schemaIndisponivel;
      }
    }

    async function salvarPadrao() {
      limparFeedback();
      if (estado.schemaIndisponivel) {
        feedback('aviso', mensagemSchemaIndisponivel(null));
        return;
      }
      const sel = el('#coz-rot-unidade-padrao');
      const unidadeId = sel ? Number(sel.value) : NaN;
      if (!Number.isInteger(unidadeId) || unidadeId <= 0) {
        feedback('erro', 'Selecione a cozinha padrão.');
        return;
      }
      const btn = el('#coz-rot-btn-salvar-padrao');
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/roteamento/padrao', {
          method: 'PUT',
          headers: headersJson(global),
          body: JSON.stringify({ unidade_id: unidadeId })
        });
        const { ok, status, body } = await parseResposta(resp);
        if (status === 503 && body && body.codigo === 'SCHEMA_ROTEAMENTO_INDISPONIVEL') {
          estado.schemaIndisponivel = true;
          mostrarSchemaAlerta(true, mensagemSchemaIndisponivel(body));
          aplicarPreviaSchemaIndisponivel();
          return;
        }
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || 'Não foi possível salvar a cozinha padrão.');
          return;
        }
        estado.config = body;
        aplicarConfigNaTela(body);
        feedback('sucesso', 'Cozinha padrão atualizada.');
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao salvar cozinha padrão.');
      } finally {
        if (btn) btn.disabled = !!estado.schemaIndisponivel;
      }
    }

    /** Compat testes S07-3B — segmentos legado. */
    async function salvarSegmento(segmento) {
      limparFeedback();
      if (estado.schemaIndisponivel) {
        feedback('aviso', mensagemSchemaIndisponivel(null));
        return;
      }
      const sel = host && host.querySelector(`select.coz-rot-seg-unidade[data-segmento="${segmento}"]`);
      const unidadeId = sel ? Number(sel.value) : NaN;
      if (!Number.isInteger(unidadeId) || unidadeId <= 0) {
        feedback('erro', `Selecione a unidade de destino para ${labelSegmento(segmento)}.`);
        return;
      }
      const btn = host && host.querySelector(`button[data-acao="salvar-segmento"][data-segmento="${segmento}"]`);
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/roteamento/segmentos', {
          method: 'PUT',
          headers: headersJson(global),
          body: JSON.stringify({ segmento, unidade_id: unidadeId })
        });
        const { ok, status, body } = await parseResposta(resp);
        if (status === 503 && body && body.codigo === 'SCHEMA_ROTEAMENTO_INDISPONIVEL') {
          estado.schemaIndisponivel = true;
          mostrarSchemaAlerta(true, mensagemSchemaIndisponivel(body));
          aplicarPreviaSchemaIndisponivel();
          return;
        }
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || `Falha ao associar ${segmento}.`);
          return;
        }
        estado.config = body;
        aplicarConfigNaTela(body);
        feedback('sucesso', `Segmento ${labelSegmento(segmento)} associado.`);
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao salvar segmento.');
      } finally {
        if (btn) btn.disabled = !!estado.schemaIndisponivel;
      }
    }

    async function criarCanal() {
      limparFeedback();
      if (estado.schemaCanaisIndisponivel) {
        feedback('aviso', mensagemSchemaCanais(null));
        return;
      }
      const input = el('#coz-rot-canal-nome');
      const nome = input ? String(input.value || '').trim() : '';
      if (!nome) {
        feedback('erro', 'Informe o nome do canal.');
        return;
      }
      const btn = el('#coz-rot-btn-criar-canal');
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/canais', {
          method: 'POST',
          headers: headersJson(global),
          body: JSON.stringify({ nome })
        });
        const { ok, status, body } = await parseResposta(resp);
        if (status === 503 && body && body.codigo === 'SCHEMA_CANAIS_INDISPONIVEL') {
          estado.schemaCanaisIndisponivel = true;
          mostrarSchemaCanaisAlerta(true, mensagemSchemaCanais(body));
          definirGravacaoCanais(false);
          return;
        }
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || 'Não foi possível criar o canal.');
          return;
        }
        feedback('sucesso', `Canal ${body.canal && body.canal.nome ? body.canal.nome : nome} cadastrado.`);
        mostrarFormCanal(false);
        await carregarCanais();
        preencherCanais();
        definirGravacaoCanais(!estado.schemaCanaisIndisponivel);
        preencherMeta(estado.config);
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao criar canal.');
      } finally {
        if (btn) btn.disabled = !!estado.schemaCanaisIndisponivel;
      }
    }

    async function salvarNomeCanal(canalId) {
      limparFeedback();
      if (estado.schemaCanaisIndisponivel) {
        feedback('aviso', mensagemSchemaCanais(null));
        return;
      }
      const input = host && host.querySelector(`input.coz-rot-canal-nome-edit[data-id="${canalId}"]`);
      const nome = input ? String(input.value || '').trim() : '';
      if (!nome) {
        feedback('erro', 'Nome do canal é obrigatório.');
        return;
      }
      const btn = host && host.querySelector(`button[data-acao="salvar-nome-canal"][data-id="${canalId}"]`);
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/canais/' + Number(canalId), {
          method: 'PATCH',
          headers: headersJson(global),
          body: JSON.stringify({ nome })
        });
        const { ok, body } = await parseResposta(resp);
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || 'Falha ao atualizar nome.');
          return;
        }
        feedback('sucesso', 'Nome do canal atualizado.');
        await carregarCanais();
        preencherCanais();
        definirGravacaoCanais(!estado.schemaCanaisIndisponivel);
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao atualizar nome.');
      } finally {
        if (btn) btn.disabled = !!estado.schemaCanaisIndisponivel;
      }
    }

    async function alternarAtivoCanal(canalId, ativo) {
      limparFeedback();
      if (estado.schemaCanaisIndisponivel) {
        feedback('aviso', mensagemSchemaCanais(null));
        return;
      }
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/canais/' + Number(canalId), {
          method: 'PATCH',
          headers: headersJson(global),
          body: JSON.stringify({ ativo: !!ativo })
        });
        const { ok, body } = await parseResposta(resp);
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || 'Falha ao alterar situação.');
          return;
        }
        feedback('sucesso', `Canal ${ativo ? 'ativado' : 'desativado'}.`);
        await carregarCanais();
        preencherCanais();
        definirGravacaoCanais(!estado.schemaCanaisIndisponivel);
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao alterar situação.');
      }
    }

    async function salvarDestinoCanal(canalId) {
      limparFeedback();
      if (estado.schemaCanaisIndisponivel) {
        feedback('aviso', mensagemSchemaCanais(null));
        return;
      }
      const sel = host && host.querySelector(`select.coz-rot-canal-unidade[data-id="${canalId}"]`);
      const unidadeId = sel ? Number(sel.value) : NaN;
      if (!Number.isInteger(unidadeId) || unidadeId <= 0) {
        feedback('erro', 'Selecione a unidade de destino do canal.');
        return;
      }
      const btn = host && host.querySelector(`button[data-acao="salvar-destino-canal"][data-id="${canalId}"]`);
      if (btn) btn.disabled = true;
      try {
        const resp = await global.fetch(apiBase(global) + '/cozinha/canais/' + Number(canalId) + '/destino', {
          method: 'PUT',
          headers: headersJson(global),
          body: JSON.stringify({ unidade_id: unidadeId })
        });
        const { ok, body } = await parseResposta(resp);
        if (!ok || !body || body.success === false) {
          feedback('erro', (body && (body.mensagem || body.error || body.codigo)) || 'Falha ao salvar destino.');
          return;
        }
        feedback('sucesso', 'Destino do canal atualizado.');
        await carregarCanais();
        preencherCanais();
        definirGravacaoCanais(!estado.schemaCanaisIndisponivel);
        preencherMeta(estado.config);
      } catch (err) {
        feedback('erro', (err && err.message) || 'Erro de rede ao salvar destino.');
      } finally {
        if (btn) btn.disabled = !!estado.schemaCanaisIndisponivel;
      }
    }

    function ligarEventos() {
      const btnRecarregar = el('#coz-rot-btn-recarregar');
      const btnModo = el('#coz-rot-btn-salvar-modo');
      const btnPadrao = el('#coz-rot-btn-salvar-padrao');
      const btnNovo = el('#coz-rot-btn-novo-canal');
      const btnCriar = el('#coz-rot-btn-criar-canal');
      const btnCancelar = el('#coz-rot-btn-cancelar-canal');
      const tbody = el('#coz-rot-tbody-canais');
      if (btnRecarregar) btnRecarregar.addEventListener('click', () => recarregar());
      if (btnModo) btnModo.addEventListener('click', () => salvarModo());
      if (btnPadrao) btnPadrao.addEventListener('click', () => salvarPadrao());
      if (btnNovo) btnNovo.addEventListener('click', () => { limparFeedback(); mostrarFormCanal(true); });
      if (btnCriar) btnCriar.addEventListener('click', () => criarCanal());
      if (btnCancelar) btnCancelar.addEventListener('click', () => mostrarFormCanal(false));
      host.querySelectorAll('input[name="coz-rot-modo"]').forEach((radio) => {
        radio.addEventListener('change', () => aplicarVisibilidadeModo());
      });
      if (tbody) {
        tbody.addEventListener('click', (ev) => {
          const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-acao]') : null;
          if (!btn) return;
          const id = Number(btn.getAttribute('data-id'));
          const acao = btn.getAttribute('data-acao');
          if (!Number.isInteger(id) || id <= 0) return;
          if (acao === 'salvar-nome-canal') salvarNomeCanal(id);
          else if (acao === 'salvar-destino-canal') salvarDestinoCanal(id);
          else if (acao === 'ativar-canal') alternarAtivoCanal(id, true);
          else if (acao === 'desativar-canal') alternarAtivoCanal(id, false);
        });
      }
      onEmpresa = () => recarregar();
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('cds-empresa-contexto-alterado', onEmpresa);
      }
    }

    function iniciar(container) {
      host = container;
      if (!host) return Promise.resolve();
      host.innerHTML = montarMarkup();
      ligarEventos();
      return recarregar();
    }

    function destruir() {
      if (onEmpresa && global.document && global.document.removeEventListener) {
        global.document.removeEventListener('cds-empresa-contexto-alterado', onEmpresa);
      }
      onEmpresa = null;
      host = null;
    }

    return {
      iniciar,
      destruir,
      recarregar,
      salvarModo,
      salvarPadrao,
      salvarSegmento,
      criarCanal,
      salvarDestinoCanal,
      montarMarkup,
      renderLinhasSegmentos,
      renderLinhasCanais,
      opcoesUnidadesHtml,
      mensagemSchemaIndisponivel,
      mensagemSchemaCanais,
      getEstado: () => ({ ...estado, canais: (estado.canais || []).slice() })
    };
  }

  return {
    MODO_PADRAO,
    MODO_SEGMENTO,
    SEGMENTOS_FALLBACK,
    UNIDADES_DEMO_PREVIA,
    montarNoNavegador,
    montarMarkup,
    renderLinhasSegmentos,
    renderLinhasCanais,
    opcoesUnidadesHtml,
    mensagemSchemaIndisponivel,
    mensagemSchemaCanais,
    labelModo,
    labelSegmento,
    escapar
  };
}));
