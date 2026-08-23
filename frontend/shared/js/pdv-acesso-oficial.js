/**
 * Destinos oficiais do PDV (Sprint 05.12).
 * Sem fallback silencioso universal → legado.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.urlPdvUniversalOficial = api.urlPdvUniversalOficial;
        root.urlPdvLegadoOficial = api.urlPdvLegadoOficial;
        root.abrirPdvUniversalOficial = api.abrirPdvUniversalOficial;
        root.destinoNavegacaoSeguro = api.destinoNavegacaoSeguro;
        root.PdvAcessoOficial = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function destinoNavegacaoSeguro(raw) {
        if (!raw || typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
        const path = trimmed.split('?')[0].split('#')[0];
        const permitidos = ['/pdv-universal', '/pdv', '/erp'];
        const ok = permitidos.some(function (p) {
            return path === p || path === p + '/' || path.indexOf(p + '/') === 0;
        });
        return ok ? path : null;
    }

    function urlPdvUniversalOficial() {
        return '/pdv-universal/';
    }

    function urlPdvLegadoOficial() {
        return '/pdv';
    }

    function abrirPdvUniversalOficial() {
        if (typeof globalThis.obterRecursosImplantacao === 'function') {
            const rec = globalThis.obterRecursosImplantacao() || {};
            if (rec.pdv === false) {
                if (typeof globalThis.showNotification === 'function') {
                    globalThis.showNotification('Módulo PDV não está licenciado.', 'warning');
                }
                return false;
            }
        }
        if (typeof globalThis.podeAbrirPDV === 'function' && !globalThis.podeAbrirPDV()) {
            return false;
        }
        globalThis.location.href = urlPdvUniversalOficial();
        return true;
    }

    return {
        destinoNavegacaoSeguro,
        urlPdvUniversalOficial,
        urlPdvLegadoOficial,
        abrirPdvUniversalOficial
    };
});
