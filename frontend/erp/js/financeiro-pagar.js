window.__financeiroPagarState = window.__financeiroPagarState || {
  modalNovaDespesaInstance: null,
  modalDetalhesPagamento: null,
  modalPagamentoInstance: null,
  contaPagamentoAtual: null,
  pagamentoIdempotencyKey: null,
  criacaoIdempotencyKey: null,
  cancelamentoIdempotencyKeys: {}
};

// Contas a Pagar
function renderContasPagar(periodo) {
  const conteudo = document.getElementById('financeiroConteudo');

  if (!conteudo) return;

  conteudo.innerHTML = `
    <div class="financeiro-filtros">
      <div class="financeiro-filtro-grupo">
        <label for="filtroStatusPagar">Status:</label>
        <select id="filtroStatusPagar" class="form-control">
          <option value="todos">Todos</option>
          <option value="aberto">Aberto</option>
          <option value="parcial">Parcial</option>
          <option value="quitada">Quitada</option>
          <option value="vencido">Vencido</option>
          <option value="cancelada">Cancelada</option>
        </select>
      </div>

      <div class="financeiro-filtro-grupo">
        <label for="filtroFornecedorPagar">Fornecedor:</label>
        <input
          type="text"
          id="filtroFornecedorPagar"
          class="form-control"
          placeholder="Nome, CPF ou CNPJ do fornecedor"
        />
      </div>

      <div class="financeiro-acoes">
        <button class="btn btn-danger" onclick="novaDespesa()">
          <i class="fas fa-plus"></i> Nova Despesa
        </button>
        <button class="btn btn-success" onclick="exportarPagar()">
          <i class="fas fa-download"></i> Exportar
        </button>
      </div>
    </div>

    <div class="financeiro-tabela">
      <table id="tabelaPagar">
        <thead>
          <tr>
            <th>Data</th>
            <th>Vencimento</th>
            <th>Fornecedor</th>
            <th>Categoria</th>
            <th>Descrição</th>
            <th>Valor</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colspan="8" class="text-center">Carregando...</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal fade" id="modalNovaDespesa" tabindex="-1" aria-labelledby="modalNovaDespesaLabel" aria-hidden="true">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="modalNovaDespesaLabel">Nova Despesa</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
          </div>
          <form id="formNovaDespesa">
            <div class="modal-body">
              <div class="row g-3">
                <div class="col-md-8">
                  <label class="form-label">Descrição *</label>
                  <input type="text" class="form-control" id="despesaDescricao" required>
                </div>

                <div class="col-md-4">
                  <label class="form-label">Categoria *</label>
                  <select class="form-select" id="despesaCategoria" required>
                    <option value="">Carregando...</option>
                  </select>
                </div>

                <div class="col-md-4">
                  <label class="form-label">Valor *</label>
                  <input type="number" class="form-control" id="despesaValor" min="0.01" step="0.01" required>
                </div>

                <div class="col-md-4">
                  <label class="form-label">Data do lançamento *</label>
                  <input type="date" class="form-control" id="despesaData" required>
                </div>

                <div class="col-md-4">
                  <label class="form-label">Vencimento *</label>
                  <input type="date" class="form-control" id="despesaVencimento" required>
                </div>

                <div class="col-md-12">
                  <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="despesaParcelado">
                    <label class="form-check-label" for="despesaParcelado">
                      Pagamento parcelado
                    </label>
                  </div>
                </div>

                <div class="col-md-3" id="parcelasGroup" style="display: none;">
                  <label class="form-label">Número de parcelas *</label>
                  <input type="number" class="form-control" id="despesaParcelas" min="2" max="60" value="2">
                </div>

                <div class="col-md-3" id="intervaloGroup" style="display: none;">
                  <label class="form-label">Intervalo (dias) *</label>
                  <input type="number" class="form-control" id="despesaIntervalo" min="1" max="365" value="30">
                </div>

                <div class="col-md-6">
                  <label class="form-label">Fornecedor / Favorecido</label>
                  <input type="text" class="form-control" id="despesaFornecedor" placeholder="Opcional">
                </div>

                <div class="col-md-3">
                  <label class="form-label">Forma de pagamento</label>
                  <select class="form-select" id="despesaFormaPagamento">
                    <option value="dinheiro">Dinheiro</option>
                    <option value="pix">PIX</option>
                    <option value="boleto">Boleto</option>
                    <option value="cartao">Cartão</option>
                    <option value="transferencia">Transferência</option>
                    <option value="outro">Outro</option>
                  </select>
                </div>

                <div class="col-12">
                  <label class="form-label">Observação</label>
                  <textarea class="form-control" id="despesaObservacao" rows="3"></textarea>
                </div>
              </div>

              <div id="erroNovaDespesa" class="text-danger mt-3"></div>

              <div id="previaParcelas" class="mt-3"></div>
            </div>

            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="submit" class="btn btn-danger">Salvar Despesa</button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <div class="modal fade" id="modalPagamento" tabindex="-1" aria-labelledby="modalPagamentoLabel" aria-hidden="true">
      <div class="modal-dialog modal-sm">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="modalPagamentoLabel">Pagar Conta</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
          </div>
          <form id="formPagamento">
            <div class="modal-body">
              <div class="row g-3">
                <div class="col-12">
                  <label class="form-label">Valor a Pagar *</label>
                  <input type="number" class="form-control" id="pagamentoValor" min="0.01" step="0.01" required>
                  <small class="text-muted">Valor restante: <span id="pagamentoValorRestante">R$ 0,00</span></small>
                </div>

                <div class="col-12">
                  <label class="form-label">Forma de Pagamento *</label>
                  <select class="form-select" id="pagamentoForma" required>
                    <option value="">Selecione...</option>
                    <option value="dinheiro">Dinheiro</option>
                    <option value="pix">PIX</option>
                    <option value="boleto">Boleto</option>
                    <option value="cartao_credito">Cartão de Crédito</option>
                    <option value="cartao_debito">Cartão de Débito</option>
                    <option value="transferencia">Transferência</option>
                    <option value="cheque">Cheque</option>
                    <option value="outro">Outro</option>
                  </select>
                </div>
              </div>

              <div id="erroPagamento" class="text-danger mt-3"></div>
            </div>

            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="submit" class="btn btn-success">Confirmar Pagamento</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  configurarFiltrosPagar();
  inicializarModalNovaDespesa();
  inicializarModalPagamento();
  carregarContasPagar(coletarFiltrosPagar(periodo));
}

function configurarFiltrosPagar() {
  const statusField = document.getElementById('filtroStatusPagar');
  const fornecedorField = document.getElementById('filtroFornecedorPagar');

  if (statusField) {
    statusField.addEventListener('change', filtrarPagar);
  }

  if (fornecedorField) {
    fornecedorField.addEventListener('input', filtrarPagar);
  }
}

function carregarContasPagar(filtros) {
  carregarContasPagarDados(filtros);
}

async function carregarContasPagarDados(filtros) {
  try {
    const params = new URLSearchParams();
    if (filtros.dataInicio) params.set('dataInicio', filtros.dataInicio);
    if (filtros.dataFim) params.set('dataFim', filtros.dataFim);
    if (filtros.status) params.set('status', filtros.status);
    if (filtros.fornecedor) params.set('fornecedor', filtros.fornecedor);

    const response = await fetch(`/api/contas-pagar?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('token')
      }
    });

    if (response.status === 401) {
      throw new Error('Sessão expirada. Faça login novamente.');
    }

    const dados = await response.json();

    if (!response.ok) {
      throw new Error(dados.error || 'Erro ao carregar contas a pagar');
    }

    const tbody = document.querySelector('#tabelaPagar tbody');
    if (!tbody) return;

    if (dados.success && Array.isArray(dados.contas) && dados.contas.length > 0) {
      tbody.innerHTML = dados.contas.map(conta => {
        const vencida = ['aberto', 'parcial'].includes(conta.status)
          && conta.data_vencimento
          && conta.data_vencimento < new Date().toISOString().slice(0, 10);
        const statusExibicao = vencida ? 'vencido' : conta.status;
        const podePagar = ['aberto', 'parcial'].includes(conta.status);
        return `
        <tr>
          <td>${formatarDataPagar(conta.data_emissao)}</td>
          <td>${formatarDataPagar(conta.data_vencimento)}</td>
          <td>${escapeHtmlFinanceiro(conta.pessoa_nome || conta.fornecedor_nome || '-')}</td>
          <td>${escapeHtmlFinanceiro(conta.categoria || '-')}</td>
          <td>${escapeHtmlFinanceiro(conta.descricao || '')}</td>
          <td class="font-weight-bold">
            ${formatarMoedaPagar(conta.valor_restante)}
            <small class="d-block text-muted">Original: ${formatarMoedaPagar(conta.valor_original)}</small>
          </td>
          <td><span class="status-${statusExibicao}">${escapeHtmlFinanceiro(statusExibicao)}</span></td>
          <td>
            <button class="btn btn-sm btn-outline-primary" onclick="abrirDetalhesPagar(${conta.id})">
              <i class="fas fa-eye"></i>
            </button>
            ${podePagar ? `<button class="btn btn-sm btn-outline-success" onclick="pagarConta(${conta.id})">
              <i class="fas fa-check"></i>
            </button>` : ''}
          </td>
        </tr>
      `}).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">Nenhuma conta a pagar encontrada</td></tr>';
    }
  } catch (error) {
    console.error('Erro ao carregar contas a pagar:', error);
    const tbody = document.querySelector('#tabelaPagar tbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger">Erro ao carregar dados</td></tr>';
    }
  }
}

function filtrarPagar() {
  const periodo = obterPeriodoFinanceiro();
  const filtros = coletarFiltrosPagar(periodo);
  carregarContasPagar(filtros);
}

function inicializarModalNovaDespesa() {
  const modalElement = document.getElementById('modalNovaDespesa');
  const form = document.getElementById('formNovaDespesa');

  if (modalElement && !window.__financeiroPagarState.modalNovaDespesaInstance) {
    window.__financeiroPagarState.modalNovaDespesaInstance = new bootstrap.Modal(modalElement);
  }

  if (form && !form.dataset.bound) {
    form.addEventListener('submit', salvarNovaDespesa);
    form.dataset.bound = 'true';
  }

  // Adicionar toggle para campos de parcelamento
  const checkboxParcelado = document.getElementById('despesaParcelado');
  const parcelasGroup = document.getElementById('parcelasGroup');
  const intervaloGroup = document.getElementById('intervaloGroup');

  if (checkboxParcelado && !checkboxParcelado.dataset.bound) {
    checkboxParcelado.addEventListener('change', function() {
      const isChecked = this.checked;
      if (parcelasGroup) parcelasGroup.style.display = isChecked ? 'block' : 'none';
      if (intervaloGroup) intervaloGroup.style.display = isChecked ? 'block' : 'none';
      if (!isChecked) {
        const parcelasEl = document.getElementById('despesaParcelas');
        const intervaloEl = document.getElementById('despesaIntervalo');
        if (parcelasEl) parcelasEl.value = 2;
        if (intervaloEl) intervaloEl.value = 30;
      }
    });
    checkboxParcelado.dataset.bound = 'true';
  }

  // Adicionar event listeners para atualizar prévia
  const despesaValor = document.getElementById('despesaValor');
  const despesaParcelas = document.getElementById('despesaParcelas');
  const despesaIntervalo = document.getElementById('despesaIntervalo');
  const despesaVencimento = document.getElementById('despesaVencimento');

  if (despesaValor && !despesaValor.dataset.bound) {
    despesaValor.addEventListener('input', atualizarPreviaParcelas);
    despesaValor.dataset.bound = 'true';
  }
  if (despesaParcelas && !despesaParcelas.dataset.bound) {
    despesaParcelas.addEventListener('input', atualizarPreviaParcelas);
    despesaParcelas.dataset.bound = 'true';
  }
  if (despesaIntervalo && !despesaIntervalo.dataset.bound) {
    despesaIntervalo.addEventListener('input', atualizarPreviaParcelas);
    despesaIntervalo.dataset.bound = 'true';
  }
  if (despesaVencimento && !despesaVencimento.dataset.bound) {
    despesaVencimento.addEventListener('input', atualizarPreviaParcelas);
    despesaVencimento.dataset.bound = 'true';
  }
}

async function novaDespesa() {
  if (!window.__financeiroPagarState.modalNovaDespesaInstance) {
    inicializarModalNovaDespesa();
  }

  const descricao = document.getElementById('despesaDescricao');
  const valor = document.getElementById('despesaValor');
  const data = document.getElementById('despesaData');
  const vencimento = document.getElementById('despesaVencimento');
  const fornecedor = document.getElementById('despesaFornecedor');
  const formaPagamento = document.getElementById('despesaFormaPagamento');
  const observacao = document.getElementById('despesaObservacao');
  const erro = document.getElementById('erroNovaDespesa');

  if (descricao) descricao.value = '';
  if (valor) valor.value = '';
  if (data) data.value = new Date().toISOString().slice(0, 10);
  if (vencimento) vencimento.value = new Date().toISOString().slice(0, 10);
  if (fornecedor) fornecedor.value = '';
  if (formaPagamento) formaPagamento.value = 'dinheiro';
  window.__financeiroPagarState.criacaoIdempotencyKey = null;
  if (observacao) observacao.value = '';
  if (erro) erro.innerText = '';

  await carregarCategoriasDespesa();

  if (window.__financeiroPagarState.modalNovaDespesaInstance) {
    window.__financeiroPagarState.modalNovaDespesaInstance.show();
  }
}

async function carregarCategoriasDespesa() {
  try {
    const response = await fetch(`${API_URL}/categorias?tipo=despesa`, {
      headers: {
        'Authorization': 'Bearer ' + localStorage.getItem('token')
      }
    });

    const categorias = await response.json();
    const select = document.getElementById('despesaCategoria');
    if (!select) return;

    if (!Array.isArray(categorias) || !categorias.length) {
      select.innerHTML = '<option value="">Nenhuma categoria de despesa cadastrada</option>';
      return;
    }

    select.innerHTML =
      '<option value="">Selecione</option>' +
      categorias.map(cat => `<option value="${escapeHtmlFinanceiro(cat.nome)}">${escapeHtmlFinanceiro(cat.nome)}</option>`).join('');
  } catch (error) {
    console.error('Erro ao carregar categorias de despesa:', error);
    const select = document.getElementById('despesaCategoria');
    if (select) {
      select.innerHTML = '<option value="">Erro ao carregar categorias</option>';
    }
  }
}

async function salvarNovaDespesa(event) {
  event.preventDefault();

  try {
    const erroEl = document.getElementById('erroNovaDespesa');
    if (erroEl) erroEl.innerText = '';

    const payload = {
      descricao: (document.getElementById('despesaDescricao')?.value || '').trim(),
      categoria: document.getElementById('despesaCategoria')?.value || '',
      valor: Number(document.getElementById('despesaValor')?.value || 0),
      data_emissao: document.getElementById('despesaData')?.value || '',
      data_vencimento: document.getElementById('despesaVencimento')?.value || '',
      pessoa_nome: (document.getElementById('despesaFornecedor')?.value || '').trim() || null,
      forma_pagamento: document.getElementById('despesaFormaPagamento')?.value || 'dinheiro',
      observacao: (document.getElementById('despesaObservacao')?.value || '').trim(),
      origem: 'manual'
    };

    if (!payload.descricao || !payload.categoria || !Number.isFinite(payload.valor) || payload.valor <= 0 || !payload.data_emissao || !payload.data_vencimento) {
      if (erroEl) erroEl.innerText = 'Preencha os campos obrigatórios.';
      return;
    }

    const isParcelado = document.getElementById('despesaParcelado')?.checked || false;
    const numParcelas = isParcelado ? Number(document.getElementById('despesaParcelas')?.value || 2) : 1;
    const intervaloDias = isParcelado ? Number(document.getElementById('despesaIntervalo')?.value || 30) : 0;

    if (
      !Number.isInteger(numParcelas)
      || numParcelas < (isParcelado ? 2 : 1)
      || numParcelas > 60
      || (isParcelado && (!Number.isInteger(intervaloDias) || intervaloDias < 1 || intervaloDias > 365))
    ) {
      if (erroEl) erroEl.innerText = 'Preencha número de parcelas (mín. 2) e intervalo (mín. 1 dia) para parcelamento.';
      return;
    }

    const totalCentavos = Math.round(payload.valor * 100);
    if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0) {
      if (erroEl) erroEl.innerText = 'Informe um valor válido em centavos.';
      return;
    }
    const centavosBase = Math.floor(totalCentavos / numParcelas);
    const parcelas = Array.from({ length: numParcelas }, (_, index) => {
      const vencimento = new Date(`${payload.data_vencimento}T00:00:00Z`);
      vencimento.setUTCDate(vencimento.getUTCDate() + index * intervaloDias);
      const centavos = index === numParcelas - 1
        ? totalCentavos - centavosBase * (numParcelas - 1)
        : centavosBase;
      return {
        descricao: numParcelas > 1
          ? `${payload.descricao} (Parcela ${index + 1}/${numParcelas})`
          : payload.descricao,
        valor_original: centavos / 100,
        data_vencimento: vencimento.toISOString().slice(0, 10)
      };
    });
    if (!window.__financeiroPagarState.criacaoIdempotencyKey) {
      window.__financeiroPagarState.criacaoIdempotencyKey = gerarChaveIdempotenciaPagar();
    }

    const response = await fetch('/api/contas-pagar/lote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('token'),
        'Idempotency-Key': window.__financeiroPagarState.criacaoIdempotencyKey
      },
      body: JSON.stringify({
        ...payload,
        parcelas,
        idempotency_key: window.__financeiroPagarState.criacaoIdempotencyKey
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Erro ao cadastrar despesas.');
    }
    window.__financeiroPagarState.criacaoIdempotencyKey = null;

    if (window.__financeiroPagarState.modalNovaDespesaInstance) {
      window.__financeiroPagarState.modalNovaDespesaInstance.hide();
    }

    if (typeof showNotification === 'function') {
      showNotification('Despesa cadastrada com sucesso.', 'success');
    } else {
      alert('Despesa cadastrada com sucesso.');
    }

    const periodo = obterPeriodoFinanceiro();
    carregarContasPagar(coletarFiltrosPagar(periodo));

    if (typeof carregarDashboardFinanceiro === 'function') {
      carregarDashboardFinanceiro(periodo);
    }

    if (typeof carregarHistoricoFinanceiro === 'function') {
      carregarHistoricoFinanceiro(periodo);
    }
  } catch (error) {
    console.error('Erro ao salvar nova despesa:', error);
    const erroEl = document.getElementById('erroNovaDespesa');
    if (erroEl) erroEl.innerText = error.message || 'Erro ao conectar com o servidor.';
  }
}

function gerarChaveIdempotenciaPagar() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `pagar-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function inicializarModalDetalhesPagamento() {
  if (!window.__financeiroPagarState.modalDetalhesPagamento) {
    const modalElement = document.getElementById('modalDetalhesFinanceiro');
    if (modalElement) {
      window.__financeiroPagarState.modalDetalhesPagamento = new bootstrap.Modal(modalElement);
    }
  }
}

function inicializarModalPagamento() {
  const modalElement = document.getElementById('modalPagamento');
  const form = document.getElementById('formPagamento');

  if (modalElement && !window.__financeiroPagarState.modalPagamentoInstance) {
    window.__financeiroPagarState.modalPagamentoInstance = new bootstrap.Modal(modalElement);
  }

  if (form && !form.dataset.bound) {
    form.addEventListener('submit', processarPagamento);
    form.dataset.bound = 'true';
  }
}

function pagarConta(id) {
  abrirModalPagamento(id);
}

async function abrirModalPagamento(id) {
  try {
    const response = await fetch(`/api/contas-pagar/${id}/detalhes`, {
      headers: {
        'Authorization': 'Bearer ' + localStorage.getItem('token')
      }
    });

    const dados = await response.json();

    if (!response.ok || dados.error || !['aberto', 'parcial'].includes(dados.status)) {
      throw new Error(dados.error || 'Erro ao carregar dados da conta.');
    }

    window.__financeiroPagarState.contaPagamentoAtual = dados;
    window.__financeiroPagarState.pagamentoIdempotencyKey = gerarChaveIdempotenciaPagar();

    const valorInput = document.getElementById('pagamentoValor');
    const valorRestanteSpan = document.getElementById('pagamentoValorRestante');
    const formaPagamentoSelect = document.getElementById('pagamentoForma');
    const erroEl = document.getElementById('erroPagamento');

    if (valorInput) {
      valorInput.value = dados.valor_restante || 0;
    }

    if (valorRestanteSpan) {
      valorRestanteSpan.textContent = formatarMoedaPagar(dados.valor_restante || 0);
    }

    if (formaPagamentoSelect) {
      formaPagamentoSelect.value = dados.forma_pagamento || '';
    }

    if (erroEl) {
      erroEl.innerText = '';
    }

    if (window.__financeiroPagarState.modalPagamentoInstance) {
      window.__financeiroPagarState.modalPagamentoInstance.show();
    }
  } catch (error) {
    console.error('Erro ao abrir modal de pagamento:', error);
    alert('Erro ao carregar dados da conta: ' + error.message);
  }
}

async function processarPagamento(event) {
  event.preventDefault();

  try {
    const erroEl = document.getElementById('erroPagamento');
    if (erroEl) erroEl.innerText = '';

    const valor = Number(document.getElementById('pagamentoValor')?.value || 0);
    const formaPagamento = document.getElementById('pagamentoForma')?.value || '';

    if (valor <= 0) {
      if (erroEl) erroEl.innerText = 'O valor deve ser maior que zero.';
      return;
    }

    if (!formaPagamento) {
      if (erroEl) erroEl.innerText = 'Selecione a forma de pagamento.';
      return;
    }

    const conta = window.__financeiroPagarState.contaPagamentoAtual;
    if (!conta) {
      if (erroEl) erroEl.innerText = 'Dados da conta não encontrados.';
      return;
    }

    const idempotencyKey = window.__financeiroPagarState.pagamentoIdempotencyKey;
    const response = await fetch(`/api/contas-pagar/${conta.id}/baixar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('token'),
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        valor_pago: valor,
        forma_pagamento: formaPagamento,
        idempotency_key: idempotencyKey
      })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Erro ao processar pagamento.');
    }
    window.__financeiroPagarState.pagamentoIdempotencyKey = null;

    if (window.__financeiroPagarState.modalPagamentoInstance) {
      window.__financeiroPagarState.modalPagamentoInstance.hide();
    }

    alert('Pagamento realizado com sucesso!');

    const periodo = obterPeriodoFinanceiro();
    carregarContasPagar(coletarFiltrosPagar(periodo));

    if (typeof carregarDashboardFinanceiro === 'function') {
      carregarDashboardFinanceiro(periodo);
    }
  } catch (error) {
    console.error('Erro ao processar pagamento:', error);
    const erroEl = document.getElementById('erroPagamento');
    if (erroEl) erroEl.innerText = error.message || 'Erro ao processar pagamento.';
  }
}

async function baixarPagamento(id) {
  return pagarConta(id);
}

function abrirDetalhesPagar(id) {
  inicializarModalDetalhesPagamento();

  const body = document.getElementById('modalDetalhesFinanceiroBody');
  const title = document.getElementById('modalDetalhesFinanceiroLabel');

  if (!body || !title) {
    alert('Modal de detalhes não encontrado.');
    return;
  }

  title.textContent = 'Detalhes da Conta a Pagar';
  body.innerHTML = '<div class="text-center text-muted">Carregando detalhes...</div>';

  if (window.__financeiroPagarState.modalDetalhesPagamento) {
    window.__financeiroPagarState.modalDetalhesPagamento.show();
  }

  fetch(`/api/contas-pagar/${id}/detalhes`, {
    headers: {
      'Authorization': 'Bearer ' + localStorage.getItem('token')
    }
  })
    .then(response => response.json())
    .then(dados => {
      if (!dados || dados.error) {
        throw new Error(dados.error || 'Falha ao carregar detalhes da conta a pagar.');
      }

      const adminAcoes = podeAdministrarFinanceiro()
        && ['aberto', 'parcial'].includes(dados.status) ? `
        <hr>
        <div class="d-flex gap-2 justify-content-end flex-wrap">
          <button class="btn btn-warning" onclick="cancelarContaPagar(${dados.id})">
            <i class="fas fa-ban"></i> Cancelar título
          </button>
        </div>
      ` : '';

      const compra = dados.compra || null;
      const itensCompra = dados.itens_compra || [];

      const parcelado = Number(dados.total_parcelas || 1) > 1 ? 'Sim' : 'Não';
      const pagamentos = dados.pagamentos || [];
      const blocoPagamentos = `
        <hr>
        <h6 class="mb-2">Pagamentos registrados</h6>
        <div class="table-responsive">
          <table class="table table-sm table-bordered">
            <thead><tr><th>Data</th><th>Valor</th><th>Forma</th><th>Responsável</th></tr></thead>
            <tbody>
              ${pagamentos.length ? pagamentos.map(pagamento => `
                <tr>
                  <td>${formatarDataPagar(pagamento.data_pagamento)}</td>
                  <td>${formatarMoedaPagar(pagamento.valor_pago)}</td>
                  <td>${escapeHtmlFinanceiro(pagamento.forma_pagamento || '-')}</td>
                  <td>${escapeHtmlFinanceiro(pagamento.usuario_nome || pagamento.usuario_id || '-')}</td>
                </tr>
              `).join('') : '<tr><td colspan="4" class="text-center text-muted">Nenhum pagamento registrado.</td></tr>'}
            </tbody>
          </table>
        </div>
      `;

      const blocoCompra = compra ? `
        <hr>

        <h6 class="mb-3">
          <i class="fas fa-file-invoice"></i> Dados da Compra / Nota Fiscal
        </h6>

        <div class="row g-3">
          <div class="col-12 col-md-4">
            <strong>Nº NF:</strong> ${escapeHtmlFinanceiro(compra.numero_nf || compra.nota_fiscal || '-')}
          </div>

          <div class="col-12 col-md-4">
            <strong>Série:</strong> ${escapeHtmlFinanceiro(compra.serie_nf || '-')}
          </div>

          <div class="col-12 col-md-4">
            <strong>Modelo:</strong> ${escapeHtmlFinanceiro(compra.modelo_nf || '-')}
          </div>

          <div class="col-12 col-md-4">
            <strong>Data da Compra:</strong> ${formatarDataPagar(compra.data_compra)}
          </div>

          <div class="col-12 col-md-4">
            <strong>Data Emissão NF:</strong> ${compra.data_emissao ? formatarDataPagar(compra.data_emissao) : '-'}
          </div>

          <div class="col-12 col-md-4">
            <strong>Data Entrada:</strong> ${compra.data_entrada ? formatarDataPagar(compra.data_entrada) : '-'}
          </div>

          <div class="col-12">
            <strong>Chave de Acesso:</strong>
            <div style="word-break: break-all;">
              ${escapeHtmlFinanceiro(compra.chave_acesso || '-')}
            </div>
          </div>

          <div class="col-12 col-md-4">
            <strong>Total da NF:</strong> ${formatarMoedaPagar(compra.valor_total_nota || compra.total || 0)}
          </div>

          <div class="col-12 col-md-4">
            <strong>Forma Pagamento:</strong> ${escapeHtmlFinanceiro(compra.forma_pagamento || dados.forma_pagamento || '-')}
          </div>

          <div class="col-12 col-md-4">
            <strong>Condição:</strong> ${escapeHtmlFinanceiro(compra.condicao_pagamento || '-')}
          </div>
        </div>

        <div class="mt-3 d-flex gap-2 flex-wrap">
          <button class="btn btn-outline-primary" onclick="viewCompra(${compra.id})">
            <i class="fas fa-eye"></i> Ver compra completa
          </button>
        </div>

        <h6 class="mt-4 mb-2">Itens da Compra</h6>

        <div class="table-responsive">
          <table class="table table-sm table-bordered">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Qtd</th>
                <th>Custo Unit.</th>
                <th>Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${
                itensCompra.length
                  ? itensCompra.map(item => `
                    <tr>
                      <td>${escapeHtmlFinanceiro(item.produto_nome || item.descricao_produto || '-')}</td>
                      <td>${Number(item.quantidade || 0)}</td>
                      <td>${formatarMoedaPagar(item.preco_unitario || 0)}</td>
                      <td>${formatarMoedaPagar(item.subtotal || 0)}</td>
                    </tr>
                  `).join('')
                  : `<tr><td colspan="4" class="text-center text-muted">Nenhum item encontrado.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      ` : '';

      body.innerHTML = `
        <div class="row g-3">
          <div class="col-12 col-md-6">
            <strong>Fornecedor:</strong> ${escapeHtmlFinanceiro(dados.pessoa_nome || dados.fornecedor_nome || '-')}
          </div>

          <div class="col-12 col-md-6">
            <strong>Documento:</strong> ${escapeHtmlFinanceiro(dados.documento || compra?.numero_nf || '-')}
          </div>

          <div class="col-12 col-md-6">
            <strong>Valor original:</strong> ${formatarMoedaPagar(dados.valor_original)}
            <br><strong>Saldo restante:</strong> ${formatarMoedaPagar(dados.valor_restante)}
          </div>

          <div class="col-12 col-md-6">
            <strong>Data Movimento:</strong> ${formatarDataPagar(dados.data_movimento)}
          </div>

          <div class="col-12 col-md-6">
            <strong>Vencimento:</strong> ${dados.vencimento ? formatarDataPagar(dados.vencimento) : '-'}
          </div>

          <div class="col-12 col-md-6">
            <strong>Data Pagamento:</strong> ${dados.baixado_em ? formatarDataPagar(dados.baixado_em) : '-'}
          </div>

          <div class="col-12 col-md-6">
            <strong>Status:</strong> ${formatarStatusBadgeSeguro(dados.status)}
          </div>

          <div class="col-12 col-md-6">
            <strong>Origem:</strong> ${escapeHtmlFinanceiro(dados.origem || 'manual')}
          </div>

          <div class="col-12 col-md-6">
            <strong>Parcelado:</strong> ${parcelado}
          </div>

          <div class="col-12 col-md-6">
            <strong>Parcela:</strong> ${dados.numero_parcela || 1} / ${dados.total_parcelas || 1}
          </div>

          <div class="col-12">
            <strong>Descrição:</strong>
            <p class="mb-1">${escapeHtmlFinanceiro(dados.descricao || '-')}</p>
          </div>

          <div class="col-12">
            <strong>Observação:</strong>
            <p class="mb-0">${escapeHtmlFinanceiro(dados.observacao || '-')}</p>
          </div>
        </div>

        ${blocoCompra}
        ${blocoPagamentos}

        ${adminAcoes}
      `;
    })
    .catch(error => {
      console.error('Erro ao carregar detalhes da conta a pagar:', error);
      body.innerHTML = `<div class="text-danger">Não foi possível carregar os detalhes. ${escapeHtmlFinanceiro(error.message || '')}</div>`;
    });
}

async function cancelarContaPagar(id) {
  const motivo = prompt('Informe o motivo do cancelamento do título:');
  if (!motivo || !motivo.trim()) return;
  if (!confirm('Cancelar este título? Pagamentos já registrados serão preservados.')) return;

  const chavesCancelamento = window.__financeiroPagarState.cancelamentoIdempotencyKeys;
  if (!chavesCancelamento[id]) {
    chavesCancelamento[id] = gerarChaveIdempotenciaPagar();
  }
  const idempotencyKey = chavesCancelamento[id];
  try {
    const response = await fetch(`/api/contas-pagar/${id}/cancelar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('token'),
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        motivo: motivo.trim(),
        idempotency_key: idempotencyKey
      })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Erro ao cancelar título.');
    }
    delete chavesCancelamento[id];

    if (window.__financeiroPagarState.modalDetalhesPagamento) {
      window.__financeiroPagarState.modalDetalhesPagamento.hide();
    }
    const periodo = obterPeriodoFinanceiro();
    carregarContasPagar(coletarFiltrosPagar(periodo));
    if (typeof carregarDashboardFinanceiro === 'function') {
      carregarDashboardFinanceiro(periodo);
    }
  } catch (error) {
    console.error('Erro ao cancelar título MCF:', error);
    alert(error.message || 'Erro ao cancelar título.');
  }
}

function coletarFiltrosPagar(periodo) {
  return {
    fornecedor: document.getElementById('filtroFornecedorPagar')?.value.trim() || '',
    status: document.getElementById('filtroStatusPagar')?.value || 'todos',
    dataInicio: periodo?.dataInicio || '',
    dataFim: periodo?.dataFim || ''
  };
}

function formatarDataPagar(data) {
  if (!data) return '-';
  const d = new Date(data);
  if (Number.isNaN(d.getTime())) return data;
  return d.toLocaleDateString('pt-BR');
}

function formatarMoedaPagar(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number(valor || 0));
}

function formatarStatusBadgeSeguro(status) {
  const texto = escapeHtmlFinanceiro(status || '-');
  return `<span class="status-${texto.toLowerCase()}">${texto}</span>`;
}

function escapeHtmlFinanceiro(texto) {
  return String(texto || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Função para atualizar a prévia das parcelas
function atualizarPreviaParcelas() {
  const isParcelado = document.getElementById('despesaParcelado')?.checked || false;
  const valorTotal = Number(document.getElementById('despesaValor')?.value || 0);
  const numParcelas = Number(document.getElementById('despesaParcelas')?.value || 2);
  const intervaloDias = Number(document.getElementById('despesaIntervalo')?.value || 30);
  const vencimentoBase = document.getElementById('despesaVencimento')?.value;

  const previaDiv = document.getElementById('previaParcelas');
  if (!previaDiv) return;

  if (!isParcelado || valorTotal <= 0 || numParcelas < 2 || !vencimentoBase) {
    previaDiv.innerHTML = '';
    return;
  }

  const totalCentavos = Math.round(valorTotal * 100);
  if (!Number.isSafeInteger(totalCentavos) || totalCentavos <= 0 || !Number.isInteger(numParcelas)) {
    previaDiv.innerHTML = '';
    return;
  }
  const centavosBase = Math.floor(totalCentavos / numParcelas);
  let html = '<h6>Prévia das Parcelas:</h6><ul class="list-group">';

  for (let index = 0; index < numParcelas; index++) {
    const dataAtual = new Date(`${vencimentoBase}T00:00:00Z`);
    dataAtual.setUTCDate(dataAtual.getUTCDate() + index * intervaloDias);
    const [ano, mes, dia] = dataAtual.toISOString().slice(0, 10).split('-');
    const dataFormatada = `${dia}/${mes}/${ano}`;
    const centavos = index === numParcelas - 1
      ? totalCentavos - centavosBase * (numParcelas - 1)
      : centavosBase;
    html += `<li class="list-group-item d-flex justify-content-between align-items-center">
      Parcela ${index + 1}/${numParcelas}
      <span>${formatarMoedaPagar(centavos / 100)} - Vence em ${dataFormatada}</span>
    </li>`;
  }

  html += '</ul>';
  previaDiv.innerHTML = html;
}

// Expor globalmente
window.renderContasPagar = renderContasPagar;
window.carregarContasPagar = carregarContasPagar;
window.novaDespesa = novaDespesa;
window.abrirDetalhesPagar = abrirDetalhesPagar;
window.pagarConta = pagarConta;
window.cancelarContaPagar = cancelarContaPagar;
window.filtrarPagar = filtrarPagar;
