/**
 * Destinos do PDV (Sprint 05.12).
 * /pdv-universal = PDV Universal CONGELADO (legado). /pdv = PDV Normal (oficial em evolução).
 * URLs de produção não foram alteradas nesta sprint.
 * Sem fallback silencioso universal → /pdv.
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
        root.abrirPdvOficial = api.abrirPdvOficial;
        root.abrirErpOficial = api.abrirErpOficial;
        root.destinoNavegacaoSeguro = api.destinoNavegacaoSeguro;
        root.notificarPedidoPdvFinalizado = api.notificarPedidoPdvFinalizado;
        root.lerTickListaPedidos = api.lerTickListaPedidos;
        root.PdvAcessoOficial = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function destinoNavegacaoSeguro(raw) {
        if (!raw || typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
        const path = trimmed.split('?')[0].split('#')[0];
        const permitidos = ['/pdv-universal', '/pdv', '/erp', '/mobile', '/mobile-pedido', '/mobile-mesas', '/mobile-pdv', '/mobile-contagem'];
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

    function emElectronComAbrirPdv() {
        return !!(globalThis.electronAPI && typeof globalThis.electronAPI.abrirPdv === 'function');
    }

    /**
     * Electron: janela PDV independente (mesmo backend).
     * Navegador: navega para /pdv na mesma aba.
     */
    function abrirPdvOficial(opcoes) {
        if (typeof globalThis.obterRecursosImplantacao === 'function') {
            const rec = globalThis.obterRecursosImplantacao() || {};
            if (rec.pdv === false) {
                if (typeof globalThis.showNotification === 'function') {
                    globalThis.showNotification('Módulo PDV não está licenciado.', 'warning');
                }
                return Promise.resolve({ ok: false, codigo: 'PDV_NAO_LICENCIADO' });
            }
        }
        if (typeof globalThis.podeAbrirPDV === 'function' && !globalThis.podeAbrirPDV()) {
            return Promise.resolve({ ok: false, codigo: 'PDV_BLOQUEADO' });
        }
        if (opcoes && opcoes.handoff) {
            try {
                const bruto = JSON.stringify(opcoes.handoff);
                // localStorage é compartilhado entre janelas Electron da mesma origem.
                if (globalThis.localStorage) globalThis.localStorage.setItem('pdvPedidoHandoff', bruto);
                if (globalThis.sessionStorage) globalThis.sessionStorage.setItem('pdvPedidoHandoff', bruto);
            } catch (_e) { /* ignore */ }
        }
        if (emElectronComAbrirPdv()) {
            return Promise.resolve(globalThis.electronAPI.abrirPdv(opcoes || {}))
                .catch((err) => ({
                    ok: false,
                    codigo: 'FALHA_IPC',
                    mensagem: err && err.message ? err.message : String(err)
                }));
        }
        const destino = urlPdvLegadoOficial();
        globalThis.location.assign(destino);
        return Promise.resolve({ ok: true, modo: 'web' });
    }

    function emElectronComAbrirErp() {
        return !!(globalThis.electronAPI && typeof globalThis.electronAPI.abrirErp === 'function');
    }

    /** Electron: foca ERP existente. Web: navega para /erp. */
    function abrirErpOficial(opcoes) {
        const opts = opcoes || {};
        if (emElectronComAbrirErp()) {
            return Promise.resolve(globalThis.electronAPI.abrirErp(opts))
                .catch((err) => ({
                    ok: false,
                    codigo: 'FALHA_IPC',
                    mensagem: err && err.message ? err.message : String(err)
                }));
        }
        const page = opts.page ? `?page=${encodeURIComponent(String(opts.page))}` : '';
        globalThis.location.assign(`/erp${page}`);
        return Promise.resolve({ ok: true, modo: 'web' });
    }

    /** Sinal cross-window: PDV avisa o ERP para atualizar a lista de Pedidos. */
    const CHAVE_LISTA_PEDIDOS_TICK = 'cds_pedidos_lista_tick';

    function notificarPedidoPdvFinalizado(detalhe) {
        try {
            if (!globalThis.localStorage) return false;
            const payload = {
                ts: Date.now(),
                pedido_id: detalhe && detalhe.pedido_id != null ? Number(detalhe.pedido_id) : null,
                consolidacao_id: detalhe && detalhe.consolidacao_id != null
                    ? Number(detalhe.consolidacao_id)
                    : null
            };
            globalThis.localStorage.setItem(CHAVE_LISTA_PEDIDOS_TICK, JSON.stringify(payload));
            return true;
        } catch (_e) {
            return false;
        }
    }

    function lerTickListaPedidos() {
        try {
            if (!globalThis.localStorage) return null;
            const raw = globalThis.localStorage.getItem(CHAVE_LISTA_PEDIDOS_TICK);
            if (!raw) return null;
            const o = JSON.parse(raw);
            return o && Number(o.ts) > 0 ? o : null;
        } catch (_e) {
            return null;
        }
    }

    return {
        destinoNavegacaoSeguro,
        urlPdvUniversalOficial,
        urlPdvLegadoOficial,
        abrirPdvUniversalOficial,
        abrirPdvOficial,
        abrirErpOficial,
        emElectronComAbrirPdv,
        emElectronComAbrirErp,
        CHAVE_LISTA_PEDIDOS_TICK,
        notificarPedidoPdvFinalizado,
        lerTickListaPedidos
    };
});
