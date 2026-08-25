/**
 * Adaptador TEF do PDV Universal.
 * HTTP: POST /api/tef/pagar, POST /api/tef/cancelar, GET /api/tef/fluxo-pdv.
 * Regras de forma/tipo: frontend/shared/js/tefFluxoPagamento.js (sem duplicar).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalTef = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function carregarFluxoTefCompartilhado() {
        if (typeof globalThis !== 'undefined' && globalThis.TefFluxoPagamento) {
            return globalThis.TefFluxoPagamento;
        }
        if (typeof require === 'function') {
            try {
                require('../shared/js/tefFluxoPagamento.js');
            } catch (_e) { /* ignore */ }
        }
        return (typeof globalThis !== 'undefined' && globalThis.TefFluxoPagamento) || null;
    }

    const Fluxo = carregarFluxoTefCompartilhado();

    const ESTADOS_UI = Object.freeze({
        PROCESSANDO: 'TEF PROCESSANDO',
        APROVADO: 'TEF APROVADO',
        CANCELADO: 'TEF CANCELADO',
        ERRO: 'TEF ERRO'
    });

    let fluxoPdvCache = null;

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlPagar() {
        return `${baseApi()}/tef/pagar`;
    }

    function urlFluxoPdv() {
        return `${baseApi()}/tef/fluxo-pdv`;
    }

    function urlCancelar() {
        return `${baseApi()}/tef/cancelar`;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch (_e) { /* ignore */ }
        return headers;
    }

    function obterFluxoTefCompartilhado() {
        return Fluxo || carregarFluxoTefCompartilhado();
    }

    function modoOperacao(contexto) {
        return (contexto && (contexto.modo_operacao || contexto.modo_operacao_venda)) || '';
    }

    function tefDisponivelNoModo(contexto) {
        const modo = modoOperacao(contexto);
        if (modo === 'MULTIEMPRESA') {
            return {
                ok: false,
                code: 'TEF_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO',
                mensagem: 'TEF_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO'
            };
        }
        if (modo !== 'EMPRESA_UNICA') {
            return {
                ok: false,
                code: 'TEF_MODO_INDISPONIVEL',
                mensagem: 'TEF disponível somente em EMPRESA ÚNICA nesta sprint.'
            };
        }
        return { ok: true, code: null, mensagem: '' };
    }

    /**
     * Tipo enviado ao POST /tef/pagar — delega normalização ao módulo compartilhado.
     * Escopo Universal: débito/crédito (não pix_tef nesta sprint).
     */
    function mapearTipoTef(formaUi) {
        const F = obterFluxoTefCompartilhado();
        if (!F || !F.formaPagamentoUsaTEF(formaUi)) return null;
        const tipo = F.normalizarTipoTef(formaUi);
        if (tipo === 'pix_tef' || tipo === 'pix') return null;
        if (tipo === 'debito' || tipo === 'cartao_debito') return 'debito';
        if (tipo === 'credito' || tipo === 'cartao_credito' || tipo === 'cartao') return 'credito';
        return null;
    }

    function formaCheckoutAposTef(tipoTef) {
        const F = obterFluxoTefCompartilhado();
        const grav = F ? F.formaPagamentoGravacaoFiscal(tipoTef) : String(tipoTef || '').toLowerCase();
        if (grav === 'cartao_debito') return 'debito';
        if (grav === 'cartao_credito') return 'credito';
        return grav;
    }

    function valorLiquidoTef(totais) {
        const n = Number(totais && totais.total);
        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
    }

    function normalizarStatus(valor) {
        const s = String(valor || '').toLowerCase();
        if (['aprovado', 'approved', 'ok', 'success'].includes(s)) return 'aprovado';
        if (['negado', 'negada', 'denied', 'reprovado'].includes(s)) return 'negado';
        if (['cancelado', 'cancelada', 'cancelled'].includes(s)) return 'cancelado';
        if (['pendente', 'pending', 'processando'].includes(s)) return 'pendente';
        return 'erro';
    }

    function estaAprovado(retorno) {
        if (!retorno) return false;
        if (retorno.sucesso === true && normalizarStatus(retorno.status) === 'aprovado') return true;
        return normalizarStatus(retorno.status) === 'aprovado';
    }

    function estadoUiDeRetorno(retorno) {
        if (estaAprovado(retorno)) return ESTADOS_UI.APROVADO;
        const st = normalizarStatus(retorno && retorno.status);
        if (st === 'cancelado') return ESTADOS_UI.CANCELADO;
        if (st === 'pendente') return ESTADOS_UI.PROCESSANDO;
        return ESTADOS_UI.ERRO;
    }

    function extrairTransacaoId(origem) {
        if (!origem) return null;
        const id = origem.transacao_id != null ? origem.transacao_id : origem.transacaoId;
        const n = Number(id);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    /**
     * Transação cancelável via POST /tef/cancelar (não aprovada, checkout não iniciado).
     */
    function transacaoTefCancelavel(pendente) {
        if (!pendente) return false;
        if (!extrairTransacaoId(pendente)) return false;
        if (pendente.aprovado === true) return false;
        if (pendente.checkoutIniciado === true) return false;
        return true;
    }

    function cancelamentoConfirmado(retorno) {
        if (!retorno) return false;
        if (retorno.cancelado === true) return true;
        return normalizarStatus(retorno.status) === 'cancelado';
    }

    async function cancelarTransacaoTef({ transacao_id, motivo }, fetchFn) {
        const id = extrairTransacaoId({ transacao_id });
        if (!id) {
            const err = new Error('transacao_id é obrigatório.');
            err.code = 'TEF_CANCEL_SEM_ID';
            throw err;
        }
        const fn = fetchFn || fetch;
        const res = await fn(urlCancelar(), {
            method: 'POST',
            headers: headersAuth(),
            body: JSON.stringify({
                transacao_id: id,
                motivo: motivo || 'Cancelamento operador'
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || body.mensagem || ('HTTP ' + res.status));
            err.code = body.codigo || 'TEF_CANCEL_ERRO';
            err.body = body;
            err.statusHttp = res.status;
            throw err;
        }
        return body;
    }

    function dadosOficiaisParaCheckout(retorno) {
        if (!retorno || typeof retorno !== 'object') return {};
        const out = {};
        if (retorno.nsu != null) out.nsu = retorno.nsu;
        if (retorno.autorizacao != null) out.autorizacao = retorno.autorizacao;
        if (retorno.adquirente != null) out.adquirente = retorno.adquirente;
        if (retorno.bandeira != null) out.bandeira = retorno.bandeira;
        if (retorno.transacaoId != null || retorno.transacao_id != null) {
            out.tef_transacao_id = retorno.transacaoId || retorno.transacao_id;
        }
        return out;
    }

    async function consultarFluxoPdv(fetchFn, opcoes) {
        const force = opcoes && opcoes.forceRefresh;
        if (fluxoPdvCache && !force) return fluxoPdvCache;
        const fn = fetchFn || fetch;
        const res = await fn(urlFluxoPdv(), {
            method: 'GET',
            headers: headersAuth()
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || ('HTTP ' + res.status));
            err.code = 'TEF_FLUXO_ERRO';
            err.statusHttp = res.status;
            throw err;
        }
        fluxoPdvCache = body;
        return body;
    }

    function parseTefHabilitado(fluxo) {
        const F = obterFluxoTefCompartilhado();
        const val = fluxo && fluxo.tefHabilitado;
        return F ? F.parseTefHabilitado(val) : val === true;
    }

    function limparCacheFluxoPdv() {
        fluxoPdvCache = null;
    }

    /**
     * Gate operacional: modo + forma TEF + GET /tef/fluxo-pdv (tefHabilitado).
     */
    async function validarTefOperacional(contexto, forma, fetchFn) {
        const modoGate = tefDisponivelNoModo(contexto);
        if (!modoGate.ok) return modoGate;
        if (!mapearTipoTef(forma)) {
            return {
                ok: false,
                code: 'TEF_FORMA_INVALIDA',
                mensagem: 'Forma de pagamento não utiliza TEF.'
            };
        }
        try {
            const fluxo = await consultarFluxoPdv(fetchFn);
            if (!parseTefHabilitado(fluxo)) {
                return {
                    ok: false,
                    code: 'TEF_DESABILITADO',
                    mensagem: 'TEF não habilitado neste terminal.'
                };
            }
        } catch (err) {
            return {
                ok: false,
                code: err.code || 'TEF_CONFIG_INDISPONIVEL',
                mensagem: err.message || 'Não foi possível consultar configuração TEF.'
            };
        }
        return { ok: true, code: null, mensagem: '' };
    }

    async function iniciarTransacaoTef({ tipo, valor, parcelas, idempotency_key }, fetchFn) {
        const tipoOficial = mapearTipoTef(tipo) || tipo;
        if (!tipoOficial || (tipoOficial !== 'debito' && tipoOficial !== 'credito')) {
            const err = new Error('Tipo TEF inválido.');
            err.code = 'TEF_TIPO_INVALIDO';
            throw err;
        }
        const fn = fetchFn || fetch;
        const res = await fn(urlPagar(), {
            method: 'POST',
            headers: headersAuth(),
            body: JSON.stringify({
                tipo: tipoOficial,
                valor: Number(valor),
                parcelas: Number(parcelas || 1),
                venda_id: null,
                idempotency_key: idempotency_key || null
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body.status) {
            const err = new Error(body.error || body.mensagem || ('HTTP ' + res.status));
            err.code = body.codigo || 'TEF_ERRO_HTTP';
            err.body = body;
            err.statusHttp = res.status;
            throw err;
        }
        return body;
    }

    return {
        ESTADOS_UI,
        urlPagar,
        urlCancelar,
        urlFluxoPdv,
        extrairTransacaoId,
        transacaoTefCancelavel,
        cancelamentoConfirmado,
        cancelarTransacaoTef,
        obterFluxoTefCompartilhado,
        tefDisponivelNoModo,
        validarTefOperacional,
        consultarFluxoPdv,
        parseTefHabilitado,
        limparCacheFluxoPdv,
        mapearTipoTef,
        formaCheckoutAposTef,
        valorLiquidoTef,
        normalizarStatus,
        estaAprovado,
        estadoUiDeRetorno,
        dadosOficiaisParaCheckout,
        iniciarTransacaoTef,
        modoOperacao
    };
});
