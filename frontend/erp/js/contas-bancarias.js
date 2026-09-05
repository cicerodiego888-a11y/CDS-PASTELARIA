/**
 * MBC-02/06 — contas, transações, conciliação e autorização Open Finance da empresa do contexto.
 * Sem matching automático. Sem senha bancária na tela.
 */
(function (global) {
  'use strict';

  var instituicoesCache = [];

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

  function rotuloEmpresa() {
    const ctx = global.CdsEmpresaContexto;
    if (!ctx) return 'Empresa do contexto operacional';
    const emp = ctx.lerEmpresa && ctx.lerEmpresa();
    if (emp && ctx.rotuloEmpresa) return ctx.rotuloEmpresa(emp).replace(/\n/g, ' · ');
    const id = ctx.lerEmpresaId && ctx.lerEmpresaId();
    return id ? ('Empresa #' + id) : 'Empresa do contexto operacional';
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
    if (data && data.error) return String(data.error).split('\n')[0];
    if (status === 403) return 'Você não possui acesso à empresa informada.';
    return 'Não foi possível concluir a operação.';
  }

  async function api(method, path, body) {
    const opt = { method: method, headers: headersJson() };
    if (body != null) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const resp = await fetch(apiUrl() + path, opt);
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) throw Object.assign(new Error(mensagemErro(data, resp.status)), { status: resp.status });
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

  function renderLista(contas) {
    const el = document.getElementById('mbcLista');
    if (!el) return;
    if (!contas || !contas.length) {
      el.innerHTML = '<p class="mbc-empty">Nenhuma conta bancária nesta empresa.</p>';
      return;
    }
    el.innerHTML = '<table class="mbc-table"><thead><tr>'
      + '<th>Instituição</th><th>Nome</th><th>Tipo</th><th>Agência</th><th>Número</th>'
      + '<th>Ativa</th><th>Principal</th><th></th></tr></thead><tbody>'
      + contas.map(function (c) {
        return '<tr><td>' + escapeHtml(c.instituicao_nome || '') + '</td>'
          + '<td>' + escapeHtml(c.nome) + '</td>'
          + '<td>' + escapeHtml(c.tipo) + '</td>'
          + '<td>' + escapeHtml(c.agencia || '—') + '</td>'
          + '<td>' + escapeHtml(c.numero) + (c.digito ? '-' + escapeHtml(c.digito) : '') + '</td>'
          + '<td>' + (c.ativa ? 'Sim' : 'Não') + '</td>'
          + '<td>' + (c.principal ? 'Sim' : 'Não') + '</td>'
          + '<td class="mbc-actions">'
          + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-integracao="' + c.id + '">Integração</button>'
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

  var contaTransacoesId = null;
  var contaConfigId = null;
  var contaOfDetalhe = null;
  var transacoesCache = [];
  var registrosElegiveisCache = [];
  var consentimentosCache = [];
  var sugestoesCache = [];

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
    if (s === 'conciliada') return 'Conciliada';
    if (s === 'ignorada') return 'Ignorada';
    if (s === 'divergente') return 'Divergente';
    return 'Pendente';
  }

  function limparPainelTransacoes() {
    contaTransacoesId = null;
    transacoesCache = [];
    registrosElegiveisCache = [];
    const painel = document.getElementById('mbcPainelTransacoes');
    if (painel) painel.hidden = true;
    const tbody = document.getElementById('mbcTxBody');
    if (tbody) tbody.innerHTML = '';
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
    ['mbcSyncSaldoBancario', 'mbcSyncSaldoConceitual', 'mbcSyncDiferenca', 'mbcSyncQtd'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    const ind = document.getElementById('mbcSyncIndicador');
    if (ind) ind.textContent = 'Nunca sincronizado.';
    const sel = document.getElementById('mbcConcRegistro');
    if (sel) sel.innerHTML = '';
    const txId = document.getElementById('mbcConcTxId');
    if (txId) txId.value = '';
    sugestoesCache = [];
    const sugBody = document.getElementById('mbcSugBody');
    if (sugBody) sugBody.innerHTML = '';
  }

  function acoesConciliacao(t, conc) {
    const st = conc ? conc.status : 'pendente';
    if (st === 'conciliada' && conc && conc.ativo) {
      return '<span>Registro ' + escapeHtml(conc.origem_financeira || '') + ' #' + escapeHtml(conc.registro_financeiro_id) + '</span> '
        + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-desconciliar="' + conc.id + '">Desconciliar</button>';
    }
    if (st === 'ignorada') return 'Ignorada';
    if (st === 'divergente') return 'Divergente' + (conc && conc.observacao ? ': ' + escapeHtml(conc.observacao) : '');
    if (t.direcao === 'transferencia') return '—';
    return '<button type="button" class="btn btn-sm btn-outline-primary" data-mbc-conciliar="' + t.id + '">Conciliar</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-ignorar="' + t.id + '">Ignorar</button>'
      + '<button type="button" class="btn btn-sm btn-outline-secondary" data-mbc-divergente="' + t.id + '">Marcar como divergente</button>';
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
      if (c.ativo) porTx[c.transacao_bancaria_id] = c;
    });
    const elSaldo = document.getElementById('mbcSaldoConceitual');
    if (elSaldo) elSaldo.textContent = fmtMoeda(saldo.saldo_conceitual);
    const tbody = document.getElementById('mbcTxBody');
    if (!tbody) return;
    const lista = data.transacoes || [];
    transacoesCache = lista;
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="mbc-empty">Nenhuma transação no período.</td></tr>';
      return;
    }
    tbody.innerHTML = lista.map(function (t) {
      const conc = porTx[t.id];
      const st = conc ? conc.status : 'pendente';
      const entrada = t.direcao === 'entrada' ? fmtMoeda(t.valor) : '—';
      const saida = t.direcao === 'saida' ? fmtMoeda(t.valor) : '—';
      return '<tr><td>' + escapeHtml(t.data_transacao || '') + '</td>'
        + '<td>' + escapeHtml(t.descricao || '') + '</td>'
        + '<td>' + escapeHtml(t.tipo || '') + '</td>'
        + '<td>' + entrada + '</td>'
        + '<td>' + saida + '</td>'
        + '<td>' + escapeHtml(rotuloDirecao(t.direcao)) + '</td>'
        + '<td>' + escapeHtml(rotuloStatus(st)) + '</td>'
        + '<td class="mbc-actions">' + acoesConciliacao(t, conc) + '</td></tr>';
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
      return;
    }
    tbody.innerHTML = lista.map(function (c) {
      const rotuloProv = c.provider === 'OPEN_FINANCE_REAL'
        ? 'OPEN_FINANCE_REAL <span class="mbc-empty">(BLOQUEADO — ainda não homologável. Este provider ainda não está habilitado para operação real.)</span>'
        : escapeHtml(c.provider) + ' <span class="mbc-empty">(Provider de teste)</span>';
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
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="mbc-empty">Nenhum consentimento nesta conta.</td></tr>';
      return;
    }
    const inst = contaOfDetalhe && contaOfDetalhe.instituicao_nome ? contaOfDetalhe.instituicao_nome : '';
    const contaNome = contaOfDetalhe ? ((contaOfDetalhe.nome || '') + ' · ' + (contaOfDetalhe.numero || '')) : '';
    tbody.innerHTML = lista.map(function (c) {
      return '<tr><td>' + escapeHtml(inst) + '</td>'
        + '<td>' + escapeHtml(contaNome) + '</td>'
        + '<td>' + escapeHtml(c.provider) + '</td>'
        + '<td>' + escapeHtml(rotuloStatusOf(c.status)) + '</td>'
        + '<td>' + escapeHtml((c.escopos || []).join(', ')) + '</td>'
        + '<td>' + escapeHtml(c.expira_em || '—') + '</td>'
        + '<td>' + escapeHtml(c.autorizado_em || '—') + '</td>'
        + '<td class="mbc-actions">' + acoesOf(c) + '</td></tr>';
    }).join('');
  }

  function rotuloSync(st) {
    if (st === 'SUCESSO') return '● Sincronizado';
    if (st === 'ERRO') return '● Erro na sincronização';
    if (st === 'SINCRONIZANDO') return '● Sincronizando';
    if (st === 'CONSENTIMENTO_EXPIRADO') return '● Erro na sincronização';
    if (st === 'CONSENTIMENTO_REVOGADO') return '● Erro na sincronização';
    if (st === 'BLOQUEADO') return '● Bloqueado';
    return '● Pendente';
  }

  async function carregarSincronizacao() {
    if (!contaConfigId) return;
    const sync = await api('GET', '/bancario/contas/' + contaConfigId + '/sincronizacao');
    const saldo = await api('GET', '/bancario/contas/' + contaConfigId + '/saldo-bancario');
    const extrato = await api('GET', '/bancario/contas/' + contaConfigId + '/extrato?limite=200');
    const ind = document.getElementById('mbcSyncIndicador');
    if (ind) {
      let txt = rotuloSync(sync.status);
      if (sync.status === 'SUCESSO' && sync.ultima_sincronizacao_em) {
        txt += '\nÚltima sincronização:\n' + sync.ultima_sincronizacao_em;
      } else if (sync.ultima_sincronizacao_em) {
        txt += '\nÚltima tentativa:\n' + sync.ultima_sincronizacao_em;
      }
      if (sync.ultimo_erro) txt += '\nErro:\n' + sync.ultimo_erro;
      ind.textContent = txt;
    }
    const elB = document.getElementById('mbcSyncSaldoBancario');
    const elC = document.getElementById('mbcSyncSaldoConceitual');
    const elD = document.getElementById('mbcSyncDiferenca');
    const elQ = document.getElementById('mbcSyncQtd');
    if (elB) elB.textContent = saldo.saldo_bancario == null ? '—' : fmtMoeda(saldo.saldo_bancario);
    if (elC) elC.textContent = fmtMoeda(saldo.saldo_conceitual);
    if (elD) elD.textContent = saldo.diferenca == null ? '—' : fmtMoeda(saldo.diferenca);
    const lista = extrato.transacoes || [];
    if (elQ) elQ.textContent = String(lista.length);
    const tbody = document.getElementById('mbcExtratoBody');
    if (!tbody) return;
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="mbc-empty">Nenhum lançamento importado.</td></tr>';
      return;
    }
    tbody.innerHTML = lista.map(function (t) {
      return '<tr><td>' + escapeHtml(t.data_transacao || '') + '</td>'
        + '<td>' + escapeHtml(t.descricao || '') + '</td>'
        + '<td>' + escapeHtml(t.tipo || '') + '</td>'
        + '<td>' + fmtMoeda(t.valor) + '</td>'
        + '<td>' + (t.saldo_apos_transacao == null ? '—' : fmtMoeda(t.saldo_apos_transacao)) + '</td>'
        + '<td>Importada</td></tr>';
    }).join('');
  }

  async function abrirIntegracao(id) {
    contaConfigId = id;
    const painel = document.getElementById('mbcPainelConfig');
    if (painel) painel.hidden = false;
    try {
      const c = await api('GET', '/bancario/contas/' + id);
      contaOfDetalhe = c;
      const el = document.getElementById('mbcCfgContaNome');
      if (el) el.textContent = (c.nome || '') + ' · ' + (c.numero || '');
      await carregarIntegracao();
      await carregarConsentimentos();
      await carregarSincronizacao();
    } catch (err) {
      setAlerta(err.message, 'erro');
    }
  }

  async function abrirTransacoes(id) {
    contaTransacoesId = id;
    transacoesCache = [];
    registrosElegiveisCache = [];
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
      DESCRICAO_PARCIAL: 'Descrição parcial'
    };
    return (lista || []).map(function (m) { return map[m] || m; }).join(', ');
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
    if (finEl) {
      finEl.textContent = reg
        ? (reg.data || '') + ' · ' + (reg.descricao || '') + ' · ' + fmtMoeda(reg.valor) + ' · ' + (reg.tipo || '')
        : 'Selecione um registro. A conciliação só ocorre ao confirmar.';
    }
    if (diffEl && tx) {
      const fin = reg ? Number(reg.valor) : 0;
      const banco = Number(tx.valor);
      diffEl.innerHTML = 'Valor bancário: ' + fmtMoeda(banco)
        + '<br>Valor financeiro: ' + (reg ? fmtMoeda(fin) : '—')
        + '<br>Diferença: ' + (reg ? fmtMoeda(banco - fin) : '—')
        + '<br>Valor a conciliar: ' + fmtMoeda(banco);
    }
  }

  async function abrirConciliar(txId) {
    const tx = transacoesCache.filter(function (x) { return String(x.id) === String(txId); })[0];
    if (!tx) return;
    document.getElementById('mbcConcTxId').value = tx.id;
    document.getElementById('mbcConcObs').value = '';
    document.getElementById('mbcConcTxResumo').textContent =
      (tx.data_transacao || '') + ' · ' + (tx.descricao || '') + ' · ' + fmtMoeda(tx.valor) + ' · ' + rotuloDirecao(tx.direcao);
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

  async function carregar() {
    const loading = document.getElementById('mbcLoading');
    const emp = document.getElementById('mbcEmpresa');
    if (emp) emp.textContent = rotuloEmpresa();
    if (loading) loading.hidden = false;
    setAlerta('');
    try {
      const inst = await api('GET', '/bancario/instituicoes');
      instituicoesCache = inst.instituicoes || [];
      const data = await api('GET', '/bancario/contas');
      renderLista(data.contas || []);
    } catch (err) {
      setAlerta(err.message, 'erro');
      renderLista([]);
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function abrirModal(idEl) {
    const el = document.getElementById(idEl);
    if (global.bootstrap && el && global.bootstrap.Modal) {
      global.bootstrap.Modal.getOrCreateInstance(el).show();
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
    limparPainelTransacoes();
    contaOfDetalhe = null;
    consentimentosCache = [];
    carregar();
  }

  function initContasBancarias() {
    const shell = document.getElementById('mbcShell');
    if (shell && global.CdsPageShell && typeof global.CdsPageShell.renderHeader === 'function') {
      shell.innerHTML = global.CdsPageShell.renderHeader({
        page: 'contas-bancarias',
        titulo: 'Contas bancárias',
        subtitulo: 'Cadastro da empresa atual'
      });
    }
    const emp = document.getElementById('mbcEmpresa');
    if (emp) emp.textContent = rotuloEmpresa();

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
    if (btnSync) btnSync.onclick = async function () {
      if (!contaConfigId) return;
      try {
        await api('POST', '/bancario/contas/' + contaConfigId + '/sincronizar', {});
        await carregarSincronizacao();
      } catch (err) {
        setAlerta(err.message, 'erro');
        try { await carregarSincronizacao(); } catch (_) { /* ignore */ }
      }
    };
    const btnOfAuth = document.getElementById('mbcOfAutorizar');
    if (btnOfAuth) btnOfAuth.onclick = async function () {
      if (!contaConfigId) return;
      if (!global.confirm('Você será direcionado ao ambiente da instituição/provedor para autorizar o compartilhamento de dados.')) {
        return;
      }
      try {
        const out = await api('POST', '/bancario/open-finance/consentimentos', {
          conta_bancaria_id: Number(contaConfigId),
          provider: 'MOCK_OPEN_FINANCE',
          escopos: ['CONTAS', 'SALDOS', 'TRANSACOES']
        });
        await carregarConsentimentos();
        if (out.authorization_url && /^\/api\/bancario\/open-finance\//.test(out.authorization_url)) {
          global.location.assign(apiUrl().replace(/\/api$/, '') + out.authorization_url);
        }
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

    const selReg = document.getElementById('mbcConcRegistro');
    if (selReg) selReg.onchange = atualizarResumoConciliacao;

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
        await api('POST', '/bancario/conciliacoes', {
          transacao_bancaria_id: Number(txId),
          origem_financeira: reg.origem_financeira,
          registro_financeiro_id: Number(reg.registro_financeiro_id),
          valor_conciliado: Number(tx.valor),
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
