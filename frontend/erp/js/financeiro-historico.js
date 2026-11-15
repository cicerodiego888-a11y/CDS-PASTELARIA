function renderHistoricoFinanceiro(periodo) {
  const container = document.getElementById('financeiroConteudo');
  if (!container) {
    console.error('Elemento financeiroConteudo não encontrado');
    return;
  }

  const pagina = document.createElement('section');
  pagina.className = 'financeiro-historico';
  pagina.setAttribute('aria-labelledby', 'financeiroHistoricoTitulo');

  const cabecalho = document.createElement('header');
  cabecalho.className = 'financeiro-historico-cabecalho';
  const tituloGrupo = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'financeiro-historico-eyebrow';
  eyebrow.textContent = 'CONSULTA DE MOVIMENTAÇÕES';
  const titulo = document.createElement('h2');
  titulo.id = 'financeiroHistoricoTitulo';
  titulo.textContent = 'Histórico Financeiro';
  const descricao = document.createElement('p');
  descricao.textContent = 'Consulte entradas, saídas e referências dos lançamentos no escopo empresarial selecionado.';
  tituloGrupo.append(eyebrow, titulo, descricao);
  const periodoResumo = document.createElement('span');
  periodoResumo.className = 'financeiro-historico-periodo';
  periodoResumo.textContent = periodo?.dataInicio && periodo?.dataFim
    ? `Período: ${formatarData(periodo.dataInicio)} a ${formatarData(periodo.dataFim)}`
    : 'Período selecionado no cabeçalho';
  cabecalho.append(tituloGrupo, periodoResumo);

  const filtros = document.createElement('section');
  filtros.className = 'financeiro-historico-filtros';
  filtros.setAttribute('aria-label', 'Filtros do Histórico Financeiro');

  const buscaGrupo = document.createElement('div');
  buscaGrupo.className = 'financeiro-historico-busca';
  const buscaLabel = document.createElement('label');
  buscaLabel.htmlFor = 'filtroDescricao';
  buscaLabel.textContent = 'Descrição ou documento';
  const busca = document.createElement('input');
  busca.type = 'search';
  busca.id = 'filtroDescricao';
  busca.className = 'form-control';
  busca.placeholder = 'Buscar lançamento';
  busca.autocomplete = 'off';
  buscaGrupo.append(buscaLabel, busca);

  const acoes = document.createElement('div');
  acoes.className = 'financeiro-historico-acoes';
  const botaoFiltrar = document.createElement('button');
  botaoFiltrar.type = 'button';
  botaoFiltrar.id = 'btnFiltrarHistorico';
  botaoFiltrar.className = 'btn btn-primary';
  botaoFiltrar.textContent = 'Aplicar filtros';
  botaoFiltrar.addEventListener('click', () => carregarHistoricoFinanceiro(periodo));
  const botaoLimpar = document.createElement('button');
  botaoLimpar.type = 'button';
  botaoLimpar.id = 'btnLimparFiltrosHistorico';
  botaoLimpar.className = 'btn btn-outline-secondary';
  botaoLimpar.textContent = 'Limpar';
  botaoLimpar.hidden = true;
  botaoLimpar.addEventListener('click', () => limparFiltrosHistorico(periodo));
  acoes.append(botaoFiltrar, botaoLimpar);

  const filtrosAvancados = document.createElement('details');
  filtrosAvancados.id = 'filtrosAvancadosHistorico';
  filtrosAvancados.className = 'financeiro-historico-avancados';
  const resumoAvancados = document.createElement('summary');
  resumoAvancados.textContent = 'Tipo e status';
  const camposAvancados = document.createElement('div');
  camposAvancados.className = 'financeiro-historico-avancados-campos';

  const tipoGrupo = document.createElement('div');
  tipoGrupo.className = 'financeiro-historico-campo';
  const tipoLabel = document.createElement('label');
  tipoLabel.htmlFor = 'filtroTipo';
  tipoLabel.textContent = 'Tipo de movimento';
  const tipo = document.createElement('select');
  tipo.id = 'filtroTipo';
  tipo.className = 'form-select';
  [
    ['', 'Todos os tipos'],
    ['receita', 'Entrada'],
    ['despesa', 'Saída']
  ].forEach(([valor, texto]) => {
    const option = document.createElement('option');
    option.value = valor;
    option.textContent = texto;
    tipo.appendChild(option);
  });
  tipoGrupo.append(tipoLabel, tipo);

  const statusGrupo = document.createElement('div');
  statusGrupo.className = 'financeiro-historico-campo';
  const statusLabel = document.createElement('label');
  statusLabel.htmlFor = 'filtroStatus';
  statusLabel.textContent = 'Status';
  const status = document.createElement('select');
  status.id = 'filtroStatus';
  status.className = 'form-select';
  [
    ['', 'Todos os status'],
    ['pendente', 'Pendente'],
    ['recebido', 'Recebido'],
    ['pago', 'Pago'],
    ['vencido', 'Vencido']
  ].forEach(([valor, texto]) => {
    const option = document.createElement('option');
    option.value = valor;
    option.textContent = texto;
    status.appendChild(option);
  });
  statusGrupo.append(statusLabel, status);
  camposAvancados.append(tipoGrupo, statusGrupo);
  filtrosAvancados.append(resumoAvancados, camposAvancados);
  filtros.append(buscaGrupo, acoes, filtrosAvancados);

  const estadoStatus = document.createElement('div');
  estadoStatus.id = 'historicoEstadoStatus';
  estadoStatus.className = 'financeiro-historico-estado';
  estadoStatus.setAttribute('role', 'status');
  estadoStatus.setAttribute('aria-live', 'polite');
  estadoStatus.hidden = true;

  const estadoVazio = document.createElement('div');
  estadoVazio.id = 'historicoEstadoVazio';
  estadoVazio.className = 'financeiro-empty-state financeiro-historico-vazio';
  estadoVazio.hidden = true;
  const iconeVazio = document.createElement('span');
  iconeVazio.className = 'financeiro-empty-state__icon';
  iconeVazio.setAttribute('aria-hidden', 'true');
  const icone = document.createElement('i');
  icone.className = 'fas fa-receipt';
  iconeVazio.appendChild(icone);
  const tituloVazio = document.createElement('h3');
  tituloVazio.textContent = 'Nenhum lançamento encontrado';
  const textoVazio = document.createElement('p');
  textoVazio.textContent = 'Ajuste a busca ou os filtros para consultar outros movimentos.';
  const botaoLimparVazio = document.createElement('button');
  botaoLimparVazio.type = 'button';
  botaoLimparVazio.id = 'btnLimparFiltrosHistoricoVazio';
  botaoLimparVazio.className = 'btn btn-sm btn-outline-secondary';
  botaoLimparVazio.textContent = 'Limpar filtros';
  botaoLimparVazio.addEventListener('click', () => limparFiltrosHistorico(periodo));
  estadoVazio.append(iconeVazio, tituloVazio, textoVazio, botaoLimparVazio);

  const tabelaContainer = document.createElement('div');
  tabelaContainer.id = 'historicoTabelaContainer';
  tabelaContainer.className = 'financeiro-tabela financeiro-tabela--historico';
  tabelaContainer.hidden = true;
  const tabelaScroll = document.createElement('div');
  tabelaScroll.className = 'table-responsive';
  const tabela = document.createElement('table');
  tabela.id = 'tabelaHistorico';
  tabela.className = 'table align-middle';
  const cabecalhoTabela = document.createElement('thead');
  const linhaCabecalho = document.createElement('tr');
  [
    'Data',
    'Movimento',
    'Descrição',
    'Referência',
    'Documento',
    'Pessoa',
    'Empresa',
    'Status',
    'Forma',
    'Valor'
  ].forEach(texto => {
    const th = document.createElement('th');
    th.textContent = texto;
    linhaCabecalho.appendChild(th);
  });
  cabecalhoTabela.appendChild(linhaCabecalho);
  const tbody = document.createElement('tbody');
  tbody.id = 'tabelaHistoricoFinanceiro';
  tabela.append(cabecalhoTabela, tbody);
  tabelaScroll.appendChild(tabela);
  tabelaContainer.appendChild(tabelaScroll);

  pagina.append(cabecalho, filtros, estadoStatus, estadoVazio, tabelaContainer);
  container.replaceChildren(pagina);

  const atualizarBotaoLimpar = () => {
    botaoLimpar.hidden = !historicoTemFiltrosAtivos();
  };
  busca.addEventListener('input', atualizarBotaoLimpar);
  tipo.addEventListener('change', atualizarBotaoLimpar);
  status.addEventListener('change', atualizarBotaoLimpar);

  carregarHistoricoFinanceiro(periodo);
}

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

async function carregarHistoricoFinanceiro(periodo) {
  mostrarEstadoHistorico('carregando');
  try {
    const filtroDescricao = document.getElementById('filtroDescricao')?.value || '';
    const filtroTipo = document.getElementById('filtroTipo')?.value || '';
    const filtroStatus = document.getElementById('filtroStatus')?.value || '';
    const params = new URLSearchParams();

    if (periodo?.dataInicio) params.append('dataInicio', periodo.dataInicio);
    if (periodo?.dataFim) params.append('dataFim', periodo.dataFim);
    if (filtroDescricao) params.append('busca', filtroDescricao);
    if (filtroTipo) params.append('tipo', filtroTipo);
    if (filtroStatus) params.append('status', filtroStatus);

    const query = params.toString();
    const endpoint = typeof financeiroEscopoTodasEmpresas === 'function' && financeiroEscopoTodasEmpresas()
      ? '/api/financeiro/multiempresa/historico'
      : '/api/financeiro/historico';
    const url = query ? `${endpoint}?${query}` : endpoint;
    const res = await fetch(url, { headers: __headersFin() });

    if (res.status === 401) {
      throw new Error('Sessão expirada. Faça login novamente.');
    }

    let data;
    try {
      data = await res.json();
    } catch (_error) {
      throw new Error('A resposta do Histórico Financeiro não é um JSON válido.');
    }

    if (!res.ok) {
      throw new Error(data?.error || 'Erro ao carregar histórico financeiro.');
    }
    if (!Array.isArray(data) || data.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('A resposta do Histórico Financeiro está fora do formato esperado.');
    }

    preencherTabelaHistorico(data);
  } catch (error) {
    console.error('Erro ao carregar histórico financeiro:', error);
    mostrarEstadoHistorico('erro', error.message || 'Erro ao carregar histórico financeiro.');
  }
}

function limparFiltrosHistorico(periodo) {
  const descricao = document.getElementById('filtroDescricao');
  const tipo = document.getElementById('filtroTipo');
  const status = document.getElementById('filtroStatus');
  const avancados = document.getElementById('filtrosAvancadosHistorico');
  if (descricao) descricao.value = '';
  if (tipo) tipo.value = '';
  if (status) status.value = '';
  if (avancados) avancados.open = false;
  const botaoLimpar = document.getElementById('btnLimparFiltrosHistorico');
  if (botaoLimpar) botaoLimpar.hidden = true;
  return carregarHistoricoFinanceiro(periodo);
}

function historicoTemFiltrosAtivos() {
  return Boolean(
    document.getElementById('filtroDescricao')?.value
    || document.getElementById('filtroTipo')?.value
    || document.getElementById('filtroStatus')?.value
  );
}

function mostrarEstadoHistorico(estado, mensagem = '') {
  const estadoStatus = document.getElementById('historicoEstadoStatus');
  const estadoVazio = document.getElementById('historicoEstadoVazio');
  const tabela = document.getElementById('historicoTabelaContainer');
  if (!estadoStatus || !estadoVazio || !tabela) return;

  estadoStatus.hidden = !['carregando', 'erro'].includes(estado);
  estadoVazio.hidden = estado !== 'vazio';
  tabela.hidden = estado !== 'dados';
  estadoStatus.className = estado === 'erro'
    ? 'financeiro-historico-estado financeiro-historico-estado--erro'
    : 'financeiro-historico-estado';
  estadoStatus.replaceChildren();
  if (estado === 'carregando') {
    const spinner = document.createElement('span');
    spinner.className = 'spinner-border spinner-border-sm';
    spinner.setAttribute('aria-hidden', 'true');
    const mensagemCarregando = document.createElement('span');
    mensagemCarregando.textContent = 'Carregando movimentações...';
    estadoStatus.append(spinner, mensagemCarregando);
  } else if (estado === 'erro') {
    estadoStatus.textContent = `Não foi possível carregar o histórico. ${mensagem}`;
  }

  const botaoLimparVazio = document.getElementById('btnLimparFiltrosHistoricoVazio');
  if (botaoLimparVazio) botaoLimparVazio.hidden = !historicoTemFiltrosAtivos();
}

function preencherTabelaHistorico(lista) {
  const tbody = document.getElementById('tabelaHistoricoFinanceiro');
  if (!tbody) {
    console.error('Elemento tabelaHistoricoFinanceiro não encontrado');
    return;
  }

  if (!Array.isArray(lista)) {
    tbody.replaceChildren();
    mostrarEstadoHistorico('erro', 'A resposta do Histórico Financeiro está fora do formato esperado.');
    return;
  }

  if (!lista.length) {
    tbody.replaceChildren();
    mostrarEstadoHistorico('vazio');
    return;
  }

  const linhas = lista.map(item => {
    const linha = document.createElement('tr');
    const tipo = item.tipo == null ? '' : String(item.tipo);
    if (tipo === 'receita') linha.className = 'historico-linha--entrada';
    if (tipo === 'despesa') linha.className = 'historico-linha--saida';

    linha.appendChild(criarCelulaHistorico(formatarData(item.data_movimento || item.vencimento)));

    const celulaTipo = document.createElement('td');
    const badgeTipo = document.createElement('span');
    badgeTipo.className = tipo === 'receita'
      ? 'financeiro-historico-tipo financeiro-historico-tipo--entrada'
      : tipo === 'despesa'
        ? 'financeiro-historico-tipo financeiro-historico-tipo--saida'
        : 'financeiro-historico-tipo financeiro-historico-tipo--outro';
    badgeTipo.textContent = tipo === 'receita'
      ? '↑ Entrada'
      : tipo === 'despesa'
        ? '↓ Saída'
        : tipo || '—';
    celulaTipo.appendChild(badgeTipo);
    linha.appendChild(celulaTipo);

    linha.appendChild(criarCelulaHistorico(item.descricao || '—'));
    linha.appendChild(criarCelulaReferenciaHistorico(item));
    linha.appendChild(criarCelulaHistorico(item.documento || '—', 'financeiro-historico-documento'));
    linha.appendChild(criarCelulaHistorico(item.pessoa_nome || '—'));
    const empresaNome = item.empresa_nome
      || (typeof nomeEmpresaFinanceiro === 'function' ? nomeEmpresaFinanceiro(item.empresa_id) : '');
    linha.appendChild(criarCelulaHistorico(empresaNome || '—'));

    const celulaStatus = document.createElement('td');
    const status = document.createElement('span');
    const statusTexto = item.status == null ? '' : String(item.status);
    const statusClasses = {
      pendente: 'financeiro-historico-status--pendente',
      parcial: 'financeiro-historico-status--parcial',
      recebido: 'financeiro-historico-status--concluido',
      pago: 'financeiro-historico-status--concluido',
      vencido: 'financeiro-historico-status--vencido',
      cancelado: 'financeiro-historico-status--cancelado',
      cancelada: 'financeiro-historico-status--cancelado'
    };
    const statusClasse = Object.prototype.hasOwnProperty.call(statusClasses, statusTexto.toLowerCase())
      ? statusClasses[statusTexto.toLowerCase()]
      : 'financeiro-historico-status--outro';
    status.className = `financeiro-historico-status ${statusClasse}`;
    status.textContent = statusTexto || '—';
    celulaStatus.appendChild(status);
    linha.appendChild(celulaStatus);

    linha.appendChild(criarCelulaHistorico(item.forma_pagamento || '—'));
    linha.appendChild(criarCelulaHistorico(formatarMoeda(item.valor), 'financeiro-historico-valor'));
    return linha;
  });

  tbody.replaceChildren(...linhas);
  mostrarEstadoHistorico('dados');
}

function criarCelulaHistorico(valor, classe = '') {
  const celula = document.createElement('td');
  if (classe) celula.className = classe;
  celula.textContent = valor == null ? '' : String(valor);
  return celula;
}

function criarCelulaReferenciaHistorico(item) {
  const celula = document.createElement('td');
  let tipo = item.referencia_tipo;
  let idBruto = item.referencia_id;
  // Projeção MCF / compra paga: preferir compra_id para o link do histórico
  if (
    (tipo === 'contas_pagar_mcf' || item.origem === 'mcf_compatibilidade' || item.origem_exibicao === 'compra')
    && item.compra_id != null
    && Number(item.compra_id) > 0
  ) {
    tipo = 'compra';
    idBruto = item.compra_id;
  }
  const idFormatoValido = typeof idBruto === 'number'
    ? Number.isSafeInteger(idBruto)
    : typeof idBruto === 'string' && /^\d+$/.test(idBruto);
  const referenciaId = idFormatoValido ? Number(idBruto) : NaN;
  const tipoValido = tipo === 'compra' || tipo === 'venda';
  const idValido = Number.isSafeInteger(referenciaId) && referenciaId > 0;

  if (tipoValido && idValido && typeof abrirReferenciaFinanceira === 'function') {
    const referencia = document.createElement('button');
    referencia.type = 'button';
    referencia.className = 'financeiro-historico-referencia';
    referencia.setAttribute(
      'aria-label',
      `Abrir referência de ${tipo === 'compra' ? 'compra' : 'venda'} ${referenciaId}`
    );
    referencia.textContent = `${tipo === 'compra' ? 'Compra' : 'Venda'} #${referenciaId}`;
    referencia.addEventListener('click', () => {
      if (
        Number.isSafeInteger(referenciaId)
        && referenciaId > 0
        && (tipo === 'compra' || tipo === 'venda')
      ) {
        abrirReferenciaFinanceira(referenciaId, tipo);
      }
    });
    celula.appendChild(referencia);
    return celula;
  }

  celula.textContent = tipo || item.referencia_id != null
    ? `${tipo == null ? '' : String(tipo)}${item.referencia_id == null ? '' : ` · ${String(item.referencia_id)}`}`
    : '—';
  return celula;
}

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function formatarData(data) {
  if (!data) return '—';
  const texto = String(data);
  const dataCivil = texto.split('T')[0];
  const partes = dataCivil.split('-');
  if (partes.length !== 3 || partes.some(parte => !parte)) return texto;
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}
