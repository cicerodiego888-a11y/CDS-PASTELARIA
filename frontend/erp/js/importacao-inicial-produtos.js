/**
 * Configurações → Avançadas → Implantação → Importação Inicial de Produtos (V1.0.18)
 * Modos: CADASTRO_INICIAL | ATUALIZAR_QUANTIDADES + modo_fiscal_importacao
 */
'use strict';

const ImportacaoEstadoApi = (typeof window !== 'undefined' && window.ImportacaoInicialEstado)
  ? window.ImportacaoInicialEstado
  : null;

const MODO_CADASTRO = 'CADASTRO_INICIAL';
const MODO_QUANTIDADES = 'ATUALIZAR_QUANTIDADES';
const MODO_FISCAL = 'FISCAL';
const MODO_NAO_FISCAL = 'NAO_FISCAL';

function criarEstadoVazioImportacao(modo) {
  if (ImportacaoEstadoApi) return ImportacaoEstadoApi.criarEstadoVazioImportacao(modo);
  return {
    modo: modo || MODO_CADASTRO,
    modo_fiscal_importacao: null,
    arquivoNome: null,
    sessaoId: null,
    resumo: null,
    linhas: [],
    resultado: null
  };
}

function rotuloModoFiscalImportacaoUi(modoFiscal) {
  if (ImportacaoEstadoApi?.rotuloModoFiscal) {
    return ImportacaoEstadoApi.rotuloModoFiscal(modoFiscal);
  }
  return modoFiscal === MODO_NAO_FISCAL
    ? 'NÃO FISCAL — SEM NF'
    : 'FISCAL — COM NF';
}

function obterModoFiscalSelecionadoUi() {
  const marcado = document.querySelector('input[name="modoFiscalImportacao"]:checked');
  return marcado ? String(marcado.value || '').toUpperCase() : null;
}

function resetarEstadoImportacaoInicial(estadoAnterior) {
  if (ImportacaoEstadoApi) return ImportacaoEstadoApi.resetarEstadoImportacaoInicial(estadoAnterior);
  return {
    estado: criarEstadoVazioImportacao(estadoAnterior?.modo || MODO_CADASTRO),
    sessaoAnterior: estadoAnterior?.sessaoId || null
  };
}

function trocarModoImportacao(estadoAnterior, novoModo) {
  if (ImportacaoEstadoApi) return ImportacaoEstadoApi.trocarModoImportacao(estadoAnterior, novoModo);
  return {
    estado: criarEstadoVazioImportacao(novoModo),
    sessaoAnterior: estadoAnterior?.sessaoId || null,
    modoAnterior: estadoAnterior?.modo || MODO_CADASTRO
  };
}

let importacaoInicialState = criarEstadoVazioImportacao();

function isModoQuantidades() {
  return importacaoInicialState.modo === MODO_QUANTIDADES;
}

function escapeHtmlImport(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function headersImportacao() {
  const headers = {};
  const token = localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function moedaImport(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '—';
  if (typeof formatCurrency === 'function') return formatCurrency(n);
  return `R$ ${n.toFixed(4).replace('.', ',')}`;
}

function badgeStatusImport(status) {
  const mapa = {
    PRONTO: '<span class="badge bg-success">PRONTO</span>',
    OK: '<span class="badge bg-success">OK</span>',
    ATENCAO: '<span class="badge bg-warning text-dark">ATENÇÃO</span>',
    ERRO: '<span class="badge bg-danger">ERRO</span>',
    CODIGO_DUPLICADO_ARQUIVO: '<span class="badge bg-danger">CÓDIGO DUPLICADO NO ARQUIVO</span>',
    EXISTENTE: '<span class="badge bg-info text-dark">EXISTENTE</span>',
    EXISTENTE_APRESENTACAO_NOVA: '<span class="badge bg-primary">EXISTENTE — APRESENTAÇÃO NOVA</span>',
    NAO_ENCONTRADO: '<span class="badge bg-danger">PRODUTO NÃO ENCONTRADO</span>',
    APRESENTACAO_NAO_ENCONTRADA: '<span class="badge bg-danger">APRESENTAÇÃO NÃO ENCONTRADA</span>',
    JA_PROCESSADO: '<span class="badge bg-secondary">JÁ PROCESSADO</span>'
  };
  return mapa[status] || `<span class="badge bg-secondary">${escapeHtmlImport(status)}</span>`;
}

function textoBotaoAcaoPrincipal(disabledHint) {
  if (isModoQuantidades()) {
    return disabledHint ? 'Registrar Quantidades' : 'Registrar Quantidades';
  }
  return disabledHint ? 'Importar produtos' : 'Importar produtos';
}

function aplicarLimpezaUiImportacaoInicial() {
  const input = document.getElementById('arquivoImportacaoProdutos');
  if (input) input.value = '';

  $('input[name="modoFiscalImportacao"]').prop('checked', false);
  $('#avisoModoFiscalImportacao').addClass('d-none').text('');

  $('#btnValidarImportacaoProdutos')
    .prop('disabled', true)
    .html('<i class="fas fa-check-double"></i> Validar Importação');

  renderResumoVazioImportacao();
  renderCabecalhoPreviewImportacao();
  $('#cardPreviewImportacao').removeClass('d-none');
  const cols = isModoQuantidades() ? 6 : 13;
  $('#tbodyPreviewImportacao').html(
    `<tr><td colspan="${cols}" class="text-center text-muted py-4">Nenhuma linha</td></tr>`
  );
  $('#btnImportarProdutosFinal')
    .prop('disabled', true)
    .text(textoBotaoAcaoPrincipal(true));

  $('#cardResultadoImportacao').addClass('d-none');
  $('#corpoResultadoImportacao').empty();
  atualizarTextosModoImportacao();
}

function renderResumoVazioImportacao() {
  if (isModoQuantidades()) {
    $('#resumoValidacaoImportacao').removeClass('d-none').html(`
      <div class="alert alert-light border mb-0">
        <div><strong>Arquivo:</strong> Nenhum arquivo selecionado</div>
        <div class="row g-2 mt-2">
          <div class="col-md-3"><strong>Produtos no arquivo:</strong> 0</div>
          <div class="col-md-3"><strong>Encontrados:</strong> 0</div>
          <div class="col-md-3"><strong>Não encontrados:</strong> 0</div>
          <div class="col-md-3"><strong>Quantidade a lançar:</strong> 0 UN</div>
        </div>
      </div>
    `);
    return;
  }
  $('#resumoValidacaoImportacao').removeClass('d-none').html(`
    <div class="alert alert-light border mb-0">
      <div><strong>Arquivo:</strong> Nenhum arquivo selecionado</div>
      <div class="row g-2 mt-2">
        <div class="col-md-3"><strong>Produtos encontrados:</strong> 0</div>
        <div class="col-md-3"><strong>Produtos válidos:</strong> 0</div>
        <div class="col-md-3"><strong>Com erro:</strong> 0</div>
        <div class="col-md-3"><strong>Possíveis duplicados:</strong> 0</div>
        <div class="col-md-3"><strong>Estoque inicial:</strong> 0 UN</div>
      </div>
    </div>
  `);
}

function renderCabecalhoPreviewImportacao() {
  const $thead = $('#theadPreviewImportacao');
  if (!$thead.length) return;
  if (isModoQuantidades()) {
    $thead.html(`
      <tr>
        <th>Status</th>
        <th>Código</th>
        <th>Produto</th>
        <th>Qtd origem</th>
        <th>Conversão</th>
        <th>Quantidade a lançar</th>
      </tr>
    `);
  } else {
    $thead.html(`
      <tr>
        <th>Status</th>
        <th>Produto</th>
        <th>Marca</th>
        <th>Unidade</th>
        <th>Custo</th>
        <th>Markup</th>
        <th>Venda</th>
        <th>Apresentação</th>
        <th>Qtd. Origem</th>
        <th>Conversão</th>
        <th>Estoque Inicial</th>
        <th>Fiscal</th>
        <th></th>
      </tr>
    `);
  }
}

function atualizarTextosModoImportacao() {
  const qtd = isModoQuantidades();
  $('#badgeModoImportacao').text(qtd ? 'ATUALIZAÇÃO DE QUANTIDADES' : 'CADASTRO INICIAL');
  $('#subtituloImportacaoProdutos').text(
    qtd
      ? 'Atualize somente as quantidades dos produtos já cadastrados.'
      : 'Importe uma base de produtos para implantação inicial do cliente. Formato V1: XLSX. Importa produtos e registra o estoque inicial informado no arquivo.'
  );
  $('#avisoModoQuantidades').toggleClass('d-none', !qtd);
  atualizarVisibilidadeTratamentoFiscal();
  $('#hintArquivoImportacao').text(
    qtd
      ? 'Ex.: CDS_Atualizacao_Quantidades_PRIMEIRA_IMPORTACAO.xlsx (aba QUANTIDADES)'
      : 'Ex.: CDS_Importacao_Produtos_PRODUTOS_FISCAL.xlsx'
  );

  $('#btnModoCadastroInicial')
    .toggleClass('btn-primary', !qtd)
    .toggleClass('btn-outline-primary', qtd);
  $('#btnModoAtualizarQuantidades')
    .toggleClass('btn-primary', qtd)
    .toggleClass('btn-outline-primary', !qtd);

  $('#btnImportarProdutosFinal').text(textoBotaoAcaoPrincipal(true));
}

function confirmarLimparImportacaoInicial() {
  const temDados = !!(
    importacaoInicialState.arquivoNome
    || importacaoInicialState.sessaoId
    || (importacaoInicialState.linhas || []).length
    || importacaoInicialState.resultado
    || (document.getElementById('arquivoImportacaoProdutos')?.files?.length)
  );

  if (!temDados) {
    const modo = importacaoInicialState.modo;
    importacaoInicialState = criarEstadoVazioImportacao(modo);
    aplicarLimpezaUiImportacaoInicial();
    showNotification('Importação limpa. Você pode selecionar um novo arquivo.', 'info');
    return;
  }

  $('#modal-container').html(`
    <div class="modal fade" id="modalLimparImportacao" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Limpar importação?</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
          </div>
          <div class="modal-body">
            <p class="mb-2">Os dados carregados nesta tela serão removidos.</p>
            <p class="mb-0">Nenhum produto já cadastrado no banco será excluído.</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
            <button type="button" class="btn btn-danger" id="btnConfirmarLimparImportacao">
              <i class="fas fa-eraser"></i> Limpar
            </button>
          </div>
        </div>
      </div>
    </div>
  `);

  const modalEl = document.getElementById('modalLimparImportacao');
  const modal = new bootstrap.Modal(modalEl);
  modal.show();

  $('#btnConfirmarLimparImportacao').off('click').on('click', () => {
    modal.hide();
    executarLimpezaImportacaoInicial();
  });
}

function executarLimpezaImportacaoInicial() {
  const { estado } = resetarEstadoImportacaoInicial(importacaoInicialState);
  importacaoInicialState = estado;
  aplicarLimpezaUiImportacaoInicial();
  showNotification('Importação limpa. Você pode selecionar um novo arquivo.', 'success');
}

function solicitarTrocaModoImportacao(novoModo) {
  if (importacaoInicialState.modo === novoModo) return;

  const temDados = !!(
    importacaoInicialState.arquivoNome
    || importacaoInicialState.sessaoId
    || (importacaoInicialState.linhas || []).length
    || importacaoInicialState.resultado
    || (document.getElementById('arquivoImportacaoProdutos')?.files?.length)
  );

  const aplicarTroca = () => {
    const { estado } = trocarModoImportacao(importacaoInicialState, novoModo);
    importacaoInicialState = estado;
    aplicarLimpezaUiImportacaoInicial();
    atualizarVisibilidadeTratamentoFiscal();
    showNotification(
      novoModo === MODO_QUANTIDADES
        ? 'Modo: Atualizar Quantidades'
        : 'Modo: Cadastro Inicial',
      'info'
    );
  };

  if (!temDados) {
    aplicarTroca();
    return;
  }

  $('#modal-container').html(`
    <div class="modal fade" id="modalTrocarModoImportacao" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Trocar o modo de importação?</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p class="mb-0">Os dados carregados atualmente serão descartados.</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
            <button type="button" class="btn btn-primary" id="btnConfirmarTrocarModo">Trocar modo</button>
          </div>
        </div>
      </div>
    </div>
  `);
  const modalEl = document.getElementById('modalTrocarModoImportacao');
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
  $('#btnConfirmarTrocarModo').off('click').on('click', () => {
    modal.hide();
    aplicarTroca();
  });
}

function loadImportacaoInicialProdutos() {
  importacaoInicialState = criarEstadoVazioImportacao(MODO_CADASTRO);

  $('#page-content').html(`
    <div class="card mb-3 border-0 shadow-sm">
      <div class="card-body py-3">
        <nav aria-label="breadcrumb" class="mb-2">
          <ol class="breadcrumb mb-0 small">
            <li class="breadcrumb-item"><a href="#" onclick="loadPage('configuracoes'); return false;">Configurações</a></li>
            <li class="breadcrumb-item"><a href="#" onclick="loadPage('configuracoes-avancadas'); return false;">Avançadas</a></li>
            <li class="breadcrumb-item">Implantação</li>
            <li class="breadcrumb-item active" aria-current="page">Importação Inicial de Produtos</li>
          </ol>
        </nav>
        <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
          <h4 class="mb-0"><i class="fas fa-file-excel text-success"></i> Importação Inicial de Produtos</h4>
          <span class="badge bg-dark" id="badgeModoImportacao">CADASTRO INICIAL</span>
        </div>
        <p class="text-muted small mb-3" id="subtituloImportacaoProdutos">
          Importe uma base de produtos para implantação inicial do cliente. Formato V1: XLSX. Importa produtos e registra o estoque inicial informado no arquivo.
        </p>
        <div class="btn-group" role="group" aria-label="Modo de importação">
          <button type="button" class="btn btn-primary" id="btnModoCadastroInicial">Cadastro Inicial</button>
          <button type="button" class="btn btn-outline-primary" id="btnModoAtualizarQuantidades">Atualizar Quantidades</button>
        </div>
      </div>
    </div>

    <div class="alert alert-warning border d-none" id="avisoModoQuantidades" role="alert">
      <strong>Atenção:</strong> Este modo NÃO cadastra produtos e NÃO altera dados cadastrais.
      Ele somente registra as quantidades dos produtos já existentes.
    </div>

    <div class="card mb-3" id="cardTratamentoFiscalImportacao">
      <div class="card-header"><i class="fas fa-balance-scale"></i> Tratamento fiscal da importação</div>
      <div class="card-body">
        <p class="text-muted small mb-3">
          Define o tratamento fiscal dos produtos NOVOS desta importação.
          Produtos já cadastrados preservam sua classificação fiscal atual.
        </p>
        <div class="form-check mb-2">
          <input class="form-check-input" type="radio" name="modoFiscalImportacao" id="modoFiscalImportacaoFiscal" value="FISCAL">
          <label class="form-check-label fw-semibold" for="modoFiscalImportacaoFiscal">FISCAL — COM NF</label>
        </div>
        <div class="form-check">
          <input class="form-check-input" type="radio" name="modoFiscalImportacao" id="modoFiscalImportacaoNaoFiscal" value="NAO_FISCAL">
          <label class="form-check-label fw-semibold" for="modoFiscalImportacaoNaoFiscal">NÃO FISCAL — SEM NF</label>
        </div>
        <div class="text-danger small mt-2 d-none" id="avisoModoFiscalImportacao"></div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="card-header"><i class="fas fa-upload"></i> 1. Selecionar arquivo</div>
      <div class="card-body">
        <div class="row g-3 align-items-end">
          <div class="col-md-6">
            <label class="form-label fw-semibold" for="arquivoImportacaoProdutos">Arquivo XLSX</label>
            <input type="file" class="form-control" id="arquivoImportacaoProdutos" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
            <small class="text-muted" id="hintArquivoImportacao">Ex.: CDS_Importacao_Produtos_PRODUTOS_FISCAL.xlsx</small>
          </div>
          <div class="col-md-3">
            <button type="button" class="btn btn-primary w-100" id="btnValidarImportacaoProdutos" disabled>
              <i class="fas fa-check-double"></i> Validar Importação
            </button>
          </div>
          <div class="col-md-3">
            <button type="button" class="btn btn-outline-secondary w-100" id="btnLimparImportacaoProdutos">
              <i class="fas fa-eraser"></i> Limpar Importação
            </button>
          </div>
        </div>
        <div id="resumoValidacaoImportacao" class="mt-3 d-none"></div>
      </div>
    </div>

    <div class="card mb-3 d-none" id="cardPreviewImportacao">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span><i class="fas fa-table"></i> 2. Pré-visualização</span>
        <button type="button" class="btn btn-success btn-sm" id="btnImportarProdutosFinal" disabled>
          Importar produtos
        </button>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive" style="max-height: 420px;">
          <table class="table table-sm table-hover mb-0 align-middle">
            <thead class="table-light sticky-top" id="theadPreviewImportacao">
              <tr>
                <th>Status</th>
                <th>Produto</th>
                <th>Marca</th>
                <th>Unidade</th>
                <th>Custo</th>
                <th>Markup</th>
                <th>Venda</th>
                <th>Apresentação</th>
                <th>Qtd. Origem</th>
                <th>Conversão</th>
                <th>Estoque Inicial</th>
                <th>Fiscal</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="tbodyPreviewImportacao"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card mb-3 d-none" id="cardResultadoImportacao">
      <div class="card-header bg-success text-white"><i class="fas fa-flag-checkered"></i> Operação concluída</div>
      <div class="card-body" id="corpoResultadoImportacao"></div>
    </div>
  `);

  atualizarTextosModoImportacao();

  $('#btnModoCadastroInicial').on('click', () => solicitarTrocaModoImportacao(MODO_CADASTRO));
  $('#btnModoAtualizarQuantidades').on('click', () => solicitarTrocaModoImportacao(MODO_QUANTIDADES));

  $('input[name="modoFiscalImportacao"]').on('change', function onModoFiscalChange() {
    importacaoInicialState.modo_fiscal_importacao = obterModoFiscalSelecionadoUi();
    $('#avisoModoFiscalImportacao').addClass('d-none').text('');
  });

  $('#arquivoImportacaoProdutos').on('change', function onFileChange() {
    const file = this.files && this.files[0];
    importacaoInicialState.arquivoNome = file ? file.name : null;
    importacaoInicialState.sessaoId = null;
    importacaoInicialState.linhas = [];
    importacaoInicialState.resumo = null;
    importacaoInicialState.resultado = null;
    $('#btnValidarImportacaoProdutos').prop('disabled', !file);
    $('#btnImportarProdutosFinal').prop('disabled', true).text(textoBotaoAcaoPrincipal(true));
    $('#resumoValidacaoImportacao').addClass('d-none').empty();
    $('#cardPreviewImportacao').addClass('d-none');
    $('#cardResultadoImportacao').addClass('d-none');
  });

  $('#btnValidarImportacaoProdutos').on('click', validarArquivoImportacaoInicial);
  $('#btnImportarProdutosFinal').on('click', confirmarImportacaoInicialProdutos);
  $('#btnLimparImportacaoProdutos').on('click', confirmarLimparImportacaoInicial);
  atualizarVisibilidadeTratamentoFiscal();
}

function atualizarVisibilidadeTratamentoFiscal() {
  const qtd = isModoQuantidades();
  $('#cardTratamentoFiscalImportacao').toggleClass('d-none', qtd);
}

async function validarArquivoImportacaoInicial() {
  const input = document.getElementById('arquivoImportacaoProdutos');
  const file = input?.files?.[0];
  if (!file) {
    showNotification('Selecione um arquivo XLSX.', 'warning');
    return;
  }

  let modoFiscal = null;
  if (!isModoQuantidades()) {
    modoFiscal = obterModoFiscalSelecionadoUi();
    if (!modoFiscal || (modoFiscal !== MODO_FISCAL && modoFiscal !== MODO_NAO_FISCAL)) {
      $('#avisoModoFiscalImportacao')
        .removeClass('d-none')
        .text('Selecione se esta importação é Fiscal ou Não Fiscal.');
      showNotification('Selecione se esta importação é Fiscal ou Não Fiscal.', 'warning');
      return;
    }
    importacaoInicialState.modo_fiscal_importacao = modoFiscal;
    $('#avisoModoFiscalImportacao').addClass('d-none').text('');
  }

  const form = new FormData();
  form.append('arquivo', file);
  form.append('modo', importacaoInicialState.modo || MODO_CADASTRO);
  if (modoFiscal) {
    form.append('modo_fiscal_importacao', modoFiscal);
  }

  $('#btnValidarImportacaoProdutos').prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> Validando...');
  try {
    const resp = await fetch(`${API_URL}/produtos/importacao-inicial/validar`, {
      method: 'POST',
      headers: headersImportacao(),
      body: form
    });
    const data = await resp.json();
    if (!resp.ok || !data.sucesso) {
      throw new Error(data.error || 'Falha na validação');
    }

    importacaoInicialState.sessaoId = data.sessao_id;
    importacaoInicialState.resumo = data.resumo;
    importacaoInicialState.linhas = data.linhas || [];
    if (data.modo) importacaoInicialState.modo = data.modo;
    if (data.modo_fiscal_importacao) {
      importacaoInicialState.modo_fiscal_importacao = data.modo_fiscal_importacao;
    }

    renderResumoValidacaoImportacao(data, file.name);
    renderCabecalhoPreviewImportacao();
    renderPreviewImportacaoInicial();
    $('#cardPreviewImportacao').removeClass('d-none');

    const r = data.resumo || {};
    const $btn = $('#btnImportarProdutosFinal');
    if (isModoQuantidades()) {
      const pode = data.pode_importar && Number(r.prontos || 0) > 0;
      $btn.prop('disabled', !pode).text('Registrar Quantidades');
    } else {
      const qtdProntos = Number(r.prontos || 0);
      const qtdEnriq = Number(r.enriquecimentos || 0);
      const importaveis = qtdProntos + qtdEnriq;
      const temErro = Number(r.com_erro || 0) > 0;
      if (!temErro && importaveis > 0) {
        const label = qtdEnriq > 0 && qtdProntos === 0
          ? `Enriquecer ${qtdEnriq} produto${qtdEnriq === 1 ? '' : 's'}`
          : `Importar ${importaveis} produto${importaveis === 1 ? '' : 's'}`;
        $btn.prop('disabled', false).text(label);
      } else {
        $btn.prop('disabled', true).text('Importar produtos');
      }
    }

    showNotification('Validação concluída.', 'success');
  } catch (err) {
    showNotification(err.message || 'Erro ao validar', 'danger');
  } finally {
    $('#btnValidarImportacaoProdutos').prop('disabled', false).html('<i class="fas fa-check-double"></i> Validar Importação');
  }
}

function renderResumoValidacaoImportacao(data, nomeArquivo) {
  const r = data.resumo || {};
  if (isModoQuantidades()) {
    $('#resumoValidacaoImportacao').removeClass('d-none').html(`
      <div class="alert alert-light border mb-0">
        <div><strong>Arquivo:</strong> ${escapeHtmlImport(data.arquivo || nomeArquivo)}</div>
        <div class="row g-2 mt-2">
          <div class="col-md-3"><strong>Produtos no arquivo:</strong> ${r.produtos_no_arquivo || 0}</div>
          <div class="col-md-3"><strong>Encontrados:</strong> ${r.produtos_encontrados || 0}</div>
          <div class="col-md-3"><strong>Não encontrados:</strong> ${r.produtos_nao_encontrados || 0}</div>
          <div class="col-md-3"><strong>Quantidade a lançar:</strong> ${r.quantidade_total_a_lancar || 0} ${escapeHtmlImport(r.quantidade_unidade || 'UN')}</div>
        </div>
      </div>
    `);
    return;
  }

  const estoqueTotal = Number(r.estoque_inicial_total || 0);
  const unEstoque = escapeHtmlImport(r.estoque_inicial_unidade || 'UN');
  const enriquecimentos = Number(r.enriquecimentos || 0);
  const aprNovas = Number(r.apresentacoes_novas || 0);
  const modoFiscal = data.modo_fiscal_importacao
    || r.modo_fiscal_importacao
    || importacaoInicialState.modo_fiscal_importacao;
  const tratamento = escapeHtmlImport(
    data.tratamento_fiscal || r.tratamento_fiscal || rotuloModoFiscalImportacaoUi(modoFiscal)
  );
  $('#resumoValidacaoImportacao').removeClass('d-none').html(`
    <div class="alert alert-light border mb-0">
      <div><strong>Arquivo:</strong> ${escapeHtmlImport(data.arquivo || nomeArquivo)}</div>
      <div class="mt-2"><strong>TRATAMENTO FISCAL:</strong> ${tratamento}</div>
      <div class="row g-2 mt-2">
        <div class="col-md-3"><strong>Produtos encontrados:</strong> ${r.produtos_encontrados || 0}</div>
        <div class="col-md-3"><strong>Produtos válidos:</strong> ${r.produtos_validos || 0}</div>
        <div class="col-md-3"><strong>Com erro:</strong> ${r.com_erro || 0}</div>
        <div class="col-md-3"><strong>Possíveis duplicados:</strong> ${r.possiveis_duplicados || 0}</div>
        <div class="col-md-3"><strong>Produtos novos:</strong> ${r.produtos_novos != null ? r.produtos_novos : (r.prontos || 0)}</div>
        <div class="col-md-3"><strong>Produtos existentes:</strong> ${r.produtos_existentes != null ? r.produtos_existentes : ((r.existentes || 0) + enriquecimentos)}</div>
        <div class="col-md-3"><strong>Produtos fiscais novos:</strong> ${r.produtos_fiscais_novos || 0}</div>
        <div class="col-md-3"><strong>Produtos não fiscais novos:</strong> ${r.produtos_nao_fiscais_novos || 0}</div>
        <div class="col-md-3"><strong>Estoque inicial:</strong> ${estoqueTotal} ${unEstoque}</div>
        <div class="col-md-3"><strong>Existentes a enriquecer:</strong> ${enriquecimentos}</div>
        <div class="col-md-3"><strong>Apresentações novas:</strong> ${aprNovas}</div>
      </div>
    </div>
  `);
}

function renderPreviewImportacaoInicial() {
  const linhas = importacaoInicialState.linhas || [];

  if (isModoQuantidades()) {
    const html = linhas.map((l) => {
      const p = l.produto || {};
      const q = l.quantidade || {};
      return `<tr>
        <td>${badgeStatusImport(l.status)}</td>
        <td>${escapeHtmlImport(p.codigo_origem || '—')}</td>
        <td>${escapeHtmlImport(p.nome || '—')}</td>
        <td>${escapeHtmlImport(q.qtd_origem_label || '—')}</td>
        <td>${escapeHtmlImport(q.conversao_label || '—')}</td>
        <td>${escapeHtmlImport(q.quantidade_label || '—')}</td>
      </tr>`;
    }).join('');
    $('#tbodyPreviewImportacao').html(html || '<tr><td colspan="6" class="text-center text-muted py-4">Nenhuma linha</td></tr>');
    return;
  }

  const html = linhas.map((l, idx) => {
    const p = l.produto || {};
    const e = l.estoque || {};
    const isFiscal = Number(p.item_fiscal) !== 0;
    const badgeFiscal = isFiscal
      ? '<span class="badge bg-primary">Fiscal</span>'
      : '<span class="badge bg-secondary">Não Fiscal</span>';
    return `<tr>
      <td>${badgeStatusImport(l.status)}</td>
      <td>${escapeHtmlImport(p.nome)}</td>
      <td>${escapeHtmlImport(p.marca || '—')}</td>
      <td>${escapeHtmlImport(p.unidade_base || 'UN')}</td>
      <td>${moedaImport(p.custo_unitario)}</td>
      <td>${Number(p.markup || 0).toFixed(2).replace('.', ',')}%</td>
      <td>${moedaImport(p.preco_venda)}</td>
      <td>${escapeHtmlImport(l.apresentacao_label || '—')}</td>
      <td>${escapeHtmlImport(e.qtd_origem_label || '—')}</td>
      <td>${escapeHtmlImport(e.conversao_label || '—')}</td>
      <td>${escapeHtmlImport(e.estoque_inicial_label || '—')}</td>
      <td>${badgeFiscal}</td>
      <td><button type="button" class="btn btn-outline-secondary btn-sm" data-idx="${idx}" onclick="verDetalheImportacaoInicial(${idx})">Ver detalhes</button></td>
    </tr>`;
  }).join('');
  $('#tbodyPreviewImportacao').html(html || '<tr><td colspan="13" class="text-center text-muted py-4">Nenhuma linha</td></tr>');
}

function verDetalheImportacaoInicial(idx) {
  const l = importacaoInicialState.linhas[idx];
  if (!l) return;
  const p = l.produto || {};
  const enr = l.enriquecimento || null;
  const apr = (l.apresentacoes || []).map((a) =>
    `<li>${escapeHtmlImport(a.tipo)} — ${a.quantidade} ${escapeHtmlImport(a.unidade)} | Custo ${moedaImport(a.custo ?? a.valor_compra)} | Venda ${moedaImport(a.preco)}</li>`
  ).join('') || '<li class="text-muted">Sem apresentações</li>';

  const blocoEnriquecimento = (l.status === 'EXISTENTE_APRESENTACAO_NOVA' && enr)
    ? `
      <hr>
      <h6>Enriquecimento de produto existente</h6>
      <dl class="row mb-0">
        <dt class="col-sm-4">Produto</dt><dd class="col-sm-8">EXISTENTE</dd>
        <dt class="col-sm-4">Apresentação</dt><dd class="col-sm-8">${Number(enr.apresentacoes_novas || 0) > 0 ? 'NOVA' : 'EXISTENTE (sincronizar)'}</dd>
        <dt class="col-sm-4">Tipo</dt><dd class="col-sm-8">${escapeHtmlImport((l.apresentacoes && l.apresentacoes[0] && l.apresentacoes[0].tipo) || '—')}</dd>
        <dt class="col-sm-4">Conversão</dt><dd class="col-sm-8">${escapeHtmlImport((l.estoque && l.estoque.conversao_label) || '—')}</dd>
        <dt class="col-sm-4">Valor</dt><dd class="col-sm-8">${moedaImport((l.apresentacoes && l.apresentacoes[0] && (l.apresentacoes[0].valor_compra ?? l.apresentacoes[0].custo)) || null)}</dd>
        <dt class="col-sm-4">Estoque</dt><dd class="col-sm-8">${enr.precisa_estoque ? `+${escapeHtmlImport((l.estoque && l.estoque.estoque_inicial_label) || '')}` : 'sem novo lançamento'}</dd>
        <dt class="col-sm-4">Unidade base</dt><dd class="col-sm-8">${enr.corrigir_unidade_base
          ? `${escapeHtmlImport(enr.unidade_atual || '—')} → ${escapeHtmlImport(enr.unidade_arquivo || p.unidade_base || '—')}`
          : escapeHtmlImport(p.unidade_base || '—')}</dd>
      </dl>
    `
    : '';

  const dup = l.duplicidade_arquivo || null;
  const blocoDuplicidade = (l.status === 'CODIGO_DUPLICADO_ARQUIVO' && dup)
    ? `
      <hr>
      <h6>Código duplicado no arquivo</h6>
      <dl class="row mb-0">
        <dt class="col-sm-4">Código</dt><dd class="col-sm-8">${escapeHtmlImport(dup.codigo || p.codigo_origem || '—')}</dd>
        <dt class="col-sm-4">Ocorrências</dt><dd class="col-sm-8">${Number(dup.ocorrencias || 0)}</dd>
        <dt class="col-sm-4">Linhas</dt><dd class="col-sm-8">${escapeHtmlImport((dup.linhas || []).join(' e '))}</dd>
        <dt class="col-sm-4">Nome</dt><dd class="col-sm-8">${escapeHtmlImport((dup.nomes && dup.nomes[0]) || p.nome || '—')}</dd>
      </dl>
    `
    : '';

  $('#modal-container').html(`
    <div class="modal fade" id="modalDetalheImportacao" tabindex="-1">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Detalhes do produto</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <dl class="row mb-0">
              <dt class="col-sm-4">Produto</dt><dd class="col-sm-8">${escapeHtmlImport(p.nome)}</dd>
              <dt class="col-sm-4">Marca</dt><dd class="col-sm-8">${escapeHtmlImport(p.marca || '—')}</dd>
              <dt class="col-sm-4">Categoria</dt><dd class="col-sm-8">${escapeHtmlImport(p.categoria || '—')}</dd>
              <dt class="col-sm-4">Subcategoria</dt><dd class="col-sm-8">${escapeHtmlImport(p.subcategoria || '—')}</dd>
              <dt class="col-sm-4">Unidade base</dt><dd class="col-sm-8">${escapeHtmlImport(p.unidade_base || 'UN')}</dd>
              <dt class="col-sm-4">Qtd. origem</dt><dd class="col-sm-8">${escapeHtmlImport((l.estoque && l.estoque.qtd_origem_label) || '—')}</dd>
              <dt class="col-sm-4">Conversão</dt><dd class="col-sm-8">${escapeHtmlImport((l.estoque && l.estoque.conversao_label) || '—')}</dd>
              <dt class="col-sm-4">Estoque inicial</dt><dd class="col-sm-8">${escapeHtmlImport((l.estoque && l.estoque.estoque_inicial_label) || '—')}</dd>
              <dt class="col-sm-4">Custo</dt><dd class="col-sm-8">${moedaImport(p.custo_unitario)}</dd>
              <dt class="col-sm-4">Markup</dt><dd class="col-sm-8">${Number(p.markup || 0).toFixed(2)}%</dd>
              <dt class="col-sm-4">Preço</dt><dd class="col-sm-8">${moedaImport(p.preco_venda)}</dd>
              <dt class="col-sm-4">Fiscal</dt><dd class="col-sm-8">${Number(p.item_fiscal) === 0
                ? 'NÃO FISCAL (item_fiscal = 0)'
                : 'FISCAL (item_fiscal = 1)'}${p.fiscal_fonte === 'EXISTENTE'
                ? ' — classificação do banco'
                : ' — modo desta importação'}</dd>
              <dt class="col-sm-4">Referência</dt><dd class="col-sm-8">${escapeHtmlImport(p.referencia_fabricante || '—')}</dd>
              <dt class="col-sm-4">Código origem</dt><dd class="col-sm-8">${escapeHtmlImport(p.codigo_origem || '—')}</dd>
              <dt class="col-sm-4">Observações</dt><dd class="col-sm-8">${escapeHtmlImport(p.observacoes || '—')}</dd>
              <dt class="col-sm-4">Status</dt><dd class="col-sm-8">${badgeStatusImport(l.status)} ${(l.mensagens || []).map(escapeHtmlImport).join('; ')}</dd>
            </dl>
            ${blocoDuplicidade}
            ${blocoEnriquecimento}
            <hr>
            <h6>Apresentações / conversões</h6>
            <ul>${apr}</ul>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Fechar</button>
          </div>
        </div>
      </div>
    </div>
  `);
  const modal = new bootstrap.Modal(document.getElementById('modalDetalheImportacao'));
  modal.show();
}

function confirmarImportacaoInicialProdutos() {
  if (!importacaoInicialState.sessaoId) return;
  if (Number(importacaoInicialState.resumo?.com_erro || 0) > 0) {
    showNotification('Existem erros de validação. Corrija o arquivo e valide novamente.', 'warning');
    return;
  }

  if (isModoQuantidades()) {
    const r = importacaoInicialState.resumo || {};
    const qtd = Number(r.prontos || 0);
    if (qtd <= 0) return;
    const totalArquivo = Number(r.produtos_no_arquivo || 0);
    const qtdLancar = Number(r.quantidade_total_a_lancar || 0);

    $('#modal-container').html(`
      <div class="modal fade" id="modalConfirmarImportacao" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Registrar quantidades?</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="mb-2">Esta operação não criará nem alterará produtos.
              Somente registrará as quantidades dos produtos existentes.</p>
              <ul class="mb-2">
                <li>Produtos: <strong>${totalArquivo}</strong></li>
                <li>Quantidade total: <strong>${qtdLancar}</strong></li>
              </ul>
              <p class="text-muted small mb-0">Será criado um backup automático antes da gravação.</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-success" id="btnConfirmarImportacaoExec">Confirmar</button>
            </div>
          </div>
        </div>
      </div>
    `);
  } else {
    const r = importacaoInicialState.resumo || {};
    const qtd = Number(r.prontos || 0);
    const enriquecimentos = Number(r.enriquecimentos || 0);
    if (qtd + enriquecimentos <= 0) return;
    const existentes = Number(r.existentes || 0);
    const total = Number(r.produtos_encontrados || 0);
    const estoque = Number(r.estoque_inicial_total || 0);
    const un = escapeHtmlImport(r.estoque_inicial_unidade || 'UN');
    const aprNovas = Number(r.apresentacoes_novas || 0);
    const modoFiscal = importacaoInicialState.modo_fiscal_importacao
      || r.modo_fiscal_importacao
      || MODO_FISCAL;
    const tratamento = rotuloModoFiscalImportacaoUi(modoFiscal);
    const avisoFiscal = modoFiscal === MODO_NAO_FISCAL
      ? `<div class="alert alert-secondary py-2">
           <p class="mb-1"><strong>Tratamento fiscal desta importação:</strong></p>
           <p class="mb-1">${escapeHtmlImport(tratamento)}</p>
           <p class="mb-1">Produtos NOVOS serão cadastrados como NÃO FISCAL.</p>
           <p class="mb-0">Produtos EXISTENTES manterão sua classificação fiscal atual.</p>
         </div>`
      : `<div class="alert alert-primary py-2">
           <p class="mb-1"><strong>Tratamento fiscal desta importação:</strong></p>
           <p class="mb-1">${escapeHtmlImport(tratamento)}</p>
           <p class="mb-1">Produtos NOVOS serão cadastrados como FISCAL.</p>
           <p class="mb-0">Produtos EXISTENTES manterão sua classificação fiscal atual.</p>
         </div>`;
    const avisoEnriquecimento = enriquecimentos > 0
      ? `<p class="mb-2 text-primary">Existem produtos já cadastrados que receberão apresentações comerciais novas.</p>
         <ul class="mb-2">
           <li>Produtos existentes a enriquecer: <strong>${enriquecimentos}</strong></li>
           <li>Apresentações novas: <strong>${aprNovas}</strong></li>
           <li>Estoque a registrar: <strong>${estoque}</strong> ${un}</li>
         </ul>`
      : '';

    $('#modal-container').html(`
      <div class="modal fade" id="modalConfirmarImportacao" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Importar produtos e registrar estoque inicial?</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              ${avisoFiscal}
              ${avisoEnriquecimento}
              <ul class="mb-2">
                <li>Produtos: <strong>${total}</strong></li>
                <li>Produtos novos: <strong>${qtd}</strong></li>
                <li>Produtos existentes (sem alteração): <strong>${existentes}</strong></li>
                <li>Estoque inicial: <strong>${estoque}</strong> na unidade base (${un})</li>
                <li>Movimentações de estoque: <strong>serão criadas quando aplicável</strong></li>
              </ul>
              <p class="mb-1">Esta operação cadastrará produtos novos e poderá enriquecer existentes com apresentações do arquivo.</p>
              <p class="mb-0">Cadastro existente (nome, marca, categoria, fiscal) <strong>não será sobrescrito</strong>.</p>
              <p class="text-muted small mt-2 mb-0">Será criado um backup automático antes da gravação.</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancelar</button>
              <button type="button" class="btn btn-success" id="btnConfirmarImportacaoExec">Confirmar Importação</button>
            </div>
          </div>
        </div>
      </div>
    `);
  }

  const modalEl = document.getElementById('modalConfirmarImportacao');
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
  $('#btnConfirmarImportacaoExec').on('click', async () => {
    modal.hide();
    await executarImportacaoInicialProdutos();
  });
}

async function executarImportacaoInicialProdutos() {
  const $btn = $('#btnImportarProdutosFinal');
  const modoQtd = isModoQuantidades();
  $btn.prop('disabled', true).html(
    modoQtd
      ? '<i class="fas fa-spinner fa-spin"></i> Registrando...'
      : '<i class="fas fa-spinner fa-spin"></i> Importando...'
  );
  try {
    const resp = await fetch(`${API_URL}/produtos/importacao-inicial/importar`, {
      method: 'POST',
      headers: { ...headersImportacao(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessao_id: importacaoInicialState.sessaoId })
    });
    const data = await resp.json();
    if (!resp.ok || !data.sucesso) {
      throw new Error(data.error || 'Falha na operação');
    }
    importacaoInicialState.resultado = data;
    const r = data.relatorio || {};
    $('#cardResultadoImportacao').removeClass('d-none');

    if (modoQtd) {
      $('#corpoResultadoImportacao').html(`
        <h5 class="text-success">QUANTIDADES REGISTRADAS</h5>
        <ul class="mb-2">
          <li>Produtos processados: <strong>${r.produtos_processados || 0}</strong></li>
          <li>Produtos criados: <strong>0</strong></li>
          <li>Cadastro alterado: <strong>${r.cadastro_alterado || 0}</strong></li>
          <li>Estoque lançado: <strong>${r.estoque_lancado || 0}</strong> UN</li>
          <li>Movimentações: <strong>${r.movimentacoes_estoque || 0}</strong></li>
          <li>Já processados (ignorados): <strong>${r.ignorados_ja_processados || 0}</strong></li>
        </ul>
        ${data.backup ? `<p class="small text-muted mb-0">Backup: ${escapeHtmlImport(data.backup.arquivo || data.backup.caminho || '')}</p>` : ''}
      `);
      $btn.text('Quantidades registradas');
      showNotification('Quantidades registradas com sucesso.', 'success');
    } else {
      $('#corpoResultadoImportacao').html(`
        <h5 class="text-success">IMPORTAÇÃO CONCLUÍDA</h5>
        <ul class="mb-2">
          <li>Produtos processados: <strong>${r.produtos_processados || 0}</strong></li>
          <li>Criados: <strong>${r.criados || 0}</strong></li>
          <li>Existentes: <strong>${r.existentes || 0}</strong></li>
          <li>Enriquecidos: <strong>${r.enriquecidos || r.atualizados || 0}</strong></li>
          <li>Apresentações novas: <strong>${r.apresentacoes_novas || 0}</strong></li>
          <li>Com atenção: <strong>${r.com_atencao || 0}</strong></li>
          <li>Erros: <strong>${r.erros || 0}</strong></li>
          <li>Estoque inicial lançado: <strong>${r.estoque_lancado || 0}</strong></li>
          <li>Movimentações de estoque: <strong>${r.movimentacoes_estoque || 0}</strong></li>
        </ul>
        ${data.backup ? `<p class="small text-muted mb-0">Backup: ${escapeHtmlImport(data.backup.arquivo || data.backup.caminho || '')}</p>` : ''}
      `);
      $btn.text('Importação concluída');
      showNotification('Importação concluída com sucesso.', 'success');
    }

    // V1.0.13 — após sucesso, atualiza snapshot da Lista de Produtos (GET /produtos).
    if (typeof loadProdutos === 'function') {
      const refresh = loadProdutos();
      if (refresh && typeof refresh.then === 'function') {
        await refresh;
      }
    }
  } catch (err) {
    showNotification(err.message || 'Erro ao processar', 'danger');
    const qtd = Number(importacaoInicialState.resumo?.prontos || 0)
      + Number(importacaoInicialState.resumo?.enriquecimentos || 0);
    if (modoQtd) {
      $btn.prop('disabled', false).text('Registrar Quantidades');
    } else {
      $btn.prop('disabled', false).text(`Importar ${qtd} produto${qtd === 1 ? '' : 's'}`);
    }
  }
}

window.loadImportacaoInicialProdutos = loadImportacaoInicialProdutos;
window.verDetalheImportacaoInicial = verDetalheImportacaoInicial;
window.confirmarLimparImportacaoInicial = confirmarLimparImportacaoInicial;
window.criarEstadoVazioImportacao = criarEstadoVazioImportacao;
window.resetarEstadoImportacaoInicial = resetarEstadoImportacaoInicial;
window.trocarModoImportacao = trocarModoImportacao;
