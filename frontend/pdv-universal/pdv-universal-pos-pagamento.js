/**
 * Materialização + fiscalização + comprovante do PDV Universal (Sprint 05.08).
 * Delega ao MUV. Sem rateio, NFC-e ou totais calculados no cliente.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalPosPagamento = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlMaterializar(id) {
        return `${baseApi()}/pdv-universal/atendimentos/${encodeURIComponent(id)}/materializar`;
    }

    function urlFiscalizar(id) {
        return `${baseApi()}/pdv-universal/atendimentos/${encodeURIComponent(id)}/fiscalizar`;
    }

    function urlComprovante(id, formato) {
        let url = `${baseApi()}/pdv-universal/atendimentos/${encodeURIComponent(id)}/comprovante`;
        if (formato) url += `?formato=${encodeURIComponent(formato)}`;
        return url;
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

    function podeMaterializar(contexto) {
        return !!((contexto && contexto.capacidades || {}).pode_materializar_atendimento);
    }

    function podeFiscalizar(contexto) {
        return !!((contexto && contexto.capacidades || {}).pode_fiscalizar_atendimento);
    }

    function podeVerComprovante(contexto) {
        return !!((contexto && contexto.capacidades || {}).pode_visualizar_comprovante);
    }

    async function postJson(url, body, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(url, {
            method: 'POST',
            headers: headersAuth(body && body.idempotency_key),
            body: JSON.stringify(body || {})
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

    async function materializar(atendimentoId, idempotencyKey, fetchFn) {
        return postJson(urlMaterializar(atendimentoId), { idempotency_key: idempotencyKey }, fetchFn);
    }

    async function fiscalizar(atendimentoId, fetchFn) {
        return postJson(urlFiscalizar(atendimentoId), {}, fetchFn);
    }

    async function obterComprovanteHtml(atendimentoId, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlComprovante(atendimentoId, 'HTML'), {
            method: 'GET',
            headers: headersAuth()
        });
        if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            const err = new Error(json.error || 'Falha ao obter comprovante.');
            err.code = json.code || 'ERRO_COMPROVANTE';
            throw err;
        }
        return res.text();
    }

    return {
        urlMaterializar,
        urlFiscalizar,
        urlComprovante,
        podeMaterializar,
        podeFiscalizar,
        podeVerComprovante,
        materializar,
        fiscalizar,
        obterComprovanteHtml
    };
});
