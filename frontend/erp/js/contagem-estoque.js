/**
 * Contagem física mínima F×NF — CDS-ESTOQUE-MANUAL-01.
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
    if (root.CdsEmpresaContexto && typeof root.CdsEmpresaContexto.getEmpresaId === 'function') {
      const id = Number(root.CdsEmpresaContexto.getEmpresaId());
      if (Number.isInteger(id) && id > 0) return id;
    }
    const h = authHeaders();
    const fromHeader = Number(h['X-Empresa-Id']);
    return Number.isInteger(fromHeader) && fromHeader > 0 ? fromHeader : null;
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

  let linhas = [];

  function render() {
    const rootEl = document.getElementById('page-content');
    if (!rootEl) return;
    const emp = empresaIdAtual();
    rootEl.innerHTML = `
      <div class="container-fluid py-3">
        <h2 class="h4">Contagem física de estoque</h2>
        <p class="text-muted">Informe separadamente a quantidade física fiscal e não fiscal. Motivo/observação é opcional.</p>
        <p class="small">Empresa do contexto: <strong>${emp != null ? emp : 'não selecionada'}</strong></p>
        <div class="card mb-3"><div class="card-body">
          <div class="row g-2 align-items-end">
            <div class="col-md-2"><label class="form-label">Produto ID</label>
              <input id="cef-produto" class="form-control" type="number" min="1"></div>
            <div class="col-md-2"><label class="form-label">Qtd fiscal contada</label>
              <input id="cef-qf" class="form-control" type="number" min="0" step="0.000001" value="0"></div>
            <div class="col-md-2"><label class="form-label">Qtd não fiscal contada</label>
              <input id="cef-qnf" class="form-control" type="number" min="0" step="0.000001" value="0"></div>
            <div class="col-md-3"><label class="form-label">Observação (opcional)</label>
              <input id="cef-obs" class="form-control" maxlength="500"></div>
            <div class="col-md-3">
              <button type="button" class="btn btn-outline-primary" id="cef-preview">Calcular diferenças</button>
              <button type="button" class="btn btn-outline-secondary" id="cef-add">Incluir na lista</button>
            </div>
          </div>
          <div id="cef-preview-box" class="mt-3 small text-muted"></div>
        </div></div>
        <div class="table-responsive">
          <table class="table table-sm align-middle">
            <thead><tr>
              <th>Produto</th><th>Saldo F ant.</th><th>Saldo NF ant.</th>
              <th>Contado F</th><th>Contado NF</th><th>Dif. F</th><th>Dif. NF</th><th></th>
            </tr></thead>
            <tbody id="cef-tbody"></tbody>
          </table>
        </div>
        <button type="button" class="btn btn-primary" id="cef-confirmar">Confirmar contagem</button>
        <button type="button" class="btn btn-link" id="cef-voltar">Voltar às empresas</button>
        <div id="cef-resultado" class="mt-3"></div>
      </div>`;
    document.getElementById('cef-preview').addEventListener('click', previewLinha);
    document.getElementById('cef-add').addEventListener('click', adicionarLinha);
    document.getElementById('cef-confirmar').addEventListener('click', confirmar);
    document.getElementById('cef-voltar').addEventListener('click', function () {
      if (typeof root.loadPage === 'function') root.loadPage('empresas');
    });
    pintarTabela();
  }

  function pintarTabela() {
    const tb = document.getElementById('cef-tbody');
    if (!tb) return;
    tb.innerHTML = linhas.map(function (l, idx) {
      return `<tr>
        <td>${l.produto_id}</td>
        <td>${l.saldo_fiscal_anterior}</td>
        <td>${l.saldo_nao_fiscal_anterior}</td>
        <td>${l.quantidade_fiscal_contada}</td>
        <td>${l.quantidade_nao_fiscal_contada}</td>
        <td>${l.diferenca_fiscal}</td>
        <td>${l.diferenca_nao_fiscal}</td>
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
    const produtoId = Number(document.getElementById('cef-produto').value);
    const qf = document.getElementById('cef-qf').value;
    const qnf = document.getElementById('cef-qnf').value;
    const box = document.getElementById('cef-preview-box');
    try {
      const res = await fetch('/api/estoque/contagem-fisica/preview', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          produto_id: produtoId,
          quantidade_fiscal_contada: qf,
          quantidade_nao_fiscal_contada: qnf
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha no preview');
      box.innerHTML = `Saldo anterior F/NF: <strong>${data.saldo_fiscal_anterior}</strong> /
        <strong>${data.saldo_nao_fiscal_anterior}</strong> · Contado: <strong>${data.quantidade_fiscal_contada}</strong> /
        <strong>${data.quantidade_nao_fiscal_contada}</strong> · Diferença: <strong>${data.diferenca_fiscal}</strong> /
        <strong>${data.diferenca_nao_fiscal}</strong>`;
      return data;
    } catch (err) {
      box.textContent = err.message;
      notify(err.message, 'danger');
      return null;
    }
  }

  async function adicionarLinha() {
    const data = await previewLinha();
    if (!data) return;
    if (linhas.some(function (l) { return Number(l.produto_id) === Number(data.produto_id); })) {
      notify('Produto já está na lista.', 'warning');
      return;
    }
    linhas.push(data);
    pintarTabela();
  }

  async function confirmar() {
    if (!linhas.length) {
      notify('Inclua ao menos um produto.', 'warning');
      return;
    }
    const obs = (document.getElementById('cef-obs').value || '').trim();
    const chave = 'contagem-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try {
      const res = await fetch('/api/estoque/contagem-fisica', {
        method: 'POST',
        headers: Object.assign(authHeaders(), { 'Idempotency-Key': chave }),
        body: JSON.stringify({
          observacao: obs || undefined,
          chave_idempotencia: chave,
          itens: linhas.map(function (l) {
            return {
              produto_id: l.produto_id,
              quantidade_fiscal_contada: l.quantidade_fiscal_contada,
              quantidade_nao_fiscal_contada: l.quantidade_nao_fiscal_contada
            };
          })
        })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha ao confirmar contagem');
      const box = document.getElementById('cef-resultado');
      box.innerHTML = `<div class="alert alert-success">Contagem #${escapeHtml(data.id)} registrada em ${escapeHtml(data.criado_em || '')}
        por ${escapeHtml(data.usuario_nome || data.usuario_id || '—')}.</div>
        <pre class="small bg-light p-2">${escapeHtml(JSON.stringify(data.itens, null, 2))}</pre>`;
      linhas = [];
      pintarTabela();
      notify('Contagem confirmada.', 'success');
    } catch (err) {
      notify(err.message, 'danger');
    }
  }

  function loadContagemEstoque() {
    linhas = [];
    render();
  }

  root.loadContagemEstoque = loadContagemEstoque;
})(typeof window !== 'undefined' ? window : globalThis);
