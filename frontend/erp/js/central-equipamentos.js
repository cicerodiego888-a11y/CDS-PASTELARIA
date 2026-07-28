/**
 * RC3.0 — Central de Equipamentos
 * Consome exclusivamente /api/central-equipamentos/*
 */

let centralEqCache = [];
let centralEqDashboard = null;
let centralEqFiltros = {
  transporte: 'todos',
  status: '',
  busca: '',
  fabricante: '',
  driver: '',
  conhecidos: '',
  novos: '',
  online: '',
  offline: ''
};

function centralEqApi() {
  return (typeof API_URL === 'string' && API_URL.trim() !== '') ? API_URL : `${window.location.origin}/api`;
}

function centralEqHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function escapeHtmlCentralEq(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatarDataCentralEq(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('pt-BR'); } catch (_) { return iso; }
}

function badgeStatusCentral(status, rotulo) {
  const mapa = {
    ONLINE: 'success',
    OFFLINE: 'secondary',
    DESCONHECIDO: 'warning text-dark',
    NUNCA_VISTO: 'info text-dark',
    ALTEROU_IP: 'warning text-dark',
    ALTEROU_FIRMWARE: 'info text-dark',
    SINCRONIZANDO: 'primary',
    ERRO: 'danger'
  };
  const cls = mapa[status] || 'secondary';
  return `<span class="badge bg-${cls}">${escapeHtmlCentralEq(rotulo || status || '—')}</span>`;
}

function badgeHealthCentral(score) {
  const n = Number(score || 0);
  const cls = n >= 80 ? 'success' : (n >= 60 ? 'warning text-dark' : 'danger');
  return `<span class="badge bg-${cls}">${n}</span>`;
}

async function centralEqFetch(path, options = {}) {
  const resp = await fetch(`${centralEqApi()}/central-equipamentos${path}`, {
    ...options,
    headers: { ...centralEqHeaders(), ...(options.headers || {}) }
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
  return body;
}

function loadCentralEquipamentos() {
  $('#page-content').html('<div class="text-center p-5"><div class="spinner-border text-primary"></div><p class="mt-2">Carregando Central de Equipamentos...</p></div>');
  Promise.all([
    centralEqFetch('/dashboard'),
    centralEqFetch(`/lista?${montarQueryCentralEq()}`)
  ])
    .then(([dash, lista]) => {
      centralEqDashboard = dash.dashboard || {};
      centralEqCache = lista.itens || [];
      renderCentralEquipamentos();
    })
    .catch((err) => {
      $('#page-content').html(`<div class="alert alert-danger m-3">${escapeHtmlCentralEq(err.message)}</div>`);
    });
}

function montarQueryCentralEq() {
  const p = new URLSearchParams();
  if (centralEqFiltros.transporte && centralEqFiltros.transporte !== 'todos') {
    p.set('transporte', centralEqFiltros.transporte);
  }
  if (centralEqFiltros.status) p.set('status', centralEqFiltros.status);
  if (centralEqFiltros.busca) p.set('busca', centralEqFiltros.busca);
  if (centralEqFiltros.fabricante) p.set('fabricante', centralEqFiltros.fabricante);
  if (centralEqFiltros.driver) p.set('driver', centralEqFiltros.driver);
  if (centralEqFiltros.conhecidos) p.set('conhecidos', '1');
  if (centralEqFiltros.novos) p.set('novos', '1');
  if (centralEqFiltros.online) p.set('online', '1');
  if (centralEqFiltros.offline) p.set('offline', '1');
  return p.toString();
}

function cardDash(label, valor, extraClass = '') {
  return `
    <div class="col-6 col-md-3 col-xl-2 mb-2">
      <div class="card ${extraClass}">
        <div class="card-body py-2">
          <small class="text-muted">${label}</small>
          <div class="h4 mb-0">${Number(valor || 0)}</div>
        </div>
      </div>
    </div>`;
}

function renderCentralEquipamentos() {
  const d = centralEqDashboard || {};
  const html = `
    <div class="container-fluid py-3">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <div>
          <nav aria-label="breadcrumb"><ol class="breadcrumb mb-1">
            <li class="breadcrumb-item"><a href="#" onclick="loadPage('configuracoes');return false;">Configurações</a></li>
            <li class="breadcrumb-item active">Central de Equipamentos</li>
          </ol></nav>
          <h2 class="h4 mb-1"><i class="fas fa-network-wired me-2"></i>Central de Equipamentos</h2>
          <p class="text-muted mb-0">Painel oficial de equipamentos cadastrados e descobertos.</p>
        </div>
        <div class="d-flex flex-wrap gap-2">
          <button class="btn btn-outline-success" onclick="centralEqDescobrir()"><i class="fas fa-search-location"></i> Descobrir novamente</button>
          <button class="btn btn-outline-secondary" onclick="loadPage('equipamentos')"><i class="fas fa-cog"></i> Cadastro</button>
          <button class="btn btn-primary" onclick="loadCentralEquipamentos()"><i class="fas fa-sync"></i> Atualizar</button>
        </div>
      </div>

      <div class="row mb-3">
        ${cardDash('Total', d.total)}
        ${cardDash('Online', d.online, 'border-success')}
        ${cardDash('Offline', d.offline, 'border-secondary')}
        ${cardDash('Novos', d.novos, 'border-info')}
        ${cardDash('Conhecidos', d.conhecidos, 'border-primary')}
        ${cardDash('Problemas', d.problemas, 'border-danger')}
        ${cardDash('Sincronizando', d.sincronizando, 'border-warning')}
        ${cardDash('Health médio', d.health_medio, 'border-dark')}
      </div>

      <div class="card mb-3">
        <div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-2">
              <label class="form-label small mb-0">Busca</label>
              <input type="text" class="form-control" id="centralEqBusca" value="${escapeHtmlCentralEq(centralEqFiltros.busca)}" placeholder="Nome, IP...">
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">Transporte</label>
              <select class="form-select" id="centralEqTransporte">
                <option value="todos">Todos</option>
                <option value="ethernet" ${centralEqFiltros.transporte === 'ethernet' ? 'selected' : ''}>Ethernet</option>
                <option value="serial" ${centralEqFiltros.transporte === 'serial' ? 'selected' : ''}>Serial</option>
                <option value="usb" ${centralEqFiltros.transporte === 'usb' ? 'selected' : ''}>USB</option>
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">Status</label>
              <select class="form-select" id="centralEqStatus">
                <option value="">Todos</option>
                ${['ONLINE','OFFLINE','DESCONHECIDO','NUNCA_VISTO','ALTEROU_IP','ALTEROU_FIRMWARE','SINCRONIZANDO','ERRO']
                  .map((s) => `<option value="${s}" ${centralEqFiltros.status === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">Fabricante</label>
              <input type="text" class="form-control" id="centralEqFabricante" value="${escapeHtmlCentralEq(centralEqFiltros.fabricante)}" placeholder="Ex: Toledo">
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">Driver</label>
              <input type="text" class="form-control" id="centralEqDriver" value="${escapeHtmlCentralEq(centralEqFiltros.driver)}" placeholder="Ex: TOLEDO">
            </div>
            <div class="col-md-2">
              <button class="btn btn-primary w-100" onclick="aplicarFiltrosCentralEq()"><i class="fas fa-filter"></i> Filtrar</button>
            </div>
            <div class="col-12">
              <div class="form-check form-check-inline">
                <input class="form-check-input" type="checkbox" id="centralEqOnline" ${centralEqFiltros.online ? 'checked' : ''}>
                <label class="form-check-label" for="centralEqOnline">Online</label>
              </div>
              <div class="form-check form-check-inline">
                <input class="form-check-input" type="checkbox" id="centralEqOffline" ${centralEqFiltros.offline ? 'checked' : ''}>
                <label class="form-check-label" for="centralEqOffline">Offline</label>
              </div>
              <div class="form-check form-check-inline">
                <input class="form-check-input" type="checkbox" id="centralEqConhecidos" ${centralEqFiltros.conhecidos ? 'checked' : ''}>
                <label class="form-check-label" for="centralEqConhecidos">Conhecidos</label>
              </div>
              <div class="form-check form-check-inline">
                <input class="form-check-input" type="checkbox" id="centralEqNovos" ${centralEqFiltros.novos ? 'checked' : ''}>
                <label class="form-check-label" for="centralEqNovos">Novos</label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header d-flex justify-content-between">
          <span><i class="fas fa-list"></i> Equipamentos (${centralEqCache.length})</span>
        </div>
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-sm table-hover mb-0 align-middle">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Fabricante/Modelo</th>
                  <th>Driver</th>
                  <th>Transporte</th>
                  <th>Status</th>
                  <th>Identidade</th>
                  <th>Health</th>
                  <th>Último IP</th>
                  <th>Firmware</th>
                  <th>Última comunicação</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>${renderLinhasCentralEq(centralEqCache)}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card mt-3" id="centralEqHistoricoPainel" style="display:none;">
        <div class="card-header d-flex justify-content-between">
          <span><i class="fas fa-history"></i> Histórico / linha do tempo</span>
          <button class="btn btn-sm btn-light" onclick="document.getElementById('centralEqHistoricoPainel').style.display='none'">Fechar</button>
        </div>
        <div class="card-body" id="centralEqHistoricoBody"></div>
      </div>
    </div>
  `;
  $('#page-content').html(html);
}

function renderLinhasCentralEq(itens) {
  if (!itens.length) {
    return '<tr><td colspan="11" class="text-center text-muted py-4">Nenhum equipamento encontrado.</td></tr>';
  }
  return itens.map((it, idx) => `
    <tr>
      <td><strong>${escapeHtmlCentralEq(it.nome)}</strong>
        <br><small class="text-muted">${escapeHtmlCentralEq(it.tipo_origem || '')}</small></td>
      <td>${escapeHtmlCentralEq(it.fabricante || '—')}<br><small class="text-muted">${escapeHtmlCentralEq(it.modelo || '—')}</small></td>
      <td><small>${escapeHtmlCentralEq(it.driver_codigo || '—')}</small></td>
      <td>${escapeHtmlCentralEq(it.transporte || '—')}</td>
      <td>${badgeStatusCentral(it.status_central, it.status_rotulo)}</td>
      <td><small>${escapeHtmlCentralEq(it.identidade_status || '—')}</small>
        ${it.ip_anterior ? `<br><small class="text-warning">${escapeHtmlCentralEq(it.ip_anterior)} → ${escapeHtmlCentralEq(it.ultimo_ip || '')}</small>` : ''}
      </td>
      <td title="${escapeHtmlCentralEq(it.health_rotulo || '')}">${badgeHealthCentral(it.health_score)}</td>
      <td><code>${escapeHtmlCentralEq(it.ultimo_ip || '—')}</code></td>
      <td><small>${escapeHtmlCentralEq(it.ultimo_firmware || '—')}</small></td>
      <td><small>${formatarDataCentralEq(it.ultima_comunicacao || it.ultima_descoberta)}</small></td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-secondary me-1" title="Histórico" onclick="centralEqAbrirHistorico(${idx})"><i class="fas fa-history"></i></button>
        ${it.equipamento_id ? `
          <button class="btn btn-sm btn-outline-info me-1" title="Testar" onclick="centralEqTestar(${it.equipamento_id})"><i class="fas fa-plug"></i></button>
          <button class="btn btn-sm btn-outline-warning me-1" title="Diagnóstico" onclick="centralEqDiagnostico(${it.equipamento_id})"><i class="fas fa-stethoscope"></i></button>
          <button class="btn btn-sm btn-outline-primary me-1" title="Configurações" onclick="loadPage('equipamentos')"><i class="fas fa-cog"></i></button>
        ` : `
          <button class="btn btn-sm btn-outline-success" title="Cadastrar" onclick="centralEqCadastrarIndice(${idx})"><i class="fas fa-plus"></i></button>
        `}
      </td>
    </tr>
  `).join('');
}

function aplicarFiltrosCentralEq() {
  centralEqFiltros.busca = document.getElementById('centralEqBusca')?.value?.trim() || '';
  centralEqFiltros.transporte = document.getElementById('centralEqTransporte')?.value || 'todos';
  centralEqFiltros.status = document.getElementById('centralEqStatus')?.value || '';
  centralEqFiltros.fabricante = document.getElementById('centralEqFabricante')?.value?.trim() || '';
  centralEqFiltros.driver = document.getElementById('centralEqDriver')?.value?.trim() || '';
  centralEqFiltros.online = document.getElementById('centralEqOnline')?.checked ? '1' : '';
  centralEqFiltros.offline = document.getElementById('centralEqOffline')?.checked ? '1' : '';
  centralEqFiltros.conhecidos = document.getElementById('centralEqConhecidos')?.checked ? '1' : '';
  centralEqFiltros.novos = document.getElementById('centralEqNovos')?.checked ? '1' : '';
  loadCentralEquipamentos();
}

async function centralEqDescobrir() {
  try {
    if (typeof showNotification === 'function') showNotification('Iniciando discovery…', 'info');
    const body = await centralEqFetch('/descobrir', {
      method: 'POST',
      body: JSON.stringify({
        transportes: ['ethernet', 'serial', 'usb'],
        timeoutMs: 800,
        persistir_sessao: true
      })
    });
    const n = (body.candidatos || []).length;
    if (typeof showNotification === 'function') {
      showNotification(`Discovery concluído: ${n} candidato(s)`, 'success');
    }
    loadCentralEquipamentos();
  } catch (err) {
    if (typeof showNotification === 'function') showNotification(err.message, 'danger');
  }
}

async function centralEqAbrirHistorico(idx) {
  const it = centralEqCache[idx];
  if (!it) return;
  const painel = document.getElementById('centralEqHistoricoPainel');
  const body = document.getElementById('centralEqHistoricoBody');
  if (!painel || !body) return;
  painel.style.display = '';
  body.innerHTML = '<div class="text-muted">Carregando…</div>';
  try {
    const q = new URLSearchParams();
    if (it.equipamento_id) q.set('equipamento_id', it.equipamento_id);
    if (it.identidade_id) q.set('identidade_id', it.identidade_id);
    const saude = await centralEqFetch(`/saude?${q.toString()}`);
    const hist = await centralEqFetch(`/historico?${q.toString()}&limite=40`);
    const eventos = hist.eventos || [];
    body.innerHTML = `
      <div class="mb-3">
        <strong>Health Score:</strong> ${badgeHealthCentral(saude.saude?.score)}
        <span class="ms-2">${escapeHtmlCentralEq(saude.saude?.rotulo || '')}</span>
        <span class="ms-2">${badgeStatusCentral(saude.saude?.status_central, saude.saude?.status_rotulo)}</span>
      </div>
      <ul class="list-group list-group-flush">
        ${eventos.length ? eventos.map((e) => `
          <li class="list-group-item px-0">
            <div class="d-flex justify-content-between">
              <div>
                <strong>${escapeHtmlCentralEq(e.rotulo || e.evento)}</strong>
                <br><small class="text-muted">${escapeHtmlCentralEq(e.tipo)} · ${escapeHtmlCentralEq(e.evento)}</small>
              </div>
              <small class="text-muted">${formatarDataCentralEq(e.em)}</small>
            </div>
          </li>
        `).join('') : '<li class="list-group-item text-muted">Sem eventos.</li>'}
      </ul>
    `;
  } catch (err) {
    body.innerHTML = `<div class="text-danger">${escapeHtmlCentralEq(err.message)}</div>`;
  }
}

async function centralEqTestar(id) {
  try {
    const body = await centralEqFetch(`/${id}/testar`, { method: 'POST', body: '{}' });
    if (typeof showNotification === 'function') {
      showNotification(body.resultado?.mensagem || 'Teste concluído', 'info');
    }
  } catch (err) {
    if (typeof showNotification === 'function') showNotification(err.message, 'danger');
  }
}

async function centralEqDiagnostico(id) {
  try {
    await centralEqFetch(`/${id}/diagnostico`, { method: 'POST', body: '{}' });
    if (typeof showNotification === 'function') showNotification('Diagnóstico concluído', 'info');
  } catch (err) {
    if (typeof showNotification === 'function') showNotification(err.message, 'danger');
  }
}

async function centralEqCadastrarIndice(idx) {
  const it = centralEqCache[idx];
  if (!it) return;
  const nome = window.prompt('Nome do equipamento:', it.nome || '');
  if (!nome) return;
  try {
    await centralEqFetch('/cadastrar', {
      method: 'POST',
      body: JSON.stringify({
        nome: String(nome).trim(),
        tipo: 'balanca',
        driver_codigo: it.driver_codigo,
        fabricante: it.fabricante,
        modelo: it.modelo,
        transporte: it.transporte || 'ethernet',
        ip: it.ultimo_ip,
        porta_tcp: it.porta_tcp || 9100,
        porta_com: it.porta_com,
        ativo: true,
        observacao: it.identidade_id ? `Central RC3 · identidade=${it.identidade_id}` : 'Central RC3'
      })
    });
    if (typeof showNotification === 'function') showNotification('Equipamento cadastrado', 'success');
    loadCentralEquipamentos();
  } catch (err) {
    if (typeof showNotification === 'function') showNotification(err.message, 'danger');
  }
}
