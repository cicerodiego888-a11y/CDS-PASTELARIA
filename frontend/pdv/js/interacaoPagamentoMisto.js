/**
 * Sprint 25 — sequência da tela de pagamento misto.
 * A forma é escolhida primeiro. O valor daquela forma só aparece depois.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.InteracaoPagamentoMisto = api;
}(typeof window !== 'undefined' ? window : globalThis, function (root) {
    function arredondar(valor) {
        return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
    }

    function criar(opcoes) {
        const totalVenda = arredondar(opcoes.totalVenda);
        const sequencial = opcoes.sequencial;
        let etapa = 'forma';
        let formaEscolhida = '';

        function restante() {
            return arredondar(totalVenda - sequencial.soma());
        }

        function visao() {
            const falta = restante();
            const parcelas = sequencial.snapshot();
            return {
                etapa,
                formaEscolhida,
                solicitarValor: etapa === 'valor',
                mostrarEscolhaForma: etapa === 'forma' && falta > 0.009,
                restante: falta,
                informado: sequencial.soma(),
                parcelas,
                podeFinalizar: falta <= 0.009 && parcelas.length > 0
            };
        }

        function escolherForma(forma) {
            const nome = String(forma || '').toLowerCase().trim();
            if (!nome) return { ok: false, codigo: 'FORMA_AUSENTE', ...visao() };
            if (restante() <= 0.009) return { ok: false, codigo: 'VENDA_QUITADA', ...visao() };
            formaEscolhida = nome;
            etapa = 'valor';
            return { ok: true, ...visao() };
        }

        function cancelarValor() {
            formaEscolhida = '';
            etapa = 'forma';
            return { ok: true, ...visao() };
        }

        async function confirmarValor(valor, autorizacao) {
            if (etapa !== 'valor' || !formaEscolhida) {
                return { ok: false, codigo: 'VALOR_SEM_FORMA', ...visao() };
            }
            const resultado = await sequencial.adicionar({
                forma: formaEscolhida,
                valor,
                totalVenda,
                tefHabilitado: autorizacao && autorizacao.tefHabilitado,
                pixIntegracaoHabilitada: autorizacao && autorizacao.pixIntegracaoHabilitada,
                formaUsaTef: autorizacao && autorizacao.formaUsaTef,
                autorizarTef: autorizacao && autorizacao.autorizarTef
            });
            if (!resultado.ok) {
                return {
                    ok: false,
                    codigo: resultado.codigo,
                    mensagem: resultado.mensagem,
                    parcela: resultado.parcela,
                    ...visao()
                };
            }
            formaEscolhida = '';
            etapa = 'forma';
            return {
                ok: true,
                parcela: resultado.parcela,
                mensagem: resultado.mensagem || null,
                ...visao()
            };
        }

        return { visao, escolherForma, confirmarValor, cancelarValor };
    }

    function modoConfirmacaoDireta(forma, contexto = {}) {
        const decisao = (typeof root !== 'undefined' && root.DecisaoConfirmacaoPagamento)
            || (typeof globalThis !== 'undefined' && globalThis.DecisaoConfirmacaoPagamento)
            || null;
        if (decisao && typeof decisao.modoConfirmacaoDireta === 'function') {
            return decisao.modoConfirmacaoDireta(forma, contexto);
        }
        const nome = String(forma || '').toLowerCase().trim();
        if (nome === 'dinheiro' || nome === 'especie' || nome === 'cash') return 'manual';
        if (['cartao', 'cartao_credito', 'cartao_debito', 'credito', 'debito', 'tef'].includes(nome)) {
            return contexto.tefHabilitado === true ? 'tef' : 'informado';
        }
        if (nome === 'pix' || nome === 'pix_tef') {
            if (contexto.tefHabilitado === true) return 'tef';
            if (contexto.pixIntegracaoHabilitada === true) return 'pix_proprio';
            return 'informado';
        }
        return 'manual';
    }

    function decidirAtalhoPagamentoPdv(tecla, estado) {
        const key = String(tecla || '');
        if (!estado || !estado.modalPagamentoAberto) return { acao: 'ignorar' };
        if (estado.modalValorAberto) {
            if (key === 'Escape') return { acao: 'cancelar_valor' };
            if (key === 'Enter') return { acao: 'confirmar_valor' };
            return { acao: 'digitar' };
        }
        if (estado.campoFocado) return { acao: 'digitar' };
        const atalhos = {
            '1': 'dinheiro',
            '2': 'pix',
            '3': 'cartao_debito',
            '4': 'cartao_credito',
            '5': 'misto',
            '6': 'prazo'
        };
        if (atalhos[key]) return { acao: 'selecionar', forma: atalhos[key] };
        if (key === 'Escape') return { acao: 'fechar_pagamento' };
        return { acao: 'ignorar' };
    }

    return { criar, modoConfirmacaoDireta, decidirAtalhoPagamentoPdv };
}));
