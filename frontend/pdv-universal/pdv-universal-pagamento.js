/**
 * Pagamento unificado MULTIEMPRESA do PDV Universal (Sprint 05.07).
 * Não calcula rateio. Não chama TEF. Não materializa.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalPagamento = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ESTRATEGIA_PADRAO = 'POR_ITEM';

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlReservar(id) {
        return `${baseApi()}/pdv-universal/atendimentos/${encodeURIComponent(id)}/reservar`;
    }

    function urlPagamento(id) {
        return `${baseApi()}/pdv-universal/atendimentos/${encodeURIComponent(id)}/pagamento`;
    }

    function urlCancelar(id) {
        return `${baseApi()}/pdv-universal/atendimentos/${encodeURIComponent(id)}/cancelar`;
    }

    function headersAuth(idempotencyKey) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
            const emp = typeof localStorage !== 'undefined' ? localStorage.getItem('cds_empresa_id') : '';
            if (emp) headers['X-Empresa-Id'] = emp;
        } catch (_e) { /* ignore */ }
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        return headers;
    }

    function podeReservar(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        return !!caps.pode_reservar_atendimento;
    }

    function podeConfirmarPagamento(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        return !!caps.pode_confirmar_pagamento_unificado;
    }

    function podeCancelarReservado(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        return !!caps.pode_cancelar_atendimento_reservado;
    }

    function montarPayloadPagamento({ pagamentos, estrategia_rateio, idempotency_key }) {
        return {
            pagamentos: (pagamentos || []).map((p) => ({
                forma_pagamento: p.forma_pagamento,
                valor: Number(p.valor)
            })),
            estrategia_rateio: estrategia_rateio || ESTRATEGIA_PADRAO,
            idempotency_key
        };
    }

    async function postJson(url, body, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(url, {
            method: 'POST',
            headers: headersAuth(body && body.idempotency_key),
            body: body ? JSON.stringify(body) : '{}'
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(json.error || 'Falha na operação do atendimento.');
            err.code = json.code || 'ERRO_ATENDIMENTO';
            err.body = json;
            throw err;
        }
        return json;
    }

    async function reservarAtendimento(atendimentoId, fetchFn) {
        return postJson(urlReservar(atendimentoId), {}, fetchFn);
    }

    async function confirmarPagamento(atendimentoId, entrada, fetchFn) {
        return postJson(urlPagamento(atendimentoId), montarPayloadPagamento(entrada || {}), fetchFn);
    }

    async function cancelarAtendimento(atendimentoId, fetchFn) {
        return postJson(urlCancelar(atendimentoId), {}, fetchFn);
    }

    function iniciarContinuidade(sessao) {
        return {
            executado: true,
            acao: 'INICIAR_RESERVA',
            atendimento_id: sessao && (sessao.atendimento_id || (sessao.atendimento && sessao.atendimento.id))
        };
    }

    return {
        ESTRATEGIA_PADRAO,
        urlReservar,
        urlPagamento,
        urlCancelar,
        podeReservar,
        podeConfirmarPagamento,
        podeCancelarReservado,
        montarPayloadPagamento,
        reservarAtendimento,
        confirmarPagamento,
        cancelarAtendimento,
        iniciarContinuidade
    };
});
