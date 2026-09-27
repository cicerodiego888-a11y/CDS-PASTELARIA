/**
 * MBC-02/06 — contas, transações, conciliação e autorização Open Finance da empresa do contexto.
 * Sem matching automático. Sem senha bancária na tela.
 */
(function (global) {
  'use strict';

  var instituicoesCache = [];
  var empresasAutorizadasCache = [];
  var contasCache = [];
  var vistaTodas = false;
  var filtroEmpresaId = '';

  function apiUrl() {
    return (typeof API_URL === 'string' && API_URL.trim())
      ? API_URL
      : (global.location.origin + '/api');
  }

  function headersJson() {
    if (global.CdsEmpresaContexto && typeof global.CdsEmpresaContexto.headersJson === 'function') {
      return global.CdsEmpresaContexto.headersJson();
    }
    return { Authorization: 'Bearer ' + (global.localStorage.getItem('token') || '') };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatarCnpj(valor) {
    if (global.CdsEmpresaContexto && global.CdsEmpresaContexto.formatarCnpj) {
      return global.CdsEmpresaContexto.formatarCnpj(valor);
    }
    const d = String(valor == null ? '' : valor).replace(/\D/g, '');
    if (d.length !== 14) return valor == null ? '' : String(valor);
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }

  function nomeEmpresa(emp) {
    if (!emp) return '';
    return String(emp.nome_fantasia || emp.razao_social || emp.empresa_nome || '').trim()
      || ('Empresa #' + (emp.id || emp.empresa_id || ''));
  }

  function rotuloEmpresaOpcao(emp) {
    if (!emp) return '';
    const nome = nomeEmpresa(emp);
    const cnpj = formatarCnpj(emp.cnpj || emp.empresa_cnpj);
    return cnpj ? (nome + ' — ' + cnpj) : nome;
  }

  function rotuloEmpresa() {
    if (vistaTodas) return 'TODAS AS EMPRESAS';
    const ctx = global.CdsEmpresaContexto;
    if (!ctx) return 'Empresa do contexto operacional';
    const emp = ctx.lerEmpresa && ctx.lerEmpresa();
    if (emp) {
      const nome = nomeEmpresa(emp);
      const cnpj = formatarCnpj(emp.cnpj);
      return cnpj ? (nome + '\nCNPJ: ' + cnpj) : nome;
    }
    const id = ctx.lerEmpresaId && ctx.lerEmpresaId();
    return id ? ('Empresa #' + id) : 'Empresa do contexto operacional';
  }

  function subtituloPagina() {
    return vistaTodas
      ? 'Contas bancárias de todas as empresas'
      : 'Contas bancárias da empresa atual';
  }

  function atualizarCabecalho() {
    const emp = document.getElementById('mbcEmpresa');
    if (emp) emp.textContent = rotuloEmpresa();
    const sub = document.querySelector('#mbcShell .cds-page-header__subtitle');
    if (sub) sub.textContent = subtituloPagina();
    const vista = document.getElementById('mbcVistaEmpresas');
    if (vista) vista.value = vistaTodas ? 'todas' : 'atual';
    const filtro = document.getElementById('mbcFiltroEmpresa');
    const filtroLabel = document.getElementById('mbcFiltroEmpresaLabel');
    if (filtro) filtro.hidden = !vistaTodas;
    if (filtroLabel) filtroLabel.hidden = !vistaTodas;
  }

  function comEscopo(path) {
    if (!vistaTodas) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'escopo=todas';
  }

  function setAlerta(msg, tipo) {
    const el = document.getElementById('mbcAlerta');
    if (!el) return;
    if (!msg) {
      el.innerHTML = '';
      return;
    }
    const cls = tipo === 'erro' ? 'alert-danger' : 'alert-info';
    el.innerHTML = '<div class="alert ' + cls + ' py-2">' + escapeHtml(msg) + '</div>';
  }

  function mensagemErro(data, status) {
    const code = data && data.code ? String(data.code) : '';
    const raw = data && data.error ? String(data.error).split('\n')[0] : '';
    if (code === 'MBC_SINCRONIZACAO_EM_ANDAMENTO' || (status === 409 && /sincroniz/i.test(raw))) {
      return 'Esta conta já está sendo sincronizada.';
    }
    if (/PROCESSANDO/i.test(raw)) {
      return 'Relatório do Mercado Pago ainda em geração. Aguarde cerca de 1 minuto e sincronize novamente.';
    }
    if (status === 401 || /autoriza(ç|c)ão.*inv(á|a)lida|token.*expir|oauth/i.test(raw)) {
      return 'Autorização do Mercado Pago inválida ou expirada.';
    }
    if (code === 'MBC_SECRET_KEY_AUSENTE') {
      return raw || 'Não foi possível ler a credencial cifrada. Salve o Client Secret novamente.';
    }
    if (status === 403) {
      return raw || 'Acesso não autorizado para esta operação.';
    }
    if (status === 404) {
      return raw || 'Recurso não encontrado.';
    }
    if (status === 429 || code === 'MBC_PROVIDER_RATE_LIMIT') {
      return 'Limite temporário da API atingido. Tente novamente mais tarde.';
    }
    if (status === 504 || code === 'MBC_PROVIDER_TIMEOUT' || /timeout/i.test(raw)) {
      return 'Mercado Pago não respondeu dentro do tempo esperado.';
    }
    if (status >= 500) {
      return raw || 'Não foi possível concluir a sincronização. Tente novamente.';
    }
    if (raw) return raw;
    if (status === 403) return 'Você não possui acesso à empresa informada.';
    return 'Não foi possível concluir a operação.';
  }

  async function api(method, path, body) {
    const opt = { method: method, headers: headersJson() };
    if (body != null) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let resp;
    try {
      resp = await fetch(apiUrl() + comEscopo(path), opt);
    } catch (_) {
      throw Object.assign(new Error('Falha de rede ao contatar o servidor.'), { status: 0 });
    }
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      throw Object.assign(new Error(mensagemErro(data, resp.status)), {
        status: resp.status,
        code: data && data.code,
        data: data
      });
    }
    return data;
  }

  function preencherInstSelect(selected) {
    const sel = document.getElementById('mbcInst');
    if (!sel) return;
    const ativas = instituicoesCache.filter(function (i) { return i.ativo; });
    sel.innerHTML = ativas.map(function (i) {
      const selAttr = String(i.id) === String(selected) ? ' selected' : '';
      return '<option value="' + i.id + '"' + selAttr + '>' + escapeHtml(i.nome) + '</option>';
    }).join('');
  }

  function rotuloTipo(tipo) {
    const mapa = { CORRENTE: 'Corrente', POUPANCA: 'Poupança', PAGAMENTO: 'Pagamento', OUTRA: 'Outra' };
    return mapa[tipo] || tipo || '—';
  }

  function preencherFiltroEmpresa() {
    const sel = document.getElementById('mbcFiltroEmpresa');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todas as empresas</option>'
      + empresasAutorizadasCache.map(function (e) {
        const selAttr = String(filtroEmpresaId) === String(e.id) ? ' selected' : '';
        return '<option value="' + e.id + '"' + selAttr + '>' + escapeHtml(rotuloEmpresaOpcao(e)) + '</option>';
      }).join('');
  }

  function preencherEmpresaContaSelect(selected, bloqueado) {
    const sel = document.getElementById('mbcEmpresaConta');
    if (!sel) return;
    const opts = empresasAutorizadasCache.length
      ? empresasAutorizadasCache
      : [];
    const placeholder = vistaTodas && !selected
      ? '<option value="">Selecione a empresa…</option>'
      : '';
    sel.innerHTML = placeholder + opts.map(function (e) {
      const selAttr = String(e.id) === String(selected) ? ' selected' : '';
      return '<option value="' + e.id + '"' + selAttr + '>' + escapeHtml(rotuloEmpresaOpcao(e)) + '</option>';
    }).join('');
    sel.disabled = !!bloqueado;
  }

  function renderLista(contas) {
    const el = document.getElementById('mbcLista');
    if (!el) return;
    if (!contas || !contas.length) {
      el.innerHTML = '<p class="mbc-empty">Nenhuma conta bancária nesta empresa.</p>';
      return;
    }
    const colEmpresa = vistaTodas
      ? '<th>Empresa</th><th>CNPJ</th>'
      : '';
    el.innerHTML = '<table class="mbc-table"><thead><tr>'
      + colEmpresa
      + '<th>Instituição</th><th>Conta</th><th>Tipo</th><th>Agência</th><th>Número</th>'
      + '<th>Principal</th><th>Status</th><th>Ações</th></tr></thead><tbody>'
      + contas.map(function (c) {
        const colsEmp = vistaTodas
          ? ('<td>' + escapeHtml(c.empresa_nome || '') + '</td>'
            + '<td>' + escapeHtml(formatarCnpj(c.empresa_cnpj)) + '</td>')
          : '';
        const sel = String(contaConfigId) === String(c.id) ? ' class="mbc-row-selected"' : '';
        return '<tr' + sel + ' data-mbc-conta-row="' + c.id + '">' + colsEmp
          + '<td>' + escapeHtml(c.instituicao_nome || '') + '</td>'
          + '<td>' + escapeHtml(c.nome) + '</td>'
          + '<td>' + escapeHtml(rotuloTipo(c.tipo)) + '</td>'
          + '<td>' + escapeHtml(c.agencia || '—') + '</td>'
          + '<td>' + escapeHtml(c.numero_mascarado || c.numero || '') + '</td>'
          + '<td>' + (c.principal ? 'Sim' : 'Não') + '</td>'
          + '<td>' + (c.ativa ? 'Ativa' : 'Inativa') + '</td>'
          + '<td class="mbc-actions">'
          + '<button type="button" class="btn btn-sm btn-primary" data-mbc-integracao="' + c.id + '">Integração</button>'
          + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-transacoes="' + c.id + '">Transações</button>'
          + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-editar="' + c.id + '">Editar</button>'
          + (c.ativa
            ? '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-desativar="' + c.id + '">Desativar</button>'
            : '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-ativar="' + c.id + '">Ativar</button>')
          + (c.ativa && !c.principal
            ? '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-principal="' + c.id + '">Principal</button>'
            : '')
          + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function badgeHtml(texto, tipo) {
    const cls = tipo === 'ok' ? 'mbc-badge--ok' : (tipo === 'warn' ? 'mbc-badge--warn' : 'mbc-badge--muted');
    return '<span class="mbc-badge ' + cls + '">' + escapeHtml(texto) + '</span>';
  }

  function rotuloProviderAmigavel(codigo) {
    if (codigo === 'OPEN_FINANCE_REAL') return 'Mercado Pago';
    if (codigo === 'ITAU') return 'Itaú';
    if (codigo === 'MOCK_OPEN_FINANCE') return 'Open Finance (teste)';
    if (codigo === 'MOCK') return 'Mock (teste)';
    return codigo || '—';
  }

  function providerSelecionadoUi() {
    const sel = document.getElementById('mbcIntProvider');
    return sel && sel.value ? String(sel.value).toUpperCase() : 'OPEN_FINANCE_REAL';
  }

  function ehProviderItau(codigo) {
    return String(codigo || providerSelecionadoUi()).toUpperCase() === 'ITAU';
  }

  function atualizarPainelCredenciaisPorProvider(provider) {
    const p = String(provider || providerSelecionadoUi()).toUpperCase();
    const panelMp = document.getElementById('mbcCredPanelMp');
    const panelItau = document.getElementById('mbcCredPanelItau');
    const btnTestar = document.getElementById('mbcItauTestarConexao');
    const btnAuth = document.getElementById('mbcOfAutorizar');
    const ajuda = document.getElementById('mbcAuthAjuda');
    const isItau = p === 'ITAU';
    if (panelMp) panelMp.hidden = isItau;
    if (panelItau) panelItau.hidden = !isItau;
    if (btnTestar) btnTestar.hidden = !isItau;
    if (btnAuth) {
      btnAuth.hidden = isItau;
      btnAuth.textContent = isItau ? 'Autorizar acesso' : 'Autorizar acesso';
    }
    if (ajuda && isItau) {
      ajuda.textContent = 'Itaú usa Client Credentials (+ mTLS em produção). Após salvar as credenciais, use “Testar conexão”, depois consulte saldo/extrato ou sincronize na aba Operação.';
    }
    const btnSaldo = document.getElementById('mbcItauConsultarSaldo');
    const btnExtrato = document.getElementById('mbcItauConsultarExtrato');
    if (btnSaldo) btnSaldo.hidden = !isItau;
    if (btnExtrato) btnExtrato.hidden = !isItau;
    const sel = document.getElementById('mbcIntProvider');
    if (sel && sel.value !== p) sel.value = p;
  }

  function selecionarAbaIntegracao(nome) {
    abaIntegracao = nome || 'config';
    document.querySelectorAll('.mbc-tab').forEach(function (btn) {
      const ativo = btn.getAttribute('data-mbc-tab') === abaIntegracao;
      if (ativo) btn.classList.add('is-active');
      else btn.classList.remove('is-active');
    });
    document.querySelectorAll('[data-mbc-panel]').forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-mbc-panel') !== abaIntegracao;
    });
  }

  function fecharPainelIntegracao() {
    const painel = document.getElementById('mbcPainelConfig');
    if (painel) painel.hidden = true;
    contaConfigId = null;
    contaOfDetalhe = null;
    credenciaisStatusCache = null;
    consentimentosCache = [];
    const cfgBody = document.getElementById('mbcCfgBody');
    if (cfgBody) cfgBody.innerHTML = '';
    const ofBody = document.getElementById('mbcOfBody');
    if (ofBody) ofBody.innerHTML = '';
    aplicarStatusMp(null, '');
    atualizarHeaderIntegracao(null);
    selecionarAbaIntegracao('config');
    if (contasCache && contasCache.length) renderLista(contasCache);
  }

  function atualizarHeaderIntegracao(conta) {
    const nomeEl = document.getElementById('mbcCfgContaNome');
    const empEl = document.getElementById('mbcCfgEmpresaMeta');
    const instEl = document.getElementById('mbcIntInstituicao');
    if (!conta) {
      if (nomeEl) nomeEl.textContent = '';
      if (empEl) empEl.textContent = '';
      if (instEl) instEl.value = '';
      const geral = document.getElementById('mbcCfgStatusGeral');
      if (geral) geral.innerHTML = '';
      return;
    }
    const ag = conta.agencia ? ('Agência ' + conta.agencia) : 'Agência —';
    const num = conta.numero_mascarado || conta.numero || '—';
    if (nomeEl) {
      nomeEl.innerHTML = '<strong>' + escapeHtml(conta.instituicao_nome || 'Instituição') + '</strong><br>'
        + escapeHtml((conta.nome || 'Conta') + ' · ' + ag + ' · Conta ' + num);
    }
    if (empEl) {
      const empNome = conta.empresa_nome || 'Empresa da conta';
      const cnpj = formatarCnpj(conta.empresa_cnpj);
      empEl.innerHTML = '<strong>Empresa:</strong> ' + escapeHtml(empNome)
        + (cnpj ? ('<br><strong>CNPJ:</strong> ' + escapeHtml(cnpj)) : '');
    }
    if (instEl) instEl.value = conta.instituicao_nome || '';
  }

  function atualizarStatusGeral(credStatus, consentimentos, oauthStatus) {
    const geral = document.getElementById('mbcCfgStatusGeral');
    const authBadges = document.getElementById('mbcAuthStatusBadges');
    const opBloq = document.getElementById('mbcOpBloqueio');
    const ajuda = document.getElementById('mbcAuthAjuda');
    const msg = document.getElementById('mbcAuthMsg');
    const btnAuth = document.getElementById('mbcOfAutorizar');
    const btnDisc = document.getElementById('mbcOfDesconectar');
    const idOk = credStatus && credStatus.client_id_configurado;
    const secOk = credStatus && credStatus.secret_configurado;
    const credOk = !!(idOk && secOk);
    const oauth = oauthStatus || oauthStatusCache;
    const lista = consentimentos || [];
    const autorizadoOauth = oauth && oauth.status === 'AUTORIZADO';
    const autorizadoConsent = lista.some(function (c) { return c.status === 'AUTORIZADO'; });
    const autorizado = !!(autorizadoOauth || autorizadoConsent);
    const aguardando = (oauth && oauth.status === 'AGUARDANDO_AUTORIZACAO')
      || lista.some(function (c) {
        return c.status === 'AGUARDANDO_AUTORIZACAO' || c.status === 'INICIADO';
      });
    const negado = oauth && oauth.status === 'NEGADO';
    const expirado = oauth && oauth.status === 'TOKEN_EXPIRADO';
    let htmlGeral = '';
    if (credOk) htmlGeral += badgeHtml('Credenciais configuradas', 'ok');
    else if (idOk || secOk) htmlGeral += badgeHtml('Credenciais incompletas', 'warn');
    else htmlGeral += badgeHtml('Não configurado', 'muted');
    if (autorizado) htmlGeral += badgeHtml('Autorizado', 'ok');
    else if (expirado) htmlGeral += badgeHtml('Token expirado', 'warn');
    else if (negado) htmlGeral += badgeHtml('Autorização não concluída', 'warn');
    else if (aguardando) htmlGeral += badgeHtml('Autorização pendente', 'warn');
    else htmlGeral += badgeHtml('Não autorizado', 'muted');
    if (geral) geral.innerHTML = htmlGeral;
    if (authBadges) {
      if (autorizado) authBadges.innerHTML = badgeHtml('Autorização concluída', 'ok');
      else if (expirado) authBadges.innerHTML = badgeHtml('Token expirado', 'warn');
      else if (negado) authBadges.innerHTML = badgeHtml('Autorização não concluída', 'warn');
      else if (aguardando) authBadges.innerHTML = badgeHtml('Autorização pendente', 'warn');
      else if (credOk) authBadges.innerHTML = badgeHtml('Pronto para autorizar', 'ok');
      else authBadges.innerHTML = badgeHtml('Ainda não autorizado', 'muted');
    }
    if (ajuda) {
      if (!credOk) ajuda.textContent = 'Configure as credenciais na aba Configuração antes de autorizar.';
      else if (autorizado) ajuda.textContent = 'Autorização concluída. Tokens ficam somente no servidor.';
      else if (expirado) ajuda.textContent = 'A autorização expirou. Autorize novamente.';
      else if (negado) ajuda.textContent = 'Autorização não concluída. Você pode tentar novamente.';
      else ajuda.textContent = 'Pronto para autorizar. Você será direcionado ao Mercado Pago para conceder acesso.';
    }
    if (msg && !msg.dataset.sticky) msg.textContent = '';
    if (btnAuth) btnAuth.disabled = !credOk;
    if (btnDisc) btnDisc.hidden = !autorizado && !expirado;
    if (opBloq) {
      opBloq.hidden = autorizado;
      if (!autorizado) {
        opBloq.textContent = 'Autorize novamente o Mercado Pago para sincronizar esta conta.';
      }
    }
    const opStatus = document.getElementById('mbcOpStatusIntegracao');
    if (opStatus) {
      let h = '';
      if (credOk) h += badgeHtml('Credenciais configuradas', 'ok');
      else h += badgeHtml('Não configurado', 'muted');
      if (autorizado) h += badgeHtml('AUTORIZADO', 'ok');
      else if (expirado) h += badgeHtml('TOKEN EXPIRADO', 'warn');
      else if (negado) h += badgeHtml('REVOGADO / NEGADO', 'warn');
      else if (aguardando) h += badgeHtml('AGUARDANDO AUTORIZAÇÃO', 'warn');
      else h += badgeHtml('NÃO AUTORIZADO', 'muted');
      opStatus.innerHTML = h;
    }
    atualizarBotaoSincronizar();
  }

  async function carregarStatusOauth() {
    const hid = document.getElementById('mbcMpConfigId');
    const configId = hid && hid.value;
    if (!configId) {
      oauthStatusCache = null;
      atualizarStatusGeral(credenciaisStatusCache, consentimentosCache, null);
      return null;
    }
    try {
      const st = await api('GET', '/bancario/configuracoes/' + configId + '/oauth/status');
      oauthStatusCache = st;
      atualizarStatusGeral(credenciaisStatusCache, consentimentosCache, st);
      return st;
    } catch (_) {
      oauthStatusCache = null;
      atualizarStatusGeral(credenciaisStatusCache, consentimentosCache, null);
      return null;
    }
  }

  var contaTransacoesId = null;
  var contaConfigId = null;
  var contaOfDetalhe = null;
  var abaIntegracao = 'config';
  var credenciaisStatusCache = null;
  var oauthStatusCache = null;
  var consentimentosCache = [];
  var sugestoesCache = [];
  var transacoesCache = [];
  var registrosElegiveisCache = [];
  var ultimoResultadoSyncCache = null;
  var sincronizandoAgora = false;

  function fmtMoeda(n) {
    return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function rotuloDirecao(d) {
    if (d === 'entrada') return 'Entrada';
    if (d === 'saida') return 'Saída';
    if (d === 'transferencia') return 'Transferência';
    return d || '—';
  }

  function rotuloStatus(s) {
    if (s === 'conciliada') return 'CONCILIADA';
    if (s === 'parcialmente_conciliada') return 'PARCIALMENTE CONCILIADA';
    if (s === 'nao_conciliada') return 'NÃO CONCILIADA';
    if (s === 'ignorada') return 'Ignorada';
    if (s === 'divergente') return 'Divergente';
    if (s === 'pendente') return 'NÃO CONCILIADA';
    return 'NÃO CONCILIADA';
  }

  function statusConciliacaoTx(t, concs) {
    const lista = Array.isArray(concs) ? concs : (concs ? [concs] : []);
    const links = lista.filter(function (c) {
      return c && c.ativo && c.status === 'conciliada';
    });
    const soma = links.reduce(function (acc, c) {
      return acc + Number(c.valor_conciliado || 0);
    }, 0);
    const total = Number(t.valor) || 0;
    const disponivel = Math.max(0, Math.round((total - soma) * 100) / 100);
    if (links.length && disponivel <= 0) {
      return {
        status: 'conciliada',
        status_conciliacao: 'conciliada',
        links: links,
        valorConciliado: soma,
        valorDisponivel: 0
      };
    }
    const marc = lista.filter(function (c) {
      return c && c.ativo && (c.status === 'ignorada' || c.status === 'divergente');
    })[0];
    if (marc) {
      return {
        status: marc.status,
        status_conciliacao: marc.status,
        links: links,
        valorConciliado: soma,
        valorDisponivel: disponivel,
        marcacao: marc
      };
    }
    const stConc = soma > 0 ? 'parcialmente_conciliada' : 'nao_conciliada';
    return {
      status: 'pendente',
      status_conciliacao: stConc,
      links: links,
      valorConciliado: soma,
      valorDisponivel: disponivel
    };
  }

  function limparPainelTransacoes() {
    contaTransacoesId = null;
    transacoesCache = [];
    registrosElegiveisCache = [];
    const painel = document.getElementById('mbcPainelTransacoes');
    if (painel) painel.hidden = true;
    const tbody = document.getElementById('mbcTxBody');
    if (tbody) tbody.innerHTML = '';
    const pendBody = document.getElementById('mbcPendBody');
    if (pendBody) pendBody.innerHTML = '';
    const saldo = document.getElementById('mbcSaldoConceitual');
    if (saldo) saldo.textContent = '—';
    const titulo = document.getElementById('mbcTxContaNome');
    if (titulo) titulo.textContent = '';
    const painelCfg = document.getElementById('mbcPainelConfig');
    if (painelCfg) painelCfg.hidden = true;
    const cfgBody = document.getElementById('mbcCfgBody');
    if (cfgBody) cfgBody.innerHTML = '';
    contaConfigId = null;
    contaOfDetalhe = null;
    consentimentosCache = [];
    const ofBody = document.getElementById('mbcOfBody');
    if (ofBody) ofBody.innerHTML = '';
    const extratoBody = document.getElementById('mbcExtratoBody');
    if (extratoBody) extratoBody.innerHTML = '';
    ultimoResultadoSyncCache = null;
    sincronizandoAgora = false;
    [
      'mbcSyncSaldoBancario', 'mbcSyncSaldoConceitual', 'mbcSyncDiferenca', 'mbcSyncQtd',
      'mbcSyncRecebidas', 'mbcSyncCriadas', 'mbcSyncJaExistentes', 'mbcSyncRejeitadas',
      'mbcSyncUltima', 'mbcSyncStatus', 'mbcSyncContinuidade'
    ].forEach(function (id) {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === 'mbcSyncUltima') el.textContent = 'Nenhuma sincronização realizada.';
      else if (id === 'mbcSyncStatus') el.textContent = 'Não executada';
      else if (id === 'mbcSyncContinuidade') el.textContent = 'Sem sincronização prévia';
      else if (id === 'mbcSyncSaldoBancario') el.textContent = 'Saldo real indisponível neste fluxo.';
      else if (id === 'mbcSyncSaldoConceitual') el.textContent = 'R$ 0,00';
      else if (id === 'mbcSyncQtd' || id.indexOf('Recebidas') >= 0 || id.indexOf('Criadas') >= 0
        || id.indexOf('Existentes') >= 0 || id.indexOf('Rejeitadas') >= 0) el.textContent = '0';
      else el.textContent = '—';
    });
    const ind = document.getElementById('mbcSyncIndicador');
    if (ind) ind.textContent = 'Nenhuma sincronização realizada.';
    setSyncMsg('', null);
    const opStatus = document.getElementById('mbcOpStatusIntegracao');
    if (opStatus) opStatus.innerHTML = '';
    atualizarBotaoSincronizar();
    const sel = document.getElementById('mbcConcRegistro');
    if (sel) sel.innerHTML = '';
    const txId = document.getElementById('mbcConcTxId');
    if (txId) txId.value = '';
    sugestoesCache = [];
    const sugBody = document.getElementById('mbcSugBody');
    if (sugBody) sugBody.innerHTML = '';
    if (typeof aplicarStatusMp === 'function') aplicarStatusMp(null, '');
    const idEl = document.getElementById('mbcMpClientId');
    if (idEl) idEl.value = '';
    const secEl = document.getElementById('mbcMpSecret');
    if (secEl) secEl.value = '';
    atualizarHeaderIntegracao(null);
    selecionarAbaIntegracao('config');
  }

  function acoesConciliacao(t, info) {
    const st = info.status_conciliacao || info.status;
    const links = info.links || [];
    if (st === 'conciliada') {
      const detalhes = links.map(function (c) {
        return escapeHtml(c.origem_financeira || '') + ' #' + escapeHtml(c.registro_financeiro_id)
          + ' · ' + fmtMoeda(c.valor_conciliado)
          + ' · ' + escapeHtml(c.origem_conciliacao || 'MANUAL')
          + (c.conciliado_em ? ' · ' + escapeHtml(c.conciliado_em) : '')
          + ' <button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-desconciliar="' + c.id + '">Cancelar</button>';
      }).join('<br>');
      return '<div><strong>Valor conciliado:</strong> ' + fmtMoeda(info.valorConciliado) + '</div>' + detalhes;
    }
    if (st === 'ignorada') return 'Ignorada';
    if (st === 'divergente') {
      const conc = info.marcacao;
      return 'Divergente' + (conc && conc.observacao ? ': ' + escapeHtml(conc.observacao) : '');
    }
    if (t.direcao === 'transferencia') return '—';
    let parcial = '';
    if (links.length) {
      parcial = links.map(function (c) {
        return '<div>' + escapeHtml(c.origem_financeira || '') + ' #' + escapeHtml(c.registro_financeiro_id)
          + ' · ' + fmtMoeda(c.valor_conciliado)
          + ' · ' + escapeHtml(c.origem_conciliacao || 'MANUAL')
          + ' <button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-desconciliar="' + c.id + '">Cancelar</button></div>';
      }).join('');
    }
    return parcial
      + '<button type="button" class="btn btn-sm btn-outline-primary" data-mbc-conciliar="' + t.id + '">Conciliar</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-matching="' + t.id + '">Encontrar correspondências</button>'
      + (links.length ? '' : '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-ignorar="' + t.id + '">Ignorar</button>'
        + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-divergente="' + t.id + '">Marcar como divergente</button>');
  }

  async function carregarTransacoes() {
    if (!contaTransacoesId) return;
    const inicio = (document.getElementById('mbcTxInicio') || {}).value || '';
    const fim = (document.getElementById('mbcTxFim') || {}).value || '';
    const qs = [];
    if (inicio) qs.push('data_inicio=' + encodeURIComponent(inicio));
    if (fim) qs.push('data_fim=' + encodeURIComponent(fim));
    const q = qs.length ? '?' + qs.join('&') : '';
    const data = await api('GET', '/bancario/contas/' + contaTransacoesId + '/transacoes' + q);
    const saldo = await api('GET', '/bancario/contas/' + contaTransacoesId + '/saldo' + q);
    const concData = await api('GET', '/bancario/conciliacoes?conta_bancaria_id=' + encodeURIComponent(contaTransacoesId));
    const porTx = {};
    (concData.conciliacoes || []).forEach(function (c) {
      if (!c.ativo) return;
      if (!porTx[c.transacao_bancaria_id]) porTx[c.transacao_bancaria_id] = [];
      porTx[c.transacao_bancaria_id].push(c);
    });
    const elSaldo = document.getElementById('mbcSaldoConceitual');
    if (elSaldo) elSaldo.textContent = fmtMoeda(saldo.saldo_conceitual);
    await carregarPendentesConciliacao();
    const tbody = document.getElementById('mbcTxBody');
    if (!tbody) return;
    const lista = data.transacoes || [];
    transacoesCache = lista;
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="mbc-empty">Nenhuma transação no período.</td></tr>';
      return;
    }
    tbody.innerHTML = lista.map(function (t) {
      const info = statusConciliacaoTx(t, porTx[t.id] || []);
      const entrada = t.direcao === 'entrada' ? fmtMoeda(t.valor) : '—';
      const saida = t.direcao === 'saida' ? fmtMoeda(t.valor) : '—';
      return '<tr><td>' + escapeHtml(t.data_transacao || '') + '</td>'
        + '<td>' + escapeHtml(t.descricao || '') + '</td>'
        + '<td>' + escapeHtml(t.tipo || '') + '</td>'
        + '<td>' + entrada + '</td>'
        + '<td>' + saida + '</td>'
        + '<td>' + escapeHtml(rotuloDirecao(t.direcao)) + '</td>'
        + '<td>' + fmtMoeda(info.valorConciliado || 0) + '</td>'
        + '<td>' + fmtMoeda(info.valorDisponivel != null ? info.valorDisponivel : t.valor) + '</td>'
        + '<td>' + escapeHtml(rotuloStatus(info.status_conciliacao || info.status)) + '</td>'
        + '<td class="mbc-actions">' + acoesConciliacao(t, info) + '</td></tr>';
    }).join('');
  }

  async function carregarPendentesConciliacao() {
    const tbody = document.getElementById('mbcPendBody');
    if (!tbody || !contaTransacoesId) return;
    const inicio = (document.getElementById('mbcTxInicio') || {}).value || '';
    const fim = (document.getElementById('mbcTxFim') || {}).value || '';
    const qs = ['conta_bancaria_id=' + encodeURIComponent(contaTransacoesId)];
    if (inicio) qs.push('data_inicio=' + encodeURIComponent(inicio));
    if (fim) qs.push('data_fim=' + encodeURIComponent(fim));
    const data = await api('GET', '/bancario/conciliacoes/pendentes?' + qs.join('&'));
    const lista = data.pendentes || [];
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="mbc-empty">Nenhuma conciliação pendente.</td></tr>';
      return;
    }
    tbody.innerHTML = lista.map(function (p) {
      const t = p.transacao || {};
      const valor = p.valor_total != null ? p.valor_total : t.valor;
      const sentido = (p.direcao || t.direcao) === 'saida' ? 'Saída' : 'Entrada';
      return '<tr><td>' + escapeHtml(p.data || t.data_transacao || '') + '</td>'
        + '<td>' + escapeHtml(p.descricao || t.descricao || '') + '</td>'
        + '<td>' + escapeHtml(sentido) + '</td>'
        + '<td>' + fmtMoeda(valor) + '</td>'
        + '<td>' + fmtMoeda(p.valor_conciliado || 0) + '</td>'
        + '<td>' + fmtMoeda(p.valor_disponivel != null ? p.valor_disponivel : valor) + '</td>'
        + '<td>' + escapeHtml(rotuloStatus(p.status_conciliacao || p.status)) + '</td>'
        + '<td class="mbc-actions">'
        + '<button type="button" class="btn btn-sm btn-outline-primary" data-mbc-conciliar="'
        + (p.transacao_bancaria_id || t.id) + '">Conciliar</button> '
        + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-matching="'
        + (p.transacao_bancaria_id || t.id) + '">Encontrar correspondências</button></td></tr>';
    }).join('');
  }

  async function carregarIntegracao() {
    if (!contaConfigId) return;
    const data = await api('GET', '/bancario/configuracoes?conta_bancaria_id=' + encodeURIComponent(contaConfigId));
    const tbody = document.getElementById('mbcCfgBody');
    if (!tbody) return;
    const lista = data.configuracoes || [];
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="mbc-empty">Nenhuma configuração nesta conta.</td></tr>';
      aplicarStatusMp(null, '');
      atualizarStatusGeral(null, consentimentosCache);
      return;
    }
    tbody.innerHTML = lista.map(function (c) {
      const rotuloProv = c.provider === 'OPEN_FINANCE_REAL'
        ? 'OPEN_FINANCE_REAL <span class="mbc-empty">(ainda não homologável — ainda não está habilitado para operação real)</span>'
        : escapeHtml(rotuloProviderAmigavel(c.provider)) + ' <span class="mbc-empty">(Provider de teste)</span>';
      return '<tr><td>' + rotuloProv + '</td>'
        + '<td>' + escapeHtml(c.ambiente) + (c.aplicacao_ref ? ' · ' + escapeHtml(c.aplicacao_ref) : '') + '</td>'
        + '<td>' + (c.ativo ? 'Ativa' : 'Inativa') + '</td>'
        + '<td>' + (c.secret_configurado ? 'Sim' : 'Não') + '</td>'
        + '<td class="mbc-actions">'
        + (c.ativo
          ? '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-cfg-off="' + c.id + '">Desativar</button>'
          : '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-cfg-on="' + c.id + '">Ativar</button>')
        + '</td></tr>';
    }).join('');
    await carregarCredenciaisMp(lista);
  }

  function limparCampoMpSecret() {
    const el = document.getElementById('mbcMpSecret');
    if (!el) return;
    el.value = '';
    el.removeAttribute('data-mbc-secret-mascarado');
  }

  /** Máscara visual — nunca é o secret real; não enviar no POST. */
  var MP_SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

  function isMpSecretMascara(v) {
    if (v == null || String(v) === '') return true;
    const s = String(v);
    if (s === MP_SECRET_MASK) return true;
    return /^[\u2022•*]+$/.test(s);
  }

  function aplicarCampoMpSecret(status) {
    const el = document.getElementById('mbcMpSecret');
    if (!el) return;
    if (status && status.secret_configurado) {
      el.value = MP_SECRET_MASK;
      el.setAttribute('data-mbc-secret-mascarado', '1');
      el.setAttribute('placeholder', 'Client Secret configurado');
    } else {
      el.value = '';
      el.removeAttribute('data-mbc-secret-mascarado');
      el.setAttribute('placeholder', '');
    }
  }

  function ligarCampoMpSecret() {
    const el = document.getElementById('mbcMpSecret');
    if (!el || el.getAttribute('data-mbc-secret-bound') === '1') return;
    el.setAttribute('data-mbc-secret-bound', '1');
    el.addEventListener('focus', function () {
      if (el.getAttribute('data-mbc-secret-mascarado') === '1') {
        el.value = '';
        el.removeAttribute('data-mbc-secret-mascarado');
      }
    });
    el.addEventListener('blur', function () {
      if (!el.value && credenciaisStatusCache && credenciaisStatusCache.secret_configurado) {
        aplicarCampoMpSecret(credenciaisStatusCache);
      }
    });
  }

  function rotuloStatusMp(status) {
    const idOk = status && status.client_id_configurado;
    const secOk = status && status.secret_configurado;
    let t = 'Client ID configurado: ' + (idOk ? '✓' : '—')
      + ' · Client Secret configurado: ' + (secOk ? '✓' : '—');
    if (status && status.provider === 'ITAU') {
      t += ' · Certificado: ' + (status.certificado_configurado ? '✓' : '—')
        + ' · Private key: ' + (status.private_key_configurado ? '✓' : '—');
      if (status.status_integracao) t += ' · Estado: ' + status.status_integracao;
    }
    return t;
  }

  function aplicarStatusMp(status, configId) {
    credenciaisStatusCache = status || null;
    const hid = document.getElementById('mbcMpConfigId');
    if (hid) hid.value = configId ? String(configId) : '';
    const st = document.getElementById('mbcMpStatus');
    if (st) st.textContent = rotuloStatusMp(status);
    const badges = document.getElementById('mbcMpStatusBadges');
    if (badges) {
      const idOk = status && status.client_id_configurado;
      const secOk = status && status.secret_configurado;
      let html = badgeHtml(idOk ? 'Client ID configurado' : 'Client ID pendente', idOk ? 'ok' : 'muted')
        + badgeHtml(secOk ? 'Client Secret configurado' : 'Client Secret pendente', secOk ? 'ok' : 'muted');
      if (status && status.provider === 'ITAU') {
        html += badgeHtml(status.certificado_configurado ? 'Certificado configurado' : 'Certificado pendente', status.certificado_configurado ? 'ok' : 'muted');
        html += badgeHtml(status.private_key_configurado ? 'Private key configurada' : 'Private key pendente', status.private_key_configurado ? 'ok' : 'muted');
        if (status.ca_configurado) html += badgeHtml('CA configurada', 'ok');
        if (status.certificado_configurado && status.certificado_valido_ate) {
          const exp = status.certificado_expirado
            ? 'Certificado expirado'
            : ('Válido até ' + String(status.certificado_valido_ate).slice(0, 10));
          html += badgeHtml(exp, status.certificado_expirado ? 'warn' : 'ok');
        }
        if (status.mtls_requerido) html += badgeHtml('mTLS obrigatório', 'warn');
        if (status.status_integracao) {
          html += badgeHtml(status.status_integracao, status.status_integracao === 'CREDENCIAIS_CONFIGURADAS' ? 'ok' : 'warn');
        }
      }
      badges.innerHTML = html;
    }
    const provider = (status && status.provider) || providerSelecionadoUi();
    atualizarPainelCredenciaisPorProvider(provider);
    if (ehProviderItau(provider)) {
      const idEl = document.getElementById('mbcItauClientId');
      if (idEl && status && status.client_id) idEl.value = status.client_id;
      else if (idEl && !(status && status.client_id_configurado)) idEl.value = '';
      aplicarCampoItauSecret(status);
      aplicarCampoItauMaterial(status);
    } else {
      const idEl = document.getElementById('mbcMpClientId');
      if (idEl && status && status.client_id) idEl.value = status.client_id;
      else if (idEl && !(status && status.client_id_configurado)) idEl.value = '';
      aplicarCampoMpSecret(status);
    }
    const amb = document.getElementById('mbcMpAmbiente');
    if (amb && status && status.ambiente && ['SANDBOX', 'HOMOLOGACAO', 'PRODUCAO'].indexOf(status.ambiente) >= 0) {
      amb.value = status.ambiente;
    }
    atualizarStatusGeral(status, consentimentosCache, oauthStatusCache);
  }

  function aplicarCampoItauSecret(status) {
    const el = document.getElementById('mbcItauSecret');
    if (!el) return;
    if (status && status.secret_configurado) {
      el.value = MP_SECRET_MASK;
      el.setAttribute('data-mbc-secret-mascarado', '1');
      el.setAttribute('placeholder', 'Client Secret configurado');
    } else {
      el.value = '';
      el.removeAttribute('data-mbc-secret-mascarado');
      el.setAttribute('placeholder', '');
    }
  }

  function aplicarCampoItauMaterial(status) {
    const cert = document.getElementById('mbcItauCert');
    const key = document.getElementById('mbcItauKey');
    const ca = document.getElementById('mbcItauCa');
    if (cert) {
      cert.value = '';
      cert.placeholder = status && status.certificado_configurado
        ? ('Certificado configurado'
          + (status.certificado_valido_ate ? (' · válido até ' + String(status.certificado_valido_ate).slice(0, 10)) : '')
          + (status.certificado_subject_cn ? (' · ' + status.certificado_subject_cn) : '')
          + '. Cole um novo PEM para substituir.')
        : 'Opcional no sandbox. Obrigatório em produção (mTLS). Nunca é exibido após salvar.';
    }
    if (key) {
      key.value = '';
      key.placeholder = status && status.private_key_configurado
        ? 'Private key já configurada (não exibida). Cole um novo PEM para substituir.'
        : 'Opcional no sandbox. Obrigatório em produção (mTLS). Nunca é exibida após salvar.';
    }
    if (ca) {
      ca.value = '';
      ca.placeholder = status && status.ca_configurado
        ? 'CA já configurada (não exibida). Cole um novo PEM para substituir.'
        : 'Opcional. Use se o ambiente exigir CA específica do Itaú (ou defina ITAU_TLS_CA no servidor).';
    }
  }

  async function garantirConfigIntegracao() {
    const hid = document.getElementById('mbcMpConfigId');
    if (hid && hid.value) return Number(hid.value);
    if (!contaConfigId) return null;
    const amb = (document.getElementById('mbcMpAmbiente') || {}).value || 'SANDBOX';
    const provider = providerSelecionadoUi();
    const criada = await api('POST', '/bancario/configuracoes', {
      conta_bancaria_id: Number(contaConfigId),
      provider: provider,
      ambiente: amb
    });
    if (hid) hid.value = String(criada.id);
    return criada.id;
  }

  async function carregarCredenciaisMp(listaCfg) {
    const lista = listaCfg || [];
    const preferido = providerSelecionadoUi();
    let cfg = lista.filter(function (c) { return c.provider === preferido && c.ativo; })[0]
      || lista.filter(function (c) { return c.provider === preferido; })[0]
      || lista.filter(function (c) { return c.provider === 'OPEN_FINANCE_REAL' || c.provider === 'ITAU'; })[0];
    if (!cfg) {
      aplicarStatusMp(null, '');
      atualizarPainelCredenciaisPorProvider(preferido);
      return;
    }
    const sel = document.getElementById('mbcIntProvider');
    if (sel && (cfg.provider === 'OPEN_FINANCE_REAL' || cfg.provider === 'ITAU')) {
      sel.value = cfg.provider;
    }
    const status = await api('GET', '/bancario/configuracoes/' + cfg.id + '/credenciais');
    aplicarStatusMp(status, cfg.id);
    if (cfg.provider === 'OPEN_FINANCE_REAL') await carregarStatusOauth();
  }

  function rotuloStatusOf(s) {
    if (!s) return 'Não configurado';
    if (s === 'AGUARDANDO_AUTORIZACAO' || s === 'INICIADO') return 'Aguardando autorização';
    if (s === 'AUTORIZADO') return 'Autorizado';
    if (s === 'EXPIRADO') return 'Expirado';
    if (s === 'REVOGADO') return 'Revogado';
    if (s === 'NEGADO') return 'Negado';
    if (s === 'ERRO') return 'Erro';
    if (s === 'BLOQUEADO') return 'Bloqueado';
    return s;
  }

  function acoesOf(c) {
    if (c.status === 'AGUARDANDO_AUTORIZACAO') {
      return '<button type="button" class="btn btn-sm btn-outline-primary" data-mbc-of-concluir="' + c.id + '">Concluir autorização</button>'
        + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-of-revogar="' + c.id + '">Revogar</button>';
    }
    if (c.status === 'AUTORIZADO') {
      return '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-of-revogar="' + c.id + '">Revogar</button>'
        + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-of-renovar="' + c.id + '">Renovar</button>';
    }
    if (c.status === 'EXPIRADO' || c.status === 'REVOGADO' || c.status === 'NEGADO' || c.status === 'ERRO') {
      return '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-of-renovar="' + c.id + '">Renovar</button>';
    }
    return '';
  }

  async function carregarConsentimentos() {
    if (!contaConfigId) return;
    const data = await api('GET', '/bancario/open-finance/consentimentos?conta_bancaria_id=' + encodeURIComponent(contaConfigId));
    const tbody = document.getElementById('mbcOfBody');
    if (!tbody) return;
    const lista = data.consentimentos || [];
    consentimentosCache = lista;
    atualizarStatusGeral(credenciaisStatusCache, lista, oauthStatusCache);
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="mbc-empty">Nenhum consentimento nesta conta.</td></tr>';
      return;
    }
    const inst = contaOfDetalhe && contaOfDetalhe.instituicao_nome ? contaOfDetalhe.instituicao_nome : '';
    const contaNome = contaOfDetalhe ? ((contaOfDetalhe.nome || '') + ' · ' + (contaOfDetalhe.numero || '')) : '';
    tbody.innerHTML = lista.map(function (c) {
      return '<tr><td>' + escapeHtml(inst) + '</td>'
        + '<td>' + escapeHtml(contaNome) + '</td>'
        + '<td>' + escapeHtml(rotuloProviderAmigavel(c.provider)) + '</td>'
        + '<td>' + escapeHtml(rotuloStatusOf(c.status)) + '</td>'
        + '<td>' + escapeHtml((c.escopos || []).join(', ')) + '</td>'
        + '<td>' + escapeHtml(c.expira_em || '—') + '</td>'
        + '<td>' + escapeHtml(c.autorizado_em || '—') + '</td>'
        + '<td class="mbc-actions">' + acoesOf(c) + '</td></tr>';
    }).join('');
  }

  function rotuloSync(st) {
    if (st === 'SUCESSO') return 'Concluída — Sincronizado';
    if (st === 'PARCIAL') return 'Parcial (continuar sync)';
    if (st === 'ERRO') return 'Erro na sincronização';
    if (st === 'SINCRONIZANDO') return 'Sincronizando…';
    if (st === 'CONSENTIMENTO_EXPIRADO') return 'Erro na sincronização';
    if (st === 'CONSENTIMENTO_REVOGADO') return 'Erro na sincronização';
    if (st === 'BLOQUEADO') return 'Bloqueado';
    if (st === 'PROCESSANDO') return 'Processando';
    if (st === 'PENDENTE') return 'Não executada';
    return 'Não executada';
  }

  function formatarDataHoraBr(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi;
  }

  function oauthEstaAutorizado() {
    const oauth = oauthStatusCache;
    if (oauth && oauth.status === 'AUTORIZADO') return true;
    return (consentimentosCache || []).some(function (c) { return c.status === 'AUTORIZADO'; });
  }

  function itauCredenciaisProntas() {
    if (!ehProviderItau()) return false;
    const st = credenciaisStatusCache;
    if (!st || st.provider !== 'ITAU') return false;
    if (st.status_integracao === 'CREDENCIAIS_CONFIGURADAS') return true;
    return !!(st.client_id_configurado && st.secret_configurado
      && (!st.mtls_requerido || (st.certificado_configurado && st.private_key_configurado)));
  }

  function operacaoBancariaPronta() {
    if (ehProviderItau()) return itauCredenciaisProntas();
    return oauthEstaAutorizado();
  }

  function atualizarBotaoSincronizar() {
    const btn = document.getElementById('mbcSyncAgora');
    if (!btn) return;
    const ok = !!contaConfigId && operacaoBancariaPronta() && !sincronizandoAgora;
    btn.disabled = !ok;
    if (sincronizandoAgora) btn.textContent = 'Sincronizando…';
    else btn.textContent = 'Sincronizar agora';
    const btnSaldo = document.getElementById('mbcItauConsultarSaldo');
    const btnExtrato = document.getElementById('mbcItauConsultarExtrato');
    if (btnSaldo) {
      btnSaldo.hidden = !ehProviderItau();
      btnSaldo.disabled = !ok;
    }
    if (btnExtrato) {
      btnExtrato.hidden = !ehProviderItau();
      btnExtrato.disabled = !ok;
    }
  }

  function aplicarResultadoSyncPainel(out) {
    if (!out) return;
    ultimoResultadoSyncCache = {
      contaId: contaConfigId,
      recebidas: out.transacoes_recebidas != null ? out.transacoes_recebidas : 0,
      criadas: out.novas_transacoes != null ? out.novas_transacoes : 0,
      ja: out.duplicadas != null ? out.duplicadas : 0,
      rej: out.rejeitadas != null ? out.rejeitadas : 0,
      em: out.ultima_sincronizacao_em || new Date().toISOString(),
      status: out.status
    };
    const elR = document.getElementById('mbcSyncRecebidas');
    const elC = document.getElementById('mbcSyncCriadas');
    const elJ = document.getElementById('mbcSyncJaExistentes');
    const elRej = document.getElementById('mbcSyncRejeitadas');
    if (elR) elR.textContent = String(ultimoResultadoSyncCache.recebidas);
    if (elC) elC.textContent = String(ultimoResultadoSyncCache.criadas);
    if (elJ) elJ.textContent = String(ultimoResultadoSyncCache.ja);
    if (elRej) elRej.textContent = String(ultimoResultadoSyncCache.rej);
  }

  function continuidadeAmigavel(sync) {
    if (!sync || !sync.cursor_atual) return 'Sem sincronização prévia';
    if (sync.status === 'ERRO') return 'Há um ponto seguro. Você pode sincronizar novamente.';
    if (sync.status === 'SUCESSO') return 'Última sincronização concluída com segurança.';
    if (sync.status === 'PARCIAL') return 'Sincronização parcial. Há mais dados; sincronize novamente.';
    if (sync.status === 'SINCRONIZANDO') return 'Sincronização em andamento.';
    return 'Continuidade disponível';
  }

  function setSyncMsg(texto, tipo) {
    const el = document.getElementById('mbcSyncMsg');
    if (!el) return;
    if (!texto) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = texto;
    el.className = 'mbc-empty' + (tipo === 'erro' ? ' text-danger' : '');
  }

  async function carregarExtratoOperacao() {
    const tbody = document.getElementById('mbcExtratoBody');
    const elQ = document.getElementById('mbcSyncQtd');
    if (!contaConfigId) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">Selecione uma conta.</td></tr>';
      if (elQ) elQ.textContent = '0';
      return;
    }
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">Carregando extrato…</td></tr>';
    try {
      const inicio = (document.getElementById('mbcExtInicio') || {}).value || '';
      const fim = (document.getElementById('mbcExtFim') || {}).value || '';
      const direcao = (document.getElementById('mbcExtDirecao') || {}).value || '';
      let qs = '?limite=200';
      if (inicio) qs += '&data_inicio=' + encodeURIComponent(inicio);
      if (fim) qs += '&data_fim=' + encodeURIComponent(fim);
      if (direcao) qs += '&direcao=' + encodeURIComponent(direcao);
      const extrato = await api('GET', '/bancario/contas/' + contaConfigId + '/extrato' + qs);
      const lista = extrato.transacoes || [];
      if (elQ) elQ.textContent = String(lista.length);
      if (!tbody) return;
      if (!lista.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">Nenhuma movimentação no extrato.</td></tr>';
        return;
      }
      tbody.innerHTML = lista.map(function (t) {
        const entrada = t.direcao === 'entrada' ? fmtMoeda(t.valor) : '';
        const saida = t.direcao === 'saida' ? fmtMoeda(t.valor) : '';
        const data = (t.data_transacao || '').slice(0, 16).replace('T', ' ');
        return '<tr><td>' + escapeHtml(data) + '</td>'
          + '<td>' + escapeHtml(t.descricao || '') + '</td>'
          + '<td>' + escapeHtml(t.referencia_externa || '') + '</td>'
          + '<td>' + escapeHtml(entrada) + '</td>'
          + '<td>' + escapeHtml(saida) + '</td>'
          + '<td>Importada</td></tr>';
      }).join('');
    } catch (err) {
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty text-danger">'
          + escapeHtml(err.message || 'Erro ao carregar extrato.') + '</td></tr>';
      }
      if (elQ) elQ.textContent = '0';
      setSyncMsg(err.message || 'Erro ao carregar extrato.', 'erro');
    }
  }

  async function carregarSincronizacao() {
    if (!contaConfigId) return;
    atualizarBotaoSincronizar();
    let sync = {
      status: 'PENDENTE',
      ultima_sincronizacao_em: null,
      cursor_atual: null,
      ultimo_erro: null
    };
    let saldo = { saldo_bancario: null, saldo_conceitual: 0, diferenca: null };
    try {
      sync = await api('GET', '/bancario/contas/' + contaConfigId + '/sincronizacao');
    } catch (err) {
      setSyncMsg(err.message || 'Erro ao consultar sincronização.', 'erro');
    }
    try {
      saldo = await api('GET', '/bancario/contas/' + contaConfigId + '/saldo-bancario');
    } catch (_) { /* saldo opcional */ }

    const ind = document.getElementById('mbcSyncIndicador');
    if (ind) {
      let txt = 'Status técnico: ' + (sync.status || 'PENDENTE');
      if (sync.ultima_sincronizacao_em) txt += '\nÚltima: ' + sync.ultima_sincronizacao_em;
      if (sync.ultimo_erro) txt += '\nErro: ' + sync.ultimo_erro;
      ind.textContent = txt;
    }

    const elUlt = document.getElementById('mbcSyncUltima');
    const elSt = document.getElementById('mbcSyncStatus');
    const elCont = document.getElementById('mbcSyncContinuidade');
    if (elUlt) {
      elUlt.textContent = sync.ultima_sincronizacao_em
        ? formatarDataHoraBr(sync.ultima_sincronizacao_em)
        : 'Nenhuma sincronização realizada.';
    }
    if (elSt) elSt.textContent = rotuloSync(sync.status);
    if (elCont) elCont.textContent = continuidadeAmigavel(sync);

    if (ultimoResultadoSyncCache && String(ultimoResultadoSyncCache.contaId) === String(contaConfigId)) {
      aplicarResultadoSyncPainel({
        transacoes_recebidas: ultimoResultadoSyncCache.recebidas,
        novas_transacoes: ultimoResultadoSyncCache.criadas,
        duplicadas: ultimoResultadoSyncCache.ja,
        rejeitadas: ultimoResultadoSyncCache.rej,
        ultima_sincronizacao_em: ultimoResultadoSyncCache.em,
        status: ultimoResultadoSyncCache.status
      });
    } else {
      ['mbcSyncRecebidas', 'mbcSyncCriadas', 'mbcSyncJaExistentes', 'mbcSyncRejeitadas'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.textContent = '0';
      });
    }

    const elB = document.getElementById('mbcSyncSaldoBancario');
    const elC = document.getElementById('mbcSyncSaldoConceitual');
    const elD = document.getElementById('mbcSyncDiferenca');
    if (elB) {
      if (ehProviderItau() && !itauCredenciaisProntas()) {
        elB.textContent = 'Credenciais Itaú não configuradas';
      } else if (saldo.saldo_bancario == null) {
        elB.textContent = ehProviderItau()
          ? 'Saldo real indisponível (consulte ou sincronize).'
          : 'Saldo real indisponível neste fluxo.';
      } else {
        elB.textContent = 'R$ ' + fmtMoeda(saldo.saldo_bancario);
      }
    }
    if (elC) elC.textContent = 'R$ ' + fmtMoeda(saldo.saldo_conceitual);
    if (elD) elD.textContent = saldo.diferenca == null ? '—' : fmtMoeda(saldo.diferenca);

    if (sync.status === 'SINCRONIZANDO') {
      sincronizandoAgora = true;
      setSyncMsg('Sincronização em andamento…', 'info');
    } else if (!sincronizandoAgora) {
      sincronizandoAgora = false;
    }
    atualizarBotaoSincronizar();
    await carregarExtratoOperacao();
  }

  async function executarSincronizarAgora() {
    if (!contaConfigId || sincronizandoAgora) return;
    if (!operacaoBancariaPronta()) {
      if (ehProviderItau()) {
        setAlerta('Credenciais Itaú não configuradas.', 'erro');
        setSyncMsg('Configure as credenciais Itaú antes de sincronizar.', 'erro');
        selecionarAbaIntegracao('config');
      } else {
        setAlerta('Autorize novamente o Mercado Pago para sincronizar esta conta.', 'erro');
        setSyncMsg('Autorize o Mercado Pago antes de sincronizar.', 'erro');
        selecionarAbaIntegracao('auth');
      }
      return;
    }
    sincronizandoAgora = true;
    atualizarBotaoSincronizar();
    const elSt = document.getElementById('mbcSyncStatus');
    if (elSt) elSt.textContent = 'Sincronizando…';
    setSyncMsg('Sincronizando…', 'info');
    setAlerta('Sincronizando conta…', 'info');
    try {
      const out = await api('POST', '/bancario/contas/' + contaConfigId + '/sincronizar', {});
      aplicarResultadoSyncPainel(out);
      setSyncMsg('Sincronização concluída.', 'ok');
      setAlerta(
        'Sincronização concluída: '
        + (out.novas_transacoes || 0) + ' criada(s), '
        + (out.duplicadas || 0) + ' já existente(s).',
        'ok'
      );
      await carregarSincronizacao();
    } catch (err) {
      const processando = /processamento|PROCESSANDO|ainda em geração/i.test(err.message || '');
      if (processando) {
        setSyncMsg(err.message, 'info');
        setAlerta(err.message, 'info');
        if (elSt) elSt.textContent = 'Processando no Mercado Pago';
        // Reconsulta status; o usuário pode sincronizar de novo quando o relatório estiver pronto.
      } else if (err.status === 409) {
        setSyncMsg(err.message, 'erro');
        setAlerta(err.message, 'erro');
        if (elSt) elSt.textContent = 'Sincronizando…';
      } else {
        setSyncMsg(err.message || 'Erro na sincronização.', 'erro');
        setAlerta(err.message, 'erro');
        if (elSt) elSt.textContent = 'Erro';
      }
      try { await carregarSincronizacao(); } catch (_) { /* ignore */ }
    } finally {
      sincronizandoAgora = false;
      atualizarBotaoSincronizar();
    }
  }

  async function executarConsultarSaldoRealItau() {
    if (!contaConfigId) return;
    if (!itauCredenciaisProntas()) {
      setAlerta('Credenciais Itaú não configuradas', 'erro');
      return;
    }
    try {
      const out = await api('GET', '/bancario/contas/' + contaConfigId + '/saldo-real');
      const elB = document.getElementById('mbcSyncSaldoBancario');
      if (out && out.disponivel && out.saldo && out.saldo.valor != null) {
        if (elB) elB.textContent = 'R$ ' + fmtMoeda(out.saldo.valor);
        setAlerta('Saldo real do banco: R$ ' + fmtMoeda(out.saldo.valor), 'ok');
        setSyncMsg('Saldo real consultado em ' + (out.as_of || 'agora') + '.', 'ok');
      } else {
        if (elB) elB.textContent = 'Saldo real indisponível.';
        setAlerta((out && out.message) || 'Saldo real indisponível.', 'erro');
      }
    } catch (err) {
      const elB = document.getElementById('mbcSyncSaldoBancario');
      if (elB && /credencial/i.test(err.message || '')) {
        elB.textContent = 'Credenciais Itaú não configuradas';
      }
      setAlerta(err.message, 'erro');
      setSyncMsg(err.message, 'erro');
    }
  }

  async function executarConsultarExtratoItau() {
    if (!contaConfigId) return;
    if (!itauCredenciaisProntas()) {
      setAlerta('Credenciais Itaú não configuradas', 'erro');
      return;
    }
    const tbody = document.getElementById('mbcExtratoBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">Consultando extrato no provider…</td></tr>';
    try {
      const inicio = (document.getElementById('mbcExtInicio') || {}).value || '';
      const fim = (document.getElementById('mbcExtFim') || {}).value || '';
      let qs = '?fonte=PROVIDER';
      if (inicio) qs += '&data_inicio=' + encodeURIComponent(inicio);
      if (fim) qs += '&data_fim=' + encodeURIComponent(fim);
      const out = await api('GET', '/bancario/contas/' + contaConfigId + '/extrato' + qs);
      const lista = out.transacoes || [];
      const elQ = document.getElementById('mbcSyncQtd');
      if (elQ) elQ.textContent = String(lista.length);
      if (!tbody) return;
      if (!lista.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">Nenhuma movimentação retornada pelo provider (consulta live, não persistida).</td></tr>';
        setAlerta('Extrato provider vazio (não persistido). Use Sincronizar para gravar.', 'info');
        return;
      }
      tbody.innerHTML = lista.map(function (t) {
        const entrada = t.direcao === 'entrada' ? fmtMoeda(t.valor) : '';
        const saida = t.direcao === 'saida' ? fmtMoeda(t.valor) : '';
        const data = (t.data_transacao || '').slice(0, 16).replace('T', ' ');
        return '<tr><td>' + escapeHtml(data) + '</td>'
          + '<td>' + escapeHtml(t.descricao || '') + '</td>'
          + '<td>' + escapeHtml(t.referencia_externa || t.external_id || '') + '</td>'
          + '<td>' + escapeHtml(entrada) + '</td>'
          + '<td>' + escapeHtml(saida) + '</td>'
          + '<td>PROVIDER</td></tr>';
      }).join('');
      setAlerta('Extrato live do Itaú (não persistido). Sincronize para gravar no MBC.', 'info');
    } catch (err) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">' + escapeHtml(err.message) + '</td></tr>';
      setAlerta(err.message, 'erro');
    }
  }

  async function abrirIntegracao(id) {
    contaConfigId = id;
    const painelTx = document.getElementById('mbcPainelTransacoes');
    if (painelTx) painelTx.hidden = true;
    const painel = document.getElementById('mbcPainelConfig');
    if (painel) painel.hidden = false;
    selecionarAbaIntegracao('config');
    try {
      const c = await api('GET', '/bancario/contas/' + id);
      contaOfDetalhe = c;
      atualizarHeaderIntegracao(c);
      const sel = document.getElementById('mbcIntProvider');
      const nomeInst = String((c && c.instituicao_nome) || '').toUpperCase();
      if (sel && /ITA[UÚ]/.test(nomeInst)) sel.value = 'ITAU';
      else if (sel && /MERCADO\s*PAGO|MERCADOPAGO/.test(nomeInst)) sel.value = 'OPEN_FINANCE_REAL';
      atualizarPainelCredenciaisPorProvider(sel ? sel.value : 'OPEN_FINANCE_REAL');
      if (contasCache && contasCache.length) renderLista(contasCache);
      await carregarIntegracao();
      await carregarConsentimentos();
      await carregarSincronizacao();
      if (painel && typeof painel.scrollIntoView === 'function') {
        painel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (err) {
      setAlerta(err.message, 'erro');
    }
  }

  async function abrirTransacoes(id) {
    contaTransacoesId = id;
    transacoesCache = [];
    registrosElegiveisCache = [];
    const painelCfg = document.getElementById('mbcPainelConfig');
    if (painelCfg) painelCfg.hidden = true;
    const painel = document.getElementById('mbcPainelTransacoes');
    if (painel) painel.hidden = false;
    try {
      const c = await api('GET', '/bancario/contas/' + id);
      const titulo = document.getElementById('mbcTxContaNome');
      if (titulo) titulo.textContent = (c.nome || '') + ' · ' + (c.numero || '');
      await carregarTransacoes();
      await carregarSugestoes();
    } catch (err) {
      setAlerta(err.message, 'erro');
    }
  }

  function rotuloNivel(n) {
    if (n === 'ALTA') return 'Alta confiança';
    if (n === 'MEDIA') return 'Média confiança';
    if (n === 'BAIXA') return 'Baixa confiança';
    return n || '—';
  }

  function rotuloMotivos(lista) {
    const map = {
      VALOR_EXATO: 'Valor exato',
      DATA_MESMO_DIA: 'Data compatível',
      DATA_1_DIA: 'Data próxima (1 dia)',
      DATA_2_DIAS: 'Data próxima (2 dias)',
      IDENTIFICADOR_EXATO: 'Identificador compatível',
      DESCRICAO_IDENTICA: 'Descrição compatível',
      DESCRICAO_COMPATIVEL: 'Descrição compatível',
      DESCRICAO_PARCIAL: 'Descrição parcial',
      MESMA_EMPRESA: 'Mesma empresa',
      MESMO_TIPO_MOVIMENTO: 'Tipo de movimento compatível',
      VALOR_COMPATIVEL: 'Valor compatível',
      VALOR_PARCIALMENTE_COMPATIVEL: 'Valor parcialmente compatível',
      DATA_COMPATIVEL: 'Data compatível'
    };
    return (lista || []).map(function (m) { return map[m] || m; }).join(', ');
  }

  function rotuloCompat(c) {
    if (c === 'EXATA') return 'EXATA';
    if (c === 'COMPATIVEL') return 'COMPATÍVEL';
    if (c === 'PARCIAL') return 'PARCIAL';
    return c || '—';
  }

  function rotuloStatusCr(status, disponivel, original) {
    const d = Number(disponivel) || 0;
    const o = Number(original) || 0;
    if (d <= 0) return 'INDISPONÍVEL';
    if (o > 0 && d < o) return 'PARCIALMENTE DISPONÍVEL';
    if (status) return String(status).toUpperCase();
    return 'DISPONÍVEL';
  }

  async function abrirMatching(txId) {
    const data = await api('GET', '/bancario/transacoes/' + txId + '/matching');
    document.getElementById('mbcMatchTxId').value = txId;
    const resumo = document.getElementById('mbcMatchResumo');
    if (resumo) {
      resumo.innerHTML = 'Valor: <strong>' + fmtMoeda(data.valor_transacao) + '</strong>'
        + '<br>Já conciliado: ' + fmtMoeda(data.valor_conciliado || 0)
        + '<br>Disponível: <strong>' + fmtMoeda(data.valor_disponivel || 0) + '</strong>'
        + '<br>Estado: ' + escapeHtml(rotuloStatus(data.status_conciliacao || data.estado))
        + '<br>Direção: ' + escapeHtml(rotuloDirecao(data.direcao))
        + '<br>Data: ' + escapeHtml(data.data || '');
    }
    const box = document.getElementById('mbcMatchCandidatos');
    if (!box) return;
    const lista = data.candidatos || [];
    if (!lista.length) {
      box.innerHTML = '<p class="mbc-empty">Nenhum candidato determinístico encontrado para o valor disponível.</p>';
    } else {
      box.innerHTML = lista.map(function (c) {
        const tipo = c.tipo_alvo || c.tipo_registro || '';
        const isCr = tipo === 'CONTAS_RECEBER';
        const isAp = (c.rotulo_entidade === 'CONTAS_A_PAGAR')
          || (tipo === 'FINANCEIRO' && String(c.tipo || '').toLowerCase() === 'despesa');
        const motivos = (c.motivos || []).map(function (m) {
          return '<li>' + escapeHtml(rotuloMotivos([m])) + '</li>';
        }).join('');
        let corpo;
        if (isCr) {
          corpo = '<div><strong>CONTAS A RECEBER</strong> · Título #' + escapeHtml(c.alvo_id || c.registro_id) + '</div>'
            + '<div>' + escapeHtml(c.descricao || '') + '</div>'
            + '<div>Vencimento: ' + escapeHtml(c.data || '—') + '</div>'
            + '<div>Valor original: ' + fmtMoeda(c.valor_original) + '</div>'
            + '<div>Pago: ' + fmtMoeda(c.valor_pago != null ? c.valor_pago : 0) + '</div>'
            + '<div>Já conciliado: ' + fmtMoeda(c.valor_ja_conciliado || 0) + '</div>'
            + '<div>Disponível: <strong>' + fmtMoeda(c.valor_disponivel) + '</strong></div>'
            + '<div>Sugestão: <strong>' + fmtMoeda(c.valor_sugerido) + '</strong></div>'
            + '<div>Status: ' + escapeHtml(rotuloStatusCr(c.status, c.valor_disponivel, c.valor_original)) + '</div>'
            + '<div>Pagamentos: ' + escapeHtml(String(
              c.quantidade_pagamentos != null
                ? c.quantidade_pagamentos
                : (c.pagamentos && c.pagamentos.quantidade) || 0
            )) + '</div>';
        } else if (isAp) {
          corpo = '<div><strong>CONTAS A PAGAR</strong> · Título #' + escapeHtml(c.alvo_id || c.registro_id) + '</div>'
            + '<div>' + escapeHtml(c.descricao || '') + '</div>'
            + '<div>' + escapeHtml(c.data_tipo === 'vencimento' ? 'Vencimento' : 'Data') + ': '
            + escapeHtml(c.data || '—') + '</div>'
            + '<div>Valor: ' + fmtMoeda(c.valor_original) + '</div>'
            + '<div>Já conciliado: ' + fmtMoeda(c.valor_ja_conciliado || 0) + '</div>'
            + '<div>Disponível: <strong>' + fmtMoeda(c.valor_disponivel) + '</strong></div>'
            + '<div>Sugestão: <strong>' + fmtMoeda(c.valor_sugerido) + '</strong></div>'
            + '<div>Status: ' + escapeHtml(String(c.status || '—')) + '</div>';
        } else {
          corpo = '<div>' + escapeHtml(tipo) + ' #' + escapeHtml(c.alvo_id || c.registro_id) + '</div>'
            + '<div>' + escapeHtml(c.descricao || '') + '</div>'
            + '<div>Data: ' + escapeHtml(c.data || '—') + '</div>'
            + '<div>Original: ' + fmtMoeda(c.valor_original)
            + ' · Já conciliado: ' + fmtMoeda(c.valor_ja_conciliado || 0)
            + ' · Disponível: ' + fmtMoeda(c.valor_disponivel)
            + ' · Sugerido: <strong>' + fmtMoeda(c.valor_sugerido) + '</strong></div>';
        }
        return '<div class="mb-3 p-2 border rounded">'
          + '<div><strong>[' + escapeHtml(rotuloCompat(c.compatibilidade)) + ']</strong></div>'
          + corpo
          + '<ul class="mb-2">' + motivos + '</ul>'
          + '<button type="button" class="btn btn-sm btn-primary" data-mbc-match-conciliar="'
          + escapeHtml(tipo) + ':' + escapeHtml(c.alvo_id || c.registro_id)
          + ':' + escapeHtml(String(c.valor_sugerido)) + '">Conciliar</button>'
          + '</div>';
      }).join('');
    }
    abrirModal('mbcModalMatching');
  }

  async function carregarSugestoes() {
    if (!contaTransacoesId) return;
    const data = await api('GET', '/bancario/conciliacoes/sugestoes?conta_bancaria_id=' + encodeURIComponent(contaTransacoesId) + '&status=PENDENTE');
    const tbody = document.getElementById('mbcSugBody');
    if (!tbody) return;
    const lista = data.sugestoes || [];
    sugestoesCache = lista;
    const porTx = {};
    lista.forEach(function (s) {
      porTx[s.transacao_bancaria_id] = (porTx[s.transacao_bancaria_id] || []).concat([s]);
    });
    const linhas = [];
    Object.keys(porTx).forEach(function (txId) {
      const grupo = porTx[txId].slice().sort(function (a, b) { return b.score - a.score; });
      const tx = transacoesCache.filter(function (t) { return String(t.id) === String(txId); })[0] || {};
      if (grupo.length > 1) {
        linhas.push('<tr><td colspan="9">Foram encontradas múltiplas correspondências para '
          + escapeHtml(tx.descricao || ('Transação #' + txId)) + '. Nenhum candidato foi escolhido automaticamente.</td></tr>');
      }
      grupo.forEach(function (s, idx) {
        const acoes = s.status === 'PENDENTE'
          ? '<button type="button" class="btn btn-sm btn-outline-primary" data-mbc-sug-aceitar="' + s.id + '">'
            + (grupo.length > 1 ? 'Escolher correspondência' : 'Aceitar') + '</button>'
            + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-sug-recusar="' + s.id + '">Recusar</button>'
          : escapeHtml(s.status);
        linhas.push('<tr><td>' + escapeHtml(tx.data_transacao || '') + '</td>'
          + '<td>' + escapeHtml(tx.descricao || '') + '</td>'
          + '<td>' + fmtMoeda(tx.valor) + '</td>'
          + '<td>' + escapeHtml((s.tipo_registro || '') + ' #' + s.registro_id) + (grupo.length > 1 ? ' (' + (idx + 1) + ')' : '') + '</td>'
          + '<td>' + escapeHtml(s.tipo_registro || '') + '</td>'
          + '<td>' + escapeHtml(String(s.score)) + '%</td>'
          + '<td>' + escapeHtml(rotuloNivel(s.nivel_confianca)) + '</td>'
          + '<td>' + escapeHtml(rotuloMotivos(s.motivos)) + '</td>'
          + '<td class="mbc-actions">' + acoes + '</td></tr>');
      });
    });
    tbody.innerHTML = linhas.length
      ? linhas.join('')
      : '<tr><td colspan="9" class="mbc-empty">Nenhuma sugestão pendente.</td></tr>';
  }

  function atualizarResumoConciliacao() {
    const txId = (document.getElementById('mbcConcTxId') || {}).value;
    const tx = transacoesCache.filter(function (x) { return String(x.id) === String(txId); })[0];
    const sel = document.getElementById('mbcConcRegistro');
    const val = sel && sel.value;
    const parts = val ? val.split(':') : [];
    const reg = registrosElegiveisCache.filter(function (r) {
      return parts.length === 2 && String(r.origem_financeira) === parts[0] && String(r.registro_financeiro_id) === parts[1];
    })[0];
    const finEl = document.getElementById('mbcConcFinResumo');
    const diffEl = document.getElementById('mbcConcDiff');
    const valorEl = document.getElementById('mbcConcValor');
    const hintEl = document.getElementById('mbcConcValorHint');
    const disponivel = tx && tx._valorDisponivelConc != null ? Number(tx._valorDisponivelConc) : (tx ? Number(tx.valor) : 0);
    if (finEl) {
      finEl.textContent = reg
        ? (reg.data || '') + ' · ' + (reg.descricao || '') + ' · ' + fmtMoeda(reg.valor) + ' · ' + (reg.tipo || '')
        : 'Selecione um registro. A conciliação só ocorre ao confirmar.';
    }
    if (hintEl) hintEl.textContent = 'Máximo permitido: ' + fmtMoeda(disponivel) + ' (autoridade no backend).';
    if (valorEl && reg) {
      const sugerido = Math.min(disponivel, Number(reg.valor));
      if (!valorEl.value || Number(valorEl.dataset.auto) === 1) {
        valorEl.value = sugerido.toFixed(2);
        valorEl.dataset.auto = '1';
      }
      valorEl.max = String(disponivel);
    }
    if (diffEl && tx) {
      const fin = reg ? Number(reg.valor) : 0;
      const digitado = valorEl && valorEl.value ? Number(valorEl.value) : NaN;
      const aConciliar = Number.isFinite(digitado) && digitado > 0
        ? digitado
        : (reg ? Math.min(disponivel, fin) : disponivel);
      diffEl.innerHTML = 'Valor total: ' + fmtMoeda(tx.valor)
        + '<br>Conciliado: ' + fmtMoeda(Math.max(0, Number(tx.valor) - disponivel))
        + '<br>Disponível: ' + fmtMoeda(disponivel)
        + '<br>Valor financeiro: ' + (reg ? fmtMoeda(fin) : '—')
        + '<br>Valor a conciliar: ' + (reg ? fmtMoeda(aConciliar) : '—');
    }
  }

  async function abrirConciliar(txId) {
    let tx = transacoesCache.filter(function (x) { return String(x.id) === String(txId); })[0];
    if (!tx) {
      tx = { id: Number(txId), valor: 0, direcao: 'entrada', descricao: '', data_transacao: '' };
    }
    let disponivel = Number(tx.valor) || 0;
    let valorTotal = Number(tx.valor) || 0;
    try {
      const det = await api('GET', '/bancario/transacoes/' + tx.id + '/conciliacoes');
      disponivel = Number(det.valor_disponivel != null ? det.valor_disponivel : tx.valor);
      valorTotal = Number(det.valor_total != null ? det.valor_total : tx.valor);
      if (!tx.descricao && det.conciliacoes) { /* keep */ }
      if (!transacoesCache.some(function (x) { return String(x.id) === String(tx.id); })) {
        transacoesCache.push(tx);
      }
    } catch (_) { /* usa valor total */ }
    tx._valorDisponivelConc = disponivel;
    tx.valor = valorTotal || tx.valor;
    document.getElementById('mbcConcTxId').value = tx.id;
    document.getElementById('mbcConcObs').value = '';
    const valorEl = document.getElementById('mbcConcValor');
    if (valorEl) {
      valorEl.value = '';
      valorEl.dataset.auto = '1';
      valorEl.max = String(disponivel);
    }
    document.getElementById('mbcConcTxResumo').textContent =
      (tx.data_transacao || '') + ' · ' + (tx.descricao || '') + ' · total ' + fmtMoeda(valorTotal)
      + ' · disponível ' + fmtMoeda(disponivel) + ' · ' + rotuloDirecao(tx.direcao);
    const data = await api('GET', '/bancario/conciliacoes/registros-elegiveis?direcao=' + encodeURIComponent(tx.direcao));
    registrosElegiveisCache = data.registros || [];
    const sel = document.getElementById('mbcConcRegistro');
    sel.innerHTML = '<option value="">Selecione…</option>' + registrosElegiveisCache.map(function (r) {
      return '<option value="' + escapeHtml(r.origem_financeira) + ':' + r.registro_financeiro_id + '">'
        + escapeHtml((r.data || '') + ' · ' + (r.descricao || '') + ' · ' + fmtMoeda(r.valor))
        + '</option>';
    }).join('');
    atualizarResumoConciliacao();
    abrirModal('mbcModalConciliar');
  }

  async function carregarEmpresasAutorizadas() {
    empresasAutorizadasCache = [];
    if (global.CdsEmpresaContexto && typeof global.CdsEmpresaContexto.listarDisponiveis === 'function') {
      try {
        const lista = await global.CdsEmpresaContexto.listarDisponiveis();
        empresasAutorizadasCache = Array.isArray(lista) ? lista : [];
      } catch (_e) {
        empresasAutorizadasCache = [];
      }
    }
    preencherFiltroEmpresa();
  }

  async function carregar() {
    const loading = document.getElementById('mbcLoading');
    atualizarCabecalho();
    if (loading) loading.hidden = false;
    setAlerta('');
    try {
      await carregarEmpresasAutorizadas();
      const inst = await api('GET', '/bancario/instituicoes');
      instituicoesCache = inst.instituicoes || [];
      let path = '/bancario/contas';
      if (vistaTodas && filtroEmpresaId) {
        path += '?empresa_id=' + encodeURIComponent(filtroEmpresaId);
      }
      const data = await api('GET', path);
      contasCache = data.contas || [];
      renderLista(contasCache);
    } catch (err) {
      setAlerta(err.message, 'erro');
      contasCache = [];
      renderLista([]);
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function abrirModal(idEl) {
    const el = document.getElementById(idEl);
    if (global.bootstrap && el && global.bootstrap.Modal) {
      const opcoes = (idEl === 'mbcModalConta' || idEl === 'mbcModalInst')
        ? { backdrop: 'static', keyboard: false }
        : undefined;
      global.bootstrap.Modal.getOrCreateInstance(el, opcoes).show();
    } else if (el) {
      el.style.display = 'block';
    }
  }

  function fecharModal(idEl) {
    const el = document.getElementById(idEl);
    if (global.bootstrap && el && global.bootstrap.Modal) {
      const m = global.bootstrap.Modal.getInstance(el);
      if (m) m.hide();
    } else if (el) {
      el.style.display = 'none';
    }
  }

  function onEmpresa() {
    if (typeof currentPage !== 'undefined' && currentPage !== 'contas-bancarias') return;
    if (!document.getElementById('mbcLista')) return;
    vistaTodas = false;
    filtroEmpresaId = '';
    contasCache = [];
    empresasAutorizadasCache = [];
    instituicoesCache = [];
    renderLista([]);
    limparPainelTransacoes();
    contaOfDetalhe = null;
    consentimentosCache = [];
    atualizarCabecalho();
    carregar();
  }

  function initContasBancarias() {
    const shell = document.getElementById('mbcShell');
    if (shell && global.CdsPageShell && typeof global.CdsPageShell.renderHeader === 'function') {
      shell.innerHTML = global.CdsPageShell.renderHeader({
        page: 'contas-bancarias',
        titulo: 'Contas bancárias',
        subtitulo: subtituloPagina()
      });
    }
    atualizarCabecalho();

    const selVista = document.getElementById('mbcVistaEmpresas');
    if (selVista) {
      selVista.onchange = function () {
        vistaTodas = selVista.value === 'todas';
        filtroEmpresaId = '';
        contasCache = [];
        renderLista([]);
        limparPainelTransacoes();
        atualizarCabecalho();
        carregar();
      };
    }
    const selFiltro = document.getElementById('mbcFiltroEmpresa');
    if (selFiltro) {
      selFiltro.onchange = function () {
        filtroEmpresaId = selFiltro.value || '';
        carregar();
      };
    }

    const btnC = document.getElementById('mbcBtnNovaConta');
    if (btnC) btnC.onclick = function () {
      document.getElementById('mbcContaId').value = '';
      document.getElementById('mbcNome').value = '';
      document.getElementById('mbcAgencia').value = '';
      document.getElementById('mbcNumero').value = '';
      document.getElementById('mbcDigito').value = '';
      document.getElementById('mbcTitular').value = '';
      document.getElementById('mbcDoc').value = '';
      document.getElementById('mbcPrincipal').checked = false;
      const ctx = global.CdsEmpresaContexto;
      const atualId = ctx && ctx.lerEmpresaId ? ctx.lerEmpresaId() : '';
      preencherEmpresaContaSelect(vistaTodas ? '' : atualId, !vistaTodas);
      preencherInstSelect();
      abrirModal('mbcModalConta');
    };
    const btnI = document.getElementById('mbcBtnNovaInst');
    if (btnI) btnI.onclick = function () {
      document.getElementById('mbcInstNome').value = '';
      document.getElementById('mbcInstCod').value = '';
      document.getElementById('mbcInstRed').value = '';
      abrirModal('mbcModalInst');
    };
    const salvarI = document.getElementById('mbcSalvarInst');
    if (salvarI) salvarI.onclick = async function () {
      try {
        await api('POST', '/bancario/instituicoes', {
          nome: document.getElementById('mbcInstNome').value,
          codigo: document.getElementById('mbcInstCod').value,
          nome_reduzido: document.getElementById('mbcInstRed').value
        });
        fecharModal('mbcModalInst');
        await carregar();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const salvarC = document.getElementById('mbcSalvarConta');
    if (salvarC) salvarC.onclick = async function () {
      const id = document.getElementById('mbcContaId').value;
      const body = {
        instituicao_financeira_id: Number(document.getElementById('mbcInst').value),
        nome: document.getElementById('mbcNome').value,
        tipo: document.getElementById('mbcTipo').value,
        agencia: document.getElementById('mbcAgencia').value,
        numero: document.getElementById('mbcNumero').value,
        digito: document.getElementById('mbcDigito').value,
        titular: document.getElementById('mbcTitular').value,
        documento_titular: document.getElementById('mbcDoc').value,
        principal: document.getElementById('mbcPrincipal').checked
      };
      if (!id && vistaTodas) {
        const empSel = document.getElementById('mbcEmpresaConta');
        const empId = empSel && empSel.value ? Number(empSel.value) : 0;
        if (!empId) {
          setAlerta('Selecione a empresa da conta bancária.', 'erro');
          return;
        }
        body.empresa_id = empId;
      }
      try {
        if (id) await api('PUT', '/bancario/contas/' + id, body);
        else await api('POST', '/bancario/contas', body);
        fecharModal('mbcModalConta');
        await carregar();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };

    const lista = document.getElementById('mbcLista');
    if (lista) {
      lista.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        try {
          if (t.getAttribute('data-mbc-ativar')) {
            await api('PATCH', '/bancario/contas/' + t.getAttribute('data-mbc-ativar') + '/ativar');
            await carregar();
          } else if (t.getAttribute('data-mbc-desativar')) {
            await api('PATCH', '/bancario/contas/' + t.getAttribute('data-mbc-desativar') + '/desativar');
            await carregar();
          } else if (t.getAttribute('data-mbc-principal')) {
            await api('PATCH', '/bancario/contas/' + t.getAttribute('data-mbc-principal') + '/principal');
            await carregar();
          } else if (t.getAttribute('data-mbc-integracao')) {
            await abrirIntegracao(t.getAttribute('data-mbc-integracao'));
          } else if (t.getAttribute('data-mbc-transacoes')) {
            await abrirTransacoes(t.getAttribute('data-mbc-transacoes'));
          } else if (t.getAttribute('data-mbc-editar')) {
            const id = t.getAttribute('data-mbc-editar');
            const c = await api('GET', '/bancario/contas/' + id);
            document.getElementById('mbcContaId').value = c.id;
            preencherEmpresaContaSelect(c.empresa_id, true);
            preencherInstSelect(c.instituicao_financeira_id);
            document.getElementById('mbcNome').value = c.nome || '';
            document.getElementById('mbcTipo').value = c.tipo || 'CORRENTE';
            document.getElementById('mbcAgencia').value = c.agencia || '';
            document.getElementById('mbcNumero').value = c.numero || '';
            document.getElementById('mbcDigito').value = c.digito || '';
            document.getElementById('mbcTitular').value = c.titular || '';
            document.getElementById('mbcDoc').value = c.documento_titular || '';
            document.getElementById('mbcPrincipal').checked = !!c.principal;
            abrirModal('mbcModalConta');
          }
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }

    document.removeEventListener('cds-empresa-contexto-alterado', onEmpresa);
    document.addEventListener('cds-empresa-contexto-alterado', onEmpresa);

    document.querySelectorAll('.mbc-tab').forEach(function (btn) {
      btn.onclick = function () {
        selecionarAbaIntegracao(btn.getAttribute('data-mbc-tab'));
      };
    });
    const btnVoltar = document.getElementById('mbcIntVoltar');
    if (btnVoltar) btnVoltar.onclick = function () {
      fecharPainelIntegracao();
    };

    const btnMpSalvar = document.getElementById('mbcMpSalvar');
    if (btnMpSalvar) btnMpSalvar.onclick = async function () {
      if (!contaConfigId) return;
      try {
        const hid = document.getElementById('mbcMpConfigId');
        if (hid) hid.value = '';
        const configId = await garantirConfigIntegracao();
        if (!configId) return;
        const isItau = ehProviderItau();
        const corpo = {
          ambiente: (document.getElementById('mbcMpAmbiente') || {}).value
        };
        if (isItau) {
          corpo.client_id = (document.getElementById('mbcItauClientId') || {}).value;
          const segredo = (document.getElementById('mbcItauSecret') || {}).value;
          if (segredo && !isMpSecretMascara(segredo)) corpo['client' + '_secret'] = segredo;
          const cert = (document.getElementById('mbcItauCert') || {}).value;
          const key = (document.getElementById('mbcItauKey') || {}).value;
          if (cert && String(cert).trim()) corpo.certificate = String(cert).trim();
          if (key && String(key).trim()) corpo['private' + '_key'] = String(key).trim();
          const ca = (document.getElementById('mbcItauCa') || {}).value;
          if (ca && String(ca).trim()) corpo.ca = String(ca).trim();
        } else {
          corpo.client_id = (document.getElementById('mbcMpClientId') || {}).value;
          const segredo = (document.getElementById('mbcMpSecret') || {}).value;
          if (segredo && !isMpSecretMascara(segredo)) corpo['client' + '_secret'] = segredo;
        }
        const out = await api('POST', '/bancario/configuracoes/' + configId + '/credenciais', corpo);
        aplicarStatusMp(out, configId);
        setAlerta('Credenciais configuradas.', 'info');
        await carregarIntegracao();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const btnItauTestar = document.getElementById('mbcItauTestarConexao');
    if (btnItauTestar) btnItauTestar.onclick = async function () {
      const hid = document.getElementById('mbcMpConfigId');
      const configId = hid && hid.value;
      if (!configId) {
        setAlerta('Salve as credenciais Itaú antes de testar a conexão.', 'erro');
        return;
      }
      try {
        const out = await api('POST', '/bancario/configuracoes/' + configId + '/conexao/testar', {});
        if (out.success) setAlerta(out.message || 'Conexão Itaú autenticada.', 'ok');
        else setAlerta(out.message || 'Falha na conexão Itaú.', 'erro');
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const selProv = document.getElementById('mbcIntProvider');
    if (selProv) {
      selProv.onchange = function () {
        const hid = document.getElementById('mbcMpConfigId');
        if (hid) hid.value = '';
        atualizarPainelCredenciaisPorProvider(selProv.value);
        carregarIntegracao().catch(function (err) { setAlerta(err.message, 'erro'); });
      };
    }
    const btnMpRemover = document.getElementById('mbcMpRemover');
    if (btnMpRemover) btnMpRemover.onclick = async function () {
      const hid = document.getElementById('mbcMpConfigId');
      const configId = hid && hid.value;
      if (!configId) return;
      try {
        const out = await api('DELETE', '/bancario/configuracoes/' + configId + '/credenciais');
        limparCampoMpSecret();
        aplicarStatusMp(out, configId);
        setAlerta('Credenciais removidas.', 'info');
        await carregarIntegracao();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    ligarCampoMpSecret();
    const btnCfg = document.getElementById('mbcCfgCriar');
    if (btnCfg) btnCfg.onclick = async function () {
      if (!contaConfigId) return;
      try {
        await api('POST', '/bancario/configuracoes', {
          conta_bancaria_id: Number(contaConfigId),
          provider: 'MOCK',
          ambiente: 'TESTE'
        });
        await carregarIntegracao();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const btnOfCfg = document.getElementById('mbcOfCfgCriar');
    if (btnOfCfg) btnOfCfg.onclick = async function () {
      if (!contaConfigId) return;
      try {
        await api('POST', '/bancario/configuracoes', {
          conta_bancaria_id: Number(contaConfigId),
          provider: 'MOCK_OPEN_FINANCE',
          ambiente: 'TESTE'
        });
        await carregarIntegracao();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const btnSync = document.getElementById('mbcSyncAgora');
    if (btnSync) btnSync.onclick = function () { executarSincronizarAgora(); };
    const btnItauSaldo = document.getElementById('mbcItauConsultarSaldo');
    if (btnItauSaldo) btnItauSaldo.onclick = function () { executarConsultarSaldoRealItau(); };
    const btnItauExtrato = document.getElementById('mbcItauConsultarExtrato');
    if (btnItauExtrato) btnItauExtrato.onclick = function () { executarConsultarExtratoItau(); };
    const btnExtAtu = document.getElementById('mbcExtratoAtualizar');
    if (btnExtAtu) btnExtAtu.onclick = function () { carregarExtratoOperacao(); };
    const btnExtFiltrar = document.getElementById('mbcExtFiltrar');
    if (btnExtFiltrar) btnExtFiltrar.onclick = function () { carregarExtratoOperacao(); };
    const btnTestarLeitura = document.getElementById('mbcTestarLeitura');
    if (btnTestarLeitura) btnTestarLeitura.onclick = async function () {
      const hid = document.getElementById('mbcMpConfigId');
      const configId = hid && hid.value;
      if (!configId) {
        setAlerta('Configure e autorize a integração antes de testar a leitura.', 'erro');
        return;
      }
      try {
        const out = await api('POST', '/bancario/configuracoes/' + configId + '/provider/testar-leitura', {});
        if (out.status_leitura === 'PROCESSANDO') {
          setAlerta(out.mensagem || 'Relatório em processamento. Tente novamente em instantes.', 'ok');
        } else {
          const n = (out.movimentacoes || []).length;
          setAlerta('Leitura concluída: ' + n + ' movimentação(ões). Nada foi gravado no banco.', 'ok');
        }
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const btnOfAuth = document.getElementById('mbcOfAutorizar');
    if (btnOfAuth) btnOfAuth.onclick = async function () {
      const hid = document.getElementById('mbcMpConfigId');
      const configId = hid && hid.value;
      if (!configId) {
        setAlerta('Configure as credenciais antes de autorizar.', 'erro');
        return;
      }
      const msg = document.getElementById('mbcAuthMsg');
      if (msg) {
        msg.dataset.sticky = '1';
        msg.textContent = 'Preparando autorização...';
      }
      try {
        const out = await api('POST', '/bancario/configuracoes/' + configId + '/oauth/autorizar', {});
        await carregarConsentimentos();
        await carregarStatusOauth();
        if (out.authorization_url) {
          if (msg) msg.textContent = 'Conclua a autorização na janela do provider e retorne ao CDS.';
          global.open(out.authorization_url, '_blank', 'noopener');
        } else if (oauthEstaAutorizado()) {
          if (msg) {
            msg.textContent = 'Autorização já concluída. Tokens ficam somente no servidor.';
            delete msg.dataset.sticky;
          }
          setAlerta('Esta conta já está autorizada. Use Sincronizar na aba Operação.', 'info');
        } else {
          if (msg) {
            msg.textContent = 'Não foi possível obter a URL de autorização.';
            delete msg.dataset.sticky;
          }
          setAlerta('Não foi possível obter a URL de autorização do Mercado Pago.', 'erro');
        }
      } catch (err) {
        if (msg) {
          msg.textContent = err && err.message
            ? String(err.message).split('\n')[0]
            : 'Não foi possível concluir a autorização.';
          delete msg.dataset.sticky;
        }
        setAlerta(err.message, 'erro');
      }
    };
    const btnOfDisc = document.getElementById('mbcOfDesconectar');
    if (btnOfDisc) btnOfDisc.onclick = async function () {
      const hid = document.getElementById('mbcMpConfigId');
      const configId = hid && hid.value;
      if (!configId) return;
      if (!global.confirm('Remover a autorização local desta integração?')) return;
      try {
        await api('POST', '/bancario/configuracoes/' + configId + '/oauth/desconectar', {});
        await carregarConsentimentos();
        await carregarStatusOauth();
        setAlerta('Autorização local removida.', 'ok');
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const cfgBody = document.getElementById('mbcCfgBody');
    if (cfgBody) {
      cfgBody.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        try {
          if (t.getAttribute('data-mbc-cfg-on')) {
            await api('PATCH', '/bancario/configuracoes/' + t.getAttribute('data-mbc-cfg-on') + '/ativar');
            await carregarIntegracao();
          } else if (t.getAttribute('data-mbc-cfg-off')) {
            await api('PATCH', '/bancario/configuracoes/' + t.getAttribute('data-mbc-cfg-off') + '/desativar');
            await carregarIntegracao();
          }
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }
    const ofBody = document.getElementById('mbcOfBody');
    if (ofBody) {
      ofBody.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        try {
          if (t.getAttribute('data-mbc-of-revogar')) {
            await api('POST', '/bancario/open-finance/consentimentos/' + t.getAttribute('data-mbc-of-revogar') + '/revogar', {});
            await carregarConsentimentos();
          } else if (t.getAttribute('data-mbc-of-renovar')) {
            const out = await api('POST', '/bancario/open-finance/consentimentos/' + t.getAttribute('data-mbc-of-renovar') + '/renovar', {});
            await carregarConsentimentos();
            if (out.authorization_url && /^\/api\/bancario\/open-finance\//.test(out.authorization_url)) {
              global.location.assign(apiUrl().replace(/\/api$/, '') + out.authorization_url);
            }
          } else if (t.getAttribute('data-mbc-of-concluir')) {
            const id = Number(t.getAttribute('data-mbc-of-concluir'));
            const item = consentimentosCache.filter(function (c) { return Number(c.id) === id; })[0];
            if (item && item.status === 'AGUARDANDO_AUTORIZACAO') {
              const out = await api('POST', '/bancario/open-finance/consentimentos', {
                conta_bancaria_id: Number(contaConfigId),
                provider: 'MOCK_OPEN_FINANCE',
                escopos: item.escopos || ['CONTAS', 'SALDOS', 'TRANSACOES']
              });
              if (out.authorization_url && /^\/api\/bancario\/open-finance\//.test(out.authorization_url)) {
                global.location.assign(apiUrl().replace(/\/api$/, '') + out.authorization_url);
              }
            }
          }
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }

    const btnFiltro = document.getElementById('mbcTxFiltrar');
    if (btnFiltro) btnFiltro.onclick = function () {
      carregarTransacoes().catch(function (err) { setAlerta(err.message, 'erro'); });
    };
    const btnSug = document.getElementById('mbcSugAnalisar');
    if (btnSug) btnSug.onclick = async function () {
      if (!contaTransacoesId) return;
      try {
        await api('POST', '/bancario/contas/' + contaTransacoesId + '/analisar-conciliacoes', {});
        await carregarTransacoes();
        await carregarSugestoes();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };
    const sugBody = document.getElementById('mbcSugBody');
    if (sugBody) {
      sugBody.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        try {
          if (t.getAttribute('data-mbc-sug-aceitar')) {
            await api('POST', '/bancario/conciliacoes/sugestoes/' + t.getAttribute('data-mbc-sug-aceitar') + '/aceitar', {});
            await carregarTransacoes();
            await carregarSugestoes();
          } else if (t.getAttribute('data-mbc-sug-recusar')) {
            await api('POST', '/bancario/conciliacoes/sugestoes/' + t.getAttribute('data-mbc-sug-recusar') + '/recusar', {});
            await carregarSugestoes();
          }
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }

    const txBody = document.getElementById('mbcTxBody');
    if (txBody) {
      txBody.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        try {
          if (t.getAttribute('data-mbc-conciliar')) {
            await abrirConciliar(t.getAttribute('data-mbc-conciliar'));
          } else if (t.getAttribute('data-mbc-matching')) {
            await abrirMatching(t.getAttribute('data-mbc-matching'));
          } else if (t.getAttribute('data-mbc-ignorar')) {
            await api('POST', '/bancario/transacoes/' + t.getAttribute('data-mbc-ignorar') + '/ignorar', {});
            await carregarTransacoes();
          } else if (t.getAttribute('data-mbc-divergente')) {
            const obs = global.prompt('Observação obrigatória para marcar como divergente:');
            if (!obs || !String(obs).trim()) {
              setAlerta('Observação é obrigatória para marcar como divergente.', 'erro');
              return;
            }
            await api('POST', '/bancario/transacoes/' + t.getAttribute('data-mbc-divergente') + '/divergente', { observacao: obs });
            await carregarTransacoes();
          } else if (t.getAttribute('data-mbc-desconciliar')) {
            await api('POST', '/bancario/conciliacoes/' + t.getAttribute('data-mbc-desconciliar') + '/desconciliar', {});
            await carregarTransacoes();
          }
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }

    const pendBody = document.getElementById('mbcPendBody');
    if (pendBody) {
      pendBody.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute) return;
        try {
          if (t.getAttribute('data-mbc-conciliar')) {
            await abrirConciliar(t.getAttribute('data-mbc-conciliar'));
          } else if (t.getAttribute('data-mbc-matching')) {
            await abrirMatching(t.getAttribute('data-mbc-matching'));
          }
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }

    const matchBox = document.getElementById('mbcMatchCandidatos');
    if (matchBox) {
      matchBox.onclick = async function (ev) {
        const t = ev.target;
        if (!t || !t.getAttribute || !t.getAttribute('data-mbc-match-conciliar')) return;
        const raw = t.getAttribute('data-mbc-match-conciliar');
        const parts = String(raw).split(':');
        const txId = document.getElementById('mbcMatchTxId').value;
        if (parts.length < 3 || !txId) return;
        try {
          await api('POST', '/bancario/transacoes/' + Number(txId) + '/conciliacoes', {
            origem_financeira: parts[0],
            registro_financeiro_id: Number(parts[1]),
            valor_conciliado: Number(parts[2]),
            origem_conciliacao: 'MANUAL',
            observacao: 'Conciliação via matching determinístico'
          });
          fecharModal('mbcModalMatching');
          await carregarTransacoes();
        } catch (err) {
          setAlerta(err.message, 'erro');
        }
      };
    }

    const selReg = document.getElementById('mbcConcRegistro');
    if (selReg) selReg.onchange = atualizarResumoConciliacao;
    const valorInp = document.getElementById('mbcConcValor');
    if (valorInp) {
      valorInp.oninput = function () {
        valorInp.dataset.auto = '0';
        atualizarResumoConciliacao();
      };
    }

    const btnConf = document.getElementById('mbcConcConfirmar');
    if (btnConf) btnConf.onclick = async function () {
      const txId = document.getElementById('mbcConcTxId').value;
      const opt = document.getElementById('mbcConcRegistro');
      const val = opt && opt.value;
      if (!val) {
        setAlerta('Selecione um registro financeiro.', 'erro');
        return;
      }
      const parts = val.split(':');
      const tx = transacoesCache.filter(function (x) { return String(x.id) === String(txId); })[0];
      const reg = registrosElegiveisCache.filter(function (r) {
        return String(r.origem_financeira) === parts[0] && String(r.registro_financeiro_id) === parts[1];
      })[0];
      if (!tx || !reg) {
        setAlerta('Selecione um registro financeiro.', 'erro');
        return;
      }
      try {
        const disponivel = tx._valorDisponivelConc != null ? Number(tx._valorDisponivelConc) : Number(tx.valor);
        const valorEl = document.getElementById('mbcConcValor');
        let valorConciliar = valorEl && valorEl.value ? Number(valorEl.value) : Math.min(disponivel, Number(reg.valor));
        if (!Number.isFinite(valorConciliar) || valorConciliar <= 0) {
          setAlerta('Informe um valor válido para conciliar.', 'erro');
          return;
        }
        await api('POST', '/bancario/transacoes/' + Number(txId) + '/conciliacoes', {
          origem_financeira: reg.origem_financeira,
          registro_financeiro_id: Number(reg.registro_financeiro_id),
          valor_conciliado: valorConciliar,
          origem_conciliacao: 'MANUAL',
          observacao: (document.getElementById('mbcConcObs') || {}).value
        });
        fecharModal('mbcModalConciliar');
        await carregarTransacoes();
      } catch (err) {
        setAlerta(err.message, 'erro');
      }
    };

    carregar();
  }

  global.initContasBancarias = initContasBancarias;
})(typeof window !== 'undefined' ? window : this);
