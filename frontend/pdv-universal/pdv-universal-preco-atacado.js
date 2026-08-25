/**
 * Adaptador de preço atacado — PDV Universal (Sprint 05.35).
 * Delega cálculo a frontend/shared/js/motor-preco-atacado.js (MotorPrecoAtacado).
 * Faixas: GET /api/produtos/:id/atacado (mesmo contrato do PDV legado).
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalPrecoAtacado = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const cacheFaixas = new Map();

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlFaixasAtacado(produtoId) {
        return `${baseApi()}/produtos/${Number(produtoId)}/atacado`;
    }

    function carregarMotor() {
        if (typeof globalThis !== 'undefined' && globalThis.MotorPrecoAtacado) {
            return globalThis.MotorPrecoAtacado;
        }
        if (typeof require === 'function') {
            try {
                require('../shared/js/motor-preco-atacado.js');
            } catch (_e) { /* ignore */ }
        }
        return (typeof globalThis !== 'undefined' && globalThis.MotorPrecoAtacado) || null;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch (_e) { /* ignore */ }
        return headers;
    }

    function itemElegivelAtacado(item) {
        return !!(item && Number(item.venda_atacado || 0) === 1);
    }

    function escolherFaixa(faixas, quantidade) {
        const qtd = Number(quantidade);
        if (!Array.isArray(faixas) || !faixas.length || !Number.isFinite(qtd)) return null;
        let escolhida = null;
        faixas.forEach(function (f) {
            const qmin = Number(f.quantidade_minima || 0);
            if (qtd >= qmin) {
                if (!escolhida || qmin > Number(escolhida.quantidade_minima || 0)) {
                    escolhida = f;
                }
            }
        });
        return escolhida;
    }

    /**
     * Cálculo puro — usa MotorPrecoAtacado existente (sem duplicar faixas).
     */
    function calcularPrecoAtacado(opcoes) {
        const o = opcoes || {};
        const Motor = carregarMotor();
        const precoComercial = Number(o.precoBase);
        const precoOriginal = Number(o.precoOriginal != null ? o.precoOriginal : o.precoBase);
        const quantidade = Number(o.quantidade);
        const faixas = o.faixas;
        const padrao = {
            precoUnitario: precoComercial,
            precoUnitarioExibicao: precoComercial,
            subtotal: Motor ? Motor.arredondarMoeda(precoComercial * quantidade) : Math.round(precoComercial * quantidade * 100) / 100,
            descontoAtacado: 0,
            isAtacado: false,
            tipo_preco: 'varejo'
        };
        if (!Motor || !Number.isFinite(precoComercial) || precoComercial <= 0 || !Number.isFinite(quantidade) || quantidade <= 0) {
            return padrao;
        }
        const escolhida = escolherFaixa(faixas, quantidade);
        if (!escolhida) return padrao;
        const precoAtacado = Number(escolhida.preco_atacado || 0);
        if (precoAtacado <= 0) return padrao;

        const calc = Motor.calcularLinhaAtacadoFaixa({
            precoVenda: precoOriginal,
            precoAtacado,
            quantidade
        });
        const precoAplicado = Math.min(precoComercial, calc.precoUnitarioInterno);
        const linha = Motor.calcularLinhaPrecoUnitarioInformado({
            precoOriginal: precoOriginal,
            quantidade,
            precoUnitarioInformado: precoAplicado
        });
        return {
            precoUnitario: precoAplicado,
            precoUnitarioExibicao: linha.precoUnitarioExibicao,
            subtotal: linha.total,
            descontoAtacado: calc.descontoAtacado,
            isAtacado: precoAplicado < precoComercial,
            tipo_preco: precoAplicado < precoComercial ? 'atacado' : 'varejo'
        };
    }

    async function buscarFaixasAtacado(produtoId, fetchFn, opcoes) {
        const id = Number(produtoId);
        if (!Number.isInteger(id) || id <= 0) return [];
        const force = opcoes && opcoes.forceRefresh;
        if (!force && cacheFaixas.has(id)) return cacheFaixas.get(id);
        const fn = fetchFn || fetch;
        try {
            const res = await fn(urlFaixasAtacado(id), {
                method: 'GET',
                headers: headersAuth()
            });
            if (!res.ok) {
                cacheFaixas.set(id, []);
                return [];
            }
            const body = await res.json().catch(() => []);
            const faixas = Array.isArray(body) ? body : (body.faixas || body.items || []);
            cacheFaixas.set(id, faixas);
            return faixas;
        } catch (_e) {
            cacheFaixas.set(id, []);
            return [];
        }
    }

    function aplicarResultadoNoItem(item, resultado, precoBase) {
        if (!item || !resultado) return item;
        const base = Number.isFinite(Number(precoBase)) ? Number(precoBase) : Number(item.preco_base || item.valor_unitario);
        item.preco_base = base;
        item.valor_unitario = resultado.precoUnitarioExibicao != null
            ? resultado.precoUnitarioExibicao
            : resultado.precoUnitario;
        item.subtotal = resultado.subtotal;
        item.desconto_atacado = Number(resultado.descontoAtacado || 0);
        item.tipo_preco = resultado.tipo_preco || (resultado.isAtacado ? 'atacado' : 'varejo');
        return item;
    }

    async function recalcularPrecoItem(item, fetchFn, opcoes) {
        const precoOriginal = Number(item.preco_base != null ? item.preco_base : item.valor_unitario);
        const precoComercial = opcoes && opcoes.precoComercial != null
            ? Number(opcoes.precoComercial)
            : precoOriginal;

        if (!item || !itemElegivelAtacado(item)) {
            if (item && precoComercial !== Number(item.valor_unitario)) {
                item.valor_unitario = precoComercial;
                const Motor = carregarMotor();
                const qtd = Number(item.quantidade);
                item.subtotal = Motor
                    ? Motor.arredondarMoeda(precoComercial * qtd)
                    : Math.round(precoComercial * qtd * 100) / 100;
            }
            return { alterado: false, item, precoComercial };
        }
        const faixas = await buscarFaixasAtacado(item.produto_id, fetchFn, opcoes);
        const resultado = calcularPrecoAtacado({
            precoBase: precoComercial,
            precoOriginal,
            quantidade: item.quantidade,
            faixas
        });
        aplicarResultadoNoItem(item, resultado, precoOriginal);
        return { alterado: true, item, resultado, precoComercial };
    }

    function limparCacheFaixas(produtoId) {
        if (produtoId == null) {
            cacheFaixas.clear();
            return;
        }
        cacheFaixas.delete(Number(produtoId));
    }

    function somarDescontoAtacadoItens(itens) {
        const Motor = carregarMotor();
        const arred = Motor ? Motor.arredondarMoeda.bind(Motor) : function (n) {
            return Math.round(Number(n) * 100) / 100;
        };
        return arred((itens || []).reduce(function (acc, i) {
            return acc + Number(i && i.desconto_atacado || 0);
        }, 0));
    }

    return {
        urlFaixasAtacado,
        carregarMotor,
        itemElegivelAtacado,
        escolherFaixa,
        calcularPrecoAtacado,
        buscarFaixasAtacado,
        aplicarResultadoNoItem,
        recalcularPrecoItem,
        limparCacheFaixas,
        somarDescontoAtacadoItens
    };
});
