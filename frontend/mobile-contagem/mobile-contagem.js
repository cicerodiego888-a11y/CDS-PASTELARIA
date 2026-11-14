/**
 * Contagem Física mobile.
 * Consome as mesmas APIs e os mesmos cálculos da tela desktop.
 * Não converte quantidade no cliente e não grava estoque antes da confirmação.
 */
(function (root) {
  'use strict';

  const api = {};
  const BUSCA = '/api/estoque/contagem-fisica/produtos-busca';
  const SALDO = '/api/estoque/contagem-fisica/saldo-atual';
  const PREVIEW = '/api/estoque/contagem-fisica/preview';
  const CONFIRMAR = '/api/estoque/contagem-fisica';
  const HISTORICO = '/api/estoque/contagem-fisica/historico';

  function ui() {
    return root.__cdsContagemEstoqueTest || null;
  }

  function $(id) {
    return root.document ? root.document.getElementById(id) : null;
  }

  function escapeHtml(valor) {
    return String(valor == null ? '' : valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatarQtd(valor) {
    const oficial = ui();
    if (oficial && typeof oficial.formatarQtd === 'function') return oficial.formatarQtd(valor);
    if (valor == null || valor === '') return '—';
    const n = Number(valor);
    return Number.isFinite(n) ? String(n) : '—';
  }

  function usuario() {
    try { return JSON.parse(root.localStorage.getItem('user') || 'null'); } catch (_e) { return null; }
  }

  function podeOperar(user) {
    if (typeof root.podeAjustarEstoque === 'function') return !!root.podeAjustarEstoque(user);
    const atual = user || usuario();
    if (!atual) return false;
    const perfil = String(atual.perfil || atual.nivel || '').trim().toUpperCase();
    return atual.role === 'admin' || perfil === 'SUPER_ADMIN' || perfil === 'ADMIN';
  }
  api.podeOperar = podeOperar;

  function f12Ativo() {
    if (typeof root.modoFiscalAtivoSistema === 'function') return !!root.modoFiscalAtivoSistema();
    if (typeof root.modoFiscalQueryParam === 'function') return root.modoFiscalQueryParam() === '1';
    try { return root.localStorage.getItem('pdv_modo_fiscal_ativo') === '1'; } catch (_e) { return true; }
  }
  api.f12Ativo = f12Ativo;

  function estadoInicial() {
    const oficial = ui();
    if (oficial && typeof oficial.estadoInicialAjusteDirecionado === 'function') {
      return oficial.estadoInicialAjusteDirecionado();
    }
    return { operacao: 'AJUSTE_DIRECIONADO', tipo: 'BAIXA', ligado: false, rotulo: 'BAIXA DE ESTOQUE' };
  }
  api.estadoInicial = estadoInicial;

  function authHeaders(extra) {
    const h = Object.assign({
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + ((root.localStorage && root.localStorage.getItem('token')) || '')
    }, extra || {});
    if (root.CdsEmpresaContexto && typeof root.CdsEmpresaContexto.headersJson === 'function') {
      const ctx = root.CdsEmpresaContexto.headersJson();
      if (ctx['X-Empresa-Id']) h['X-Empresa-Id'] = ctx['X-Empresa-Id'];
    }
    return h;
  }
  api.authHeaders = authHeaders;

  function empresaLabel() {
    const contexto = root.CdsEmpresaContexto;
    const empresa = contexto && typeof contexto.lerEmpresa === 'function' ? contexto.lerEmpresa() : null;
    if (!empresa) return 'Empresa não selecionada';
    return empresa.nome_fantasia || empresa.razao_social || ('Empresa #' + empresa.id);
  }

  function corpoPreview(produto, qf, qnf, opts) {
    const o = opts || {};
    const f12 = !!o.f12On;
    const body = {
      produto_id: Number(produto.id || produto.produto_id),
      quantidade_fiscal_informada: qf,
      unidade_informada: produto.unidade_comercial || produto.unidade_informada || produto.unidade,
      modo_fiscal: f12 ? '1' : '0',
      omitir_nao_fiscal: f12
    };
    if (produto.apresentacao_id != null && produto.apresentacao_id !== '') {
      body.apresentacao_id = produto.apresentacao_id;
    }
    if (!f12) body.quantidade_nao_fiscal_informada = qnf;
    if (o.operacao === 'CONTAGEM_FISICA') {
      body.operacao = 'CONTAGEM_FISICA';
    } else {
      body.operacao = 'AJUSTE_DIRECIONADO';
      body.tipo_ajuste = o.tipoAjuste || 'BAIXA';
    }
    return body;
  }
  api.corpoPreview = corpoPreview;

  function contextoDaLinha(linha, tipoOverride) {
    if (tipoOverride === 'BAIXA' || tipoOverride === 'ACRESCIMO') {
      return { operacao: 'AJUSTE_DIRECIONADO', tipoAjuste: tipoOverride };
    }
    if (linha && (linha.tipo_ajuste === 'BAIXA' || linha.tipo_ajuste === 'ACRESCIMO')) {
      return { operacao: 'AJUSTE_DIRECIONADO', tipoAjuste: linha.tipo_ajuste };
    }
    return { operacao: 'CONTAGEM_FISICA', tipoAjuste: null };
  }
  api.contextoDaLinha = contextoDaLinha;

  function itemApi(linha) {
    const oficial = ui();
    if (!oficial || typeof oficial.itemConfirmacaoApi !== 'function') {
      throw new Error('A confirmação oficial da contagem não está disponível.');
    }
    return oficial.itemConfirmacaoApi(linha);
  }

  function montarConfirmacao(linhas, extra) {
    const o = extra || {};
    const f12 = !!o.f12On;
    const chave = o.chave;
    return {
      url: CONFIRMAR,
      method: 'POST',
      headers: { 'Idempotency-Key': chave },
      body: {
        observacao: o.observacao || undefined,
        chave_idempotencia: chave,
        modo_fiscal: f12 ? '1' : '0',
        omitir_nao_fiscal: f12,
        itens: (linhas || []).map(itemApi)
      }
    };
  }
  api.montarConfirmacao = montarConfirmacao;

  function aplicarSucesso(estado) {
    const atual = estado || {};
    atual.linhas = [];
    atual.operacao = 'AJUSTE_DIRECIONADO';
    atual.tipo = 'BAIXA';
    atual.chave = null;
    atual.confirmando = false;
    atual.produto = null;
    atual.preview = null;
    return atual;
  }
  api.aplicarSucesso = aplicarSucesso;

  function resumo(linhas) {
    const oficial = ui();
    if (oficial && typeof oficial.resumoDirecionado === 'function') return oficial.resumoDirecionado(linhas);
    return { produtos: (linhas || []).length, baixas: 0, acrescimos: 0, contagens: 0, por_unidade: {} };
  }
  api.resumo = resumo;

  api.endpoints = { BUSCA: BUSCA, SALDO: SALDO, PREVIEW: PREVIEW, CONFIRMAR: CONFIRMAR, HISTORICO: HISTORICO };

  const estado = aplicarSucesso({});
  estado.editando = null;
  estado.seqBusca = 0;
  estado.seqCalc = 0;
  let buscaTimer = null;
  let calcTimer = null;

  function mostrarAlerta(texto) {
    const el = $('mc-alerta');
    if (!el) return;
    el.hidden = !texto;
    el.textContent = texto || '';
  }

  function rotuloSwitch(tipo) {
    const oficial = ui();
    if (oficial && typeof oficial.rotuloTipoAjuste === 'function') return oficial.rotuloTipoAjuste(tipo);
    return tipo === 'ACRESCIMO' ? 'ACRÉSCIMO DE ESTOQUE' : 'BAIXA DE ESTOQUE';
  }

  function pintarSwitch() {
    const btn = $('mc-switch');
    const rotulo = $('mc-switch-rotulo');
    if (!btn) return;
    const direcionado = estado.operacao !== 'CONTAGEM_FISICA';
    btn.hidden = !direcionado;
    const ligado = direcionado && estado.tipo === 'ACRESCIMO';
    btn.classList.toggle('is-on', ligado);
    btn.classList.toggle('is-off', !ligado);
    btn.setAttribute('aria-pressed', ligado ? 'true' : 'false');
    if (rotulo) rotulo.textContent = rotuloSwitch(ligado ? 'ACRESCIMO' : 'BAIXA');
    const ajuda = $('mc-modo-ajuda');
    if (ajuda) {
      ajuda.textContent = direcionado
        ? 'A quantidade informada é a movimentação. OFF retira do saldo e ON soma ao saldo.'
        : 'Informe a quantidade física encontrada. A diferença é calculada sobre o saldo atual.';
    }
    const ajuste = $('mc-modo-ajuste');
    const absoluta = $('mc-modo-absoluta');
    if (ajuste) ajuste.classList.toggle('is-ativa', direcionado);
    if (absoluta) absoluta.classList.toggle('is-ativa', !direcionado);
    const f12 = f12Ativo();
    const labelQf = $('mc-label-qf');
    const labelQnf = $('mc-label-qnf');
    const wrap = $('mc-wrap-qnf');
    if (wrap) wrap.hidden = f12;
    if (labelQf) {
      if (!direcionado) labelQf.textContent = f12 ? 'Quantidade física encontrada' : 'Quantidade fiscal contada';
      else labelQf.textContent = f12 ? 'Quantidade para ajuste' : 'Quantidade fiscal para ajuste';
    }
    if (labelQnf) {
      labelQnf.textContent = direcionado ? 'Quantidade não fiscal para ajuste' : 'Qtd não fiscal contada';
    }
    pintarContexto();
  }

  function pintarContexto() {
    const ctx = $('mc-contexto');
    if (!ctx) return;
    const f12 = f12Ativo();
    ctx.textContent = empresaLabel() + ' · ' + (f12 ? 'F12 ON — somente quantidade fiscal' : 'F12 OFF — fiscal e não fiscal');
  }

  function textoSaldo(rotulo, anterior, previsto, unidade) {
    return '<p>' + escapeHtml(rotulo) + ': ' + escapeHtml(formatarQtd(anterior)) + ' ' + escapeHtml(unidade || '')
      + ' → ' + escapeHtml(formatarQtd(previsto)) + ' ' + escapeHtml(unidade || '') + '</p>';
  }

  function htmlPreview(data) {
    if (!data) return '';
    const oficial = ui();
    const un = data.unidade_base || '';
    let html = '<p><strong>Conversão</strong></p>';
    if (oficial && typeof oficial.textoConversao === 'function') {
      html += '<p>' + escapeHtml(oficial.textoConversao(data, 'fiscal')) + '</p>';
      if (!data.omitir_nao_fiscal) html += '<p>Não fiscal: ' + escapeHtml(oficial.textoConversao(data, 'nf')) + '</p>';
    }
    if (data.operacao === 'AJUSTE_DIRECIONADO') {
      const cls = data.tipo_ajuste === 'ACRESCIMO' ? 'mc-entrada' : 'mc-baixa';
      html += '<p class="' + cls + '">' + escapeHtml(rotuloSwitch(data.tipo_ajuste)) + '</p>';
      html += textoSaldo('Saldo fiscal', data.saldo_fiscal_anterior, data.saldo_fiscal_previsto, un);
      if (!data.omitir_nao_fiscal) {
        html += textoSaldo('Saldo não fiscal', data.saldo_nao_fiscal_anterior, data.saldo_nao_fiscal_previsto, un);
      }
    } else {
      html += '<p>Quantidade física: ' + escapeHtml(formatarQtd(data.quantidade_fiscal_contada)) + ' ' + escapeHtml(un) + '</p>';
      html += textoSaldo('Saldo fiscal', data.saldo_fiscal_anterior, data.quantidade_fiscal_contada, un);
    }
    html += '<p class="mp-ajuda">Aguardando confirmação. O estoque ainda não foi movimentado.</p>';
    return html;
  }

  function pintarProduto() {
    const box = $('mc-produto');
    if (!box) return;
    if (!estado.produto) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const p = estado.produto;
    const saldo = estado.saldo;
    box.hidden = false;
    box.innerHTML = '<h3>' + escapeHtml(p.nome || '') + '</h3>'
      + '<p>Código: ' + escapeHtml(p.codigo || '—') + '</p>'
      + '<p>Unidade comercial: ' + escapeHtml(p.unidade_comercial || p.unidade || 'UN') + '</p>'
      + '<p>Unidade de estoque: ' + escapeHtml((saldo && saldo.unidade_base) || p.unidade_base || '—') + '</p>'
      + '<p>Saldo fiscal: ' + escapeHtml(formatarQtd(saldo && (saldo.saldo_fiscal_atual != null ? saldo.saldo_fiscal_atual : saldo.saldo_fiscal_esperado)))
      + ' ' + escapeHtml((saldo && saldo.unidade_base) || '') + '</p>'
      + (f12Ativo() ? '<p>Não fiscal preservado.</p>'
        : '<p>Saldo não fiscal: ' + escapeHtml(formatarQtd(saldo && saldo.saldo_nao_fiscal_atual)) + '</p>')
      + (saldo && saldo.fator_conversao != null
        ? '<p>Conversão: ' + escapeHtml(formatarQtd(saldo.fator_conversao)) + ' ' + escapeHtml(saldo.unidade_base || '') + ' por unidade.</p>'
        : '');
  }

  function htmlCartao(linha, idx) {
    const un = linha.unidade_base || '';
    const comercial = linha.unidade_informada || '';
    const tipo = linha.tipo_ajuste === 'ACRESCIMO'
      ? 'ACRÉSCIMO'
      : (linha.tipo_ajuste === 'BAIXA' ? 'BAIXA' : 'CONTAGEM FÍSICA');
    const cls = linha.tipo_ajuste === 'ACRESCIMO' ? 'mc-entrada' : (linha.tipo_ajuste === 'BAIXA' ? 'mc-baixa' : '');
    const editando = estado.editando === idx;
    const qtd = editando
      ? '<label class="mp-label">Quantidade fiscal<input class="mp-campo" data-mc-eqf="' + idx + '" type="number" min="0" step="0.000001" value="'
        + escapeHtml(linha.quantidade_fiscal_informada != null ? linha.quantidade_fiscal_informada : '') + '"></label>'
        + (f12Ativo() || linha.omitir_nao_fiscal ? ''
          : '<label class="mp-label">Quantidade não fiscal<input class="mp-campo" data-mc-eqnf="' + idx + '" type="number" min="0" step="0.000001" value="'
            + escapeHtml(linha.quantidade_nao_fiscal_informada != null ? linha.quantidade_nao_fiscal_informada : '') + '"></label>')
      : '<p>Quantidade: ' + escapeHtml(formatarQtd(linha.quantidade_fiscal_informada)) + ' ' + escapeHtml(comercial) + '</p>';
    return '<article class="mc-card">'
      + '<h3>' + escapeHtml(linha.produto_nome || ('Produto #' + linha.produto_id)) + '</h3>'
      + '<p>Código: ' + escapeHtml(linha.produto_codigo || '—') + '</p>'
      + qtd
      + '<p>Conversão: ' + escapeHtml(formatarQtd(linha.quantidade_fiscal_contada)) + ' ' + escapeHtml(un) + '</p>'
      + '<p class="' + cls + '">Operação: ' + escapeHtml(tipo) + '</p>'
      + textoSaldo('Saldo fiscal', linha.saldo_fiscal_anterior, linha.saldo_fiscal_previsto, un)
      + (f12Ativo() || linha.omitir_nao_fiscal ? '' : textoSaldo('Saldo não fiscal', linha.saldo_nao_fiscal_anterior, linha.saldo_nao_fiscal_previsto, un))
      + '<button type="button" class="mp-btn" data-mc-edit="' + idx + '">Editar</button>'
      + '<button type="button" class="mp-btn" data-mc-rm="' + idx + '">Remover</button>'
      + '</article>';
  }

  function pintarResumo(alvo) {
    if (!alvo) return;
    const r = resumo(estado.linhas);
    const inconsistentes = estado.linhas.filter(function (l) { return l.saldo_insuficiente; }).length;
    alvo.innerHTML = '<div class="mc-kpi"><strong>' + r.produtos + '</strong><span>Produtos</span></div>'
      + '<div class="mc-kpi"><strong>' + r.baixas + '</strong><span>Baixas</span></div>'
      + '<div class="mc-kpi"><strong>' + r.acrescimos + '</strong><span>Acréscimos</span></div>'
      + '<div class="mc-kpi"><strong>' + inconsistentes + '</strong><span>Inconsistências</span></div>';
  }

  function pintarLista() {
    const lista = $('mc-lista');
    const resumoEl = $('mc-resumo');
    pintarResumo(resumoEl);
    if (!lista) return;
    if (!estado.linhas.length) {
      lista.innerHTML = '<p class="mp-ajuda">Nenhum produto na contagem. Aguardando confirmação.</p>';
      return;
    }
    lista.innerHTML = estado.linhas.map(htmlCartao).join('');
    lista.querySelectorAll('[data-mc-rm]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const oficial = ui();
        const idx = Number(btn.getAttribute('data-mc-rm'));
        estado.linhas = oficial ? oficial.removerDaLista(estado.linhas, idx) : estado.linhas.filter(function (_l, i) { return i !== idx; });
        estado.editando = null;
        pintarLista();
      });
    });
    lista.querySelectorAll('[data-mc-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        estado.editando = Number(btn.getAttribute('data-mc-edit'));
        pintarLista();
      });
    });
    lista.querySelectorAll('[data-mc-eqf], [data-mc-eqnf]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const idx = Number(inp.getAttribute('data-mc-eqf') || inp.getAttribute('data-mc-eqnf'));
        if (calcTimer) clearTimeout(calcTimer);
        calcTimer = setTimeout(function () { salvarEdicao(idx); }, 280);
      });
    });
  }

  async function postJson(url, body, extraHeaders) {
    const res = await root.fetch(url, {
      method: 'POST',
      headers: authHeaders(extraHeaders),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      const err = new Error(data.error || 'Falha na contagem.');
      err.code = data.code || null;
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function calcular(produto, qf, qnf, opts) {
    return postJson(PREVIEW, corpoPreview(produto, qf, qnf, Object.assign({ f12On: f12Ativo() }, opts || {})));
  }

  function lerQtd(id) {
    const el = $(id);
    if (!el || el.closest('[hidden]')) return { vazio: true };
    const raw = String(el.value == null ? '' : el.value).trim();
    if (raw === '') return { vazio: true };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { invalido: true };
    return { valor: raw };
  }

  async function incluir() {
    if (!estado.produto) {
      mostrarAlerta('Selecione um produto na pesquisa.');
      return;
    }
    const qf = lerQtd('mc-qf');
    const qnf = f12Ativo() ? { valor: undefined } : lerQtd('mc-qnf');
    if (qf.vazio || qnf.vazio) {
      mostrarAlerta('Informe a quantidade.');
      return;
    }
    if (qf.invalido || qnf.invalido) {
      mostrarAlerta('Informe uma quantidade maior ou igual a zero.');
      return;
    }
    const data = await calcular(estado.produto, qf.valor, qnf.valor, {
      operacao: estado.operacao,
      tipoAjuste: estado.tipo
    });
    const oficial = ui();
    const resultado = oficial.incluirNaLista(estado.linhas, data, estado.produto);
    if (!resultado.ok && resultado.code === 'PRODUTO_JA_NA_LISTA') {
      mostrarAlerta('Produto já está na lista. Edite o item existente.');
      estado.editando = resultado.indice;
      pintarLista();
      return;
    }
    if (!resultado.ok && resultado.code === 'SALDO_INSUFICIENTE') {
      mostrarAlerta('Saldo insuficiente para a baixa. A quantidade solicitada é maior que o saldo disponível.');
      return;
    }
    if (!resultado.ok) {
      mostrarAlerta('Pré-visualização sem snapshot. Atualize e tente novamente.');
      return;
    }
    estado.linhas = resultado.linhas;
    mostrarAlerta('');
    pintarLista();
  }

  async function salvarEdicao(idx) {
    const atual = estado.linhas[idx];
    if (!atual) return;
    const qfEl = root.document.querySelector('[data-mc-eqf="' + idx + '"]');
    const qnfEl = root.document.querySelector('[data-mc-eqnf="' + idx + '"]');
    if (!qfEl || String(qfEl.value).trim() === '') return;
    const seq = ++estado.seqCalc;
    const ctx = contextoDaLinha(atual);
    try {
      const data = await calcular({
        id: atual.produto_id,
        unidade_comercial: atual.unidade_informada,
        apresentacao_id: atual.apresentacao_id
      }, String(qfEl.value).trim(), qnfEl ? String(qnfEl.value).trim() : undefined, ctx);
      if (seq !== estado.seqCalc) return;
      const oficial = ui();
      const atualizado = oficial.atualizarLinhaPorPreview(estado.linhas, idx, data, {
        nome: atual.produto_nome,
        codigo: atual.produto_codigo,
        apresentacao_id: atual.apresentacao_id,
        unidade_base: atual.unidade_base
      });
      if (!atualizado.ok) return;
      estado.linhas = atualizado.linhas;
      if (data.saldo_insuficiente) {
        mostrarAlerta('Saldo insuficiente para a baixa. A confirmação deste item está bloqueada.');
      }
      pintarLista();
    } catch (err) {
      if (seq !== estado.seqCalc) return;
      mostrarAlerta(err.message || 'Falha ao recalcular o item.');
    }
  }

  function pintarRevisao() {
    const box = $('mc-resumo-final');
    if (!box) return;
    pintarResumo(box);
    box.innerHTML += estado.linhas.map(function (l) {
      return '<p>' + escapeHtml(l.produto_nome || '') + ': '
        + escapeHtml(formatarQtd(l.saldo_fiscal_anterior)) + ' → '
        + escapeHtml(formatarQtd(l.saldo_fiscal_previsto)) + ' ' + escapeHtml(l.unidade_base || '') + '</p>';
    }).join('');
  }

  async function confirmar() {
    if (estado.confirmando) return;
    if (!estado.linhas.length) {
      mostrarAlerta('Inclua ao menos um produto.');
      return;
    }
    if (estado.linhas.some(function (l) { return l.saldo_insuficiente || l.saldo_fiscal_esperado == null; })) {
      mostrarAlerta('Há item sem saldo suficiente ou sem snapshot. A confirmação foi bloqueada.');
      return;
    }
    if (!estado.chave) {
      estado.chave = 'contagem-mobile-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    }
    const obs = $('mc-obs');
    const pedido = montarConfirmacao(estado.linhas, {
      f12On: f12Ativo(),
      chave: estado.chave,
      observacao: obs ? String(obs.value || '').trim() : ''
    });
    const btn = $('mc-confirmar');
    estado.confirmando = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Confirmando…';
    }
    try {
      const data = await postJson(pedido.url, pedido.body, pedido.headers);
      const resultado = $('mc-resultado');
      if (resultado) {
        resultado.hidden = false;
        resultado.innerHTML = '<h2>Contagem confirmada</h2><p>Registro #' + escapeHtml(data.id) + '.</p>'
          + (data.itens || []).map(function (item) {
            return '<p>Produto ' + escapeHtml(item.produto_id) + ': '
              + escapeHtml(item.tipo_ajuste || 'CONTAGEM FÍSICA') + '</p>';
          }).join('');
      }
      aplicarSucesso(estado);
      estado.editando = null;
      if ($('mc-qf')) $('mc-qf').value = '';
      if ($('mc-qnf')) $('mc-qnf').value = '';
      if ($('mc-obs')) $('mc-obs').value = '';
      const painel = $('mc-painel-confirmar');
      if (painel) painel.hidden = true;
      pintarSwitch();
      pintarProduto();
      pintarLista();
      const prev = $('mc-preview');
      if (prev) prev.innerHTML = '';
      mostrarAlerta('');
      carregarHistorico();
    } catch (err) {
      estado.confirmando = false;
      if (err.code === 'CONTAGEM_DESATUALIZADA') {
        estado.chave = null;
        mostrarAlerta('A observação está desatualizada. Atualize a pré-visualização e confirme novamente. Nenhuma movimentação foi concluída.');
      } else if (err.code === 'SALDO_INSUFICIENTE') {
        mostrarAlerta(err.message || 'Saldo insuficiente para a baixa.');
      } else if (err.status === 403) {
        mostrarAlerta('Acesso não autorizado.');
      } else {
        mostrarAlerta(err.message || 'Falha ao confirmar a contagem. A lista foi preservada.');
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'CONFIRMAR CONTAGEM';
      }
    }
  }

  async function pesquisar() {
    const campo = $('mc-busca');
    const termo = campo ? String(campo.value || '').trim() : '';
    const seq = ++estado.seqBusca;
    const lista = $('mc-busca-lista');
    const status = $('mc-busca-status');
    if (termo.length < 1) {
      if (lista) lista.innerHTML = '';
      return;
    }
    if (status) {
      status.hidden = false;
      status.textContent = 'Pesquisando…';
    }
    try {
      const res = await root.fetch(BUSCA + '?q=' + encodeURIComponent(termo) + '&limite=20', {
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (seq !== estado.seqBusca) return;
      if (res.status === 403) {
        mostrarAlerta(data.error || 'Acesso não autorizado.');
        return;
      }
      const itens = Array.isArray(data.itens) ? data.itens : [];
      if (status) status.textContent = itens.length ? '' : 'Nenhum produto encontrado.';
      if (!lista) return;
      lista.innerHTML = itens.map(function (p) {
        return '<button type="button" data-mc-prod="' + escapeHtml(p.id) + '">'
          + escapeHtml(p.nome || '') + '<small>'
          + escapeHtml(p.codigo || '') + ' · ' + escapeHtml(p.unidade_comercial || p.unidade || 'UN')
          + '</small></button>';
      }).join('');
      lista.querySelectorAll('[data-mc-prod]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const id = Number(btn.getAttribute('data-mc-prod'));
          const hit = itens.find(function (p) { return Number(p.id) === id; });
          if (hit) selecionarProduto(hit);
        });
      });
    } catch (err) {
      if (seq !== estado.seqBusca) return;
      mostrarAlerta(err.message || 'Falha na pesquisa.');
    }
  }

  async function selecionarProduto(produto) {
    estado.produto = {
      id: Number(produto.id),
      nome: produto.nome || '',
      codigo: produto.codigo || null,
      unidade_comercial: produto.unidade_comercial || produto.unidade || 'UN',
      unidade_base: produto.unidade_base || null,
      apresentacao_id: produto.apresentacao_id || null
    };
    const busca = $('mc-busca');
    if (busca) busca.value = estado.produto.nome;
    if ($('mc-busca-lista')) $('mc-busca-lista').innerHTML = '';
    estado.saldo = null;
    pintarProduto();
    try {
      const res = await root.fetch(SALDO + '?produto_id=' + encodeURIComponent(estado.produto.id), {
        headers: authHeaders()
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Falha ao consultar o saldo.');
      estado.saldo = data;
      if (data.apresentacao_id) estado.produto.apresentacao_id = data.apresentacao_id;
      if (data.unidade_base) estado.produto.unidade_base = data.unidade_base;
      pintarProduto();
    } catch (err) {
      mostrarAlerta(err.message || 'Falha ao consultar o saldo.');
    }
  }

  async function carregarHistorico() {
    const box = $('mc-historico');
    if (!box || !podeOperar()) return;
    try {
      const res = await root.fetch(HISTORICO + '?limite=8', { headers: authHeaders() });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) return;
      const itens = Array.isArray(data.itens) ? data.itens : [];
      box.innerHTML = itens.length ? itens.map(function (h) {
        return '<p class="mp-item">' + escapeHtml(h.id) + ' · ' + escapeHtml(h.resultado || 'CONFIRMADA')
          + ' · ' + escapeHtml(h.quantidade_produtos != null ? h.quantidade_produtos : '') + ' produtos</p>';
      }).join('') : '<p class="mp-ajuda">Nenhuma contagem confirmada ainda.</p>';
    } catch (_e) { /* histórico é consulta; a falha não movimenta estoque */ }
  }

  function exigirSessao() {
    let token = '';
    try { token = root.localStorage.getItem('token') || ''; } catch (_e) { token = ''; }
    if (token) return true;
    if (root.location && typeof root.location.replace === 'function') {
      root.location.replace('/login?next=/mobile-contagem');
    }
    return false;
  }

  function iniciar() {
    if (!root.document || !$('mc-app')) return;
    if (!exigirSessao()) return;
    const emp = $('mc-empresa');
    if (emp) emp.textContent = empresaLabel();
    const op = $('mc-operador');
    const atual = usuario();
    if (op) op.textContent = atual && (atual.nome || atual.username) ? ('Operador: ' + (atual.nome || atual.username)) : '';
    pintarContexto();
    if (!podeOperar()) {
      const bloqueio = $('mc-bloqueio');
      const operacao = $('mc-operacao');
      if (bloqueio) bloqueio.hidden = false;
      if (operacao) operacao.hidden = true;
      return;
    }
    pintarSwitch();
    pintarLista();
    const busca = $('mc-busca');
    if (busca) {
      busca.addEventListener('input', function () {
        if (buscaTimer) clearTimeout(buscaTimer);
        buscaTimer = setTimeout(pesquisar, 280);
      });
    }
    const modoAjuste = $('mc-modo-ajuste');
    const modoAbs = $('mc-modo-absoluta');
    if (modoAjuste) {
      modoAjuste.addEventListener('click', function () {
        estado.operacao = 'AJUSTE_DIRECIONADO';
        if (estado.tipo !== 'ACRESCIMO') estado.tipo = 'BAIXA';
        pintarSwitch();
      });
    }
    if (modoAbs) {
      modoAbs.addEventListener('click', function () {
        estado.operacao = 'CONTAGEM_FISICA';
        pintarSwitch();
      });
    }
    const sw = $('mc-switch');
    if (sw) {
      sw.addEventListener('click', function () {
        estado.tipo = estado.tipo === 'ACRESCIMO' ? 'BAIXA' : 'ACRESCIMO';
        pintarSwitch();
      });
    }
    const incluirBtn = $('mc-incluir');
    if (incluirBtn) incluirBtn.addEventListener('click', function () { incluir().catch(function (err) { mostrarAlerta(err.message); }); });
    const revisar = $('mc-revisar');
    if (revisar) {
      revisar.addEventListener('click', function () {
        const painel = $('mc-painel-confirmar');
        if (!painel) return;
        pintarRevisao();
        painel.hidden = false;
        painel.scrollIntoView({ block: 'start' });
      });
    }
    const voltar = $('mc-confirmar-voltar');
    if (voltar) voltar.addEventListener('click', function () { const p = $('mc-painel-confirmar'); if (p) p.hidden = true; });
    const confirmarBtn = $('mc-confirmar');
    if (confirmarBtn) confirmarBtn.addEventListener('click', function () { confirmar().catch(function (err) { mostrarAlerta(err.message); }); });
    carregarHistorico();
  }

  api.exigirSessao = exigirSessao;
  root.MobileContagem = api;

  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
  }
})(typeof window !== 'undefined' ? window : globalThis);
