/**
 * Adaptador PIX do PDV Universal (05.24).
 * Consome POST /api/pix/criar-cobranca e GET /api/pix/status/:txid.
 * Não cria gateway. Não confirma pagamento no clique.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalPix = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ESTADOS_UI = Object.freeze({
        AGUARDANDO: 'AGUARDANDO PIX',
        PENDENTE: 'PIX PENDENTE',
        CONFIRMADO: 'PIX CONFIRMADO',
        ERRO: 'PIX ERRO'
    });

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlCriarCobranca() {
        return `${baseApi()}/pix/criar-cobranca`;
    }

    function urlStatus(txid) {
        return `${baseApi()}/pix/status/${encodeURIComponent(txid)}`;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch (_e) { /* ignore */ }
        return headers;
    }

    function modoOperacao(contexto) {
        return (contexto && (contexto.modo_operacao || contexto.modo_operacao_venda)) || '';
    }

    function pixDisponivelNoModo(contexto) {
        const modo = modoOperacao(contexto);
        if (modo === 'MULTIEMPRESA') {
            return {
                ok: false,
                code: 'PIX_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO',
                mensagem: 'PIX_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO'
            };
        }
        if (modo !== 'EMPRESA_UNICA') {
            return {
                ok: false,
                code: 'PIX_MODO_INDISPONIVEL',
                mensagem: 'PIX disponível somente em EMPRESA ÚNICA nesta sprint.'
            };
        }
        return { ok: true, code: null, mensagem: '' };
    }

    function normalizarEstadoUi(statusContrato) {
        const s = String(statusContrato || '').toUpperCase();
        if (s === 'PAGO' || s === 'APPROVED' || s === 'CONFIRMADO') return ESTADOS_UI.CONFIRMADO;
        if (s === 'ERRO' || s === 'REJECTED' || s === 'CANCELADO' || s === 'EXPIRADO') return ESTADOS_UI.ERRO;
        if (s === 'PENDENTE' || s === 'PENDING') return ESTADOS_UI.PENDENTE;
        if (!s) return ESTADOS_UI.AGUARDANDO;
        return ESTADOS_UI.PENDENTE;
    }

    function valorLiquidoPix(totais) {
        const t = totais || {};
        const n = Number(t.total);
        return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
    }

    async function criarCobrancaPix({ valor, descricao, venda_id }, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlCriarCobranca(), {
            method: 'POST',
            headers: headersAuth(),
            body: JSON.stringify({
                valor: Number(valor),
                descricao: descricao || 'Venda PDV Universal',
                venda_id: venda_id || null
            })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.success === false) {
            const err = new Error((body && body.error) || 'Falha ao criar cobrança PIX.');
            err.code = 'PIX_ERRO_CRIACAO';
            err.body = body;
            throw err;
        }
        const cob = body.cobranca || body;
        return {
            txid: cob.txid,
            status: cob.status || 'PENDENTE',
            copia_cola: cob.copiaCola || cob.copia_cola || null,
            qr_code_base64: cob.qrCodeBase64 || cob.qr_code_base64 || null,
            valor: Number(valor),
            raw: cob
        };
    }

    async function consultarStatusPix(txid, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlStatus(txid), {
            method: 'GET',
            headers: headersAuth()
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.success === false) {
            const err = new Error((body && body.error) || 'Falha ao consultar PIX.');
            err.code = 'PIX_ERRO_STATUS';
            err.body = body;
            throw err;
        }
        const st = body.status || body;
        return {
            status: st.status || st,
            statusOriginal: st.statusOriginal || null,
            raw: st
        };
    }

    /**
     * Evita cobrança duplicada: mesma sessão com txid pendente e mesmo valor.
     */
    function deveReutilizarCobranca(sessaoPix, valor) {
        if (!sessaoPix || !sessaoPix.txid) return false;
        if (Number(sessaoPix.valor) !== Number(valor)) return false;
        const ui = normalizarEstadoUi(sessaoPix.status);
        return ui === ESTADOS_UI.PENDENTE || ui === ESTADOS_UI.AGUARDANDO;
    }

    return {
        ESTADOS_UI,
        urlCriarCobranca,
        urlStatus,
        pixDisponivelNoModo,
        normalizarEstadoUi,
        valorLiquidoPix,
        criarCobrancaPix,
        consultarStatusPix,
        deveReutilizarCobranca,
        modoOperacao
    };
});
