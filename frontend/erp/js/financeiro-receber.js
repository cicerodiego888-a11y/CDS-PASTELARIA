// Contas a Receber
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

let modalDetalhesRecebimento = null;
/** Cache da última lista unificada (chave → conta) para detalhes/ações por fonte. */
let cacheListaContasReceber = Object.create(null);
let empresaDuplicataAtualId = null;

function headersReceberDaEmpresa(empresaId, extra) {
  const id = Number(empresaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Não foi possível identificar a empresa proprietária deste recebível.');
  }
  if (typeof headersFinanceiroDaEmpresa === 'function') {
    return headersFinanceiroDaEmpresa(id, extra || {});
  }
  return Object.assign(__headersFin(extra), { 'X-Empresa-Id': String(id) });
}

function empresaIdReceberParaAcao(empresaId, conta) {
  const registrado = conta && conta.empresa_id != null ? conta.empresa_id : empresaId;
  if (registrado != null && Number.isSafeInteger(Number(registrado)) && Number(registrado) > 0) {
    return Number(registrado);
  }
  if (
    typeof financeiroEscopoEmpresa !== 'undefined'
    && financeiroEscopoEmpresa !== 'todas'
    && Number.isSafeInteger(Number(financeiroEscopoEmpresa))
  ) {
    return Number(financeiroEscopoEmpresa);
  }
  return null;
}

function escapeHtmlFinanceiroSafe(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderContasReceber(periodo) {
  const conteudo = document.getElementById('financeiroConteudo');

  conteudo.innerHTML = `
    <section class="financeiro-filtros financeiro-filtros--receber" aria-label="Filtros de contas a receber">
      <div class="financeiro-filtros-principais">
        <div class="financeiro-filtro-grupo financeiro-filtro-grupo--busca">
        <label for="filtroClienteReceber">Cliente:</label>
        <input
          type="text"
          id="filtroClienteReceber"
          class="form-control"
          placeholder="Nome ou CPF do cliente"
        />
      </div>
        <div class="financeiro-filtro-grupo financeiro-filtro-grupo--status">
          <label for="filtroStatusReceber">Status:</label>
          <select id="filtroStatusReceber" class="form-select">
            <option value="todas">Todas</option>
            <option value="vencidas">Vencidas</option>
            <option value="a_vencer">A vencer</option>
            <option value="recebidas">Recebidas</option>
          </select>
        </div>
      </div>
      <div class="financeiro-acoes financeiro-acoes--receber">
        <button type="button" class="btn btn-primary" onclick="novoRecebimento()">
          <i class="fas fa-plus"></i> Nova Conta a Receber
        </button>
        <button type="button" class="btn btn-outline-secondary" onclick="filtrarReceber()">
          <i class="fas fa-filter" aria-hidden="true"></i> Aplicar filtros
        </button>
        <div class="financeiro-acoes-exportar" aria-label="Exportar contas a receber">
          <button type="button" class="btn btn-outline-secondary" onclick="exportarReceber('pdf')" aria-label="Exportar PDF" title="Exportar PDF">
            <i class="fas fa-file-pdf" aria-hidden="true"></i><span> PDF</span>
          </button>
          <button type="button" class="btn btn-outline-secondary" onclick="exportarReceber('excel')" aria-label="Exportar Excel" title="Exportar Excel">
            <i class="fas fa-file-excel" aria-hidden="true"></i><span> Excel</span>
          </button>
        </div>
      </div>

      <details class="financeiro-filtros-avancados">
        <summary><i class="fas fa-sliders-h" aria-hidden="true"></i> Mais filtros <span>Documento e vencimento</span></summary>
        <div class="financeiro-filtros-avancados-campos">
          <div class="financeiro-filtro-grupo">
            <label for="filtroDocumentoReceber">Documento:</label>
            <input type="text" id="filtroDocumentoReceber" class="form-control" placeholder="Número do documento">
          </div>
          <div class="financeiro-filtro-grupo">
            <label for="filtroDataInicioReceber">Vencimento a partir de:</label>
            <input type="date" id="filtroDataInicioReceber" class="form-control" value="${escapeHtmlFinanceiroSafe(periodo.dataInicio || '')}">
          </div>
          <div class="financeiro-filtro-grupo">
            <label for="filtroDataFimReceber">Vencimento até:</label>
            <input type="date" id="filtroDataFimReceber" class="form-control" value="${escapeHtmlFinanceiroSafe(periodo.dataFim || '')}">
          </div>
        </div>
      </details>
    </section>

    <div id="contasReceberEstadoVazio" class="financeiro-empty-state" hidden>
      <div class="financeiro-empty-state__icon" aria-hidden="true"><i class="fas fa-file-invoice-dollar"></i></div>
      <h3>Nenhuma conta encontrada</h3>
      <p>Não há títulos para os filtros e o período selecionados.</p>
      <button type="button" class="btn btn-outline-secondary" onclick="limparFiltrosReceber()">Limpar filtros</button>
    </div>

    <div id="contasReceberTabelaWrap" class="financeiro-tabela financeiro-tabela--receber">
      <div class="table-responsive">
        <table id="tabelaReceber" class="table table-hover align-middle">
          <caption class="visually-hidden">Contas a receber no período selecionado</caption>
        <thead>
          <tr>
            <th scope="col">Cliente</th>
            <th scope="col">Empresa</th>
            <th scope="col">Descrição</th>
            <th scope="col">Documento</th>
            <th scope="col">Vencimento</th>
            <th scope="col">Valor</th>
            <th scope="col">Parcela</th>
            <th scope="col">Status</th>
            <th scope="col">Origem</th>
            <th scope="col">Ações</th>
          </tr>
        </thead>
        <tbody id="contasReceberTabelaBody">
          <tr>
            <td colspan="10" class="text-center text-muted">Carregando contas a receber...</td>
          </tr>
        </tbody>
        </table>
      </div>
    </div>
  `;

  // Configurar filtros
  configurarFiltrosReceber();

  // Carregar dados
  carregarContasReceber(coletarFiltrosReceber(periodo));
}

function renderDuplicataClientes(periodo) {
  const conteudo = document.getElementById('financeiroConteudo');
  if (!conteudo) return;

  conteudo.innerHTML = `
    <section class="financeiro-duplicata" aria-labelledby="financeiroDuplicataTitulo">
      <header class="financeiro-duplicata-cabecalho">
        <div>
          <span class="financeiro-duplicata-eyebrow">CONTAS A RECEBER · AGRUPADO</span>
          <h2 id="financeiroDuplicataTitulo">Dívidas por Cliente</h2>
          <p>Saldos em aberto de <code>contas_receber</code>, agrupados por cliente e empresa de origem.</p>
        </div>
      </header>

      <section class="financeiro-duplicata-filtros" aria-label="Filtros de dívidas por cliente">
        <div class="financeiro-duplicata-campo financeiro-duplicata-campo--busca">
          <label for="filtroClienteDuplicata">Buscar cliente</label>
          <input
            type="search"
            id="filtroClienteDuplicata"
            class="form-control"
            placeholder="Nome, CPF ou telefone"
            autocomplete="off"
          />
        </div>
        <div class="financeiro-duplicata-campo">
          <label for="filtroStatusDuplicata">Situação</label>
          <select id="filtroStatusDuplicata" class="form-select">
            <option value="todas">Todas</option>
            <option value="vencidas">Vencidas</option>
            <option value="a_vencer">A vencer</option>
          </select>
        </div>
        <div class="financeiro-duplicata-campo">
          <label for="filtroDataInicioDuplicata">Vencimento de</label>
          <input type="date" id="filtroDataInicioDuplicata" class="form-control" value="${escapeHtmlFinanceiroSafe(periodo.dataInicio || '')}">
        </div>
        <div class="financeiro-duplicata-campo">
          <label for="filtroDataFimDuplicata">Vencimento até</label>
          <input type="date" id="filtroDataFimDuplicata" class="form-control" value="${escapeHtmlFinanceiroSafe(periodo.dataFim || '')}">
        </div>
        <div class="financeiro-duplicata-acoes-filtro">
          <button type="button" class="btn btn-primary" id="btnFiltrarDuplicata">
            <i class="fas fa-filter" aria-hidden="true"></i> Filtrar
          </button>
        </div>
      </section>

      <div id="duplicataListaEstado" class="financeiro-duplicata-estado" role="status" aria-live="polite" hidden></div>

      <div class="financeiro-duplicata-tabela-wrap" id="duplicataTabelaWrap" hidden>
        <div class="table-responsive">
          <table class="financeiro-duplicata-tabela" id="tabelaDuplicataClientes">
            <caption class="visually-hidden">Clientes com títulos em aberto no período</caption>
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col">Empresa</th>
                <th scope="col">Documento / contato</th>
                <th scope="col" class="financeiro-duplicata-num">Vendas</th>
                <th scope="col" class="financeiro-duplicata-num">Títulos</th>
                <th scope="col" class="financeiro-duplicata-valor">Total em aberto</th>
                <th scope="col" class="financeiro-duplicata-num">Vencidas</th>
                <th scope="col" class="financeiro-duplicata-num">A vencer</th>
                <th scope="col" class="financeiro-duplicata-col-acoes">Ações</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  document.getElementById('btnFiltrarDuplicata')?.addEventListener('click', () => filtrarDuplicata());
  document.getElementById('filtroClienteDuplicata')?.addEventListener('input', () => filtrarDuplicata());
  document.getElementById('filtroStatusDuplicata')?.addEventListener('change', () => filtrarDuplicata());
  carregarDuplicataClientes(coletarFiltrosDuplicata(periodo));
}

function setEstadoDuplicataLista(tipo, mensagem) {
  const el = document.getElementById('duplicataListaEstado');
  const wrap = document.getElementById('duplicataTabelaWrap');
  if (!el) return;
  el.hidden = false;
  el.className = 'financeiro-duplicata-estado';
  el.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  if (tipo === 'carregando') {
    el.classList.add('financeiro-duplicata-estado--carregando');
    el.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>Carregando dívidas por cliente…</span>';
    if (wrap) wrap.hidden = true;
    return;
  }
  if (tipo === 'vazio') {
    el.classList.add('financeiro-duplicata-estado--vazio');
    el.innerHTML =
      '<i class="fas fa-users" aria-hidden="true"></i>' +
      '<div><strong>Nenhuma dívida agrupada encontrada</strong>' +
      '<p>Não há títulos em aberto de contas a receber para os filtros e o período selecionados.</p></div>';
    if (wrap) wrap.hidden = true;
    return;
  }
  if (tipo === 'erro') {
    el.classList.add('financeiro-duplicata-estado--erro');
    el.innerHTML =
      '<i class="fas fa-exclamation-circle" aria-hidden="true"></i>' +
      '<div><strong>Não foi possível carregar</strong><p></p></div>';
    const p = el.querySelector('p');
    if (p) p.textContent = String(mensagem || 'Erro ao carregar dados');
    if (wrap) wrap.hidden = true;
    return;
  }
  el.hidden = true;
  el.innerHTML = '';
  if (wrap) wrap.hidden = false;
}

function configurarFiltrosReceber() {
  // Configurar eventos de filtro
  document.getElementById('filtroClienteReceber').addEventListener('input', () => filtrarReceber());
  document.getElementById('filtroStatusReceber').addEventListener('change', () => filtrarReceber());
  document.getElementById('filtroDocumentoReceber').addEventListener('input', () => filtrarReceber());
}

function coletarFiltrosDuplicata(periodo) {
  return {
    cliente: document.getElementById('filtroClienteDuplicata').value.trim(),
    status: document.getElementById('filtroStatusDuplicata').value,
    dataInicio: document.getElementById('filtroDataInicioDuplicata').value || periodo.dataInicio,
    dataFim: document.getElementById('filtroDataFimDuplicata').value || periodo.dataFim
  };
}

function filtrarDuplicata() {
  const filtros = coletarFiltrosDuplicata(obterPeriodoFinanceiro());
  carregarDuplicataClientes(filtros);
}

async function carregarDuplicataClientes(filtros) {
  setEstadoDuplicataLista('carregando');
  try {
    const queryString = new URLSearchParams(filtros).toString();
    const endpoint = typeof financeiroEscopoTodasEmpresas === 'function' && financeiroEscopoTodasEmpresas()
      ? '/api/financeiro/multiempresa/dividas-cliente'
      : '/api/financeiro/receber/agrupado';
    const response = await fetch(`${endpoint}?${queryString}`, {
      headers: __headersFin()
    });
    const dados = await response.json().catch(() => ({}));

    if (!response.ok || !dados.success) {
      throw new Error(dados.error || 'Falha ao carregar lista de duplicatas');
    }
    if (!Array.isArray(dados.clientes)) {
      throw new Error('Resposta inválida ao listar dívidas por cliente.');
    }

    preencherTabelaDuplicataClientes(dados.clientes);
  } catch (error) {
    console.error('Erro ao carregar dívidas por cliente:', error);
    setEstadoDuplicataLista('erro', error.message || 'Erro ao carregar dados');
  }
}

function preencherTabelaDuplicataClientes(clientes) {
  const tbody = document.querySelector('#tabelaDuplicataClientes tbody');
  if (!tbody) return;

  if (!Array.isArray(clientes) || clientes.length === 0) {
    setEstadoDuplicataLista('vazio');
    tbody.innerHTML = '';
    return;
  }

  setEstadoDuplicataLista('ok');
  tbody.innerHTML = clientes.map((cliente) => {
    const id = Number(cliente.cliente_id);
    const idAttr = Number.isInteger(id) && id > 0 ? String(id) : '';
    const contato = [
      cliente.cpf ? escapeHtmlFinanceiroSafe(cliente.cpf) : '',
      cliente.telefone ? escapeHtmlFinanceiroSafe(cliente.telefone) : ''
    ].filter(Boolean).join('<br>') || '—';
    return `
      <tr>
        <td><span class="financeiro-duplicata-cliente">${escapeHtmlFinanceiroSafe(cliente.nome_cliente)}</span></td>
        <td>${escapeHtmlFinanceiroSafe(cliente.empresa_nome || nomeEmpresaFinanceiro(cliente.empresa_id) || '—')}</td>
        <td class="financeiro-duplicata-contato">${contato}</td>
        <td class="financeiro-duplicata-num">${escapeHtmlFinanceiroSafe(cliente.quantidade_vendas)}</td>
        <td class="financeiro-duplicata-num">${escapeHtmlFinanceiroSafe(cliente.quantidade_titulos)}</td>
        <td class="financeiro-duplicata-valor">${formatarMoeda(cliente.total_divida)}</td>
        <td class="financeiro-duplicata-num${Number(cliente.vencidas) > 0 ? ' financeiro-duplicata-num--alerta' : ''}">${escapeHtmlFinanceiroSafe(cliente.vencidas)}</td>
        <td class="financeiro-duplicata-num">${escapeHtmlFinanceiroSafe(cliente.a_vencer)}</td>
        <td class="financeiro-duplicata-col-acoes">
          <button type="button" class="btn btn-sm btn-primary" data-abrir-duplicata="${idAttr}" data-empresa-id="${escapeHtmlFinanceiroSafe(cliente.empresa_id || '')}" ${idAttr ? '' : 'disabled'}>
            <i class="fas fa-file-invoice-dollar" aria-hidden="true"></i> Ver duplicata
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-abrir-duplicata]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-abrir-duplicata'));
        const empresaId = Number(btn.getAttribute('data-empresa-id'));
        if (Number.isInteger(id) && id > 0) abrirDuplicataCliente(id, empresaId);
      });
  });
}

async function abrirDuplicataCliente(clienteId, empresaId) {
  try {
      const empresaIdAcao = empresaIdReceberParaAcao(empresaId);
      const response = await fetch(`/api/financeiro/receber/agrupado/${clienteId}`, {
        headers: headersReceberDaEmpresa(empresaIdAcao)
      });
    const dados = await response.json();

    if (!dados.success) {
      throw new Error(dados.error || 'Falha ao carregar duplicata do cliente');
    }

    dados.empresa_id = empresaIdAcao;
    dados.empresa_nome = nomeEmpresaFinanceiro(empresaIdAcao);
    renderizarDuplicataCliente(dados);
  } catch (error) {
    console.error('Erro ao abrir duplicata:', error);
    alert('Não foi possível abrir a duplicata do cliente. Tente novamente.');
  }
}

function formatarStatusDuplicataBadge(status) {
  const key = String(status || '').toLowerCase();
  const map = {
    aberto: { cls: 'financeiro-duplicata-badge financeiro-duplicata-badge--aberto', label: 'Em aberto' },
    vencido: { cls: 'financeiro-duplicata-badge financeiro-duplicata-badge--vencido', label: 'Vencido' },
    parcial: { cls: 'financeiro-duplicata-badge financeiro-duplicata-badge--parcial', label: 'Parcial' },
    recebido: { cls: 'financeiro-duplicata-badge financeiro-duplicata-badge--recebido', label: 'Recebido' },
    pago: { cls: 'financeiro-duplicata-badge financeiro-duplicata-badge--recebido', label: 'Pago' }
  };
  const item = map[key] || {
    cls: 'financeiro-duplicata-badge financeiro-duplicata-badge--neutro',
    label: status ? String(status) : '—'
  };
  return `<span class="${item.cls}">${escapeHtmlFinanceiroSafe(item.label)}</span>`;
}

function renderizarDuplicataCliente(dados) {
  const conteudo = document.getElementById('financeiroConteudo');
  if (!conteudo || !dados || !dados.cliente) return;
  empresaDuplicataAtualId = empresaIdReceberParaAcao(dados.empresa_id);

  const clienteId = Number(dados.cliente.id);
  const clienteIdAttr = Number.isInteger(clienteId) && clienteId > 0 ? String(clienteId) : '';
  const contato = [
    dados.cliente.cpf ? escapeHtmlFinanceiroSafe(dados.cliente.cpf) : '',
    dados.cliente.telefone ? escapeHtmlFinanceiroSafe(dados.cliente.telefone) : ''
  ].filter(Boolean).join(' · ');

  const vendas = Array.isArray(dados.vendas) ? dados.vendas : [];
  const resumo = dados.resumo || {};

  const vendasHtml = vendas.map((venda) => {
    const vendaId = Number(venda.venda_id);
    const vendaIdAttr = Number.isInteger(vendaId) && vendaId > 0 ? String(vendaId) : '';
    const produtos = Array.isArray(venda.produtos) ? venda.produtos : [];
    const parcelas = Array.isArray(venda.parcelas) ? venda.parcelas : [];
    return `
      <article class="financeiro-duplicata-venda">
        <div class="financeiro-duplicata-venda-topo">
          <div>
            <h3>Venda ${escapeHtmlFinanceiroSafe(venda.numero_venda || venda.venda_id)}</h3>
            <p>Emissão ${formatarData(venda.data_venda)} · Vencimento ${formatarData(venda.data_vencimento)}</p>
          </div>
          <div class="financeiro-duplicata-venda-status">${formatarStatusDuplicataBadge(venda.status)}</div>
        </div>
        <div class="financeiro-duplicata-venda-valores">
          <div><span>Total</span><strong class="financeiro-duplicata-valor">${formatarMoeda(venda.valor_total)}</strong></div>
          <div><span>Pago</span><strong class="financeiro-duplicata-valor">${formatarMoeda(venda.valor_pago)}</strong></div>
          <div><span>Saldo</span><strong class="financeiro-duplicata-valor financeiro-duplicata-valor--saldo">${formatarMoeda(venda.saldo_aberto)}</strong></div>
        </div>
        <div class="financeiro-duplicata-venda-acoes">
          <button type="button" class="btn btn-sm btn-outline-primary" data-toggle-venda="${vendaIdAttr}" ${vendaIdAttr ? '' : 'disabled'}>
            Detalhes
          </button>
        </div>
        <div id="duplicataVendaDetalhes-${vendaIdAttr}" class="financeiro-duplicata-venda-detalhes" hidden>
          <div class="financeiro-duplicata-venda-section">
            <h4>Produtos</h4>
            <div class="table-responsive">
              <table class="financeiro-duplicata-mini-tabela">
                <thead>
                  <tr>
                    <th>Produto</th>
                    <th class="financeiro-duplicata-num">Qtd.</th>
                    <th class="financeiro-duplicata-valor">Preço</th>
                    <th class="financeiro-duplicata-valor">Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  ${produtos.length ? produtos.map((prod) => `
                    <tr>
                      <td>${escapeHtmlFinanceiroSafe(prod.nome_produto || '—')}</td>
                      <td class="financeiro-duplicata-num">${escapeHtmlFinanceiroSafe(prod.quantidade)}</td>
                      <td class="financeiro-duplicata-valor">${formatarMoeda(prod.preco_unitario)}</td>
                      <td class="financeiro-duplicata-valor">${formatarMoeda(prod.subtotal)}</td>
                    </tr>
                  `).join('') : '<tr><td colspan="4">Nenhum produto</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
          <div class="financeiro-duplicata-venda-section">
            <h4>Parcelas</h4>
            <div class="table-responsive">
              <table class="financeiro-duplicata-mini-tabela">
                <thead>
                  <tr>
                    <th>Parcela</th>
                    <th>Componente</th>
                    <th class="financeiro-duplicata-valor">Valor</th>
                    <th class="financeiro-duplicata-valor">Restante</th>
                    <th>Vencimento</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${parcelas.length ? parcelas.map((parcela) => `
                    <tr>
                      <td>${escapeHtmlFinanceiroSafe(parcela.parcela)}</td>
                      <td>${parcela.componente === 'outros' ? 'Outros' : 'Produtos'}</td>
                      <td class="financeiro-duplicata-valor">${formatarMoeda(parcela.valor_parcela)}</td>
                      <td class="financeiro-duplicata-valor">${formatarMoeda(parcela.valor_restante)}</td>
                      <td>${formatarData(parcela.vencimento)}</td>
                      <td>${formatarStatusDuplicataBadge(parcela.status)}</td>
                    </tr>
                  `).join('') : '<tr><td colspan="6">Nenhuma parcela</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </article>
    `;
  }).join('');

  conteudo.innerHTML = `
    <section class="financeiro-duplicata financeiro-duplicata--detalhe" aria-labelledby="financeiroDuplicataDetalheTitulo">
      <header class="financeiro-duplicata-cabecalho financeiro-duplicata-cabecalho--detalhe">
        <div>
          <button type="button" class="btn btn-outline-secondary btn-sm" id="btnVoltarDuplicataLista">
            <i class="fas fa-arrow-left" aria-hidden="true"></i> Voltar à lista
          </button>
          <span class="financeiro-duplicata-eyebrow">DUPLICATA DO CLIENTE</span>
          <h2 id="financeiroDuplicataDetalheTitulo">${escapeHtmlFinanceiroSafe(dados.cliente.nome)}</h2>
          <p>${escapeHtmlFinanceiroSafe(dados.empresa_nome || '')}${dados.empresa_nome ? '<br>' : ''}${contato || 'Sem documento/telefone'}${dados.cliente.endereco ? `<br>${escapeHtmlFinanceiroSafe(dados.cliente.endereco)}` : ''}</p>
        </div>
        <div class="financeiro-duplicata-acoes">
          <button type="button" class="btn btn-success" id="btnPagamentoParcialDuplicata" data-cliente-id="${clienteIdAttr}" data-empresa-id="${empresaDuplicataAtualId || ''}" ${clienteIdAttr ? '' : 'disabled'}>
            <i class="fas fa-hand-holding-usd" aria-hidden="true"></i> Pagamento parcial
          </button>
          <button type="button" class="btn btn-primary" id="btnImprimirExtratoDuplicata" data-cliente-id="${clienteIdAttr}" data-empresa-id="${empresaDuplicataAtualId || ''}" ${clienteIdAttr ? '' : 'disabled'}>
            <i class="fas fa-print" aria-hidden="true"></i> Imprimir extrato
          </button>
        </div>
      </header>

      <div class="financeiro-duplicata-resumo" aria-label="Resumo da dívida">
        <div class="financeiro-duplicata-resumo-card">
          <span>Total da dívida</span>
          <strong class="financeiro-duplicata-valor">${formatarMoeda(resumo.totalDivida)}</strong>
        </div>
        <div class="financeiro-duplicata-resumo-card">
          <span>Já pago</span>
          <strong class="financeiro-duplicata-valor">${formatarMoeda(resumo.totalPago)}</strong>
        </div>
        <div class="financeiro-duplicata-resumo-card financeiro-duplicata-resumo-card--destaque">
          <span>Saldo atual</span>
          <strong class="financeiro-duplicata-valor">${formatarMoeda(resumo.saldoAtual)}</strong>
        </div>
        <div class="financeiro-duplicata-resumo-card">
          <span>Vendas em aberto</span>
          <strong>${escapeHtmlFinanceiroSafe(resumo.quantidadeVendas)}</strong>
        </div>
        <div class="financeiro-duplicata-resumo-card">
          <span>Parcelas em aberto</span>
          <strong>${escapeHtmlFinanceiroSafe(resumo.quantidadeTitulos)}</strong>
        </div>
      </div>

      <div class="financeiro-duplicata-venda-list">
        ${vendasHtml || '<div class="financeiro-duplicata-estado financeiro-duplicata-estado--vazio"><div><strong>Nenhuma venda em aberto</strong><p>Este cliente não possui títulos abertos no momento.</p></div></div>'}
      </div>
    </section>
  `;

  document.getElementById('btnVoltarDuplicataLista')?.addEventListener('click', () => {
    renderDuplicataClientes(obterPeriodoFinanceiro());
  });
  document.getElementById('btnPagamentoParcialDuplicata')?.addEventListener('click', (ev) => {
    const id = Number(ev.currentTarget.getAttribute('data-cliente-id'));
    const empresaId = Number(ev.currentTarget.getAttribute('data-empresa-id'));
    if (Number.isInteger(id) && id > 0) abrirPagamentoParcialDuplicata(id, empresaId);
  });
  document.getElementById('btnImprimirExtratoDuplicata')?.addEventListener('click', (ev) => {
    const id = Number(ev.currentTarget.getAttribute('data-cliente-id'));
    const empresaId = Number(ev.currentTarget.getAttribute('data-empresa-id'));
    if (Number.isInteger(id) && id > 0) imprimirExtratoDuplicata(id, empresaId);
  });
  conteudo.querySelectorAll('[data-toggle-venda]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-venda');
      toggleVendaDuplicataDetalhes(id);
    });
  });
}

function toggleVendaDuplicataDetalhes(vendaId) {
  const target = document.getElementById(`duplicataVendaDetalhes-${vendaId}`);
  if (target) {
    target.hidden = !target.hidden;
  }
}

async function imprimirExtratoDuplicata(clienteId, empresaId) {
  try {
    const empresaIdAcao = empresaIdReceberParaAcao(empresaId || empresaDuplicataAtualId);
    const response = await fetch(`/api/financeiro/receber/agrupado/${clienteId}/extrato`, {
      headers: headersReceberDaEmpresa(empresaIdAcao)
    });
    const dados = await response.json();

    if (!dados.success) {
      throw new Error(dados.error || 'Falha ao gerar extrato');
    }

    const html = gerarHtmlExtratoDuplicata(dados);
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Não foi possível abrir a janela de impressão. Verifique o bloqueador de pop-ups.');
      return;
    }

    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  } catch (error) {
    console.error('Erro ao gerar extrato:', error);
    alert('Não foi possível gerar o extrato. Tente novamente.');
  }
}

let modalPagamentoParcialInicializada = false;
let modalConfirmacaoPagamentoParcial = null;
let pagamentoParcialDadosConfirmacao = null;

async function abrirPagamentoParcialDuplicata(clienteId, empresaId) {
  try {
    const empresaIdAcao = empresaIdReceberParaAcao(empresaId || empresaDuplicataAtualId);
    if (!empresaIdAcao) {
      throw new Error('Selecione a empresa proprietária da dívida para continuar.');
    }
    empresaDuplicataAtualId = empresaIdAcao;
    if (!modalPagamentoParcialInicializada) {
      inicializarModalPagamentoParcial();
      modalPagamentoParcialInicializada = true;
    }

    const response = await fetch(`/api/financeiro/receber/agrupado/${clienteId}`, {
      headers: headersReceberDaEmpresa(empresaIdAcao)
    });
    const dados = await response.json();

    if (!dados.success) {
      alert('Não foi possível carregar informações do cliente');
      return;
    }

    const cliente = dados.cliente;
    const saldoAtual = dados.resumo.saldoAtual;

    document.getElementById('modalPagamentoParcialClienteNome').textContent = cliente.nome;
    document.getElementById('modalPagamentoParcialSaldo').textContent = formatarMoeda(saldoAtual);
    
    document.getElementById('formPagamentoParcial').reset();
    document.getElementById('pagamentoParcialData').value = new Date().toISOString().split('T')[0];
    document.getElementById('pagamentoParcialForma').value = 'dinheiro';
    document.getElementById('pagamentoParcialValor').focus();

    document.getElementById('btnConfirmarPagamentoParcial').dataset.clienteId = clienteId;
    document.getElementById('btnConfirmarPagamentoParcial').dataset.empresaId = String(empresaIdAcao);

    const modal = new bootstrap.Modal(document.getElementById('modalPagamentoParcial'));
    modal.show();
  } catch (error) {
    console.error('Erro ao abrir pagamento parcial:', error);
    alert('Erro ao abrir formulário de pagamento');
  }
}

function inicializarModalPagamentoParcial() {
  const btnConfirmar = document.getElementById('btnConfirmarPagamentoParcial');
  const btnConfirmarSim = document.getElementById('btnConfirmacaoPagamentoParcialSim');
  const modalConfirmacaoElement = document.getElementById('modalConfirmacaoPagamentoParcial');

  if (!btnConfirmar || !btnConfirmarSim || !modalConfirmacaoElement) {
    console.warn('Elementos de confirmação de pagamento parcial não encontrados');
    return;
  }

  if (!btnConfirmar.hasAttribute('data-listener-attached')) {
    btnConfirmar.addEventListener('click', confirmarPagamentoParcial);
    btnConfirmar.setAttribute('data-listener-attached', 'true');
  }

  modalConfirmacaoPagamentoParcial = new bootstrap.Modal(modalConfirmacaoElement);

  if (!btnConfirmarSim.hasAttribute('data-listener-attached')) {
    btnConfirmarSim.addEventListener('click', enviarPagamentoParcialConfirmado);
    btnConfirmarSim.setAttribute('data-listener-attached', 'true');
  }
}

function confirmarPagamentoParcial(event) {
  event.preventDefault();
  const btnConfirmar = event.currentTarget;
  const clienteId = btnConfirmar.dataset.clienteId;
  const empresaId = Number(btnConfirmar.dataset.empresaId);
  
  if (!clienteId) {
    alert('Erro: Cliente não identificado');
    return;
  }
  if (!Number.isSafeInteger(empresaId) || empresaId <= 0) {
    alert('Empresa proprietária da dívida não identificada. Reabra os detalhes e tente novamente.');
    return;
  }

  const valor = document.getElementById('pagamentoParcialValor').value.trim();
  const data = document.getElementById('pagamentoParcialData').value;
  const forma = document.getElementById('pagamentoParcialForma').value;
  const observacao = document.getElementById('pagamentoParcialObservacao').value.trim();

  if (!valor || parseFloat(valor) <= 0) {
    alert('Informe um valor válido e maior que zero');
    document.getElementById('pagamentoParcialValor').focus();
    return;
  }

  if (!data) {
    alert('Informe a data do pagamento');
    return;
  }

  pagamentoParcialDadosConfirmacao = {
    clienteId,
    empresaId,
    valor: parseFloat(valor),
    data,
    forma,
    observacao: observacao || 'Pagamento parcial via duplicata agrupada'
  };

  const textoConfirmacao = `Confirmar pagamento de R$ ${pagamentoParcialDadosConfirmacao.valor.toFixed(2)} em ${pagamentoParcialDadosConfirmacao.data}?`;
  document.getElementById('confirmacaoPagamentoParcialTexto').textContent = textoConfirmacao;

  if (modalConfirmacaoPagamentoParcial) {
    modalConfirmacaoPagamentoParcial.show();
  }
}

async function enviarPagamentoParcialConfirmado(event) {
  event.preventDefault();
  const btnConfirmarSim = event.currentTarget;

  if (!pagamentoParcialDadosConfirmacao) {
    alert('Dados de pagamento não encontrados. Tente novamente.');
    return;
  }

  const { clienteId, empresaId, valor, data, forma, observacao } = pagamentoParcialDadosConfirmacao;

  try {
    btnConfirmarSim.disabled = true;
    btnConfirmarSim.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processando...';

    if (modalConfirmacaoPagamentoParcial) {
      modalConfirmacaoPagamentoParcial.hide();
    }

    const response = await fetch(`/api/financeiro/receber/agrupado/${clienteId}/pagamento-parcial`, {
      method: 'POST',
      headers: headersReceberDaEmpresa(empresaId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        valor,
        data_pagamento: data,
        forma_pagamento: forma,
        observacao
      })
    });

    const dados = await response.json();

    if (!dados.success) {
      throw new Error(dados.error || 'Erro ao processar pagamento');
    }

    const modalParcial = bootstrap.Modal.getInstance(document.getElementById('modalPagamentoParcial'));
    if (modalParcial) {
      modalParcial.hide();
    }

    alert('Pagamento parcial registrado com sucesso!');
    abrirDuplicataCliente(clienteId, empresaId);
  } catch (error) {
    console.error('Erro ao confirmar pagamento:', error);
    alert('Não foi possível processar o pagamento: ' + error.message);
  } finally {
    btnConfirmarSim.disabled = false;
    btnConfirmarSim.innerHTML = 'Sim';
    pagamentoParcialDadosConfirmacao = null;
  }
}


function gerarHtmlExtratoDuplicata(dados) {
  const vendas = Array.isArray(dados.vendas) ? dados.vendas : [];
  const vendasHtml = vendas.map((venda) => `
    <tr>
      <td>${escapeHtmlFinanceiroSafe(venda.numero_venda || venda.venda_id)}</td>
      <td>${formatarData(venda.data_venda)}</td>
      <td>${formatarMoeda(venda.valor_total)}</td>
      <td>${formatarMoeda(venda.saldo_aberto)}</td>
      <td>${formatarStatusDuplicataBadge(venda.status)}</td>
    </tr>
  `).join('');

  const empresa = dados.empresa || {};
  const cliente = dados.cliente || {};
  const resumo = dados.resumo || {};

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>Extrato de Duplicata</title>
      <style>
        body { font-family: Arial, sans-serif; color: #2c3e50; margin: 20px; }
        h1, h2, h3, h4, h5 { margin: 0; }
        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .header .empresa { max-width: 60%; }
        .header .cliente { text-align: right; }
        .resumo { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 20px; }
        .resumo-card { padding: 14px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th, td { padding: 10px; border: 1px solid #dfe3e6; }
        th { background: #f1f3f5; text-align: left; }
        .financeiro-duplicata-badge { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 0.85rem; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="empresa">
          <h1>${escapeHtmlFinanceiroSafe(empresa.nome || 'Empresa')}</h1>
          <p>${escapeHtmlFinanceiroSafe(empresa.endereco || '')}</p>
          <p>CNPJ: ${escapeHtmlFinanceiroSafe(formatarCNPJ(empresa.cnpj) || '-')}</p>
          <p>Tel: ${escapeHtmlFinanceiroSafe(empresa.telefone || '-')}</p>
        </div>
        <div class="cliente">
          <h2>Extrato de Dívida</h2>
          <p>${escapeHtmlFinanceiroSafe(cliente.nome || '')}</p>
          <p>${escapeHtmlFinanceiroSafe(formatarCPF(cliente.cpf) || '')}</p>
          <p>${escapeHtmlFinanceiroSafe(cliente.telefone || '')}</p>
          <p>${escapeHtmlFinanceiroSafe(cliente.endereco || '')}</p>
          <p>Gerado em: ${escapeHtmlFinanceiroSafe(dados.geradoEm || '')}</p>
        </div>
      </div>
      <div class="resumo">
        <div class="resumo-card"><strong>Total da Dívida</strong><div>${formatarMoeda(resumo.totalDivida)}</div></div>
        <div class="resumo-card"><strong>Total Pago</strong><div>${formatarMoeda(resumo.totalPago)}</div></div>
        <div class="resumo-card"><strong>Saldo Atual</strong><div>${formatarMoeda(resumo.saldoAtual)}</div></div>
        <div class="resumo-card"><strong>Vendas</strong><div>${escapeHtmlFinanceiroSafe(resumo.quantidadeVendas)}</div></div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Venda</th>
            <th>Emissão</th>
            <th>Valor Total</th>
            <th>Saldo</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${vendasHtml}
        </tbody>
      </table>
      <p>Este extrato apresenta as informações de dívida agrupadas por cliente e as vendas em aberto.</p>
    </body>
    </html>
  `;
}

function formatarStatusBadge(status) {
  const map = {
    aberto: '<span class="status-badge" style="background:#ffe8cc;color:#a56300;">Em aberto</span>',
    vencido: '<span class="status-badge" style="background:#f8d7da;color:#721c24;">Vencido</span>',
    parcial: '<span class="status-badge" style="background:#d1ecf1;color:#0c5460;">Parcial</span>',
    recebido: '<span class="status-badge" style="background:#d4edda;color:#155724;">Recebido</span>',
    pago: '<span class="status-badge" style="background:#d4edda;color:#155724;">Pago</span>'
  };
  return map[status] || `<span class="status-badge" style="background:#e2e3e5;color:#383d41;">${status}</span>`;
}

function idContaReceberSeguro(valor) {
  if (typeof valor === 'number') {
    return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
  }
  if (typeof valor === 'string' && /^\d+$/.test(valor)) {
    const n = Number(valor);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function mensagemSeguraApiReceber(texto) {
  const bruto = String(texto == null ? '' : texto).trim();
  if (!bruto) return '';
  if (/[<>]|javascript:|stack|sqlite|SELECT\s|INSERT\s|UPDATE\s|Bearer\s|token|C:\\|\/backend\//i.test(bruto)) {
    return '';
  }
  if (bruto.length > 240) return bruto.slice(0, 240);
  return bruto;
}

function mensagemErroHttpContasReceber(response, dados) {
  const status = response && response.status;
  const detalhe = mensagemSeguraApiReceber(
    (dados && (dados.error || dados.erro || dados.message)) || ''
  );
  if (status === 401) {
    return 'Sessão expirada. Faça login novamente.';
  }
  if (status === 403) {
    return detalhe || 'Sem permissão para consultar contas a receber.';
  }
  if (status === 400) {
    if (detalhe) return detalhe;
    if (typeof financeiroMensagemEmpresaObrigatoria === 'function') {
      return financeiroMensagemEmpresaObrigatoria();
    }
    return 'Selecione a empresa no seletor da barra lateral para continuar.';
  }
  if (status >= 500) {
    return detalhe || 'Não foi possível carregar as contas a receber. Tente novamente.';
  }
  return detalhe || 'Não foi possível carregar as contas a receber.';
}

function obterCorpoTabelaContasReceber() {
  return document.getElementById('contasReceberTabelaBody')
    || document.querySelector('#tabelaReceber tbody');
}

function obterWrapTabelaContasReceber() {
  return document.getElementById('contasReceberTabelaWrap')
    || document.querySelector('.financeiro-tabela--receber');
}

function mostrarErroTabelaContasReceber(mensagem) {
  const tbody = obterCorpoTabelaContasReceber();
  const tabelaWrapper = obterWrapTabelaContasReceber();
  const estadoVazio = document.getElementById('contasReceberEstadoVazio');
  if (tabelaWrapper) tabelaWrapper.hidden = false;
  if (estadoVazio) estadoVazio.hidden = true;
  if (!tbody) return;

  const linha = document.createElement('tr');
  const celula = document.createElement('td');
  celula.colSpan = 10;
  celula.className = 'text-center text-danger';
  celula.setAttribute('role', 'alert');
  celula.textContent = String(mensagem || 'Não foi possível carregar as contas a receber.');
  linha.appendChild(celula);
  if (typeof tbody.replaceChildren === 'function') {
    tbody.replaceChildren(linha);
  } else {
    tbody.innerHTML = '';
    tbody.appendChild(linha);
  }
}

function criarCelulaTextoReceber(valor, classe) {
  const celula = document.createElement('td');
  if (classe) celula.className = classe;
  celula.textContent = valor == null || valor === '' ? '—' : String(valor);
  return celula;
}

function classeStatusContaReceber(status) {
  const mapa = {
    aberto: 'status-aberto',
    vencido: 'status-vencido',
    parcial: 'status-parcial',
    recebido: 'status-recebido',
    pago: 'status-pago',
    cancelado: 'status-cancelado',
    cancelada: 'status-cancelado'
  };
  const chave = String(status || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(mapa, chave) ? mapa[chave] : 'status-outro';
}

function criarBotaoAcaoReceber(acao, rotulo, classeBtn, icone) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = classeBtn;
  btn.title = rotulo;
  btn.setAttribute('aria-label', rotulo);
  btn.setAttribute('data-acao-receber', acao);
  const iconeEl = document.createElement('i');
  iconeEl.className = icone;
  iconeEl.setAttribute('aria-hidden', 'true');
  btn.appendChild(iconeEl);
  return btn;
}

function normalizarFonteReceber(fonte) {
  return fonte === 'contas_receber' ? 'contas_receber' : 'financeiro';
}

function ligarAcoesTabelaContasReceber(tbody) {
  if (!tbody || typeof tbody.querySelectorAll !== 'function') return;
  tbody.querySelectorAll('[data-acao-receber]').forEach((btn) => {
    const acao = btn.getAttribute('data-acao-receber');
    const id = idContaReceberSeguro(btn.getAttribute('data-id'));
    const fonte = normalizarFonteReceber(btn.getAttribute('data-fonte'));
    const chave = btn.getAttribute('data-chave') || `${fonte}:${id}`;
    const empresaId = btn.getAttribute('data-empresa-id');
    if (!id) return;
    btn.addEventListener('click', () => {
      if (acao === 'baixar') baixarRecebimentoPorFonte(id, fonte, chave, empresaId);
      else if (acao === 'detalhes') abrirDetalhesReceberPorFonte(id, fonte, chave, empresaId);
      else if (acao === 'editar' && fonte === 'financeiro') editarContaReceber(id);
      else if (acao === 'renegociar' && fonte === 'financeiro') renegociarContaReceber(id);
      else if (acao === 'cancelar' && fonte === 'financeiro') cancelarContaReceber(id);
      else if (fonte === 'contas_receber' && (acao === 'editar' || acao === 'renegociar' || acao === 'cancelar')) {
        alert('Esta ação não está disponível para títulos canônicos nesta lista. Use Dívidas por Cliente quando aplicável.');
      }
    });
  });
}

async function carregarContasReceber(filtros) {
  try {
    const queryString = new URLSearchParams(filtros || {}).toString();
    const endpoint = typeof financeiroEscopoTodasEmpresas === 'function' && financeiroEscopoTodasEmpresas()
      ? '/api/financeiro/multiempresa/receber'
      : '/api/financeiro/receber';
    const response = await fetch(`${endpoint}?${queryString}`, {
      headers: __headersFin()
    });
    const dados = await response.json().catch(() => ({}));

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      mostrarErroTabelaContasReceber(mensagemErroHttpContasReceber(response, dados));
      return;
    }

    if (!response.ok) {
      mostrarErroTabelaContasReceber(mensagemErroHttpContasReceber(response, dados));
      return;
    }

    if (!dados || dados.success !== true || !Array.isArray(dados.contas)) {
      mostrarErroTabelaContasReceber('A resposta de contas a receber está fora do formato esperado.');
      return;
    }

    preencherTabelaContasReceber(dados.contas);
  } catch (error) {
    console.error('Erro ao carregar contas a receber:', error);
    const detalhe = mensagemSeguraApiReceber(error && error.message);
    mostrarErroTabelaContasReceber(
      detalhe || 'Não foi possível carregar as contas a receber. Verifique a conexão e tente novamente.'
    );
  }
}

function rotuloFonteReceber(fonte) {
  return fonte === 'contas_receber' ? 'canônico' : 'legado';
}

function preencherTabelaContasReceber(contas) {
  const tbody = obterCorpoTabelaContasReceber();
  const tabelaWrapper = obterWrapTabelaContasReceber();
  const estadoVazio = document.getElementById('contasReceberEstadoVazio');
  if (!tbody) return;

  cacheListaContasReceber = Object.create(null);

  if (Array.isArray(contas) && contas.length > 0) {
    if (tabelaWrapper) tabelaWrapper.hidden = false;
    if (estadoVazio) estadoVazio.hidden = true;

    const linhas = contas.map((conta) => {
      const linha = document.createElement('tr');
      const idSeguro = idContaReceberSeguro(conta && conta.id);
      const fonte = normalizarFonteReceber(conta && conta.fonte);
      const chave = (conta && conta.chave) || `${fonte}:${idSeguro || ''}`;
      if (chave) cacheListaContasReceber[chave] = conta;

      linha.appendChild(criarCelulaTextoReceber((conta && conta.cliente) || '—'));
      const empresaId = (conta && conta.empresa_id) || (
        typeof financeiroEscopoEmpresa !== 'undefined' && financeiroEscopoEmpresa !== 'todas'
          ? financeiroEscopoEmpresa
          : null
      );
      const empresaNome = (conta && conta.empresa_nome) || nomeEmpresaFinanceiro(empresaId);
      linha.appendChild(criarCelulaTextoReceber(empresaNome || '—'));
      linha.appendChild(criarCelulaTextoReceber((conta && conta.descricao) || '—'));
      linha.appendChild(criarCelulaTextoReceber((conta && conta.documento) || '—'));
      linha.appendChild(criarCelulaTextoReceber(
        formatarData(conta && conta.dataVencimento),
        'text-nowrap'
      ));
      linha.appendChild(criarCelulaTextoReceber(
        formatarMoeda(conta && conta.valor),
        'text-end financeiro-valor'
      ));

      const parcelaTxt = [
        (conta && conta.numero_parcela) != null && conta.numero_parcela !== '' ? String(conta.numero_parcela) : '—',
        (conta && conta.total_parcelas) != null && conta.total_parcelas !== '' ? String(conta.total_parcelas) : '—'
      ].join(' / ');
      linha.appendChild(criarCelulaTextoReceber(parcelaTxt, 'text-center text-nowrap'));

      const celulaStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = classeStatusContaReceber(conta && conta.status);
      badge.textContent = (conta && conta.status) ? String(conta.status) : '—';
      celulaStatus.appendChild(badge);
      linha.appendChild(celulaStatus);

      const origemTxt = (conta && conta.origem) || 'manual';
      linha.appendChild(criarCelulaTextoReceber(
        `${origemTxt} · ${rotuloFonteReceber(fonte)}`
      ));

      const celulaAcoes = document.createElement('td');
      const grupo = document.createElement('div');
      grupo.className = 'financeiro-acoes-linha';
      const acoesPermitidas = Array.isArray(conta && conta.acoes_disponiveis) && conta.acoes_disponiveis.length
        ? conta.acoes_disponiveis
        : (fonte === 'contas_receber'
          ? ['detalhes']
          : ['baixar', 'detalhes', 'editar', 'renegociar', 'cancelar']);
      if (idSeguro != null) {
        const catalogo = {
          baixar: ['baixar', 'Baixar conta', 'btn btn-sm btn-outline-success', 'fas fa-check'],
          detalhes: ['detalhes', 'Ver detalhes', 'btn btn-sm btn-outline-info', 'fas fa-eye'],
          editar: ['editar', 'Editar conta', 'btn btn-sm btn-outline-primary', 'fas fa-edit'],
          renegociar: ['renegociar', 'Renegociar conta', 'btn btn-sm btn-outline-warning', 'fas fa-handshake'],
          cancelar: ['cancelar', 'Cancelar conta', 'btn btn-sm btn-outline-danger', 'fas fa-times']
        };
        acoesPermitidas.forEach((nome) => {
          const def = catalogo[nome];
          if (!def) return;
          const btn = criarBotaoAcaoReceber(def[0], def[1], def[2], def[3]);
          btn.setAttribute('data-id', String(idSeguro));
          btn.setAttribute('data-fonte', fonte);
          btn.setAttribute('data-chave', chave);
          if (conta && conta.empresa_id != null) {
            btn.setAttribute('data-empresa-id', String(conta.empresa_id));
          }
          grupo.appendChild(btn);
        });
      }
      celulaAcoes.appendChild(grupo);
      linha.appendChild(celulaAcoes);
      return linha;
    });

    if (typeof tbody.replaceChildren === 'function') {
      tbody.replaceChildren(...linhas);
    } else {
      tbody.innerHTML = '';
      linhas.forEach((linha) => tbody.appendChild(linha));
    }
    ligarAcoesTabelaContasReceber(tbody);
  } else {
    if (typeof tbody.replaceChildren === 'function') {
      tbody.replaceChildren();
    } else {
      tbody.innerHTML = '';
    }
    if (tabelaWrapper) tabelaWrapper.hidden = true;
    if (estadoVazio) estadoVazio.hidden = false;
  }
}

function limparFiltrosReceber() {
  const periodo = obterPeriodoFinanceiro();
  document.getElementById('filtroClienteReceber').value = '';
  document.getElementById('filtroStatusReceber').value = 'todas';
  document.getElementById('filtroDocumentoReceber').value = '';
  document.getElementById('filtroDataInicioReceber').value = periodo.dataInicio;
  document.getElementById('filtroDataFimReceber').value = periodo.dataFim;
  const filtrosAvancados = document.querySelector('.financeiro-filtros-avancados');
  if (filtrosAvancados) filtrosAvancados.open = false;
  carregarContasReceber(coletarFiltrosReceber(periodo));
}

function coletarFiltrosReceber(periodo) {
  return {
    cliente: document.getElementById('filtroClienteReceber').value.trim(),
    status: document.getElementById('filtroStatusReceber').value,
    documento: document.getElementById('filtroDocumentoReceber').value.trim(),
    dataInicio: document.getElementById('filtroDataInicioReceber').value || periodo.dataInicio,
    dataFim: document.getElementById('filtroDataFimReceber').value || periodo.dataFim
  };
}

function filtrarReceber() {
  const filtros = coletarFiltrosReceber(obterPeriodoFinanceiro());
  carregarContasReceber(filtros);
}

async function baixarRecebimento(id) {
  return baixarRecebimentoPorFonte(id, 'financeiro');
}

async function baixarRecebimentoPorFonte(id, fonte, chave, empresaId) {
  const fonteNorm = normalizarFonteReceber(fonte);
  if (!confirm('Tem certeza que deseja baixar este recebimento?')) return;

  try {
    let response;
    const conta = (chave && cacheListaContasReceber[chave]) || null;
    const empresaIdAcao = empresaIdReceberParaAcao(empresaId, conta);
    if (fonteNorm === 'contas_receber') {
      const valorPago = conta && Number(conta.valor) > 0 ? Number(conta.valor) : null;
      if (valorPago == null) {
        alert('Não foi possível determinar o saldo restante do título canônico.');
        return;
      }
      if (conta && conta.status_persistido && conta.status_persistido !== 'aberto') {
        alert('Pagamento parcial de título canônico deve ser feito em Dívidas por Cliente.');
        return;
      }
      response = await fetch(`/api/contas-receber/pagar/${id}`, {
        method: 'POST',
        headers: headersReceberDaEmpresa(empresaIdAcao, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          valor_pago: valorPago,
          data_pagamento: new Date().toISOString().slice(0, 10)
        })
      });
    } else {
      response = await fetch(`/api/financeiro/receber/${id}/baixar`, {
        method: 'POST',
        headers: headersReceberDaEmpresa(empresaIdAcao, { 'Content-Type': 'application/json' })
      });
    }

    const dados = await response.json().catch(() => ({}));

    if (!response.ok) {
      alert('Erro ao baixar recebimento: ' + (dados.error || dados.message || 'Erro desconhecido'));
      return;
    }

    if (fonteNorm === 'financeiro' && !dados.success) {
      alert('Erro ao baixar recebimento: ' + (dados.error || 'Erro desconhecido'));
      return;
    }

    alert('Recebimento baixado com sucesso!');
    const periodo = obterPeriodoFinanceiro();
    carregarContasReceber(coletarFiltrosReceber(periodo));
    if (typeof carregarDashboardFinanceiro === 'function') {
      carregarDashboardFinanceiro(obterPeriodoFinanceiro());
    }
  } catch (error) {
    console.error('Erro ao baixar recebimento:', error);
    alert('Erro ao baixar recebimento');
  }
}

function editarContaReceber(id) {
  // Implementar edição
  alert(`Editar conta a receber ${id} - Em desenvolvimento`);
}

function inicializarModalDetalhesRecebimento() {
  if (!modalDetalhesRecebimento) {
    const modalElement = document.getElementById('modalDetalhesFinanceiro');
    if (modalElement) {
      modalDetalhesRecebimento = new bootstrap.Modal(modalElement);
    }
  }
}

function abrirDetalhesReceber(id) {
  return abrirDetalhesReceberPorFonte(id, 'financeiro');
}

function abrirDetalhesReceberPorFonte(id, fonte, chave, empresaId) {
  const fonteNorm = normalizarFonteReceber(fonte);
  inicializarModalDetalhesRecebimento();

  const body = document.getElementById('modalDetalhesFinanceiroBody');
  const title = document.getElementById('modalDetalhesFinanceiroLabel');

  if (!body || !title) {
    alert('Modal de detalhes não encontrado.');
    return;
  }

  title.textContent = fonteNorm === 'contas_receber'
    ? 'Detalhes do título canônico'
    : 'Detalhes do Recebimento';

  if (fonteNorm === 'contas_receber') {
    const conta = (chave && cacheListaContasReceber[chave]) || null;
    if (!conta) {
      alert('Detalhes do título canônico indisponíveis nesta sessão. Recarregue a lista.');
      return;
    }
    body.replaceChildren();
    const dl = document.createElement('div');
    dl.className = 'row g-2';
    const campos = [
      ['Fonte', 'contas_receber'],
      ['Empresa', conta.empresa_nome || nomeEmpresaFinanceiro(conta.empresa_id) || '—'],
      ['Cliente', conta.cliente || '—'],
      ['Descrição', conta.descricao || '—'],
      ['Documento', conta.documento || '—'],
      ['Vencimento', formatarData(conta.dataVencimento)],
      ['Saldo', formatarMoeda(conta.valor)],
      ['Parcela original', formatarMoeda(conta.valor_parcela)],
      ['Status', conta.status || '—'],
      ['Venda', conta.venda_id != null ? String(conta.venda_id) : '—'],
      ['Componente', conta.componente || '—']
    ];
    campos.forEach(([rotulo, valor]) => {
      const col = document.createElement('div');
      col.className = 'col-12 col-md-6';
      const strong = document.createElement('strong');
      strong.textContent = `${rotulo}: `;
      col.appendChild(strong);
      col.appendChild(document.createTextNode(String(valor)));
      dl.appendChild(col);
    });
    body.appendChild(dl);
    if (modalDetalhesRecebimento) modalDetalhesRecebimento.show();
    return;
  }

  body.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'text-center text-muted';
  loading.textContent = 'Carregando detalhes...';
  body.appendChild(loading);

  if (modalDetalhesRecebimento) {
    modalDetalhesRecebimento.show();
  }

  fetch(`/api/financeiro/${id}`, {
    headers: headersReceberDaEmpresa(empresaIdReceberParaAcao(
      empresaId,
      (chave && cacheListaContasReceber[chave]) || null
    ))
  })
    .then(response => response.json())
    .then(dados => {
      if (!dados || dados.error) {
        throw new Error(dados.error || 'Falha ao carregar detalhes do recebimento.');
      }

      const adminAcoes = podeAdministrarFinanceiro() ? `
        <hr>
        <div class="d-flex gap-2 justify-content-end flex-wrap">
          <button class="btn btn-primary" onclick="abrirEdicaoReceber(${dados.id}, ${Number(dados.empresa_id) || Number(empresaId) || 0})">
            <i class="fas fa-edit"></i> Editar
          </button>
          <button class="btn btn-danger" onclick="excluirContaReceber(${dados.id}, ${Number(dados.empresa_id) || Number(empresaId) || 0})">
            <i class="fas fa-trash"></i> Excluir
          </button>
        </div>
      ` : '';

      body.innerHTML = `
        <div class="row g-3">
          <div class="col-12 col-md-6"><strong>Cliente:</strong> ${escapeHtmlFinanceiroSafe(dados.pessoa_nome || '-')}</div>
          <div class="col-12 col-md-6"><strong>Empresa:</strong> ${escapeHtmlFinanceiroSafe(nomeEmpresaFinanceiro(dados.empresa_id) || nomeEmpresaFinanceiro(empresaId) || '')}</div>
          <div class="col-12 col-md-6"><strong>Documento:</strong> ${escapeHtmlFinanceiroSafe(dados.documento || '-')}</div>
          <div class="col-12 col-md-6"><strong>Valor:</strong> ${formatarMoeda(Number(dados.valor || 0))}</div>
          <div class="col-12 col-md-6"><strong>Data Movimento:</strong> ${dados.data_movimento ? formatarData(dados.data_movimento) : '-'}</div>
          <div class="col-12 col-md-6"><strong>Vencimento:</strong> ${dados.vencimento ? formatarData(dados.vencimento) : '-'}</div>
          <div class="col-12 col-md-6"><strong>Status:</strong> ${formatarStatusBadge(dados.status)}</div>
          <div class="col-12 col-md-6"><strong>Origem:</strong> ${escapeHtmlFinanceiroSafe(dados.origem || 'manual')}</div>
          <div class="col-12 col-md-6"><strong>Parcela:</strong> ${dados.numero_parcela || '-'} / ${dados.total_parcelas || '-'}</div>
          <div class="col-12">
            <strong>Descrição:</strong>
            <p class="mb-1">${escapeHtmlFinanceiroSafe(dados.descricao || '-')}</p>
          </div>
          <div class="col-12">
            <strong>Observação:</strong>
            <p class="mb-0">${escapeHtmlFinanceiroSafe(dados.observacao || '-')}</p>
          </div>
        </div>
        ${adminAcoes}
      `;
    })
    .catch(error => {
      console.error('Erro ao carregar detalhes do recebimento:', error);
      body.innerHTML = `<div class="text-danger">Não foi possível carregar os detalhes. ${escapeHtmlFinanceiroSafe(error.message || '')}</div>`;
    });
}

async function abrirEdicaoReceber(id, empresaId) {
  const body = document.getElementById('modalDetalhesFinanceiroBody');
  if (!body) return;

  body.innerHTML = '<div class="text-center text-muted">Carregando dados para edição...</div>';

  try {
    const empresaIdAcao = empresaIdReceberParaAcao(empresaId);
    const response = await fetch(`/api/financeiro/${id}`, {
      headers: headersReceberDaEmpresa(empresaIdAcao)
    });

    const dados = await response.json();

    if (!response.ok || dados.error) {
      throw new Error(dados.error || 'Erro ao carregar recebimento para edição.');
    }

    body.innerHTML = `
      <form id="formEditarReceber" class="row g-3">
        <div class="col-md-8">
          <label class="form-label">Descrição</label>
          <input type="text" class="form-control" id="editarReceberDescricao" value="${escapeHtmlFinanceiroSafe(dados.descricao || '')}" required>
        </div>

        <div class="col-md-4">
          <label class="form-label">Valor</label>
          <input type="number" class="form-control" id="editarReceberValor" value="${Number(dados.valor || 0)}" min="0.01" step="0.01" required>
        </div>

        <div class="col-md-4">
          <label class="form-label">Data Movimento</label>
          <input type="date" class="form-control" id="editarReceberData" value="${dados.data_movimento || ''}" required>
        </div>

        <div class="col-md-4">
          <label class="form-label">Vencimento</label>
          <input type="date" class="form-control" id="editarReceberVencimento" value="${dados.vencimento || ''}">
        </div>

        <div class="col-md-4">
          <label class="form-label">Status</label>
          <select class="form-control" id="editarReceberStatus">
            <option value="pendente" ${dados.status === 'pendente' ? 'selected' : ''}>Pendente</option>
            <option value="recebido" ${dados.status === 'recebido' ? 'selected' : ''}>Recebido</option>
            <option value="pago" ${dados.status === 'pago' ? 'selected' : ''}>Pago</option>
            <option value="parcial" ${dados.status === 'parcial' ? 'selected' : ''}>Parcial</option>
            <option value="vencido" ${dados.status === 'vencido' ? 'selected' : ''}>Vencido</option>
          </select>
        </div>

        <div class="col-md-6">
          <label class="form-label">Cliente</label>
          <input type="text" class="form-control" id="editarReceberPessoa" value="${escapeHtmlFinanceiroSafe(dados.pessoa_nome || '')}">
        </div>

        <div class="col-md-6">
          <label class="form-label">Documento</label>
          <input type="text" class="form-control" id="editarReceberDocumento" value="${escapeHtmlFinanceiroSafe(dados.documento || '')}">
        </div>

        <div class="col-md-6">
          <label class="form-label">Categoria</label>
          <input type="text" class="form-control" id="editarReceberCategoria" value="${escapeHtmlFinanceiroSafe(dados.categoria || '')}">
        </div>

        <div class="col-md-6">
          <label class="form-label">Forma de pagamento</label>
          <input type="text" class="form-control" id="editarReceberForma" value="${escapeHtmlFinanceiroSafe(dados.forma_pagamento || '')}">
        </div>

        <div class="col-12">
          <label class="form-label">Observação</label>
          <textarea class="form-control" id="editarReceberObservacao" rows="3">${escapeHtmlFinanceiroSafe(dados.observacao || '')}</textarea>
        </div>

        <div class="col-12 d-flex gap-2 justify-content-end flex-wrap">
          <button type="button" class="btn btn-secondary" onclick="abrirDetalhesReceberPorFonte(${id}, 'financeiro', null, ${empresaIdAcao})">Cancelar</button>
          <button type="submit" class="btn btn-primary">Salvar Alterações</button>
        </div>
      </form>
    `;

    const form = document.getElementById('formEditarReceber');
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      await salvarEdicaoReceber(id, empresaIdAcao);
    });
  } catch (error) {
    console.error('Erro ao abrir edição do recebimento:', error);
    body.innerHTML = `<div class="text-danger">Erro ao carregar formulário de edição. ${escapeHtmlFinanceiroSafe(error.message || '')}</div>`;
  }
}

async function salvarEdicaoReceber(id, empresaId) {
  try {
    const empresaIdAcao = empresaIdReceberParaAcao(empresaId);
    const payload = {
      descricao: document.getElementById('editarReceberDescricao')?.value?.trim() || '',
      valor: Number(document.getElementById('editarReceberValor')?.value || 0),
      data_movimento: document.getElementById('editarReceberData')?.value || '',
      vencimento: document.getElementById('editarReceberVencimento')?.value || '',
      status: document.getElementById('editarReceberStatus')?.value || 'pendente',
      pessoa_nome: document.getElementById('editarReceberPessoa')?.value?.trim() || '',
      documento: document.getElementById('editarReceberDocumento')?.value?.trim() || '',
      categoria: document.getElementById('editarReceberCategoria')?.value?.trim() || '',
      forma_pagamento: document.getElementById('editarReceberForma')?.value?.trim() || '',
      observacao: document.getElementById('editarReceberObservacao')?.value?.trim() || ''
    };

    if (!payload.descricao || payload.valor <= 0 || !payload.data_movimento) {
      alert('Preencha descrição, valor e data do movimento.');
      return;
    }

    const response = await fetch(`/api/financeiro/${id}`, {
      method: 'PUT',
      headers: headersReceberDaEmpresa(empresaIdAcao, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });

    const dados = await response.json();

    if (!response.ok || dados.error) {
      throw new Error(dados.error || 'Erro ao salvar alterações.');
    }

    alert('Recebimento atualizado com sucesso.');

    const periodo = obterPeriodoFinanceiro();
    carregarContasReceber(coletarFiltrosReceber(periodo));

    if (typeof carregarDashboardFinanceiro === 'function') {
      carregarDashboardFinanceiro(periodo);
    }

    if (typeof carregarHistoricoFinanceiro === 'function') {
      carregarHistoricoFinanceiro(periodo);
    }

    abrirDetalhesReceberPorFonte(id, 'financeiro', null, empresaIdAcao);
  } catch (error) {
    console.error('Erro ao salvar edição do recebimento:', error);
    alert(error.message || 'Erro ao salvar alterações.');
  }
}

function renegociarContaReceber(id) {
  // Implementar renegociação
  alert(`Renegociar conta a receber ${id} - Em desenvolvimento`);
}

async function excluirContaReceber(id, empresaId) {
  if (!confirm('Tem certeza que deseja excluir este recebimento?')) return;

  try {
    const empresaIdAcao = empresaIdReceberParaAcao(empresaId);
    const response = await fetch(`/api/financeiro/${id}`, {
      method: 'DELETE',
      headers: headersReceberDaEmpresa(empresaIdAcao)
    });

    const dados = await response.json();

    if (!response.ok || dados.error) {
      throw new Error(dados.error || 'Erro ao excluir recebimento.');
    }

    alert('Recebimento excluído com sucesso.');

    if (modalDetalhesRecebimento) {
      modalDetalhesRecebimento.hide();
    }

    const periodo = obterPeriodoFinanceiro();
    carregarContasReceber(coletarFiltrosReceber(periodo));

    if (typeof carregarDashboardFinanceiro === 'function') {
      carregarDashboardFinanceiro(periodo);
    }

    if (typeof carregarHistoricoFinanceiro === 'function') {
      carregarHistoricoFinanceiro(periodo);
    }
  } catch (error) {
    console.error('Erro ao excluir recebimento:', error);
    alert(error.message || 'Erro ao excluir recebimento.');
  }
}

function novoRecebimento() {
  // Implementar modal ou navegação para novo recebimento
  alert('Nova conta a receber - Em desenvolvimento');
}

function exportarReceber(tipo) {
  // Implementar exportação
  alert(`Exportação ${tipo.toUpperCase()} em desenvolvimento`);
}

function formatarData(data) {
  if (data == null || data === '') return '—';
  const s = String(data).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const d = new Date(data);
  if (Number.isNaN(d.getTime())) return escapeHtmlFinanceiroSafe(s);
  return d.toLocaleDateString('pt-BR');
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(valor);
}

window.abrirEdicaoReceber = abrirEdicaoReceber;
window.salvarEdicaoReceber = salvarEdicaoReceber;
window.excluirContaReceber = excluirContaReceber;