// Relatórios Financeiro
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

function modoFiscalRelatorioFinanceiroParam() {
    if (typeof modoFiscalQueryParam === 'function') {
        return modoFiscalQueryParam();
    }
    return localStorage.getItem('pdv_modo_fiscal_ativo') === '1' ? '1' : '0';
}

function escaparHtmlRelatorio(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nomeEmpresaRelatorio(conta) {
  const id = conta && conta.empresa_id != null
    ? conta.empresa_id
    : (typeof financeiroEscopoEmpresa !== 'undefined' && financeiroEscopoEmpresa !== 'todas'
      ? financeiroEscopoEmpresa
      : null);
  return (conta && conta.empresa_nome)
    || (typeof nomeEmpresaFinanceiro === 'function' ? nomeEmpresaFinanceiro(id) : '')
    || '—';
}

let sequenciaValidacaoEmpresaRelatorios = 0;

function definirEstadoEmpresaRelatorios(mensagem) {
  [
    'financeiroRelatoriosEmpresaNome',
    'financeiroRelatoriosEmpresaCardNome'
  ].forEach((id) => {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = mensagem;
  });
  [
    'financeiroRelatoriosEmpresaCnpj',
    'financeiroRelatoriosEmpresaCardCnpj'
  ].forEach((id) => {
    const elemento = document.getElementById(id);
    if (elemento) elemento.textContent = '';
  });
}

async function atualizarContextoEmpresaRelatorios() {
  const sequencia = ++sequenciaValidacaoEmpresaRelatorios;
  if (typeof financeiroEscopoTodasEmpresas === 'function' && financeiroEscopoTodasEmpresas()) {
    definirEstadoEmpresaRelatorios('Todas as empresas autorizadas');
    return;
  }
  const contexto = typeof CdsEmpresaContexto !== 'undefined' ? CdsEmpresaContexto : null;
  if (!contexto
    || typeof contexto.lerEmpresaId !== 'function'
    || typeof contexto.listarDisponiveis !== 'function') {
    definirEstadoEmpresaRelatorios('Contexto empresarial indisponível.');
    return;
  }

  definirEstadoEmpresaRelatorios('Validando contexto...');
  const idInicial = contexto.lerEmpresaId();
  try {
    const empresas = await contexto.listarDisponiveis();
    if (sequencia !== sequenciaValidacaoEmpresaRelatorios) return;
    if (!Array.isArray(empresas)) {
      throw new Error('A lista de empresas está fora do formato esperado.');
    }

    const empresaId = contexto.lerEmpresaId();
    if (Number(empresaId) !== Number(idInicial)) {
      return atualizarContextoEmpresaRelatorios();
    }
    if (empresas.length === 0) {
      definirEstadoEmpresaRelatorios('Nenhuma empresa disponível.');
      return;
    }
    if (!Number.isInteger(Number(empresaId)) || Number(empresaId) <= 0) {
      definirEstadoEmpresaRelatorios('Selecione uma empresa no menu global.');
      return;
    }

    const empresa = empresas.find((item) => Number(item.id) === Number(empresaId));
    if (!empresa) {
      definirEstadoEmpresaRelatorios('Contexto empresarial inválido. Selecione novamente.');
      return;
    }

    const nome = String(
      empresa.nome_fantasia || empresa.razao_social || `Empresa #${empresa.id}`
    ).trim();
    const cnpj = empresa.cnpj && typeof contexto.formatarCnpj === 'function'
      ? contexto.formatarCnpj(empresa.cnpj)
      : '';
    [
      'financeiroRelatoriosEmpresaNome',
      'financeiroRelatoriosEmpresaCardNome'
    ].forEach((id) => {
      const elemento = document.getElementById(id);
      if (elemento) elemento.textContent = nome;
    });
    [
      'financeiroRelatoriosEmpresaCnpj',
      'financeiroRelatoriosEmpresaCardCnpj'
    ].forEach((id) => {
      const elemento = document.getElementById(id);
      if (elemento) elemento.textContent = cnpj;
    });
  } catch (error) {
    if (sequencia !== sequenciaValidacaoEmpresaRelatorios) return;
    console.error('Falha ao validar o contexto empresarial dos relatórios:', error);
    definirEstadoEmpresaRelatorios('Não foi possível validar a empresa ativa.');
  }
}

function observarContextoEmpresaRelatorios() {
  if (typeof document === 'undefined' || !document.addEventListener) return;
  document.removeEventListener(
    'cds-empresa-contexto-alterado',
    atualizarContextoEmpresaRelatorios
  );
  document.addEventListener(
    'cds-empresa-contexto-alterado',
    atualizarContextoEmpresaRelatorios
  );
}

function renderRelatoriosFinanceiros(periodo) {
  const conteudo = document.getElementById('financeiroConteudo');

  conteudo.innerHTML = `
    <section class="financeiro-relatorios" aria-labelledby="financeiroRelatoriosTitulo">
      <header class="financeiro-relatorios-cabecalho">
        <div>
          <span class="financeiro-relatorios-eyebrow">CONSULTAS E ANÁLISES</span>
          <h2 id="financeiroRelatoriosTitulo">Relatórios Financeiros</h2>
          <p>Consulte cada relatório de acordo com seu conceito e sua fonte de dados.</p>
        </div>
        <div class="financeiro-relatorios-contexto" aria-live="polite">
          <span><i class="fas fa-building" aria-hidden="true"></i> Empresa: <strong id="financeiroRelatoriosEmpresaNome">Validando contexto...</strong></span>
          <small id="financeiroRelatoriosEmpresaCnpj"></small>
          <small>Período definido no cabeçalho do Financeiro</small>
        </div>
      </header>

      <section class="financeiro-relatorios-filtros" aria-label="Seleção e filtros do relatório">
        <div class="financeiro-relatorios-campo financeiro-relatorios-campo--tipo">
          <label for="tipoRelatorio" class="form-label">Relatório</label>
          <select id="tipoRelatorio" class="form-select" aria-describedby="descricaoTipoRelatorio">
            <optgroup label="Visão geral">
              <option value="resumo">Resumo financeiro</option>
              <option value="fluxo">Fluxo financeiro</option>
            </optgroup>
            <optgroup label="Títulos e recebíveis">
              <option value="receber">Contas a receber</option>
              <option value="pagar">Contas a pagar (MCF)</option>
              <option value="inadimplencia">Inadimplência</option>
            </optgroup>
          </select>
          <small id="descricaoTipoRelatorio" class="financeiro-relatorios-ajuda"></small>
        </div>

        <div class="financeiro-relatorios-campo" id="grupoStatusRelatorio" hidden>
          <label for="filtroStatusRelatorio" class="form-label">Status</label>
          <select id="filtroStatusRelatorio" class="form-select"></select>
        </div>
        <div class="financeiro-relatorios-campo" id="grupoClienteRelatorio" hidden>
          <label for="filtroClienteRelatorio" class="form-label">Cliente</label>
          <input id="filtroClienteRelatorio" class="form-control" type="search" autocomplete="off">
        </div>
        <div class="financeiro-relatorios-campo" id="grupoFornecedorRelatorio" hidden>
          <label for="filtroFornecedorRelatorio" class="form-label">Fornecedor</label>
          <input id="filtroFornecedorRelatorio" class="form-control" type="search" autocomplete="off">
        </div>

        <div class="financeiro-relatorios-acoes">
          <button type="button" id="btnGerarRelatorio" class="btn btn-primary">
            <i class="fas fa-chart-bar" aria-hidden="true"></i> Gerar relatório
          </button>
          <button type="button" id="btnExportarRelatorio" class="btn btn-outline-secondary">
            <i class="fas fa-download" aria-hidden="true"></i> Exportar
          </button>
        </div>
      </section>

      <div id="relatorioContainer" class="financeiro-relatorios-resultado" aria-live="polite" aria-busy="false">
        <div class="financeiro-relatorios-estado financeiro-relatorios-estado--vazio">
          <i class="fas fa-chart-line" aria-hidden="true"></i>
          <div>
            <strong>Escolha um relatório</strong>
            <p>Selecione a consulta desejada e gere o resultado para o período atual.</p>
          </div>
        </div>
      </div>
    </section>
  `;

  document.getElementById('tipoRelatorio').addEventListener('change', function() {
    atualizarFiltrosVisiveisRelatorio();
    mostrarEstadoRelatorio('vazio', 'Consulta atualizada', 'Gere o relatório para visualizar os resultados.');
  });
  document.getElementById('btnGerarRelatorio').addEventListener('click', carregarRelatorioSelecionado);
  document.getElementById('btnExportarRelatorio').addEventListener('click', exportarRelatorio);
  atualizarFiltrosVisiveisRelatorio();
  observarContextoEmpresaRelatorios();
  atualizarContextoEmpresaRelatorios();
}

function atualizarFiltrosVisiveisRelatorio() {
  const tipo = document.getElementById('tipoRelatorio')?.value || 'resumo';
  const statusGrupo = document.getElementById('grupoStatusRelatorio');
  const clienteGrupo = document.getElementById('grupoClienteRelatorio');
  const fornecedorGrupo = document.getElementById('grupoFornecedorRelatorio');
  const status = document.getElementById('filtroStatusRelatorio');
  const descricao = document.getElementById('descricaoTipoRelatorio');
  const descricoes = {
    resumo: 'Receitas e despesas do Financeiro, com recebimentos de venda discriminados.',
    receber: 'Lançamentos a receber no período, com a composição fiscal disponível.',
    pagar: 'Títulos da fonte canônica de Contas a Pagar (MCF).',
    fluxo: 'Entradas de venda e lançamentos financeiros conforme o contrato do fluxo.',
    inadimplencia: 'Registros em atraso das fontes retornadas pelo relatório.'
  };
  const opcoesStatus = {
    receber: [
      ['todas', 'Todos os status'],
      ['pendente', 'Pendente'],
      ['recebido', 'Recebido'],
      ['pago', 'Pago'],
      ['parcial', 'Parcial'],
      ['vencido', 'Vencido'],
      ['cancelado', 'Cancelado']
    ],
    pagar: [
      ['todas', 'Todos os status'],
      ['pendente', 'Em aberto'],
      ['parcial', 'Parcial'],
      ['pago', 'Pago'],
      ['vencido', 'Vencido'],
      ['cancelado', 'Cancelado']
    ]
  };
  const opcoes = opcoesStatus[tipo] || [];
  const valorAnterior = status.value;
  const barraFiltros = document.querySelector('.financeiro-relatorios-filtros');
  status.replaceChildren();
  opcoes.forEach(([valor, rotulo]) => {
    const opcao = document.createElement('option');
    opcao.value = valor;
    opcao.textContent = rotulo;
    status.appendChild(opcao);
  });
  if (opcoes.some(([valor]) => valor === valorAnterior)) {
    status.value = valorAnterior;
  } else if (opcoes.length) {
    status.value = opcoes[0][0];
  }

  statusGrupo.hidden = opcoes.length === 0;
  clienteGrupo.hidden = tipo !== 'receber';
  fornecedorGrupo.hidden = tipo !== 'pagar';
  barraFiltros.classList.toggle('financeiro-relatorios-filtros--simples', opcoes.length === 0);
  descricao.textContent = descricoes[tipo] || '';
}

function mostrarEstadoRelatorio(tipo, titulo, mensagem) {
  const container = document.getElementById('relatorioContainer');
  if (!container) return;
  const icones = {
    carregando: 'fa-spinner fa-spin',
    vazio: 'fa-chart-line',
    erro: 'fa-exclamation-triangle'
  };
  const rotulos = {
    carregando: 'Carregando',
    vazio: 'Nenhum resultado',
    erro: 'Não foi possível gerar o relatório'
  };
  const estado = document.createElement('div');
  estado.className = `financeiro-relatorios-estado financeiro-relatorios-estado--${tipo}`;
  estado.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  const icone = document.createElement('i');
  icone.className = `fas ${icones[tipo] || icones.vazio}`;
  icone.setAttribute('aria-hidden', 'true');
  const conteudo = document.createElement('div');
  const tituloEl = document.createElement('strong');
  tituloEl.textContent = titulo || rotulos[tipo] || '';
  const mensagemEl = document.createElement('p');
  mensagemEl.textContent = mensagem || '';
  conteudo.append(tituloEl, mensagemEl);
  estado.append(icone, conteudo);
  container.replaceChildren(estado);
  container.setAttribute('aria-busy', tipo === 'carregando' ? 'true' : 'false');
}

async function gerarRelatorio() {
  return carregarRelatorioSelecionado();
}

function renderizarRelatorio(tipo, titulo, dados, periodo) {
  const container = document.getElementById('relatorioContainer');
  const sufixoModo = dados.modo_fiscal_ativo
    ? ' · Somente fiscal'
    : (dados.recebimentos_venda || dados.entradas_venda || dados.totais ? ' · Visão fiscal e não fiscal' : '');
  const periodoTexto = `Período: ${formatarData(periodo.dataInicio)} a ${formatarData(periodo.dataFim)}${sufixoModo}`;

  let html = `
    <section class="financeiro-relatorios-card">
      <header class="financeiro-relatorios-card-cabecalho">
        <div>
          <h3>${escaparHtmlRelatorio(titulo)}</h3>
          <p>${escaparHtmlRelatorio(periodoTexto)}</p>
        </div>
        <span class="financeiro-relatorios-card-contexto" aria-live="polite">
          Empresa: <strong id="financeiroRelatoriosEmpresaCardNome">Validando contexto...</strong>
          <small id="financeiroRelatoriosEmpresaCardCnpj"></small>
        </span>
      </header>
      <div class="financeiro-relatorios-card-conteudo">
      </div>
      <div class="card-body">
  `;

  switch (tipo) {
    case 'resumo':
      html += renderizarResumoFinanceiro(dados);
      break;
    case 'receber':
      html += renderizarRelatorioReceber(dados);
      break;
    case 'pagar':
      html += renderizarRelatorioPagar(dados);
      break;
    case 'fluxo':
      html += renderizarFluxoCaixa(dados);
      break;
    case 'inadimplencia':
      html += renderizarInadimplencia(dados);
      break;
  }

  html += `
      </div>
    </section>
  `;

  container.innerHTML = html;
  container.setAttribute('aria-busy', 'false');
  atualizarContextoEmpresaRelatorios();
}

function renderizarFluxoCaixa(dados) {
  const modoFiscalAtivo = Boolean(dados.modo_fiscal_ativo);
  const entradasVenda = dados.entradas_venda || {};
  const entradasHtml = modoFiscalAtivo
    ? `<p class="valor">${formatarMoeda(dados.entradas || 0)}</p>`
    : `
        <p class="valor">${formatarMoeda(dados.entradas || 0)}</p>
        <small class="text-muted d-block">
          Fiscal: ${formatarMoeda(entradasVenda.fiscal || 0)} |
          Não fiscal: ${formatarMoeda(entradasVenda.nao_fiscal || 0)}
        </small>
      `;

  return `
    <div class="row">
      <div class="col-md-6">
        <h5>Entradas (recebimentos de venda)</h5>
        <div class="dashboard-card recebido mb-3">
          ${entradasHtml}
        </div>
        ${!modoFiscalAtivo ? `<small class="text-muted">Lançamentos financeiros gerais: ${formatarMoeda(dados.entradas_financeiro || 0)}</small>` : ''}
      </div>
      <div class="col-md-6">
        <h5>Saídas</h5>
        <div class="dashboard-card pagar mb-3">
          <p class="valor">${formatarMoeda(dados.saidas || 0)}</p>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="col-12">
        <h5>Saldo</h5>
        <div class="dashboard-card saldo">
          <p class="valor">${formatarMoeda((dados.entradas || 0) - (dados.saidas || 0))}</p>
        </div>
      </div>
    </div>
  `;
}

function renderizarReceitasDespesas(dados) {
  return `
    <div class="row">
      <div class="col-md-6">
        <h5>Total Receitas</h5>
        <div class="dashboard-card recebido">
          <p class="valor">${formatarMoeda(dados.receitas || 0)}</p>
        </div>
      </div>
      <div class="col-md-6">
        <h5>Total Despesas</h5>
        <div class="dashboard-card pagar">
          <p class="valor">${formatarMoeda(dados.despesas || 0)}</p>
        </div>
      </div>
    </div>
    <div class="mt-4">
      <h5>Comparativo Mensal</h5>
      <div class="financeiro-tabela">
        <table>
          <thead>
            <tr>
              <th>Mês</th>
              <th>Receitas</th>
              <th>Despesas</th>
              <th>Saldo</th>
            </tr>
          </thead>
          <tbody>
            ${(dados.mensal || []).map(item => `
              <tr>
                <td>${escaparHtmlRelatorio(item.mes)}</td>
                <td>${formatarMoeda(item.receitas)}</td>
                <td>${formatarMoeda(item.despesas)}</td>
                <td class="${item.saldo >= 0 ? 'text-success' : 'text-danger'} font-weight-bold">
                  ${formatarMoeda(item.saldo)}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderizarInadimplencia(dados) {
  const linhas = (dados.contasAtraso || []).map(conta => [
    conta.pessoa || conta.cliente || '-',
    nomeEmpresaRelatorio(conta),
    valorCelulaRelatorio(formatarMoeda(conta.valor || 0)),
    conta.dias_atraso ?? conta.diasAtraso ?? '-',
    formatarData(conta.dataVencimento)
  ]);
  return `
    <div class="financeiro-relatorios-indicadores financeiro-relatorios-indicadores--inadimplencia">
      <div class="financeiro-relatorios-indicador financeiro-relatorios-indicador--vencido">
        <span>Contas vencidas</span>
        <strong>${escaparHtmlRelatorio(dados.vencidas)}</strong>
      </div>
      <div class="financeiro-relatorios-indicador">
        <span>Em atraso até 7 dias</span>
        <strong>${escaparHtmlRelatorio(dados.vencer7dias)}</strong>
      </div>
      <div class="financeiro-relatorios-indicador">
        <span>Valor total em atraso</span>
        <strong>${escaparHtmlRelatorio(formatarMoeda(dados.valorAtraso))}</strong>
      </div>
    </div>
    <h4 class="financeiro-relatorios-subtitulo">Detalhes das contas em atraso</h4>
    ${renderTabelaRelatorio(
      ['Pessoa', 'Empresa', 'Valor', 'Dias em atraso', 'Data de vencimento'],
      linhas,
      'Nenhuma conta em atraso para o período selecionado.'
    )}
  `;
}

function renderizarLucroPrejuizo(dados) {
  const lucroPrejuizo = (dados.receitas || 0) - (dados.despesas || 0);
  const classe = lucroPrejuizo >= 0 ? 'text-success' : 'text-danger';
  const titulo = lucroPrejuizo >= 0 ? 'Lucro' : 'Prejuízo';

  return `
    <div class="row">
      <div class="col-md-6">
        <h5>Receitas Totais</h5>
        <div class="dashboard-card recebido">
          <p class="valor">${formatarMoeda(dados.receitas || 0)}</p>
        </div>
      </div>
      <div class="col-md-6">
        <h5>Despesas Totais</h5>
        <div class="dashboard-card pagar">
          <p class="valor">${formatarMoeda(dados.despesas || 0)}</p>
        </div>
      </div>
    </div>
    <div class="row mt-3">
      <div class="col-12">
        <h5>${titulo} do Período</h5>
        <div class="dashboard-card saldo">
          <p class="valor ${classe}">${formatarMoeda(Math.abs(lucroPrejuizo))}</p>
        </div>
      </div>
    </div>
  `;
}

function renderizarResumoFinanceiro(dados) {
  const modoFiscalAtivo = Boolean(dados.modo_fiscal_ativo);
  const recebimentos = dados.recebimentos_venda || {};
  const recebimentosHtml = modoFiscalAtivo
    ? `<p class="valor mb-0">${formatarMoeda(recebimentos.fiscal?.total || 0)}</p>`
    : `
        <p class="valor mb-0">${formatarMoeda(recebimentos.total?.total || 0)}</p>
        <small class="text-muted">
          Fiscal: ${formatarMoeda(recebimentos.fiscal?.total || 0)} |
          Não fiscal: ${formatarMoeda(recebimentos.nao_fiscal?.total || 0)}
        </small>
      `;

  return `
    <div class="row mb-3">
      <div class="col-12">
        <div class="dashboard-card recebido">
          <h5>Recebimentos de Venda</h5>
          ${recebimentosHtml}
        </div>
      </div>
    </div>
    <div class="row">
      <div class="col-md-4">
        <div class="dashboard-card recebido">
          <h5>Receitas</h5>
          <p class="valor">${formatarMoeda(dados.receitas.total || 0)}</p>
          <small>Recebidas: ${formatarMoeda(dados.receitas.recebidas || 0)}</small>
        </div>
      </div>
      <div class="col-md-4">
        <div class="dashboard-card pagar">
          <h5>Despesas</h5>
          <p class="valor">${formatarMoeda(dados.despesas.total || 0)}</p>
          <small>Pagas: ${formatarMoeda(dados.despesas.pagas || 0)}</small>
        </div>
      </div>
      <div class="col-md-4">
        <div class="dashboard-card saldo">
          <h5>Saldo</h5>
          <p class="valor">${formatarMoeda((dados.receitas.total || 0) - (dados.despesas.total || 0))}</p>
        </div>
      </div>
    </div>
  `;
}

function renderizarRelatorioReceber(dados) {
  const modoFiscalAtivo = Boolean(dados.modo_fiscal_ativo);
  const colunas = modoFiscalAtivo
    ? ['Cliente', 'Empresa', 'Descrição', 'Documento', 'Vencimento', 'Valor Fiscal', 'Status', 'Origem']
    : ['Cliente', 'Empresa', 'Descrição', 'Documento', 'Vencimento', 'Fiscal', 'Não Fiscal', 'Total', 'Status', 'Origem'];
  const linhas = (dados.contas || []).map(conta => {
    const empresa = nomeEmpresaRelatorio(conta);
    if (modoFiscalAtivo) {
      return [
        conta.cliente || '-',
        empresa,
        conta.descricao || '-',
        conta.documento || '-',
        formatarData(conta.dataVencimento),
        valorCelulaRelatorio(formatarMoeda(conta.valor_fiscal ?? conta.valor ?? 0)),
        statusCelulaRelatorio(conta.status || '-'),
        conta.origem || '-'
      ];
    }
    return [
      conta.cliente || '-',
      empresa,
      conta.descricao || '-',
      conta.documento || '-',
      formatarData(conta.dataVencimento),
      valorCelulaRelatorio(formatarMoeda(conta.valor_fiscal || 0)),
      valorCelulaRelatorio(formatarMoeda(conta.valor_nao_fiscal || 0)),
      valorCelulaRelatorio(formatarMoeda(conta.valor_total ?? conta.valor ?? 0)),
      statusCelulaRelatorio(conta.status || '-'),
      conta.origem || '-'
    ];
  });
  const totais = dados.totais || {};
  const rodape = modoFiscalAtivo
    ? `<div class="mt-3 text-end"><strong>Total fiscal: ${formatarMoeda(totais.fiscal || 0)}</strong></div>`
    : `<div class="mt-3 text-end">
        <strong>Total: ${formatarMoeda(totais.total || 0)}</strong>
        <small class="text-muted d-block">
          Fiscal: ${formatarMoeda(totais.fiscal || 0)} | Não fiscal: ${formatarMoeda(totais.nao_fiscal || 0)}
        </small>
      </div>`;
  return renderTabelaRelatorio(colunas, linhas) + rodape;
}

function renderizarRelatorioPagar(dados) {
  const colunas = ['Fornecedor', 'Empresa', 'Descrição', 'Documento', 'Categoria', 'Vencimento', 'Valor', 'Status', 'Forma de Pagamento', 'Origem'];
  const linhas = (dados.contas || []).map(conta => [
    conta.fornecedor || '-',
    nomeEmpresaRelatorio(conta),
    conta.descricao || '-',
    conta.documento || '-',
    conta.categoria || '-',
    formatarData(conta.dataVencimento),
    valorCelulaRelatorio(formatarMoeda(conta.valor || 0)),
    statusCelulaRelatorio(conta.status || '-'),
    conta.forma_pagamento || '-',
    conta.origem || '-'
  ]);
  return renderTabelaRelatorio(colunas, linhas);
}

function exportarRelatorio() {
  const tipo = document.getElementById('tipoRelatorio').value;
  const periodo = obterPeriodoFinanceiro();

  // Implementar exportação (PDF, Excel, etc.)
  alert(`Exportação do relatório "${tipo}" em desenvolvimento`);
}

// Funções obrigatórias do prompt
function carregarRelatorioSelecionado() {
  const tipo = document.getElementById('tipoRelatorio').value;
  const periodo = obterPeriodoFinanceiro();
  
  switch (tipo) {
    case 'resumo':
      return gerarRelatorioResumo(coletarFiltrosRelatorios(periodo));
    case 'receber':
      return gerarRelatorioReceber(coletarFiltrosRelatorios(periodo));
    case 'pagar':
      return gerarRelatorioPagar(coletarFiltrosRelatorios(periodo));
    case 'fluxo':
      return gerarRelatorioFluxo(coletarFiltrosRelatorios(periodo));
    case 'inadimplencia':
      return gerarRelatorioInadimplencia(coletarFiltrosRelatorios(periodo));
    default:
      return Promise.resolve();
  }
}

async function requisitarDadosRelatorio(url, mensagemErro) {
  const response = await fetch(url, { headers: __headersFin() });
  const dados = await response.json().catch(() => null);

  if (response.status === 401) {
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  if (response.status === 403) {
    throw new Error(dados?.error || 'Você não tem permissão para consultar este relatório.');
  }
  if (!response.ok) {
    throw new Error(dados?.error || mensagemErro);
  }
  if (!dados || typeof dados !== 'object' || Array.isArray(dados) || dados.success !== true) {
    throw new Error(dados?.error || 'A resposta da API está fora do formato esperado.');
  }

  return dados;
}

function validarFormatoRelatorio(tipo, dados) {
  const objeto = valor => valor && typeof valor === 'object' && !Array.isArray(valor);
  let valido = false;
  switch (tipo) {
    case 'resumo':
      valido = objeto(dados.resumo)
        && objeto(dados.resumo.receitas)
        && objeto(dados.resumo.despesas)
        && objeto(dados.recebimentos_venda);
      break;
    case 'receber':
    case 'pagar':
      valido = Array.isArray(dados.contas);
      break;
    case 'fluxo':
      valido = Array.isArray(dados.fluxo)
        || (typeof dados.entradas === 'number' && typeof dados.saidas === 'number');
      break;
    case 'inadimplencia':
      valido = Array.isArray(dados.contasAtraso)
        && typeof dados.vencidas === 'number'
        && typeof dados.vencer7dias === 'number'
        && typeof dados.valorAtraso === 'number';
      break;
    default:
      valido = false;
  }
  if (!valido) {
    throw new Error('A resposta da API está fora do formato esperado para este relatório.');
  }
}

async function executarRelatorioApi(tipo, titulo, url, filtros, transformarDados) {
  mostrarEstadoRelatorio('carregando', 'Gerando relatório', 'Consultando os dados da empresa ativa...');
  try {
    const resposta = await requisitarDadosRelatorio(url, `Erro ao gerar ${titulo.toLowerCase()}.`);
    validarFormatoRelatorio(tipo, resposta);
    const dados = transformarDados ? transformarDados(resposta) : resposta;
    renderizarRelatorio(tipo, titulo, dados, filtros);
  } catch (error) {
    console.error(`Erro ao gerar ${titulo.toLowerCase()}:`, error);
    mostrarEstadoRelatorio('erro', 'Não foi possível gerar o relatório', error.message || String(error));
  }
}

function gerarRelatorioResumo(filtros) {
  const params = new URLSearchParams({
    dataInicio: filtros.dataInicio,
    dataFim: filtros.dataFim,
    modo_fiscal: modoFiscalRelatorioFinanceiroParam()
  });
  return executarRelatorioApi(
    'resumo',
    'Resumo Financeiro',
    `${endpointRelatorioFinanceiro('/relatorios/resumo')}?${params.toString()}`,
    filtros,
    dados => ({
      ...dados.resumo,
      modo_fiscal_ativo: dados.modo_fiscal_ativo,
      recebimentos_venda: dados.recebimentos_venda
    })
  );
}

function gerarRelatorioReceber(filtros) {
  const params = new URLSearchParams({
    dataInicio: filtros.dataInicio,
    dataFim: filtros.dataFim,
    status: filtros.status,
    cliente: filtros.cliente || '',
    modo_fiscal: modoFiscalRelatorioFinanceiroParam()
  });
  return executarRelatorioApi(
    'receber',
    'Contas a Receber',
    `${endpointRelatorioFinanceiro('/relatorios/receber')}?${params.toString()}`,
    filtros
  );
}

function gerarRelatorioPagar(filtros) {
  const params = new URLSearchParams({
    dataInicio: filtros.dataInicio || '',
    dataFim: filtros.dataFim || '',
    status: filtros.status || 'todos',
    fornecedor: filtros.fornecedor || ''
  });
  return executarRelatorioApi(
    'pagar',
    'Contas a Pagar',
    `${typeof financeiroEscopoTodasEmpresas === 'function' && financeiroEscopoTodasEmpresas()
      ? '/api/contas-pagar/multiempresa'
      : '/api/contas-pagar'}?${params.toString()}`,
    filtros,
    dados => ({
      ...dados,
      contas: dados.contas.map(conta => ({
        ...conta,
        fornecedor: conta.pessoa_nome || conta.fornecedor_nome || '-',
        valor: conta.valor_original,
        dataVencimento: conta.data_vencimento
      }))
    })
  );
}

function gerarRelatorioFluxo(filtros) {
  const params = new URLSearchParams({
    dataInicio: filtros.dataInicio,
    dataFim: filtros.dataFim,
    modo_fiscal: modoFiscalRelatorioFinanceiroParam()
  });
  return executarRelatorioApi(
    'fluxo',
    'Fluxo Financeiro',
    `${endpointRelatorioFinanceiro('/relatorios/fluxo')}?${params.toString()}`,
    filtros
  );
}

function gerarRelatorioInadimplencia(filtros) {
  const params = new URLSearchParams({
    dataInicio: filtros.dataInicio,
    dataFim: filtros.dataFim
  });
  return executarRelatorioApi(
    'inadimplencia',
    'Relatório de Inadimplência',
    `${endpointRelatorioFinanceiro('/relatorios/inadimplencia')}?${params.toString()}`,
    filtros
  );
}

function renderTabelaRelatorio(colunas, linhas, mensagemVazia) {
  return renderTabelaRelatorioComVazio(colunas, linhas, mensagemVazia);
}

function valorCelulaRelatorio(texto) {
  return { tipo: 'valor', texto };
}

function statusCelulaRelatorio(texto) {
  return { tipo: 'status', texto };
}

function renderTabelaRelatorioComVazio(colunas, linhas, mensagemVazia) {
  if (!Array.isArray(linhas)) {
    throw new Error('As linhas do relatório estão fora do formato esperado.');
  }
  if (linhas.length === 0) {
    return `
      <div class="financeiro-relatorios-estado financeiro-relatorios-estado--vazio">
        <i class="fas fa-inbox" aria-hidden="true"></i>
        <div>
          <strong>Nenhum resultado</strong>
          <p>${escaparHtmlRelatorio(mensagemVazia || 'Nenhum dado encontrado para os filtros selecionados.')}</p>
        </div>
      </div>
    `;
  }

  const statusClasses = {
    aberto: 'financeiro-relatorios-status--aberto',
    pendente: 'financeiro-relatorios-status--aberto',
    parcial: 'financeiro-relatorios-status--parcial',
    vencido: 'financeiro-relatorios-status--vencido',
    recebido: 'financeiro-relatorios-status--concluido',
    pago: 'financeiro-relatorios-status--concluido',
    quitada: 'financeiro-relatorios-status--concluido',
    cancelado: 'financeiro-relatorios-status--neutro',
    cancelada: 'financeiro-relatorios-status--neutro'
  };
  const renderizarCelula = celula => {
    if (celula && typeof celula === 'object' && Object.prototype.hasOwnProperty.call(celula, 'tipo')) {
      const texto = escaparHtmlRelatorio(celula.texto);
      if (celula.tipo === 'valor') {
        return `<td class="financeiro-relatorios-valor">${texto}</td>`;
      }
      if (celula.tipo === 'status') {
        const statusTexto = String(celula.texto ?? '');
        const statusClasse = Object.prototype.hasOwnProperty.call(statusClasses, statusTexto.toLowerCase())
          ? statusClasses[statusTexto.toLowerCase()]
          : 'financeiro-relatorios-status--neutro';
        return `<td><span class="financeiro-relatorios-status ${statusClasse}">${texto}</span></td>`;
      }
    }
    return `<td>${escaparHtmlRelatorio(celula)}</td>`;
  };

  const indicesValor = new Set();
  linhas.forEach(linha => linha.forEach((celula, indice) => {
    if (celula && typeof celula === 'object' && celula.tipo === 'valor') {
      indicesValor.add(indice);
    }
  }));
  const cabecalho = colunas.map((coluna, indice) => {
    const classe = indicesValor.has(indice) ? ' class="financeiro-relatorios-valor"' : '';
    return `<th scope="col"${classe}>${escaparHtmlRelatorio(coluna)}</th>`;
  }).join('');
  const corpo = linhas.map(linha => {
    if (!Array.isArray(linha)) {
      throw new Error('Uma linha do relatório está fora do formato esperado.');
    }
    return `<tr>${linha.map(renderizarCelula).join('')}</tr>`;
  }).join('');

  return `
    <div class="financeiro-relatorios-tabela-scroll">
      <table class="financeiro-relatorios-tabela">
        <thead><tr>${cabecalho}</tr></thead>
        <tbody>${corpo}</tbody>
      </table>
    </div>
  `;
}

function coletarFiltrosRelatorios(periodo) {
  return {
    dataInicio: periodo?.dataInicio || '',
    dataFim: periodo?.dataFim || '',
    status: document.getElementById('filtroStatusRelatorio')?.value || 'todas',
    cliente: document.getElementById('filtroClienteRelatorio')?.value || '',
    fornecedor: document.getElementById('filtroFornecedorRelatorio')?.value || '',
    tipo: document.getElementById('tipoRelatorio')?.value || 'resumo'
  };
}

function endpointRelatorioFinanceiro(caminho) {
  const prefixo = typeof financeiroEscopoTodasEmpresas === 'function' && financeiroEscopoTodasEmpresas()
    ? '/api/financeiro/multiempresa'
    : '/api/financeiro';
  return `${prefixo}${caminho}`;
}

function formatarData(data) {
  if (data == null || data === '') return '-';
  const valor = String(data);
  const dataLocal = /^\d{4}-\d{2}-\d{2}$/.test(valor) ? `${valor}T00:00:00` : valor;
  const dataConvertida = new Date(dataLocal);
  return Number.isNaN(dataConvertida.getTime())
    ? '-'
    : dataConvertida.toLocaleDateString('pt-BR');
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valor);
}