/**
 * Sessão visual do PDV Universal (Sprint 05.10).
 * Sem regra de estoque, rateio, pagamento ou fiscal.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PdvUniversalSession = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ESTADOS = Object.freeze({
        INICIAL: 'INICIAL',
        CARRINHO_ATIVO: 'CARRINHO_ATIVO',
        CHECKOUT_PROCESSANDO: 'CHECKOUT_PROCESSANDO',
        ATENDIMENTO_VALIDADO: 'ATENDIMENTO_VALIDADO',
        RESERVA_PROCESSANDO: 'RESERVA_PROCESSANDO',
        ATENDIMENTO_RESERVADO: 'ATENDIMENTO_RESERVADO',
        PAGAMENTO_PROCESSANDO: 'PAGAMENTO_PROCESSANDO',
        ATENDIMENTO_PAGO: 'ATENDIMENTO_PAGO',
        MATERIALIZACAO_PROCESSANDO: 'MATERIALIZACAO_PROCESSANDO',
        FISCALIZACAO_PROCESSANDO: 'FISCALIZACAO_PROCESSANDO',
        COMPROVANTE_DISPONIVEL: 'COMPROVANTE_DISPONIVEL',
        ERRO_RECUPERAVEL: 'ERRO_RECUPERAVEL'
    });

    const ACOES = Object.freeze({
        CHECKOUT: 'CHECKOUT',
        RESERVAR: 'RESERVAR',
        PAGAR: 'PAGAR',
        MATERIALIZAR: 'MATERIALIZAR',
        FISCALIZAR: 'FISCALIZAR',
        CANCELAR: 'CANCELAR',
        NOVO: 'NOVO'
    });

    const SEGURO_POR_ERRO = Object.freeze({
        CHECKOUT: ESTADOS.CARRINHO_ATIVO,
        RESERVAR: ESTADOS.ATENDIMENTO_VALIDADO,
        PAGAR: ESTADOS.ATENDIMENTO_RESERVADO,
        MATERIALIZAR: ESTADOS.ATENDIMENTO_PAGO,
        FISCALIZAR: ESTADOS.ATENDIMENTO_PAGO
    });

    function criarSessao() {
        return {
            estado: ESTADOS.INICIAL,
            estado_seguro: ESTADOS.INICIAL,
            lock: null,
            atendimento_id: null,
            codigo: null,
            status: null,
            empresa_operacional_persistida: null
        };
    }

    function emProcessamento(sessao) {
        return !!(sessao && sessao.lock);
    }

    function adquirir(sessao, acao) {
        if (!sessao) return false;
        if (sessao.lock) return false;
        sessao.lock = acao;
        if (acao === ACOES.CHECKOUT) sessao.estado = ESTADOS.CHECKOUT_PROCESSANDO;
        if (acao === ACOES.RESERVAR) sessao.estado = ESTADOS.RESERVA_PROCESSANDO;
        if (acao === ACOES.PAGAR) sessao.estado = ESTADOS.PAGAMENTO_PROCESSANDO;
        if (acao === ACOES.MATERIALIZAR) sessao.estado = ESTADOS.MATERIALIZACAO_PROCESSANDO;
        if (acao === ACOES.FISCALIZAR) sessao.estado = ESTADOS.FISCALIZACAO_PROCESSANDO;
        return true;
    }

    function liberar(sessao) {
        if (sessao) sessao.lock = null;
    }

    function marcarSeguro(sessao, estado, extra) {
        if (!sessao) return sessao;
        sessao.estado = estado;
        sessao.estado_seguro = estado;
        if (extra) {
            if (extra.atendimento_id != null) sessao.atendimento_id = extra.atendimento_id;
            if (extra.codigo != null) sessao.codigo = extra.codigo;
            if (extra.status != null) sessao.status = extra.status;
        }
        return sessao;
    }

    function recuperarErro(sessao, acao) {
        const seguro = (SEGURO_POR_ERRO[acao] || (sessao && sessao.estado_seguro) || ESTADOS.INICIAL);
        if (sessao) {
            sessao.lock = null;
            sessao.estado = ESTADOS.ERRO_RECUPERAVEL;
            sessao.estado_seguro = seguro;
        }
        return seguro;
    }

    function fecharModalPreservaDominio(sessao) {
        return {
            atendimento_id: sessao && sessao.atendimento_id,
            estado_seguro: sessao && sessao.estado_seguro,
            status: sessao && sessao.status
        };
    }

    function atalhoPermitido(sessao) {
        return !emProcessamento(sessao);
    }

    function resetarSessaoPDVUniversal(sessao, opts) {
        const persistida = opts && opts.empresa_operacional_persistida != null
            ? opts.empresa_operacional_persistida
            : (sessao && sessao.empresa_operacional_persistida);
        const limpa = criarSessao();
        limpa.empresa_operacional_persistida = persistida;
        limpa.estado = ESTADOS.INICIAL;
        limpa.estado_seguro = ESTADOS.INICIAL;
        return limpa;
    }

    function nuncaCaiNoLegado(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        return !caps.checkout_empresa_unica && !!caps.checkout_multiempresa;
    }

    function nuncaUsaMuvPagamento(contexto) {
        const caps = (contexto && contexto.capacidades) || {};
        return !!caps.checkout_empresa_unica && !caps.checkout_multiempresa;
    }

    return {
        ESTADOS,
        ACOES,
        SEGURO_POR_ERRO,
        criarSessao,
        emProcessamento,
        adquirir,
        liberar,
        marcarSeguro,
        recuperarErro,
        fecharModalPreservaDominio,
        atalhoPermitido,
        resetarSessaoPDVUniversal,
        nuncaCaiNoLegado,
        nuncaUsaMuvPagamento
    };
});
