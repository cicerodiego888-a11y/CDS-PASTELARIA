/**
 * Sprint 04.13 — cliente do comprovante unificado (somente consome a API oficial).
 * Sem cálculo, sem NFC-e direta, sem rateio, sem CSC/PFX.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.MuvComprovanteClient = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const CAMPOS_SECRETOS = [
        'token_csc', 'csc', 'senha_certificado', 'senhaCertificado',
        'certificado_pfx', 'pfx', 'path_certificado', 'pathCertificado',
        'rateio', 'rateios'
    ];

    function extrairAtendimentoId(resposta) {
        if (resposta == null) return null;
        if (typeof resposta === 'number' && Number.isFinite(resposta) && resposta > 0) {
            return Math.trunc(resposta);
        }
        if (typeof resposta === 'string' && /^\d+$/.test(resposta.trim())) {
            return parseInt(resposta.trim(), 10);
        }
        if (typeof resposta !== 'object') return null;
        const bruto = resposta.atendimento_id
            || resposta.atendimentoId
            || (resposta.atendimento && (resposta.atendimento.id || resposta.atendimento.atendimento_id))
            || null;
        const n = Number(bruto);
        if (!Number.isFinite(n) || n <= 0) return null;
        return Math.trunc(n);
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

    function montarUrlComprovante(atendimentoId, formato) {
        const id = extrairAtendimentoId(atendimentoId);
        if (!id) {
            const err = new Error('ATENDIMENTO_ID_OBRIGATORIO');
            err.code = 'ATENDIMENTO_ID_OBRIGATORIO';
            throw err;
        }
        let url = `${baseApi()}/atendimentos/${id}/comprovante`;
        if (formato) {
            url += `?formato=${encodeURIComponent(String(formato).toUpperCase())}`;
        }
        return url;
    }

    function montarUrlImprimir(atendimentoId) {
        const id = extrairAtendimentoId(atendimentoId);
        if (!id) {
            const err = new Error('ATENDIMENTO_ID_OBRIGATORIO');
            err.code = 'ATENDIMENTO_ID_OBRIGATORIO';
            throw err;
        }
        return `${baseApi()}/atendimentos/${id}/imprimir`;
    }

    function corpoImpressaoBrowser(largura) {
        return {
            destino: 'BROWSER',
            formato: 'HTML',
            largura: largura == null ? 40 : Number(largura)
        };
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
        return headers;
    }

    function dtoContemSegredo(obj, profundidade) {
        if (!obj || typeof obj !== 'object' || profundidade > 8) return false;
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i += 1) {
            const k = keys[i];
            const kl = k.toLowerCase();
            if (CAMPOS_SECRETOS.some((s) => kl === s.toLowerCase() || kl.includes('token_csc'))) {
                return true;
            }
            if (dtoContemSegredo(obj[k], profundidade + 1)) return true;
        }
        return false;
    }

    function classificarEstadoVisual(dto, erroCarregamento) {
        if (erroCarregamento) return 'ERRO_CARREGAMENTO';
        if (!dto) return 'CARREGANDO';
        const status = String((dto.atendimento && dto.atendimento.status) || '').toUpperCase();
        if (status === 'CANCELADO') return 'ATENDIMENTO_CANCELADO';
        const fiscal = String((dto.fiscal && dto.fiscal.status) || '').toUpperCase();
        const docs = Array.isArray(dto.documentos_fiscais) ? dto.documentos_fiscais : [];
        if (fiscal === 'FISCAL_PARCIAL') return 'FISCAL_PARCIAL';
        if (fiscal === 'FISCAL_ERRO') return 'FISCAL_ERRO';
        if (docs.length === 0 && (fiscal === 'PENDENTE' || fiscal === '')) return 'SEM_DOCUMENTO_FISCAL';
        return 'COMPROVANTE_DISPONIVEL';
    }

    function mensagensEstado(estado) {
        const mapa = {
            CARREGANDO: 'Carregando comprovante oficial…',
            COMPROVANTE_DISPONIVEL: 'Comprovante disponível.',
            SEM_DOCUMENTO_FISCAL: 'Sem documento fiscal. O comprovante comercial permanece visível.',
            FISCAL_PARCIAL: 'Fiscalização parcial: documentos autorizados e pendências são exibidos juntos.',
            FISCAL_ERRO: 'Há erro fiscal em alguma operação. Documentos autorizados continuam visíveis.',
            ATENDIMENTO_CANCELADO: 'Atendimento cancelado. O comprovante oficial permanece consultável.',
            ERRO_CARREGAMENTO: 'Não foi possível carregar o comprovante oficial.'
        };
        return mapa[estado] || '';
    }

    async function request(url, opcoes, fetchFn) {
        const fn = fetchFn || (typeof fetch === 'function' ? fetch : null);
        if (!fn) {
            const err = new Error('FETCH_INDISPONIVEL');
            err.code = 'FETCH_INDISPONIVEL';
            throw err;
        }
        const res = await fn(url, opcoes);
        const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
        let body;
        if (ct.indexOf('application/json') >= 0) {
            body = await res.json();
        } else {
            body = await res.text();
        }
        if (!res.ok) {
            const err = new Error((body && body.mensagem) || (body && body.error) || `HTTP_${res.status}`);
            err.code = (body && (body.codigo || body.code)) || 'ERRO_API_COMPROVANTE';
            err.status = res.status;
            err.body = body;
            throw err;
        }
        return body;
    }

    async function obterComprovanteJson(atendimentoId, fetchFn) {
        const url = montarUrlComprovante(atendimentoId, null);
        const dto = await request(url, { method: 'GET', headers: headersAuth() }, fetchFn);
        if (dtoContemSegredo(dto, 0)) {
            const err = new Error('COMPROVANTE_COM_DADOS_SECRETOS');
            err.code = 'COMPROVANTE_COM_DADOS_SECRETOS';
            throw err;
        }
        return dto;
    }

    async function obterComprovanteHtml(atendimentoId, fetchFn) {
        const url = montarUrlComprovante(atendimentoId, 'HTML');
        const headers = headersAuth();
        headers.Accept = 'text/html, application/json';
        return request(url, { method: 'GET', headers }, fetchFn);
    }

    async function prepararImpressaoBrowser(atendimentoId, fetchFn, largura) {
        const url = montarUrlImprimir(atendimentoId);
        const headers = headersAuth();
        headers['Content-Type'] = 'application/json';
        return request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(corpoImpressaoBrowser(largura))
        }, fetchFn);
    }

    return {
        extrairAtendimentoId,
        montarUrlComprovante,
        montarUrlImprimir,
        corpoImpressaoBrowser,
        classificarEstadoVisual,
        mensagensEstado,
        obterComprovanteJson,
        obterComprovanteHtml,
        prepararImpressaoBrowser,
        dtoContemSegredo,
        CAMPOS_SECRETOS
    };
});
