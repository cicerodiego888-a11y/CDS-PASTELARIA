// Módulo Financeiro Principal
let abaAtiva = 'dashboard';
let financeiroEscopoEmpresa = 'todas';
let financeiroEmpresasAutorizadas = [];
let financeiroEmpresasProntas = false;
let financeiroContextoSyncing = false;

/** Cabeçalhos /api do Financeiro via mecanismo central (token + X-Empresa-Id). */
function headersFinanceiro(extra) {
  if (typeof CdsEmpresaContexto !== 'undefined' && typeof CdsEmpresaContexto.headersAuth === 'function') {
    return CdsEmpresaContexto.headersAuth(extra || {});
  }
  if (typeof CdsEmpresaContexto !== 'undefined' && typeof CdsEmpresaContexto.headersJson === 'function') {
    return Object.assign({}, CdsEmpresaContexto.headersJson(), extra || {});
  }
  const h = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + (localStorage.getItem('token') || '')
  };
  return Object.assign(h, extra || {});
}

function financeiroEscopoTodasEmpresas() {
  return financeiroEscopoEmpresa === 'todas';
}

function nomeEmpresaFinanceiro(empresaId) {
  const id = Number(empresaId);
  const empresa = financeiroEmpresasAutorizadas.find((item) => Number(item.id) === id);
  return empresa
    ? (empresa.nome_fantasia || empresa.razao_social || `Empresa #${id}`)
    : '';
}

function headersFinanceiroDaEmpresa(empresaId, extra) {
  const id = Number(empresaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Selecione a empresa proprietária deste registro para continuar.');
  }
  return headersFinanceiro(Object.assign({}, extra || {}, { 'X-Empresa-Id': String(id) }));
}

function financeiroTemEmpresaSelecionada() {
  return typeof CdsEmpresaContexto !== 'undefined'
    && typeof CdsEmpresaContexto.temEmpresaSelecionada === 'function'
    && CdsEmpresaContexto.temEmpresaSelecionada();
}

function financeiroMensagemEmpresaObrigatoria() {
  if (typeof CdsEmpresaContexto !== 'undefined'
    && typeof CdsEmpresaContexto.mensagemEmpresaObrigatoria === 'function') {
    return CdsEmpresaContexto.mensagemEmpresaObrigatoria();
  }
  return 'Selecione a empresa no seletor da barra lateral para continuar.';
}

function isFinanceiroPageLoaded() {
  return document.getElementById('financeiroConteudo') !== null;
}

async function initFinanceiro() {
  const pageRoot = document.querySelector('.financeiro-page');
  if (!pageRoot || !isFinanceiroPageLoaded()) {
    return;
  }

  if (pageRoot.dataset.financeiroInitialized === 'true') {
    return;
  }

  pageRoot.dataset.financeiroInitialized = 'true';
  abaAtiva = 'dashboard';

  configurarFiltrosPeriodo();
  configurarAbas();
  selecionarAbaVisual(abaAtiva);
  if (!pageRoot.dataset.financeiroEmpresaListener) {
    pageRoot.dataset.financeiroEmpresaListener = '1';
    document.addEventListener('cds-empresa-contexto-alterado', function onFinanceiroEmpresaAlterada(event) {
      if (!isFinanceiroPageLoaded()) return;
      if (!financeiroEmpresasProntas) return;
      if (financeiroContextoSyncing) return;
      const id = Number(event && event.detail && event.detail.empresaId);
      const empresa = financeiroEmpresasAutorizadas.find((item) => Number(item.id) === id);
      if (empresa) {
        financeiroEscopoEmpresa = String(id);
        const seletor = document.getElementById('financeiroEmpresaSelect');
        if (seletor) seletor.value = financeiroEscopoEmpresa;
      }
      carregarAbaAtiva();
    });
  }
  const empresasCarregadas = await inicializarEmpresasFinanceiro();
  if (!empresasCarregadas) return;
  carregarAbaAtiva();
}

async function inicializarEmpresasFinanceiro() {
  const seletor = document.getElementById('financeiroEmpresaSelect');
  const estado = document.getElementById('financeiroEmpresaEstado');
  if (!seletor || !estado) return false;

  seletor.disabled = true;
  estado.hidden = false;
  estado.textContent = 'Carregando empresas autorizadas…';
  estado.removeAttribute('role');
  try {
    if (typeof CdsEmpresaContexto === 'undefined'
      || typeof CdsEmpresaContexto.listarDisponiveis !== 'function') {
      throw new Error('O serviço oficial de contexto empresarial não está disponível.');
    }
    const empresas = await CdsEmpresaContexto.listarDisponiveis();
    if (!Array.isArray(empresas)) {
      throw new Error('A resposta de empresas autorizadas possui formato inválido.');
    }
    if (empresas.some((empresa) => {
      const id = Number(empresa && empresa.id);
      return !Number.isSafeInteger(id) || id <= 0;
    })) {
      throw new Error('A lista de empresas autorizadas contém identificadores inválidos.');
    }
    financeiroEmpresasAutorizadas = empresas;
    if (financeiroEmpresasAutorizadas.length === 0) {
      financeiroEmpresasProntas = false;
      estado.setAttribute('role', 'alert');
      estado.textContent = 'Nenhuma empresa autorizada está disponível para este usuário.';
      return false;
    }

    while (seletor.options.length > 1) seletor.remove(1);
    financeiroEmpresasAutorizadas.forEach((empresa) => {
      const option = document.createElement('option');
      option.value = String(Number(empresa.id));
      const nome = empresa.nome_fantasia || empresa.razao_social || `Empresa #${empresa.id}`;
      const cnpj = typeof CdsEmpresaContexto.formatarCnpj === 'function'
        ? CdsEmpresaContexto.formatarCnpj(empresa.cnpj)
        : empresa.cnpj;
      option.textContent = cnpj ? `${nome} — ${cnpj}` : nome;
      seletor.add(option);
    });

    financeiroEscopoEmpresa = 'todas';
    seletor.value = 'todas';
    seletor.disabled = false;
    financeiroEmpresasProntas = true;
    estado.hidden = true;
    estado.textContent = '';
    seletor.addEventListener('change', () => selecionarEscopoFinanceiro(seletor.value));
    return true;
  } catch (error) {
    console.error('Falha ao carregar empresas autorizadas do Financeiro:', error);
    estado.setAttribute('role', 'alert');
    estado.textContent = error.message || 'Não foi possível carregar as empresas autorizadas.';
    return false;
  }
}

async function selecionarEscopoFinanceiro(valor) {
  const seletor = document.getElementById('financeiroEmpresaSelect');
  if (!seletor || !financeiroEmpresasProntas) return;

  if (String(valor) === 'todas') {
    financeiroEscopoEmpresa = 'todas';
    carregarAbaAtiva();
    return;
  }

  const empresaId = Number(valor);
  const empresa = financeiroEmpresasAutorizadas.find((item) => Number(item.id) === empresaId);
  if (!empresa || !Number.isSafeInteger(empresaId) || empresaId <= 0) {
    seletor.value = financeiroEscopoEmpresa;
    if (typeof showNotification === 'function') {
      showNotification('A empresa selecionada não está entre as empresas autorizadas.', 'error');
    }
    return;
  }

  const escopoAnterior = financeiroEscopoEmpresa;
  financeiroEscopoEmpresa = String(empresaId);
  seletor.disabled = true;
  const conteudo = document.getElementById('financeiroConteudo');
  if (conteudo) {
    conteudo.innerHTML = '<div class="financeiro-dashboard-estado financeiro-dashboard-estado--carregando" role="status">Validando o contexto empresarial…</div>';
  }
  try {
    if (typeof CdsEmpresaContexto === 'undefined'
      || typeof CdsEmpresaContexto.selecionar !== 'function') {
      throw new Error('O serviço oficial de seleção empresarial não está disponível.');
    }
    financeiroContextoSyncing = true;
    const resposta = await CdsEmpresaContexto.selecionar(empresaId);
    if (!resposta || !resposta.empresa || Number(resposta.empresa.id) !== empresaId) {
      throw new Error('Não foi possível confirmar a empresa selecionada no contexto oficial.');
    }
    seletor.value = String(empresaId);
    carregarAbaAtiva();
  } catch (error) {
    financeiroEscopoEmpresa = escopoAnterior;
    seletor.value = escopoAnterior;
    console.error('Falha ao selecionar empresa no Financeiro:', error);
    if (typeof showNotification === 'function') {
      showNotification(error.message || 'Não foi possível selecionar a empresa.', 'error');
    }
    carregarAbaAtiva();
  } finally {
    financeiroContextoSyncing = false;
    seletor.disabled = false;
  }
}

function configurarFiltrosPeriodo() {
  const periodoSelect = document.getElementById('financeiroPeriodo');
  const dataInicioInput = document.getElementById('financeiroDataInicio');
  const dataFimInput = document.getElementById('financeiroDataFim');
  const botaoAtualizar = document.getElementById('btnAtualizarFinanceiro');
  const inicioWrapper = document.getElementById('financeiroPeriodoInicioWrapper');
  const fimWrapper = document.getElementById('financeiroPeriodoFimWrapper');

  if (!periodoSelect || !dataInicioInput || !dataFimInput || !botaoAtualizar || !inicioWrapper || !fimWrapper) {
    return;
  }

  function atualizarPeriodosVisuais(periodo, dataInicio, dataFim) {
    const valorInicio = dataInicio.toISOString().split('T')[0];
    const valorFim = dataFim.toISOString().split('T')[0];

    dataInicioInput.value = valorInicio;
    dataFimInput.value = valorFim;
    inicioWrapper.classList.toggle('d-none', periodo !== 'personalizado');
    fimWrapper.classList.toggle('d-none', periodo !== 'personalizado');
  }

  periodoSelect.addEventListener('change', function() {
    const periodo = this.value;
    const hoje = new Date();
    let dataInicio, dataFim;

    switch (periodo) {
      case 'hoje':
        dataInicio = new Date(hoje);
        dataFim = new Date(hoje);
        break;
      case '7dias':
        dataInicio = new Date(hoje.getTime() - 6 * 24 * 60 * 60 * 1000);
        dataFim = new Date(hoje);
        break;
      case 'mes-atual':
        dataInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        dataFim = new Date(hoje);
        break;
      case 'personalizado':
        if (!dataInicioInput.value) {
          dataInicioInput.value = hoje.toISOString().split('T')[0];
        }
        if (!dataFimInput.value) {
          dataFimInput.value = hoje.toISOString().split('T')[0];
        }
        inicioWrapper.classList.remove('d-none');
        fimWrapper.classList.remove('d-none');
        return;
      default:
        dataInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        dataFim = new Date(hoje);
    }

    atualizarPeriodosVisuais(periodo, dataInicio, dataFim);
  });

  periodoSelect.value = 'mes-atual';
  periodoSelect.dispatchEvent(new Event('change'));

  botaoAtualizar.addEventListener('click', function() {
    if (!financeiroEmpresasProntas) {
      inicializarEmpresasFinanceiro().then((carregadas) => {
        if (carregadas) carregarAbaAtiva();
      });
      return;
    }
    carregarAbaAtiva();
  });
}

function configurarAbas() {
  const abas = document.querySelectorAll('.financeiro-tab');
  if (!abas || abas.length === 0) {
    return;
  }

  abas.forEach(aba => {
    aba.addEventListener('click', function() {
      const abaSelecionada = this.getAttribute('data-aba');
      if (!abaSelecionada) {
        return;
      }

      if (abaAtiva === abaSelecionada) {
        return;
      }

      abas.forEach(a => a.classList.remove('active'));
      this.classList.add('active');

      abaAtiva = abaSelecionada;
      carregarAbaAtiva();
    });
  });
}

function selecionarAbaVisual(nomeAba) {
  const abas = document.querySelectorAll('.financeiro-tab');
  abas.forEach(aba => {
    const abaNome = aba.getAttribute('data-aba');
    if (abaNome === nomeAba) {
      aba.classList.add('active');
    } else {
      aba.classList.remove('active');
    }
  });
}

function carregarAbaAtiva() {
  const conteudo = document.getElementById('financeiroConteudo');
  if (!conteudo) {
    return;
  }

  conteudo.innerHTML = '';

  if (!financeiroEmpresasProntas) {
    conteudo.innerHTML =
      '<div class="alert alert-warning" role="alert">Não foi possível validar as empresas autorizadas. Use Atualizar para tentar novamente.</div>';
    return;
  }

  if (financeiroEscopoEmpresa !== 'todas' && !financeiroTemEmpresaSelecionada()) {
    const msg = financeiroMensagemEmpresaObrigatoria();
    conteudo.innerHTML =
      '<div class="alert alert-warning" role="alert">' +
      '<strong>Contexto empresarial obrigatório.</strong> ' +
      String(msg).replace(/</g, '&lt;') +
      '</div>';
    return;
  }

  switch (abaAtiva) {
    case 'dashboard':
      if (typeof renderDashboardFinanceiro === 'function') {
        renderDashboardFinanceiro(obterPeriodoFinanceiro());
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Dashboard não disponível</div>';
      }
      break;
    case 'receber':
      if (typeof renderContasReceber === 'function') {
        renderContasReceber(obterPeriodoFinanceiro());
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Contas a Receber não disponível</div>';
      }
      break;
    case 'duplicata':
      if (typeof renderDuplicataClientes === 'function') {
        renderDuplicataClientes(obterPeriodoFinanceiro());
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Dívidas por Cliente não disponível</div>';
      }
      break;
    case 'pagar':
      if (typeof renderContasPagar === 'function') {
        renderContasPagar(obterPeriodoFinanceiro());
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Contas a Pagar não disponível</div>';
      }
      break;
    case 'condicoes':
      if (typeof renderCondicoesPagamento === 'function') {
        renderCondicoesPagamento();
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Condições de Pagamento não disponível</div>';
      }
      break;
    case 'historico':
      if (typeof renderHistoricoFinanceiro === 'function') {
        renderHistoricoFinanceiro(obterPeriodoFinanceiro());
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Histórico não disponível</div>';
      }
      break;
    case 'relatorios':
      if (typeof renderRelatoriosFinanceiros === 'function') {
        renderRelatoriosFinanceiros(obterPeriodoFinanceiro());
      } else {
        conteudo.innerHTML = '<div class="alert alert-warning">Relatórios não disponível</div>';
      }
      break;
    default:
      conteudo.innerHTML = '<div class="alert alert-warning">Aba inválida.</div>';
  }
}

function obterPeriodoFinanceiro() {
  const periodoSelect = document.getElementById('financeiroPeriodo');
  const dataInicioInput = document.getElementById('financeiroDataInicio');
  const dataFimInput = document.getElementById('financeiroDataFim');
  const hoje = new Date();

  if (!periodoSelect || !dataInicioInput || !dataFimInput) {
    return {
      tipo: 'mes-atual',
      dataInicio: hoje.toISOString().split('T')[0],
      dataFim: hoje.toISOString().split('T')[0]
    };
  }

  const periodo = periodoSelect.value;
  let dataInicio, dataFim;

  switch (periodo) {
    case 'hoje':
      dataInicio = new Date(hoje);
      dataFim = new Date(hoje);
      break;
    case '7dias':
      dataInicio = new Date(hoje.getTime() - 6 * 24 * 60 * 60 * 1000);
      dataFim = new Date(hoje);
      break;
    case 'mes-atual':
      dataInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      dataFim = new Date(hoje);
      break;
    case 'personalizado': {
      const inicioRaw = dataInicioInput.value;
      const fimRaw = dataFimInput.value;
      const inicioDate = inicioRaw ? new Date(inicioRaw) : null;
      const fimDate = fimRaw ? new Date(fimRaw) : null;

      if (inicioDate instanceof Date && !Number.isNaN(inicioDate.getTime())) {
        dataInicio = inicioDate;
      } else {
        dataInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      }

      if (fimDate instanceof Date && !Number.isNaN(fimDate.getTime())) {
        dataFim = fimDate;
      } else {
        dataFim = new Date(hoje);
      }

      if (dataFim < dataInicio) {
        dataFim = new Date(dataInicio);
      }
      break;
    }
    default:
      dataInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      dataFim = hoje;
  }

  if (!(dataInicio instanceof Date) || Number.isNaN(dataInicio.getTime())) {
    dataInicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  }
  if (!(dataFim instanceof Date) || Number.isNaN(dataFim.getTime())) {
    dataFim = new Date(hoje);
  }

  return {
    tipo: periodo,
    dataInicio: dataInicio.toISOString().split('T')[0],
    dataFim: dataFim.toISOString().split('T')[0]
  };
}

function abrirAbaFinanceiro(nomeAba) {
  abaAtiva = nomeAba;
  selecionarAbaVisual(nomeAba);
  carregarAbaAtiva();
}

function atualizarFinanceiroAtual() {
  carregarAbaAtiva();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (isFinanceiroPageLoaded()) {
      initFinanceiro();
    }
  });
} else if (isFinanceiroPageLoaded()) {
  initFinanceiro();
}

function renderFinanceiro(movimentacoes, resumo, filtros) {
    const escapar = escaparHtmlFinanceiro;
    const html = `
        <h3><i class="fas fa-wallet"></i> Financeiro</h3>
        <div class="alert alert-info">
            Compras agora geram <strong>despesas automáticas</strong> e vendas geram <strong>receitas automáticas</strong>.
            Use o botão abaixo apenas para despesas e ajustes avulsos, como aluguel, água, luz e internet.
        </div>

        <div class="card mb-3">
            <div class="card-body">
                <div class="row g-2 align-items-end">
                    <div class="col-md-2">
                        <label class="form-label">Data início</label>
                        <input type="date" class="form-control" id="filtro_data_inicio" value="${escapar(filtros.data_inicio)}">
                    </div>
                    <div class="col-md-2">
                        <label class="form-label">Data fim</label>
                        <input type="date" class="form-control" id="filtro_data_fim" value="${escapar(filtros.data_fim)}">
                    </div>
                    <div class="col-md-2">
                        <label class="form-label">Tipo</label>
                        <select class="form-control" id="filtro_tipo">
                            <option value="">Todos</option>
                            <option value="receita" ${filtros.tipo === 'receita' ? 'selected' : ''}>Receitas</option>
                            <option value="despesa" ${filtros.tipo === 'despesa' ? 'selected' : ''}>Despesas</option>
                        </select>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label">Status</label>
                        <select class="form-control" id="filtro_status">${buildSelectOptions(FINANCEIRO_STATUS, filtros.status || '')}</select>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label">Origem</label>
                        <select class="form-control" id="filtro_origem">${buildSelectOptions(FINANCEIRO_ORIGENS, filtros.origem || '')}</select>
                    </div>
                    <div class="col-md-2">
                        <label class="form-label">Forma pgto.</label>
                        <select class="form-control" id="filtro_forma_pagamento">
                            <option value="">Todas</option>
                            ${FINANCEIRO_FORMAS_PAGAMENTO.map(item => `<option value="${item.value}" ${filtros.forma_pagamento === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="mt-3 d-flex gap-2 flex-wrap">
                    <button class="btn btn-primary" onclick="aplicarFiltrosFinanceiro()"><i class="fas fa-filter"></i> Filtrar</button>
                    <button class="btn btn-secondary" onclick="limparFiltrosFinanceiro()"><i class="fas fa-undo"></i> Limpar</button>
                    <button class="btn btn-danger" onclick="showMovimentacaoModal()"><i class="fas fa-plus"></i> Nova despesa avulsa</button>
                </div>
            </div>
        </div>

        <div class="row mb-3">
            <div class="col-md-3"><div class="card bg-success text-white"><div class="card-body"><small>Recebido no período</small><h4>${formatCurrency(resumo.total_recebido || 0)}</h4></div></div></div>
            <div class="col-md-3"><div class="card bg-danger text-white"><div class="card-body"><small>Pago no período</small><h4>${formatCurrency(resumo.total_pago || 0)}</h4></div></div></div>
            <div class="col-md-3"><div class="card bg-warning text-dark"><div class="card-body"><small>A receber</small><h4>${formatCurrency(resumo.total_a_receber || 0)}</h4></div></div></div>
            <div class="col-md-3"><div class="card bg-secondary text-white"><div class="card-body"><small>A pagar</small><h4>${formatCurrency(resumo.total_a_pagar || 0)}</h4></div></div></div>
        </div>
        <div class="row mb-3">
            <div class="col-md-12"><div class="card bg-info text-white"><div class="card-body"><small>Saldo realizado (recebido - pago)</small><h4>${formatCurrency(resumo.saldo || 0)}</h4></div></div></div>
        </div>

        <div class="card">
            <div class="card-header"><i class="fas fa-list"></i> Lançamentos</div>
            <div class="card-body table-responsive">
                <table class="table table-striped table-hover align-middle">
                    <thead>
                        <tr>
                            <th>Venc./Data</th>
                            <th>Tipo</th>
                            <th>Origem</th>
                            <th>Descrição</th>
                            <th>Documento</th>
                            <th>Pessoa</th>
                            <th>Status</th>
                            <th>Forma</th>
                            <th>Valor</th>
                            <th>Ações</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${movimentacoes.map(m => {
                            const id = Number(m.id);
                            const idValido = Number.isSafeInteger(id) && id > 0;
                            const referenciaId = Number(m.referencia_id);
                            const tipoReferenciaValido = m.referencia_tipo === 'compra' || m.referencia_tipo === 'venda';
                            const referenciaValida = Number.isSafeInteger(referenciaId) && referenciaId > 0 && tipoReferenciaValido;
                            const atributosReferencia = referenciaValida
                                ? `data-referencia-id="${referenciaId}" data-referencia-tipo="${m.referencia_tipo}" tabindex="0"`
                                : '';
                            const status = String(m.status_exibicao || m.status || '');
                            const statusClasses = {
                                pendente: 'warning text-dark',
                                parcial: 'warning text-dark',
                                recebido: 'success',
                                pago: 'success',
                                vencido: 'danger',
                                cancelado: 'secondary'
                            };
                            const classeStatus = statusClasses[status.toLowerCase()] || 'secondary';
                            return `
                            <tr ${atributosReferencia}>
                                <td>${escapar(formatDate(m.vencimento || m.data_movimento))}</td>
                                <td><span class="badge bg-${m.tipo === 'receita' ? 'success' : 'danger'}">${escapar(m.tipo)}</span></td>
                                <td>${escapar(m.origem || '-')}</td>
                                <td>${escapar(m.descricao || '-')}</td>
                                <td>${escapar(m.documento || '-')}</td>
                                <td>${escapar(m.pessoa_nome || '-')}</td>
                                <td><span class="badge bg-${classeStatus}">${escapar(status || '-')}</span></td>
                                <td>${escapar(nomeFormaPagamento(m.forma_pagamento))}</td>
                                <td class="${m.tipo === 'receita' ? 'text-success' : 'text-danger'}">${formatCurrency(m.valor)}</td>
                                <td class="text-nowrap">
                                    ${(idValido && m.status === 'pendente') ? `<button type="button" class="btn btn-sm btn-success" data-financeiro-acao="baixar" data-financeiro-id="${id}"><i class="fas fa-check"></i></button>` : ''}
                                    ${idValido ? `<button type="button" class="btn btn-sm btn-warning" data-financeiro-acao="editar" data-financeiro-id="${id}"><i class="fas fa-edit"></i></button>` : ''}
                                    ${(idValido && (m.origem === 'manual' || !m.origem)) ? `<button type="button" class="btn btn-sm btn-danger" data-financeiro-acao="excluir" data-financeiro-id="${id}"><i class="fas fa-trash"></i></button>` : ''}
                                </td>
                            </tr>
                            `;
                        }).join('') || '<tr><td colspan="10" class="text-center">Nenhum lançamento no período.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>
    `;
    $('#page-content').html(html);
    const corpoTabela = document.querySelector('#page-content tbody');
    if (corpoTabela) {
        corpoTabela.addEventListener('click', event => {
            const alvo = event.target instanceof Element ? event.target : event.target?.parentElement;
            const botao = alvo?.closest('button[data-financeiro-acao]');
            if (botao) {
                event.stopPropagation();
                const id = Number(botao.dataset.financeiroId);
                if (!Number.isSafeInteger(id) || id <= 0) return;
                if (botao.dataset.financeiroAcao === 'baixar') baixarMovimentacao(id);
                else if (botao.dataset.financeiroAcao === 'editar') editMovimentacao(id);
                else if (botao.dataset.financeiroAcao === 'excluir') deleteMovimentacao(id);
                return;
            }

            const linha = alvo?.closest('tr[data-referencia-id]');
            if (linha) {
                abrirReferenciaFinanceira(linha.dataset.referenciaId, linha.dataset.referenciaTipo);
            }
        });
    }
}

function abrirReferenciaFinanceira(referenciaId, referenciaTipo) {
    const id = Number(referenciaId);
    if (!Number.isSafeInteger(id) || id <= 0) {
        showNotification('Referência inválida para este lançamento.', 'warning');
        return;
    }
    if (referenciaTipo === 'compra' && typeof viewCompra === 'function') {
        viewCompra(id);
        return;
    }
    if (referenciaTipo === 'venda' && typeof viewVenda === 'function') {
        viewVenda(id);
        return;
    }
    showNotification('Não há referência disponível para este lançamento.', 'info');
}

function escaparHtmlFinanceiro(valor) {
    return String(valor == null ? '' : valor).replace(/[&<>"']/g, caractere => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[caractere]);
}

function showMovimentacaoModal(movimentacao = null) {
    const isEdit = !!movimentacao;
    const title = isEdit ? 'Editar movimentação' : 'Nova despesa avulsa';
    const modalHtml = `
        <div class="modal fade" id="movimentacaoModal" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">${title}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                    </div>
                    <div class="modal-body">
                        <div class="alert alert-light border">Receitas normais vêm das vendas. Aqui o foco é cadastrar despesas avulsas e ajustes.</div>
                        <form id="movimentacaoForm">
                            <input type="hidden" id="movimentacaoId" value="${movimentacao?.id || ''}">
                            <div class="mb-3">
                                <label class="form-label">Tipo</label>
                                <select class="form-control" id="tipo">
                                    <option value="despesa" ${(movimentacao?.tipo || 'despesa') === 'despesa' ? 'selected' : ''}>Despesa</option>
                                    <option value="receita" ${movimentacao?.tipo === 'receita' ? 'selected' : ''}>Receita avulsa</option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Descrição *</label>
                                <input type="text" class="form-control" id="descricao" value="${movimentacao?.descricao || ''}">
                            </div>
                            <div class="row g-2">
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Valor *</label>
                                    <input type="number" step="0.01" class="form-control" id="valor" value="${movimentacao?.valor || ''}">
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Data lançamento *</label>
                                    <input type="date" class="form-control" id="data_movimento" value="${movimentacao?.data_movimento || new Date().toISOString().split('T')[0]}">
                                </div>
                            </div>
                            <div class="row g-2">
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Vencimento</label>
                                    <input type="date" class="form-control" id="vencimento" value="${movimentacao?.vencimento || movimentacao?.data_movimento || new Date().toISOString().split('T')[0]}">
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Forma de pagamento</label>
                                    <select class="form-control" id="forma_pagamento">
                                        <option value="">Selecione</option>
                                        ${FINANCEIRO_FORMAS_PAGAMENTO.map(item => `<option value="${item.value}" ${movimentacao?.forma_pagamento === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}
                                    </select>
                                </div>
                            </div>
                            <div class="row g-2">
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Documento</label>
                                    <input type="text" class="form-control" id="documento" value="${movimentacao?.documento || ''}">
                                </div>
                                <div class="col-md-6 mb-3">
                                    <label class="form-label">Favorecido / pessoa</label>
                                    <input type="text" class="form-control" id="pessoa_nome" value="${movimentacao?.pessoa_nome || ''}">
                                </div>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Status</label>
                                <select class="form-control" id="status">
                                    <option value="pendente" ${(movimentacao?.status || 'pendente') === 'pendente' ? 'selected' : ''}>Pendente</option>
                                    <option value="pago" ${movimentacao?.status === 'pago' ? 'selected' : ''}>Pago</option>
                                    <option value="recebido" ${movimentacao?.status === 'recebido' ? 'selected' : ''}>Recebido</option>
                                </select>
                            </div>
                            <div class="mb-3">
                                <label class="form-label">Observação</label>
                                <textarea class="form-control" id="observacao">${movimentacao?.observacao || ''}</textarea>
                            </div>
                        </form>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
                        <button type="button" class="btn btn-primary" onclick="saveMovimentacao()">Salvar</button>
                    </div>
                </div>
            </div>
        </div>
    `;
    $('#modal-container').html(modalHtml);
    $('#movimentacaoModal').modal('show');
}

function saveMovimentacao() {
    const id = $('#movimentacaoId').val();
    const data = {
        tipo: $('#tipo').val(),
        descricao: $('#descricao').val(),
        valor: parseFloat($('#valor').val()),
        data_movimento: $('#data_movimento').val(),
        vencimento: $('#vencimento').val(),
        forma_pagamento: $('#forma_pagamento').val(),
        documento: $('#documento').val(),
        pessoa_nome: $('#pessoa_nome').val(),
        status: $('#status').val(),
        observacao: $('#observacao').val(),
        categoria: $('#tipo').val() === 'despesa' ? 'despesa_avulsa' : 'receita_avulsa'
    };

    if (!data.tipo || !data.descricao || !data.valor || !data.data_movimento) {
        showNotification('Preencha os campos obrigatórios.', 'danger');
        return;
    }

    $.ajax({
        url: id ? `${API_URL}/financeiro/${id}` : `${API_URL}/financeiro`,
        method: id ? 'PUT' : 'POST',
        contentType: 'application/json',
        data: JSON.stringify(data)
    }).done(function() {
        $('#movimentacaoModal').modal('hide');
        showNotification('Movimentação salva com sucesso!', 'success');
        loadFinanceiro();
    }).fail(function(xhr) {
        showNotification(xhr.responseJSON?.error || 'Erro ao salvar movimentação.', 'danger');
    });
}

function editMovimentacao(id) {
    $.ajax({ url: `${API_URL}/financeiro/${id}`, method: 'GET' }).done(function(movimentacao) {
        showMovimentacaoModal(movimentacao);
    }).fail(function(xhr) {
        showNotification(xhr.responseJSON?.error || 'Erro ao carregar movimentação.', 'danger');
    });
}

function deleteMovimentacao(id) {
    if (!confirm('Deseja excluir esta movimentação?')) return;
    $.ajax({ url: `${API_URL}/financeiro/${id}`, method: 'DELETE' }).done(function() {
        showNotification('Movimentação excluída com sucesso!', 'success');
        loadFinanceiro();
    }).fail(function(xhr) {
        showNotification(xhr.responseJSON?.error || 'Erro ao excluir movimentação.', 'danger');
    });
}

function baixarMovimentacao(id) {
    $.ajax({ url: `${API_URL}/financeiro/${id}/baixar`, method: 'POST' }).done(function() {
        showNotification('Baixa registrada com sucesso!', 'success');
        loadFinanceiro();
    }).fail(function(xhr) {
        showNotification(xhr.responseJSON?.error || 'Erro ao baixar movimentação.', 'danger');
    });
}

function aplicarFiltrosFinanceiro() {
    loadFinanceiro({
        data_inicio: $('#filtro_data_inicio').val(),
        data_fim: $('#filtro_data_fim').val(),
        tipo: $('#filtro_tipo').val(),
        status: $('#filtro_status').val(),
        origem: $('#filtro_origem').val(),
        forma_pagamento: $('#filtro_forma_pagamento').val()
    });
}

function limparFiltrosFinanceiro() {
    loadFinanceiro({});
}
