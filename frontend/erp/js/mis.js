/**
 * MIS — visão gerencial da empresa do contexto (04.02 + 05).
 * Sem mistura de empresas. Sem MUC. Empresa só pelo backend.
 */
(function (global) {
  'use strict';

  var misChartEvolucao = null;

  function apiUrl() {
    return (typeof API_URL === 'string' && API_URL.trim())
      ? API_URL
      : (global.location.origin + '/api');
  }

  function isoHoje() {
    const d = new Date();
    return isoLocal(d);
  }

  function isoLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function addDias(iso, delta) {
    const [y, m, d] = String(iso).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + delta);
    return isoLocal(dt);
  }

  function moeda(v) {
    const n = Number(v);
    const x = Number.isFinite(n) ? n : 0;
    if (typeof formatarMoedaDashboard === 'function') return formatarMoedaDashboard(x);
    return x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function inteiro(v) {
    const n = Number(v);
    return String(Number.isFinite(n) ? Math.round(n) : 0);
  }

  function qtdFmt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : String(n);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatarBr(iso) {
    const p = String(iso || '').split('-');
    if (p.length !== 3) return iso || '—';
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function headersMis() {
    if (global.CdsEmpresaContexto && typeof global.CdsEmpresaContexto.headersJson === 'function') {
      return global.CdsEmpresaContexto.headersJson();
    }
    return {
      Authorization: 'Bearer ' + (global.localStorage.getItem('token') || '')
    };
  }

  function modoFiscal() {
    if (typeof modoFiscalQueryParam === 'function') return modoFiscalQueryParam();
    return global.localStorage.getItem('pdv_modo_fiscal_ativo') === '1' ? '1' : '0';
  }

  function rotuloEmpresa() {
    const ctx = global.CdsEmpresaContexto;
    if (!ctx) return 'Empresa do contexto operacional';
    const emp = ctx.lerEmpresa && ctx.lerEmpresa();
    if (emp && ctx.rotuloEmpresa) return ctx.rotuloEmpresa(emp).replace(/\n/g, ' · ');
    const id = ctx.lerEmpresaId && ctx.lerEmpresaId();
    return id ? ('Empresa #' + id) : 'Empresa do contexto operacional';
  }

  function periodoAtual() {
    const inicio = document.getElementById('misDataInicio');
    const fim = document.getElementById('misDataFim');
    return {
      inicio: (inicio && inicio.value) || isoHoje(),
      fim: (fim && fim.value) || isoHoje()
    };
  }

  function compararAtivo() {
    const el = document.getElementById('misComparar');
    return !!(el && el.checked);
  }

  function aplicarAtalho(tipo) {
    const hoje = isoHoje();
    let inicio = hoje;
    let fim = hoje;
    if (tipo === '7') inicio = addDias(hoje, -6);
    else if (tipo === '30') inicio = addDias(hoje, -29);
    else if (tipo === 'mes') {
      const d = new Date();
      inicio = isoLocal(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    const elI = document.getElementById('misDataInicio');
    const elF = document.getElementById('misDataFim');
    if (elI) elI.value = inicio;
    if (elF) elF.value = fim;
    carregarResumoMis();
  }

  function setAlerta(msg, tipo) {
    const el = document.getElementById('misAlerta');
    if (!el) return;
    if (!msg) {
      el.innerHTML = '';
      return;
    }
    const cls = tipo === 'erro' ? 'alert-danger' : 'alert-info';
    el.innerHTML = '<div class="alert ' + cls + ' py-2">' + escapeHtml(msg) + '</div>';
  }

  function destruirGrafico() {
    if (misChartEvolucao && typeof misChartEvolucao.destroy === 'function') {
      misChartEvolucao.destroy();
    }
    misChartEvolucao = null;
  }

  function limparConteudoDinamico() {
    destruirGrafico();
    const idsZeroMoeda = ['misFat', 'misTicket', 'misComprasTotal', 'misReceberTotal'];
    idsZeroMoeda.forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.textContent = 'R$ 0,00';
    });
    ['misQtdVendas', 'misFiscalQtd'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.textContent = '0';
    });
    ['misFatCmp', 'misQtdCmp', 'misTicketCmp'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) {
        el.hidden = true;
        el.innerHTML = '';
      }
    });
    const ranking = document.getElementById('misRanking');
    if (ranking) {
      ranking.className = 'mis-empty';
      ranking.textContent = 'Nenhum produto vendido no período.';
    }
    const estoque = document.getElementById('misEstoque');
    if (estoque) {
      estoque.className = 'mis-empty';
      estoque.textContent = 'Nenhum produto abaixo do mínimo.';
    }
    const tab = document.getElementById('misEvolucaoTabela');
    if (tab) tab.innerHTML = '';
    const ev = document.getElementById('misEvolucaoVazio');
    if (ev) ev.textContent = 'Sem vendas no período.';
  }

  function rotuloVariacao(itemEstado, percentual) {
    if (itemEstado === 'sem_base') return 'Sem base para comparação';
    if (itemEstado === 'sem_variacao') return 'Sem variação';
    const n = Number(percentual);
    if (!Number.isFinite(n)) return 'Sem base para comparação';
    const sinal = n > 0 ? '+' : '';
    return sinal + n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
  }

  function classeVariacao(itemEstado, percentual) {
    if (itemEstado !== 'ok') return '';
    const n = Number(percentual);
    if (n > 0) return 'mis-var-up';
    if (n < 0) return 'mis-var-down';
    return '';
  }

  function preencherComparacaoCard(elId, rotuloAtual, rotuloAnterior, estado, percentual) {
    const el = document.getElementById(elId);
    if (!el) return;
    const cls = classeVariacao(estado, percentual);
    el.hidden = false;
    el.innerHTML = '<strong>Período atual</strong>: ' + escapeHtml(rotuloAtual)
      + '<br><strong>Período anterior</strong>: ' + escapeHtml(rotuloAnterior)
      + '<br>Variação: <span class="' + cls + '">' + escapeHtml(rotuloVariacao(estado, percentual)) + '</span>';
  }

  function renderComparacao(cmp) {
    if (!cmp || !cmp.habilitada) {
      ['misFatCmp', 'misQtdCmp', 'misTicketCmp'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) {
          el.hidden = true;
          el.innerHTML = '';
        }
      });
      return;
    }
    const atual = cmp.atual || {};
    const ant = cmp.anterior || {};
    const v = cmp.variacao || {};
    preencherComparacaoCard('misFatCmp', moeda(atual.faturamento), moeda(ant.faturamento), v.faturamento_estado, v.faturamento);
    preencherComparacaoCard('misQtdCmp', inteiro(atual.vendas), inteiro(ant.vendas), v.vendas_estado, v.vendas);
    preencherComparacaoCard('misTicketCmp', moeda(atual.ticket_medio), moeda(ant.ticket_medio), v.ticket_medio_estado, v.ticket_medio);
  }

  function renderEvolucao(serie) {
    const lista = Array.isArray(serie) ? serie : [];
    const vazio = document.getElementById('misEvolucaoVazio');
    const wrap = document.getElementById('misChartWrap');
    const tab = document.getElementById('misEvolucaoTabela');
    const temVenda = lista.some(function (d) { return Number(d.total_vendas) > 0 || Number(d.faturamento) > 0; });
    if (vazio) vazio.hidden = temVenda || lista.length === 0;
    if (vazio && lista.length && !temVenda) vazio.hidden = false;
    if (vazio && lista.length === 0) vazio.hidden = false;

    if (tab) {
      if (!lista.length) {
        tab.innerHTML = '';
      } else {
        tab.innerHTML = '<table class="mis-table"><thead><tr><th>Dia</th><th>Faturamento</th><th>Vendas</th></tr></thead><tbody>'
          + lista.map(function (d) {
            return '<tr><td>' + escapeHtml(formatarBr(d.data)) + '</td><td>'
              + escapeHtml(moeda(d.faturamento)) + '</td><td>'
              + escapeHtml(inteiro(d.total_vendas)) + '</td></tr>';
          }).join('') + '</tbody></table>';
      }
    }

    destruirGrafico();
    const canvas = document.getElementById('misEvolucaoChart');
    const ChartCtor = global.Chart;
    if (wrap) wrap.hidden = !lista.length;
    if (!canvas || !ChartCtor || !lista.length) return;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    misChartEvolucao = new ChartCtor(ctx, {
      type: 'line',
      data: {
        labels: lista.map(function (d) { return formatarBr(d.data); }),
        datasets: [
          {
            label: 'Faturamento',
            data: lista.map(function (d) { return Number(d.faturamento) || 0; }),
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37, 99, 235, 0.12)',
            tension: 0.2,
            fill: true,
            yAxisID: 'y'
          },
          {
            label: 'Nº de vendas',
            data: lista.map(function (d) { return Number(d.total_vendas) || 0; }),
            borderColor: '#059669',
            backgroundColor: 'transparent',
            tension: 0.2,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'bottom' } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: function (v) { return moeda(v); } } },
          y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } }
        }
      }
    });
  }

  function renderRanking(lista) {
    const el = document.getElementById('misRanking');
    if (!el) return;
    if (!lista || !lista.length) {
      el.className = 'mis-empty';
      el.textContent = 'Nenhum produto vendido no período.';
      return;
    }
    el.className = '';
    el.innerHTML = '<table class="mis-table"><thead><tr><th>Pos.</th><th>Produto</th><th>Qtd.</th></tr></thead><tbody>'
      + lista.map(function (p, i) {
        return '<tr><td class="mis-num">' + (i + 1) + 'º</td><td>'
          + escapeHtml(p.nome) + '</td><td class="mis-num">'
          + escapeHtml(qtdFmt(p.quantidade_vendida)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderEstoque(lista) {
    const el = document.getElementById('misEstoque');
    if (!el) return;
    if (!lista || !lista.length) {
      el.className = 'mis-empty';
      el.textContent = 'Nenhum produto abaixo do mínimo.';
      return;
    }
    el.className = '';
    el.innerHTML = '<table class="mis-table"><thead><tr><th>Produto</th><th>Atual</th><th>Mín.</th><th>Dif.</th></tr></thead><tbody>'
      + lista.map(function (p) {
        const dif = p.diferenca != null ? Number(p.diferenca) : (Number(p.estoque) - Number(p.estoque_minimo));
        const difTxt = (Number.isFinite(dif) && dif > 0 ? '+' : '') + (Number.isFinite(dif) ? dif : '0');
        return '<tr><td>' + escapeHtml(p.nome) + '</td>'
          + '<td class="mis-num">' + escapeHtml(qtdFmt(p.estoque)) + '</td>'
          + '<td class="mis-num">' + escapeHtml(qtdFmt(p.estoque_minimo)) + '</td>'
          + '<td class="mis-num">' + escapeHtml(difTxt) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function preencher(data) {
    const v = data.vendas || {};
    const c = data.compras || {};
    const r = data.receber || {};
    const f = data.fiscal || {};
    const p = data.periodo || periodoAtual();
    document.getElementById('misFat').textContent = moeda(v.faturamento);
    document.getElementById('misQtdVendas').textContent = inteiro(v.total_vendas);
    document.getElementById('misTicket').textContent = moeda(v.ticket_medio);
    document.getElementById('misComprasTotal').textContent = moeda(c.total);
    document.getElementById('misComprasQtd').textContent = inteiro(c.quantidade) + ' compras';
    document.getElementById('misReceberTotal').textContent = moeda(r.total);
    document.getElementById('misReceberQtd').textContent = inteiro(r.quantidade) + ' títulos';
    const fq = document.getElementById('misFiscalQtd');
    if (fq) fq.textContent = inteiro(f.quantidade);
    document.getElementById('misFiscal').textContent =
      'NFC-e emitidas: ' + inteiro(f.quantidade) + ' · Total: ' + moeda(f.total);
    const cmp = data.comparacao || {};
    let periodoTxt = 'Período atual: ' + formatarBr(p.inicio) + ' — ' + formatarBr(p.fim);
    if (cmp.habilitada && cmp.periodo_anterior) {
      periodoTxt += '  vs  período anterior: ' + formatarBr(cmp.periodo_anterior.inicio)
        + ' — ' + formatarBr(cmp.periodo_anterior.fim);
    }
    document.getElementById('misPeriodoLabel').textContent = periodoTxt;
    renderComparacao(cmp);
    renderEvolucao(data.evolucao);
    renderRanking(data.ranking);
    renderEstoque(data.estoque_critico);
    const semMov = Number(v.total_vendas) === 0 && Number(c.quantidade) === 0;
    const banner = document.getElementById('misEmptyBanner');
    if (banner) banner.hidden = !semMov;
  }

  function mensagemErroMis(data, status) {
    const code = data && data.code;
    if (code === 'PERIODO_INVALIDO') return 'Período inválido.';
    if (code === 'EMPRESA_NAO_AUTORIZADA') return 'Você não tem autorização para esta empresa.';
    if (code === 'EMPRESA_CONTEXT_REQUIRED' || code === 'EMPRESA_OPERACIONAL_AUSENTE' || code === 'EMPRESA_OBRIGATORIA') {
      return 'Informe a empresa do contexto.';
    }
    const raw = (data && (data.error || data.erro)) || '';
    if (raw) return String(raw).split('\n')[0];
    if (status === 403) return 'Você não tem autorização para esta empresa.';
    if (status === 400) return 'Não foi possível carregar o MIS.';
    return 'Não foi possível carregar o MIS.';
  }

  async function carregarResumoMis() {
    const loading = document.getElementById('misLoading');
    const conteudo = document.getElementById('misConteudo');
    const emp = document.getElementById('misEmpresa');
    if (emp) emp.textContent = rotuloEmpresa();
    const { inicio, fim } = periodoAtual();
    if (!inicio || !fim || inicio > fim) {
      setAlerta('Período inválido.', 'erro');
      if (loading) loading.hidden = true;
      return;
    }
    if (conteudo) conteudo.hidden = true;
    limparConteudoDinamico();
    if (loading) loading.hidden = false;
    setAlerta('');
    try {
      let url = apiUrl() + '/mis/resumo?inicio=' + encodeURIComponent(inicio)
        + '&fim=' + encodeURIComponent(fim)
        + '&modo_fiscal=' + encodeURIComponent(modoFiscal());
      if (compararAtivo()) url += '&comparar=1';
      const resp = await fetch(url, { headers: headersMis() });
      const data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        throw Object.assign(new Error(mensagemErroMis(data, resp.status)), { status: resp.status });
      }
      if (conteudo) conteudo.hidden = false;
      preencher(data);
    } catch (err) {
      setAlerta(err.message || 'Erro ao carregar o MIS.', 'erro');
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function onEmpresaContextoAlterado() {
    if (typeof currentPage !== 'undefined' && currentPage !== 'mis') return;
    if (!document.getElementById('misDataInicio')) return;
    carregarResumoMis();
  }

  function initMis() {
    const shell = document.getElementById('misShell');
    if (shell && global.CdsPageShell && typeof global.CdsPageShell.renderHeader === 'function') {
      shell.innerHTML = global.CdsPageShell.renderHeader({
        page: 'mis',
        titulo: 'MIS',
        subtitulo: 'Visão gerencial da empresa'
      });
    }
    const emp = document.getElementById('misEmpresa');
    if (emp) emp.textContent = rotuloEmpresa();
    const hoje = isoHoje();
    const elI = document.getElementById('misDataInicio');
    const elF = document.getElementById('misDataFim');
    if (elI && !elI.value) elI.value = addDias(hoje, -6);
    if (elF && !elF.value) elF.value = hoje;
    const btn = document.getElementById('misBtnAplicar');
    if (btn) btn.onclick = function () { carregarResumoMis(); };
    const chk = document.getElementById('misComparar');
    if (chk) chk.onchange = function () { carregarResumoMis(); };
    document.querySelectorAll('[data-mis-atalho]').forEach(function (b) {
      b.onclick = function () { aplicarAtalho(b.getAttribute('data-mis-atalho')); };
    });
    document.removeEventListener('cds-empresa-contexto-alterado', onEmpresaContextoAlterado);
    document.addEventListener('cds-empresa-contexto-alterado', onEmpresaContextoAlterado);
    carregarResumoMis();
  }

  global.initMis = initMis;
  global.carregarResumoMis = carregarResumoMis;
})(typeof window !== 'undefined' ? window : this);
