/**
 * Adaptador de promoção comercial — PDV Universal (Sprint 05.36).
 * Consulta GET /api/produtos/:id/promocao-ativa (mesmo contrato do PDV legado pdv.js).
 * Não duplica regras de vigência — a API filtra status e período.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalPromocao = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const cachePromocao = new Map();

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlPromocaoAtiva(produtoId) {
        return `${baseApi()}/produtos/${Number(produtoId)}/promocao-ativa`;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
        } catch (_e) { /* ignore */ }
        return headers;
    }

    function arredondarMoeda(valor) {
        if (typeof globalThis !== 'undefined' && globalThis.MotorPrecoAtacado) {
            return globalThis.MotorPrecoAtacado.arredondarMoeda(valor);
        }
        return Math.round(Number(valor) * 100) / 100;
    }

    /**
     * Mesma exclusão do PDV legado: sem promoção em venda por unidade ou etiqueta de balança.
     */
    function itemElegivelPromocao(item) {
        if (!item) return false;
        const origem = String(item.origem_quantidade || '').toUpperCase();
        if (origem.indexOf('ETIQUETA') === 0) return false;
        const tipo = String(item.tipo_venda || '').toUpperCase();
        if (tipo === 'UNIDADE' || tipo === 'UN') return false;
        return true;
    }

    /**
     * Cálculo puro — recebe promoção já validada pela API (ou null).
     */
    function calcularPrecoPromocional(opcoes) {
        const o = opcoes || {};
        const precoBase = Number(o.precoBase);
        const quantidade = Number(o.quantidade);
        const promocao = o.promocao;
        const padrao = {
            precoUnitario: precoBase,
            descontoPromocao: 0,
            promocao_id: null,
            temPromocao: false,
            tipo_preco: 'varejo'
        };
        if (!o.elegivel || !Number.isFinite(precoBase) || precoBase <= 0) return padrao;
        if (!Number.isFinite(quantidade) || quantidade <= 0) return padrao;
        if (!promocao || typeof promocao !== 'object') return padrao;

        const precoPromo = Number(promocao.preco_promocional || 0);
        if (precoPromo <= 0 || precoPromo >= precoBase) {
            return Object.assign({}, padrao, {
                promocao_id: promocao.id || null
            });
        }

        const descontoPromocao = arredondarMoeda((precoBase - precoPromo) * quantidade);
        return {
            precoUnitario: precoPromo,
            descontoPromocao,
            promocao_id: promocao.id || null,
            temPromocao: true,
            tipo_preco: 'promocao'
        };
    }

    async function buscarPromocaoAtiva(produtoId, fetchFn, opcoes) {
        const id = Number(produtoId);
        if (!Number.isInteger(id) || id <= 0) return null;
        const force = opcoes && opcoes.forceRefresh;
        if (!force && cachePromocao.has(id)) return cachePromocao.get(id);

        const fn = fetchFn || fetch;
        try {
            const res = await fn(urlPromocaoAtiva(id), {
                method: 'GET',
                headers: headersAuth()
            });
            if (!res.ok) {
                cachePromocao.set(id, null);
                return null;
            }
            const body = await res.json().catch(() => null);
            const promocao = body && typeof body === 'object' && body.id != null ? body : null;
            cachePromocao.set(id, promocao);
            return promocao;
        } catch (_e) {
            cachePromocao.set(id, null);
            return null;
        }
    }

    function aplicarCamposPromocaoNoItem(item, resultado) {
        if (!item) return item;
        const r = resultado || {};
        item.promocao_id = r.promocao_id || null;
        item.desconto_promocao = Number(r.descontoPromocao || 0);
        if (r.temPromocao && !item.desconto_atacado) {
            item.tipo_preco = r.tipo_preco || 'promocao';
        }
        return item;
    }

    function limparCamposPromocaoNoItem(item) {
        if (!item) return item;
        item.promocao_id = null;
        item.desconto_promocao = 0;
        if (item.tipo_preco === 'promocao') item.tipo_preco = 'varejo';
        return item;
    }

    async function recalcularPromocaoItem(item, fetchFn, opcoes) {
        if (!item) {
            return { alterado: false, precoComercial: 0, resultado: null };
        }
        const precoBase = Number(item.preco_base != null ? item.preco_base : item.valor_unitario);
        if (!itemElegivelPromocao(item)) {
            limparCamposPromocaoNoItem(item);
            return {
                alterado: false,
                precoComercial: precoBase,
                resultado: calcularPrecoPromocional({ precoBase, quantidade: item.quantidade, elegivel: false })
            };
        }
        const promocao = await buscarPromocaoAtiva(item.produto_id, fetchFn, opcoes);
        const resultado = calcularPrecoPromocional({
            precoBase,
            quantidade: item.quantidade,
            promocao,
            elegivel: true
        });
        aplicarCamposPromocaoNoItem(item, resultado);
        return { alterado: true, precoComercial: resultado.precoUnitario, resultado };
    }

    function limparCachePromocao(produtoId) {
        if (produtoId == null) {
            cachePromocao.clear();
            return;
        }
        cachePromocao.delete(Number(produtoId));
    }

    function somarDescontoPromocaoItens(itens) {
        return arredondarMoeda((itens || []).reduce(function (acc, i) {
            return acc + Number(i && i.desconto_promocao || 0);
        }, 0));
    }

    return {
        urlPromocaoAtiva,
        itemElegivelPromocao,
        calcularPrecoPromocional,
        buscarPromocaoAtiva,
        aplicarCamposPromocaoNoItem,
        limparCamposPromocaoNoItem,
        recalcularPromocaoItem,
        limparCachePromocao,
        somarDescontoPromocaoItens
    };
});
