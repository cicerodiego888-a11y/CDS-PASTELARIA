/**
 * Checkout EMPRESA_UNICA do PDV Universal (Sprint 05.05).
 * POST /pdv-universal/checkout. Sem chamada direta a vendas legado ou TEF.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalCheckout = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlCheckout() {
        return `${baseApi()}/pdv-universal/checkout`;
    }

    function podeFinalizar(contexto, itens) {
        const caps = (contexto && contexto.capacidades) || {};
        if (!itens || !itens.length) return false;
        if (caps.checkout_multiempresa) return true;
        if (!caps.checkout_empresa_unica) return false;
        if (!contexto || !contexto.empresa_selecionada || !contexto.empresa_selecionada.id) return false;
        return true;
    }

    function mensagemBloqueio(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        if (caps.checkout_multiempresa) return '';
        if (!caps.checkout_empresa_unica) {
            return 'CHECKOUT_INDISPONIVEL';
        }
        return '';
    }

    function aplicarResultadoCheckout(resposta) {
        if (resposta && (resposta.modo_operacao_venda === 'MULTIEMPRESA' || resposta.modo === 'MULTIEMPRESA')) {
            const atd = resposta.atendimento || {};
            return {
                estado: 'ATENDIMENTO_CRIADO',
                atendimento_id: atd.id || resposta.atendimento_id,
                codigo: atd.codigo,
                status: atd.status,
                operacoes: resposta.operacoes || [],
                pagamento_pendente: resposta.pagamento_pendente !== false,
                venda_concluida: false,
                total: resposta.total != null ? Number(resposta.total) : null
            };
        }
        return {
            estado: 'READY',
            venda_id: resposta && resposta.venda_id,
            pagamento_pendente: false
        };
    }

    function continuarParaPagamento(sessao) {
        const Pag = (typeof globalThis !== 'undefined' && globalThis.PdvUniversalPagamento)
            || (typeof require === 'function' ? require('./pdv-universal-pagamento.js') : null);
        if (Pag && Pag.iniciarContinuidade) {
            return Pag.iniciarContinuidade(sessao);
        }
        return { executado: true, acao: 'INICIAR_RESERVA' };
    }

    async function finalizarCheckout({ itens, pagamentos, emitir_fiscal, idempotency_key }, fetchFn) {
        const fn = fetchFn || fetch;
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
            const emp = typeof localStorage !== 'undefined' ? localStorage.getItem('cds_empresa_id') : '';
            if (emp) headers['X-Empresa-Id'] = emp;
        } catch (_e) { /* ignore */ }
        if (idempotency_key) headers['Idempotency-Key'] = idempotency_key;

        const payload = { itens, pagamentos, emitir_fiscal: !!emitir_fiscal, idempotency_key };
        const res = await fn(urlCheckout(), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || 'Falha no checkout.');
            err.code = body.code || 'ERRO_CHECKOUT';
            err.body = body;
            throw err;
        }
        return body;
    }

    return {
        urlCheckout,
        podeFinalizar,
        mensagemBloqueio,
        finalizarCheckout,
        aplicarResultadoCheckout,
        continuarParaPagamento
    };
});
