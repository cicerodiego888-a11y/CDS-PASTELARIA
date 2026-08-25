/**
 * Adaptador operacional de caixa do PDV Universal (Sprint 05.33).
 * Reutiliza APIs existentes: GET/POST /api/caixa/*.
 * Sem motor novo, sem cálculo de fechamento local.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalCaixa = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ACOES = Object.freeze({
        ABRIR: 'ABRIR',
        SANGRIA: 'SANGRIA',
        SUPRIMENTO: 'SUPRIMENTO',
        FECHAR: 'FECHAR',
        ATUALIZAR: 'ATUALIZAR'
    });

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlAberto() {
        return `${baseApi()}/caixa/aberto`;
    }

    function urlAbrir() {
        return `${baseApi()}/caixa/abrir`;
    }

    function urlSangria() {
        return `${baseApi()}/caixa/sangria`;
    }

    function urlSuprimento() {
        return `${baseApi()}/caixa/suprimento`;
    }

    function urlFechar() {
        return `${baseApi()}/caixa/fechar`;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch (_e) { /* ignore */ }
        try {
            if (typeof localStorage !== 'undefined') {
                const emp = localStorage.getItem('cds_empresa_id');
                if (emp) headers['X-Empresa-Id'] = emp;
            }
        } catch (_e2) { /* ignore */ }
        return headers;
    }

    function obterTerminalId() {
        try {
            if (typeof globalThis.terminalId !== 'undefined' && globalThis.terminalId != null) {
                return globalThis.terminalId;
            }
            if (typeof localStorage === 'undefined') return null;
            return localStorage.getItem('cds_terminal_id')
                || localStorage.getItem('terminal_id')
                || null;
        } catch (_e) {
            return null;
        }
    }

    function comTerminal(body) {
        const out = Object.assign({}, body || {});
        const tid = obterTerminalId();
        if (tid != null && tid !== '') {
            out.terminal_id = tid;
        }
        return out;
    }

    function parseValor(raw) {
        if (raw == null || raw === '') return NaN;
        const s = String(raw).trim().replace(/\s/g, '').replace(',', '.');
        return Number(s);
    }

    /**
     * Ações visíveis conforme status classificado (05.23).
     */
    function acoesVisiveisPorStatus(codigo) {
        const c = String(codigo || '').toUpperCase();
        if (c === 'FECHADO') {
            return { abrir: true, sangria: false, suprimento: false, fechar: false, atualizar: true };
        }
        if (c === 'ABERTO') {
            return { abrir: false, sangria: true, suprimento: true, fechar: true, atualizar: true };
        }
        return { abrir: false, sangria: false, suprimento: false, fechar: false, atualizar: true };
    }

    async function postCaixa(url, body, fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(url, {
            method: 'POST',
            headers: headersAuth(),
            body: JSON.stringify(comTerminal(body))
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(payload.error || payload.message || ('HTTP ' + res.status));
            err.code = payload.code || 'CAIXA_ERRO';
            err.statusHttp = res.status;
            err.requer_senha_admin = payload.requer_senha_admin === true;
            err.body = payload;
            throw err;
        }
        return payload;
    }

    async function abrirCaixa({ valor_inicial, senha_admin }, fetchFn) {
        const valor = parseValor(valor_inicial);
        if (!Number.isFinite(valor) || valor < 0) {
            const err = new Error('Informe um valor inicial válido.');
            err.code = 'CAIXA_VALOR_INVALIDO';
            throw err;
        }
        const body = { valor_inicial: valor };
        if (senha_admin) body.senha_admin = senha_admin;
        return postCaixa(urlAbrir(), body, fetchFn);
    }

    async function registrarSangria({ valor, motivo, senha_admin }, fetchFn) {
        const v = parseValor(valor);
        if (!Number.isFinite(v) || v <= 0) {
            const err = new Error('Informe um valor válido para sangria.');
            err.code = 'CAIXA_VALOR_INVALIDO';
            throw err;
        }
        const body = {
            valor: v,
            motivo: motivo != null && String(motivo).trim() !== ''
                ? String(motivo).trim()
                : 'Sangria de caixa'
        };
        if (senha_admin) body.senha_admin = senha_admin;
        return postCaixa(urlSangria(), body, fetchFn);
    }

    async function registrarSuprimento({ valor, motivo, senha_admin }, fetchFn) {
        const v = parseValor(valor);
        if (!Number.isFinite(v) || v <= 0) {
            const err = new Error('Informe um valor válido para suprimento.');
            err.code = 'CAIXA_VALOR_INVALIDO';
            throw err;
        }
        const body = {
            valor: v,
            motivo: motivo != null && String(motivo).trim() !== ''
                ? String(motivo).trim()
                : 'Suprimento de caixa'
        };
        if (senha_admin) body.senha_admin = senha_admin;
        return postCaixa(urlSuprimento(), body, fetchFn);
    }

    async function fecharCaixa({ valor_informado, observacao, senha_admin }, fetchFn) {
        const valor = parseValor(valor_informado == null || valor_informado === '' ? 0 : valor_informado);
        if (!Number.isFinite(valor) || valor < 0) {
            const err = new Error('Informe um valor de fechamento válido.');
            err.code = 'CAIXA_VALOR_INVALIDO';
            throw err;
        }
        const body = {
            valor_informado: valor,
            observacao: observacao != null ? String(observacao) : ''
        };
        if (senha_admin) body.senha_admin = senha_admin;
        return postCaixa(urlFechar(), body, fetchFn);
    }

    return {
        ACOES,
        urlAberto,
        urlAbrir,
        urlSangria,
        urlSuprimento,
        urlFechar,
        obterTerminalId,
        parseValor,
        acoesVisiveisPorStatus,
        abrirCaixa,
        registrarSangria,
        registrarSuprimento,
        fecharCaixa
    };
});
