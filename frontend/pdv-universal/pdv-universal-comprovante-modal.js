/**
 * Preview e preparação de impressão do PDV Universal (Sprint 05.09).
 * Consome GET pdv-universal/comprovante e POST /atendimentos/:id/imprimir.
 * Sem window.print automático. Sem montar totais/NFC-e.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PDVUniversalComprovanteModal = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const ESTADOS = Object.freeze({
        LOADING: 'LOADING',
        ERROR: 'ERROR',
        READY: 'READY'
    });

    function pos() {
        return (root && root.PdvUniversalPosPagamento)
            || (typeof require === 'function' ? require('./pdv-universal-pos-pagamento.js') : null);
    }

    function printClient() {
        return (root && root.MuvComprovanteClient)
            || (typeof require === 'function' ? require('../shared/js/muv-comprovante-client.js') : null);
    }

    function podePreview(contexto) {
        return !!((contexto && contexto.capacidades || {}).pode_visualizar_comprovante);
    }

    function podePrepararImpressao(contexto) {
        return !!((contexto && contexto.capacidades || {}).pode_preparar_impressao);
    }

    function podeNovoAtendimento(contexto) {
        return !!((contexto && contexto.capacidades || {}).pode_iniciar_novo_atendimento);
    }

    function fiscalNaoBloqueia(status) {
        const s = String(status || '').toUpperCase();
        return s === 'FISCALIZADO' || s === 'FISCAL_PARCIAL' || s === 'FISCAL_ERRO' || s === 'CONCLUIDO';
    }

    function estadoInicial() {
        return { estado: ESTADOS.LOADING, html: '', erro: null, impressao: null };
    }

    async function carregarPreview(atendimentoId, fetchFn) {
        const p = pos();
        if (!p) {
            const err = new Error('POS_PAGAMENTO_INDISPONIVEL');
            err.code = 'POS_PAGAMENTO_INDISPONIVEL';
            throw err;
        }
        const html = await p.obterComprovanteHtml(atendimentoId, fetchFn);
        return { estado: ESTADOS.READY, html, erro: null };
    }

    async function prepararImpressao(atendimentoId, fetchFn) {
        const c = printClient();
        if (!c) {
            const err = new Error('ERRO_PREPARAR_IMPRESSAO');
            err.code = 'ERRO_PREPARAR_IMPRESSAO';
            throw err;
        }
        return c.prepararImpressaoBrowser(atendimentoId, fetchFn, 40);
    }

    function estadoNovoAtendimento() {
        return {
            sessao: null,
            pagamentos: [],
            locks: false,
            carrinho_limpo: true
        };
    }

    return {
        ESTADOS,
        podePreview,
        podePrepararImpressao,
        podeNovoAtendimento,
        fiscalNaoBloqueia,
        estadoInicial,
        carregarPreview,
        prepararImpressao,
        estadoNovoAtendimento
    };
});
