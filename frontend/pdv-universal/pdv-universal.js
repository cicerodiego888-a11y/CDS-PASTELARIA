/**
 * Sprint 05.03 — tela principal do PDV Universal.
 * Consome GET /api/pdv-universal/contexto. Sem carrinho, checkout ou venda.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalTela = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ESTADOS = Object.freeze({
        LOADING: 'LOADING',
        ERROR: 'ERROR',
        READY: 'READY',
        IDLE: 'IDLE',
        CARRINHO_ATIVO: 'CARRINHO_ATIVO',
        CHECKOUT_PROCESSANDO: 'CHECKOUT_PROCESSANDO',
        ATENDIMENTO_CRIADO: 'ATENDIMENTO_CRIADO',
        ERRO_CHECKOUT: 'ERRO_CHECKOUT',
        AGUARDANDO_PAGAMENTO: 'AGUARDANDO_PAGAMENTO',
        RESERVANDO_ESTOQUE: 'RESERVANDO_ESTOQUE',
        ESTOQUE_RESERVADO: 'ESTOQUE_RESERVADO',
        PROCESSANDO_PAGAMENTO: 'PROCESSANDO_PAGAMENTO',
        PAGAMENTO_CONFIRMADO: 'PAGAMENTO_CONFIRMADO',
        ERRO_RESERVA: 'ERRO_RESERVA',
        ERRO_PAGAMENTO: 'ERRO_PAGAMENTO',
        PROCESSANDO_MATERIALIZACAO: 'PROCESSANDO_MATERIALIZACAO',
        MATERIALIZACAO_CONCLUIDA: 'MATERIALIZACAO_CONCLUIDA',
        ERRO_MATERIALIZACAO: 'ERRO_MATERIALIZACAO',
        PROCESSANDO_FISCAL: 'PROCESSANDO_FISCAL',
        FISCALIZADO: 'FISCALIZADO',
        FISCAL_PARCIAL: 'FISCAL_PARCIAL',
        FISCAL_ERRO: 'FISCAL_ERRO',
        COMPROVANTE_DISPONIVEL: 'COMPROVANTE_DISPONIVEL',
        INICIAL: 'INICIAL',
        ATENDIMENTO_VALIDADO: 'ATENDIMENTO_VALIDADO',
        RESERVA_PROCESSANDO: 'RESERVA_PROCESSANDO',
        ATENDIMENTO_RESERVADO: 'ATENDIMENTO_RESERVADO',
        PAGAMENTO_PROCESSANDO: 'PAGAMENTO_PROCESSANDO',
        ATENDIMENTO_PAGO: 'ATENDIMENTO_PAGO',
        MATERIALIZACAO_PROCESSANDO: 'MATERIALIZACAO_PROCESSANDO',
        FISCALIZACAO_PROCESSANDO: 'FISCALIZACAO_PROCESSANDO',
        ERRO_RECUPERAVEL: 'ERRO_RECUPERAVEL'
    });

    function SessionLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalSession)
            || (typeof require === 'function' ? require('./pdv-universal-session.js') : null);
    }

    function IdentLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalIdentificacao)
            || (typeof require === 'function' ? require('./pdv-universal-identificacao.js') : null);
    }

    function PixLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalPix)
            || (typeof require === 'function' ? require('./pdv-universal-pix.js') : null);
    }

    function TefLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalTef)
            || (typeof require === 'function' ? require('./pdv-universal-tef.js') : null);
    }

    function CaixaLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalCaixa)
            || (typeof require === 'function' ? require('./pdv-universal-caixa.js') : null);
    }

    function EntregaLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalEntrega)
            || (typeof require === 'function' ? require('./pdv-universal-entrega.js') : null);
    }

    function PrecoAtacadoLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalPrecoAtacado)
            || (typeof require === 'function' ? require('./pdv-universal-preco-atacado.js') : null);
    }

    function PromocaoLib() {
        return (typeof globalThis !== 'undefined' && globalThis.PdvUniversalPromocao)
            || (typeof require === 'function' ? require('./pdv-universal-promocao.js') : null);
    }

    function CartApi() {
        return (typeof globalThis !== 'undefined' && globalThis.PDVUniversalCart)
            || (typeof require === 'function' ? require('./pdv-universal-cart.js') : null);
    }

    /** Mesma regra 05.28 — só exibe PESAR para produto fracionado/pesável. */
    function deveExibirAcaoPesagemManual(item) {
        const C = CartApi();
        return !!(C && C.produtoVendidoPorPeso && C.produtoVendidoPorPeso(item));
    }

    /**
     * Reutiliza interpretarQuantidadeUi (05.28).
     * Zero/negativo → rejeitar (não remove item na pesagem manual).
     */
    function interpretarPesoManualUi(raw, pesoAnterior) {
        const C = CartApi();
        const prev = Number(pesoAnterior);
        const anterior = Number.isFinite(prev) && prev > 0 ? prev : 0;
        if (!C || typeof C.interpretarQuantidadeUi !== 'function') {
            return { acao: 'rejeitar', quantidade: anterior, motivo: 'ADAPTADOR_INDISPONIVEL' };
        }
        const d = C.interpretarQuantidadeUi(raw, anterior > 0 ? anterior : 1, { permiteDecimal: true });
        if (!d || d.acao === 'remover') {
            return { acao: 'rejeitar', quantidade: anterior, motivo: 'PESO_DEVE_SER_POSITIVO' };
        }
        if (d.acao === 'restaurar') {
            return { acao: 'rejeitar', quantidade: anterior, motivo: 'PESO_INVALIDO' };
        }
        if (!(Number(d.quantidade) > 0)) {
            return { acao: 'rejeitar', quantidade: anterior, motivo: 'PESO_DEVE_SER_POSITIVO' };
        }
        return { acao: 'aplicar', quantidade: d.quantidade };
    }

    function aplicarPesoManualNoCarrinho(cart, produtoId, empresaId, peso) {
        if (!cart) return { ok: false, code: 'CARRINHO_INDISPONIVEL' };
        const n = Number(peso);
        if (!(n > 0)) return { ok: false, code: 'PESO_INVALIDO' };
        const item = cart.localizar(produtoId, empresaId);
        if (!item) return { ok: false, code: 'ITEM_NAO_ENCONTRADO' };
        if (!deveExibirAcaoPesagemManual(item)) return { ok: false, code: 'PRODUTO_NAO_PESAVEL' };
        try {
            cart.aplicarQuantidadeInteira(produtoId, empresaId, n);
            return { ok: true, item: cart.localizar(produtoId, empresaId) };
        } catch (err) {
            return { ok: false, code: err.code || 'PESO_ERRO', mensagem: err.message };
        }
    }

    function montarEstadoPesagemManual(item) {
        const C = CartApi();
        const porPeso = deveExibirAcaoPesagemManual(item);
        const qtd = Number(item && item.quantidade) || 0;
        return {
            produto_id: item && item.produto_id,
            empresa_id: item && item.empresa_id,
            descricao: (item && (item.descricao || item.nome)) || '',
            peso_atual: qtd,
            peso_atual_formatado: C && C.formatarQuantidadeUi
                ? C.formatarQuantidadeUi(qtd, true)
                : String(qtd),
            unidade: (item && item.unidade) || 'KG',
            exibir_acao: porPeso
        };
    }

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        if (typeof window !== 'undefined' && window.location && window.location.origin) {
            return `${window.location.origin}/api`;
        }
        return '/api';
    }

    function urlContexto() {
        return `${baseApi()}/pdv-universal/contexto`;
    }

    function urlSelecionarEmpresa() {
        return `${baseApi()}/pdv-universal/contexto/empresa`;
    }

    function urlBuscaProduto(termo) {
        return `${baseApi()}/produtos/consulta-pdv/buscar?q=${encodeURIComponent(termo)}`;
    }

    function urlIdentificarProduto() {
        const Ident = IdentLib();
        if (Ident && Ident.urlIdentificar) return Ident.urlIdentificar();
        return `${baseApi()}/produtos/identificar`;
    }

    function urlDisponibilidade(produtoId) {
        return `${baseApi()}/pdv-universal/produtos/${encodeURIComponent(produtoId)}/disponibilidade`;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json' };
        let token = '';
        try {
            if (typeof localStorage !== 'undefined') {
                token = localStorage.getItem('token') || '';
            }
        } catch (_e) {
            token = '';
        }
        if (token) headers.Authorization = `Bearer ${token}`;
        try {
            if (typeof localStorage !== 'undefined') {
                const emp = localStorage.getItem('cds_empresa_id');
                if (emp) headers['X-Empresa-Id'] = emp;
            }
        } catch (_e2) { /* ignore */ }
        return headers;
    }

    function aplicarCapabilities(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        return Object.freeze({
            permite_selecao_empresa: !!caps.permite_selecao_empresa,
            exige_empresa_unica_para_checkout: !!caps.exige_empresa_unica_para_checkout,
            permite_multiplas_empresas_no_atendimento: !!caps.permite_multiplas_empresas_no_atendimento,
            empresa_por_item: !!caps.empresa_por_item,
            mostrar_seletor: !!caps.permite_selecao_empresa
                && (!!(contexto && contexto.exige_selecao) || !(contexto && contexto.empresa_selecionada)),
            mostrar_painel_empresas_atendimento: !!caps.permite_multiplas_empresas_no_atendimento,
            finalizar_habilitado: false,
            checkout_empresa_unica: !!caps.checkout_empresa_unica,
            checkout_multiempresa: !!caps.checkout_multiempresa,
            pode_reservar_atendimento: !!caps.pode_reservar_atendimento,
            pode_confirmar_pagamento_unificado: !!caps.pode_confirmar_pagamento_unificado,
            pode_cancelar_atendimento_reservado: !!caps.pode_cancelar_atendimento_reservado,
            pode_materializar_atendimento: !!caps.pode_materializar_atendimento,
            pode_fiscalizar_atendimento: !!caps.pode_fiscalizar_atendimento,
            pode_visualizar_comprovante: !!caps.pode_visualizar_comprovante,
            pode_preparar_impressao: !!caps.pode_preparar_impressao,
            pode_iniciar_novo_atendimento: !!caps.pode_iniciar_novo_atendimento
        });
    }

    function rotuloModo(contexto) {
        const globalModo = (contexto && contexto.modo_operacional_global) || '';
        if (globalModo === 'EMPRESA_SIMPLES') return 'EMPRESA SIMPLES';
        if (globalModo === 'MULTIEMPRESA') return 'MULTIEMPRESA';
        const modo = (contexto && (contexto.modo_operacao || contexto.modo_operacao_venda)) || '';
        if (modo === 'MULTIEMPRESA') return 'MULTIEMPRESA';
        if (modo === 'EMPRESA_UNICA') return 'EMPRESA ÚNICA';
        return modo ? String(modo) : '—';
    }

    function rotuloEmpresa(contexto) {
        const emp = contexto && contexto.empresa_selecionada;
        if (!emp) return null;
        return emp.nome || emp.razao_social || emp.nome_fantasia || null;
    }

    function empresasDoContexto(contexto) {
        const lista = (contexto && (contexto.empresas_disponiveis
            || (contexto.contexto && contexto.contexto.empresas_disponiveis))) || [];
        return lista.slice();
    }

    function avisoContextoPronto(contexto) {
        const modo = (contexto && (contexto.modo_operacao || contexto.modo_operacao_venda)) || '';
        if (modo === 'EMPRESA_UNICA' && (contexto.exige_selecao || !contexto.empresa_selecionada)) {
            return 'Selecione uma empresa para iniciar o PDV.';
        }
        return '';
    }

    function nuncaAssumirEmpresaUm(contexto) {
        const id = contexto && contexto.empresa_selecionada && contexto.empresa_selecionada.id;
        if (id == null) return true;
        return Number(id) !== 1 || empresasDoContexto(contexto).some((e) => Number(e.id) === 1);
    }

    async function carregarContexto(fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlContexto(), { method: 'GET', headers: headersAuth() });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || 'Não foi possível carregar o contexto operacional do PDV.');
            err.code = body.code || 'ERRO_CONTEXTO';
            err.status = res.status;
            throw err;
        }
        return body;
    }

    async function carregarContextoComRecuperacao(fetchFn) {
        try {
            return await carregarContexto(fetchFn);
        } catch (err) {
            if (err && err.code === 'EMPRESA_OPERACIONAL_INVALIDA') {
                try {
                    if (typeof localStorage !== 'undefined') {
                        localStorage.removeItem('cds_empresa_id');
                    }
                } catch (_e) { /* ignore */ }
                return carregarContexto(fetchFn);
            }
            throw err;
        }
    }

    async function selecionarEmpresaOperacional(empresaId, fetchFn) {
        const id = Number(empresaId);
        if (!Number.isInteger(id) || id <= 0) {
            const err = new Error('empresa_id é obrigatório.');
            err.code = 'EMPRESA_ID_OBRIGATORIO';
            throw err;
        }
        const fn = fetchFn || fetch;
        const headers = headersAuth();
        headers['Content-Type'] = 'application/json';
        const res = await fn(urlSelecionarEmpresa(), {
            method: 'PUT',
            headers,
            body: JSON.stringify({ empresa_id: id })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || 'Não foi possível selecionar a empresa.');
            err.code = body.code || 'ERRO_SELECAO';
            throw err;
        }
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('cds_empresa_id', String(id));
            }
        } catch (_e) { /* persistência oficial do cliente */ }
        return carregarContexto(fn);
    }

    function classificarErroContexto(err) {
        const status = err && Number(err.status);
        const code = err && err.code;
        if ((status === 401 || status === 403 || code === 'SESSAO_INVALIDA')
            && status !== 409
            && code !== 'NENHUMA_EMPRESA_DISPONIVEL') {
            return {
                tipo: 'SESSAO',
                mensagem: 'Sua sessão expirou. Faça login novamente.',
                acao: 'LOGIN',
                status: status || null,
                code: code || 'SESSAO_INVALIDA'
            };
        }
        if (code === 'NENHUMA_EMPRESA_DISPONIVEL') {
            return {
                tipo: 'SEM_EMPRESA',
                mensagem: 'Nenhuma empresa operacional está disponível. Cadastre uma empresa em Configurações Avançadas → Empresas.',
                acao: 'CADASTRAR',
                status: status || 409,
                code: code
            };
        }
        if (code === 'EMPRESA_OPERACIONAL_NAO_SELECIONADA') {
            return {
                tipo: 'SELECAO',
                mensagem: 'Selecione a empresa para iniciar o atendimento.',
                acao: 'SELECIONAR',
                status: status || 409,
                code: code
            };
        }
        if (code === 'MODO_OPERACAO_VENDA_INVALIDO') {
            return {
                tipo: 'TECNICO',
                mensagem: (err && err.message) || 'Modo de operação de venda inválido.',
                acao: 'RETRY',
                status: status || 500,
                code: code
            };
        }
        if (code === 'EMPRESA_OPERACIONAL_INVALIDA' || code === 'EMPRESA_INATIVA') {
            return {
                tipo: 'SELECAO',
                mensagem: 'Selecione a empresa para iniciar o atendimento.',
                acao: 'SELECIONAR',
                status: status || 400,
                code: code
            };
        }
        return {
            tipo: 'TEMPORARIO',
            mensagem: (err && err.message) || 'Não foi possível carregar o PDV agora.',
            acao: 'RETRY',
            status: status || null,
            code: code || 'ERRO_CONTEXTO'
        };
    }

    function mensagemErro(err) {
        return classificarErroContexto(err).mensagem;
    }

    function registrarErroContexto(err, endpoint) {
        const info = classificarErroContexto(err);
        try {
            console.warn('[PDV Universal] erro de contexto', {
                status: info.status || (err && err.status),
                code: info.code,
                mensagem: info.mensagem,
                endpoint: endpoint || urlContexto()
            });
        } catch (_e) { /* ignore */ }
        return info;
    }

    function montarModeloVisual(contexto) {
        const caps = aplicarCapabilities(contexto);
        return Object.freeze({
            estado: ESTADOS.READY,
            modo_rotulo: rotuloModo(contexto),
            empresa_rotulo: rotuloEmpresa(contexto),
            empresa_id: contexto && contexto.empresa_selecionada
                ? contexto.empresa_selecionada.id
                : null,
            empresas: empresasDoContexto(contexto),
            operador: contexto && contexto.operador ? contexto.operador : null,
            capabilities: caps,
            finalizar_desabilitado: true,
            itens: 0,
            total: 'R$ 0,00'
        });
    }

    function moneyVisual(n) {
        return `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
    }

    function urlStatusCaixa() {
        return `${baseApi()}/caixa/aberto`;
    }

    function classificarStatusCaixa(resposta, falhou) {
        if (falhou) return { codigo: 'INDISPONIVEL', rotulo: 'CAIXA: INDISPONÍVEL' };
        if (resposta === undefined) return { codigo: 'VERIFICANDO', rotulo: 'CAIXA: VERIFICANDO' };
        if (resposta === null) return { codigo: 'FECHADO', rotulo: 'CAIXA: FECHADO' };
        if (resposta && typeof resposta === 'object') {
            const st = String(resposta.status || (resposta.caixa && resposta.caixa.status) || '').toLowerCase();
            if (st === 'aberto' || resposta.id || resposta.caixa_id || (resposta.caixa && resposta.caixa.id)) {
                return { codigo: 'ABERTO', rotulo: 'CAIXA: ABERTO' };
            }
            if (st === 'fechado') return { codigo: 'FECHADO', rotulo: 'CAIXA: FECHADO' };
        }
        return { codigo: 'INDISPONIVEL', rotulo: 'CAIXA: INDISPONÍVEL' };
    }

    /**
     * Consulta única do status de caixa (05.23). Sem polling.
     * Não faz logout. Não inventa regra de bloqueio de venda.
     */
    async function atualizarStatusCaixa(opcoes) {
        const opts = opcoes || {};
        const onEstado = typeof opts.onEstado === 'function' ? opts.onEstado : function () {};
        const fetchFn = opts.fetchFn || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);

        const verificando = classificarStatusCaixa(undefined, false);
        onEstado(verificando);

        try {
            if (typeof fetchFn !== 'function') {
                const indisp = classificarStatusCaixa(null, true);
                onEstado(indisp);
                return indisp;
            }
            const res = await fetchFn(urlStatusCaixa(), {
                method: 'GET',
                headers: headersAuth()
            });
            if (!res.ok) {
                const indisp = classificarStatusCaixa(null, true);
                onEstado(indisp);
                return indisp;
            }
            const body = await res.json().catch(() => null);
            const info = classificarStatusCaixa(body, false);
            onEstado(info);
            return info;
        } catch (_e) {
            const indisp = classificarStatusCaixa(null, true);
            onEstado(indisp);
            return indisp;
        }
    }

    function arred2(n) {
        return Math.round(Number(n) * 100) / 100;
    }

    /**
     * Totais operacionais do atendimento (05.22).
     * Campo vazio/inválido → 0. Total nunca negativo.
     */
    function calcularTotaisOperacionais(entrada) {
        const e = entrada || {};
        const subtotal = Math.max(0, arred2(e.subtotal || 0));
        const modo = e.modo_desconto === 'percentual' ? 'percentual' : 'valor';
        let descontoPercentual = 0;
        let descontoValor = 0;
        if (modo === 'percentual') {
            const rawPct = e.desconto_percentual;
            descontoPercentual = (rawPct === '' || rawPct == null || Number.isNaN(Number(rawPct)))
                ? 0
                : Math.min(100, Math.max(0, Number(rawPct)));
            descontoValor = arred2(subtotal * descontoPercentual / 100);
        } else {
            const raw = e.desconto_valor;
            descontoValor = (raw === '' || raw == null || Number.isNaN(Number(raw)))
                ? 0
                : Math.max(0, Number(raw));
            descontoValor = Math.min(subtotal, arred2(descontoValor));
            descontoPercentual = subtotal > 0 ? arred2((descontoValor / subtotal) * 100) : 0;
        }
        const rawAcr = e.acrescimo;
        let acrescimo = (rawAcr === '' || rawAcr == null || Number.isNaN(Number(rawAcr)))
            ? 0
            : Math.max(0, Number(rawAcr));
        acrescimo = arred2(acrescimo);
        const total = Math.max(0, arred2(subtotal - descontoValor + acrescimo));
        return Object.freeze({
            subtotal,
            desconto_valor: descontoValor,
            desconto_percentual: descontoPercentual,
            acrescimo,
            total,
            modo_desconto: modo
        });
    }

    function montarResumoVisual(cart, ajuste) {
        const itens = cart && typeof cart.obterItens === 'function' ? cart.obterItens() : [];
        const qtd = itens.reduce((a, i) => a + Number(i.quantidade || 0), 0);
        const subtotal = cart && typeof cart.calcularTotal === 'function' ? cart.calcularTotal() : 0;
        const totais = calcularTotaisOperacionais(Object.assign({
            subtotal,
            modo_desconto: 'valor',
            desconto_valor: 0,
            desconto_percentual: 0,
            acrescimo: 0
        }, ajuste || {}));
        const Atacado = PrecoAtacadoLib();
        const Promo = PromocaoLib();
        const descAtacado = Atacado && Atacado.somarDescontoAtacadoItens
            ? Atacado.somarDescontoAtacadoItens(itens)
            : 0;
        const descPromocao = Promo && Promo.somarDescontoPromocaoItens
            ? Promo.somarDescontoPromocaoItens(itens)
            : 0;
        return Object.freeze({
            subtotal: moneyVisual(totais.subtotal),
            desconto_atacado: descAtacado > 0 ? moneyVisual(descAtacado) : '—',
            desconto_promocao: descPromocao > 0 ? moneyVisual(descPromocao) : '—',
            itens: qtd,
            desconto: moneyVisual(totais.desconto_valor),
            acrescimo: moneyVisual(totais.acrescimo),
            total: moneyVisual(totais.total),
            totais
        });
    }

    function resolverAcaoEscape(ctx) {
        const c = ctx || {};
        if (c.processamento) return 'BLOQUEAR';
        if (c.modalAberto) return 'FECHAR_MODAL';
        if (c.drawerAberto) return 'FECHAR_DRAWER';
        if (c.pagamentoEmAndamento || c.temAtendimento) return 'PRESERVAR';
        return 'CANCELAR_CARRINHO';
    }

    function podeDispararF10(ctx) {
        const c = ctx || {};
        return !c.disabled && !c.processamento && !!c.permitido;
    }

    function formatarDataHoraPdv(d) {
        const dt = d instanceof Date ? d : new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
    }

    function aplicarTeclaCalc(estado, tecla) {
        const st = estado || { display: '0', acc: null, op: null };
        const t = String(tecla);
        if (t === 'C') return { display: '0', acc: null, op: null };
        if (t === '=' && st.op && st.acc != null) {
            const a = Number(st.acc);
            const b = Number(st.display);
            let r = b;
            if (st.op === '+') r = a + b;
            if (st.op === '-') r = a - b;
            if (st.op === '*') r = a * b;
            if (st.op === '/') r = b === 0 ? a : a / b;
            return { display: String(r), acc: null, op: null };
        }
        if (t === '+' || t === '-' || t === '*' || t === '/') {
            return { display: st.display, acc: Number(st.display), op: t };
        }
        if (t === '.' && String(st.display).includes('.')) return st;
        if (st.display === '0' && t !== '.') return { display: t, acc: st.acc, op: st.op };
        return { display: String(st.display) + t, acc: st.acc, op: st.op };
    }

    async function buscarProdutos(termo, fetchFn) {
        const q = String(termo || '').trim();
        if (!q) return [];
        const fn = fetchFn || fetch;
        const res = await fn(urlBuscaProduto(q), { method: 'GET', headers: headersAuth() });
        if (!res.ok) return [];
        const body = await res.json();
        return Array.isArray(body) ? body : (body.itens || []);
    }

    async function consultarDisponibilidade(produtoId, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlDisponibilidade(produtoId), { method: 'GET', headers: headersAuth() });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || 'Falha na disponibilidade.');
            err.code = body.code || 'ERRO_DISPONIBILIDADE';
            throw err;
        }
        return body;
    }

    function bindUi(doc, api) {
        if (!doc) return;
        const $ = function (sel) { return doc.querySelector(sel); };
        const S = SessionLib();
        api._session = api._session || (S ? S.criarSessao() : { lock: null, estado: ESTADOS.INICIAL });
        try {
            if (api._session && typeof localStorage !== 'undefined') {
                api._session.empresa_operacional_persistida = localStorage.getItem('cds_empresa_id');
            }
        } catch (_e) { /* ignore */ }

        function atualizarBotaoFinalizar() {
            const fin = $('#pdvu-finalizar');
            if (!fin) return;
            const Checkout = globalThis.PdvUniversalCheckout;
            const itens = api._cart ? api._cart.obterItens() : [];
            const S = SessionLib();
            const criado = api._sessaoAtendimento && api._sessaoAtendimento.estado === ESTADOS.ATENDIMENTO_CRIADO;
            const pode = Checkout && Checkout.podeFinalizar(api._contexto, itens);
            const busy = S && S.emProcessamento(api._session);
            fin.disabled = !!(busy || api._checkoutLock || api._tefEmAndamento || api._tefCancelamentoEmAndamento || api._pixEmAndamento || criado || !pode);
        }

        function mostrarAtendimentoCriado(sessao) {
            const box = $('#pdvu-atendimento-criado');
            if (!box) return;
            box.hidden = false;
            const cod = $('#pdvu-atd-codigo');
            if (cod) cod.textContent = sessao.codigo || ('#' + sessao.atendimento_id);
            const emp = $('#pdvu-atd-empresas');
            const nEmp = (sessao.operacoes || []).length;
            if (emp) emp.textContent = 'Empresas envolvidas: ' + nEmp;
            const st = $('#pdvu-atd-status');
            if (st) st.textContent = sessao.status || 'VALIDADO';
        }

        function setEstado(estado, extra) {
            const root = $('#pdvu-root');
            if (!root) return;
            root.setAttribute('data-estado', estado);
            const loading = $('#pdvu-loading');
            const error = $('#pdvu-error');
            const ready = $('#pdvu-ready');
            if (loading) loading.hidden = estado !== ESTADOS.LOADING;
            if (error) error.hidden = estado !== ESTADOS.ERROR;
            if (ready) ready.hidden = estado === ESTADOS.LOADING || estado === ESTADOS.ERROR;
            if (estado === ESTADOS.ERROR && extra) {
                const msg = $('#pdvu-error-msg');
                if (msg) msg.textContent = extra;
            }
        }

        function aplicarAcoesErro(info) {
            const retry = $('#pdvu-retry');
            const login = $('#pdvu-voltar-login');
            const sel = $('#pdvu-erro-selecionar');
            const code = $('#pdvu-error-code');
            if (code) {
                const partes = [];
                if (info && info.status) partes.push('HTTP ' + info.status);
                if (info && info.code) partes.push(info.code);
                code.textContent = partes.join(' · ');
            }
            const cad = $('#pdvu-ir-empresas');
            if (retry) retry.hidden = !(info && (info.acao === 'RETRY' || info.acao === 'CADASTRAR'));
            if (login) login.hidden = !(info && info.acao === 'LOGIN');
            if (sel) sel.hidden = !(info && info.acao === 'SELECIONAR');
            if (cad) cad.hidden = !(info && info.acao === 'CADASTRAR');
        }

        function pintar(ctx) {
            const modelo = montarModeloVisual(ctx);
            const caps = modelo.capabilities;
            const modoEl = $('#pdvu-modo');
            if (modoEl) modoEl.textContent = modelo.modo_rotulo;
            const empEl = $('#pdvu-empresa');
            if (empEl) {
                empEl.textContent = modelo.empresa_rotulo || 'Selecionar empresa';
            }
            const opEl = $('#pdvu-operador');
            if (opEl) {
                opEl.textContent = (modelo.operador && (modelo.operador.nome || modelo.operador.id)) || '—';
            }
            const painel = $('#pdvu-empresas-atendimento');
            if (painel) painel.hidden = !caps.mostrar_painel_empresas_atendimento;
            const btnSel = $('#pdvu-btn-selecionar');
            if (btnSel) btnSel.hidden = !caps.mostrar_seletor && !!modelo.empresa_rotulo;
            if (btnSel && caps.permite_selecao_empresa && !modelo.empresa_rotulo) {
                btnSel.hidden = false;
            }
            const aviso = $('#pdvu-aviso');
            if (aviso) aviso.textContent = avisoContextoPronto(ctx);
            atualizarBotaoFinalizar();
            const lista = $('#pdvu-lista-empresas');
            if (lista) {
                lista.innerHTML = '';
                modelo.empresas.forEach(function (e) {
                    const b = doc.createElement('button');
                    b.type = 'button';
                    b.className = 'pdvu-empresa-opcao';
                    b.setAttribute('data-empresa-id', String(e.id));
                    b.textContent = e.nome || e.razao_social || ('Empresa #' + e.id);
                    lista.appendChild(b);
                });
            }
            setEstado(ESTADOS.READY);
            focarBuscaSeApropriado();
        }

        async function carregar() {
            setEstado(ESTADOS.LOADING);
            try {
                const ctx = await api.carregarContextoComRecuperacao();
                api._contexto = ctx;
                try {
                    console.info('[PDV UNIVERSAL]', {
                        rota: (globalThis.location && globalThis.location.pathname) || '/pdv-universal/',
                        modo: ctx && ctx.modo_operacao,
                        empresa_selecionada: ctx && ctx.empresa_selecionada && ctx.empresa_selecionada.id,
                        endpoint: api.urlContexto(),
                        status: 200
                    });
                } catch (_e) { /* ignore */ }
                pintar(ctx);
                consultarStatusCaixaOficial();
            } catch (err) {
                const info = api.registrarErroContexto(err);
                setEstado(ESTADOS.ERROR, info.mensagem);
                aplicarAcoesErro(info);
            }
        }

        function abrirModal() {
            const modal = $('#pdvu-modal-empresa');
            if (modal) modal.hidden = false;
        }

        function fecharModal() {
            const modal = $('#pdvu-modal-empresa');
            if (modal) modal.hidden = true;
        }

        const retry = $('#pdvu-retry');
        if (retry) retry.addEventListener('click', carregar);
        const voltarLogin = $('#pdvu-voltar-login');
        if (voltarLogin) {
            voltarLogin.addEventListener('click', function () {
                globalThis.location.href = '/login';
            });
        }
        const irEmpresas = $('#pdvu-ir-empresas');
        if (irEmpresas) {
            irEmpresas.addEventListener('click', function () {
                globalThis.location.href = '/erp?page=empresas';
            });
        }
        const erroSel = $('#pdvu-erro-selecionar');
        if (erroSel) erroSel.addEventListener('click', abrirModal);
        const btnSel = $('#pdvu-btn-selecionar');
        if (btnSel) btnSel.addEventListener('click', abrirModal);
        const fechar = $('#pdvu-modal-fechar');
        if (fechar) fechar.addEventListener('click', fecharModal);
        const lista = $('#pdvu-lista-empresas');
        if (lista) {
            lista.addEventListener('click', async function (ev) {
                const btn = ev.target.closest('[data-empresa-id]');
                if (!btn) return;
                try {
                    const ctx = await api.selecionarEmpresaOperacional(btn.getAttribute('data-empresa-id'));
                    api._contexto = ctx;
                    fecharModal();
                    pintar(ctx);
                } catch (err) {
                    setEstado(ESTADOS.ERROR, api.mensagemErro(err));
                    fecharModal();
                }
            });
        }

        const CartLib = (typeof globalThis !== 'undefined' && globalThis.PDVUniversalCart)
            || (typeof require === 'function' ? require('./pdv-universal-cart.js') : null);
        api._cart = CartLib ? CartLib.criarCarrinho() : null;
        api._calc = { display: '0', acc: null, op: null };
        api._ajuste = {
            modo_desconto: 'valor',
            desconto_valor: '',
            desconto_percentual: '',
            acrescimo: ''
        };
        api._modalidadeAtendimento = 'BALCAO';
        api._entregaConfigurada = false;
        api._entregaOperacaoEmAndamento = false;
        api._clientesEntrega = [];

        function modalidadeAtual() {
            return String(api._modalidadeAtendimento || 'BALCAO').toUpperCase() === 'ENTREGA'
                ? 'ENTREGA'
                : 'BALCAO';
        }

        function pintarModalidadeUi() {
            const mod = modalidadeAtual();
            const bal = $('#pdvu-modalidade-balcao');
            const ent = $('#pdvu-modalidade-entrega');
            const st = $('#pdvu-modalidade-status');
            const cfg = $('#pdvu-btn-configurar-entrega');
            const formaBox = doc.querySelector('.pdvu-forma-box');
            if (bal) {
                bal.classList.toggle('pdvu-modalidade-btn--ativo', mod === 'BALCAO');
            }
            if (ent) {
                ent.classList.toggle('pdvu-modalidade-btn--ativo', mod === 'ENTREGA');
                ent.classList.toggle('pdvu-modalidade-btn--entrega', true);
            }
            if (st) {
                if (api._entregaConfigurada) {
                    st.textContent = 'Entrega configurada';
                } else {
                    st.textContent = mod === 'ENTREGA' ? 'Entrega — configure cliente/endereço' : 'Balcão';
                }
            }
            if (cfg) cfg.hidden = mod !== 'ENTREGA';
            if (formaBox) formaBox.hidden = mod === 'ENTREGA';
        }

        function definirModalidade(mod) {
            const Entrega = EntregaLib();
            const alvo = String(mod || 'BALCAO').toUpperCase() === 'ENTREGA' ? 'ENTREGA' : 'BALCAO';
            if (alvo === 'ENTREGA') {
                const gate = Entrega && Entrega.entregaDisponivelNoModo
                    ? Entrega.entregaDisponivelNoModo(api._contexto)
                    : { ok: false, mensagem: 'Adaptador de entrega indisponível.' };
                if (!gate.ok) {
                    aviso(gate.mensagem || gate.code || 'Entrega indisponível.');
                    api._modalidadeAtendimento = 'BALCAO';
                    pintarModalidadeUi();
                    return false;
                }
            }
            api._modalidadeAtendimento = alvo;
            if (alvo === 'BALCAO') {
                api._entregaConfigurada = false;
            }
            pintarModalidadeUi();
            atualizarBotaoFinalizar();
            return true;
        }

        function fecharModalEntrega(voltarBalcao) {
            const modal = $('#pdvu-modal-entrega');
            if (modal) modal.hidden = true;
            const msg = $('#pdvu-entrega-msg');
            if (msg) msg.textContent = '';
            if (voltarBalcao) definirModalidade('BALCAO');
        }

        async function carregarClientesEntregaModal() {
            const Entrega = EntregaLib();
            const sel = $('#pdvu-entrega-cliente');
            if (!Entrega || !sel) return;
            sel.innerHTML = '<option value="">Consumidor</option>';
            try {
                const lista = await Entrega.listarClientes();
                api._clientesEntrega = lista;
                lista.forEach(function (c) {
                    const opt = doc.createElement('option');
                    opt.value = String(c.id);
                    opt.textContent = c.nome || ('Cliente #' + c.id);
                    sel.appendChild(opt);
                });
            } catch (_e) {
                api._clientesEntrega = [];
            }
        }

        function lerFormEntregaModal() {
            return {
                cliente_id: ($('#pdvu-entrega-cliente') && $('#pdvu-entrega-cliente').value) || null,
                telefone_entrega: ($('#pdvu-entrega-telefone') && $('#pdvu-entrega-telefone').value) || '',
                cep_entrega: ($('#pdvu-entrega-cep') && $('#pdvu-entrega-cep').value) || '',
                endereco_entrega: ($('#pdvu-entrega-endereco') && $('#pdvu-entrega-endereco').value) || '',
                numero_entrega: ($('#pdvu-entrega-numero') && $('#pdvu-entrega-numero').value) || '',
                bairro_entrega: ($('#pdvu-entrega-bairro') && $('#pdvu-entrega-bairro').value) || '',
                cidade_entrega: ($('#pdvu-entrega-cidade') && $('#pdvu-entrega-cidade').value) || '',
                uf_entrega: ($('#pdvu-entrega-uf') && $('#pdvu-entrega-uf').value) || '',
                taxa_entrega: ($('#pdvu-entrega-taxa') && $('#pdvu-entrega-taxa').value) || '0',
                pagamento_previsto: ($('#pdvu-entrega-pagamento') && $('#pdvu-entrega-pagamento').value) || 'NAO_INFORMADO'
            };
        }

        async function abrirModalEntrega() {
            const Entrega = EntregaLib();
            if (!Entrega) {
                aviso('Adaptador de entrega indisponível.');
                return;
            }
            const itens = api._cart ? api._cart.obterItens() : [];
            if (!itens.length) {
                aviso('Adicione itens ao carrinho antes de configurar a entrega.');
                return;
            }
            await carregarClientesEntregaModal();
            const modal = $('#pdvu-modal-entrega');
            if (modal) modal.hidden = false;
            const end = $('#pdvu-entrega-endereco');
            if (end) end.focus();
        }

        async function confirmarEntregaOperacional() {
            const Entrega = EntregaLib();
            if (!Entrega || api._entregaOperacaoEmAndamento) return;
            const itens = api._cart ? api._cart.obterItens() : [];
            const resumo = montarResumoVisual(api._cart, api._ajuste);
            const totais = resumo.totais;
            const form = lerFormEntregaModal();
            const msg = $('#pdvu-entrega-msg');
            api._entregaOperacaoEmAndamento = true;
            if (msg) msg.textContent = '';
            try {
                const ret = await Entrega.criarVendaEntrega({
                    itens,
                    totais,
                    desconto: totais.desconto_valor,
                    form
                });
                api._entregaConfigurada = true;
                fecharModalEntrega(false);
                api._cart.limpar();
                api._ajuste = {
                    modo_desconto: 'valor',
                    desconto_valor: '',
                    desconto_percentual: '',
                    acrescimo: ''
                };
                pintarCarrinho();
                definirModalidade('BALCAO');
                aviso((ret && ret.message) || 'Venda para entrega criada.');
            } catch (err) {
                if (msg) msg.textContent = err.message || 'Erro ao confirmar entrega.';
                aviso(err.message || 'Erro ao confirmar entrega.');
            } finally {
                api._entregaOperacaoEmAndamento = false;
            }
        }

        const btnModBalcao = $('#pdvu-modalidade-balcao');
        if (btnModBalcao) {
            btnModBalcao.addEventListener('click', function () {
                definirModalidade('BALCAO');
            });
        }
        const btnModEntrega = $('#pdvu-modalidade-entrega');
        if (btnModEntrega) {
            btnModEntrega.addEventListener('click', function () {
                if (definirModalidade('ENTREGA')) {
                    void abrirModalEntrega();
                }
            });
        }
        const btnCfgEntrega = $('#pdvu-btn-configurar-entrega');
        if (btnCfgEntrega) {
            btnCfgEntrega.addEventListener('click', function () {
                void abrirModalEntrega();
            });
        }
        const selClienteEntrega = $('#pdvu-entrega-cliente');
        if (selClienteEntrega) {
            selClienteEntrega.addEventListener('change', function () {
                const Entrega = EntregaLib();
                if (!Entrega) return;
                const id = selClienteEntrega.value;
                const cli = (api._clientesEntrega || []).find(function (c) {
                    return String(c.id) === String(id);
                });
                if (!cli) return;
                const end = Entrega.enderecoDeCliente(cli);
                const map = {
                    telefone_entrega: '#pdvu-entrega-telefone',
                    cep_entrega: '#pdvu-entrega-cep',
                    endereco_entrega: '#pdvu-entrega-endereco',
                    numero_entrega: '#pdvu-entrega-numero',
                    bairro_entrega: '#pdvu-entrega-bairro',
                    cidade_entrega: '#pdvu-entrega-cidade',
                    uf_entrega: '#pdvu-entrega-uf'
                };
                Object.keys(map).forEach(function (k) {
                    const el = $(map[k]);
                    if (el && end[k] != null) el.value = end[k];
                });
            });
        }
        const btnEntregaConfirmar = $('#pdvu-entrega-confirmar');
        if (btnEntregaConfirmar) {
            btnEntregaConfirmar.addEventListener('click', function () {
                void confirmarEntregaOperacional();
            });
        }
        const btnEntregaCancelar = $('#pdvu-entrega-cancelar');
        if (btnEntregaCancelar) {
            btnEntregaCancelar.addEventListener('click', function () {
                fecharModalEntrega(true);
            });
        }
        pintarModalidadeUi();

        function pintarStatusCaixa(info) {
            const el = $('#pdvu-status-caixa');
            if (!el) return;
            el.textContent = info.rotulo;
            el.setAttribute('data-caixa', info.codigo);
            el.className = 'pdvu-caixa pdvu-caixa--' + String(info.codigo).toLowerCase();
            api._caixaStatus = info.codigo;
            sincronizarBotoesCaixa(info.codigo);
        }

        function sincronizarBotoesCaixa(codigo) {
            const Caixa = CaixaLib();
            const vis = Caixa && Caixa.acoesVisiveisPorStatus
                ? Caixa.acoesVisiveisPorStatus(codigo)
                : { abrir: false, sangria: false, suprimento: false, fechar: false, atualizar: true };
            function setBtn(id, show) {
                const b = $(id);
                if (!b) return;
                b.hidden = !show;
                b.disabled = !show || !!api._caixaOperacaoEmAndamento;
            }
            setBtn('#pdvu-btn-abrir-caixa', vis.abrir);
            setBtn('#pdvu-btn-sangria', vis.sangria);
            setBtn('#pdvu-btn-suprimento', vis.suprimento);
            setBtn('#pdvu-btn-fechar-caixa', vis.fechar);
        }

        function fecharModalCaixa() {
            const modal = $('#pdvu-modal-caixa');
            if (modal) modal.hidden = true;
            api._caixaAcaoModal = null;
            const msg = $('#pdvu-caixa-msg');
            if (msg) msg.textContent = '';
        }

        function abrirModalCaixa(acao) {
            const Caixa = CaixaLib();
            if (!Caixa) {
                aviso('Adaptador de caixa indisponível.');
                return;
            }
            api._caixaAcaoModal = acao;
            const modal = $('#pdvu-modal-caixa');
            const titulo = $('#pdvu-caixa-titulo');
            const hint = $('#pdvu-caixa-hint');
            const lblValor = $('#pdvu-caixa-lbl-valor');
            const inpValor = $('#pdvu-caixa-valor');
            const lblMotivo = $('#pdvu-caixa-lbl-motivo');
            const inpMotivo = $('#pdvu-caixa-motivo');
            const inpSenha = $('#pdvu-caixa-senha');
            const msg = $('#pdvu-caixa-msg');
            if (msg) msg.textContent = '';
            if (inpValor) inpValor.value = '';
            if (inpMotivo) inpMotivo.value = '';
            if (inpSenha) inpSenha.value = '';

            const showMotivo = acao === Caixa.ACOES.SANGRIA
                || acao === Caixa.ACOES.SUPRIMENTO
                || acao === Caixa.ACOES.FECHAR;
            if (lblMotivo) lblMotivo.hidden = !showMotivo;
            if (inpMotivo) inpMotivo.hidden = !showMotivo;

            if (acao === Caixa.ACOES.ABRIR) {
                if (titulo) titulo.textContent = 'ABRIR CAIXA';
                if (hint) hint.textContent = 'Informe o valor inicial (fundo de troco).';
                if (lblValor) lblValor.textContent = 'Valor inicial';
                if (lblMotivo) lblMotivo.textContent = 'Motivo / Observação';
            } else if (acao === Caixa.ACOES.SANGRIA) {
                if (titulo) titulo.textContent = 'SANGRIA';
                if (hint) hint.textContent = 'Retirada de dinheiro do caixa.';
                if (lblValor) lblValor.textContent = 'Valor';
                if (lblMotivo) lblMotivo.textContent = 'Motivo';
            } else if (acao === Caixa.ACOES.SUPRIMENTO) {
                if (titulo) titulo.textContent = 'SUPRIMENTO';
                if (hint) hint.textContent = 'Entrada de dinheiro no caixa.';
                if (lblValor) lblValor.textContent = 'Valor';
                if (lblMotivo) lblMotivo.textContent = 'Motivo';
            } else if (acao === Caixa.ACOES.FECHAR) {
                if (titulo) titulo.textContent = 'FECHAR CAIXA';
                if (hint) hint.textContent = 'Confirme o valor informado e feche o turno.';
                if (lblValor) lblValor.textContent = 'Valor informado';
                if (lblMotivo) lblMotivo.textContent = 'Observação';
            }
            if (modal) modal.hidden = false;
            if (inpValor) inpValor.focus();
        }

        async function confirmarOperacaoCaixa() {
            const Caixa = CaixaLib();
            const acao = api._caixaAcaoModal;
            if (!Caixa || !acao || api._caixaOperacaoEmAndamento) return;

            const valor = $('#pdvu-caixa-valor') ? $('#pdvu-caixa-valor').value : '';
            const motivo = $('#pdvu-caixa-motivo') ? $('#pdvu-caixa-motivo').value : '';
            const senha = $('#pdvu-caixa-senha') ? $('#pdvu-caixa-senha').value : '';
            const msg = $('#pdvu-caixa-msg');

            api._caixaOperacaoEmAndamento = true;
            sincronizarBotoesCaixa(api._caixaStatus);
            try {
                let ret = null;
                if (acao === Caixa.ACOES.ABRIR) {
                    ret = await Caixa.abrirCaixa({
                        valor_inicial: valor === '' ? 0 : valor,
                        senha_admin: senha || undefined
                    });
                    aviso((ret && ret.message) || 'Caixa aberto com sucesso.');
                } else if (acao === Caixa.ACOES.SANGRIA) {
                    ret = await Caixa.registrarSangria({
                        valor,
                        motivo,
                        senha_admin: senha || undefined
                    });
                    aviso((ret && ret.message) || 'Sangria registrada.');
                } else if (acao === Caixa.ACOES.SUPRIMENTO) {
                    ret = await Caixa.registrarSuprimento({
                        valor,
                        motivo,
                        senha_admin: senha || undefined
                    });
                    aviso((ret && ret.message) || 'Suprimento registrado.');
                } else if (acao === Caixa.ACOES.FECHAR) {
                    ret = await Caixa.fecharCaixa({
                        valor_informado: valor === '' ? 0 : valor,
                        observacao: motivo,
                        senha_admin: senha || undefined
                    });
                    const partes = [(ret && ret.message) || 'Caixa fechado com sucesso.'];
                    if (ret && ret.resumo) {
                        partes.push('Resumo retornado pelo servidor.');
                    }
                    aviso(partes.join(' '));
                }
                fecharModalCaixa();
                await consultarStatusCaixaOficial();
            } catch (err) {
                const texto = (err && err.message) || 'Erro na operação de caixa.';
                if (msg) msg.textContent = texto;
                aviso(texto);
            } finally {
                api._caixaOperacaoEmAndamento = false;
                sincronizarBotoesCaixa(api._caixaStatus || 'INDISPONIVEL');
            }
        }

        async function consultarStatusCaixaOficial() {
            return atualizarStatusCaixa({
                onEstado: pintarStatusCaixa
            });
        }

        const btnAtualizarCaixa = $('#pdvu-btn-atualizar-caixa');
        if (btnAtualizarCaixa) {
            btnAtualizarCaixa.addEventListener('click', function () {
                consultarStatusCaixaOficial();
            });
        }

        const Cx = CaixaLib();
        const mapBtnCaixa = [
            ['#pdvu-btn-abrir-caixa', Cx && Cx.ACOES.ABRIR],
            ['#pdvu-btn-sangria', Cx && Cx.ACOES.SANGRIA],
            ['#pdvu-btn-suprimento', Cx && Cx.ACOES.SUPRIMENTO],
            ['#pdvu-btn-fechar-caixa', Cx && Cx.ACOES.FECHAR]
        ];
        mapBtnCaixa.forEach(function (par) {
            const el = $(par[0]);
            if (el && par[1]) {
                el.addEventListener('click', function () {
                    abrirModalCaixa(par[1]);
                });
            }
        });
        const btnCaixaConfirmar = $('#pdvu-caixa-confirmar');
        if (btnCaixaConfirmar) {
            btnCaixaConfirmar.addEventListener('click', function () {
                void confirmarOperacaoCaixa();
            });
        }
        const btnCaixaCancelar = $('#pdvu-caixa-cancelar');
        if (btnCaixaCancelar) {
            btnCaixaCancelar.addEventListener('click', fecharModalCaixa);
        }

        function atualizarRelogio() {
            const el = $('#pdvu-data-hora');
            if (el) el.textContent = formatarDataHoraPdv(new Date());
        }
        atualizarRelogio();
        if (typeof globalThis.setInterval === 'function') {
            api._relogioInterval = globalThis.setInterval(atualizarRelogio, 1000);
        }

        function drawerAberto() {
            const d = $('#pdvu-drawer');
            return !!(d && !d.hidden);
        }

        function setDrawer(aberto) {
            const d = $('#pdvu-drawer');
            const btn = $('#pdvu-btn-menu');
            if (d) d.hidden = !aberto;
            if (btn) btn.setAttribute('aria-expanded', aberto ? 'true' : 'false');
        }

        const btnMenu = $('#pdvu-btn-menu');
        if (btnMenu) {
            btnMenu.addEventListener('click', function () {
                setDrawer(!drawerAberto());
            });
        }
        const btnDrawerFecha = $('#pdvu-drawer-fechar');
        if (btnDrawerFecha) btnDrawerFecha.addEventListener('click', function () { setDrawer(false); });
        const btnDrawerEmp = $('#pdvu-drawer-empresa');
        if (btnDrawerEmp) {
            btnDrawerEmp.addEventListener('click', function () {
                setDrawer(false);
                abrirModal();
            });
        }

        function pintarCalc() {
            const el = $('#pdvu-calc-display');
            if (el) el.textContent = api._calc.display;
        }
        const btnCalc = $('#pdvu-btn-calculadora');
        if (btnCalc) {
            btnCalc.addEventListener('click', function () {
                const box = $('#pdvu-calc');
                if (box) box.hidden = !box.hidden;
            });
        }
        const calcFecha = $('#pdvu-calc-fechar');
        if (calcFecha) {
            calcFecha.addEventListener('click', function () {
                const box = $('#pdvu-calc');
                if (box) box.hidden = true;
            });
        }
        const calcGrid = doc.querySelector && doc.querySelector('.pdvu-calc-grid');
        if (calcGrid) {
            calcGrid.addEventListener('click', function (ev) {
                const b = ev.target.closest('[data-calc]');
                if (!b) return;
                api._calc = aplicarTeclaCalc(api._calc, b.getAttribute('data-calc'));
                pintarCalc();
            });
        }

        function aviso(msg) {
            const el = $('#pdvu-aviso');
            if (el) el.textContent = msg || '';
            if (msg && typeof globalThis.showNotification === 'function') {
                globalThis.showNotification(msg, 'info');
            }
        }

        function pintarEmpresasAtendimento() {
            const painel = $('#pdvu-empresas-atendimento');
            const lista = $('#pdvu-empresas-atendimento-lista');
            const caps = aplicarCapabilities(api._contexto);
            if (painel) painel.hidden = !caps.mostrar_painel_empresas_atendimento;
            if (!lista) return;
            const itens = api._cart ? api._cart.obterItens() : [];
            const nomes = [];
            itens.forEach(function (i) {
                const n = i.empresa_nome || ('Empresa ' + i.empresa_id);
                if (nomes.indexOf(n) < 0) nomes.push(n);
            });
            lista.textContent = nomes.length ? nomes.join(', ') : 'Nenhuma empresa adicionada';
        }

        async function recalcularPrecoComercialItem(produtoId, empresaId) {
            const Atacado = PrecoAtacadoLib();
            const Promo = PromocaoLib();
            if (!api._cart || !api._cart.localizar) return;
            const item = api._cart.localizar(produtoId, empresaId);
            if (!item) return;

            const precoOriginal = Number(item.preco_base != null ? item.preco_base : item.valor_unitario);
            if (item.preco_base == null || item.preco_base === undefined) {
                item.preco_base = precoOriginal;
            }

            let precoComercial = precoOriginal;
            try {
                if (Promo) {
                    const promo = await Promo.recalcularPromocaoItem(item);
                    precoComercial = Number(promo.precoComercial != null ? promo.precoComercial : precoOriginal);
                }
            } catch (_e) {
                if (Promo && Promo.limparCamposPromocaoNoItem) Promo.limparCamposPromocaoNoItem(item);
            }

            try {
                if (Atacado) {
                    await Atacado.recalcularPrecoItem(item, undefined, { precoComercial });
                } else {
                    item.valor_unitario = precoComercial;
                    item.subtotal = Math.round(precoComercial * Number(item.quantidade) * 100) / 100;
                }
            } catch (_e) { /* mantém preço atual */ }
        }

        async function recalcularAtacadoItem(produtoId, empresaId) {
            await recalcularPrecoComercialItem(produtoId, empresaId);
        }

        async function aplicarQuantidadeLocal(produtoId, empresaId, novaQtd) {
            if (!api._cart) return;
            try {
                api._cart.aplicarQuantidadeInteira
                    ? api._cart.aplicarQuantidadeInteira(produtoId, empresaId, novaQtd)
                    : api._cart.alterarQuantidade(produtoId, empresaId, novaQtd);
                await recalcularAtacadoItem(produtoId, empresaId);
                pintarCarrinho();
                aviso('');
            } catch (err) {
                aviso(err.message || 'Não foi possível alterar a quantidade.');
                pintarCarrinho();
            }
        }

        function confirmarEdicaoQuantidade(inputEl, item) {
            if (!api._cart || !inputEl) return;
            if (!api._cart.localizar(item.produto_id, item.empresa_id)) return;
            const CartLib = (typeof globalThis !== 'undefined' && globalThis.PDVUniversalCart)
                || null;
            const porPeso = CartLib && CartLib.produtoVendidoPorPeso
                ? CartLib.produtoVendidoPorPeso(item)
                : false;
            const interpretar = CartLib && CartLib.interpretarQuantidadeUi
                ? CartLib.interpretarQuantidadeUi
                : (CartLib && CartLib.interpretarQuantidadeInteiraUi
                    ? CartLib.interpretarQuantidadeInteiraUi
                    : null);
            const formatar = CartLib && CartLib.formatarQuantidadeUi
                ? CartLib.formatarQuantidadeUi
                : function (q) { return String(Math.trunc(Number(q)) || 1); };
            const qtdAnterior = Number(item.quantidade);
            const decisao = interpretar
                ? (CartLib.interpretarQuantidadeUi
                    ? CartLib.interpretarQuantidadeUi(inputEl.value, qtdAnterior, { permiteDecimal: porPeso })
                    : interpretar(inputEl.value, qtdAnterior))
                : { acao: 'aplicar', quantidade: parseInt(inputEl.value, 10) };
            if (decisao.acao === 'restaurar') {
                inputEl.value = formatar(qtdAnterior, porPeso);
                return;
            }
            if (decisao.acao === 'remover') {
                aplicarQuantidadeLocal(item.produto_id, item.empresa_id, 0);
                return;
            }
            if (Math.abs(Number(decisao.quantidade) - qtdAnterior) < 1e-9) {
                inputEl.value = formatar(qtdAnterior, porPeso);
                return;
            }
            aplicarQuantidadeLocal(item.produto_id, item.empresa_id, decisao.quantidade);
        }

        function pintarCarrinho() {
            const box = $('#pdvu-linhas-carrinho');
            if (!api._cart) return;
            const itens = api._cart.obterItens();
            const resumo = montarResumoVisual(api._cart, api._ajuste);
            const subEl = $('#pdvu-subtotal');
            const descEl = $('#pdvu-desconto');
            const acrEl = $('#pdvu-acrescimo');
            const totalEl = $('#pdvu-total');
            const qtdEl = $('#pdvu-qtd-itens');
            if (subEl) subEl.textContent = resumo.subtotal;
            if (descEl) descEl.textContent = resumo.desconto;
            if (acrEl) acrEl.textContent = resumo.acrescimo;
            if (totalEl) totalEl.textContent = resumo.total;
            if (qtdEl) qtdEl.textContent = String(resumo.itens);
            atualizarBotaoFinalizar();
            pintarEmpresasAtendimento();
            if (!box) return;
            box.innerHTML = '';
            if (!itens.length) {
                const tr = doc.createElement('tr');
                tr.id = 'pdvu-atendimento-vazio';
                tr.className = 'pdvu-tr-vazio';
                tr.innerHTML = '<td colspan="8">Nenhum item no carrinho</td>';
                box.appendChild(tr);
                return;
            }
            const caps = aplicarCapabilities(api._contexto);
            itens.forEach(function (i) {
                const tr = doc.createElement('tr');
                tr.className = 'pdvu-linha';
                tr.setAttribute('data-produto-id', String(i.produto_id));
                tr.setAttribute('data-empresa-id', String(i.empresa_id));
                const emp = caps.empresa_por_item
                    ? `<small>Empresa: ${i.empresa_nome || i.empresa_id}</small>`
                    : `<small class="pdvu-emp-discreta">Empresa ${i.empresa_id}</small>`;
                const un = i.unidade || 'UN';
                const descPct = i.desconto_percentual != null ? String(i.desconto_percentual) : '—';
                const descRs = i.desconto_valor != null ? moneyVisual(i.desconto_valor) : '—';
                const porPeso = CartLib && CartLib.produtoVendidoPorPeso
                    ? CartLib.produtoVendidoPorPeso(i)
                    : false;
                const qtdExibida = CartLib && CartLib.formatarQuantidadeUi
                    ? CartLib.formatarQuantidadeUi(i.quantidade, porPeso)
                    : String(Math.trunc(Number(i.quantidade)) || 0);
                const qtdParaBotoes = Math.trunc(Number(i.quantidade)) || 0;
                tr.innerHTML = `<td class="pdvu-qtd-cell"></td><td>${un}</td>`
                    + `<td><strong>${i.descricao}</strong>${emp}</td>`
                    + `<td>${moneyVisual(i.valor_unitario)}</td>`
                    + `<td>${descPct}</td><td>${descRs}</td>`
                    + `<td>${moneyVisual(i.subtotal)}</td><td class="pdvu-acoes-cell"></td>`;

                const qtdCell = tr.querySelector('.pdvu-qtd-cell');
                const ctrl = doc.createElement('div');
                ctrl.className = 'pdvu-qtd-ctrl';
                const menos = doc.createElement('button');
                menos.type = 'button';
                menos.className = 'pdvu-qtd-btn pdvu-qtd-menos';
                menos.setAttribute('aria-label', 'Diminuir quantidade');
                menos.textContent = '−';
                const input = doc.createElement('input');
                input.type = 'text';
                input.className = 'pdvu-qtd-input' + (porPeso ? ' pdvu-qtd-input--peso' : '');
                input.setAttribute('inputmode', porPeso ? 'decimal' : 'numeric');
                input.setAttribute('aria-label', 'Quantidade');
                input.value = qtdExibida;
                input.dataset.qtdAnterior = String(i.quantidade);
                const mais = doc.createElement('button');
                mais.type = 'button';
                mais.className = 'pdvu-qtd-btn pdvu-qtd-mais';
                mais.setAttribute('aria-label', 'Aumentar quantidade');
                mais.textContent = '+';

                mais.addEventListener('click', function () {
                    aplicarQuantidadeLocal(i.produto_id, i.empresa_id, qtdParaBotoes + 1);
                });
                menos.addEventListener('click', function () {
                    aplicarQuantidadeLocal(i.produto_id, i.empresa_id, qtdParaBotoes - 1);
                });
                input.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        input.blur();
                    }
                });
                input.addEventListener('blur', function () {
                    confirmarEdicaoQuantidade(input, i);
                });

                ctrl.appendChild(menos);
                ctrl.appendChild(input);
                ctrl.appendChild(mais);
                if (qtdCell) qtdCell.appendChild(ctrl);

                const acaoCell = tr.querySelector('.pdvu-acoes-cell');
                if (acaoCell) {
                    if (porPeso) {
                        const btnPesar = doc.createElement('button');
                        btnPesar.type = 'button';
                        btnPesar.className = 'pdvu-btn-pesar-item';
                        btnPesar.setAttribute('data-acao', 'PESAR');
                        btnPesar.setAttribute('aria-label', 'Informar peso');
                        btnPesar.title = 'Informar peso';
                        btnPesar.textContent = 'PESAR';
                        btnPesar.addEventListener('click', function () {
                            abrirPesagemManual(i);
                        });
                        acaoCell.appendChild(btnPesar);
                    }
                    const btnRemover = doc.createElement('button');
                    btnRemover.type = 'button';
                    btnRemover.className = 'pdvu-btn-remover-item';
                    btnRemover.setAttribute('aria-label', 'Remover item');
                    btnRemover.setAttribute('data-acao', 'REMOVER');
                    btnRemover.title = 'Remover';
                    btnRemover.textContent = '×';
                    btnRemover.addEventListener('click', function () {
                        removerItemManualUi(i.produto_id, i.empresa_id);
                    });
                    acaoCell.appendChild(btnRemover);
                }
                box.appendChild(tr);
            });
        }

        function garantirModalPesagem() {
            let modal = $('#pdvu-modal-pesagem');
            if (modal) return modal;
            const host = (doc.body) || (doc.documentElement);
            if (!host || !doc.createElement) return null;
            modal = doc.createElement('div');
            modal.id = 'pdvu-modal-pesagem';
            modal.className = 'pdvu-overlay';
            modal.hidden = true;
            modal.innerHTML = ''
                + '<div class="pdvu-dialog pdvu-dialog-pesagem" role="dialog" aria-labelledby="pdvu-pesagem-titulo">'
                + '<h2 id="pdvu-pesagem-titulo">PESO DO PRODUTO</h2>'
                + '<p class="pdvu-pesagem-produto-label">Produto:</p>'
                + '<p id="pdvu-pesagem-produto" class="pdvu-pesagem-produto">—</p>'
                + '<label class="pdvu-pesagem-label" for="pdvu-pesagem-input">Peso:</label>'
                + '<div class="pdvu-pesagem-campo">'
                + '<input id="pdvu-pesagem-input" class="pdvu-pesagem-input" type="text" inputmode="decimal" autocomplete="off">'
                + '<span id="pdvu-pesagem-un" class="pdvu-pesagem-un">KG</span>'
                + '</div>'
                + '<p id="pdvu-pesagem-msg" class="pdvu-aviso"></p>'
                + '<div class="pdvu-pesagem-acoes">'
                + '<button type="button" id="pdvu-pesagem-cancelar" class="pdvu-btn">CANCELAR</button>'
                + '<button type="button" id="pdvu-pesagem-confirmar" class="pdvu-finalizar">CONFIRMAR</button>'
                + '</div>'
                + '</div>';
            host.appendChild(modal);
            const btnCancel = modal.querySelector('#pdvu-pesagem-cancelar');
            const btnOk = modal.querySelector('#pdvu-pesagem-confirmar');
            const inp = modal.querySelector('#pdvu-pesagem-input');
            if (btnCancel) {
                btnCancel.addEventListener('click', function () {
                    fecharPesagemManual(false);
                });
            }
            if (btnOk) {
                btnOk.addEventListener('click', function () {
                    confirmarPesagemManual();
                });
            }
            if (inp) {
                inp.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        confirmarPesagemManual();
                    }
                });
            }
            return modal;
        }

        function abrirPesagemManual(item) {
            if (!deveExibirAcaoPesagemManual(item)) return;
            const modal = garantirModalPesagem();
            if (!modal) return;
            const estado = montarEstadoPesagemManual(item);
            api._pesagem = {
                produto_id: estado.produto_id,
                empresa_id: estado.empresa_id,
                quantidade_antes: estado.peso_atual
            };
            const nomeEl = $('#pdvu-pesagem-produto');
            if (nomeEl) nomeEl.textContent = estado.descricao || '—';
            const unEl = $('#pdvu-pesagem-un');
            if (unEl) unEl.textContent = estado.unidade || 'KG';
            const inp = $('#pdvu-pesagem-input');
            if (inp) {
                inp.value = estado.peso_atual_formatado;
                inp.focus();
                if (typeof inp.select === 'function') inp.select();
            }
            const msg = $('#pdvu-pesagem-msg');
            if (msg) msg.textContent = '';
            modal.hidden = false;
        }

        function fecharPesagemManual() {
            api._pesagem = null;
            const modal = $('#pdvu-modal-pesagem');
            if (modal) modal.hidden = true;
            const msg = $('#pdvu-pesagem-msg');
            if (msg) msg.textContent = '';
        }

        function confirmarPesagemManual() {
            const ctx = api._pesagem;
            if (!ctx || !api._cart) return;
            const inp = $('#pdvu-pesagem-input');
            const raw = inp ? inp.value : '';
            const decisao = interpretarPesoManualUi(raw, ctx.quantidade_antes);
            if (decisao.acao !== 'aplicar') {
                const msg = $('#pdvu-pesagem-msg');
                if (msg) msg.textContent = 'Informe um peso válido maior que zero.';
                if (inp && CartApi() && CartApi().formatarQuantidadeUi) {
                    inp.value = CartApi().formatarQuantidadeUi(ctx.quantidade_antes, true);
                }
                return;
            }
            const r = aplicarPesoManualNoCarrinho(
                api._cart,
                ctx.produto_id,
                ctx.empresa_id,
                decisao.quantidade
            );
            if (!r.ok) {
                const msg = $('#pdvu-pesagem-msg');
                if (msg) msg.textContent = r.mensagem || 'Não foi possível aplicar o peso.';
                return;
            }
            fecharPesagemManual();
            pintarCarrinho();
            aviso('');
        }

        function removerItemManualUi(produtoId, empresaId) {
            if (!api._cart) return;
            const removido = api._cart.removerItem(produtoId, empresaId);
            pintarCarrinho();
            if (removido) aviso('ITEM REMOVIDO');
        }

        function lerAjusteDosInputs() {
            const rs = $('#pdvu-input-desconto-rs');
            const pct = $('#pdvu-input-desconto-pct');
            const acr = $('#pdvu-input-acrescimo');
            return {
                modo_desconto: (api._ajuste && api._ajuste.modo_desconto) || 'valor',
                desconto_valor: rs ? rs.value : '',
                desconto_percentual: pct ? pct.value : '',
                acrescimo: acr ? acr.value : ''
            };
        }

        function aplicarAjusteERepintar(modo) {
            api._ajuste = lerAjusteDosInputs();
            if (modo) api._ajuste.modo_desconto = modo;
            pintarCarrinho();
        }

        const inpDescRs = $('#pdvu-input-desconto-rs');
        if (inpDescRs) {
            inpDescRs.addEventListener('input', function () {
                aplicarAjusteERepintar('valor');
            });
        }
        const inpDescPct = $('#pdvu-input-desconto-pct');
        if (inpDescPct) {
            inpDescPct.addEventListener('input', function () {
                aplicarAjusteERepintar('percentual');
            });
        }
        const inpAcr = $('#pdvu-input-acrescimo');
        if (inpAcr) {
            inpAcr.addEventListener('input', function () {
                aplicarAjusteERepintar(api._ajuste && api._ajuste.modo_desconto);
            });
        }

        function focarBuscaSeApropriado() {
            if (modalOperacionalAberto()) return;
            const buscaEl = $('#pdvu-busca-input');
            if (buscaEl && typeof buscaEl.focus === 'function') {
                buscaEl.focus();
                if (typeof buscaEl.select === 'function') buscaEl.select();
            }
        }

        function limparBuscaEFocar() {
            const buscaEl = $('#pdvu-busca-input');
            if (buscaEl) buscaEl.value = '';
            const lista = $('#pdvu-resultados');
            if (lista) lista.innerHTML = '';
            api._resultadosBusca = [];
            api._indiceResultado = -1;
            focarBuscaSeApropriado();
        }

        function pintarResultadosBusca(itens, indiceSelecionado) {
            const lista = $('#pdvu-resultados');
            if (!lista) return;
            lista.innerHTML = '';
            api._resultadosBusca = Array.isArray(itens) ? itens.slice() : [];
            const idx = indiceSelecionado == null ? (api._resultadosBusca.length ? 0 : -1) : indiceSelecionado;
            api._indiceResultado = idx;
            api._resultadosBusca.forEach(function (p, i) {
                const b = doc.createElement('button');
                b.type = 'button';
                b.className = 'pdvu-resultado' + (i === idx ? ' pdvu-resultado--sel' : '');
                b.setAttribute('data-resultado-idx', String(i));
                b.textContent = p.nome || p.descricao || ('#' + p.id);
                b.addEventListener('click', function () {
                    tentarAdicionar(p, null, 1)
                        .then(function (ok) {
                            if (ok !== false) limparBuscaEFocar();
                        })
                        .catch(function (err) { aviso(err.message); });
                });
                lista.appendChild(b);
            });
        }

        /**
         * @returns {Promise<boolean|undefined>} false = modal empresa aberto / bloqueado; true = adicionado
         */
        async function tentarAdicionar(produto, empresaEscolhida, quantidade) {
            const qtd = Number(quantidade) > 0 ? Number(quantidade) : 1;
            const caps = aplicarCapabilities(api._contexto);
            const disp = await api.consultarDisponibilidade(produto.id || produto.produto_id);
            const idf = CartLib.identificarEmpresaOperacional({
                empresa_por_item: caps.empresa_por_item,
                empresa_contexto_id: api._contexto && api._contexto.empresa_selecionada
                    && api._contexto.empresa_selecionada.id,
                empresas_disponiveis: disp.empresas_disponiveis
            });
            if (idf.exige_escolha && !empresaEscolhida) {
                api._pendenteProduto = produto;
                api._pendenteQuantidade = qtd;
                const lista = $('#pdvu-lista-empresa-item');
                if (lista) {
                    lista.innerHTML = '';
                    idf.candidatos.forEach(function (e) {
                        const b = doc.createElement('button');
                        b.type = 'button';
                        b.className = 'pdvu-empresa-opcao';
                        b.setAttribute('data-empresa-item', String(e.empresa_id));
                        b.textContent = `${e.nome} — disp. ${e.disponibilidade.total}`;
                        lista.appendChild(b);
                    });
                }
                const modal = $('#pdvu-modal-empresa-item');
                if (modal) modal.hidden = false;
                return false;
            }
            const escolhida = empresaEscolhida
                ? (disp.empresas_disponiveis || []).find((e) => Number(e.empresa_id) === Number(empresaEscolhida))
                : null;
            const resolvida = escolhida
                ? {
                    empresa_id: Number(escolhida.empresa_id),
                    nome: escolhida.nome,
                    origem_identificacao_empresa: 'ESCOLHA_OPERADOR',
                    disponibilidade: escolhida.disponibilidade
                }
                : idf;
            api._cart.adicionarItem({
                produto_id: produto.id || produto.produto_id,
                descricao: produto.nome || produto.descricao,
                quantidade: qtd,
                valor_unitario: produto.preco_venda != null ? produto.preco_venda : produto.preco,
                empresa_id: resolvida.empresa_id,
                empresa_nome: resolvida.nome,
                disponibilidade: resolvida.disponibilidade,
                origem_identificacao_empresa: resolvida.origem_identificacao_empresa,
                unidade: produto.unidade || null,
                produto_fracionado: produto.produto_fracionado,
                produto_pesavel: produto.produto_pesavel,
                vendido_por_peso: produto.vendido_por_peso,
                venda_atacado: produto.venda_atacado,
                preco_base: produto.preco_venda != null ? produto.preco_venda : produto.preco,
                origem_quantidade: produto.quantidadeOrigem || produto.origem_quantidade || null
            }, resolvida.disponibilidade && resolvida.disponibilidade.total);
            const pid = produto.id || produto.produto_id;
            const loc = api._cart.localizar(pid, resolvida.empresa_id);
            if (loc) {
                loc.venda_atacado = Number(produto.venda_atacado || 0);
                if (loc.preco_base == null || loc.preco_base === undefined) {
                    loc.preco_base = Number(produto.preco_venda != null ? produto.preco_venda : produto.preco);
                }
            }
            await recalcularPrecoComercialItem(pid, resolvida.empresa_id);
            pintarCarrinho();
            aviso('');
            return true;
        }

        /** Autocomplete textual — preserva consulta-pdv sem chamar identificar a cada tecla. */
        async function executarBuscaTextual() {
            const buscaEl = $('#pdvu-busca-input');
            const lista = $('#pdvu-resultados');
            if (!lista || !buscaEl) return;
            const termo = String(buscaEl.value || '').trim();
            if (!termo) {
                lista.innerHTML = '';
                api._resultadosBusca = [];
                api._indiceResultado = -1;
                return;
            }
            const itens = await api.buscarProdutos(termo);
            pintarResultadosBusca(itens, itens.length ? 0 : -1);
        }

        /**
         * ENTER / BUSCAR — pipeline oficial: identificar → consulta → carrinho Universal.
         */
        async function executarIdentificacaoOperacional() {
            const Ident = IdentLib();
            const buscaEl = $('#pdvu-busca-input');
            if (!buscaEl) return;
            const termo = String(buscaEl.value || '').trim();
            if (!termo) {
                aviso('Informe código, PLU ou nome.');
                focarBuscaSeApropriado();
                return;
            }

            if (api._resultadosBusca && api._resultadosBusca.length
                && api._indiceResultado >= 0
                && api._indiceResultado < api._resultadosBusca.length
                && api._confirmandoLista) {
                const sel = api._resultadosBusca[api._indiceResultado];
                api._confirmandoLista = false;
                try {
                    const ok = await tentarAdicionar(sel, null, 1);
                    if (ok) limparBuscaEFocar();
                } catch (err) {
                    aviso(err.message || 'Não foi possível adicionar.');
                    focarBuscaSeApropriado();
                }
                return;
            }

            if (!Ident || typeof Ident.identificarEntradaPdv !== 'function') {
                await executarBuscaTextual();
                return;
            }

            aviso('');
            let resolucao;
            try {
                resolucao = await Ident.identificarEntradaPdv(termo, { origem: 'pdv-universal' }, {});
            } catch (err) {
                aviso(err.message || 'Falha na identificação.');
                focarBuscaSeApropriado();
                return;
            }

            if (resolucao.tipo === Ident.TIPOS.VAZIO) {
                focarBuscaSeApropriado();
                return;
            }
            if (resolucao.tipo === Ident.TIPOS.NAO_ENCONTRADO || resolucao.tipo === Ident.TIPOS.ERRO) {
                pintarResultadosBusca([]);
                aviso(resolucao.mensagem || 'Produto não encontrado.');
                focarBuscaSeApropriado();
                return;
            }
            if (resolucao.tipo === Ident.TIPOS.MULTIPLOS) {
                pintarResultadosBusca(resolucao.produtos, 0);
                aviso(resolucao.mensagem || 'Vários produtos. Use ↑↓ e ENTER para confirmar.');
                api._confirmandoLista = true;
                focarBuscaSeApropriado();
                return;
            }
            if (resolucao.tipo === Ident.TIPOS.UNICO && resolucao.produtos[0]) {
                try {
                    const ok = await tentarAdicionar(
                        resolucao.produtos[0],
                        null,
                        resolucao.quantidade || 1
                    );
                    if (ok) limparBuscaEFocar();
                    else focarBuscaSeApropriado();
                } catch (err) {
                    aviso(err.message || 'Não foi possível adicionar.');
                    focarBuscaSeApropriado();
                }
            }
        }

        const busca = $('#pdvu-busca-input');
        if (busca) {
            busca.disabled = false;
            let t = null;
            busca.addEventListener('input', function () {
                api._confirmandoLista = false;
                clearTimeout(t);
                t = setTimeout(function () {
                    executarBuscaTextual();
                }, 220);
            });
            busca.addEventListener('keydown', function (ev) {
                if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                    const n = (api._resultadosBusca || []).length;
                    if (!n) return;
                    ev.preventDefault();
                    let idx = api._indiceResultado == null ? 0 : api._indiceResultado;
                    if (ev.key === 'ArrowDown') idx = Math.min(n - 1, idx + 1);
                    else idx = Math.max(0, idx - 1);
                    api._confirmandoLista = true;
                    pintarResultadosBusca(api._resultadosBusca, idx);
                    return;
                }
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    clearTimeout(t);
                    executarIdentificacaoOperacional();
                }
            });
        }
        const btnBuscar = $('#pdvu-btn-buscar');
        if (btnBuscar) {
            btnBuscar.addEventListener('click', function () {
                executarIdentificacaoOperacional();
            });
        }

        const listaItemEmp = $('#pdvu-lista-empresa-item');
        if (listaItemEmp) {
            listaItemEmp.addEventListener('click', function (ev) {
                const btn = ev.target.closest('[data-empresa-item]');
                if (!btn || !api._pendenteProduto) return;
                const modal = $('#pdvu-modal-empresa-item');
                if (modal) modal.hidden = true;
                const qtd = api._pendenteQuantidade || 1;
                tentarAdicionar(api._pendenteProduto, btn.getAttribute('data-empresa-item'), qtd)
                    .then(function (ok) {
                        if (ok) limparBuscaEFocar();
                        else focarBuscaSeApropriado();
                    })
                    .catch(function (err) { aviso(err.message); });
                api._pendenteProduto = null;
                api._pendenteQuantidade = 1;
            });
        }

        const finBtn = $('#pdvu-finalizar');
        if (finBtn) {
            finBtn.addEventListener('click', async function () {
                const Checkout = globalThis.PdvUniversalCheckout;
                const ctx = api._contexto;
                const itens = api._cart ? api._cart.obterItens() : [];
                if (modalidadeAtual() === 'ENTREGA') {
                    const Entrega = EntregaLib();
                    const gate = Entrega && Entrega.entregaDisponivelNoModo
                        ? Entrega.entregaDisponivelNoModo(ctx)
                        : { ok: false, mensagem: 'Adaptador de entrega indisponível.' };
                    if (!gate.ok) {
                        aviso(gate.mensagem || gate.code || 'Entrega indisponível.');
                        return;
                    }
                    if (!itens.length) {
                        aviso('Adicione itens ao carrinho antes de configurar a entrega.');
                        return;
                    }
                    await abrirModalEntrega();
                    return;
                }
                if (!Checkout || !Checkout.podeFinalizar(ctx, itens)) {
                    aviso((Checkout && Checkout.mensagemBloqueio(ctx)) || 'Checkout indisponível.');
                    return;
                }
                const Pix = PixLib();
                const forma = ($('#pdvu-forma') && $('#pdvu-forma').value) || 'dinheiro';
                const resumo = montarResumoVisual(api._cart, api._ajuste);
                const totais = resumo.totais;
                const total = totais.total;

                if (String(forma).toLowerCase() === 'pix') {
                    const gate = Pix && Pix.pixDisponivelNoModo
                        ? Pix.pixDisponivelNoModo(ctx)
                        : { ok: false, mensagem: 'Adaptador PIX indisponível.' };
                    if (!gate.ok) {
                        aviso(gate.mensagem || gate.code || 'PIX indisponível.');
                        return;
                    }
                    if (api._pixPollTimer) {
                        aviso('Cobrança PIX já em andamento.');
                        return;
                    }
                    await executarCheckoutPixEmpresaUnica({
                        Checkout, Pix, itens, totais, total, finBtn, S, root: $('#pdvu-root')
                    });
                    return;
                }

                const Tef = TefLib();
                if (Tef && Tef.mapearTipoTef(forma)) {
                    if (api._tefEmAndamento || api._tefCancelamentoEmAndamento || api._checkoutLock) {
                        aviso('Transação TEF já em andamento.');
                        return;
                    }
                    const gateTef = Tef.validarTefOperacional
                        ? await Tef.validarTefOperacional(ctx, forma)
                        : Tef.tefDisponivelNoModo(ctx);
                    if (!gateTef.ok) {
                        aviso(gateTef.mensagem || gateTef.code || 'TEF indisponível.');
                        return;
                    }
                    await executarCheckoutTefEmpresaUnica({
                        Checkout, Tef, itens, totais, forma, finBtn, S, root: $('#pdvu-root')
                    });
                    return;
                }

                if (S && !S.adquirir(api._session, S.ACOES.CHECKOUT)) return;
                api._checkoutLock = true;
                finBtn.disabled = true;
                const root = $('#pdvu-root');
                if (root) root.setAttribute('data-estado', ESTADOS.CHECKOUT_PROCESSANDO);
                aviso('Processando checkout…');
                try {
                    const r = await Checkout.finalizarCheckout({
                        itens,
                        pagamentos: [{ forma_pagamento: forma, valor: total }],
                        desconto: totais.desconto_valor,
                        acrescimo: totais.acrescimo,
                        idempotency_key: `pdvu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                    });
                    const trans = Checkout.aplicarResultadoCheckout(r);
                    if (trans.total == null) trans.total = total;
                    api._sessaoAtendimento = trans;
                    if (trans.estado === ESTADOS.ATENDIMENTO_CRIADO) {
                        if (S) {
                            S.marcarSeguro(api._session, S.ESTADOS.ATENDIMENTO_VALIDADO, {
                                atendimento_id: trans.atendimento_id,
                                codigo: trans.codigo,
                                status: trans.status
                            });
                        }
                        mostrarAtendimentoCriado(trans);
                        aviso('ATENDIMENTO CRIADO — AGUARDANDO PAGAMENTO');
                        if (root) root.setAttribute('data-estado', ESTADOS.ATENDIMENTO_VALIDADO);
                        pintarCarrinho();
                    } else {
                        api._cart.limpar();
                        api._ajuste = {
                            modo_desconto: 'valor',
                            desconto_valor: '',
                            desconto_percentual: '',
                            acrescimo: ''
                        };
                        if (S) api._session = S.resetarSessaoPDVUniversal(api._session);
                        pintarCarrinho();
                        aviso(`Venda ${r.venda_id} concluída.`);
                        if (root) root.setAttribute('data-estado', ESTADOS.INICIAL);
                    }
                } catch (err) {
                    aviso(err.message || 'Erro no checkout.');
                    if (S) S.recuperarErro(api._session, S.ACOES.CHECKOUT);
                    if (root) root.setAttribute('data-estado', ESTADOS.ERRO_RECUPERAVEL);
                    pintarCarrinho();
                } finally {
                    if (S) S.liberar(api._session);
                    api._checkoutLock = false;
                    atualizarBotaoFinalizar();
                }
            });
        }

        function pintarModalPix(cob, estadoUi, msg) {
            const modal = $('#pdvu-modal-pix');
            if (modal) modal.hidden = false;
            const valorEl = $('#pdvu-pix-valor');
            if (valorEl) valorEl.textContent = moneyVisual(cob && cob.valor);
            const est = $('#pdvu-pix-estado');
            if (est) est.textContent = estadoUi || 'AGUARDANDO PIX';
            const msgEl = $('#pdvu-pix-msg');
            if (msgEl) msgEl.textContent = msg || '';
            const copia = $('#pdvu-pix-copia');
            if (copia) copia.value = (cob && cob.copia_cola) || '';
            const qrWrap = $('#pdvu-pix-qr-wrap');
            const qr = $('#pdvu-pix-qr');
            if (cob && cob.qr_code_base64 && qr && qrWrap) {
                qr.src = cob.qr_code_base64.indexOf('data:') === 0
                    ? cob.qr_code_base64
                    : ('data:image/png;base64,' + cob.qr_code_base64);
                qrWrap.hidden = false;
            } else if (qrWrap) {
                qrWrap.hidden = true;
            }
        }

        function fecharModalPix() {
            if (api._pixPollTimer) {
                clearTimeout(api._pixPollTimer);
                api._pixPollTimer = null;
            }
            api._pixEmAndamento = false;
            const modal = $('#pdvu-modal-pix');
            if (modal) modal.hidden = true;
        }

        const btnPixFechar = $('#pdvu-pix-fechar');
        if (btnPixFechar) {
            btnPixFechar.addEventListener('click', function () {
                fecharModalPix();
                atualizarBotaoFinalizar();
                focarBuscaSeApropriado();
            });
        }
        const btnPixCopiar = $('#pdvu-pix-copiar');
        if (btnPixCopiar) {
            btnPixCopiar.addEventListener('click', function () {
                const copia = $('#pdvu-pix-copia');
                if (!copia || !copia.value) return;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(copia.value).then(function () {
                        aviso('Código PIX copiado.');
                    }).catch(function () { /* ignore */ });
                } else {
                    copia.select();
                }
            });
        }

        async function executarCheckoutPixEmpresaUnica(opts) {
            const Pix = opts.Pix;
            const Checkout = opts.Checkout;
            const itens = opts.itens;
            const totais = opts.totais;
            const total = Pix.valorLiquidoPix(totais);
            const finBtn = opts.finBtn;
            const root = opts.root;
            if (!(total > 0)) {
                aviso('Total inválido para PIX.');
                return;
            }
            if (api._pixEmAndamento) {
                aviso('Cobrança PIX já em andamento.');
                if (api._pixSessao) {
                    pintarModalPix(api._pixSessao, Pix.normalizarEstadoUi(api._pixSessao.status), '');
                }
                return;
            }
            api._pixEmAndamento = true;
            finBtn.disabled = true;
            if (root) root.setAttribute('data-estado', 'AGUARDANDO_PIX');

            let cob = null;
            try {
                if (Pix.deveReutilizarCobranca(api._pixSessao, total)) {
                    cob = api._pixSessao;
                } else {
                    pintarModalPix({ valor: total }, Pix.ESTADOS_UI.AGUARDANDO, 'Gerando cobrança PIX…');
                    cob = await Pix.criarCobrancaPix({
                        valor: total,
                        descricao: 'Venda PDV Universal'
                    });
                    api._pixSessao = cob;
                }
                pintarModalPix(cob, Pix.normalizarEstadoUi(cob.status), '');

                const confirmado = await aguardarConfirmacaoPixOficial(Pix, cob);
                if (!confirmado) {
                    pintarModalPix(cob, Pix.ESTADOS_UI.ERRO, 'PIX não confirmado. Venda não concluída.');
                    api._pixEmAndamento = false;
                    atualizarBotaoFinalizar();
                    return;
                }
                pintarModalPix(cob, Pix.ESTADOS_UI.CONFIRMADO, 'Pagamento confirmado. Finalizando venda…');

                if (S && !S.adquirir(api._session, S.ACOES.CHECKOUT)) {
                    api._pixEmAndamento = false;
                    atualizarBotaoFinalizar();
                    return;
                }
                api._checkoutLock = true;
                try {
                    const r = await Checkout.finalizarCheckout({
                        itens,
                        pagamentos: [{ forma_pagamento: 'pix', valor: total }],
                        desconto: totais.desconto_valor,
                        acrescimo: totais.acrescimo,
                        idempotency_key: `pdvu-pix-${cob.txid || Date.now()}`
                    });
                    const trans = Checkout.aplicarResultadoCheckout(r);
                    api._sessaoAtendimento = trans;
                    api._pixSessao = null;
                    fecharModalPix();
                    api._cart.limpar();
                    api._ajuste = {
                        modo_desconto: 'valor',
                        desconto_valor: '',
                        desconto_percentual: '',
                        acrescimo: ''
                    };
                    if (S) api._session = S.resetarSessaoPDVUniversal(api._session);
                    pintarCarrinho();
                    aviso(`Venda ${r.venda_id} concluída (PIX).`);
                    if (root) root.setAttribute('data-estado', ESTADOS.INICIAL);
                } catch (err) {
                    pintarModalPix(cob, Pix.ESTADOS_UI.ERRO, err.message || 'Checkout falhou após PIX.');
                    aviso(err.message || 'PIX confirmado, mas checkout falhou.');
                    if (S) S.recuperarErro(api._session, S.ACOES.CHECKOUT);
                } finally {
                    if (S) S.liberar(api._session);
                    api._checkoutLock = false;
                    api._pixEmAndamento = false;
                    atualizarBotaoFinalizar();
                }
            } catch (err) {
                pintarModalPix({ valor: total }, Pix.ESTADOS_UI.ERRO, err.message || 'Erro PIX.');
                aviso(err.message || 'Erro ao iniciar PIX.');
                api._pixEmAndamento = false;
                atualizarBotaoFinalizar();
            }
        }

        function aguardarConfirmacaoPixOficial(Pix, cob) {
            return new Promise(function (resolve) {
                let tentativas = 0;
                const maxTentativas = 60;
                function tick() {
                    tentativas += 1;
                    Pix.consultarStatusPix(cob.txid).then(function (st) {
                        cob.status = st.status;
                        const ui = Pix.normalizarEstadoUi(st.status);
                        pintarModalPix(cob, ui, '');
                        if (ui === Pix.ESTADOS_UI.CONFIRMADO) {
                            api._pixPollTimer = null;
                            resolve(true);
                            return;
                        }
                        if (ui === Pix.ESTADOS_UI.ERRO || tentativas >= maxTentativas) {
                            api._pixPollTimer = null;
                            resolve(false);
                            return;
                        }
                        api._pixPollTimer = setTimeout(tick, 2000);
                    }).catch(function () {
                        if (tentativas >= maxTentativas) {
                            api._pixPollTimer = null;
                            resolve(false);
                            return;
                        }
                        api._pixPollTimer = setTimeout(tick, 2000);
                    });
                }
                tick();
            });
        }

        function fecharModalTefVisual() {
            const modal = $('#pdvu-modal-tef');
            if (modal) modal.hidden = true;
        }

        function limparEstadoTefOperacional() {
            api._tefPendente = null;
            api._tefEmAndamento = false;
            api._tefCancelamentoSolicitado = false;
            fecharModalTefVisual();
            atualizarBotaoFinalizar();
        }

        async function abortarOperacaoTef() {
            const Tef = globalThis.PdvUniversalTef;
            if (!Tef) {
                limparEstadoTefOperacional();
                focarBuscaSeApropriado();
                return;
            }
            if (api._tefCancelamentoEmAndamento) return;

            if (api._checkoutLock && api._tefPendente && api._tefPendente.aprovado) {
                aviso('Checkout em andamento. Aguarde conclusão.');
                return;
            }

            const pendente = api._tefPendente;
            const transacaoId = Tef.extrairTransacaoId(pendente);

            if (!api._tefEmAndamento && !transacaoId) {
                limparEstadoTefOperacional();
                focarBuscaSeApropriado();
                return;
            }

            if (api._tefEmAndamento && !transacaoId) {
                api._tefCancelamentoSolicitado = true;
                pintarModalTef({
                    valor: pendente && pendente.valor,
                    tipo: pendente && pendente.tipo,
                    estadoUi: Tef.ESTADOS_UI.PROCESSANDO,
                    mensagem: 'Cancelamento solicitado…'
                });
                return;
            }

            if (pendente && pendente.aprovado) {
                aviso('Pagamento TEF já aprovado.');
                return;
            }

            if (transacaoId && Tef.transacaoTefCancelavel(pendente)) {
                api._tefCancelamentoEmAndamento = true;
                pintarModalTef({
                    valor: pendente.valor,
                    tipo: pendente.tipo,
                    estadoUi: Tef.ESTADOS_UI.PROCESSANDO,
                    mensagem: 'Cancelando TEF…'
                });
                try {
                    const ret = await Tef.cancelarTransacaoTef({
                        transacao_id: transacaoId,
                        motivo: 'Cancelamento operador'
                    });
                    pintarModalTef({
                        valor: pendente.valor,
                        tipo: pendente.tipo,
                        estadoUi: Tef.ESTADOS_UI.CANCELADO,
                        mensagem: (ret && ret.mensagem) || 'TEF cancelado.'
                    });
                    limparEstadoTefOperacional();
                    aviso('TEF cancelado. Carrinho mantido.');
                    focarBuscaSeApropriado();
                } catch (err) {
                    pintarModalTef({
                        valor: pendente.valor,
                        tipo: pendente.tipo,
                        estadoUi: Tef.ESTADOS_UI.ERRO,
                        mensagem: err.message || 'Erro ao cancelar TEF.'
                    });
                    aviso(err.message || 'Erro ao cancelar TEF.');
                    api._tefEmAndamento = false;
                    atualizarBotaoFinalizar();
                } finally {
                    api._tefCancelamentoEmAndamento = false;
                }
                return;
            }

            limparEstadoTefOperacional();
            focarBuscaSeApropriado();
        }

        function pintarModalTef(opts) {
            const o = opts || {};
            const modal = $('#pdvu-modal-tef');
            if (modal) modal.hidden = false;
            const valorEl = $('#pdvu-tef-valor');
            if (valorEl) valorEl.textContent = moneyVisual(o.valor);
            const tipoEl = $('#pdvu-tef-tipo');
            if (tipoEl) tipoEl.textContent = String(o.tipo || '—').toUpperCase();
            const est = $('#pdvu-tef-estado');
            if (est) est.textContent = o.estadoUi || 'TEF PROCESSANDO';
            const msgEl = $('#pdvu-tef-msg');
            if (msgEl) msgEl.textContent = o.mensagem || '';
        }

        function fecharModalTef() {
            limparEstadoTefOperacional();
        }

        const btnTefFechar = $('#pdvu-tef-fechar');
        if (btnTefFechar) {
            btnTefFechar.addEventListener('click', function () {
                void abortarOperacaoTef();
            });
        }

        async function executarCheckoutTefEmpresaUnica(opts) {
            const Tef = opts.Tef;
            const Checkout = opts.Checkout;
            const itens = opts.itens;
            const totais = opts.totais;
            const forma = opts.forma;
            const finBtn = opts.finBtn;
            const root = opts.root;
            const valor = Tef.valorLiquidoTef(totais);
            const tipo = Tef.mapearTipoTef(forma);
            if (!(valor > 0) || !tipo) {
                aviso('Valor ou tipo TEF inválido.');
                return;
            }
            if (api._tefEmAndamento || api._tefCancelamentoEmAndamento) {
                aviso('Transação TEF já em andamento.');
                return;
            }
            api._tefPendente = { valor, tipo, transacao_id: null, aprovado: false, checkoutIniciado: false };
            api._tefCancelamentoSolicitado = false;
            api._tefEmAndamento = true;
            finBtn.disabled = true;
            if (root) root.setAttribute('data-estado', 'TEF_PROCESSANDO');
            pintarModalTef({
                valor,
                tipo,
                estadoUi: Tef.ESTADOS_UI.PROCESSANDO,
                mensagem: 'Aguardando terminal…'
            });

            let retorno = null;
            try {
                retorno = await Tef.iniciarTransacaoTef({
                    tipo,
                    valor,
                    parcelas: 1,
                    idempotency_key: `pdvu-tef-${Date.now()}`
                });
            } catch (err) {
                const tid = Tef.extrairTransacaoId(err.body || err);
                if (tid) {
                    api._tefPendente = {
                        valor,
                        tipo,
                        transacao_id: tid,
                        aprovado: false,
                        checkoutIniciado: false,
                        retorno: err.body
                    };
                }
                if (api._tefCancelamentoSolicitado && api._tefPendente && Tef.transacaoTefCancelavel(api._tefPendente)) {
                    await abortarOperacaoTef();
                    return;
                }
                pintarModalTef({
                    valor,
                    tipo,
                    estadoUi: Tef.ESTADOS_UI.ERRO,
                    mensagem: err.message || 'Erro TEF.'
                });
                aviso(err.message || 'Erro TEF. Venda não concluída.');
                api._tefEmAndamento = false;
                atualizarBotaoFinalizar();
                return;
            }

            api._tefPendente = {
                valor,
                tipo,
                transacao_id: Tef.extrairTransacaoId(retorno),
                aprovado: Tef.estaAprovado(retorno),
                checkoutIniciado: false,
                retorno
            };

            if (api._tefCancelamentoSolicitado && Tef.transacaoTefCancelavel(api._tefPendente)) {
                await abortarOperacaoTef();
                return;
            }

            const ui = Tef.estadoUiDeRetorno(retorno);
            if (!Tef.estaAprovado(retorno)) {
                pintarModalTef({
                    valor,
                    tipo,
                    estadoUi: ui,
                    mensagem: (retorno && (retorno.mensagem || retorno.error)) || 'TEF não aprovado. Venda não concluída.'
                });
                aviso('TEF não aprovado. Carrinho mantido.');
                api._tefEmAndamento = false;
                atualizarBotaoFinalizar();
                return;
            }

            pintarModalTef({
                valor,
                tipo,
                estadoUi: Tef.ESTADOS_UI.APROVADO,
                mensagem: 'Aprovado. Finalizando venda…'
            });

            if (api._tefPendente) {
                api._tefPendente.aprovado = true;
            }

            if (S && !S.adquirir(api._session, S.ACOES.CHECKOUT)) {
                api._tefEmAndamento = false;
                atualizarBotaoFinalizar();
                return;
            }
            api._checkoutLock = true;
            if (api._tefPendente) api._tefPendente.checkoutIniciado = true;
            try {
                const extras = Tef.dadosOficiaisParaCheckout(retorno);
                const pagamento = Object.assign({
                    forma_pagamento: Tef.formaCheckoutAposTef(tipo),
                    valor
                }, extras);
                const r = await Checkout.finalizarCheckout({
                    itens,
                    pagamentos: [pagamento],
                    desconto: totais.desconto_valor,
                    acrescimo: totais.acrescimo,
                    idempotency_key: `pdvu-tef-chk-${retorno.transacaoId || retorno.transacao_id || Date.now()}`
                });
                fecharModalTef();
                api._tefPendente = null;
                api._cart.limpar();
                api._ajuste = {
                    modo_desconto: 'valor',
                    desconto_valor: '',
                    desconto_percentual: '',
                    acrescimo: ''
                };
                if (S) api._session = S.resetarSessaoPDVUniversal(api._session);
                pintarCarrinho();
                aviso(`Venda ${r.venda_id} concluída (TEF).`);
                if (root) root.setAttribute('data-estado', ESTADOS.INICIAL);
            } catch (err) {
                pintarModalTef({
                    valor,
                    tipo,
                    estadoUi: Tef.ESTADOS_UI.ERRO,
                    mensagem: err.message || 'Checkout falhou após TEF.'
                });
                aviso(err.message || 'TEF aprovado, mas checkout falhou. Carrinho mantido.');
                if (S) S.recuperarErro(api._session, S.ACOES.CHECKOUT);
            } finally {
                if (S) S.liberar(api._session);
                api._checkoutLock = false;
                api._tefEmAndamento = false;
                if (!api._tefPendente || api._tefPendente.checkoutIniciado) {
                    api._tefPendente = null;
                }
                atualizarBotaoFinalizar();
            }
        }

        function money(n) {
            return `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
        }

        function abrirModalPagamento() {
            const modal = $('#pdvu-modal-pagamento');
            if (modal) modal.hidden = false;
            const s = api._sessaoAtendimento || {};
            const cod = $('#pdvu-pgto-codigo');
            if (cod) cod.textContent = 'ATENDIMENTO ' + (s.codigo || s.atendimento_id || '—');
            const tot = $('#pdvu-pgto-total');
            if (tot) tot.textContent = money(s.total);
            if (!api._pagamentosIntencao || !api._pagamentosIntencao.length) {
                api._pagamentosIntencao = [{
                    forma_pagamento: 'DINHEIRO',
                    valor: Number(s.total || 0)
                }];
            }
            pintarIntencoes();
        }

        function pintarIntencoes() {
            const box = $('#pdvu-pgto-linhas');
            const linhas = api._pagamentosIntencao || [];
            const soma = linhas.reduce((a, p) => a + Number(p.valor || 0), 0);
            const total = Number((api._sessaoAtendimento && api._sessaoAtendimento.total) || 0);
            if (box) {
                box.innerHTML = '';
                linhas.forEach(function (p, idx) {
                    const d = doc.createElement('div');
                    d.textContent = `${p.forma_pagamento} ${money(p.valor)}`;
                    const rm = doc.createElement('button');
                    rm.type = 'button';
                    rm.textContent = 'x';
                    rm.addEventListener('click', function () {
                        api._pagamentosIntencao.splice(idx, 1);
                        pintarIntencoes();
                    });
                    d.appendChild(rm);
                    box.appendChild(d);
                });
            }
            const inf = $('#pdvu-pgto-informado');
            if (inf) inf.textContent = money(soma);
            const dif = $('#pdvu-pgto-diff');
            if (dif) dif.textContent = money(total - soma);
        }

        function statusPgto(msg) {
            const el = $('#pdvu-pgto-status');
            if (el) el.textContent = msg || '';
            aviso(msg || '');
        }

        async function reservarEAbrirPagamento() {
            const Pag = globalThis.PdvUniversalPagamento;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Pag || !caps.pode_reservar_atendimento || !s || !s.atendimento_id) {
                statusPgto('Reserva indisponível.');
                return;
            }
            if (S && !S.adquirir(api._session, S.ACOES.RESERVAR)) return;
            api._pagamentoLock = true;
            const root = $('#pdvu-root');
            if (root) root.setAttribute('data-estado', ESTADOS.RESERVA_PROCESSANDO);
            statusPgto('RESERVANDO ESTOQUE…');
            try {
                const r = await Pag.reservarAtendimento(s.atendimento_id);
                s.status = r.atendimento && r.atendimento.status;
                if (S) S.marcarSeguro(api._session, S.ESTADOS.ATENDIMENTO_RESERVADO, { status: s.status });
                if (root) root.setAttribute('data-estado', ESTADOS.ATENDIMENTO_RESERVADO);
                statusPgto('ESTOQUE RESERVADO');
                abrirModalPagamento();
            } catch (err) {
                if (S) S.recuperarErro(api._session, S.ACOES.RESERVAR);
                if (root) root.setAttribute('data-estado', ESTADOS.ATENDIMENTO_VALIDADO);
                statusPgto(err.message || 'Atendimento não pôde ser reservado.');
            } finally {
                if (S) S.liberar(api._session);
                api._pagamentoLock = false;
            }
        }

        async function confirmarPagamentoUnificado() {
            const Pag = globalThis.PdvUniversalPagamento;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Pag || !caps.pode_confirmar_pagamento_unificado || !s) return;
            if (S && !S.adquirir(api._session, S.ACOES.PAGAR)) return;
            api._pagamentoLock = true;
            const conf = $('#pdvu-pgto-confirmar');
            if (conf) conf.disabled = true;
            const root = $('#pdvu-root');
            if (root) root.setAttribute('data-estado', ESTADOS.PAGAMENTO_PROCESSANDO);
            statusPgto('PROCESSANDO PAGAMENTO…');
            try {
                const r = await Pag.confirmarPagamento(s.atendimento_id, {
                    pagamentos: api._pagamentosIntencao,
                    estrategia_rateio: Pag.ESTRATEGIA_PADRAO,
                    idempotency_key: api._pagamentoIdem || (api._pagamentoIdem = `pdvu-pag-${Date.now()}`)
                });
                s.status = r.atendimento && r.atendimento.status;
                if (S) S.marcarSeguro(api._session, S.ESTADOS.ATENDIMENTO_PAGO, { status: s.status });
                if (root) root.setAttribute('data-estado', ESTADOS.ATENDIMENTO_PAGO);
                statusPgto('PAGAMENTO CONFIRMADO');
                const prox = $('#pdvu-pgto-proximo');
                if (prox) prox.hidden = false;
                const matBtn = $('#pdvu-materializar');
                if (matBtn) matBtn.hidden = false;
                const pos = $('#pdvu-acoes-pos');
                if (pos) pos.hidden = false;
                const matMain = $('#pdvu-materializar-main');
                if (matMain) matMain.hidden = false;
                const retry = $('#pdvu-pgto-retry');
                if (retry) retry.hidden = true;
            } catch (err) {
                if (S) S.recuperarErro(api._session, S.ACOES.PAGAR);
                if (root) root.setAttribute('data-estado', ESTADOS.ATENDIMENTO_RESERVADO);
                statusPgto(err.message || 'Falha no pagamento. Atendimento permanece reservado.');
                const retry = $('#pdvu-pgto-retry');
                if (retry) retry.hidden = false;
            } finally {
                if (S) S.liberar(api._session);
                api._pagamentoLock = false;
                if (conf) conf.disabled = false;
            }
        }

        async function cancelarAtendimentoReservado() {
            const Pag = globalThis.PdvUniversalPagamento;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Pag || !caps.pode_cancelar_atendimento_reservado || !s) return;
            if (S && S.emProcessamento(api._session)) return;
            if (typeof globalThis.confirm === 'function' && !globalThis.confirm('Cancelar atendimento?')) return;
            try {
                await Pag.cancelarAtendimento(s.atendimento_id);
                const modal = $('#pdvu-modal-pagamento');
                if (modal) modal.hidden = true;
                resetarSessaoPDVUniversal();
                statusPgto('Atendimento cancelado. Reservas liberadas.');
            } catch (err) {
                statusPgto(err.message || 'Não foi possível cancelar.');
            }
        }

        const btnPag = $('#pdvu-continuar-pagamento');
        if (btnPag) {
            btnPag.addEventListener('click', function () {
                const Checkout = globalThis.PdvUniversalCheckout;
                const start = Checkout && Checkout.continuarParaPagamento
                    ? Checkout.continuarParaPagamento(api._sessaoAtendimento)
                    : { acao: 'INICIAR_RESERVA' };
                if (start.acao === 'INICIAR_RESERVA') {
                    reservarEAbrirPagamento();
                }
            });
        }
        const addPg = $('#pdvu-pgto-adicionar');
        if (addPg) {
            addPg.addEventListener('click', function () {
                const forma = ($('#pdvu-pgto-forma') && $('#pdvu-pgto-forma').value) || 'DINHEIRO';
                const valor = Number($('#pdvu-pgto-valor') && $('#pdvu-pgto-valor').value);
                if (!(valor > 0)) return;
                api._pagamentosIntencao = api._pagamentosIntencao || [];
                api._pagamentosIntencao.push({ forma_pagamento: forma, valor });
                pintarIntencoes();
            });
        }
        const confPg = $('#pdvu-pgto-confirmar');
        if (confPg) confPg.addEventListener('click', confirmarPagamentoUnificado);
        const retryPg = $('#pdvu-pgto-retry');
        if (retryPg) retryPg.addEventListener('click', confirmarPagamentoUnificado);
        const fechaPg = $('#pdvu-pgto-fechar');
        if (fechaPg) {
            fechaPg.addEventListener('click', function () {
                const modal = $('#pdvu-modal-pagamento');
                if (modal) modal.hidden = true;
                if (S) S.fecharModalPreservaDominio(api._session);
            });
        }
        const cancPg = $('#pdvu-pgto-cancelar');
        if (cancPg) cancPg.addEventListener('click', cancelarAtendimentoReservado);

        async function materializarAtendimentoPago() {
            const Pos = globalThis.PdvUniversalPosPagamento;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Pos || !caps.pode_materializar_atendimento || !s || !s.atendimento_id) return;
            if (S && !S.adquirir(api._session, S.ACOES.MATERIALIZAR)) return;
            api._posLock = true;
            const root = $('#pdvu-root');
            if (root) root.setAttribute('data-estado', ESTADOS.MATERIALIZACAO_PROCESSANDO);
            statusPgto('PROCESSANDO MATERIALIZAÇÃO…');
            try {
                const r = await Pos.materializar(s.atendimento_id, api._matIdem || (api._matIdem = `pdvu-mat-${Date.now()}`));
                s.status = r.atendimento && r.atendimento.status;
                s.atendimento_id = r.atendimento_id || s.atendimento_id;
                if (S) S.marcarSeguro(api._session, S.ESTADOS.ATENDIMENTO_PAGO, { status: s.status });
                if (root) root.setAttribute('data-estado', ESTADOS.MATERIALIZACAO_CONCLUIDA);
                statusPgto('MATERIALIZAÇÃO CONCLUÍDA');
                const fisc = $('#pdvu-fiscalizar');
                if (fisc) fisc.hidden = false;
                const fiscMain = $('#pdvu-fiscalizar-main');
                if (fiscMain) fiscMain.hidden = false;
                const ver = $('#pdvu-ver-comprovante');
                if (ver) ver.hidden = false;
                const verMain = $('#pdvu-ver-comprovante-main');
                if (verMain) verMain.hidden = false;
            } catch (err) {
                if (S) S.recuperarErro(api._session, S.ACOES.MATERIALIZAR);
                if (root) root.setAttribute('data-estado', ESTADOS.ATENDIMENTO_PAGO);
                statusPgto(err.message || 'Falha na materialização.');
            } finally {
                if (S) S.liberar(api._session);
                api._posLock = false;
            }
        }

        async function fiscalizarAtendimentoConcluido() {
            const Pos = globalThis.PdvUniversalPosPagamento;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Pos || !caps.pode_fiscalizar_atendimento || !s || !s.atendimento_id) return;
            if (S && !S.adquirir(api._session, S.ACOES.FISCALIZAR)) return;
            api._posLock = true;
            const root = $('#pdvu-root');
            if (root) root.setAttribute('data-estado', ESTADOS.FISCALIZACAO_PROCESSANDO);
            statusPgto('PROCESSANDO DOCUMENTOS FISCAIS…');
            try {
                const r = await Pos.fiscalizar(s.atendimento_id);
                s.status = r.atendimento && r.atendimento.status;
                s.atendimento_id = r.atendimento_id || s.atendimento_id;
                const st = (r.atendimento && r.atendimento.status) || 'FISCALIZADO';
                if (S) S.marcarSeguro(api._session, S.ESTADOS.COMPROVANTE_DISPONIVEL, { status: st });
                if (root) root.setAttribute('data-estado', ESTADOS[st] || ESTADOS.FISCALIZADO);
                statusPgto(st);
                const ver = $('#pdvu-ver-comprovante');
                if (ver) ver.hidden = false;
                const verMain = $('#pdvu-ver-comprovante-main');
                if (verMain) verMain.hidden = false;
                if (root) root.setAttribute('data-estado', ESTADOS.COMPROVANTE_DISPONIVEL);
            } catch (err) {
                if (S) S.recuperarErro(api._session, S.ACOES.FISCALIZAR);
                if (root) root.setAttribute('data-estado', ESTADOS.ERRO_RECUPERAVEL);
                statusPgto(err.message || 'Falha na fiscalização.');
                const ver = $('#pdvu-ver-comprovante');
                if (ver) ver.hidden = false;
            } finally {
                if (S) S.liberar(api._session);
                api._posLock = false;
            }
        }

        function setEstadoComprovante(estado, msg) {
            const dialog = $('#pdvu-modal-comprovante') && $('#pdvu-modal-comprovante').querySelector('.pdvu-dialog');
            if (dialog) dialog.setAttribute('data-estado', estado);
            const ban = $('#pdvu-comp-banner');
            if (ban) ban.textContent = msg || '';
        }

        function escreverPreview(html) {
            const frame = $('#pdvu-comprovante-frame');
            if (!frame) return;
            const docf = frame.contentDocument;
            if (docf) {
                docf.open();
                docf.write(html);
                docf.close();
            }
        }

        async function abrirComprovanteOficial() {
            const Comp = globalThis.PDVUniversalComprovanteModal;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Comp || !caps.pode_visualizar_comprovante || !s || !s.atendimento_id) return;
            const modal = $('#pdvu-modal-comprovante');
            if (modal) modal.hidden = false;
            setEstadoComprovante(Comp.ESTADOS.LOADING, 'Carregando comprovante oficial…');
            try {
                const r = await Comp.carregarPreview(s.atendimento_id);
                escreverPreview(r.html);
                const fiscal = s.status || '';
                const avisoFiscal = fiscal === 'FISCAL_PARCIAL' || fiscal === 'FISCAL_ERRO'
                    ? Comp.fiscalNaoBloqueia(fiscal) ? fiscal : ''
                    : '';
                setEstadoComprovante(Comp.ESTADOS.READY, avisoFiscal);
                const root = $('#pdvu-root');
                if (root) root.setAttribute('data-estado', ESTADOS.COMPROVANTE_DISPONIVEL);
            } catch (err) {
                setEstadoComprovante(
                    Comp.ESTADOS.ERROR,
                    err.code || err.message || 'COMPROVANTE_NAO_ENCONTRADO'
                );
                statusPgto(err.message || 'Comprovante indisponível.');
            }
        }

        async function prepararImpressaoOficial() {
            const Comp = globalThis.PDVUniversalComprovanteModal;
            const caps = aplicarCapabilities(api._contexto);
            const s = api._sessaoAtendimento;
            if (!Comp || !caps.pode_preparar_impressao || !s || !s.atendimento_id) return;
            try {
                await Comp.prepararImpressao(s.atendimento_id);
                setEstadoComprovante(Comp.ESTADOS.READY, 'Impressão preparada (BROWSER/HTML).');
            } catch (err) {
                setEstadoComprovante(Comp.ESTADOS.ERROR, err.code || 'ERRO_PREPARAR_IMPRESSAO');
                statusPgto(err.message || 'ERRO_PREPARAR_IMPRESSAO');
            }
        }

        function resetarSessaoPDVUniversal() {
            let persistida = null;
            try {
                persistida = typeof localStorage !== 'undefined'
                    ? localStorage.getItem('cds_empresa_id')
                    : null;
            } catch (_e) { persistida = null; }
            if (S) {
                api._session = S.resetarSessaoPDVUniversal(api._session, {
                    empresa_operacional_persistida: persistida
                });
            }
            api._sessaoAtendimento = null;
            api._pagamentosIntencao = [];
            api._pagamentoIdem = null;
            api._matIdem = null;
            api._checkoutLock = false;
            api._pagamentoLock = false;
            api._posLock = false;
            if (api._cart) api._cart.limpar();
            const pg = $('#pdvu-modal-pagamento');
            if (pg) pg.hidden = true;
            const modal = $('#pdvu-modal-comprovante');
            if (modal) modal.hidden = true;
            const criado = $('#pdvu-atendimento-criado');
            if (criado) criado.hidden = true;
            const pos = $('#pdvu-acoes-pos');
            if (pos) pos.hidden = true;
            const root = $('#pdvu-root');
            if (root) root.setAttribute('data-estado', ESTADOS.INICIAL);
            pintarCarrinho();
            aviso('');
        }

        function iniciarNovoAtendimentoVisual() {
            const Comp = globalThis.PDVUniversalComprovanteModal;
            const caps = aplicarCapabilities(api._contexto);
            if (S && S.emProcessamento(api._session)) return;
            if (Comp && !caps.pode_iniciar_novo_atendimento) return;
            resetarSessaoPDVUniversal();
        }

        const btnMat = $('#pdvu-materializar');
        if (btnMat) btnMat.addEventListener('click', materializarAtendimentoPago);
        const btnMatMain = $('#pdvu-materializar-main');
        if (btnMatMain) btnMatMain.addEventListener('click', materializarAtendimentoPago);
        const btnFisc = $('#pdvu-fiscalizar');
        if (btnFisc) btnFisc.addEventListener('click', fiscalizarAtendimentoConcluido);
        const btnFiscMain = $('#pdvu-fiscalizar-main');
        if (btnFiscMain) btnFiscMain.addEventListener('click', fiscalizarAtendimentoConcluido);
        const btnComp = $('#pdvu-ver-comprovante');
        if (btnComp) btnComp.addEventListener('click', abrirComprovanteOficial);
        const btnCompMain = $('#pdvu-ver-comprovante-main');
        if (btnCompMain) btnCompMain.addEventListener('click', abrirComprovanteOficial);
        const btnNovoMain = $('#pdvu-novo-main');
        if (btnNovoMain) btnNovoMain.addEventListener('click', iniciarNovoAtendimentoVisual);
        const btnFechaComp = $('#pdvu-fechar-comprovante');
        if (btnFechaComp) {
            btnFechaComp.addEventListener('click', function () {
                const modal = $('#pdvu-modal-comprovante');
                if (modal) modal.hidden = true;
                if (S) S.fecharModalPreservaDominio(api._session);
            });
        }
        const btnPreview = $('#pdvu-comp-preview');
        if (btnPreview) btnPreview.addEventListener('click', abrirComprovanteOficial);
        const btnImp = $('#pdvu-comp-imprimir');
        if (btnImp) btnImp.addEventListener('click', prepararImpressaoOficial);
        const btnNovo = $('#pdvu-comp-novo');
        if (btnNovo) btnNovo.addEventListener('click', iniciarNovoAtendimentoVisual);

        function modalOperacionalAberto() {
            const ids = ['pdvu-modal-pagamento', 'pdvu-modal-comprovante', 'pdvu-modal-empresa', 'pdvu-modal-empresa-item', 'pdvu-modal-pix', 'pdvu-modal-tef', 'pdvu-modal-pesagem', 'pdvu-modal-caixa', 'pdvu-modal-entrega'];
            return ids.some(function (id) {
                const el = doc.getElementById ? doc.getElementById(id) : $('#' + id);
                return el && !el.hidden;
            });
        }

        function fecharModaisVisuais() {
            const tefEl = $('#pdvu-modal-tef');
            const Tef = globalThis.PdvUniversalTef;
            const tefAberto = tefEl && !tefEl.hidden;
            if (tefAberto && Tef && (api._tefEmAndamento || (api._tefPendente && Tef.transacaoTefCancelavel(api._tefPendente)))) {
                void abortarOperacaoTef();
                return;
            }
            const entregaEl = $('#pdvu-modal-entrega');
            const entregaAberta = entregaEl && !entregaEl.hidden;
            ['pdvu-modal-pagamento', 'pdvu-modal-comprovante', 'pdvu-modal-empresa', 'pdvu-modal-empresa-item', 'pdvu-modal-pix', 'pdvu-modal-tef', 'pdvu-modal-pesagem', 'pdvu-modal-caixa', 'pdvu-modal-entrega'].forEach(function (id) {
                const el = doc.getElementById ? doc.getElementById(id) : $('#' + id);
                if (el) el.hidden = true;
            });
            if (entregaAberta) fecharModalEntrega(true);
            api._caixaAcaoModal = null;
            if (api._pixPollTimer) {
                clearTimeout(api._pixPollTimer);
                api._pixPollTimer = null;
            }
            api._pixEmAndamento = false;
            api._tefEmAndamento = false;
            api._tefCancelamentoSolicitado = false;
            api._tefPendente = null;
            api._pesagem = null;
            if (S) S.fecharModalPreservaDominio(api._session);
            focarBuscaSeApropriado();
        }

        function cancelarAtendimentoOuCarrinho() {
            if (S && S.emProcessamento(api._session)) {
                aviso('Operação em andamento. O atendimento não foi cancelado.');
                return;
            }
            if (api._sessaoAtendimento && api._sessaoAtendimento.atendimento_id) {
                cancelarAtendimentoReservado();
                return;
            }
            if (api._cart) api._cart.limpar();
            pintarCarrinho();
            aviso('');
        }

        const btnCancelar = $('#pdvu-cancelar');
        if (btnCancelar) {
            btnCancelar.addEventListener('click', cancelarAtendimentoOuCarrinho);
        }

        if (doc.addEventListener) {
            doc.addEventListener('keydown', function (ev) {
                const processamento = S && !S.atalhoPermitido(api._session);
                if (processamento) {
                    if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === 'F1' || ev.key === 'F10') {
                        ev.preventDefault();
                    }
                    return;
                }
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    const acao = resolverAcaoEscape({
                        processamento: false,
                        modalAberto: modalOperacionalAberto(),
                        drawerAberto: drawerAberto(),
                        temAtendimento: !!(api._sessaoAtendimento && api._sessaoAtendimento.atendimento_id),
                        pagamentoEmAndamento: !!(api._pagamentoLock || (api._session && (
                            api._session.estado === ESTADOS.PAGAMENTO_PROCESSANDO
                            || api._session.estado === ESTADOS.ATENDIMENTO_RESERVADO
                        )))
                    });
                    if (acao === 'FECHAR_MODAL') {
                        fecharModaisVisuais();
                        return;
                    }
                    if (acao === 'FECHAR_DRAWER') {
                        setDrawer(false);
                        return;
                    }
                    if (acao === 'PRESERVAR') {
                        aviso('ESC fechou só a interface. Use CANCELAR ATENDIMENTO para encerrar.');
                        return;
                    }
                    if (acao === 'CANCELAR_CARRINHO') {
                        cancelarAtendimentoOuCarrinho();
                    }
                    return;
                }
                if (ev.key === 'F1') {
                    ev.preventDefault();
                    const inp = $('#pdvu-busca-input');
                    if (inp) inp.focus();
                    return;
                }
                if (ev.key === 'F10') {
                    ev.preventDefault();
                    const fin = $('#pdvu-finalizar');
                    const Checkout = globalThis.PdvUniversalCheckout;
                    const itens = api._cart ? api._cart.obterItens() : [];
                    const permitido = !!(Checkout && Checkout.podeFinalizar(api._contexto, itens));
                    if (podeDispararF10({
                        disabled: !!(fin && fin.disabled),
                        processamento: false,
                        permitido: permitido
                    }) && fin) {
                        fin.click();
                    }
                }
            });
        }

        carregar();
        return { carregar, pintar, setEstado, pintarCarrinho };
    }

    return {
        ESTADOS,
        urlContexto,
        urlSelecionarEmpresa,
        urlBuscaProduto,
        urlIdentificarProduto,
        urlDisponibilidade,
        buscarProdutos,
        consultarDisponibilidade,
        aplicarCapabilities,
        rotuloModo,
        rotuloEmpresa,
        empresasDoContexto,
        nuncaAssumirEmpresaUm,
        carregarContexto,
        carregarContextoComRecuperacao,
        classificarErroContexto,
        registrarErroContexto,
        avisoContextoPronto,
        selecionarEmpresaOperacional,
        mensagemErro,
        montarModeloVisual,
        bindUi,
        SessionLib,
        IdentLib,
        PixLib,
        TefLib,
        CaixaLib,
        EntregaLib,
        PrecoAtacadoLib,
        PromocaoLib,
        urlStatusCaixa,
        classificarStatusCaixa,
        atualizarStatusCaixa,
        montarResumoVisual,
        calcularTotaisOperacionais,
        resolverAcaoEscape,
        podeDispararF10,
        formatarDataHoraPdv,
        aplicarTeclaCalc,
        moneyVisual,
        deveExibirAcaoPesagemManual,
        interpretarPesoManualUi,
        aplicarPesoManualNoCarrinho,
        montarEstadoPesagemManual
    };
});
