/**
 * FIN-UX-08/09 — Dashboard Financeiro Multiempresa
 * Contrato: GET /api/financeiro/dashboard/multiempresa
 */
let dashboardFinanceiroRequestId = 0;
let chartFluxoFinanceiroMultiempresa = null;
let chartAbertoFinanceiroMultiempresa = null;

function __headersFin(extra) {
  if (typeof headersFinanceiro === 'function') return headersFinanceiro(extra || {});
  if (typeof CdsEmpresaContexto !== 'undefined' && typeof CdsEmpresaContexto.headersAuth === 'function') {
    return CdsEmpresaContexto.headersAuth(extra || {});
  }
  return Object.assign({
    Accept: 'application/json',
    Authorization: 'Bearer ' + (localStorage.getItem('token') || '')
  }, extra || {});
}

function renderDashboardFinanceiro(periodo) {
  const conteudo = document.getElementById('financeiroConteudo');
  if (!conteudo) return;

  const inicio = periodo && periodo.dataInicio ? String(periodo.dataInicio) : '';
  const fim = periodo && periodo.dataFim ? String(periodo.dataFim) : '';

  conteudo.innerHTML = `
    <section class="financeiro-dashboard" aria-labelledby="financeiroDashboardTitulo">
      <header class="financeiro-dashboard-cabecalho">
        <div class="financeiro-dashboard-resumo-heading">
          <span class="financeiro-dashboard-secao-icone"><i class="fas fa-chart-column" aria-hidden="true"></i></span>
          <div>
            <span id="financeiroDashboardEscopo" class="financeiro-dashboard-eyebrow">VISÃO CONSOLIDADA</span>
            <h2 id="financeiroDashboardTitulo">Resumo consolidado</h2>
            <p id="financeiroDashboardDescricao">Total das empresas autorizadas no período selecionado</p>
          </div>
        </div>
        <div class="financeiro-dashboard-resumo-meta">
          <span class="financeiro-dashboard-badge"><i class="fas fa-building" aria-hidden="true"></i><span id="financeiroDashboardBadgeEscopo">Todas as empresas</span></span>
          <span id="financeiroDashboardBadgeQuantidade" class="financeiro-dashboard-badge financeiro-dashboard-badge--periodo">Exibindo dados consolidados</span>
          <span class="financeiro-dashboard-periodo">
            <span class="financeiro-dashboard-periodo-label">Movimentação</span>
            <strong id="financeiroDashboardPeriodo">${escapeHtmlDashboard(formatarData(inicio))} — ${escapeHtmlDashboard(formatarData(fim))}</strong>
            <span class="financeiro-dashboard-periodo-label">Em aberto em <strong id="financeiroDashboardReferencia">—</strong></span>
          </span>
        </div>
      </header>

      <div id="dashboardFinEstado" class="financeiro-dashboard-estado" role="status" aria-live="polite" hidden></div>

      <div id="dashboardFinConteudo" hidden>
        <section class="financeiro-dashboard-indicadores" aria-label="Indicadores financeiros">
          <article class="financeiro-dashboard-kpi financeiro-dashboard-kpi--recebido">
            <div class="financeiro-dashboard-kpi-cabecalho">
              <span class="financeiro-dashboard-kpi-icone"><i class="fas fa-arrow-down" aria-hidden="true"></i></span>
              <span>Total recebido</span>
            </div>
            <strong id="totalRecebido">R$ 0,00</strong>
            <small>Recebimentos efetivos no período selecionado</small>
          </article>
          <article class="financeiro-dashboard-kpi financeiro-dashboard-kpi--pago">
            <div class="financeiro-dashboard-kpi-cabecalho">
              <span class="financeiro-dashboard-kpi-icone"><i class="fas fa-arrow-up" aria-hidden="true"></i></span>
              <span>Total pago</span>
            </div>
            <strong id="totalPago">R$ 0,00</strong>
            <small>Pagamentos efetivos no período selecionado</small>
          </article>
          <article class="financeiro-dashboard-kpi financeiro-dashboard-kpi--receber">
            <div class="financeiro-dashboard-kpi-cabecalho">
              <span class="financeiro-dashboard-kpi-icone"><i class="fas fa-credit-card" aria-hidden="true"></i></span>
              <span>A receber (em aberto)</span>
            </div>
            <strong id="totalReceber">R$ 0,00</strong>
            <small>Saldo pendente na data de referência</small>
          </article>
          <article class="financeiro-dashboard-kpi financeiro-dashboard-kpi--pagar">
            <div class="financeiro-dashboard-kpi-cabecalho">
              <span class="financeiro-dashboard-kpi-icone"><i class="fas fa-wallet" aria-hidden="true"></i></span>
              <span>A pagar (em aberto)</span>
            </div>
            <strong id="totalPagar">R$ 0,00</strong>
            <small>Obrigações pendentes na data de referência</small>
          </article>
          <article class="financeiro-dashboard-kpi financeiro-dashboard-kpi--saldo">
            <div class="financeiro-dashboard-kpi-cabecalho">
              <span class="financeiro-dashboard-kpi-icone"><i class="fas fa-scale-balanced" aria-hidden="true"></i></span>
              <span>Saldo líquido do período</span>
            </div>
            <strong id="saldoPeriodo">R$ 0,00</strong>
            <small>Recebido − pago; não representa saldo bancário ou patrimônio</small>
          </article>
        </section>

        <div class="financeiro-dashboard-graficos">
          <section class="financeiro-dashboard-bloco" aria-labelledby="dashFluxoTitulo">
            <header class="financeiro-dashboard-bloco-cabecalho">
              <div>
                <h3 id="dashFluxoTitulo">Recebimentos x Pagamentos</h3>
                <p>Evolução mensal das movimentações efetivas</p>
              </div>
            </header>
            <div id="graficoFluxoFinanceiro" class="financeiro-dashboard-grafico" aria-label="Recebimentos e pagamentos mensais">
              <canvas id="chartFluxoFinanceiro" aria-label="Série de recebimentos e pagamentos por data"></canvas>
            </div>
          </section>
          <section class="financeiro-dashboard-bloco" aria-labelledby="dashAbertosTitulo">
            <header class="financeiro-dashboard-bloco-cabecalho">
              <div>
                <h3 id="dashAbertosTitulo">A receber x A pagar (em aberto)</h3>
                <p>Comparativo por empresa na data de referência</p>
              </div>
            </header>
            <div id="graficoAbertoFinanceiro" class="financeiro-dashboard-grafico" aria-label="Comparativo de valores em aberto por empresa">
              <canvas id="chartAbertoFinanceiro" aria-label="Comparativo de contas a receber e a pagar em aberto por empresa"></canvas>
            </div>
          </section>
        </div>

        <section class="financeiro-dashboard-bloco" aria-labelledby="dashEmpresasTitulo">
          <header class="financeiro-dashboard-bloco-cabecalho">
            <div class="financeiro-dashboard-secao-heading">
              <span class="financeiro-dashboard-secao-icone"><i class="fas fa-building" aria-hidden="true"></i></span>
              <div>
              <h3 id="dashEmpresasTitulo">Financeiro por empresa</h3>
              <p>Valores individualizados para as empresas autorizadas neste escopo</p>
              </div>
            </div>
          </header>
          <div id="dashboardEmpresasCards" class="financeiro-dashboard-empresas"></div>
        </section>
      </div>
    </section>
  `;

  conteudo.addEventListener('click', (event) => {
    const botao = event.target.closest('[data-selecionar-empresa]');
    if (!botao) return;
    if (typeof selecionarEscopoFinanceiro === 'function') {
      selecionarEscopoFinanceiro(botao.getAttribute('data-selecionar-empresa'));
    }
  });

  carregarDashboardFinanceiro(periodo);
}

function setEstadoDashboardFin(tipo, mensagem) {
  const el = document.getElementById('dashboardFinEstado');
  const conteudo = document.getElementById('dashboardFinConteudo');
  if (!el) return;
  el.hidden = false;
  el.className = 'financeiro-dashboard-estado';
  el.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  if (tipo === 'carregando') {
    el.classList.add('financeiro-dashboard-estado--carregando');
    el.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Carregando dashboard…</span>';
    if (conteudo) conteudo.hidden = true;
    return;
  }
  if (tipo === 'erro') {
    el.classList.add('financeiro-dashboard-estado--erro');
    el.innerHTML = '<i class="fas fa-exclamation-circle" aria-hidden="true"></i><div><strong>Não foi possível carregar</strong><p></p></div>';
    const p = el.querySelector('p');
    if (p) p.textContent = String(mensagem || 'Erro ao carregar dados do dashboard');
    if (conteudo) conteudo.hidden = true;
    return;
  }
  el.hidden = true;
  el.innerHTML = '';
  if (conteudo) conteudo.hidden = false;
}

async function carregarDashboardFinanceiro(periodo) {
  const requestId = ++dashboardFinanceiroRequestId;
  setEstadoDashboardFin('carregando');
  try {
    const inicio = encodeURIComponent(periodo.dataInicio || '');
    const fim = encodeURIComponent(periodo.dataFim || '');
    const empresaId = encodeURIComponent(financeiroEscopoEmpresa || 'todas');
    const response = await fetch(`/api/financeiro/dashboard/multiempresa?empresaId=${empresaId}&dataInicio=${inicio}&dataFim=${fim}`, {
      headers: __headersFin()
    });

    const dados = await response.json().catch(() => ({}));

    if (!response.ok || !dados.success) {
      throw new Error(dados.error || 'Erro ao carregar dados do dashboard');
    }
    validarRespostaDashboardMultiempresa(dados);
    if (requestId !== dashboardFinanceiroRequestId) return;

    setEstadoDashboardFin('ok');
    preencherCardsDashboard(dados.resumo);
    preencherContextoDashboard(dados);
    renderGraficoFluxoFinanceiro(dados.serieTemporal);
    renderGraficoAbertosFinanceiro(dados.empresas);
    renderCardsEmpresasFinanceiro(dados.empresas);
  } catch (error) {
    if (requestId !== dashboardFinanceiroRequestId) return;
    console.error('Erro ao carregar dashboard:', error);
    setEstadoDashboardFin('erro', error.message || 'Erro ao carregar dados do dashboard');
  }
}

function validarRespostaDashboardMultiempresa(dados) {
  const resumo = dados && dados.resumo;
  const camposResumo = ['totalRecebido', 'totalPago', 'totalReceber', 'totalPagar'];
  const numeroValido = (valor) => typeof valor === 'number' && Number.isFinite(valor);
  if (!resumo || !['todas', 'empresa'].includes(dados.escopo)
    || !Array.isArray(dados.empresas) || !Array.isArray(dados.serieTemporal)
    || !dados.periodo || !dados.periodo.dataInicio || !dados.periodo.dataFim
    || !dados.periodo.dataReferenciaAbertos
    || camposResumo.some((campo) => !numeroValido(resumo[campo]))) {
    throw new Error('A resposta do dashboard financeiro está incompleta ou inválida.');
  }
  if (dados.empresas.some((empresa) => {
    return !empresa || !Number.isSafeInteger(Number(empresa.id)) || !empresa.resumo
      || camposResumo.some((campo) => !numeroValido(empresa.resumo[campo]));
  })) {
    throw new Error('A resposta do dashboard não contém dados completos por empresa.');
  }
  const idsEmpresas = dados.empresas.map((empresa) => Number(empresa.id));
  if (new Set(idsEmpresas).size !== idsEmpresas.length
    || idsEmpresas.some((id) => !financeiroEmpresasAutorizadas.some((empresa) => Number(empresa.id) === id))) {
    throw new Error('A resposta do dashboard inclui empresas fora do escopo autorizado.');
  }
  if (dados.escopo === 'todas' && (
    idsEmpresas.length !== financeiroEmpresasAutorizadas.length
    || financeiroEmpresasAutorizadas.some((empresa) => !idsEmpresas.includes(Number(empresa.id)))
  )) {
    throw new Error('A consolidação recebida não contém todas as empresas autorizadas.');
  }
  if (dados.escopo === 'empresa' && (
    idsEmpresas.length !== 1 || idsEmpresas[0] !== Number(financeiroEscopoEmpresa)
  )) {
    throw new Error('A resposta não corresponde à empresa selecionada.');
  }
  if (dados.serieTemporal.some((item) => {
    return !item || !dataSerieDashboardValida(item.data) || !numeroValido(item.recebido)
      || !numeroValido(item.pago);
  })) {
    throw new Error('A série temporal do dashboard financeiro é inválida.');
  }
}

function dataSerieDashboardValida(valor) {
  if (typeof valor !== 'string') return false;
  const partes = valor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!partes) return false;
  const data = new Date(Date.UTC(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3])));
  return data.getUTCFullYear() === Number(partes[1])
    && data.getUTCMonth() + 1 === Number(partes[2])
    && data.getUTCDate() === Number(partes[3]);
}

function preencherCardsDashboard(resumo) {
  const totalRecebido = Number(resumo.totalRecebido);
  const totalPago = Number(resumo.totalPago);
  const totalReceber = Number(resumo.totalReceber);
  const totalPagar = Number(resumo.totalPagar);
  const saldoPeriodo = totalRecebido - totalPago;

  const elTotalRecebido = document.getElementById('totalRecebido');
  const elTotalPago = document.getElementById('totalPago');
  const elTotalReceber = document.getElementById('totalReceber');
  const elTotalPagar = document.getElementById('totalPagar');
  const elSaldoPeriodo = document.getElementById('saldoPeriodo');

  if (elTotalRecebido) elTotalRecebido.textContent = formatarMoeda(totalRecebido);
  if (elTotalPago) elTotalPago.textContent = formatarMoeda(totalPago);
  if (elTotalReceber) elTotalReceber.textContent = formatarMoeda(totalReceber);
  if (elTotalPagar) elTotalPagar.textContent = formatarMoeda(totalPagar);
  if (elSaldoPeriodo) {
    elSaldoPeriodo.textContent = formatarMoeda(saldoPeriodo);
    elSaldoPeriodo.classList.toggle('is-negativo', saldoPeriodo < 0);
  }
}

function preencherContextoDashboard(dados) {
  const indicador = document.getElementById('financeiroDashboardEscopo');
  const descricao = document.getElementById('financeiroDashboardDescricao');
  const periodoEl = document.getElementById('financeiroDashboardPeriodo');
  const referenciaEl = document.getElementById('financeiroDashboardReferencia');
  const titulo = document.getElementById('financeiroDashboardTitulo');
  const badgeEscopo = document.getElementById('financeiroDashboardBadgeEscopo');
  const badgeQuantidade = document.getElementById('financeiroDashboardBadgeQuantidade');
  if (!indicador || !descricao || !periodoEl || !referenciaEl
    || !titulo || !badgeEscopo || !badgeQuantidade) return;

  const empresa = dados.empresas.length === 1 ? dados.empresas[0] : null;
  if (dados.escopo === 'todas') {
    indicador.textContent = `VISÃO CONSOLIDADA · ${dados.empresas.length} ${dados.empresas.length === 1 ? 'EMPRESA AUTORIZADA' : 'EMPRESAS AUTORIZADAS'}`;
    titulo.textContent = 'Resumo consolidado';
    descricao.textContent = 'Total das empresas autorizadas no período selecionado';
    badgeEscopo.textContent = 'Todas as empresas';
    badgeQuantidade.textContent = `Exibindo dados consolidados de ${dados.empresas.length} ${dados.empresas.length === 1 ? 'empresa' : 'empresas'}`;
  } else {
    const nomeEmpresa = empresa ? empresa.nome : 'empresa autorizada';
    indicador.textContent = `VISÃO INDIVIDUAL · ${nomeEmpresa}`;
    titulo.textContent = `Financeiro de ${nomeEmpresa}`;
    descricao.textContent = 'Indicadores e movimentações da empresa selecionada no período';
    badgeEscopo.textContent = nomeEmpresa;
    badgeQuantidade.textContent = 'Exibindo dados da empresa selecionada';
  }
  periodoEl.textContent = `${formatarData(dados.periodo.dataInicio)} — ${formatarData(dados.periodo.dataFim)}`;
  referenciaEl.textContent = formatarData(dados.periodo.dataReferenciaAbertos);
}

function renderGraficoFluxoFinanceiro(serieTemporal) {
  const host = document.getElementById('graficoFluxoFinanceiro');
  if (!host) return;
  if (chartFluxoFinanceiroMultiempresa) {
    chartFluxoFinanceiroMultiempresa.destroy();
    chartFluxoFinanceiroMultiempresa = null;
  }
  const movimentacoes = agruparSerieFinanceiraPorMes(serieTemporal);
  if (movimentacoes.recebido.every((valor, indice) => valor === 0 && movimentacoes.pago[indice] === 0)) {
    host.innerHTML = '<div class="financeiro-dashboard-grafico-vazio" role="status"><i class="fas fa-chart-column" aria-hidden="true"></i><strong>Sem movimentações no período</strong><span>Não há recebimentos ou pagamentos efetivos para exibir.</span></div>';
    return;
  }
  if (typeof Chart === 'undefined') {
    host.innerHTML = '<div class="financeiro-dashboard-grafico-vazio financeiro-dashboard-grafico-vazio--erro" role="alert">Gráfico indisponível porque Chart.js não foi carregado.</div>';
    return;
  }

  host.innerHTML = '<canvas id="chartFluxoFinanceiro" role="img" aria-label="Recebimentos e pagamentos mensais em reais"></canvas>';
  chartFluxoFinanceiroMultiempresa = new Chart(host.querySelector('canvas'), {
    type: 'bar',
    data: {
      labels: movimentacoes.labels,
      datasets: [
        {
          label: 'Recebimentos',
          data: movimentacoes.recebido,
          borderColor: '#159947',
          backgroundColor: '#159947',
          borderRadius: 3
        },
        {
          label: 'Pagamentos',
          data: movimentacoes.pago,
          borderColor: '#e73535',
          backgroundColor: '#e73535',
          borderRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      datasets: { bar: { categoryPercentage: 0.68, barPercentage: 0.82 } },
      scales: {
        x: { title: { display: true, text: 'Mês' }, grid: { display: false } },
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Valor (R$)' },
          ticks: { callback: (value) => formatarMoeda(value) }
        }
      },
      plugins: {
        legend: { display: true, position: 'top', align: 'end' },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatarMoeda(context.parsed.y)}`
          }
        }
      }
    }
  });
}

function agruparSerieFinanceiraPorMes(serieTemporal) {
  const meses = new Map();
  serieTemporal.forEach((item) => {
    const [ano, mes] = item.data.split('-');
    const chave = `${ano}-${mes}`;
    if (!meses.has(chave)) meses.set(chave, { ano: Number(ano), mes: Number(mes), recebido: 0, pago: 0 });
    const agregado = meses.get(chave);
    agregado.recebido += item.recebido;
    agregado.pago += item.pago;
  });

  const agregados = Array.from(meses.values()).sort((a, b) => a.ano - b.ano || a.mes - b.mes);
  const variosAnos = new Set(agregados.map((item) => item.ano)).size > 1;
  return {
    labels: agregados.map((item) => {
      const mes = new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(item.ano, item.mes - 1, 1)))
        .replace('.', '');
      const nomeMes = mes.charAt(0).toLocaleUpperCase('pt-BR') + mes.slice(1);
      return variosAnos ? `${nomeMes}/${item.ano}` : nomeMes;
    }),
    recebido: agregados.map((item) => item.recebido),
    pago: agregados.map((item) => item.pago)
  };
}

function renderGraficoAbertosFinanceiro(empresas) {
  const host = document.getElementById('graficoAbertoFinanceiro');
  if (!host) return;
  if (chartAbertoFinanceiroMultiempresa) {
    chartAbertoFinanceiroMultiempresa.destroy();
    chartAbertoFinanceiroMultiempresa = null;
  }
  const valoresAbertos = empresas.flatMap((empresa) => [
    empresa.resumo.totalReceber,
    empresa.resumo.totalPagar
  ]);
  if (valoresAbertos.every((valor) => valor === 0)) {
    host.innerHTML = '<div class="financeiro-dashboard-grafico-vazio" role="status"><i class="fas fa-scale-balanced" aria-hidden="true"></i><strong>Nenhum saldo em aberto</strong><span>As empresas autorizadas não têm valores pendentes na data de referência.</span></div>';
    return;
  }
  if (typeof Chart === 'undefined') {
    host.innerHTML = '<div class="financeiro-dashboard-grafico-vazio financeiro-dashboard-grafico-vazio--erro" role="alert">Gráfico indisponível porque Chart.js não foi carregado.</div>';
    return;
  }

  const maiorSaldo = valoresAbertos.reduce((maior, valor) => Math.max(maior, valor), 0);
  const rotulosValoresAbertos = {
    id: 'financeiroRotulosValoresAbertos',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = '600 10px Arial, sans-serif';
      ctx.fillStyle = '#344054';
      ctx.textBaseline = 'middle';
      chart.data.datasets.forEach((dataset, indiceDataset) => {
        const meta = chart.getDatasetMeta(indiceDataset);
        meta.data.forEach((barra, indiceDado) => {
          const valor = dataset.data[indiceDado];
          if (valor === 0) return;
          const rotulo = formatarMoeda(valor);
          const largura = ctx.measureText(rotulo).width;
          const x = valor > 0 ? barra.x + 6 : barra.x - largura - 6;
          if (x < chartArea.left || x + largura > chart.width - 3) return;
          ctx.fillText(rotulo, x, barra.y);
        });
      });
      ctx.restore();
    }
  };
  host.innerHTML = '<canvas id="chartAbertoFinanceiro" role="img" aria-label="Contas a receber e a pagar em aberto por empresa, em reais"></canvas>';
  chartAbertoFinanceiroMultiempresa = new Chart(host.querySelector('canvas'), {
    type: 'bar',
    data: {
      labels: empresas.map((empresa) => empresa.nome),
      datasets: [
        {
          label: 'A receber',
          data: empresas.map((empresa) => empresa.resumo.totalReceber),
          backgroundColor: '#1677ff',
          borderRadius: 3
        },
        {
          label: 'A pagar',
          data: empresas.map((empresa) => empresa.resumo.totalPagar),
          backgroundColor: '#7628d8',
          borderRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          beginAtZero: true,
          suggestedMax: maiorSaldo > 0 ? maiorSaldo * 1.22 : undefined,
          title: { display: true, text: 'Valor em aberto (R$)' },
          ticks: { callback: (value) => formatarMoeda(value) }
        },
        y: { title: { display: true, text: 'Empresa' }, grid: { display: false } }
      },
      plugins: {
        legend: { display: true, position: 'top', align: 'end' },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label}: ${formatarMoeda(context.parsed.x)}`
          }
        }
      }
    },
    plugins: [rotulosValoresAbertos]
  });
}

function renderCardsEmpresasFinanceiro(empresas) {
  const host = document.getElementById('dashboardEmpresasCards');
  if (!host) return;
  host.innerHTML = empresas.map((empresa) => {
    const cnpj = empresa.cnpj
      ? (typeof CdsEmpresaContexto !== 'undefined'
        && typeof CdsEmpresaContexto.formatarCnpj === 'function'
        ? CdsEmpresaContexto.formatarCnpj(empresa.cnpj)
        : empresa.cnpj)
      : '';
    return `
      <article class="financeiro-dashboard-empresa">
        <header class="financeiro-dashboard-empresa-cabecalho">
          <span class="financeiro-dashboard-empresa-icone"><i class="fas fa-building" aria-hidden="true"></i></span>
          <div class="financeiro-dashboard-empresa-identidade">
            <h4>${escapeHtmlDashboard(empresa.nome)}</h4>
            ${cnpj ? `<small>CNPJ ${escapeHtmlDashboard(cnpj)}</small>` : ''}
          </div>
        </header>
        <dl>
          <div class="financeiro-dashboard-empresa-metrica financeiro-dashboard-empresa-metrica--recebido">
            <dt><span class="financeiro-dashboard-empresa-metrica-icone"><i class="fas fa-arrow-down" aria-hidden="true"></i></span>Recebido</dt>
            <dd>${formatarMoeda(empresa.resumo.totalRecebido)}</dd>
          </div>
          <div class="financeiro-dashboard-empresa-metrica financeiro-dashboard-empresa-metrica--pago">
            <dt><span class="financeiro-dashboard-empresa-metrica-icone"><i class="fas fa-arrow-up" aria-hidden="true"></i></span>Pago</dt>
            <dd>${formatarMoeda(empresa.resumo.totalPago)}</dd>
          </div>
          <div class="financeiro-dashboard-empresa-metrica financeiro-dashboard-empresa-metrica--receber">
            <dt><span class="financeiro-dashboard-empresa-metrica-icone"><i class="fas fa-credit-card" aria-hidden="true"></i></span>A receber</dt>
            <dd>${formatarMoeda(empresa.resumo.totalReceber)}</dd>
          </div>
          <div class="financeiro-dashboard-empresa-metrica financeiro-dashboard-empresa-metrica--pagar">
            <dt><span class="financeiro-dashboard-empresa-metrica-icone"><i class="fas fa-wallet" aria-hidden="true"></i></span>A pagar</dt>
            <dd>${formatarMoeda(empresa.resumo.totalPagar)}</dd>
          </div>
        </dl>
        <button type="button" class="btn btn-sm btn-primary" data-selecionar-empresa="${Number(empresa.id)}">
          Ver financeiro da empresa <i class="fas fa-arrow-right" aria-hidden="true"></i>
        </button>
      </article>
    `;
  }).join('');
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(valor || 0));
}

function formatarData(data) {
  if (data == null || data === '') return '—';
  const s = String(data).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const d = new Date(data);
  if (Number.isNaN(d.getTime())) return escapeHtmlDashboard(s);
  return d.toLocaleDateString('pt-BR');
}

function escapeHtmlDashboard(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
