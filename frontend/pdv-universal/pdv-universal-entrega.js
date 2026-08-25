/**
 * Adaptador de entrega do PDV Universal (Sprint 05.34).
 * Reutiliza POST /api/vendas (tipo_venda ENTREGA) e GET /api/clientes.
 * Sem motor novo, sem rotas novas.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalEntrega = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MODALIDADES = Object.freeze({
        BALCAO: 'BALCAO',
        ENTREGA: 'ENTREGA'
    });

    function baseApi() {
        if (typeof globalThis.API_URL === 'string' && globalThis.API_URL) {
            return globalThis.API_URL.replace(/\/$/, '');
        }
        return '/api';
    }

    function urlVendas() {
        return `${baseApi()}/vendas`;
    }

    function urlClientes() {
        return `${baseApi()}/clientes?limit=200`;
    }

    function headersAuth() {
        const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
        try {
            const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : '';
            if (token) headers.Authorization = `Bearer ${token}`;
            const emp = typeof localStorage !== 'undefined' ? localStorage.getItem('cds_empresa_id') : '';
            if (emp) headers['X-Empresa-Id'] = emp;
        } catch (_e) { /* ignore */ }
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
        if (raw == null || raw === '') return 0;
        const s = String(raw).trim().replace(/\s/g, '').replace(',', '.');
        const n = Number(s);
        return Number.isFinite(n) ? n : NaN;
    }

    function formatarCep(valor) {
        const digits = String(valor || '').replace(/\D/g, '').slice(0, 8);
        if (digits.length <= 5) return digits;
        return `${digits.slice(0, 5)}-${digits.slice(5)}`;
    }

    function modoOperacao(contexto) {
        return (contexto && (contexto.modo_operacao || contexto.modo_operacao_venda)) || '';
    }

    function entregaDisponivelNoModo(contexto) {
        const modo = modoOperacao(contexto);
        if (modo === 'MULTIEMPRESA') {
            return {
                ok: false,
                code: 'ENTREGA_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADA',
                mensagem: 'ENTREGA_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADA'
            };
        }
        if (modo !== 'EMPRESA_UNICA') {
            return {
                ok: false,
                code: 'ENTREGA_MODO_INDISPONIVEL',
                mensagem: 'Entrega disponível somente em EMPRESA ÚNICA nesta sprint.'
            };
        }
        return { ok: true, code: null, mensagem: '' };
    }

    function montarItensPayload(itens) {
        return (itens || []).map(function (item) {
            return {
                produto_id: item.produto_id || item.id,
                quantidade: item.quantidade,
                quantidade_estoque: item.quantidade_estoque,
                preco_unitario: item.valor_unitario != null ? item.valor_unitario : item.preco_unitario,
                desconto_percentual: item.desconto_percentual || 0,
                desconto_valor: item.desconto_valor || 0,
                desconto_manual: Number(item.desconto_manual || 0) === 1 ? 1 : 0,
                subtotal: item.subtotal,
                tipo_venda: item.tipo_venda || item.tipoVenda,
                nome: item.descricao || item.nome
            };
        });
    }

    /**
     * Payload alinhado ao PDV legado (pdv-venda-entrega.js → POST /api/vendas).
     */
    function montarPayloadVendaEntrega(opcoes) {
        const o = opcoes || {};
        const form = o.form || {};
        const totais = o.totais || {};
        const taxa = parseValor(form.taxa_entrega);
        const taxaOk = Number.isFinite(taxa) && taxa >= 0 ? taxa : 0;
        const totalItens = Number(totais.total) || 0;
        const total = Number((totalItens + taxaOk).toFixed(2));
        const levaTroco = form.leva_troco === true || form.leva_troco === '1' || form.leva_troco === 1;
        const pagamentoPrevisto = String(form.pagamento_previsto || 'NAO_INFORMADO').toUpperCase();

        return comTerminal({
            tipo_venda: 'ENTREGA',
            emitir_fiscal: false,
            cliente_id: form.cliente_id || null,
            total,
            desconto: Number(totais.desconto_valor || o.desconto || 0) || 0,
            itens: montarItensPayload(o.itens),
            pagamento_previsto: pagamentoPrevisto,
            entregador: form.entregador || '',
            endereco_entrega: String(form.endereco_entrega || '').trim(),
            numero_entrega: form.numero_entrega || '',
            complemento_entrega: form.complemento_entrega || '',
            bairro_entrega: form.bairro_entrega || '',
            cidade_entrega: form.cidade_entrega || '',
            uf_entrega: String(form.uf_entrega || '').trim().toUpperCase(),
            cep_entrega: String(form.cep_entrega || '').replace(/\D/g, ''),
            referencia_entrega: form.referencia_entrega || '',
            observacao_entrega: form.observacao_entrega || '',
            telefone_entrega: form.telefone_entrega || '',
            taxa_entrega: taxaOk,
            leva_maquineta: form.leva_maquineta === true || form.leva_maquineta === '1' || form.leva_maquineta === 1,
            leva_troco: levaTroco,
            troco_para: levaTroco ? (parseValor(form.troco_para) || 0) : 0,
            forma_pagamento: pagamentoPrevisto.toLowerCase(),
            pagamentos: []
        });
    }

    function validarDadosEntrega(form) {
        const endereco = String(form && form.endereco_entrega || '').trim();
        if (!endereco) {
            return { ok: false, mensagem: 'Informe o endereço de entrega.' };
        }
        return { ok: true, mensagem: '' };
    }

    function enderecoDeCliente(cliente) {
        if (!cliente || typeof cliente !== 'object') return {};
        return {
            telefone_entrega: cliente.telefone || '',
            cep_entrega: formatarCep(cliente.cep),
            endereco_entrega: cliente.rua || cliente.endereco || '',
            numero_entrega: cliente.numero || '',
            complemento_entrega: cliente.complemento || '',
            bairro_entrega: cliente.bairro || '',
            cidade_entrega: cliente.cidade || '',
            uf_entrega: cliente.uf || ''
        };
    }

    async function listarClientes(fetchFn) {
        const fn = fetchFn || fetch;
        const res = await fn(urlClientes(), {
            method: 'GET',
            headers: headersAuth()
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || ('HTTP ' + res.status));
            err.code = 'CLIENTES_ERRO';
            throw err;
        }
        return Array.isArray(body) ? body : (body.clientes || body.items || []);
    }

    async function criarVendaEntrega(opcoes, fetchFn) {
        const o = opcoes || {};
        const val = validarDadosEntrega(o.form);
        if (!val.ok) {
            const err = new Error(val.mensagem);
            err.code = 'ENTREGA_DADOS_INVALIDOS';
            throw err;
        }
        if (!o.itens || !o.itens.length) {
            const err = new Error('Adicione itens ao carrinho antes de criar a entrega.');
            err.code = 'CARRINHO_VAZIO';
            throw err;
        }
        const payload = montarPayloadVendaEntrega(o);
        const fn = fetchFn || fetch;
        const res = await fn(urlVendas(), {
            method: 'POST',
            headers: headersAuth(),
            body: JSON.stringify(payload)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.error || body.message || ('HTTP ' + res.status));
            err.code = body.code || 'ENTREGA_ERRO';
            err.body = body;
            err.statusHttp = res.status;
            throw err;
        }
        return body;
    }

    return {
        MODALIDADES,
        urlVendas,
        urlClientes,
        entregaDisponivelNoModo,
        montarItensPayload,
        montarPayloadVendaEntrega,
        validarDadosEntrega,
        enderecoDeCliente,
        listarClientes,
        criarVendaEntrega,
        parseValor,
        formatarCep,
        obterTerminalId
    };
});
