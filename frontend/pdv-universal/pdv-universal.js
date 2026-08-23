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
            fin.disabled = !!(busy || api._checkoutLock || criado || !pode);
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

        function pintarCarrinho() {
            const box = $('#pdvu-linhas-carrinho');
            const vazio = $('#pdvu-atendimento-vazio');
            const fin = $('#pdvu-finalizar');
            const totalEl = $('#pdvu-total');
            const qtdEl = $('#pdvu-qtd-itens');
            if (!api._cart) return;
            const itens = api._cart.obterItens();
            if (vazio) vazio.hidden = itens.length > 0;
            if (totalEl) totalEl.textContent = `R$ ${api._cart.calcularTotal().toFixed(2).replace('.', ',')}`;
            if (qtdEl) qtdEl.textContent = String(itens.reduce((a, i) => a + i.quantidade, 0));
            atualizarBotaoFinalizar();
            pintarEmpresasAtendimento();
            if (!box) return;
            box.innerHTML = '';
            const caps = aplicarCapabilities(api._contexto);
            itens.forEach(function (i) {
                const div = doc.createElement('div');
                div.className = 'pdvu-linha';
                const emp = caps.empresa_por_item
                    ? `<small>Empresa: ${i.empresa_nome || i.empresa_id}</small>`
                    : `<small class="pdvu-emp-discreta">Empresa ${i.empresa_id}</small>`;
                div.innerHTML = `<strong>${i.quantidade}x ${i.descricao}</strong>${emp}`
                    + `<span>un. R$ ${Number(i.valor_unitario).toFixed(2).replace('.', ',')} · sub. R$ ${Number(i.subtotal).toFixed(2).replace('.', ',')}</span>`;
                const mais = doc.createElement('button');
                mais.type = 'button';
                mais.textContent = '+';
                mais.addEventListener('click', function () {
                    alterarQtdUi(i, i.quantidade + 1);
                });
                const menos = doc.createElement('button');
                menos.type = 'button';
                menos.textContent = '−';
                menos.addEventListener('click', function () {
                    if (i.quantidade <= 1) api._cart.removerItem(i.produto_id, i.empresa_id);
                    else alterarQtdUi(i, i.quantidade - 1);
                    pintarCarrinho();
                });
                div.appendChild(menos);
                div.appendChild(mais);
                box.appendChild(div);
            });
        }

        async function alterarQtdUi(item, nova) {
            try {
                const disp = await api.consultarDisponibilidade(item.produto_id);
                const emp = (disp.empresas_disponiveis || []).find((e) => Number(e.empresa_id) === item.empresa_id);
                const teto = emp ? Number(emp.disponibilidade.total) : 0;
                if (nova > 1e-9) api._cart.alterarQuantidade(item.produto_id, item.empresa_id, nova, teto);
                pintarCarrinho();
                aviso('');
            } catch (err) {
                aviso(err.message || 'Estoque insuficiente.');
            }
        }

        async function tentarAdicionar(produto, empresaEscolhida) {
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
                return;
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
                quantidade: 1,
                valor_unitario: produto.preco_venda != null ? produto.preco_venda : produto.preco,
                empresa_id: resolvida.empresa_id,
                empresa_nome: resolvida.nome,
                disponibilidade: resolvida.disponibilidade,
                origem_identificacao_empresa: resolvida.origem_identificacao_empresa
            }, resolvida.disponibilidade && resolvida.disponibilidade.total);
            pintarCarrinho();
            aviso('');
        }

        const busca = $('#pdvu-busca-input');
        if (busca) {
            busca.disabled = false;
            let t = null;
            busca.addEventListener('input', function () {
                clearTimeout(t);
                t = setTimeout(async function () {
                    const lista = $('#pdvu-resultados');
                    if (!lista) return;
                    lista.innerHTML = '';
                    const itens = await api.buscarProdutos(busca.value);
                    itens.forEach(function (p) {
                        const b = doc.createElement('button');
                        b.type = 'button';
                        b.className = 'pdvu-resultado';
                        b.textContent = p.nome || p.descricao || ('#' + p.id);
                        b.addEventListener('click', function () {
                            tentarAdicionar(p).catch(function (err) { aviso(err.message); });
                        });
                        lista.appendChild(b);
                    });
                }, 220);
            });
        }

        const listaItemEmp = $('#pdvu-lista-empresa-item');
        if (listaItemEmp) {
            listaItemEmp.addEventListener('click', function (ev) {
                const btn = ev.target.closest('[data-empresa-item]');
                if (!btn || !api._pendenteProduto) return;
                const modal = $('#pdvu-modal-empresa-item');
                if (modal) modal.hidden = true;
                tentarAdicionar(api._pendenteProduto, btn.getAttribute('data-empresa-item'))
                    .catch(function (err) { aviso(err.message); });
                api._pendenteProduto = null;
            });
        }

        const finBtn = $('#pdvu-finalizar');
        if (finBtn) {
            finBtn.addEventListener('click', async function () {
                const Checkout = globalThis.PdvUniversalCheckout;
                const ctx = api._contexto;
                const itens = api._cart ? api._cart.obterItens() : [];
                if (!Checkout || !Checkout.podeFinalizar(ctx, itens)) {
                    aviso((Checkout && Checkout.mensagemBloqueio(ctx)) || 'Checkout indisponível.');
                    return;
                }
                if (S && !S.adquirir(api._session, S.ACOES.CHECKOUT)) return;
                api._checkoutLock = true;
                finBtn.disabled = true;
                const root = $('#pdvu-root');
                if (root) root.setAttribute('data-estado', ESTADOS.CHECKOUT_PROCESSANDO);
                aviso('Processando checkout…');
                try {
                    const forma = ($('#pdvu-forma') && $('#pdvu-forma').value) || 'dinheiro';
                    const total = api._cart.calcularTotal();
                    const r = await Checkout.finalizarCheckout({
                        itens,
                        pagamentos: [{ forma_pagamento: forma, valor: total }],
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

        if (doc.addEventListener) {
            doc.addEventListener('keydown', function (ev) {
                if (S && !S.atalhoPermitido(api._session)) {
                    if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === 'F1') {
                        ev.preventDefault();
                    }
                    return;
                }
                if (ev.key === 'Escape') {
                    ev.preventDefault();
                    const pg = $('#pdvu-modal-pagamento');
                    if (pg) pg.hidden = true;
                    const comp = $('#pdvu-modal-comprovante');
                    if (comp) comp.hidden = true;
                    return;
                }
                if (ev.key === 'F1') {
                    ev.preventDefault();
                    const inp = $('#pdvu-busca-input');
                    if (inp) inp.focus();
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
        SessionLib
    };
});
