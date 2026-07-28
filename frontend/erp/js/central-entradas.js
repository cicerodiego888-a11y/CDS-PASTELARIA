/**
 * Central Inteligente de Entradas — Sprint UX1 (Tela Definitiva).
 *
 * Interface moderna e integrada com APIs existentes. Sem alteração de regras de negócio.
 */

function centralUx() {
    return window.CentralEntradasUX || {};
}

const centralEntradasState = {
    pagina: 1,
    limite: 20,
    total: 0,
    totalPaginas: 1,
    documentos: [],
    documentoSelecionadoId: null,
    metadados: null,
    ordenarPor: 'created_at',
    ordenarDirecao: 'desc',
    carregando: false,
    carregandoDashboard: false,
    carregandoInteligencia: false,
    sincronizando: false,
    ultimaSincronizacao: null,
    sincronizacaoNsu: null,
    notasNovasUltimaSync: 0,
    processando: false,
    etapaProcessamento: null,
    detalheAtual: null,
    xmlAtual: null,
    parseAtual: null,
    abaAtiva: 'resumo',
    indicadores: null,
    ultimoDashboardContadores: null,
    operacional: null,
    sefazOperacional: null,
    alertas: null,
    pendencias: null,
    atencao: null,
    filtroRapidoAtivo: '',
    fornecedorStats: null,
    servicoStatus: null,
    configuracoes: null,
    configAbaAtiva: 'ambiente',
    viewAtiva: 'inbox',
    eventosLog: [],
    eventosTotal: 0,
    notificacoesVistas: new Set(),
    tickerServico: null,
    tickerNotificacoes: null,
    tickerSync: null,
    uploadArquivos: [],
    uploadEmAndamento: false,
    eventosRodape: [],
    notificacoesNaoLidas: 0,
    buscaDebounceTimer: null,
    tickerLiveUx: null,
    tickerSoftDoc: null,
    softRefreshEmAndamento: false,
    statusServico: null,
    loadingFase: 'preparando'
};

const CENTRAL_STATUS_META = {
    RECEBIDA: { cor: '#94a3b8', bg: 'rgba(148,163,184,.12)', icone: 'fa-envelope', badge: 'central-badge-light', descricao: 'Documento recebido' },
    SINCRONIZADA: { cor: '#0d6efd', bg: 'rgba(13,110,253,.10)', icone: 'fa-inbox', badge: 'bg-primary', descricao: 'Nova nota encontrada' },
    EM_PROCESSAMENTO: { cor: '#f59e0b', bg: 'rgba(245,158,11,.12)', icone: 'fa-cog', badge: 'bg-warning text-dark', descricao: 'Pipeline em execução' },
    AGUARDANDO_REVISAO: { cor: '#fd7e14', bg: 'rgba(253,126,20,.12)', icone: 'fa-user-check', badge: 'central-badge-orange', descricao: 'Produtos aguardando revisão' },
    AGUARDANDO_XML_COMPLETO: { cor: '#64748b', bg: 'rgba(100,116,139,.12)', icone: 'fa-file-import', badge: 'bg-secondary', descricao: 'Aguardando a disponibilização do XML completo pela SEFAZ.' },
    REVISADA: { cor: '#0dcaf0', bg: 'rgba(13,202,240,.12)', icone: 'fa-clipboard-check', badge: 'bg-info', descricao: 'Revisão concluída' },
    PRONTA_PARA_COMPRA: { cor: '#198754', bg: 'rgba(25,135,84,.12)', icone: 'fa-check-circle', badge: 'bg-success', descricao: 'Pronta para lançamento' },
    EM_COMPRA: { cor: '#6610f2', bg: 'rgba(102,16,242,.12)', icone: 'fa-shopping-cart', badge: 'bg-info', descricao: 'Aberta na tela de Compras' },
    GRAVADA: { cor: '#6c757d', bg: 'rgba(108,117,125,.12)', icone: 'fa-archive', badge: 'bg-secondary', descricao: 'Compra concluída' },
    DESCARTADA: { cor: '#212529', bg: 'rgba(33,37,41,.10)', icone: 'fa-trash-alt', badge: 'bg-dark', descricao: 'Documento descartado' },
    ERRO: { cor: '#dc3545', bg: 'rgba(220,53,69,.12)', icone: 'fa-exclamation-triangle', badge: 'bg-danger', descricao: 'Consulta temporariamente indisponível.' },
    DUPLICADA: { cor: '#dc3545', bg: 'rgba(220,53,69,.12)', icone: 'fa-copy', badge: 'bg-danger', descricao: 'Nota já lançada no sistema' }
};

function metaStatusCentral(status) {
    return CENTRAL_STATUS_META[status] || CENTRAL_STATUS_META.RECEBIDA;
}

function escapeHtmlCentralEntradas(texto) {
    if (texto === null || texto === undefined) return '';
    return String(texto)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatarMoedaCentral(valor) {
    return Number(valor || 0).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    });
}

function formatarDataCentral(data) {
    if (!data) return '—';
    const texto = String(data);
    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) {
        const [ano, mes, dia] = texto.substring(0, 10).split('-');
        return `${dia}/${mes}/${ano}`;
    }
    return texto;
}

function formatarDataHoraCentral(data) {
    if (!data) return '—';
    const texto = String(data).trim();
    const soData = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (soData) return `${soData[3]}/${soData[2]}/${soData[1]}`;
    const date = new Date(texto);
    if (Number.isNaN(date.getTime())) return texto;
    return date.toLocaleString('pt-BR');
}

/**
 * Data de exibição do documento: prioriza dataEmissao, depois dhRecbto.
 * Nunca usa created_at como data principal.
 * @param {Object} doc
 * @returns {{ data: string, hora: string, fonte?: string }}
 */
function obterDataExibicaoDocumentoCentral(doc) {
    const UX = centralUx();
    if (typeof UX.resolverDataDocumentoCentral === 'function') {
        const r = UX.resolverDataDocumentoCentral(doc);
        if (r?.data && r.data !== '—') return r;
    }
    const emissao = doc?.dataEmissao || doc?.data_emissao;
    if (emissao) {
        return UX.formatarDataHoraSeparadoCentral?.(emissao)
            || { data: formatarDataCentral(emissao), hora: '', fonte: 'dataEmissao' };
    }
    const dh = doc?.dhRecbto || doc?.dh_recbto || doc?.dataRecebimento;
    if (dh) {
        return UX.formatarDataHoraSeparadoCentral?.(dh)
            || { data: formatarDataCentral(dh), hora: '', fonte: 'dhRecbto' };
    }
    return { data: '—', hora: '', fonte: null };
}

function tempoDesdeCentral(data) {
    if (!data) return null;
    const inicio = new Date(data).getTime();
    if (Number.isNaN(inicio)) return null;

    const diffSeg = Math.max(0, Math.floor((Date.now() - inicio) / 1000));
    if (diffSeg < 60) return 'agora mesmo';
    if (diffSeg < 3600) return `há ${Math.floor(diffSeg / 60)} min`;
    if (diffSeg < 86400) return `há ${Math.floor(diffSeg / 3600)} h`;
    return `há ${Math.floor(diffSeg / 86400)} dia(s)`;
}

function labelOrigemCentral(origem) {
    const mapa = {
        dfe: 'DF-e',
        upload_manual: 'Upload',
        consulta_chave: 'Chave'
    };
    return mapa[origem] || origem || '—';
}

function iconeOrigemCentral(origem) {
    const mapa = {
        dfe: 'fa-cloud-download-alt',
        upload_manual: 'fa-file-upload',
        consulta_chave: 'fa-key'
    };
    return mapa[origem] || 'fa-file';
}

function obterLabelStatusCentral(status) {
    const meta = (centralEntradasState.metadados?.estados || []).find((e) => e.codigo === status);
    return meta?.label || status || '—';
}

function renderBadgeStatusCentral(status, label) {
    const meta = metaStatusCentral(status);
    return `<span class="badge ${meta.badge} central-entradas-badge-status" title="${escapeHtmlCentralEntradas(meta.descricao)}">
        <i class="fas ${meta.icone} me-1"></i>${escapeHtmlCentralEntradas(label || obterLabelStatusCentral(status))}
    </span>`;
}

async function centralEntradasFetch(path, options = {}) {
    const token = localStorage.getItem('token');
    const response = await fetch(`${API_URL}/central-entradas${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.headers || {})
        }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || `Erro HTTP ${response.status}`);
    }
    return data;
}

async function centralEntradasUpload(arquivos) {
    const token = localStorage.getItem('token');
    const formData = new FormData();

    arquivos.forEach((arquivo) => {
        formData.append('xml', arquivo);
    });

    const usuario = obterUsuarioLogadoCentral();
    if (usuario?.id != null) {
        formData.append('usuario_id', String(usuario.id));
    }

    const response = await fetch(`${API_URL}/central-entradas/upload`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`
        },
        body: formData
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok && !data.itens) {
        throw new Error(data.error || `Erro HTTP ${response.status}`);
    }
    return data;
}

function arquivoXmlValidoCentral(arquivo) {
    const nome = String(arquivo?.name || '');
    if (!/\.xml$/i.test(nome)) {
        return { valido: false, mensagem: 'Apenas arquivos .xml são permitidos' };
    }
    return { valido: true };
}

function renderListaArquivosUploadCentral() {
    const lista = document.getElementById('centralUploadLista');
    const btnEnviar = document.getElementById('centralUploadEnviar');
    if (!lista) return;

    const arquivos = centralEntradasState.uploadArquivos || [];
    if (!arquivos.length) {
        lista.classList.add('d-none');
        lista.innerHTML = '';
        if (btnEnviar) btnEnviar.disabled = true;
        return;
    }

    lista.classList.remove('d-none');
    lista.innerHTML = `
        <div class="central-upload-lista-header">
            <span><i class="fas fa-file-code me-1"></i> ${arquivos.length} arquivo(s) selecionado(s)</span>
            <button type="button" class="btn btn-link btn-sm text-danger p-0" id="centralUploadLimpar">Limpar</button>
        </div>
        <ul class="central-upload-lista-itens">
            ${arquivos.map((arquivo, idx) => `
                <li>
                    <span class="central-upload-item-nome" title="${escapeHtmlCentralEntradas(arquivo.name)}">
                        <i class="fas fa-file-xml text-primary me-1"></i>
                        ${escapeHtmlCentralEntradas(arquivo.name)}
                    </span>
                    <span class="text-muted small">${(arquivo.size / 1024).toFixed(1)} KB</span>
                    <button type="button" class="btn btn-sm btn-link text-danger p-0 central-upload-remover" data-idx="${idx}" title="Remover">
                        <i class="fas fa-times"></i>
                    </button>
                </li>
            `).join('')}
        </ul>
    `;

    if (btnEnviar) btnEnviar.disabled = centralEntradasState.uploadEmAndamento;
}

function renderResultadoUploadCentral(resultado) {
    const container = document.getElementById('centralUploadResultado');
    const progresso = document.getElementById('centralUploadProgresso');
    if (!container) return;

    if (progresso) progresso.classList.add('d-none');

    const itens = Array.isArray(resultado?.itens) ? resultado.itens : [];
    const resumoClass = resultado.importados > 0 ? 'success' : 'warning';

    const codigoLabel = {
        IMPORTADO: { texto: 'Upload concluído', classe: 'text-success' },
        XML_INVALIDO: { texto: 'XML inválido', classe: 'text-danger' },
        EXTENSAO_INVALIDA: { texto: 'Extensão inválida', classe: 'text-danger' },
        DOCUMENTO_JA_EXISTENTE: { texto: 'Documento já existente', classe: 'text-warning' },
        DOCUMENTO_DUPLICADO: { texto: 'Documento duplicado', classe: 'text-danger' },
        NF_CANCELADA: { texto: 'NF cancelada', classe: 'text-danger' },
        ERRO_PROCESSAMENTO: { texto: 'Erro no processamento', classe: 'text-danger' }
    };

    container.classList.remove('d-none');
    container.innerHTML = `
        <div class="alert alert-${resumoClass} py-2 mb-2">
            <strong>${escapeHtmlCentralEntradas(resultado.mensagem || 'Processamento concluído')}</strong>
            <div class="small mt-1">
                Enviados: ${resultado.totalEnviados || 0} ·
                Importados: ${resultado.importados || 0} ·
                Duplicados: ${resultado.duplicados || 0} ·
                Inválidos: ${resultado.invalidos || 0} ·
                Cancelados: ${resultado.cancelados || 0}
            </div>
        </div>
        ${itens.length ? `
            <ul class="central-upload-resultado-itens list-unstyled mb-0">
                ${itens.map((item) => {
                    const meta = codigoLabel[item.codigo] || { texto: item.mensagem, classe: 'text-muted' };
                    return `
                        <li class="central-upload-resultado-item">
                            <span class="central-upload-item-nome">${escapeHtmlCentralEntradas(item.nomeArquivo)}</span>
                            <span class="small ${meta.classe}">${escapeHtmlCentralEntradas(meta.texto)}</span>
                        </li>
                    `;
                }).join('')}
            </ul>
        ` : ''}
    `;
}

function abrirModalUploadCentral() {
    centralEntradasState.uploadArquivos = [];
    centralEntradasState.uploadEmAndamento = false;

    const resultado = document.getElementById('centralUploadResultado');
    const progresso = document.getElementById('centralUploadProgresso');
    const input = document.getElementById('centralUploadInput');

    if (resultado) {
        resultado.classList.add('d-none');
        resultado.innerHTML = '';
    }
    if (progresso) progresso.classList.add('d-none');
    if (input) input.value = '';

    renderListaArquivosUploadCentral();

    const modalEl = document.getElementById('centralUploadModal');
    if (!modalEl) return;

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
}

function adicionarArquivosUploadCentral(fileList) {
    const novos = Array.from(fileList || []);
    if (!novos.length) return;

    const invalidos = [];
    const validos = [];

    novos.forEach((arquivo) => {
        const check = arquivoXmlValidoCentral(arquivo);
        if (!check.valido) {
            invalidos.push(`${arquivo.name}: ${check.mensagem}`);
        } else {
            validos.push(arquivo);
        }
    });

    if (invalidos.length) {
        showNotification(invalidos.join('; '), 'warning');
    }

    if (!validos.length) return;

    const existentes = new Set((centralEntradasState.uploadArquivos || []).map((f) => `${f.name}|${f.size}`));
    const merged = [...(centralEntradasState.uploadArquivos || [])];

    validos.forEach((arquivo) => {
        const chave = `${arquivo.name}|${arquivo.size}`;
        if (!existentes.has(chave)) {
            merged.push(arquivo);
            existentes.add(chave);
        }
    });

    centralEntradasState.uploadArquivos = merged;
    renderListaArquivosUploadCentral();
}

async function enviarUploadCentralEntradas() {
    const arquivos = centralEntradasState.uploadArquivos || [];
    if (!arquivos.length || centralEntradasState.uploadEmAndamento) return;

    const btnEnviar = document.getElementById('centralUploadEnviar');
    const progresso = document.getElementById('centralUploadProgresso');
    const resultado = document.getElementById('centralUploadResultado');

    centralEntradasState.uploadEmAndamento = true;
    if (btnEnviar) {
        btnEnviar.disabled = true;
        btnEnviar.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Enviando...';
    }
    if (progresso) {
        progresso.classList.remove('d-none');
        progresso.innerHTML = `
            <div class="d-flex align-items-center gap-2 text-primary small">
                <span class="spinner-border spinner-border-sm"></span>
                Enviando ${arquivos.length} arquivo(s)...
            </div>
        `;
    }
    if (resultado) {
        resultado.classList.add('d-none');
        resultado.innerHTML = '';
    }

    try {
        const resposta = await centralEntradasUpload(arquivos);
        renderResultadoUploadCentral(resposta);

        if (resposta.importados > 0) {
            showNotification(resposta.mensagem || 'Upload concluído.', 'success');
            await Promise.all([
                carregarDashboardCentral(),
                carregarDocumentosCentral({ pagina: 1 })
            ]);

            const primeiroImportado = (resposta.itens || []).find((i) => i.codigo === 'IMPORTADO' && i.documentoId);
            if (primeiroImportado?.documentoId) {
                await selecionarDocumentoCentral(primeiroImportado.documentoId);
            }
        } else if (resposta.duplicados > 0) {
            showNotification('Nenhum documento novo — verifique duplicatas.', 'warning');
        } else {
            showNotification(resposta.mensagem || 'Nenhum documento importado.', 'warning');
        }

        centralEntradasState.uploadArquivos = [];
        renderListaArquivosUploadCentral();
    } catch (error) {
        showNotification('Erro no upload: ' + error.message, 'danger');
    } finally {
        centralEntradasState.uploadEmAndamento = false;
        if (btnEnviar) {
            btnEnviar.disabled = !(centralEntradasState.uploadArquivos || []).length;
            btnEnviar.innerHTML = '<i class="fas fa-upload"></i> Enviar';
        }
    }
}

/* ============================================================
 * Dashboard — Sprint UX1
 * ============================================================ */

const CENTRAL_UX1_FILTROS = [
    { codigo: 'hoje', label: 'Hoje' },
    { codigo: 'ontem', label: 'Ontem' },
    { codigo: 'ultimos_7_dias', label: 'Semana' },
    { codigo: 'este_mes', label: 'Mês' },
    { codigo: 'pendentes', label: 'Pendentes' },
    { codigo: '_status_gravada', label: 'Importadas', status: 'GRAVADA' },
    { codigo: '_status_descartada', label: 'Canceladas', status: 'DESCARTADA' },
    { codigo: '_status_erro', label: 'Erro', status: 'ERRO' },
    { codigo: '', label: 'Todos' }
];

function renderSefazOperacionalChipCentral(painel) {
    if (!painel || !painel.estadoOperacional) return '';
    const est = painel.estadoOperacional;
    const titulo = [
        `Estado: ${est.label || est.codigo || '—'}`,
        painel.ultimoCStat ? `Último cStat: ${painel.ultimoCStat}` : null,
        painel.ultimaConsulta ? `Última consulta: ${formatarDataHoraCentral(painel.ultimaConsulta)}` : null,
        painel.proximaConsulta ? `Próxima: ${formatarDataHoraCentral(painel.proximaConsulta)}` : null,
        painel.tempoRestante ? `Restante: ${painel.tempoRestante}` : null,
        painel.economiaSOAP != null ? `Economia SOAP: ${painel.economiaSOAP}` : null
    ].filter(Boolean).join(' · ');
    return `<span class="central-ux1-sync-info" title="${escapeHtmlCentralEntradas(titulo)}" style="margin-left:.35rem">
        <span aria-hidden="true">${escapeHtmlCentralEntradas(est.indicador || '🟢')}</span>
        SEFAZ: ${escapeHtmlCentralEntradas(est.label || 'Normal')}
        ${painel.tempoRestante && (est.codigo === 'BLOQUEIO_656' || est.codigo === 'BLOCKED')
            ? ` · ${escapeHtmlCentralEntradas(painel.tempoRestante)}`
            : ''}
    </span>`;
}

function renderCabecalhoUx1Central() {
    const container = document.getElementById('centralUx1Header');
    if (!container) return;

    const UX = centralUx();
    const estado = UX.resolverEstadoServicoCentral?.(centralEntradasState) || { label: 'Online', codigo: 'monitorando' };
    const online = estado.codigo !== 'offline' && navigator.onLine;
    const ultima = centralEntradasState.ultimaSincronizacao;
    const tempoSync = tempoDesdeCentral(ultima);
    const usuario = obterUsuarioLogadoCentral();
    const iniciais = (usuario?.nome || 'U').split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
    const podeDiagnostico = typeof usuarioPodeAcessarDiagnosticoCentral === 'function'
        && usuarioPodeAcessarDiagnosticoCentral();
    const notifQtd = centralEntradasState.notificacoesNaoLidas || 0;

    container.innerHTML = `
        <div class="central-ux1-header central-entradas-anim-in">
            <div>
                <h1 class="central-ux1-header-titulo">Central Inteligente de Entradas</h1>
                <p class="central-ux1-header-sub">Monitoramento automático de documentos fiscais recebidos</p>
                <div class="central-ux1-header-meta">
                    <span class="central-ux1-online ${online ? '' : 'central-ux1-online--off'}" title="${online ? 'Sistema conectado e operacional' : 'Sem conexão'}">
                        <span class="central-ux1-online-pulse" aria-hidden="true"></span>
                        ${online ? 'ONLINE' : 'OFFLINE'}
                    </span>
                    <span class="central-ux1-sync-info" title="Última sincronização com a SEFAZ">
                        <i class="fas fa-clock me-1" aria-hidden="true"></i>
                        Última sync: ${ultima ? escapeHtmlCentralEntradas(formatarDataHoraCentral(ultima)) : '—'}
                        ${tempoSync && !centralEntradasState.sincronizando ? ` · ${escapeHtmlCentralEntradas(tempoSync)}` : ''}
                    </span>
                    ${renderSefazOperacionalChipCentral(centralEntradasState.sefazOperacional)}
                </div>
            </div>
            <div class="central-ux1-header-acoes">
                <button type="button" class="btn btn-light btn-sm" id="centralBtnSincronizar" title="Sincronizar agora com a SEFAZ">
                    <i class="fas fa-sync-alt ${centralEntradasState.sincronizando ? 'fa-spin' : ''} me-1"></i> Sincronizar Agora
                </button>
                ${podeDiagnostico
                    ? `<button type="button" class="btn btn-outline-light btn-sm" id="centralBtnDiagnostico" title="Painel de diagnóstico (admin)">
                        <i class="fas fa-stethoscope me-1"></i> Diagnóstico
                       </button>`
                    : ''}
                <button type="button" class="btn btn-outline-light btn-sm position-relative" id="centralBtnNotificacoes" title="Notificações da Central">
                    <i class="fas fa-bell"></i>
                    ${notifQtd > 0 ? `<span class="central-ux1-notif-badge">${notifQtd > 9 ? '9+' : notifQtd}</span>` : ''}
                </button>
                <button type="button" class="btn btn-outline-light btn-sm" id="centralBtnAdicionarDocumento" title="Adicionar documento via XML">
                    <i class="fas fa-plus"></i>
                </button>
                <button type="button" class="btn btn-outline-light btn-sm central-nav-view" data-view="ciclo-dfe" title="Monitor de Ciclo DF-e (homologação)">
                    <i class="fas fa-project-diagram"></i>
                </button>
                <button type="button" class="btn btn-outline-light btn-sm central-nav-view" data-view="config" title="Configurações">
                    <i class="fas fa-cog"></i>
                </button>
                <button type="button" class="btn btn-outline-light btn-sm central-nav-view" data-view="log" title="Log operacional">
                    <i class="fas fa-list-alt"></i>
                </button>
                <div class="central-ux1-usuario" title="Usuário logado">
                    <span class="central-ux1-usuario-avatar" aria-hidden="true">${escapeHtmlCentralEntradas(iniciais)}</span>
                    <span>${escapeHtmlCentralEntradas(usuario?.nome || 'Usuário')}</span>
                </div>
            </div>
        </div>`;
}

function renderCardsUx1Central(contadores = {}, indicadores = {}, operacional = {}) {
    const UX = centralUx();
    const snapshot = UX.obterSnapshotKpisCentral?.();
    const prev = snapshot?.contadores || {};
    const prevOp = snapshot?.operacional || {};
    const porStatus = contadores.porStatus || {};

    const cards = [
        { titulo: 'Recebidas Hoje', valor: indicadores.documentosHoje ?? 0, icone: 'fa-inbox', cor: '#0d6efd', trendKey: 'documentosHoje', trendPrev: prevOp.documentosHoje, statusFiltro: null, filtroRapido: 'hoje' },
        { titulo: 'Importadas', valor: contadores.gravadas ?? 0, icone: 'fa-check-double', cor: '#198754', trendKey: 'gravadas', statusFiltro: 'GRAVADA' },
        { titulo: 'Pendentes', valor: (contadores.novas ?? 0) + (contadores.emProcessamento ?? 0) + (contadores.aguardandoRevisao ?? 0), icone: 'fa-hourglass-half', cor: '#fd7e14', trendKey: 'pendentes', trendPrev: (prev.novas || 0) + (prev.emProcessamento || 0) + (prev.aguardandoRevisao || 0), invertTrend: true, filtroRapido: 'pendentes' },
        { titulo: 'Em Processamento', valor: contadores.emProcessamento ?? 0, icone: 'fa-cog', cor: '#0dcaf0', trendKey: 'emProcessamento', statusFiltro: 'EM_PROCESSAMENTO' },
        { titulo: 'Canceladas', valor: porStatus.DESCARTADA ?? 0, icone: 'fa-ban', cor: '#6c757d', trendKey: 'canceladas', trendPrev: prev.porStatus?.DESCARTADA, statusFiltro: 'DESCARTADA' },
        { titulo: 'Precisão MIIP', valor: operacional.taxaIdentificacaoAutomatica != null ? `${operacional.taxaIdentificacaoAutomatica}%` : '—', icone: 'fa-brain', cor: '#6610f2', trendVal: operacional.taxaIdentificacaoAutomatica, trendPrev: prevOp.taxaIdentificacaoAutomatica, raw: true },
        { titulo: 'Tempo Médio', valor: operacional.tempoMedioProcessamentoMinutos != null ? `${operacional.tempoMedioProcessamentoMinutos} min` : '—', icone: 'fa-stopwatch', cor: '#20c997', trendVal: operacional.tempoMedioProcessamentoMinutos, trendPrev: prevOp.tempoMedioProcessamentoMinutos, invertTrend: true, raw: true },
        { titulo: 'Valor Total', valor: formatarMoedaCentral(indicadores.valorTotalDia), icone: 'fa-coins', cor: '#198754', trendVal: indicadores.valorTotalDia, trendPrev: prevOp.valorTotalDia, raw: true }
    ];

    return cards.map((card) => {
        const trend = card.raw
            ? (UX.renderTendenciaKpiCentral?.(card.trendVal, card.trendPrev, card.invertTrend) || '')
            : (UX.renderTendenciaKpiCentral?.(card.valor, card.trendPrev ?? prev[card.trendKey], card.invertTrend) || '');
        const clickAttrs = card.statusFiltro
            ? `data-status-filtro="${card.statusFiltro}"`
            : (card.filtroRapido ? `data-filtro-kpi="${card.filtroRapido}"` : '');
        const clickClass = clickAttrs ? 'central-ux1-kpi--click central-entradas-card-click' : '';

        return `
            <div class="central-ux1-kpi central-entradas-anim-in ${clickClass}" ${clickAttrs}
                 style="--kpi-cor:${card.cor}; --kpi-bg:${card.cor}18"
                 title="${escapeHtmlCentralEntradas(card.titulo)}"
                 tabindex="${clickAttrs ? '0' : '-1'}"
                 role="${clickAttrs ? 'button' : 'group'}">
                <div class="central-ux1-kpi-icone"><i class="fas ${card.icone}"></i></div>
                <div>
                    <div class="central-ux1-kpi-valor">${escapeHtmlCentralEntradas(card.valor)}</div>
                    <div class="central-ux1-kpi-titulo">${escapeHtmlCentralEntradas(card.titulo)}</div>
                    ${trend}
                </div>
            </div>`;
    }).join('');
}

function renderAtencaoBannerUx1() {
    const container = document.getElementById('centralEntradasAtencao');
    if (!container) return;

    const itens = centralEntradasState.atencao?.itens || [];
    if (!itens.length) {
        container.innerHTML = '';
        return;
    }

    const principal = itens[0];
    container.innerHTML = `
        <div class="central-ux1-atencao-banner central-entradas-anim-in" role="alert">
            <i class="fas fa-exclamation-circle text-warning"></i>
            <span class="flex-grow-1">${escapeHtmlCentralEntradas(principal.mensagem)}</span>
            ${principal.acao
                ? `<button type="button" class="btn btn-sm btn-warning central-atencao-acao" data-atencao-idx="0">${escapeHtmlCentralEntradas(principal.acao.label || 'Ver')}</button>`
                : ''}
        </div>`;
}

function renderRodapeUx1Central() {
    const container = document.getElementById('centralUx1Rodape');
    if (!container) return;

    const op = centralEntradasState.operacional || {};
    const ind = centralEntradasState.indicadores || {};
    const tempoEconomizado = op.tempoMedioProcessamentoMinutos != null
        ? `${Math.round((op.comprasConcluidasHoje || 0) * op.tempoMedioProcessamentoMinutos)} min`
        : '—';
    const ranking = montarRankingFornecedoresUx1();

    container.innerHTML = `
        <div class="central-ux1-rodape central-entradas-anim-in">
            <div class="central-ux1-rodape-card">
                <div class="central-ux1-rodape-titulo"><i class="fas fa-piggy-bank"></i> Economia Gerada Hoje</div>
                <div class="central-ux1-economia-item"><span>Tempo economizado</span><strong>${escapeHtmlCentralEntradas(tempoEconomizado)}</strong></div>
                <div class="central-ux1-economia-item"><span>Produtos reconhecidos</span><strong>${escapeHtmlCentralEntradas(op.taxaIdentificacaoAutomatica != null ? `${op.taxaIdentificacaoAutomatica}%` : '—')}</strong></div>
                <div class="central-ux1-economia-item"><span>Importações automáticas</span><strong>${escapeHtmlCentralEntradas(op.comprasConcluidasHoje ?? 0)}</strong></div>
            </div>
            <div class="central-ux1-rodape-card">
                <div class="central-ux1-rodape-titulo"><i class="fas fa-chart-line"></i> Precisão por Fornecedor</div>
                ${ranking || '<p class="text-muted small mb-0">Carregue documentos para ver o ranking.</p>'}
            </div>
            <div class="central-ux1-rodape-card">
                <div class="central-ux1-rodape-titulo"><i class="fas fa-bolt"></i> Atividade em Tempo Real</div>
                <div id="centralUx1Atividade">${renderAtividadeRodapeUx1()}</div>
            </div>
            <div class="central-ux1-rodape-card">
                <div class="central-ux1-rodape-titulo"><i class="fas fa-server"></i> Status dos Serviços</div>
                <div id="centralUx1Servicos">${renderStatusServicosRodapeUx1()}</div>
            </div>
        </div>`;
}

function montarRankingFornecedoresUx1() {
    const mapa = {};
    (centralEntradasState.documentos || []).forEach((doc) => {
        const nome = doc.fornecedor || 'Sem nome';
        if (!mapa[nome]) mapa[nome] = { nome, scores: [], total: 0 };
        if (doc.scoreGeral != null) mapa[nome].scores.push(doc.scoreGeral);
        mapa[nome].total += 1;
    });

    const lista = Object.values(mapa)
        .map((f) => ({
            nome: f.nome,
            precisao: f.scores.length
                ? Math.round(f.scores.reduce((a, b) => a + b, 0) / f.scores.length)
                : null
        }))
        .filter((f) => f.precisao != null)
        .sort((a, b) => b.precisao - a.precisao)
        .slice(0, 5);

    if (!lista.length) return '';

    return lista.map((f) => `
        <div class="central-ux1-fornecedor-rank">
            <span class="central-ux1-fornecedor-rank-nome" title="${escapeHtmlCentralEntradas(f.nome)}">${escapeHtmlCentralEntradas(f.nome)}</span>
            <div class="central-ux1-fornecedor-rank-bar" title="Precisão ${f.precisao}%"><span style="width:${f.precisao}%"></span></div>
            <strong class="small">${f.precisao}%</strong>
        </div>
    `).join('');
}

function renderAtividadeRodapeUx1() {
    const eventos = centralEntradasState.eventosRodape || [];
    if (!eventos.length) {
        return '<p class="text-muted small mb-0">Aguardando atividades...</p>';
    }

    const iconePorTipo = {
        DOCUMENTO_RECEBIDO: 'fa-inbox',
        DOCUMENTO_ATUALIZADO: 'fa-file-import',
        DOCUMENTO_PROCESSADO: 'fa-brain',
        CIENCIA_ENVIADA: 'fa-paper-plane',
        MANIFESTACAO_ACEITA: 'fa-check-circle',
        MANIFESTACAO_REJEITADA: 'fa-times-circle',
        CONSULTA_DFE_POS_MANIFESTACAO: 'fa-cloud-download-alt',
        PARSER_CONCLUIDO: 'fa-file-code',
        MIIP_CONCLUIDO: 'fa-brain',
        COMPRA_GRAVADA: 'fa-shopping-cart',
        SYNC_CONCLUIDA: 'fa-sync-alt',
        SYNC_INICIADA: 'fa-cloud-download-alt',
        ERRO: 'fa-exclamation-triangle',
        SYNC_ERRO: 'fa-exclamation-triangle'
    };

    return eventos.slice(0, 6).map((ev) => {
        const dt = centralUx().formatarDataHoraSeparadoCentral?.(ev.createdAt) || { hora: '—' };
        const icone = iconePorTipo[ev.tipo] || 'fa-circle';
        return `
            <div class="central-ux1-atividade-item">
                <span class="central-ux1-atividade-icone"><i class="fas ${icone}"></i></span>
                <div>
                    <div>${escapeHtmlCentralEntradas(ev.descricao || ev.tipo || 'Evento')}</div>
                    <small class="text-muted">${escapeHtmlCentralEntradas(dt.hora)}</small>
                </div>
            </div>`;
    }).join('');
}

function renderStatusServicosRodapeUx1() {
    const UX = centralUx();
    const estado = UX.resolverEstadoServicoCentral?.(centralEntradasState) || {};
    const s = centralEntradasState.servicoStatus || {};
    const sefazOnline = navigator.onLine && estado.codigo !== 'offline' && estado.codigo !== 'erro';
    const bgOnline = Boolean(s.servicoAtivo || s.syncAutomaticaHabilitada || s.executando);

    const servicos = [
        { nome: 'SEFAZ', online: sefazOnline },
        { nome: 'MIIP', online: navigator.onLine },
        { nome: 'Parser', online: navigator.onLine },
        { nome: 'Background', online: bgOnline }
    ];

    return `
        <div class="central-ux1-servico-grid">
            ${servicos.map((srv) => `
                <div class="central-ux1-servico-item" title="${srv.nome}: ${srv.online ? 'Online' : 'Offline'}">
                    <span class="central-ux1-servico-dot ${srv.online ? '' : 'central-ux1-servico-dot--off'}"></span>
                    <span>${escapeHtmlCentralEntradas(srv.nome)}</span>
                    <small class="ms-auto text-muted">${srv.online ? 'Online' : 'Offline'}</small>
                </div>
            `).join('')}
        </div>`;
}

async function carregarEventosRodapeCentral() {
    try {
        const resultado = await centralEntradasFetch('/eventos?limite=8');
        centralEntradasState.eventosRodape = resultado.eventos || [];
        const ativ = document.getElementById('centralUx1Atividade');
        if (ativ) ativ.innerHTML = renderAtividadeRodapeUx1();
    } catch { /* ignore */ }
}

async function carregarContagemNotificacoesCentral() {
    try {
        const { notificacoes, total } = await centralEntradasFetch('/notificacoes?apenas_nao_lidas=true&limite=1');
        centralEntradasState.notificacoesNaoLidas = total ?? (notificacoes || []).length;
        renderCabecalhoUx1Central();
    } catch { /* ignore */ }
}

function renderCardsDashboardCentral(contadores = {}) {
    const UX = centralUx();
    const snapshot = UX.obterSnapshotKpisCentral?.();
    const prev = snapshot?.contadores || {};

    const cards = [
        { titulo: 'Novas Notas', valor: contadores.novas ?? 0, status: 'SINCRONIZADA', subtitulo: 'aguardando processamento', trendKey: 'novas' },
        { titulo: 'Em Processamento', valor: contadores.emProcessamento ?? 0, status: 'EM_PROCESSAMENTO', subtitulo: 'pipeline em execução', trendKey: 'emProcessamento' },
        { titulo: 'Aguardando Revisão', valor: contadores.aguardandoRevisao ?? 0, status: 'AGUARDANDO_REVISAO', subtitulo: 'pendências MIIP', trendKey: 'aguardandoRevisao', invertTrend: true },
        { titulo: 'Prontas para Compra', valor: contadores.prontasParaCompra ?? 0, status: 'PRONTA_PARA_COMPRA', subtitulo: 'prontas para lançamento', trendKey: 'prontasParaCompra' },
        { titulo: 'Compras Gravadas', valor: contadores.gravadas ?? 0, status: 'GRAVADA', subtitulo: 'fluxo concluído', trendKey: 'gravadas' },
        { titulo: 'Erros', valor: contadores.erros ?? 0, status: 'ERRO', subtitulo: 'exigem atenção', trendKey: 'erros', invertTrend: true }
    ];

    return cards.map((card) => {
        const meta = metaStatusCentral(card.status);
        const trend = UX.renderTendenciaKpiCentral
            ? UX.renderTendenciaKpiCentral(card.valor, prev[card.trendKey], card.invertTrend)
            : '';
        return `
        <div class="col-6 col-md-4 col-xl-2">
            <div class="central-entradas-kpi central-entradas-card-click central-entradas-anim-in"
                 data-status-filtro="${card.status}"
                 style="--kpi-cor:${meta.cor}; --kpi-bg:${meta.bg}"
                 title="${escapeHtmlCentralEntradas(meta.descricao)}"
                 tabindex="0"
                 role="button"
                 aria-label="${escapeHtmlCentralEntradas(card.titulo)}: ${card.valor}">
                <div class="central-entradas-kpi-icone">
                    <i class="fas ${meta.icone}"></i>
                </div>
                <div class="central-entradas-kpi-corpo">
                    <div class="central-entradas-kpi-valor">${escapeHtmlCentralEntradas(card.valor)}</div>
                    <div class="central-entradas-kpi-titulo">${escapeHtmlCentralEntradas(card.titulo)}</div>
                    <div class="central-entradas-kpi-subtitulo">${escapeHtmlCentralEntradas(card.subtitulo)}</div>
                    ${trend}
                </div>
            </div>
        </div>`;
    }).join('');
}

function renderIndicadoresCentral() {
    const container = document.getElementById('centralEntradasIndicadores');
    if (!container) return;

    const ind = centralEntradasState.indicadores || {};
    const ultima = centralEntradasState.ultimaSincronizacao;
    const tempoSync = tempoDesdeCentral(ultima);
    const sincronizando = centralEntradasState.sincronizando;
    const nsu = centralEntradasState.sincronizacaoNsu;

    container.innerHTML = `
        <div class="central-entradas-indicadores central-entradas-anim-in ${sincronizando ? 'central-entradas-indicadores--ativo' : ''}">
            <div class="central-entradas-indicador">
                <i class="fas fa-satellite-dish ${sincronizando ? 'fa-spin text-primary' : 'text-primary'}"></i>
                <div>
                    <div class="central-entradas-indicador-label">Monitoramento SEFAZ</div>
                    <div class="central-entradas-indicador-valor">
                        ${sincronizando
                            ? 'Sincronizando...'
                            : (ultima ? `${escapeHtmlCentralEntradas(formatarDataHoraCentral(ultima))}` : 'Nunca sincronizado')}
                    </div>
                    ${tempoSync && !sincronizando ? `<div class="central-entradas-indicador-extra">${escapeHtmlCentralEntradas(tempoSync)}</div>` : ''}
                </div>
            </div>
            <div class="central-entradas-indicador">
                <i class="fas fa-coins text-success"></i>
                <div>
                    <div class="central-entradas-indicador-label">Valor das notas de hoje</div>
                    <div class="central-entradas-indicador-valor">${escapeHtmlCentralEntradas(formatarMoedaCentral(ind.valorTotalDia))}</div>
                    <div class="central-entradas-indicador-extra">${escapeHtmlCentralEntradas(ind.documentosHoje ?? 0)} documento(s) hoje</div>
                </div>
            </div>
            <div class="central-entradas-indicador">
                <i class="fas fa-database text-secondary"></i>
                <div>
                    <div class="central-entradas-indicador-label">Documentos monitorados</div>
                    <div class="central-entradas-indicador-valor">${escapeHtmlCentralEntradas(ind.totalDocumentos ?? 0)}</div>
                    ${nsu?.ultNsu ? `<div class="central-entradas-indicador-extra">NSU ${escapeHtmlCentralEntradas(nsu.ultNsu)}</div>` : ''}
                </div>
            </div>
            ${centralEntradasState.notasNovasUltimaSync > 0 && !sincronizando
                ? `<div class="central-entradas-indicador central-entradas-indicador--novas central-entradas-anim-pulse">
                    <i class="fas fa-bell text-warning"></i>
                    <div>
                        <div class="central-entradas-indicador-label">Última sincronização</div>
                        <div class="central-entradas-indicador-valor">+${centralEntradasState.notasNovasUltimaSync} nova(s)</div>
                    </div>
                </div>`
                : ''}
        </div>
    `;
}

function renderPainelAtencaoCentral() {
    const container = document.getElementById('centralEntradasAtencao');
    if (!container) return;

    const itens = centralEntradasState.atencao?.itens || [];
    if (!itens.length) {
        container.innerHTML = `
            <div class="central-entradas-atencao central-entradas-atencao--ok central-entradas-anim-in">
                <i class="fas fa-check-circle text-success"></i>
                <span>Nenhuma pendência crítica no momento. A Central está em dia.</span>
            </div>`;
        return;
    }

    container.innerHTML = `
        <div class="central-entradas-atencao central-entradas-anim-in">
            <div class="central-entradas-atencao-titulo">
                <i class="fas fa-bell text-warning"></i> O que requer sua atenção
            </div>
            <div class="central-entradas-atencao-itens">
                ${itens.map((item, idx) => `
                    <div class="central-entradas-atencao-item" style="--item-cor:${escapeHtmlCentralEntradas(item.cor)}">
                        <i class="fas ${escapeHtmlCentralEntradas(item.icone)}"></i>
                        <span class="flex-grow-1">${escapeHtmlCentralEntradas(item.mensagem)}</span>
                        <button type="button" class="btn btn-sm btn-outline-primary central-atencao-acao"
                            data-atencao-idx="${idx}">
                            ${escapeHtmlCentralEntradas(item.acao?.label || 'Ação')}
                        </button>
                    </div>
                `).join('')}
            </div>
        </div>`;
}

function renderCardsOperacionaisCentral() {
    const container = document.getElementById('centralEntradasOperacional');
    if (!container) return;

    if (centralEntradasState.carregandoInteligencia) {
        container.innerHTML = centralUx().renderSkeletonKpisCentral?.(6) || '';
        return;
    }

    const UX = centralUx();
    const op = centralEntradasState.operacional || {};
    const prev = UX.obterSnapshotKpisCentral?.()?.operacional || {};

    const cards = [
        { titulo: 'Valor do mês', valor: formatarMoedaCentral(op.valorTotalMes), icone: 'fa-calendar-alt', cor: '#198754', trendVal: op.valorTotalMes, trendPrev: prev.valorTotalMes },
        { titulo: 'Tempo médio processamento', valor: op.tempoMedioProcessamentoMinutos != null ? `${op.tempoMedioProcessamentoMinutos} min` : '—', icone: 'fa-stopwatch', cor: '#0d6efd', trendVal: op.tempoMedioProcessamentoMinutos, trendPrev: prev.tempoMedioProcessamentoMinutos, invertTrend: true },
        { titulo: 'Identificação automática', valor: op.taxaIdentificacaoAutomatica != null ? `${op.taxaIdentificacaoAutomatica}%` : '—', icone: 'fa-brain', cor: '#6610f2', trendVal: op.taxaIdentificacaoAutomatica, trendPrev: prev.taxaIdentificacaoAutomatica },
        { titulo: 'Revisão manual', valor: op.taxaRevisaoManual != null ? `${op.taxaRevisaoManual}%` : '—', icone: 'fa-user-check', cor: '#fd7e14', trendVal: op.taxaRevisaoManual, trendPrev: prev.taxaRevisaoManual, invertTrend: true },
        { titulo: 'Compras concluídas hoje', valor: op.comprasConcluidasHoje ?? 0, icone: 'fa-check-double', cor: '#20c997', trendVal: op.comprasConcluidasHoje, trendPrev: prev.comprasConcluidasHoje },
        { titulo: 'Pendências críticas', valor: op.pendenciasCriticas ?? 0, icone: 'fa-exclamation-circle', cor: '#dc3545', trendVal: op.pendenciasCriticas, trendPrev: prev.pendenciasCriticas, invertTrend: true }
    ];

    container.innerHTML = cards.map((card) => {
        const trend = UX.renderTendenciaKpiCentral
            ? UX.renderTendenciaKpiCentral(card.trendVal, card.trendPrev, card.invertTrend)
            : '';
        return `
        <div class="col-6 col-md-4 col-xl-2">
            <div class="central-entradas-kpi central-entradas-kpi--operacional central-entradas-anim-in"
                 style="--kpi-cor:${card.cor}; --kpi-bg:${card.cor}18"
                 title="${escapeHtmlCentralEntradas(card.titulo)}">
                <div class="central-entradas-kpi-icone"><i class="fas ${card.icone}"></i></div>
                <div class="central-entradas-kpi-corpo">
                    <div class="central-entradas-kpi-valor">${escapeHtmlCentralEntradas(card.valor)}</div>
                    <div class="central-entradas-kpi-titulo">${escapeHtmlCentralEntradas(card.titulo)}</div>
                    ${trend}
                </div>
            </div>
        </div>`;
    }).join('');
}

function renderPainelAlertasCentral() {
    const container = document.getElementById('centralEntradasAlertas');
    if (!container) return;

    if (centralEntradasState.carregandoInteligencia) {
        container.innerHTML = centralUx().renderSkeletonPainelBlocoCentral?.() || '';
        return;
    }

    const alertas = centralEntradasState.alertas?.alertas || [];
    if (!alertas.length) {
        container.innerHTML = centralUx().renderEmptyStateCentral?.('alertas') || '';
        return;
    }

    container.innerHTML = `
        <div class="central-entradas-alertas-lista">
            ${alertas.map((alerta) => `
                <div class="central-entradas-alerta central-entradas-alerta--${escapeHtmlCentralEntradas(alerta.gravidade)} central-entradas-anim-in"
                     style="--alerta-cor:${escapeHtmlCentralEntradas(alerta.cor)}">
                    <div class="central-entradas-alerta-icone">
                        <i class="fas ${escapeHtmlCentralEntradas(alerta.icone)}"></i>
                    </div>
                    <div class="central-entradas-alerta-corpo">
                        <div class="central-entradas-alerta-titulo">
                            ${escapeHtmlCentralEntradas(alerta.descricao)}
                            <span class="badge bg-secondary ms-1">${escapeHtmlCentralEntradas(alerta.quantidade ?? 0)}</span>
                        </div>
                        <div class="central-entradas-alerta-acao small text-muted">
                            ${escapeHtmlCentralEntradas(alerta.acaoSugerida || '')}
                        </div>
                    </div>
                    ${alerta.documentoIds?.length
                        ? `<button type="button" class="btn btn-sm btn-outline-secondary central-alerta-ver"
                               data-doc-id="${alerta.documentoIds[0]}">Ver</button>`
                        : ''}
                </div>
            `).join('')}
        </div>`;
}

function renderPainelPendenciasCentral() {
    const container = document.getElementById('centralEntradasPendenciasBody');
    if (!container) return;

    if (centralEntradasState.carregandoInteligencia) {
        container.innerHTML = centralUx().renderSkeletonPainelBlocoCentral?.() || '';
        return;
    }

    const secoes = centralEntradasState.pendencias?.secoes || {};
    const resumo = centralEntradasState.pendencias?.resumo || {};

    const blocos = [
        { chave: 'aguardandoRevisao', titulo: 'Aguardando revisão', icone: 'fa-user-check', cor: '#fd7e14' },
        { chave: 'comprasAbertas', titulo: 'Compras abertas', icone: 'fa-shopping-cart', cor: '#6610f2' },
        { chave: 'erros', titulo: 'Erros', icone: 'fa-exclamation-triangle', cor: '#dc3545' },
        { chave: 'xmlInvalido', titulo: 'XML inválido', icone: 'fa-file-excel', cor: '#dc3545' }
    ];

    const totalPendencias = blocos.reduce((acc, b) => acc + (resumo[b.chave] ?? 0), 0);
    const temItens = blocos.some((b) => (secoes[b.chave] || []).length > 0);

    if (!totalPendencias && !temItens) {
        container.innerHTML = centralUx().renderEmptyStateCentral?.('pendencias') || '';
        return;
    }

    container.innerHTML = `
        <div class="row g-2 mb-3">
            ${blocos.map((b) => `
                <div class="col-6 col-md-3">
                    <div class="central-entradas-pendencia-resumo" style="--pend-cor:${b.cor}">
                        <i class="fas ${b.icone}"></i>
                        <div>
                            <div class="fw-bold">${resumo[b.chave] ?? 0}</div>
                            <div class="small text-muted">${escapeHtmlCentralEntradas(b.titulo)}</div>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>
        <div class="central-entradas-pendencias-secoes">
            ${blocos.map((b) => {
                const itens = secoes[b.chave] || [];
                if (!itens.length) return '';
                return `
                    <div class="central-entradas-pendencia-secao mb-2">
                        <div class="small fw-semibold text-muted mb-1">${escapeHtmlCentralEntradas(b.titulo)}</div>
                        ${itens.slice(0, 5).map((item) => `
                            <div class="central-entradas-pendencia-item central-pendencia-ver"
                                 data-doc-id="${item.documentoId}" role="button">
                                <span class="text-truncate">${escapeHtmlCentralEntradas(item.fornecedor || '—')}</span>
                                <span class="text-muted small">${escapeHtmlCentralEntradas(formatarMoedaCentral(item.valorTotal))}</span>
                            </div>
                        `).join('')}
                    </div>`;
            }).join('')}
        </div>`;
}

function renderFiltrosRapidosCentral() {
    const container = document.getElementById('centralEntradasFiltrosRapidos');
    if (!container) return;

    const ativo = centralEntradasState.filtroRapidoAtivo;
    const statusAtivo = document.getElementById('centralFiltroStatus')?.value || '';

    container.innerHTML = CENTRAL_UX1_FILTROS.map((preset) => {
        const isStatus = preset.codigo.startsWith('_status_');
        const ativa = isStatus
            ? (statusAtivo === preset.status && !ativo)
            : (ativo === preset.codigo || (!ativo && !statusAtivo && preset.codigo === ''));
        return `<button type="button" class="central-ux1-filtro ${ativa ? 'ativa' : ''}"
            data-filtro-rapido="${escapeHtmlCentralEntradas(preset.codigo)}"
            data-filtro-status="${escapeHtmlCentralEntradas(preset.status || '')}"
            title="${escapeHtmlCentralEntradas(preset.label)}">${escapeHtmlCentralEntradas(preset.label)}</button>`;
    }).join('');
}

function renderScoreBadgeCentral(score, cor) {
    const UX = centralUx();
    if (score == null) {
        return '<span class="central-entradas-score central-entradas-score--na" title="Score indisponível" aria-label="Score indisponível">—</span>';
    }
    const corFinal = cor || UX.corScoreCentral?.(score) || '#94a3b8';
    const desc = UX.descricaoScoreCentral?.(score) || 'Score geral da nota';
    return `<span class="central-entradas-score central-entradas-score--anim" style="--score-cor:${escapeHtmlCentralEntradas(corFinal)}"
        title="${escapeHtmlCentralEntradas(desc)}" aria-label="Score ${score} por cento">${escapeHtmlCentralEntradas(score)}%</span>`;
}

async function carregarInteligenciaCentral() {
    centralEntradasState.carregandoInteligencia = true;

    try {
        // RC3: um único endpoint — alertas calculados uma vez
        const inteligencia = await centralEntradasFetch('/inteligencia?limite=20');

        centralEntradasState.operacional = inteligencia.operacional;
        centralEntradasState.alertas = inteligencia.alertas;
        centralEntradasState.pendencias = inteligencia.pendencias;
        centralEntradasState.atencao = inteligencia.atencao;

        renderAtencaoBannerUx1();

        centralUx().salvarSnapshotKpisCentral?.(
            { contadores: centralEntradasState.ultimoDashboardContadores || {} },
            inteligencia.operacional
        );

        await carregarEventosRodapeCentral();
    } catch (error) {
        console.warn('[Central Entradas][UX] Inteligência operacional:', error.message);
    } finally {
        centralEntradasState.carregandoInteligencia = false;
    }
}

async function carregarStatsFornecedorCentral(cnpj) {
    if (!cnpj) {
        centralEntradasState.fornecedorStats = null;
        return;
    }
    try {
        centralEntradasState.fornecedorStats = await centralEntradasFetch(
            `/fornecedor/${encodeURIComponent(String(cnpj).replace(/\D/g, ''))}/estatisticas`
        );
    } catch {
        centralEntradasState.fornecedorStats = null;
    }
}

function renderStatsFornecedorCentral() {
    const stats = centralEntradasState.fornecedorStats;
    if (!stats?.quantidadeNotas) return '';

    const ultima = stats.ultimaNota?.createdAt
        ? tempoDesdeCentral(stats.ultimaNota.createdAt) || formatarDataCentral(stats.ultimaNota.dataEmissao)
        : '—';

    return `
        <div class="central-entradas-fornecedor-stats mt-3 central-entradas-anim-in">
            <label class="central-entradas-label">Inteligência do fornecedor</label>
            <div class="row g-2 small">
                <div class="col-6"><span class="text-muted">Precisão MIIP</span><br><strong>${stats.precisaoMediaMiip != null ? stats.precisaoMediaMiip + '%' : '—'}</strong></div>
                <div class="col-6"><span class="text-muted">Notas (${stats.periodoDias}d)</span><br><strong>${stats.quantidadeNotas}</strong></div>
                <div class="col-6"><span class="text-muted">Tempo médio</span><br><strong>${stats.tempoMedioLancamentoMinutos != null ? stats.tempoMedioLancamentoMinutos + ' min' : '—'}</strong></div>
                <div class="col-6"><span class="text-muted">Pendências</span><br><strong>${stats.pendencias}</strong></div>
                <div class="col-12"><span class="text-muted">Última nota</span><br><strong>${escapeHtmlCentralEntradas(ultima)}</strong></div>
            </div>
        </div>`;
}

function executarAcaoAtencaoCentral(acao) {
    if (!acao) return;

    if (acao.tipo === 'filtrar_status') {
        mostrarViewCentral('inbox');
        const select = document.getElementById('centralFiltroStatus');
        if (select) select.value = acao.status || '';
        centralEntradasState.filtroRapidoAtivo = '';
        centralEntradasState.pagina = 1;
        renderFiltrosRapidosCentral();
        carregarDocumentosCentral();
        return;
    }

    if (acao.tipo === 'sincronizar') {
        sincronizarCentralEntradas();
        return;
    }

    if (acao.tipo === 'abrir_alerta' && acao.documentoId) {
        mostrarViewCentral('inbox');
        selecionarDocumentoCentral(Number(acao.documentoId));
    }
}

/* ============================================================
 * Sprint 8 — Automação e serviço
 * ============================================================ */

function renderPainelServicoCentral() {
    const container = document.getElementById('centralEntradasServico');
    if (!container) return;

    const UX = centralUx();
    const estado = UX.resolverEstadoServicoCentral?.(centralEntradasState) || {
        label: 'Serviço',
        descricao: '',
        icone: 'fa-circle',
        classe: ''
    };

    const s = centralEntradasState.servicoStatus || {};
    const ultima = s.ultimaExecucao || centralEntradasState.ultimaSincronizacao;
    const proxima = s.proximaExecucao;
    const ultimo = s.ultimoResultado || {};
    const duracao = ultimo.duracaoMs != null ? `${Math.round(ultimo.duracaoMs / 1000)}s` : '—';
    const qtd = ultimo.notasNovas != null ? ultimo.notasNovas : '—';
    const executando = estado.codigo === 'sincronizando';

    container.innerHTML = `
        <div class="central-entradas-servico central-ux-servico ${estado.classe} central-entradas-anim-in ${executando ? 'central-entradas-servico--ativo' : ''}"
             role="status" aria-live="polite" aria-label="Estado do serviço: ${escapeHtmlCentralEntradas(estado.label)}">
            <div class="central-entradas-servico-status">
                <span class="central-ux-servico-icone" aria-hidden="true">
                    <i class="fas ${estado.icone}"></i>
                </span>
                <div>
                    <strong>${escapeHtmlCentralEntradas(estado.label)}</strong>
                    <div class="central-ux-servico-descricao small text-muted">${escapeHtmlCentralEntradas(estado.descricao)}</div>
                </div>
                ${executando ? '<span class="badge bg-primary ms-2 central-ux-badge-pulse">Em execução</span>' : ''}
            </div>
            <div class="central-entradas-servico-metricas">
                <div title="Data e hora da última sincronização"><span class="label">Última execução</span><span>${escapeHtmlCentralEntradas(ultima ? formatarDataHoraCentral(ultima) : '—')}</span></div>
                <div title="Próxima execução agendada"><span class="label">Próxima execução</span><span>${escapeHtmlCentralEntradas(proxima ? formatarDataHoraCentral(proxima) : '—')}</span></div>
                <div title="Duração da última sincronização"><span class="label">Duração última sync</span><span>${escapeHtmlCentralEntradas(duracao)}</span></div>
                <div title="Notas recebidas na última sincronização"><span class="label">Notas na última sync</span><span>${escapeHtmlCentralEntradas(qtd)}</span></div>
            </div>
        </div>`;
}

async function carregarStatusServicoCentral() {
    try {
        centralEntradasState.servicoStatus = await centralEntradasFetch('/servico/status');
        centralEntradasState.statusServico = centralEntradasState.servicoStatus;
        renderPainelServicoCentral();
        renderPainelSaudeSefazUxCentral();
    } catch { /* ignore */ }
}

function mostrarViewCentral(view) {
    centralEntradasState.viewAtiva = view;
    const inbox = document.getElementById('centralEntradasViewInbox');
    const config = document.getElementById('centralEntradasViewConfig');
    const log = document.getElementById('centralEntradasViewLog');
    const ciclo = document.getElementById('centralEntradasViewCicloDfe');
    if (inbox) inbox.classList.toggle('d-none', view !== 'inbox');
    if (config) config.classList.toggle('d-none', view !== 'config');
    if (log) log.classList.toggle('d-none', view !== 'log');
    if (ciclo) ciclo.classList.toggle('d-none', view !== 'ciclo-dfe');

    document.querySelectorAll('.central-nav-view').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });

    if (view === 'config') carregarConfigCentral();
    if (view === 'log') carregarLogCentral();
    if (view === 'ciclo-dfe') {
        if (typeof carregarHomologacaoCentral === 'function') {
            carregarHomologacaoCentral();
        } else if (window.CdsErpLazyLoader) {
            window.CdsErpLazyLoader.loadFeature('central-homologacao')
                .then(() => carregarHomologacaoCentral())
                .catch((error) => {
                    console.error('[ERP LAZY] Falha ao carregar homologação da Central:', error);
                    mostrarToastCentral('Não foi possível carregar a homologação.', 'error');
                });
        }
    }
}

function badgeCfgCentral(texto, tipo = 'neutral') {
    return `<span class="central-cfg-badge central-cfg-badge--${tipo}">${escapeHtmlCentralEntradas(texto)}</span>`;
}

function badgeCertStatusCfg(status) {
    const mapa = {
        OK: 'ok',
        A_VENCER: 'warn',
        VENCIDO: 'error',
        AUSENTE: 'error',
        ARQUIVO_AUSENTE: 'error',
        ERRO: 'error'
    };
    const labels = {
        OK: 'Válido',
        A_VENCER: 'A vencer',
        VENCIDO: 'Vencido',
        AUSENTE: 'Ausente',
        ARQUIVO_AUSENTE: 'Arquivo ausente',
        ERRO: 'Erro'
    };
    const codigo = String(status || 'AUSENTE');
    return badgeCfgCentral(labels[codigo] || codigo, mapa[codigo] || 'neutral');
}

function formatarMsCfgCentral(ms) {
    if (ms == null || Number.isNaN(Number(ms))) return '—';
    const valor = Number(ms);
    if (valor < 1000) return `${Math.round(valor)} ms`;
    if (valor < 60000) return `${(valor / 1000).toFixed(1)} s`;
    return `${(valor / 60000).toFixed(1)} min`;
}

function renderAbaAmbienteCfg(painel) {
    const amb = painel.ambiente || {};
    const codigo = Number(amb.codigo) === 1 ? 1 : 2;
    const origemLabel = amb.origemLabel || 'Centro de Configurações (fonte oficial)';
    return `
        <div class="row g-3">
            <div class="col-lg-7">
                <div class="central-cfg-card">
                    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                        <div class="central-cfg-card__title mb-0"><i class="fas fa-globe me-1"></i> Ambiente SEFAZ</div>
                        <div class="central-cfg-meta">
                            ${badgeCfgCentral('Somente leitura', 'neutral')}
                            ${badgeCfgCentral('RC3.1 fonte única', 'ok')}
                        </div>
                    </div>
                    <div class="central-cfg-disabled-note mb-3">
                        Ambiente e UF emitente vêm de <strong>Centro de Configurações → Fiscal</strong>
                        (<span class="text-muted">(${escapeHtmlCentralEntradas(origemLabel)})</span>.
                        A Central apenas consome — altere a fonte oficial para mudar Produção/Homologação.
                    </div>
                    <div class="mb-3">
                        <button type="button" class="btn btn-primary btn-sm" id="btnCentralAbrirConfigFiscal">
                            <i class="fas fa-file-invoice me-1"></i> Abrir Configuração Fiscal
                        </button>
                    </div>
                    <div class="row g-3">
                        <div class="col-md-4">
                            <label class="central-cfg-label">Ambiente</label>
                            <input type="text" class="form-control" id="cfgAmbienteReadonly" readonly disabled
                                value="${escapeHtmlCentralEntradas(codigo === 1 ? 'Produção (1)' : 'Homologação (2)')}">
                        </div>
                        <div class="col-md-4">
                            <label class="central-cfg-label" for="cfgUf">UF emitente</label>
                            <input type="text" class="form-control" id="cfgUf" maxlength="10" readonly disabled
                                value="${escapeHtmlCentralEntradas(amb.uf || '—')}">
                        </div>
                        <div class="col-md-4">
                            <label class="central-cfg-label" for="cfgCodigoUf">Código UF</label>
                            <input type="text" class="form-control" id="cfgCodigoUf" maxlength="2" readonly disabled
                                value="${escapeHtmlCentralEntradas(amb.codigoUf || '—')}">
                        </div>
                    </div>
                </div>
            </div>
            <div class="col-lg-5">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-info-circle me-1"></i> Metadados</div>
                    <div class="central-cfg-meta mb-3">
                        ${badgeCfgCentral(amb.label || (codigo === 1 ? 'Produção' : 'Homologação'), codigo === 1 ? 'ok' : 'info')}
                        ${badgeCfgCentral(painel.unificacaoFiscal || 'RC3.1', 'ok')}
                        ${badgeCfgCentral(painel.versaoConfiguracao || 'RC4', 'prep')}
                    </div>
                    <div class="central-cfg-stat mb-2">
                        <div class="central-cfg-stat__label">Fonte oficial</div>
                        <div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(origemLabel)}</div>
                    </div>
                    <div class="central-cfg-stat mb-2">
                        <div class="central-cfg-stat__label">Atualizado em (ops. Central)</div>
                        <div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(formatarDataHoraCentral(amb.atualizadoEm) || '—')}</div>
                    </div>
                    <div class="central-cfg-stat">
                        <div class="central-cfg-stat__label">Última alteração (ops. Central)</div>
                        <div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(formatarDataHoraCentral(amb.ultimaAlteracao) || '—')}</div>
                    </div>
                </div>
            </div>
        </div>`;
}

function renderAbaSefazCfg(painel) {
    const s = painel.sefaz || {};
    const pf = painel.plataformaFiscal || {};
    const amb = painel.ambiente || {};
    const dfeOk = Boolean(s.urlDistribuicaoDfeProducao && s.urlDistribuicaoDfeHomologacao);
    const manifOk = Boolean(s.urlManifestacaoProducao && s.urlManifestacaoHomologacao);
    const politica = s.politicaManifestacao || pf.modoCodigo || 'MANUAL';
    const politicaBadge = badgePoliticaManifestacaoCfg(politica);
    const ambienteLabel = Number(amb.codigo) === 1 ? 'Produção' : 'Homologação';
    const atualizadoEm = amb.ultimaAlteracao || amb.atualizadoEm || null;

    return `
        <div class="row g-3">
            <div class="col-12">
                <div class="central-cfg-card">
                    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                        <div class="central-cfg-card__title mb-0">
                            <i class="fas fa-file-signature me-1"></i> Manifestação do Destinatário
                            ${badgeCfgCentral('Somente leitura', 'neutral')}
                        </div>
                        <div class="central-cfg-meta">${politicaBadge}</div>
                    </div>
                    <div class="central-cfg-disabled-note mb-3">
                        A política da Manifestação do Destinatário define como a Central Inteligente enviará o evento
                        Ciência da Emissão (210210) durante o ciclo DF-e. Esta configuração afeta apenas futuras sincronizações.
                    </div>
                    <dl class="central-cfg-platform-dl mb-3">
                        <div><dt>Modo atual</dt><dd>${politicaBadge}</dd></div>
                        <div><dt>Origem</dt><dd>Centro de Configurações → Fiscal</dd></div>
                        <div><dt>Última atualização</dt><dd>${escapeHtmlCentralEntradas(atualizadoEm ? formatarDataHoraCentral(atualizadoEm) : '—')}</dd></div>
                    </dl>
                    <button type="button" class="btn btn-primary btn-sm mb-3" id="btnCentralAbrirConfigManifestacao">
                        <i class="fas fa-cog me-1"></i> Abrir Configuração Fiscal
                    </button>
                    <div class="central-cfg-card central-cfg-card--nested">
                        <div class="central-cfg-card__title"><i class="fas fa-heartbeat me-1"></i> Status (somente leitura)</div>
                        <div id="centralCfgManifStatusBody" class="small text-muted">Carregando status operacional…</div>
                    </div>
                </div>
            </div>
            <div class="col-12">
                <div class="central-cfg-card">
                    <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                        <div class="central-cfg-card__title mb-0">
                            <i class="fas fa-network-wired me-1"></i> Endpoints SEFAZ
                            <i class="fas fa-info-circle ms-1 central-cfg-tip"
                               title="Os endpoints de Manifestação são resolvidos automaticamente pela Plataforma Fiscal (Registry + UrlResolver)."></i>
                        </div>
                        <div class="central-cfg-meta">
                            ${badgeCfgCentral('DF-e via UrlResolver', dfeOk ? 'ok' : 'warn')}
                            ${badgeCfgCentral('Manifestação via UrlResolver', manifOk ? 'ok' : 'warn')}
                        </div>
                    </div>
                    <div class="central-cfg-disabled-note mb-3">
                        Endpoints DF-e e Manifestação são resolvidos pela Plataforma Fiscal (Registry → UrlResolver). A Central não edita nem monta URLs SOAP.
                    </div>
                    <div class="row g-3">
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgUrlDfeProd">Distribuição DF-e — Produção</label>
                            ${renderCampoEndpointResolvidoCfg({
                                id: 'cfgUrlDfeProd',
                                url: s.urlDistribuicaoDfeProducao,
                                origem: s.origemEndpointDfe || 'UrlResolver'
                            })}
                        </div>
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgUrlDfeHom">Distribuição DF-e — Homologação</label>
                            ${renderCampoEndpointResolvidoCfg({
                                id: 'cfgUrlDfeHom',
                                url: s.urlDistribuicaoDfeHomologacao,
                                origem: s.origemEndpointDfe || 'UrlResolver'
                            })}
                        </div>
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgUrlConsultaProd">
                                Consulta chave — Produção
                                <i class="fas fa-info-circle ms-1 central-cfg-tip"
                                   title="Endpoint resolvido automaticamente pela Plataforma Fiscal (Registry + UrlResolver)."></i>
                            </label>
                            ${renderCampoEndpointResolvidoCfg({
                                id: 'cfgUrlConsultaProd',
                                url: s.urlConsultaChaveProducao,
                                origem: 'Registry → UrlResolver'
                            })}
                        </div>
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgUrlConsultaHom">
                                Consulta chave — Homologação
                                <i class="fas fa-info-circle ms-1 central-cfg-tip"
                                   title="Endpoint resolvido automaticamente pela Plataforma Fiscal (Registry + UrlResolver)."></i>
                            </label>
                            ${renderCampoEndpointResolvidoCfg({
                                id: 'cfgUrlConsultaHom',
                                url: s.urlConsultaChaveHomologacao,
                                origem: 'Registry → UrlResolver'
                            })}
                        </div>
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgUrlManifProd">
                                Manifestação — Produção
                                <i class="fas fa-info-circle ms-1 central-cfg-tip"
                                   title="Os endpoints de Manifestação são resolvidos automaticamente pela Plataforma Fiscal (Registry + UrlResolver)."></i>
                            </label>
                            ${renderCampoEndpointResolvidoCfg({
                                id: 'cfgUrlManifProd',
                                url: s.urlManifestacaoProducao,
                                origem: 'Registry → UrlResolver'
                            })}
                        </div>
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgUrlManifHom">
                                Manifestação — Homologação
                                <i class="fas fa-info-circle ms-1 central-cfg-tip"
                                   title="Os endpoints de Manifestação são resolvidos automaticamente pela Plataforma Fiscal (Registry + UrlResolver)."></i>
                            </label>
                            ${renderCampoEndpointResolvidoCfg({
                                id: 'cfgUrlManifHom',
                                url: s.urlManifestacaoHomologacao,
                                origem: 'Registry → UrlResolver'
                            })}
                        </div>
                        <div class="col-12">
                            <div class="d-flex flex-wrap gap-2 align-items-center">
                                <button type="button" class="btn btn-sm btn-outline-primary" id="centralCfgTestarResolucao">
                                    <i class="fas fa-search me-1"></i> Testar Resolução
                                </button>
                                <button type="button" class="btn btn-sm btn-outline-secondary" id="centralCfgCopiarUrlManif">
                                    <i class="fas fa-copy me-1"></i> Copiar URL
                                </button>
                                <span id="centralCfgResolucaoFeedback" class="small text-muted"></span>
                            </div>
                            <div id="centralCfgResultResolucao" class="central-cfg-result mt-2"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="col-lg-8">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-sliders-h me-1"></i> Comunicação</div>
                    <div class="row g-3">
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgVersaoServico">Versão</label>
                            <input type="text" class="form-control" id="cfgVersaoServico"
                                value="${escapeHtmlCentralEntradas(s.versaoServico || '1.01')}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgTimeoutMs">Timeout (ms)</label>
                            <input type="number" class="form-control" id="cfgTimeoutMs" min="1000" max="300000"
                                value="${Number(s.timeoutMs) || 90000}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgMaxTentativas">Máx. tentativas</label>
                            <input type="number" class="form-control" id="cfgMaxTentativas" min="1" max="10"
                                value="${Number(s.maxTentativas) || 2}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgIntervaloTentativas">Intervalo (ms)</label>
                            <input type="number" class="form-control" id="cfgIntervaloTentativas" min="0" max="60000"
                                value="${Number(s.intervaloTentativasMs) || 3000}">
                        </div>
                    </div>
                </div>
            </div>
            <div class="col-lg-4">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-plug me-1"></i> Teste</div>
                    <p class="small text-muted mb-3">Valida comunicação com o endpoint DF-e do ambiente atual (SOAP).</p>
                    <button type="button" class="btn btn-outline-primary w-100" id="centralCfgTestarSefaz">
                        <i class="fas fa-satellite-dish me-1"></i> Testar comunicação
                    </button>
                    <div id="centralCfgResultSefaz" class="central-cfg-result"></div>
                </div>
                <div class="central-cfg-card mt-3">
                    <div class="central-cfg-card__title"><i class="fas fa-layer-group me-1"></i> Plataforma Fiscal</div>
                    <dl class="central-cfg-platform-dl mb-0">
                        <div><dt>Registry</dt><dd>${pf.registry === false ? '—' : '✔ Operacional'}</dd></div>
                        <div><dt>UrlResolver</dt><dd>${pf.urlResolver === false ? '—' : '✔ Operacional'}</dd></div>
                        <div><dt>SoapTransport</dt><dd>${pf.soapTransport === false ? '—' : '✔ Operacional'}</dd></div>
                        <div><dt>Runtime</dt><dd>✔ Operacional</dd></div>
                        <div><dt>Ambiente</dt><dd>${escapeHtmlCentralEntradas(ambienteLabel)}</dd></div>
                        <div><dt>Manifestação</dt><dd>${escapeHtmlCentralEntradas(pf.modo || s.politicaManifestacaoLabel || 'Manual')}</dd></div>
                        <div><dt>Endpoint</dt><dd>${pf.endpointResolvido ? 'Resolvido' : badgeCfgCentral('Não resolvido', 'warn')}</dd></div>
                    </dl>
                    <div class="central-cfg-disabled-note mt-2 mb-0">Somente leitura — sem edição na Central.</div>
                </div>
            </div>
        </div>`;
}

function abrirConfigFiscalManifestacaoCentral() {
    window.__CDS_CFG_FORCE_TAB = 'fiscal';
    window.__CDS_CFG_FORCE_ANCHOR = 'manifestacao';
    if (typeof loadPage === 'function') loadPage('configuracoes-avancadas');
}

async function carregarStatusManifestacaoCentralCfg() {
    const el = document.getElementById('centralCfgManifStatusBody');
    if (!el) return;
    const painel = centralEntradasState.configuracoes || {};
    const s = painel.sefaz || {};
    const pf = painel.plataformaFiscal || {};
    try {
        const [homolog, eventos] = await Promise.all([
            centralEntradasFetch('/homologacao/painel?limite=20').catch(() => null),
            centralEntradasFetch('/eventos?limite=80').catch(() => ({ eventos: [] }))
        ]);
        const diag = homolog?.diagnosticoSefaz || {};
        const lista = Array.isArray(eventos?.eventos) ? eventos.eventos : [];
        const enviados = lista.filter((e) => e.tipo === 'CIENCIA_ENVIADA').length;
        const aceitos = lista.filter((e) => e.tipo === 'MANIFESTACAO_ACEITA').length;
        const rejeitados = lista.filter((e) => e.tipo === 'MANIFESTACAO_REJEITADA').length;
        const ultimoEv = diag.ultimaManifestacao || lista.find((e) =>
            ['CIENCIA_ENVIADA', 'MANIFESTACAO_ACEITA', 'MANIFESTACAO_REJEITADA'].includes(e.tipo)
        );
        const cooldown = homolog?.cooldown || diag.cooldown;
        el.innerHTML = `
            <dl class="central-cfg-platform-dl mb-0">
                <div><dt>Modo atual</dt><dd>${badgePoliticaManifestacaoCfg(s.politicaManifestacao || pf.modoCodigo || 'MANUAL')}</dd></div>
                <div><dt>Última manifestação</dt><dd>${escapeHtmlCentralEntradas(ultimoEv?.dataHora ? formatarDataHoraCentral(ultimoEv.dataHora) : (ultimoEv?.createdAt ? formatarDataHoraCentral(ultimoEv.createdAt) : '—'))}</dd></div>
                <div><dt>Último evento enviado</dt><dd>${escapeHtmlCentralEntradas(ultimoEv?.tipo || '—')}</dd></div>
                <div><dt>Último cStat</dt><dd>${escapeHtmlCentralEntradas(String(ultimoEv?.cStat ?? ultimoEv?.detalhe?.cStat ?? diag.ultimoCstatPersistido ?? '—'))}</dd></div>
                <div><dt>Cooldown</dt><dd>${cooldown?.ativo ? `Ativo até ${escapeHtmlCentralEntradas(formatarDataHoraCentral(cooldown.proximaConsultaEm))}` : 'Inativo'}</dd></div>
                <div><dt>Eventos enviados</dt><dd>${enviados}</dd></div>
                <div><dt>Eventos aceitos</dt><dd>${aceitos}</dd></div>
                <div><dt>Eventos rejeitados</dt><dd>${rejeitados}</dd></div>
                <div><dt>Origem</dt><dd>Centro de Configurações → Fiscal</dd></div>
            </dl>`;
    } catch (err) {
        el.innerHTML = `<span class="text-danger">${escapeHtmlCentralEntradas(err.message || 'Falha ao carregar status')}</span>`;
    }
}

async function testarResolucaoEndpointCentralCfg() {
    const result = document.getElementById('centralCfgResultResolucao');
    const feedback = document.getElementById('centralCfgResolucaoFeedback');
    if (result) result.innerHTML = '<span class="text-muted small"><i class="fas fa-spinner fa-spin me-1"></i> Resolvendo via Registry → UrlResolver (sem SOAP)…</span>';
    if (feedback) feedback.textContent = '';
    const t0 = performance.now();
    try {
        const painel = await centralEntradasFetch('/configuracao');
        const tempoMs = Math.round(performance.now() - t0);
        centralEntradasState.configuracoes = painel;
        const amb = Number(painel.ambiente?.codigo) === 1 ? 1 : 2;
        const sefaz = painel.sefaz || {};
        const urlManif = amb === 1 ? sefaz.urlManifestacaoProducao : sefaz.urlManifestacaoHomologacao;
        const urlConsulta = amb === 1 ? sefaz.urlConsultaChaveProducao : sefaz.urlConsultaChaveHomologacao;
        const urlDfe = amb === 1 ? sefaz.urlDistribuicaoDfeProducao : sefaz.urlDistribuicaoDfeHomologacao;
        const ok = Boolean(urlManif && urlConsulta && urlDfe);
        if (result) {
            result.innerHTML = `
                <div class="alert alert-${ok ? 'success' : 'warning'} py-2 mb-0 small">
                    <div><strong>Status:</strong> ${ok ? '✔ Endpoints resolvidos' : 'Resolução parcial / falha'}</div>
                    <div><strong>Ambiente:</strong> ${amb === 1 ? 'Produção' : 'Homologação'}</div>
                    <div><strong>DF-e:</strong> ${escapeHtmlCentralEntradas(urlDfe || '—')}</div>
                    <div><strong>Consulta chave:</strong> ${escapeHtmlCentralEntradas(urlConsulta || '—')}</div>
                    <div><strong>Manifestação:</strong> ${escapeHtmlCentralEntradas(urlManif || '—')}</div>
                    <div><strong>Origem:</strong> Registry → UrlResolver → FiscalWebServices</div>
                    <div><strong>Tempo:</strong> ${tempoMs} ms</div>
                    <div><strong>Modelo:</strong> NFe</div>
                    <div class="text-muted mt-1">Nenhum SOAP enviado · Nenhuma consulta SEFAZ</div>
                </div>`;
        }
    } catch (err) {
        if (result) {
            result.innerHTML = `<div class="alert alert-danger py-2 mb-0 small">${escapeHtmlCentralEntradas(err.message)}</div>`;
        }
    }
}

async function copiarUrlManifestacaoCentralCfg() {
    const painel = centralEntradasState.configuracoes || {};
    const amb = Number(painel.ambiente?.codigo) === 1 ? 1 : 2;
    const sefaz = painel.sefaz || {};
    const url = amb === 1
        ? (sefaz.urlManifestacaoProducao || sefaz.urlConsultaChaveProducao || sefaz.urlDistribuicaoDfeProducao)
        : (sefaz.urlManifestacaoHomologacao || sefaz.urlConsultaChaveHomologacao || sefaz.urlDistribuicaoDfeHomologacao);
    const feedback = document.getElementById('centralCfgResolucaoFeedback');
    if (!url) {
        if (feedback) feedback.textContent = 'Nenhuma URL resolvida para copiar';
        if (typeof showNotification === 'function') showNotification('Nenhuma URL resolvida para copiar.', 'warning');
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        if (feedback) feedback.textContent = '✔ URL copiada.';
        if (typeof showNotification === 'function') showNotification('URL copiada.', 'success');
    } catch {
        const input = document.createElement('input');
        input.value = url;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        if (feedback) feedback.textContent = '✔ URL copiada.';
        if (typeof showNotification === 'function') showNotification('URL copiada.', 'success');
    }
}

function wireBotoesConfigFiscalCentral() {
    document.getElementById('btnCentralAbrirConfigFiscal')?.addEventListener('click', () => {
        window.__CDS_CFG_FORCE_TAB = 'fiscal';
        if (typeof loadPage === 'function') loadPage('configuracoes-avancadas');
    });
    document.getElementById('btnCentralAbrirConfigManifestacao')?.addEventListener('click', abrirConfigFiscalManifestacaoCentral);
    document.getElementById('centralCfgTestarResolucao')?.addEventListener('click', () => {
        void testarResolucaoEndpointCentralCfg();
    });
    document.getElementById('centralCfgCopiarUrlManif')?.addEventListener('click', () => {
        void copiarUrlManifestacaoCentralCfg();
    });
    void carregarStatusManifestacaoCentralCfg();
}

function badgePoliticaManifestacaoCfg(politica) {
    if (politica === 'AUTOMATICA_CIENCIA') {
        return badgeCfgCentral('🟢 Manifestação Automática', 'ok');
    }
    if (politica === 'CONFIRMAR_OPERADOR') {
        return badgeCfgCentral('🔵 Solicitar Confirmação', 'info');
    }
    return badgeCfgCentral('🟡 Manifestação Manual', 'warn');
}

function renderCampoEndpointResolvidoCfg({ id, url, origem }) {
    const resolvido = Boolean(url && String(url).trim());
    const valorExibido = resolvido ? String(url).trim() : 'Endpoint não resolvido';
    return `
        <input type="text" class="form-control form-control-sm ${resolvido ? '' : 'central-cfg-endpoint--unresolved'}"
            id="${escapeHtmlCentralEntradas(id)}" readonly disabled
            value="${escapeHtmlCentralEntradas(valorExibido)}"
            title="${escapeHtmlCentralEntradas(resolvido ? valorExibido : 'Endpoint não resolvido pela Plataforma Fiscal')}">
        <div class="central-cfg-endpoint-meta">
            ${resolvido
                ? `${badgeCfgCentral('Resolução dinâmica', 'ok')}
                   <span class="central-cfg-endpoint-origem">Origem: ${escapeHtmlCentralEntradas(origem || 'Registry → UrlResolver')}</span>`
                : badgeCfgCentral('Endpoint não resolvido', 'warn')}
        </div>`;
}

function renderAbaCertificadoCfg(painel) {
    const c = painel.certificado || {};
    const filiais = Array.isArray(painel.certificadosFiliais) ? painel.certificadosFiliais : [];
    return `
        <div class="row g-3">
            <div class="col-lg-7">
                <div class="central-cfg-card">
                    <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
                        <div class="central-cfg-card__title mb-0"><i class="fas fa-certificate me-1"></i> Certificado digital</div>
                        ${badgeCertStatusCfg(c.status)}
                    </div>
                    <div class="row g-3">
                        <div class="col-md-6">
                            <div class="central-cfg-stat">
                                <div class="central-cfg-stat__label">Nome / CN</div>
                                <div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(c.nome || '—')}</div>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="central-cfg-stat">
                                <div class="central-cfg-stat__label">CNPJ</div>
                                <div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(c.cnpj || '—')}</div>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="central-cfg-stat">
                                <div class="central-cfg-stat__label">Validade</div>
                                <div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(c.validade ? formatarDataHoraCentral(c.validade) : '—')}</div>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="central-cfg-stat">
                                <div class="central-cfg-stat__label">Dias restantes</div>
                                <div class="central-cfg-stat__value">${c.diasRestantes != null ? escapeHtmlCentralEntradas(String(c.diasRestantes)) : '—'}</div>
                            </div>
                        </div>
                    </div>
                    ${c.mensagem ? `<p class="small text-muted mt-3 mb-0">${escapeHtmlCentralEntradas(c.mensagem)}</p>` : ''}
                    <div class="d-flex flex-wrap gap-2 mt-3">
                        <button type="button" class="btn btn-outline-primary" id="centralCfgTestarCert">
                            <i class="fas fa-shield-alt me-1"></i> Testar Certificado
                        </button>
                        <button type="button" class="btn btn-outline-secondary" id="centralCfgAtualizarCert">
                            <i class="fas fa-sync me-1"></i> Atualizar Certificado
                        </button>
                    </div>
                    <div id="centralCfgResultCert" class="central-cfg-result"></div>
                    <div class="alert alert-light border mt-3 mb-0 small" id="centralCfgCertInfo" hidden>
                        O certificado é gerenciado nas <strong>configurações fiscais</strong> da empresa.
                        Esta tela exibe o status operacional para a Central.
                    </div>
                </div>
            </div>
            <div class="col-lg-5">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title">
                        <i class="fas fa-building me-1"></i> Filiais
                        ${badgeCfgCentral('estrutura', 'prep')}
                    </div>
                    ${filiais.length
                        ? filiais.map((f) => `
                            <div class="central-cfg-filial">
                                <div>
                                    <strong>${escapeHtmlCentralEntradas(f.nome || 'Filial')}</strong>
                                    <div class="central-cfg-hint mb-0">${escapeHtmlCentralEntradas(f.cnpj || '—')}</div>
                                </div>
                                ${badgeCertStatusCfg(f.status)}
                            </div>`).join('')
                        : `<p class="small text-muted mb-0">Nenhum certificado de filial listado. Estrutura pronta para múltiplos CNPJs.</p>`}
                </div>
            </div>
        </div>`;
}

function renderAbaSincronizacaoCfg(painel) {
    const sync = painel.sincronizacao || {};
    return `
        <div class="row g-3">
            <div class="col-12">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-sync-alt me-1"></i> Sincronização DF-e</div>
                    <div class="row g-3">
                        <div class="col-md-6">
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" id="cfgSyncAutomatica" ${sync.syncAutomaticaHabilitada ? 'checked' : ''}>
                                <label class="form-check-label" for="cfgSyncAutomatica">Sincronização automática</label>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" id="cfgSyncAoAbrir" ${sync.syncAoAbrir !== false ? 'checked' : ''}>
                                <label class="form-check-label" for="cfgSyncAoAbrir">Buscar ao abrir a Central</label>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" id="cfgNotificar" ${sync.notificarNovasNotas !== false ? 'checked' : ''}>
                                <label class="form-check-label" for="cfgNotificar">Notificar novas notas</label>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" id="cfgReprocessamento" ${sync.reprocessamentoAutomatico !== false ? 'checked' : ''}>
                                <label class="form-check-label" for="cfgReprocessamento">Reprocessamento automático</label>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <label class="central-cfg-label" for="cfgIntervalo">Intervalo (minutos)</label>
                            <input type="number" class="form-control" id="cfgIntervalo" min="1" max="1440"
                                value="${Number(sync.syncIntervaloMinutos) || 15}">
                        </div>
                        <div class="col-md-4">
                            <label class="central-cfg-label" for="cfgMaxDocs">Máx. iterações por sync</label>
                            <input type="number" class="form-control" id="cfgMaxDocs" min="1" max="200"
                                value="${Number(sync.syncMaxDocumentos) || 50}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgPermInicio">Horário permitido — início</label>
                            <input type="time" class="form-control" id="cfgPermInicio"
                                value="${escapeHtmlCentralEntradas(sync.horarioPermitidoInicio || '06:00')}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgPermFim">Horário permitido — fim</label>
                            <input type="time" class="form-control" id="cfgPermFim"
                                value="${escapeHtmlCentralEntradas(sync.horarioPermitidoFim || '23:59')}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgBloqInicio">Horário bloqueado — início</label>
                            <input type="time" class="form-control" id="cfgBloqInicio"
                                value="${escapeHtmlCentralEntradas(sync.horarioBloqueadoInicio || '')}">
                        </div>
                        <div class="col-md-3">
                            <label class="central-cfg-label" for="cfgBloqFim">Horário bloqueado — fim</label>
                            <input type="time" class="form-control" id="cfgBloqFim"
                                value="${escapeHtmlCentralEntradas(sync.horarioBloqueadoFim || '')}">
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
}

function renderAbaDiagnosticoCfg(painel) {
    const d = painel.diagnostico || {};
    const op = d.sefazOperacional || centralEntradasState.sefazOperacional || {};
    const est = op.estadoOperacional || {};
    const errOp = op.errosOperacionaisSefaz || {};
    const errInt = op.errosInternosCds || {};
    return `
        <div class="row g-3">
            <div class="col-12">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-satellite-dish me-1"></i> SEFAZ OPERACIONAL</div>
                    <div class="row g-2">
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Estado</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas((est.indicador || '🟢') + ' ' + (est.label || 'Normal'))}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Último cStat</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(op.ultimoCStat || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Tempo restante</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(op.tempoRestante || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Última consulta</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(formatarDataHoraCentral(op.ultimaConsulta) || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Próxima consulta</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(formatarDataHoraCentral(op.proximaConsulta) || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Backoff atual</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(op.backoffAtual || op.backoffAtualLabel || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Consultas realizadas</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(String(op.consultasSOAP ?? op.consultasRealizadas ?? '—'))}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Consultas evitadas</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(String(op.consultasEvitadas ?? '—'))}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Economia SOAP</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(String(op.economiaSOAP ?? '—'))}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Tempo médio</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(op.tempoMedio || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Tempo bloqueado</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(op.tempoBloqueado || '—')}</div></div></div>
                        <div class="col-md-4"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Contador 656</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(String(op.contador656 ?? '—'))}</div></div></div>
                    </div>
                    <div class="row g-2 mt-2">
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Erros operacionais SEFAZ</div><div class="central-cfg-stat__value small">137: ${escapeHtmlCentralEntradas(String(errOp['137'] ?? 0))} · 138: ${escapeHtmlCentralEntradas(String(errOp['138'] ?? 0))} · 656: ${escapeHtmlCentralEntradas(String(errOp['656'] ?? 0))} · 593: ${escapeHtmlCentralEntradas(String(errOp['593'] ?? 0))}</div></div></div>
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Erros internos CDS</div><div class="central-cfg-stat__value small">Timeout: ${escapeHtmlCentralEntradas(String(errInt.TIMEOUT ?? 0))} · SOAP: ${escapeHtmlCentralEntradas(String(errInt.SOAP_EXCEPTION ?? 0))} · XML: ${escapeHtmlCentralEntradas(String(errInt.ERRO_XML ?? 0))}</div></div></div>
                    </div>
                </div>
            </div>
            <div class="col-lg-5">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-stethoscope me-1"></i> Ações rápidas</div>
                    <div class="d-flex flex-wrap gap-2 central-cfg-diag-actions">
                        <button type="button" class="btn btn-sm btn-outline-primary" id="centralCfgHealth">
                            <i class="fas fa-heartbeat me-1"></i> Health
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-primary" id="centralCfgTestarCertDiag">
                            <i class="fas fa-shield-alt me-1"></i> Testar Cert
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-primary" id="centralCfgTestarSefazDiag">
                            <i class="fas fa-satellite-dish me-1"></i> Testar SEFAZ
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" id="centralCfgLimparCache">
                            <i class="fas fa-broom me-1"></i> Limpar Cache
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" id="centralCfgVerEventos">
                            <i class="fas fa-list-alt me-1"></i> Ver Eventos
                        </button>
                    </div>
                    <div id="centralCfgResultDiag" class="central-cfg-result"></div>
                </div>
            </div>
            <div class="col-lg-7">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-code-branch me-1"></i> Versões e tempos</div>
                    <div class="row g-2">
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Central</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(d.versaoCentral || '—')}</div></div></div>
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Pipeline</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(d.versaoPipeline || '—')}</div></div></div>
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Parser</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(d.versaoParser || '—')}</div></div></div>
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">MIIP</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(d.versaoMiip || '—')}</div></div></div>
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Tempo médio sync</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(formatarMsCfgCentral(d.tempoMedioSyncMs))}</div></div></div>
                        <div class="col-md-6"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Última sincronização</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(formatarDataHoraCentral(d.ultimaSincronizacao) || '—')}</div></div></div>
                        <div class="col-12"><div class="central-cfg-stat"><div class="central-cfg-stat__label">Último erro</div><div class="central-cfg-stat__value">${escapeHtmlCentralEntradas(d.ultimoErro || 'Nenhum')}</div></div></div>
                    </div>
                </div>
            </div>
        </div>`;
}

function renderAbaAvancadoCfg(painel) {
    const a = painel.avancado || {};
    return `
        <div class="row g-3">
            <div class="col-lg-6">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-server me-1"></i> HTTP</div>
                    <div class="row g-3">
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgHttpTimeout">Timeout HTTP (ms)</label>
                            <input type="number" class="form-control" id="cfgHttpTimeout" min="1000" max="300000"
                                value="${Number(a.httpTimeoutMs) || 90000}">
                        </div>
                        <div class="col-md-6">
                            <label class="central-cfg-label" for="cfgHttpRetry">Retry HTTP</label>
                            <input type="number" class="form-control" id="cfgHttpRetry" min="0" max="10"
                                value="${Number(a.httpRetry) || 2}">
                        </div>
                    </div>
                </div>
            </div>
            <div class="col-lg-6">
                <div class="central-cfg-card">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <div class="central-cfg-card__title mb-0"><i class="fas fa-shield-alt me-1"></i> Proxy</div>
                        ${badgeCfgCentral('estrutura', 'prep')}
                    </div>
                    <div class="form-check form-switch mb-2">
                        <input class="form-check-input" type="checkbox" id="cfgProxyHab" disabled ${a.proxyHabilitado ? 'checked' : ''}>
                        <label class="form-check-label" for="cfgProxyHab">Proxy habilitado</label>
                    </div>
                    <label class="central-cfg-label" for="cfgProxyUrl">URL do proxy</label>
                    <input type="url" class="form-control" id="cfgProxyUrl" disabled
                        value="${escapeHtmlCentralEntradas(a.proxyUrl || '')}" placeholder="http://proxy:8080">
                    <div class="central-cfg-disabled-note mt-2">Proxy preparado — ainda não funcional nesta versão.</div>
                </div>
            </div>
            <div class="col-12">
                <div class="central-cfg-card">
                    <div class="central-cfg-card__title"><i class="fas fa-bug me-1"></i> Logs e debug</div>
                    <div class="row g-3">
                        <div class="col-md-6">
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" id="cfgLogDetalhado" ${a.logDetalhado ? 'checked' : ''}>
                                <label class="form-check-label" for="cfgLogDetalhado">Log detalhado</label>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="form-check form-switch">
                                <input class="form-check-input" type="checkbox" id="cfgModoDebug" ${a.modoDebug ? 'checked' : ''}>
                                <label class="form-check-label" for="cfgModoDebug">Modo debug</label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
}

function renderPainelConfigCentral(painel) {
    const aba = centralEntradasState.configAbaAtiva || 'ambiente';
    const tabs = [
        { id: 'ambiente', icon: 'fa-globe', label: 'Ambiente' },
        { id: 'sefaz', icon: 'fa-network-wired', label: 'SEFAZ' },
        { id: 'certificado', icon: 'fa-certificate', label: 'Certificado' },
        { id: 'sincronizacao', icon: 'fa-sync-alt', label: 'Sincronização' },
        { id: 'diagnostico', icon: 'fa-stethoscope', label: 'Diagnóstico' },
        { id: 'avancado', icon: 'fa-cogs', label: 'Avançado' }
    ];

    const conteudos = {
        ambiente: renderAbaAmbienteCfg(painel),
        sefaz: renderAbaSefazCfg(painel),
        certificado: renderAbaCertificadoCfg(painel),
        sincronizacao: renderAbaSincronizacaoCfg(painel),
        diagnostico: renderAbaDiagnosticoCfg(painel),
        avancado: renderAbaAvancadoCfg(painel)
    };

    return `
        <ul class="nav nav-tabs central-cfg-tabs" role="tablist">
            ${tabs.map((t) => `
                <li class="nav-item" role="presentation">
                    <button type="button" class="nav-link ${aba === t.id ? 'active' : ''}"
                        data-cfg-tab="${t.id}" role="tab" aria-selected="${aba === t.id}">
                        <i class="fas ${t.icon} me-1"></i> ${t.label}
                    </button>
                </li>`).join('')}
        </ul>
        <div class="central-cfg-body">
            ${tabs.map((t) => `
                <div class="central-cfg-tab-pane ${aba === t.id ? '' : 'd-none'}" data-cfg-pane="${t.id}">
                    ${conteudos[t.id]}
                </div>`).join('')}
        </div>
        <div class="central-cfg-actions">
            <div class="central-cfg-actions__left">
                <button type="button" class="btn btn-outline-warning" id="centralBtnRestaurarConfig">
                    <i class="fas fa-undo me-1"></i> Restaurar padrão
                </button>
            </div>
            <div class="central-cfg-actions__right">
                <button type="button" class="btn btn-outline-secondary" id="centralBtnCancelarConfig">
                    <i class="fas fa-times me-1"></i> Cancelar
                </button>
                <button type="button" class="btn btn-primary" id="centralBtnSalvarConfig">
                    <i class="fas fa-save me-1"></i> Salvar
                </button>
            </div>
        </div>`;
}

function ativarAbaConfigCentral(tabId) {
    centralEntradasState.configAbaAtiva = tabId;
    document.querySelectorAll('[data-cfg-tab]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.cfgTab === tabId);
        btn.setAttribute('aria-selected', btn.dataset.cfgTab === tabId ? 'true' : 'false');
    });
    document.querySelectorAll('[data-cfg-pane]').forEach((pane) => {
        pane.classList.toggle('d-none', pane.dataset.cfgPane !== tabId);
    });
}

function coletarPayloadConfigCentral() {
    // RC3.1 — ambiente/UF não são enviados; fonte oficial = Centro de Configurações
    // RC4.3.1 — endpoints SOAP não são enviados; resolução = Plataforma Fiscal
    return {
        sefaz: {
            versaoServico: document.getElementById('cfgVersaoServico')?.value?.trim() || '1.01',
            timeoutMs: Number(document.getElementById('cfgTimeoutMs')?.value) || 90000,
            maxTentativas: Number(document.getElementById('cfgMaxTentativas')?.value) || 2,
            intervaloTentativasMs: Number(document.getElementById('cfgIntervaloTentativas')?.value) || 3000
        },
        sincronizacao: {
            syncAutomaticaHabilitada: document.getElementById('cfgSyncAutomatica')?.checked ?? false,
            syncAoAbrir: document.getElementById('cfgSyncAoAbrir')?.checked ?? true,
            syncIntervaloMinutos: Number(document.getElementById('cfgIntervalo')?.value) || 15,
            syncMaxDocumentos: Number(document.getElementById('cfgMaxDocs')?.value) || 50,
            notificarNovasNotas: document.getElementById('cfgNotificar')?.checked ?? true,
            reprocessamentoAutomatico: document.getElementById('cfgReprocessamento')?.checked ?? true,
            horarioPermitidoInicio: document.getElementById('cfgPermInicio')?.value || '06:00',
            horarioPermitidoFim: document.getElementById('cfgPermFim')?.value || '23:59',
            horarioBloqueadoInicio: document.getElementById('cfgBloqInicio')?.value || '',
            horarioBloqueadoFim: document.getElementById('cfgBloqFim')?.value || ''
        },
        avancado: {
            httpTimeoutMs: Number(document.getElementById('cfgHttpTimeout')?.value) || 90000,
            httpRetry: Number(document.getElementById('cfgHttpRetry')?.value) || 2,
            logDetalhado: document.getElementById('cfgLogDetalhado')?.checked ?? false,
            modoDebug: document.getElementById('cfgModoDebug')?.checked ?? false
        }
    };
}

function exibirResultadoCfg(elId, resultado, okFallback = 'OK') {
    const el = document.getElementById(elId);
    if (!el) return;
    const ok = resultado?.sucesso !== false && !resultado?.error;
    const msg = resultado?.mensagemAmigavel || resultado?.mensagem || resultado?.error || okFallback;
    el.innerHTML = `<div class="alert alert-${ok ? 'success' : 'warning'} py-2 mb-0">${escapeHtmlCentralEntradas(msg)}</div>`;
}

async function postConfigAcaoCentral(path) {
    const token = localStorage.getItem('token');
    const response = await fetch(`${API_URL}/central-entradas${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && data.sucesso !== false) {
        data.sucesso = false;
        data.mensagemAmigavel = data.mensagemAmigavel || data.error || `Erro HTTP ${response.status}`;
    }
    return data;
}

async function carregarConfigCentral() {
    const container = document.getElementById('centralConfigForm');
    if (!container) return;

    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>';

    try {
        const painel = await centralEntradasFetch('/configuracao');
        centralEntradasState.configuracoes = painel;
        container.innerHTML = renderPainelConfigCentral(painel);
        wireBotoesConfigFiscalCentral();
    } catch (error) {
        container.innerHTML = `<div class="alert alert-danger m-3">${escapeHtmlCentralEntradas(error.message)}</div>`;
    }
}

async function salvarConfigCentral() {
    const payload = coletarPayloadConfigCentral();
    try {
        const painel = await centralEntradasFetch('/configuracao', {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        centralEntradasState.configuracoes = painel;
        const container = document.getElementById('centralConfigForm');
        if (container) container.innerHTML = renderPainelConfigCentral(painel);
        wireBotoesConfigFiscalCentral();
        showNotification('Configurações salvas. Serviço de sync reiniciado.', 'success');
        await carregarStatusServicoCentral();
    } catch (error) {
        showNotification('Erro ao salvar: ' + error.message, 'danger');
    }
}

async function restaurarConfigCentral() {
    if (!confirm('Restaurar valores padrão da Configuração Enterprise? As preferências de sync operacional serão preservadas.')) {
        return;
    }
    try {
        const painel = await centralEntradasFetch('/configuracao/restaurar', {
            method: 'POST',
            body: JSON.stringify({})
        });
        centralEntradasState.configuracoes = painel;
        const container = document.getElementById('centralConfigForm');
        if (container) container.innerHTML = renderPainelConfigCentral(painel);
        wireBotoesConfigFiscalCentral();
        showNotification('Configuração padrão restaurada.', 'success');
    } catch (error) {
        showNotification('Erro ao restaurar: ' + error.message, 'danger');
    }
}

async function testarSefazConfigCentral(resultElId = 'centralCfgResultSefaz') {
    const el = document.getElementById(resultElId);
    if (el) el.innerHTML = '<span class="text-muted small"><i class="fas fa-spinner fa-spin me-1"></i> Testando SEFAZ...</span>';
    try {
        const resultado = await postConfigAcaoCentral('/configuracao/testar-sefaz');
        exibirResultadoCfg(resultElId, resultado, 'Comunicação SEFAZ OK');
        if (resultado.sucesso === false && resultado.mensagemAmigavel) {
            showNotification(resultado.mensagemAmigavel, 'warning');
        } else if (resultado.sucesso !== false) {
            showNotification(resultado.mensagemAmigavel || 'Comunicação SEFAZ OK', 'success');
        }
    } catch (error) {
        exibirResultadoCfg(resultElId, { sucesso: false, mensagemAmigavel: error.message });
        showNotification(error.message, 'danger');
    }
}

async function testarCertificadoConfigCentral(resultElId = 'centralCfgResultCert') {
    const el = document.getElementById(resultElId);
    if (el) el.innerHTML = '<span class="text-muted small"><i class="fas fa-spinner fa-spin me-1"></i> Testando certificado...</span>';
    try {
        const resultado = await postConfigAcaoCentral('/configuracao/testar-certificado');
        exibirResultadoCfg(resultElId, resultado, 'Certificado OK');
        if (resultado.sucesso === false && resultado.mensagemAmigavel) {
            showNotification(resultado.mensagemAmigavel, 'warning');
        } else if (resultado.sucesso !== false) {
            showNotification(resultado.mensagemAmigavel || 'Certificado OK', 'success');
        }
    } catch (error) {
        exibirResultadoCfg(resultElId, { sucesso: false, mensagemAmigavel: error.message });
        showNotification(error.message, 'danger');
    }
}

async function healthConfigCentral() {
    const el = document.getElementById('centralCfgResultDiag');
    if (el) el.innerHTML = '<span class="text-muted small"><i class="fas fa-spinner fa-spin me-1"></i> Executando health check...</span>';
    try {
        const resultado = await postConfigAcaoCentral('/configuracao/health');
        const status = resultado.status || (resultado.sucesso !== false ? 'OK' : 'ERRO');
        exibirResultadoCfg('centralCfgResultDiag', {
            sucesso: resultado.sucesso !== false,
            mensagemAmigavel: resultado.mensagemAmigavel || `Health: ${status}`
        });
    } catch (error) {
        exibirResultadoCfg('centralCfgResultDiag', { sucesso: false, mensagemAmigavel: error.message });
    }
}

async function limparCacheConfigCentral() {
    try {
        const resultado = await postConfigAcaoCentral('/configuracao/limpar-cache');
        exibirResultadoCfg('centralCfgResultDiag', resultado, 'Cache limpo');
        showNotification(resultado.mensagemAmigavel || 'Cache limpo.', 'success');
    } catch (error) {
        showNotification(error.message, 'danger');
    }
}

/**
 * Sync ao abrir: não bloqueia a UI; avisa suavemente se houver mensagemAmigavel.
 */
function sincronizarAoAbrirCentralSuave() {
    const token = localStorage.getItem('token');
    return fetch(`${API_URL}/central-entradas/sincronizar-ao-abrir`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        }
    })
        .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (data && data.sucesso === false && data.mensagemAmigavel) {
                showNotification(data.mensagemAmigavel, 'warning');
            }
            return data;
        })
        .catch(() => null);
}

async function carregarLogCentral() {
    const tbody = document.getElementById('centralLogBody');
    if (!tbody) return;

    const busca = document.getElementById('centralLogBusca')?.value?.trim() || '';
    const tipo = document.getElementById('centralLogTipo')?.value || '';

    try {
        const resultado = await centralEntradasFetch(`/eventos?limite=50${tipo ? `&tipo=${encodeURIComponent(tipo)}` : ''}${busca ? `&busca=${encodeURIComponent(busca)}` : ''}`);
        centralEntradasState.eventosLog = resultado.eventos || [];
        centralEntradasState.eventosTotal = resultado.total || 0;

        if (!centralEntradasState.eventosLog.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Nenhum evento registrado.</td></tr>';
            return;
        }

        tbody.innerHTML = centralEntradasState.eventosLog.map((ev) => `
            <tr>
                <td class="small">${escapeHtmlCentralEntradas(formatarDataHoraCentral(ev.createdAt))}</td>
                <td><span class="badge bg-secondary">${escapeHtmlCentralEntradas(ev.tipo)}</span></td>
                <td class="small">${escapeHtmlCentralEntradas(ev.origem || '—')}</td>
                <td>${escapeHtmlCentralEntradas(ev.descricao || '—')}</td>
                <td class="small">${ev.duracaoMs != null ? ev.duracaoMs + ' ms' : '—'}</td>
                <td>${ev.sucesso === true ? '<span class="text-success">OK</span>' : (ev.sucesso === false ? '<span class="text-danger">Erro</span>' : '—')}</td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-danger">${escapeHtmlCentralEntradas(error.message)}</td></tr>`;
    }
}

async function pollNotificacoesCentral() {
    if (!document.getElementById('centralUx1Header')) return;

    try {
        const { notificacoes, total } = await centralEntradasFetch('/notificacoes?apenas_nao_lidas=true&limite=10');
        centralEntradasState.notificacoesNaoLidas = total ?? (notificacoes || []).length;
        renderCabecalhoUx1Central();

        (notificacoes || []).forEach((n) => {
            if (centralEntradasState.notificacoesVistas.has(n.id)) return;
            centralEntradasState.notificacoesVistas.add(n.id);
            const tipo = n.tipo === 'SYNC_ERRO' || n.tipo === 'ERRO' ? 'danger'
                : (n.tipo === 'NOVAS_NOTAS' ? 'success' : 'info');
            showNotification(n.titulo + (n.mensagem ? ': ' + n.mensagem : ''), tipo);
            centralEntradasFetch(`/notificacoes/${n.id}/lida`, { method: 'PATCH' }).catch(() => {});
        });
    } catch { /* ignore */ }
}

function iniciarAutomacaoCentral() {
    if (centralEntradasState.tickerServico) clearInterval(centralEntradasState.tickerServico);
    if (centralEntradasState.tickerNotificacoes) clearInterval(centralEntradasState.tickerNotificacoes);
    if (centralEntradasState.tickerLiveUx) clearInterval(centralEntradasState.tickerLiveUx);
    if (centralEntradasState.tickerSoftDoc) clearInterval(centralEntradasState.tickerSoftDoc);

    carregarStatusServicoCentral();
    pollNotificacoesCentral();
    carregarContagemNotificacoesCentral();

    centralEntradasState.tickerServico = setInterval(() => {
        if (document.getElementById('centralUx1Header')) {
            carregarStatusServicoCentral();
            const srv = document.getElementById('centralUx1Servicos');
            if (srv) srv.innerHTML = renderStatusServicosRodapeUx1();
        } else {
            clearInterval(centralEntradasState.tickerServico);
            centralEntradasState.tickerServico = null;
        }
    }, 30000);

    centralEntradasState.tickerNotificacoes = setInterval(() => {
        if (document.getElementById('centralUx1Header')) {
            pollNotificacoesCentral();
            carregarEventosRodapeCentral();
        } else {
            clearInterval(centralEntradasState.tickerNotificacoes);
            centralEntradasState.tickerNotificacoes = null;
        }
    }, 45000);

    // RC7.5 — countdown / tempo aguardando (sem reload da tabela)
    centralEntradasState.tickerLiveUx = setInterval(() => {
        if (!document.getElementById('centralUx1Header')) {
            clearInterval(centralEntradasState.tickerLiveUx);
            centralEntradasState.tickerLiveUx = null;
            return;
        }
        tickLiveUxCentral();
    }, 1000);

    centralEntradasState.tickerSoftDoc = setInterval(() => {
        if (!document.getElementById('centralUx1Header')) {
            clearInterval(centralEntradasState.tickerSoftDoc);
            centralEntradasState.tickerSoftDoc = null;
            return;
        }
        softRefreshDocumentoSelecionadoCentral();
    }, 20000);
}

function iniciarTickerSincronizacao() {
    if (centralEntradasState.tickerSync) clearInterval(centralEntradasState.tickerSync);
    centralEntradasState.tickerSync = setInterval(() => {
        if (document.getElementById('centralUx1Header')) {
            renderCabecalhoUx1Central();
        } else {
            clearInterval(centralEntradasState.tickerSync);
            centralEntradasState.tickerSync = null;
        }
    }, 60000);
}

/* ============================================================
 * Grid
 * ============================================================ */

function montarOptionsStatusCentral(statusSelecionado) {
    const estados = centralEntradasState.metadados?.estados || [];
    const options = ['<option value="">Todos</option>'];
    estados.forEach((estado) => {
        const selected = statusSelecionado === estado.codigo ? 'selected' : '';
        options.push(`<option value="${escapeHtmlCentralEntradas(estado.codigo)}" ${selected}>${escapeHtmlCentralEntradas(estado.label)}</option>`);
    });
    return options.join('');
}

function obterFiltrosCentralDaTela() {
    return {
        busca: document.getElementById('centralFiltroBusca')?.value?.trim() || '',
        status: document.getElementById('centralFiltroStatus')?.value || '',
        origem: document.getElementById('centralFiltroOrigem')?.value || '',
        dataEmissaoInicio: document.getElementById('centralFiltroDataInicio')?.value || '',
        dataEmissaoFim: document.getElementById('centralFiltroDataFim')?.value || '',
        filtroRapido: centralEntradasState.filtroRapidoAtivo || ''
    };
}

function renderGridCentralEntradas() {
    const lista = document.getElementById('centralEntradasListaDocs');
    const tbody = document.getElementById('centralEntradasGridBody');
    const container = lista || tbody;
    const contador = document.getElementById('centralEntradasContador');
    if (!container) return;

    if (centralEntradasState.carregando) {
        if (lista) {
            container.innerHTML = centralUx().renderSkeletonListaDocumentosCentral?.(6) || '';
        } else {
            container.innerHTML = centralUx().renderSkeletonGridCentral?.(8) || '';
        }
        if (contador) contador.textContent = 'Carregando...';
        return;
    }

    const filtros = obterFiltrosCentralDaTela();
    const temFiltro = !!(filtros.busca || filtros.status || filtros.origem
        || filtros.dataEmissaoInicio || filtros.dataEmissaoFim || filtros.filtroRapido);

    if (!centralEntradasState.documentos.length) {
        const emptyTipo = temFiltro ? 'pesquisa' : 'documentos';
        container.innerHTML = centralUx().renderEmptyStateCentral?.(emptyTipo) || '';
    } else if (lista) {
        const UX = centralUx();
        container.innerHTML = centralEntradasState.documentos.map((doc) => {
            const selecionado = centralEntradasState.documentoSelecionadoId === doc.id ? 'central-ux1-doc-card--selected' : '';
            const numero = doc.numero ? `${doc.numero}${doc.serie ? '/' + doc.serie : ''}` : '—';
            const avatar = UX.avatarFornecedorCentral?.(doc.fornecedor) || { iniciais: '?', cor: '#94a3b8' };
            const badge = UX.badgeStatusUx1?.(doc.status, doc.statusLabel) || renderBadgeStatusCentral(doc.status, doc.statusLabel);
            const miipBadge = doc.miipDisponivel
                ? '<span class="central-ux1-badge-miip" title="Processado pelo MIIP"><i class="fas fa-brain"></i> MIIP</span>'
                : '';
            const dt = obterDataExibicaoDocumentoCentral(doc);

            return `
                <div class="central-ux1-doc-card ${selecionado} central-entradas-row"
                     data-documento-id="${doc.id}"
                     tabindex="0"
                     role="button"
                     aria-label="Documento ${escapeHtmlCentralEntradas(doc.fornecedor || 'sem fornecedor')}, NF ${escapeHtmlCentralEntradas(numero)}">
                    <span class="central-ux1-doc-avatar" style="background:${escapeHtmlCentralEntradas(avatar.cor)}" aria-hidden="true">${escapeHtmlCentralEntradas(avatar.iniciais)}</span>
                    <div class="central-ux1-doc-info">
                        <div class="central-ux1-doc-fornecedor">${escapeHtmlCentralEntradas(doc.fornecedor || '—')}</div>
                        <div class="central-ux1-doc-meta">
                            <span title="Número da NF"><i class="fas fa-file-invoice me-1"></i>${escapeHtmlCentralEntradas(numero)}</span>
                            <span title="Data"><i class="far fa-calendar me-1"></i>${escapeHtmlCentralEntradas(dt.data)} ${escapeHtmlCentralEntradas(dt.hora)}</span>
                            <span title="Origem"><i class="fas ${iconeOrigemCentral(doc.origem)} me-1"></i>${escapeHtmlCentralEntradas(labelOrigemCentral(doc.origem))}</span>
                        </div>
                    </div>
                    <div class="central-ux1-doc-acoes">
                        <div class="central-ux1-doc-valor">${escapeHtmlCentralEntradas(formatarMoedaCentral(doc.valorTotal))}</div>
                        ${badge}
                        ${miipBadge}
                        <button type="button" class="btn btn-sm btn-outline-primary central-doc-detalhe-btn" data-doc-id="${doc.id}" title="Ver detalhes">
                            <i class="fas fa-chevron-right"></i>
                        </button>
                    </div>
                </div>`;
        }).join('');
    } else {
        container.innerHTML = centralEntradasState.documentos.map((doc) => {
            const meta = metaStatusCentral(doc.status);
            const selecionado = centralEntradasState.documentoSelecionadoId === doc.id ? 'central-entradas-row-selected' : '';
            const numero = doc.numero ? `${doc.numero}${doc.serie ? '/' + doc.serie : ''}` : '—';
            const miipBadge = doc.miipDisponivel
                ? '<span class="central-entradas-badge-miip" title="Processado pelo MIIP"><i class="fas fa-brain"></i> MIIP</span>'
                : '';

            return `
                <tr class="central-entradas-row ${selecionado}" data-documento-id="${doc.id}"
                    style="--row-cor:${meta.cor}"
                    tabindex="0"
                    role="button"
                    aria-label="Documento ${escapeHtmlCentralEntradas(doc.fornecedor || 'sem fornecedor')}, ${escapeHtmlCentralEntradas(numero)}">
                    <td class="central-entradas-cell-status">
                        <span class="central-entradas-status-dot" style="background:${meta.bg}; color:${meta.cor}"
                              title="${escapeHtmlCentralEntradas(meta.descricao)}">
                            <i class="fas ${meta.icone}"></i>
                        </span>
                    </td>
                    <td>
                        <div class="central-entradas-fornecedor">${escapeHtmlCentralEntradas(doc.fornecedor || '—')}</div>
                        <small class="text-muted">${escapeHtmlCentralEntradas(doc.cnpjFornecedor || '')}</small>
                    </td>
                    <td>
                        <div class="fw-semibold">${escapeHtmlCentralEntradas(numero)}</div>
                        <small class="text-muted"><i class="fas ${iconeOrigemCentral(doc.origem)} me-1"></i>${escapeHtmlCentralEntradas(labelOrigemCentral(doc.origem))}</small>
                    </td>
                    <td>${escapeHtmlCentralEntradas(obterDataExibicaoDocumentoCentral(doc).data)}</td>
                    <td class="fw-semibold">${escapeHtmlCentralEntradas(formatarMoedaCentral(doc.valorTotal))}</td>
                    <td>${renderScoreBadgeCentral(doc.scoreGeral, doc.scoreCor)}</td>
                    <td>
                        ${renderBadgeStatusCentral(doc.status, doc.statusLabel)}
                        ${miipBadge}
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (contador) {
        contador.textContent = `${centralEntradasState.total} documento${centralEntradasState.total === 1 ? '' : 's'}`;
    }

    renderPaginacaoCentral();
    renderRodapeUx1Central();
}

function renderPaginacaoCentral() {
    const container = document.getElementById('centralEntradasPaginacao');
    if (!container) return;

    const { pagina, totalPaginas, total } = centralEntradasState;
    if (total <= 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <div class="d-flex justify-content-between align-items-center px-3 py-2 border-top">
            <small class="text-muted">
                Página ${pagina} de ${totalPaginas}
            </small>
            <div class="btn-group btn-group-sm">
                <button type="button" class="btn btn-outline-secondary" id="centralPaginaAnterior"
                    ${pagina <= 1 ? 'disabled' : ''}>
                    <i class="fas fa-chevron-left"></i> Anterior
                </button>
                <button type="button" class="btn btn-outline-secondary" id="centralPaginaProxima"
                    ${pagina >= totalPaginas ? 'disabled' : ''}>
                    Próxima <i class="fas fa-chevron-right"></i>
                </button>
            </div>
        </div>
    `;
}

/* ============================================================
 * Painel lateral — abas
 * ============================================================ */

function renderPainelLateralPlaceholder() {
    const painel = document.getElementById('centralEntradasPainelLateral');
    if (!painel) return;

    painel.innerHTML = `
        <div class="central-ux1-painel h-100">
            <div class="card-body d-flex flex-column justify-content-center flex-grow-1">
                ${centralUx().renderEmptyStateCentral?.('selecao', {
                    descricao: 'Selecione um documento na lista para ver detalhes, produtos, timeline e MIIP.'
                }) || ''}
            </div>
        </div>
    `;
}

const CENTRAL_TIMELINE_ICONES = {
    SINCRONIZADA: { icone: 'fa-cloud-download-alt', cor: '#0d6efd' },
    EM_PROCESSAMENTO: { icone: 'fa-cog', cor: '#f59e0b' },
    AGUARDANDO_REVISAO: { icone: 'fa-user-check', cor: '#fd7e14' },
    AGUARDANDO_XML_COMPLETO: { icone: 'fa-file-import', cor: '#64748b' },
    REVISADA: { icone: 'fa-clipboard-check', cor: '#0dcaf0' },
    PRONTA_PARA_COMPRA: { icone: 'fa-check-circle', cor: '#198754' },
    EM_COMPRA: { icone: 'fa-shopping-cart', cor: '#6610f2' },
    GRAVADA: { icone: 'fa-archive', cor: '#6c757d' },
    DUPLICADA: { icone: 'fa-copy', cor: '#dc3545' },
    ERRO: { icone: 'fa-exclamation-triangle', cor: '#dc3545' },
    DESCARTADA: { icone: 'fa-trash-alt', cor: '#212529' }
};

function renderTimelineCentral(historico) {
    const UX = centralUx();

    if (!historico || !historico.length) {
        return UX.renderEmptyStateCentral?.('historico') || '<p class="text-muted small mb-0">Nenhum evento registrado.</p>';
    }

    return `
        <div class="central-entradas-timeline-enterprise" role="list" aria-label="Histórico do documento">
            ${historico.map((item) => {
                const meta = CENTRAL_TIMELINE_ICONES[item.statusNovo] || { icone: 'fa-circle', cor: '#94a3b8' };
                const dt = UX.formatarDataHoraSeparadoCentral?.(item.createdAt) || { data: '—', hora: '—' };
                const origem = UX.inferirOrigemTimelineCentral?.(item) || 'Sistema';
                const usuario = item.usuarioId ? `Usuário #${item.usuarioId}` : 'Sistema automático';
                const descricao = item.detalhe
                    || (item.statusAnteriorLabel
                        ? `Transição de ${item.statusAnteriorLabel} para ${item.statusNovoLabel || item.statusNovo}`
                        : `Status definido como ${item.statusNovoLabel || item.statusNovo}`);

                return `
                <div class="central-entradas-timeline-enterprise-item central-entradas-anim-in" role="listitem"
                     style="--tl-cor:${meta.cor}">
                    <div class="central-entradas-timeline-enterprise-marker" aria-hidden="true">
                        <span class="central-entradas-timeline-enterprise-icone" style="background:${meta.cor}1a; color:${meta.cor}">
                            <i class="fas ${meta.icone}"></i>
                        </span>
                    </div>
                    <div class="central-entradas-timeline-enterprise-card">
                        <div class="central-entradas-timeline-enterprise-top">
                            <strong class="central-entradas-timeline-enterprise-status">
                                ${item.statusAnteriorLabel
                                    ? `<span class="text-muted">${escapeHtmlCentralEntradas(item.statusAnteriorLabel)}</span>
                                       <i class="fas fa-arrow-right mx-1 small text-muted" aria-hidden="true"></i>`
                                    : ''}
                                ${escapeHtmlCentralEntradas(item.statusNovoLabel || item.statusNovo)}
                            </strong>
                            <div class="central-entradas-timeline-enterprise-datahora" title="${escapeHtmlCentralEntradas(formatarDataHoraCentral(item.createdAt))}">
                                <span class="central-entradas-timeline-enterprise-data">${escapeHtmlCentralEntradas(dt.data)}</span>
                                <span class="central-entradas-timeline-enterprise-hora">${escapeHtmlCentralEntradas(dt.hora)}</span>
                            </div>
                        </div>
                        <div class="central-entradas-timeline-enterprise-descricao">${escapeHtmlCentralEntradas(descricao)}</div>
                        <div class="central-entradas-timeline-enterprise-meta">
                            <span title="Usuário responsável"><i class="far fa-user me-1" aria-hidden="true"></i>${escapeHtmlCentralEntradas(usuario)}</span>
                            <span title="Origem do evento"><i class="fas fa-route me-1" aria-hidden="true"></i>${escapeHtmlCentralEntradas(origem)}</span>
                        </div>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;
}

function renderAcoesPipelineCentral(doc) {
    const processando = centralEntradasState.processando;
    const etapa = centralEntradasState.etapaProcessamento;

    const etapasPadrao = [
        { codigo: 'localizar', label: 'Localizar documento' },
        { codigo: 'parse', label: 'Parser NF-e' },
        { codigo: 'miip', label: 'Identificação MIIP' },
        { codigo: 'persistir', label: 'Persistir resultados' },
        { codigo: 'status', label: 'Atualizar status' }
    ];

    const progressoHtml = processando || etapa
        ? `<div class="central-entradas-pipeline-progress mb-2">
            ${etapasPadrao.map((e) => {
                const ativa = etapa === e.codigo;
                const concluida = etapa === 'concluido' || (etapa && etapasPadrao.findIndex((x) => x.codigo === etapa) > etapasPadrao.findIndex((x) => x.codigo === e.codigo));
                return `<div class="central-entradas-pipeline-step ${ativa ? 'ativa' : ''} ${concluida ? 'concluida' : ''}">
                    <i class="fas ${concluida ? 'fa-check-circle' : ativa ? 'fa-spinner fa-spin' : 'fa-circle'} me-1"></i>
                    ${escapeHtmlCentralEntradas(e.label)}
                </div>`;
            }).join('')}
           </div>`
        : '';

    const podeProcessar = doc.status === 'SINCRONIZADA' && !processando;
    const aguardandoRevisao = doc.status === 'AGUARDANDO_REVISAO';

    let acoesHtml = '';
    if (doc.status === 'AGUARDANDO_XML_COMPLETO') {
        acoesHtml += `<button type="button" class="btn btn-outline-primary btn-sm w-100 mb-2" id="centralBtnSolicitarXmlCompleto" data-doc-id="${doc.id}" title="Enviar Ciência da Emissão e consultar o XML completo">
            <i class="fas fa-file-import me-1"></i> Solicitar XML completo
        </button>`;
    }
    if (podeProcessar) {
        acoesHtml += `<button type="button" class="btn btn-primary btn-sm w-100 mb-2" id="centralBtnProcessar" data-doc-id="${doc.id}" title="Executar pipeline Parser → MIIP">
            <i class="fas fa-cogs me-1"></i> Processar documento
        </button>`;
    }
    if (aguardandoRevisao && typeof MiipCentralRevisao !== 'undefined') {
        acoesHtml += `<button type="button" class="btn btn-warning btn-sm w-100 mb-2" id="centralBtnRevisarMiip" data-doc-id="${doc.id}" title="Abrir Central de Revisão MIIP">
            <i class="fas fa-search me-1"></i> Abrir Central de Revisão
        </button>`;
    }

    return progressoHtml + (acoesHtml || '');
}

function renderAbaResumoCentral(doc) {
    const UX = centralUx();
    const meta = metaStatusCentral(doc.status);
    const detalhe = centralEntradasState.detalheAtual;
    const wait = doc.xmlWait || detalhe?.documento?.xmlWait || null;
    const sefaz = detalhe?.sefazOperacional || centralEntradasState.sefazOperacional || {};
    const exec = UX.extrairDadosExecutivoCentral?.(
        doc,
        centralEntradasState.parseAtual,
        centralEntradasState.parseAtual,
        detalhe?.historico
    ) || {};

    const gaugeHtml = UX.renderGaugeScoreCentral
        ? `<div class="text-center mb-3">${UX.renderGaugeScoreCentral(doc.scoreGeral, doc.scoreCor, { tamanho: 108 })}</div>`
        : '';

    const modelo = UX.montarEtapasOperacionaisCentral?.(doc, detalhe?.historico, wait) || null;
    const barraHtml = modelo && UX.renderBarraProgressoOperacionalCentral
        ? UX.renderBarraProgressoOperacionalCentral(modelo)
        : '';
    const timelineOpHtml = modelo && UX.renderTimelineOperacionalCentral
        ? `<div class="mb-3"><label class="central-entradas-label">Linha do tempo operacional</label>${UX.renderTimelineOperacionalCentral(modelo)}</div>`
        : '';
    const cardXmlHtml = UX.renderCardXmlWaitOperacionalCentral?.(doc, wait, {
        ultimoCStat: sefaz.ultimoCStat,
        backoffLabel: sefaz.backoffAtual || sefaz.backoffAtualLabel
    }) || '';
    const chipHtml = UX.renderChipEtapaCentral?.(UX.resolverChipEtapaCentral?.(doc, wait)) || '';
    const techHtml = UX.renderInfoTecnicasRecolhivelCentral?.({
        doc,
        wait,
        sefaz,
        statusBg: centralEntradasState.statusServico || {}
    }) || '';

    const descricaoResumo = doc.status === 'AGUARDANDO_XML_COMPLETO'
        ? (UX.mensagemAmigavelCentral?.('AGUARDANDO_XML_COMPLETO')
            || 'Aguardando a disponibilização do XML completo pela SEFAZ.')
        : (doc.status === 'ERRO'
            ? (UX.mensagemAmigavelCentral?.('ERRO') || meta.descricao)
            : meta.descricao);

    return `
        ${gaugeHtml}

        <div class="mb-2 d-flex flex-wrap gap-2 align-items-center">${chipHtml}</div>

        ${cardXmlHtml}

        ${barraHtml ? `<div class="mb-3">${barraHtml}</div>` : ''}

        ${timelineOpHtml}

        <div class="central-entradas-resumo-executivo mb-3 central-entradas-anim-in"
             style="border-left-color:${meta.cor}; background:${meta.bg}">
            <div class="d-flex align-items-center gap-2 mb-1">
                <i class="fas ${meta.icone}" style="color:${meta.cor}" aria-hidden="true"></i>
                <strong>${escapeHtmlCentralEntradas(obterLabelStatusCentral(doc.status))}</strong>
            </div>
            <div class="small text-muted">${escapeHtmlCentralEntradas(descricaoResumo)}</div>
        </div>

        ${techHtml}

        <div class="central-entradas-painel-executivo mb-3">
            <label class="central-entradas-label">Painel executivo</label>
            <div class="row g-2 central-entradas-exec-grid">
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Fornecedor emissor da NF-e">
                        <i class="fas fa-building" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Fornecedor</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.fornecedor)}</span>
                            <small class="text-muted">${escapeHtmlCentralEntradas(exec.cnpjFornecedor)}</small>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Transporte / frete na nota">
                        <i class="fas fa-truck" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Transportadora</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.transportadora)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Volumes e unidades">
                        <i class="fas fa-boxes" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Volumes</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.volumes)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Peso bruto (quando disponível no XML)">
                        <i class="fas fa-weight-hanging" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Peso</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.peso)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Condição de pagamento">
                        <i class="fas fa-credit-card" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Pagamento</span>
                            <span class="central-entradas-exec-valor text-truncate d-block">${escapeHtmlCentralEntradas(exec.pagamento)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Valor total da nota">
                        <i class="fas fa-coins" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Valor total</span>
                            <span class="central-entradas-exec-valor text-success fw-semibold">${escapeHtmlCentralEntradas(formatarMoedaCentral(exec.valorTotal ?? doc.valorTotal))}</span>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Quantidade de itens">
                        <i class="fas fa-list-ol" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Itens</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.qtdItens)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-6">
                    <div class="central-entradas-exec-item" title="Precisão da identificação MIIP">
                        <i class="fas fa-brain" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Precisão MIIP</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.precisaoMiip)}</span>
                        </div>
                    </div>
                </div>
                <div class="col-12">
                    <div class="central-entradas-exec-item" title="Tempo entre início e conclusão do processamento">
                        <i class="fas fa-stopwatch" aria-hidden="true"></i>
                        <div>
                            <span class="central-entradas-exec-label">Tempo de processamento</span>
                            <span class="central-entradas-exec-valor">${escapeHtmlCentralEntradas(exec.tempoProcessamento)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="row g-2 mb-3">
            <div class="col-6">
                <label class="central-entradas-label">Número / Série</label>
                <div>${escapeHtmlCentralEntradas(doc.numero || '—')}${doc.serie ? '/' + escapeHtmlCentralEntradas(doc.serie) : ''}</div>
            </div>
            <div class="col-6">
                <label class="central-entradas-label">Emissão</label>
                <div>${escapeHtmlCentralEntradas(obterDataExibicaoDocumentoCentral(doc).data)}</div>
            </div>
        </div>

        <div class="mb-3">
            <label class="central-entradas-label">Origem</label>
            <div><i class="fas ${iconeOrigemCentral(doc.origem)} me-1 text-muted" aria-hidden="true"></i>${escapeHtmlCentralEntradas(labelOrigemCentral(doc.origem))}</div>
        </div>

        <div class="mb-3">
            <label class="central-entradas-label">Chave de acesso</label>
            <div class="central-entradas-chave">${escapeHtmlCentralEntradas(doc.chave || '—')}</div>
        </div>

        <div class="central-entradas-divider"></div>
        <label class="central-entradas-label">Ações do pipeline</label>
        ${renderAcoesPipelineCentral(doc) || '<div class="text-muted small">Nenhuma ação disponível para este status.</div>'}
        ${renderStatsFornecedorCentral()}
    `;
}

function renderAbaItensCentral() {
    const parse = centralEntradasState.parseAtual?.parse;
    if (!parse) {
        return '<div class="text-muted small py-3 text-center"><i class="fas fa-hourglass-half me-1"></i> Documento ainda não processado.<br>Os itens ficam disponíveis após o processamento.</div>';
    }

    const itens = parse.itens || [];
    if (!itens.length) {
        return '<div class="text-muted small py-3 text-center">Nenhum item no parse.</div>';
    }

    return `
        <div class="central-entradas-itens-lista">
            ${itens.map((item, i) => `
                <div class="central-entradas-item-card central-entradas-anim-in">
                    <div class="d-flex justify-content-between align-items-start">
                        <div class="central-entradas-item-nome">
                            <span class="central-entradas-item-indice">${i + 1}</span>
                            ${escapeHtmlCentralEntradas(item.produto_nome || '—')}
                        </div>
                        ${item.produto_id
                            ? '<span class="central-entradas-badge-vinculado" title="Produto identificado"><i class="fas fa-link"></i></span>'
                            : '<span class="central-entradas-badge-pendente" title="Produto não identificado"><i class="fas fa-question"></i></span>'}
                    </div>
                    <div class="central-entradas-item-meta">
                        ${item.codigo_barras ? `<span><i class="fas fa-barcode me-1"></i>${escapeHtmlCentralEntradas(item.codigo_barras)}</span>` : ''}
                        <span>${escapeHtmlCentralEntradas(item.quantidade || 0)} ${escapeHtmlCentralEntradas(item.unidade || 'UN')}</span>
                        <span>${escapeHtmlCentralEntradas(formatarMoedaCentral(item.preco_unitario))}</span>
                        <span class="fw-semibold">${escapeHtmlCentralEntradas(formatarMoedaCentral(item.subtotal))}</span>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderAbaTimelineCentral(detalhe) {
    const UX = centralUx();
    const doc = detalhe.documento;
    const wait = doc?.xmlWait || null;
    const modelo = UX.montarEtapasOperacionaisCentral?.(doc, detalhe.historico, wait);
    const op = modelo && UX.renderTimelineOperacionalCentral
        ? `<div class="mb-3">${UX.renderBarraProgressoOperacionalCentral?.(modelo) || ''}${UX.renderTimelineOperacionalCentral(modelo)}</div>`
        : '';
    const legado = UX.renderPipelineTimelineUx1?.(doc, detalhe.historico)
        || renderTimelineCentral(detalhe.historico);
    return op + legado;
}

function renderPainelSaudeSefazUxCentral() {
    const wrap = document.getElementById('centralRc75SaudeWrap');
    if (!wrap) return;
    const UX = centralUx();
    if (!UX.renderPainelSaudeSefazCentral) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = UX.renderPainelSaudeSefazCentral(
        centralEntradasState.sefazOperacional || {},
        centralEntradasState.servicoStatus || centralEntradasState.statusServico || {}
    );
}

/** RC7.5 — atualiza countdown/tempo sem redesenhar tabela. */
function tickLiveUxCentral() {
    const UX = centralUx();
    if (!UX.atualizarLiveRegionsCentral) return;
    const painel = document.getElementById('centralEntradasPainelLateral');
    const saude = document.getElementById('centralRc75SaudeWrap');
    if (painel) UX.atualizarLiveRegionsCentral(painel);
    if (saude) UX.atualizarLiveRegionsCentral(saude);
}

/** Soft refresh só do documento selecionado (AGUARDANDO_XML). */
async function softRefreshDocumentoSelecionadoCentral() {
    const id = centralEntradasState.documentoSelecionadoId;
    if (!id || !document.getElementById('centralUx1Header')) return;
    const doc = centralEntradasState.detalheAtual?.documento;
    if (!doc || doc.status !== 'AGUARDANDO_XML_COMPLETO') return;
    if (centralEntradasState.softRefreshEmAndamento) return;
    centralEntradasState.softRefreshEmAndamento = true;
    try {
        const detalhe = await centralEntradasFetch(`/${id}`);
        if (centralEntradasState.documentoSelecionadoId !== id) return;
        centralEntradasState.detalheAtual = {
            ...centralEntradasState.detalheAtual,
            ...detalhe,
            documento: {
                ...(centralEntradasState.detalheAtual?.documento || {}),
                ...(detalhe.documento || {})
            }
        };
        if (detalhe.sefazOperacional) {
            centralEntradasState.sefazOperacional = detalhe.sefazOperacional;
            renderPainelSaudeSefazUxCentral();
        }
        // Atualização parcial: só aba resumo / timeline se ativas
        if (['resumo', 'timeline'].includes(centralEntradasState.abaAtiva)) {
            const corpo = document.getElementById('centralEntradasAbaConteudo')
                || document.querySelector('.central-ux1-painel-body');
            if (corpo && centralEntradasState.detalheAtual) {
                // Re-render apenas o painel lateral (documento único), sem grid.
                renderPainelLateralCentral(centralEntradasState.detalheAtual);
            }
        } else {
            // Atualiza só o card XML live se existir no DOM
            const card = document.getElementById('centralRc75XmlCard');
            if (card && centralEntradasState.detalheAtual) {
                renderPainelLateralCentral(centralEntradasState.detalheAtual);
            }
        }
    } catch { /* ignore soft refresh */ }
    finally {
        centralEntradasState.softRefreshEmAndamento = false;
    }
}

function renderAbaMiipCentral(doc) {
    const miip = centralEntradasState.parseAtual?.miipResumo;
    const exec = centralUx().extrairDadosExecutivoCentral?.(
        doc,
        centralEntradasState.parseAtual,
        centralEntradasState.parseAtual,
        centralEntradasState.detalheAtual?.historico
    ) || {};

    if (!doc.parseDisponivel) {
        return '<div class="text-muted small py-3 text-center"><i class="fas fa-brain me-1"></i> O MIIP é executado durante o processamento do documento.</div>';
    }

    if (!miip?.resumo) {
        return '<div class="text-muted small py-3 text-center"><i class="fas fa-info-circle me-1"></i> Parse concluído sem dados MIIP (motor indisponível no momento do processamento).</div>';
    }

    const r = miip.resumo;
    const kpis = [
        { label: 'Produtos reconhecidos', valor: r.identificadosAutomaticamente ?? 0, icone: 'fa-magic', cor: '#198754' },
        { label: 'Para confirmar', valor: r.precisamConfirmacao ?? 0, icone: 'fa-user-check', cor: '#fd7e14' },
        { label: 'Produtos novos', valor: r.precisamCadastro ?? 0, icone: 'fa-plus-circle', cor: '#dc3545' },
        { label: 'Itens na nota', valor: r.totalItens ?? 0, icone: 'fa-list', cor: '#0d6efd' }
    ];

    const precisao = r.totalItens > 0
        ? Math.round(((r.identificadosAutomaticamente || 0) / r.totalItens) * 100)
        : 0;

    return `
        <div class="central-entradas-miip-precisao mb-3 central-entradas-anim-in">
            <div class="d-flex justify-content-between small mb-1">
                <span><i class="fas fa-brain me-1 text-primary"></i> Precisão MIIP</span>
                <strong>${precisao}%</strong>
            </div>
            <div class="progress" style="height:8px">
                <div class="progress-bar bg-primary" style="width:${precisao}%"></div>
            </div>
        </div>
        <div class="central-entradas-miip-kpis">
            ${kpis.map((k) => `
                <div class="central-entradas-miip-kpi central-entradas-anim-in" style="--miip-cor:${k.cor}">
                    <i class="fas ${k.icone}"></i>
                    <div class="central-entradas-miip-kpi-valor">${escapeHtmlCentralEntradas(k.valor)}</div>
                    <div class="central-entradas-miip-kpi-label">${escapeHtmlCentralEntradas(k.label)}</div>
                </div>
            `).join('')}
        </div>
        <div class="mt-3 small">
            <div class="d-flex justify-content-between py-1 border-bottom">
                <span class="text-muted">Tempo processamento</span>
                <strong>${escapeHtmlCentralEntradas(exec.tempoProcessamento || '—')}</strong>
            </div>
            <div class="d-flex justify-content-between py-1">
                <span class="text-muted">Motores utilizados</span>
                <strong>Parser · MIIP</strong>
            </div>
        </div>
        ${miip.operacaoId ? `<div class="small text-muted mt-2"><i class="fas fa-fingerprint me-1"></i>Sessão: ${escapeHtmlCentralEntradas(miip.operacaoId)}</div>` : ''}
    `;
}

function renderAbaXmlCentral(doc) {
    if (!doc.xmlDisponivel) {
        return '<div class="text-muted small py-3 text-center">XML indisponível para este documento.</div>';
    }

    if (centralEntradasState.xmlAtual === null) {
        return `
            <div class="text-center py-3">
                <button type="button" class="btn btn-outline-primary btn-sm" id="centralBtnCarregarXml" data-doc-id="${doc.id}">
                    <i class="fas fa-code me-1"></i> Carregar XML original
                </button>
            </div>
        `;
    }

    const ehResumo = doc.tipoDocumento === 'RES_NFE'
      || (doc.status === 'AGUARDANDO_XML_COMPLETO' && doc.tipoDocumento !== 'PROC_NFE' && doc.tipoDocumento !== 'NFE');
    return `
        <div class="d-flex justify-content-end mb-2">
            <button type="button" class="btn btn-outline-secondary btn-sm" id="centralBtnExportarXmlPainel" data-doc-id="${doc.id}" data-download-kind="${ehResumo ? 'resumo' : 'completo'}">
                <i class="fas fa-download me-1"></i> ${ehResumo ? 'Baixar Resumo' : 'Baixar XML Completo'}
            </button>
        </div>
        <pre class="central-entradas-xml-viewer">${escapeHtmlCentralEntradas(centralEntradasState.xmlAtual)}</pre>
    `;
}

function renderAbaCompraCentral(doc) {
    if (doc.compraVinculada) {
        return `
            <div class="central-entradas-compra-ok central-entradas-anim-in">
                <i class="fas fa-check-circle"></i>
                <div>
                    <strong>Compra concluída</strong>
                    <div class="small text-muted">Documento vinculado à compra <strong>#${escapeHtmlCentralEntradas(doc.compraId)}</strong>.</div>
                    <div class="small text-muted">Estoque e financeiro atualizados pela tela de Compras.</div>
                </div>
            </div>
        `;
    }

    const podeAbrir = ['PRONTA_PARA_COMPRA', 'EM_COMPRA', 'REVISADA'].includes(doc.status) && doc.parseDisponivel;

    return `
        <div class="text-muted small mb-3">
            O lançamento é feito na tela oficial de Compras, com o formulário pré-preenchido.
            O usuário pode ajustar produtos, valores, pagamento e fornecedor antes de salvar.
        </div>
        ${podeAbrir
            ? `<button type="button" class="btn btn-success btn-sm w-100" id="centralBtnAbrirCompra" data-doc-id="${doc.id}">
                <i class="fas fa-shopping-cart me-1"></i> Abrir em Compras
            </button>`
            : `<div class="alert alert-light small py-2 mb-0"><i class="fas fa-lock me-1"></i>Disponível quando o documento estiver pronto para compra.</div>`}
    `;
}

function renderConteudoAbaCentral(detalhe) {
    const doc = detalhe.documento;
    switch (centralEntradasState.abaAtiva) {
        case 'itens':
        case 'produtos': return renderAbaItensCentral();
        case 'miip': return renderAbaMiipCentral(doc);
        case 'xml': return renderAbaXmlCentral(doc);
        case 'timeline': return renderAbaTimelineCentral(detalhe);
        case 'historico': return renderTimelineCentral(detalhe.historico);
        case 'compra': return renderAbaCompraCentral(doc);
        default: return renderAbaResumoCentral(doc);
    }
}

function renderCtaImportarCompraCentral(doc) {
    const podeAbrir = ['PRONTA_PARA_COMPRA', 'EM_COMPRA', 'REVISADA'].includes(doc.status) && doc.parseDisponivel;
    if (!podeAbrir) {
        return `<button type="button" class="btn btn-secondary central-ux1-btn-importar" disabled title="Disponível quando a máquina de estados permitir importação">
            <i class="fas fa-lock me-1"></i> IMPORTAR COMPRA
        </button>`;
    }
    return `<button type="button" class="btn btn-success central-ux1-btn-importar" id="centralBtnAbrirCompra" data-doc-id="${doc.id}" title="Importar compra a partir desta NF-e">
        <i class="fas fa-shopping-cart me-1"></i> IMPORTAR COMPRA
    </button>`;
}

function renderPainelLateralCentral(detalhe) {
    const painel = document.getElementById('centralEntradasPainelLateral');
    if (!painel || !detalhe?.documento) return;

    const doc = detalhe.documento;
    const UX = centralUx();
    const exec = UX.extrairDadosExecutivoCentral?.(
        doc,
        centralEntradasState.parseAtual,
        centralEntradasState.parseAtual,
        detalhe.historico
    ) || {};
    const badge = UX.badgeStatusUx1?.(doc.status, doc.statusLabel) || renderBadgeStatusCentral(doc.status, doc.statusLabel);
    const numero = doc.numero ? `${doc.numero}${doc.serie ? '/' + doc.serie : ''}` : '—';

    const abas = [
        { id: 'resumo', label: 'Resumo', icone: 'fa-file-invoice' },
        { id: 'produtos', label: 'Produtos', icone: 'fa-boxes' },
        { id: 'timeline', label: 'Timeline', icone: 'fa-project-diagram' },
        { id: 'miip', label: 'MIIP', icone: 'fa-brain' },
        { id: 'xml', label: 'XML', icone: 'fa-code' },
        { id: 'historico', label: 'Histórico', icone: 'fa-history' }
    ];

    const abaAtiva = centralEntradasState.abaAtiva === 'itens' ? 'produtos' : centralEntradasState.abaAtiva;

    painel.innerHTML = `
        <div class="central-ux1-painel central-entradas-painel-card central-entradas-anim-in">
            <div class="central-ux1-painel-header">
                <div class="d-flex justify-content-between align-items-start gap-2">
                    <div class="text-truncate">
                        <strong>${escapeHtmlCentralEntradas(doc.fornecedor || '—')}</strong>
                        <div class="small text-muted">NF ${escapeHtmlCentralEntradas(numero)}</div>
                    </div>
                    ${badge}
                </div>
                <div class="central-ux1-painel-resumo-chips">
                    <span class="central-ux1-chip" title="Valor total"><i class="fas fa-coins me-1"></i>${escapeHtmlCentralEntradas(formatarMoedaCentral(doc.valorTotal))}</span>
                    <span class="central-ux1-chip" title="Data emissão"><i class="far fa-calendar me-1"></i>${escapeHtmlCentralEntradas(obterDataExibicaoDocumentoCentral(doc).data)}</span>
                    <span class="central-ux1-chip" title="Itens"><i class="fas fa-list me-1"></i>${escapeHtmlCentralEntradas(exec.qtdItens || '—')} itens</span>
                    <span class="central-ux1-chip" title="Peso"><i class="fas fa-weight-hanging me-1"></i>${escapeHtmlCentralEntradas(exec.peso || '—')}</span>
                    <span class="central-ux1-chip" title="Volumes"><i class="fas fa-cubes me-1"></i>${escapeHtmlCentralEntradas(exec.volumes || '—')}</span>
                </div>
            </div>
            <div class="central-entradas-abas" role="tablist" aria-label="Detalhes do documento">
                ${abas.map((aba) => `
                    <button type="button"
                        class="central-entradas-aba ${abaAtiva === aba.id ? 'ativa' : ''}"
                        data-aba="${aba.id}"
                        role="tab"
                        aria-selected="${abaAtiva === aba.id ? 'true' : 'false'}"
                        title="${escapeHtmlCentralEntradas(aba.label)}">
                        <i class="fas ${aba.icone}" aria-hidden="true"></i>
                        <span>${escapeHtmlCentralEntradas(aba.label)}</span>
                    </button>
                `).join('')}
            </div>
            <div class="card-body central-entradas-painel-body flex-grow-1 overflow-auto" role="tabpanel">
                ${renderConteudoAbaCentral(detalhe)}
            </div>
            <div class="central-ux1-painel-cta">
                ${renderCtaImportarCompraCentral(doc)}
            </div>
        </div>
    `;
}

/* ============================================================
 * Ações — sincronização, processamento, revisão, compra
 * ============================================================ */

async function carregarDashboardCentral() {
    const cardsContainer = document.getElementById('centralEntradasCards');

    centralEntradasState.carregandoDashboard = true;
    if (cardsContainer) {
        cardsContainer.className = 'central-ux1-kpis';
        cardsContainer.innerHTML = Array.from({ length: 8 }, () => `
            <div class="central-ux1-kpi central-ux-skeleton-kpi" aria-hidden="true">
                <div class="central-ux-skeleton central-ux-skeleton-circle"></div>
                <div class="flex-grow-1">
                    <div class="central-ux-skeleton central-ux-skeleton-line central-ux-skeleton-line--lg"></div>
                    <div class="central-ux-skeleton central-ux-skeleton-line central-ux-skeleton-line--sm mt-1"></div>
                </div>
            </div>
        `).join('');
    }

    try {
        const dashboard = await centralEntradasFetch('/dashboard');
        centralEntradasState.ultimoDashboardContadores = dashboard.contadores || {};

        centralEntradasState.indicadores = dashboard.indicadores || null;
        centralEntradasState.ultimaSincronizacao = dashboard.ultimaSincronizacao || dashboard.sincronizacao?.dataSincronizacao || null;
        centralEntradasState.sincronizacaoNsu = dashboard.sincronizacao || null;
        centralEntradasState.sefazOperacional = dashboard.sefazOperacional
            || dashboard.xmlWait?.painelOperacional
            || null;

        renderCabecalhoUx1Central();
        renderPainelSaudeSefazUxCentral();

        if (cardsContainer) {
            cardsContainer.className = 'central-ux1-kpis';
            cardsContainer.innerHTML = renderCardsUx1Central(
                dashboard.contadores || {},
                dashboard.indicadores || {},
                centralEntradasState.operacional || {}
            );
        }

        await carregarInteligenciaCentral();

        if (cardsContainer && centralEntradasState.operacional) {
            cardsContainer.className = 'central-ux1-kpis';
            cardsContainer.innerHTML = renderCardsUx1Central(
                dashboard.contadores || {},
                dashboard.indicadores || {},
                centralEntradasState.operacional
            );
        }

        renderRodapeUx1Central();
        renderAtencaoBannerUx1();
    } catch (error) {
        if (cardsContainer) {
            cardsContainer.innerHTML = '<div class="col-12 text-danger small">Erro ao carregar dashboard.</div>';
        }
        console.warn('[Central Entradas] Dashboard:', error.message);
        // RC7.3.1 — não relança: permite que a lista de documentos conclua o Promise.all.
    } finally {
        centralEntradasState.carregandoDashboard = false;
    }
}

function atualizarIndicadorSyncBotao() {
    const btn = document.getElementById('centralBtnSincronizar');
    if (!btn) return;

    if (centralEntradasState.sincronizando) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span> Sincronizando...';
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sync-alt me-1"></i> Sincronizar Agora';
    }
}

async function sincronizarCentralEntradas() {
    if (centralEntradasState.sincronizando) return;

    centralEntradasState.sincronizando = true;
    atualizarIndicadorSyncBotao();
    renderCabecalhoUx1Central();

    try {
        const resultado = await centralEntradasFetch('/sincronizar', { method: 'POST' });

        centralEntradasState.notasNovasUltimaSync = resultado.notasNovas || 0;
        centralEntradasState.ultimaSincronizacao = resultado.ultimaSincronizacao || new Date().toISOString();

        if (resultado.sucesso) {
            const msg = resultado.notasNovas > 0
                ? `${resultado.notasNovas} nova${resultado.notasNovas === 1 ? '' : 's'} nota${resultado.notasNovas === 1 ? '' : 's'} encontrada${resultado.notasNovas === 1 ? '' : 's'}.`
                : 'Sincronização concluída. Nenhuma nota nova.';
            showNotification(msg, 'success');
        } else {
            const erros = (resultado.erros || []).join('; ') || resultado.mensagem || 'Falha na sincronização';
            showNotification('Sincronização: ' + erros, 'warning');
        }

        await Promise.all([
            carregarDashboardCentral(),
            carregarDocumentosCentral({ pagina: 1 })
        ]);
    } catch (error) {
        showNotification('Erro ao sincronizar: ' + error.message, 'danger');
    } finally {
        centralEntradasState.sincronizando = false;
        atualizarIndicadorSyncBotao();
        renderCabecalhoUx1Central();
        carregarStatusServicoCentral();
    }
}

function obterUsuarioLogadoCentral() {
    try {
        const usuario = JSON.parse(localStorage.getItem('usuario') || 'null');
        return usuario || { id: null, nome: 'Sistema' };
    } catch {
        return { id: null, nome: 'Sistema' };
    }
}

async function carregarProdutosParaRevisaoCentral() {
    const token = localStorage.getItem('token');
    const response = await fetch(`${API_URL}/produtos`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return [];
    return response.json().catch(() => []);
}

async function abrirCentralRevisaoMiip(documentoId, dadosImportacao) {
    if (typeof MiipCentralRevisao === 'undefined') {
        showNotification('Central de Revisão MIIP não disponível.', 'danger');
        return;
    }

    const produtos = await carregarProdutosParaRevisaoCentral();

    MiipCentralRevisao.iniciar({
        dadosImportacao,
        apiUrl: API_URL,
        produtos,
        obterUsuario: obterUsuarioLogadoCentral,
        abrirCadastroProduto: function (item, callback) {
            if (typeof showProdutoModal !== 'function') {
                showNotification('Cadastre o produto em Produtos e retorne à revisão.', 'info');
                if (typeof callback === 'function') callback(null);
                return;
            }

            showProdutoModal(null);

            const el = document.getElementById('produtoModal');
            if (!el) {
                showNotification('Não foi possível abrir o cadastro de produto.', 'danger');
                if (typeof callback === 'function') callback(null);
                return;
            }

            try {
                bootstrap.Modal.getOrCreateInstance(el).show();
            } catch (_) { /* ignore */ }

            const elevar = () => {
                el.style.zIndex = '21000';
                const backdrops = document.querySelectorAll('.modal-backdrop');
                const last = backdrops[backdrops.length - 1];
                if (last) last.style.zIndex = '20990';
            };
            elevar();

            const preencher = () => {
                elevar();
                $('#nome').val(item.produto_nome || item.descricao || '');
                if ($('#codigo_barras').length) $('#codigo_barras').val(item.codigo_barras || item.gtin || '');
                if ($('#ncm').length) $('#ncm').val(item.ncm || '');
                if ($('#unidade').length) $('#unidade').val(item.unidade || 'UN');
                if ($('#preco_compra').length && item.preco_unitario != null) {
                    $('#preco_compra').val(item.preco_unitario);
                }
                if ($('#codigo').length && item.codigo_fornecedor) {
                    $('#codigo').val(String(item.codigo_fornecedor));
                }
            };

            el.addEventListener('shown.bs.modal', preencher, { once: true });
            if (el.classList.contains('show')) preencher();

            el.addEventListener('hidden.bs.modal', async function () {
                const lista = await carregarProdutosParaRevisaoCentral();
                const hint = String(item.produto_nome || item.descricao || '').trim().toLowerCase();
                let escolhido = null;
                if (hint && Array.isArray(lista)) {
                    escolhido = [...lista].reverse().find((p) =>
                        String(p.nome || '').trim().toLowerCase() === hint
                    ) || null;
                }
                if (!escolhido && Array.isArray(lista) && lista.length) {
                    escolhido = lista.reduce((a, b) =>
                        (Number(a?.id || 0) > Number(b?.id || 0) ? a : b)
                    );
                }
                if (typeof callback === 'function') callback(escolhido || null);
            }, { once: true });
        },
        onConcluir: async function (resultado) {
            try {
                const itens = resultado?.itens || dadosImportacao.itens;
                await centralEntradasFetch(`/${documentoId}/revisar/concluir`, {
                    method: 'POST',
                    body: JSON.stringify({ itens, usuario_id: obterUsuarioLogadoCentral()?.id })
                });
                showNotification('Documento pronto para lançamento.', 'success');
                await Promise.all([
                    carregarDashboardCentral(),
                    carregarDocumentosCentral()
                ]);
                await selecionarDocumentoCentral(documentoId);
            } catch (error) {
                showNotification('Erro ao concluir revisão: ' + error.message, 'danger');
            }
        },
        onCancelar: function () {
            showNotification('Revisão MIIP cancelada.', 'warning');
        }
    });
}

async function processarDocumentoCentral(documentoId) {
    if (centralEntradasState.processando) return;

    centralEntradasState.processando = true;
    centralEntradasState.etapaProcessamento = 'localizar';
    centralEntradasState.abaAtiva = 'resumo';

    if (centralEntradasState.detalheAtual) {
        renderPainelLateralCentral(centralEntradasState.detalheAtual);
    }

    try {
        const resultado = await centralEntradasFetch(`/${documentoId}/processar`, {
            method: 'POST',
            body: JSON.stringify({ usuario_id: obterUsuarioLogadoCentral()?.id })
        });

        centralEntradasState.etapaProcessamento = resultado.etapaAtual || 'concluido';

        if (!resultado.sucesso) {
            showNotification(resultado.mensagem || 'Falha no processamento.', 'danger');
            return;
        }

        showNotification(resultado.mensagem || 'Processamento concluído.', 'success');

        await Promise.all([
            carregarDashboardCentral(),
            carregarDocumentosCentral()
        ]);

        await selecionarDocumentoCentral(documentoId);

        if (resultado.proximaAcao === 'revisar_produtos' && resultado.parse) {
            await abrirCentralRevisaoMiip(documentoId, resultado.parse);
        }
    } catch (error) {
        showNotification('Erro ao processar: ' + error.message, 'danger');
    } finally {
        centralEntradasState.processando = false;
        centralEntradasState.etapaProcessamento = null;
        if (centralEntradasState.detalheAtual) {
            renderPainelLateralCentral(centralEntradasState.detalheAtual);
        }
    }
}

async function solicitarXmlCompletoCentral(documentoId) {
    const confirmado = window.confirm(
        'Enviar Ciência da Emissão (210210) à SEFAZ para solicitar o XML completo desta NF-e?'
    );
    if (!confirmado) return;

    try {
        const resultado = await centralEntradasFetch(`/${documentoId}/ciclo-dfe`, {
            method: 'POST',
            body: JSON.stringify({
                confirmado: true,
                usuario_id: obterUsuarioLogadoCentral()?.id
            })
        });
        showNotification(
            resultado.mensagem || (resultado.xmlCompleto
                ? 'XML completo recebido.'
                : 'Aguardando disponibilização do XML completo pela SEFAZ.'),
            resultado.xmlCompleto ? 'success' : 'info'
        );
        await Promise.all([
            carregarDashboardCentral(),
            carregarDocumentosCentral()
        ]);
        await selecionarDocumentoCentral(documentoId);
    } catch (error) {
        showNotification('Erro ao solicitar XML completo: ' + error.message, 'danger');
    }
}

async function abrirRevisaoMiipCentral(documentoId) {
    try {
        const payload = await centralEntradasFetch(`/${documentoId}/payload-compra`);
        if (payload.dadosCompra) {
            await abrirCentralRevisaoMiip(documentoId, payload.dadosCompra);
        }
    } catch (error) {
        showNotification('Erro ao abrir revisão: ' + error.message, 'danger');
    }
}

async function abrirCompraDesdeCentral(documentoId) {
    try {
        const resultado = await centralEntradasFetch(`/${documentoId}/abrir-compra`, {
            method: 'POST',
            body: JSON.stringify({ usuario_id: obterUsuarioLogadoCentral()?.id })
        });

        sessionStorage.setItem('central_abrir_compra', JSON.stringify({
            documentoId: resultado.documentoId || documentoId,
            dadosCompra: resultado.dadosCompra
        }));

        if (typeof loadPage === 'function') {
            loadPage('compras');
        } else {
            showNotification('Navegue até Compras para concluir o lançamento.', 'info');
        }
    } catch (error) {
        showNotification('Erro ao abrir Compras: ' + error.message, 'danger');
    }
}

async function buscarChaveCentralEntradas() {
    const input = document.getElementById('centralFiltroChave');
    const chave = String(input?.value || '').replace(/\D/g, '');

    if (chave.length !== 44) {
        showNotification('Informe uma chave de acesso com 44 dígitos.', 'warning');
        return;
    }

    try {
        const resultado = await centralEntradasFetch(`/buscar-chave?chave=${encodeURIComponent(chave)}`);

        if (resultado.documento?.id) {
            await Promise.all([
                carregarDashboardCentral(),
                carregarDocumentosCentral({ pagina: 1 })
            ]);
            await selecionarDocumentoCentral(resultado.documento.id);
            showNotification(resultado.novo ? 'Nota importada da SEFAZ.' : 'Nota localizada na Central.', 'success');
        } else {
            showNotification(resultado.mensagem || 'Nota não encontrada.', 'info');
        }
    } catch (error) {
        showNotification('Erro na busca por chave: ' + error.message, 'danger');
    }
}

async function carregarXmlDocumentoCentral(documentoId) {
    try {
        const xmlDoc = await centralEntradasFetch(`/${documentoId}/xml`);
        centralEntradasState.xmlAtual = xmlDoc.xml || '';
        if (centralEntradasState.detalheAtual) {
            renderPainelLateralCentral(centralEntradasState.detalheAtual);
        }
    } catch (error) {
        showNotification('Erro ao carregar XML: ' + error.message, 'danger');
    }
}

async function exportarXmlCentral(documentoId) {
    const id = documentoId || centralEntradasState.documentoSelecionadoId;
    if (!id) {
        showNotification('Selecione um documento para exportar o XML.', 'warning');
        return;
    }

    try {
        const xmlDoc = await centralEntradasFetch(`/${id}/xml`);
        if (!xmlDoc.xml) {
            showNotification('XML indisponível para este documento.', 'warning');
            return;
        }

        const blob = new Blob([xmlDoc.xml], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const tipo = xmlDoc.tipoDocumento;
        const ehResumo = tipo === 'RES_NFE'
          || xmlDoc.xmlCompleto === false
          || (xmlDoc.status === 'AGUARDANDO_XML_COMPLETO' && tipo !== 'PROC_NFE' && tipo !== 'NFE');
        if (tipo === 'RES_NFE' && xmlDoc.xmlCompleto === true) {
            showNotification('Inconsistência de tipo: RES_NFE marcado como completo. Download bloqueado.', 'warning');
            return;
        }
        link.download = `${ehResumo ? 'Resumo-NFe' : 'NFe'}-${xmlDoc.chave || id}.xml`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        showNotification(ehResumo ? 'Resumo exportado com sucesso.' : 'XML completo exportado com sucesso.', 'success');
    } catch (error) {
        showNotification('Erro ao exportar XML: ' + error.message, 'danger');
    }
}

/* ============================================================
 * Carregamento de dados
 * ============================================================ */

async function carregarDocumentosCentral(opcoes = {}) {
    if (centralEntradasState.carregando) return;
    centralEntradasState.carregando = true;
    centralEntradasState.loadingFase = 'preparando';
    const lista = document.getElementById('centralEntradasLista');
    const UX = centralUx();
    if (lista && UX.renderLoadingEtapasCentral) {
        lista.innerHTML = UX.renderLoadingEtapasCentral('preparando');
    } else {
        renderGridCentralEntradas();
    }

    try {
        centralEntradasState.loadingFase = 'recebendo';
        if (lista && UX.renderLoadingEtapasCentral) {
            lista.innerHTML = UX.renderLoadingEtapasCentral('recebendo');
        }
        if (opcoes.pagina) centralEntradasState.pagina = opcoes.pagina;
        if (opcoes.ordenarPor) centralEntradasState.ordenarPor = opcoes.ordenarPor;
        if (opcoes.ordenarDirecao) centralEntradasState.ordenarDirecao = opcoes.ordenarDirecao;

        const filtros = {
            ...obterFiltrosCentralDaTela(),
            pagina: centralEntradasState.pagina,
            limite: centralEntradasState.limite,
            ordenar_por: centralEntradasState.ordenarPor,
            ordenar_direcao: centralEntradasState.ordenarDirecao
        };

        const params = new URLSearchParams();
        Object.entries(filtros).forEach(([chave, valor]) => {
            if (valor !== '' && valor != null) {
                const param = chave === 'filtroRapido' ? 'filtro_rapido' : chave;
                params.append(param, valor);
            }
        });

        centralEntradasState.loadingFase = 'atualizando';
        const resultado = await centralEntradasFetch(`/?${params.toString()}`);
        centralEntradasState.documentos = resultado.documentos || [];
        centralEntradasState.total = resultado.paginacao?.total || 0;
        centralEntradasState.totalPaginas = resultado.paginacao?.totalPaginas || 1;
        centralEntradasState.pagina = resultado.paginacao?.pagina || 1;
        centralEntradasState.loadingFase = 'concluido';
    } catch (error) {
        showNotification('Não foi possível carregar os documentos. Tente novamente.', 'danger');
        if (lista) {
            lista.innerHTML = `<div class="alert alert-warning border-0 small m-2" role="alert">
                <i class="fas fa-exclamation-circle me-1"></i>
                Não foi possível carregar a lista. ${escapeHtmlCentralEntradas(error.message || '')}
            </div>`;
        }
    } finally {
        // RC7.3.1 / RC7.5 — sempre desliga loading e redesenha (evita skeleton infinito).
        centralEntradasState.carregando = false;
        renderGridCentralEntradas();
    }
}

async function selecionarDocumentoCentral(id) {
    centralEntradasState.documentoSelecionadoId = id;
    centralEntradasState.abaAtiva = 'resumo';
    centralEntradasState.xmlAtual = null;
    centralEntradasState.parseAtual = null;
    renderGridCentralEntradas();

    const painel = document.getElementById('centralEntradasPainelLateral');
    if (painel) {
        painel.innerHTML = centralUx().renderSkeletonPainelCentral?.() || '';
    }

    try {
        const detalhe = await centralEntradasFetch(`/${id}`);
        centralEntradasState.detalheAtual = detalhe;
        await carregarStatsFornecedorCentral(detalhe.documento?.cnpjFornecedor);
        renderPainelLateralCentral(detalhe);

        if (detalhe.documento?.parseDisponivel) {
            centralEntradasFetch(`/${id}/parse`)
                .then((parseDoc) => {
                    centralEntradasState.parseAtual = parseDoc;
                    if (centralEntradasState.documentoSelecionadoId === id
                        && ['itens', 'produtos', 'miip', 'resumo', 'timeline'].includes(centralEntradasState.abaAtiva)) {
                        renderPainelLateralCentral(centralEntradasState.detalheAtual);
                    }
                })
                .catch(() => {});
        }
    } catch (error) {
        showNotification('Erro ao carregar detalhe: ' + error.message, 'danger');
        renderPainelLateralPlaceholder();
    }
}

function alternarOrdenacaoCentral(campo) {
    if (centralEntradasState.ordenarPor === campo) {
        centralEntradasState.ordenarDirecao = centralEntradasState.ordenarDirecao === 'asc' ? 'desc' : 'asc';
    } else {
        centralEntradasState.ordenarPor = campo;
        centralEntradasState.ordenarDirecao = 'desc';
    }
    centralEntradasState.pagina = 1;
    carregarDocumentosCentral();
}

/* ============================================================
 * Eventos
 * ============================================================ */

function limparFiltrosCentralEntradas() {
    const ids = ['centralFiltroBusca', 'centralFiltroDataInicio', 'centralFiltroDataFim'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const status = document.getElementById('centralFiltroStatus');
    const origem = document.getElementById('centralFiltroOrigem');
    if (status) status.value = '';
    if (origem) origem.value = '';
    centralEntradasState.filtroRapidoAtivo = '';
    centralEntradasState.pagina = 1;
    renderFiltrosRapidosCentral();
    carregarDocumentosCentral();
}

function bindEventosCentralEntradas() {
    $(document).off('.centralEntradas');

    window.removeEventListener('online', renderPainelServicoCentral);
    window.removeEventListener('offline', renderPainelServicoCentral);
    window.addEventListener('online', renderPainelServicoCentral);
    window.addEventListener('offline', renderPainelServicoCentral);

    $(document).on('click.centralEntradas', '#centralEmptySync', function () {
        sincronizarCentralEntradas();
    });

    $(document).on('click.centralEntradas', '#centralEmptyLimparFiltros', function () {
        limparFiltrosCentralEntradas();
    });

    $(document).on('keydown.centralEntradas', '.central-entradas-row, .central-ux1-doc-card', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            const id = Number($(this).data('documento-id'));
            if (id) selecionarDocumentoCentral(id);
        }
    });

    $(document).on('click.centralEntradas', '.central-doc-detalhe-btn', function (event) {
        event.stopPropagation();
        const id = Number($(this).data('doc-id'));
        if (id) selecionarDocumentoCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralBtnDiagnostico', function () {
        if (typeof loadPage === 'function') {
            loadPage('central-diagnostico');
        }
    });

    $(document).on('click.centralEntradas', '#centralBtnNotificacoes', function () {
        centralEntradasFetch('/notificacoes/marcar-todas-lidas', { method: 'PATCH' })
            .then(() => {
                centralEntradasState.notificacoesNaoLidas = 0;
                renderCabecalhoUx1Central();
                showNotification('Notificações marcadas como lidas.', 'info');
            })
            .catch(() => showNotification('Não foi possível atualizar notificações.', 'warning'));
    });

    $(document).on('click.centralEntradas', '[data-filtro-kpi]', function () {
        centralEntradasState.filtroRapidoAtivo = $(this).data('filtro-kpi');
        const select = document.getElementById('centralFiltroStatus');
        if (select) select.value = '';
        centralEntradasState.pagina = 1;
        renderFiltrosRapidosCentral();
        carregarDocumentosCentral();
    });

    $(document).on('keydown.centralEntradas', '.central-entradas-card-click', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            $(this).trigger('click');
        }
    });

    $(document).on('click.centralEntradas', '#centralBtnProcessar', function () {
        const id = Number($(this).data('doc-id'));
        if (id) processarDocumentoCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralBtnSolicitarXmlCompleto', function () {
        const id = Number($(this).data('doc-id'));
        if (id) solicitarXmlCompletoCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralBtnRevisarMiip', function () {
        const id = Number($(this).data('doc-id'));
        if (id) abrirRevisaoMiipCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralBtnAbrirCompra', function () {
        const id = Number($(this).data('doc-id'));
        if (id) abrirCompraDesdeCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralBtnCarregarXml', function () {
        const id = Number($(this).data('doc-id'));
        if (id) carregarXmlDocumentoCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralBtnExportarXml, #centralBtnExportarXmlPainel', function () {
        const id = Number($(this).data('doc-id')) || centralEntradasState.documentoSelecionadoId;
        exportarXmlCentral(id);
    });

    $(document).on('click.centralEntradas', '.central-entradas-aba', function () {
        const aba = $(this).data('aba');
        if (!aba || aba === centralEntradasState.abaAtiva) return;
        centralEntradasState.abaAtiva = aba;
        if (centralEntradasState.detalheAtual) {
            renderPainelLateralCentral(centralEntradasState.detalheAtual);
        }
    });

    $(document).on('click.centralEntradas', '#centralBtnSincronizar', function () {
        sincronizarCentralEntradas();
    });

    $(document).on('click.centralEntradas', '#centralBtnAdicionarDocumento', function () {
        abrirModalUploadCentral();
    });

    $(document).on('click.centralEntradas', '#centralUploadSelecionar', function () {
        document.getElementById('centralUploadInput')?.click();
    });

    $(document).on('change.centralEntradas', '#centralUploadInput', function () {
        adicionarArquivosUploadCentral(this.files);
        this.value = '';
    });

    $(document).on('click.centralEntradas', '#centralUploadEnviar', function () {
        enviarUploadCentralEntradas();
    });

    $(document).on('click.centralEntradas', '#centralUploadLimpar', function () {
        centralEntradasState.uploadArquivos = [];
        renderListaArquivosUploadCentral();
    });

    $(document).on('click.centralEntradas', '.central-upload-remover', function () {
        const idx = Number($(this).data('idx'));
        if (Number.isNaN(idx)) return;
        centralEntradasState.uploadArquivos = (centralEntradasState.uploadArquivos || []).filter((_, i) => i !== idx);
        renderListaArquivosUploadCentral();
    });

    $(document).on('click.centralEntradas', '#centralUploadAtalhoChave', function () {
        const modalEl = document.getElementById('centralUploadModal');
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
        document.getElementById('centralFiltroChave')?.focus();
        showNotification('Informe a chave de 44 dígitos no filtro abaixo.', 'info');
    });

    $(document).on('click.centralEntradas', '#centralUploadAtalhoSefaz', function () {
        const modalEl = document.getElementById('centralUploadModal');
        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
        sincronizarCentralEntradas();
    });

    const dropzone = document.getElementById('centralUploadDropzone');
    if (dropzone) {
        ['dragenter', 'dragover'].forEach((evento) => {
            dropzone.addEventListener(evento, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.add('central-upload-dropzone--ativo');
            });
        });
        ['dragleave', 'drop'].forEach((evento) => {
            dropzone.addEventListener(evento, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropzone.classList.remove('central-upload-dropzone--ativo');
            });
        });
        dropzone.addEventListener('drop', (e) => {
            adicionarArquivosUploadCentral(e.dataTransfer?.files);
        });
    }

    $(document).on('click.centralEntradas', '#centralBtnAtualizar', function () {
        Promise.all([
            carregarDashboardCentral(),
            carregarDocumentosCentral()
        ]).then(() => showNotification('Central atualizada.', 'info'));
    });

    $(document).on('click.centralEntradas', '#centralBtnAtualizarDashboard', function () {
        carregarDashboardCentral().then(() => showNotification('Dashboard atualizado.', 'info'));
    });

    $(document).on('click.centralEntradas', '#centralBtnBuscarChave', function () {
        buscarChaveCentralEntradas();
    });

    $(document).on('keypress.centralEntradas', '#centralFiltroChave', function (event) {
        if (event.which === 13) buscarChaveCentralEntradas();
    });

    $(document).on('click.centralEntradas', '#centralBtnFiltrar', function () {
        centralEntradasState.pagina = 1;
        carregarDocumentosCentral();
        carregarDashboardCentral();
    });

    $(document).on('click.centralEntradas', '.central-entradas-card-click', function () {
        const status = $(this).data('status-filtro');
        const select = document.getElementById('centralFiltroStatus');
        if (select) select.value = status;
        centralEntradasState.pagina = 1;
        carregarDocumentosCentral();
    });

    $(document).on('click.centralEntradas', '.central-entradas-row', function () {
        const id = Number($(this).data('documento-id'));
        if (id) selecionarDocumentoCentral(id);
    });

    $(document).on('click.centralEntradas', '#centralPaginaAnterior', function () {
        if (centralEntradasState.pagina > 1) {
            carregarDocumentosCentral({ pagina: centralEntradasState.pagina - 1 });
        }
    });

    $(document).on('click.centralEntradas', '#centralPaginaProxima', function () {
        if (centralEntradasState.pagina < centralEntradasState.totalPaginas) {
            carregarDocumentosCentral({ pagina: centralEntradasState.pagina + 1 });
        }
    });

    $(document).on('click.centralEntradas', '.central-entradas-sort', function () {
        alternarOrdenacaoCentral($(this).data('sort'));
    });

    $(document).on('input.centralEntradas', '#centralFiltroBusca', function () {
        if (centralEntradasState.buscaDebounceTimer) {
            clearTimeout(centralEntradasState.buscaDebounceTimer);
        }
        centralEntradasState.buscaDebounceTimer = setTimeout(() => {
            centralEntradasState.pagina = 1;
            carregarDocumentosCentral();
        }, 400);
    });

    $(document).on('keypress.centralEntradas', '#centralFiltroBusca', function (event) {
        if (event.which === 13) {
            event.preventDefault();
            centralEntradasState.pagina = 1;
            carregarDocumentosCentral();
        }
    });

    $(document).on('click.centralEntradas', '.central-ux1-filtro', function () {
        const codigo = String($(this).data('filtro-rapido') ?? '');
        const status = $(this).data('filtro-status') || '';
        const select = document.getElementById('centralFiltroStatus');

        if (codigo === '') {
            centralEntradasState.filtroRapidoAtivo = '';
            if (select) select.value = '';
        } else if (codigo.startsWith('_status_')) {
            centralEntradasState.filtroRapidoAtivo = '';
            if (select) select.value = status;
        } else if (centralEntradasState.filtroRapidoAtivo === codigo) {
            centralEntradasState.filtroRapidoAtivo = '';
            if (select) select.value = '';
        } else {
            centralEntradasState.filtroRapidoAtivo = codigo;
            if (select) select.value = '';
        }

        centralEntradasState.pagina = 1;
        renderFiltrosRapidosCentral();
        carregarDocumentosCentral();
    });

    $(document).on('click.centralEntradas', '.central-atencao-acao', function () {
        const idx = Number($(this).data('atencao-idx'));
        const item = centralEntradasState.atencao?.itens?.[idx];
        if (item?.acao) executarAcaoAtencaoCentral(item.acao);
    });

    $(document).on('click.centralEntradas', '.central-alerta-ver, .central-pendencia-ver', function () {
        const id = Number($(this).data('doc-id'));
        if (id) selecionarDocumentoCentral(id);
    });

    $(document).on('click.centralEntradas', '.central-nav-view', function () {
        mostrarViewCentral($(this).data('view'));
    });

    $(document).on('click.centralEntradas', '#centralBtnSalvarConfig', function () {
        salvarConfigCentral();
    });

    $(document).on('click.centralEntradas', '#centralBtnCancelarConfig', function () {
        carregarConfigCentral();
    });

    $(document).on('click.centralEntradas', '#centralBtnRestaurarConfig', function () {
        restaurarConfigCentral();
    });

    $(document).on('click.centralEntradas', '[data-cfg-tab]', function () {
        ativarAbaConfigCentral($(this).data('cfg-tab'));
    });

    $(document).on('click.centralEntradas', '#centralCfgTestarSefaz, #centralCfgTestarSefazDiag', function () {
        const resultId = this.id === 'centralCfgTestarSefazDiag' ? 'centralCfgResultDiag' : 'centralCfgResultSefaz';
        testarSefazConfigCentral(resultId);
    });

    $(document).on('click.centralEntradas', '#centralCfgTestarCert, #centralCfgTestarCertDiag', function () {
        const resultId = this.id === 'centralCfgTestarCertDiag' ? 'centralCfgResultDiag' : 'centralCfgResultCert';
        testarCertificadoConfigCentral(resultId);
    });

    $(document).on('click.centralEntradas', '#centralCfgHealth', function () {
        healthConfigCentral();
    });

    $(document).on('click.centralEntradas', '#centralCfgLimparCache', function () {
        limparCacheConfigCentral();
    });

    $(document).on('click.centralEntradas', '#centralCfgVerEventos', function () {
        mostrarViewCentral('log');
    });

    $(document).on('click.centralEntradas', '#centralCfgAtualizarCert', function () {
        const info = document.getElementById('centralCfgCertInfo');
        if (info) info.hidden = false;
        showNotification('O certificado é gerenciado nas configurações fiscais da empresa.', 'info');
    });

    $(document).on('click.centralEntradas', '#centralBtnFiltrarLog', function () {
        carregarLogCentral();
    });

    $(document).on('keypress.centralEntradas', '#centralLogBusca', function (event) {
        if (event.which === 13) carregarLogCentral();
    });
}

/* ============================================================
 * Página
 * ============================================================ */

function loadCentralEntradas() {
    centralEntradasState.pagina = 1;
    centralEntradasState.documentoSelecionadoId = null;
    centralEntradasState.documentos = [];
    centralEntradasState.total = 0;
    centralEntradasState.detalheAtual = null;
    centralEntradasState.xmlAtual = null;
    centralEntradasState.parseAtual = null;
    centralEntradasState.abaAtiva = 'resumo';

    const html = `
        <div class="central-ux1-page">
            <div id="centralUx1Header"></div>
            <div id="centralRc75SaudeWrap" class="mb-3"></div>

            <div id="centralEntradasViewConfig" class="d-none mb-4">
                <div class="card central-cfg-panel">
                    <div class="card-header d-flex justify-content-between align-items-start flex-wrap gap-2">
                        <div>
                            <div class="central-cfg-header-title">
                                <i class="fas fa-sliders-h me-2"></i> Configuração Enterprise
                            </div>
                            <div class="central-cfg-header-sub">Ambiente (somente leitura · fonte oficial), SEFAZ, certificado, sync e diagnóstico</div>
                        </div>
                        <button type="button" class="btn btn-sm btn-outline-light central-nav-view" data-view="inbox" title="Voltar à Central">
                            <i class="fas fa-arrow-left me-1"></i> Voltar
                        </button>
                    </div>
                    <div id="centralConfigForm">
                        <div class="text-center py-4"><div class="spinner-border spinner-border-sm text-primary"></div></div>
                    </div>
                </div>
            </div>

            <div id="centralEntradasViewLog" class="d-none mb-4">
                <div class="card">
                    <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
                        <span><i class="fas fa-list-alt me-2"></i> Log Operacional</span>
                        <div class="d-flex gap-2">
                            <button type="button" class="btn btn-sm btn-outline-secondary central-nav-view" data-view="inbox" title="Voltar à Central">
                                <i class="fas fa-arrow-left"></i>
                            </button>
                            <input type="text" class="form-control form-control-sm" id="centralLogBusca" placeholder="Pesquisar..." title="Pesquisar no log">
                            <select class="form-select form-select-sm" id="centralLogTipo" title="Filtrar por tipo de evento">
                                <option value="">Todos os tipos</option>
                                <option value="SYNC_INICIADA">Sync iniciada</option>
                                <option value="SYNC_CONCLUIDA">Sync concluída</option>
                                <option value="SYNC_ERRO">Sync erro</option>
                                <option value="DOCUMENTO_RECEBIDO">Documento recebido</option>
                                <option value="DOCUMENTO_ATUALIZADO">Documento atualizado</option>
                                <option value="DOCUMENTO_PROCESSADO">Documento processado</option>
                                <option value="CIENCIA_ENVIADA">Ciência enviada</option>
                                <option value="MANIFESTACAO_ACEITA">Manifestação aceita</option>
                                <option value="MANIFESTACAO_REJEITADA">Manifestação rejeitada</option>
                                <option value="CONSULTA_DFE_POS_MANIFESTACAO">Nova consulta DF-e</option>
                                <option value="PARSER_CONCLUIDO">Parser</option>
                                <option value="MIIP_CONCLUIDO">MIIP</option>
                                <option value="COMPRA_GRAVADA">Compra gravada</option>
                                <option value="ERRO">Erro</option>
                            </select>
                            <button type="button" class="btn btn-sm btn-primary" id="centralBtnFiltrarLog" title="Filtrar log"><i class="fas fa-search"></i></button>
                        </div>
                    </div>
                    <div class="table-responsive">
                        <table class="table table-sm table-hover mb-0">
                            <thead class="table-light">
                                <tr>
                                    <th>Data/Hora</th><th>Evento</th><th>Origem</th><th>Descrição</th><th>Tempo</th><th>Resultado</th>
                                </tr>
                            </thead>
                            <tbody id="centralLogBody">
                                <tr><td colspan="6" class="text-center py-4 text-muted">Carregando...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div id="centralEntradasViewCicloDfe" class="d-none mb-4">
                <div class="card">
                    <div class="card-header d-flex justify-content-between align-items-start flex-wrap gap-2">
                        <div>
                            <div class="fw-semibold"><i class="fas fa-project-diagram me-2"></i> Monitor de Ciclo DF-e</div>
                            <div class="small text-muted">Homologação assistida · somente leitura · telemetria SEFAZ</div>
                        </div>
                        <button type="button" class="btn btn-sm btn-outline-light central-nav-view" data-view="inbox" title="Voltar à Central">
                            <i class="fas fa-arrow-left me-1"></i> Voltar
                        </button>
                    </div>
                    <div class="card-body" id="centralHomologacaoBody">
                        <div class="text-center py-4 text-muted">Abrindo monitor…</div>
                    </div>
                </div>
            </div>

            <div id="centralEntradasViewInbox">

            <div id="centralEntradasAtencao"></div>

            <div id="centralEntradasCards" class="central-ux1-kpis" aria-busy="true">
                ${Array.from({ length: 8 }, () => `
                    <div class="central-ux1-kpi central-ux-skeleton-kpi" aria-hidden="true">
                        <div class="central-ux-skeleton central-ux-skeleton-circle"></div>
                        <div class="flex-grow-1">
                            <div class="central-ux-skeleton central-ux-skeleton-line central-ux-skeleton-line--lg"></div>
                            <div class="central-ux-skeleton central-ux-skeleton-line central-ux-skeleton-line--sm mt-1"></div>
                        </div>
                    </div>
                `).join('')}
            </div>

            <div class="central-ux1-toolbar">
                <div class="central-ux1-busca">
                    <i class="fas fa-search" aria-hidden="true"></i>
                    <input type="search" class="form-control" id="centralFiltroBusca"
                        placeholder="Pesquisar: fornecedor, número, chave, CNPJ, valor..."
                        title="Pesquisa instantânea por fornecedor, número, chave, produto, valor ou CNPJ"
                        autocomplete="off">
                </div>
                <div class="central-ux1-filtros" id="centralEntradasFiltrosRapidos"></div>
                <button type="button" class="btn btn-outline-secondary btn-sm" id="centralBtnAtualizar" title="Atualizar lista e indicadores">
                    <i class="fas fa-redo-alt"></i>
                </button>
            </div>

            <div class="d-none" aria-hidden="true">
                <input type="text" id="centralFiltroChave" maxlength="44">
                <select id="centralFiltroStatus"><option value="">Todos</option></select>
                <select id="centralFiltroOrigem"><option value="">Todas</option></select>
                <input type="date" id="centralFiltroDataInicio">
                <input type="date" id="centralFiltroDataFim">
                <button type="button" id="centralBtnFiltrar"></button>
                <button type="button" id="centralBtnBuscarChave"></button>
                <button type="button" id="centralBtnExportarXml"></button>
                <button type="button" id="centralBtnAtualizarDashboard"></button>
            </div>

            <div class="central-ux1-corpo">
                <div class="central-ux1-lista-card">
                    <div class="central-ux1-lista-header">
                        <span><i class="fas fa-file-invoice me-2"></i> Documentos Fiscais</span>
                        <span class="badge bg-secondary" id="centralEntradasContador">0 documentos</span>
                    </div>
                    <div class="central-ux1-lista-body" id="centralEntradasListaDocs">
                        ${centralUx().renderSkeletonListaDocumentosCentral?.(6) || ''}
                    </div>
                    <div id="centralEntradasPaginacao"></div>
                </div>
                <div id="centralEntradasPainelLateral"></div>
            </div>

            <div id="centralUx1Rodape"></div>

            </div>
        </div>

        <div class="modal fade" id="centralUploadModal" tabindex="-1" aria-labelledby="centralUploadModalLabel" aria-hidden="true">
            <div class="modal-dialog modal-lg modal-dialog-centered">
                <div class="modal-content central-upload-modal">
                    <div class="modal-header">
                        <h5 class="modal-title" id="centralUploadModalLabel">
                            <i class="fas fa-file-upload me-2 text-success"></i> Adicionar Documento
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fechar"></button>
                    </div>
                    <div class="modal-body">
                        <p class="text-muted small mb-3">
                            Envie NF-e em XML pela Central Inteligente. O documento seguirá o mesmo pipeline da SEFAZ (Parser → MIIP → Revisão).
                        </p>
                        <div class="central-upload-dropzone" id="centralUploadDropzone">
                            <div class="central-upload-dropzone-icone">
                                <i class="fas fa-cloud-upload-alt fa-2x text-primary"></i>
                            </div>
                            <p class="mb-2 fw-semibold">Arraste XMLs aqui</p>
                            <p class="text-muted small mb-3">ou</p>
                            <button type="button" class="btn btn-outline-primary" id="centralUploadSelecionar">
                                <i class="fas fa-folder-open me-1"></i> Selecionar XML
                            </button>
                            <input type="file" id="centralUploadInput" accept=".xml,application/xml,text/xml" multiple hidden>
                            <p class="text-muted small mt-3 mb-0">1 ou vários arquivos · somente .xml · NF-e</p>
                        </div>
                        <div id="centralUploadLista" class="central-upload-lista d-none"></div>
                        <div id="centralUploadProgresso" class="central-upload-progresso d-none"></div>
                        <div id="centralUploadResultado" class="central-upload-resultado d-none"></div>
                        <hr class="my-3">
                        <div class="central-upload-atalhos">
                            <p class="text-muted small mb-2 mb-md-0">Atalhos</p>
                            <div class="d-flex gap-2 flex-wrap">
                                <button type="button" class="btn btn-sm btn-outline-secondary" id="centralUploadAtalhoChave">
                                    <i class="fas fa-key me-1"></i> Buscar pela chave
                                </button>
                                <button type="button" class="btn btn-sm btn-outline-secondary" id="centralUploadAtalhoSefaz">
                                    <i class="fas fa-sync-alt me-1"></i> Consultar SEFAZ
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancelar</button>
                        <button type="button" class="btn btn-primary" id="centralUploadEnviar" disabled>
                            <i class="fas fa-upload me-1"></i> Enviar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;

    $('#page-content').html(html);
    renderCabecalhoUx1Central();
    renderRodapeUx1Central();
    renderPainelLateralPlaceholder();
    bindEventosCentralEntradas();
    iniciarTickerSincronizacao();
    iniciarAutomacaoCentral();

    const posGravacao = sessionStorage.getItem('central_pos_gravacao');

    centralEntradasFetch('/metadados')
        .then((metadados) => {
            centralEntradasState.metadados = metadados;
            const select = document.getElementById('centralFiltroStatus');
            if (select) select.innerHTML = montarOptionsStatusCentral('');
            renderFiltrosRapidosCentral();
            return Promise.all([
                sincronizarAoAbrirCentralSuave(),
                carregarDashboardCentral(),
                carregarDocumentosCentral()
            ]);
        })
        .then(() => {
            if (posGravacao) {
                sessionStorage.removeItem('central_pos_gravacao');
                const docId = Number(posGravacao);
                if (docId) {
                    showNotification('Compra lançada com sucesso.', 'success');
                    selecionarDocumentoCentral(docId);
                }
            }
        })
        .catch((error) => {
            showNotification('Erro ao inicializar Central: ' + error.message, 'danger');
        })
        .finally(() => {
            // RC7.3.1 — garante fim de qualquer skeleton residual.
            centralEntradasState.carregando = false;
            centralEntradasState.carregandoDashboard = false;
            if (document.getElementById('centralEntradasLista')
                || document.getElementById('centralEntradasTbody')) {
                renderGridCentralEntradas();
            }
        });
}
