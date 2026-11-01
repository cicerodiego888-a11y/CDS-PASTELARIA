/**
 * Sprint 25 — sequência da tela de pagamento misto.
 * A forma é escolhida primeiro. O valor daquela forma só aparece depois.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.InteracaoPagamentoMisto = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
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
            return { ok: true, parcela: resultado.parcela, ...visao() };
        }

        return { visao, escolherForma, confirmarValor, cancelarValor };
    }

    function modoConfirmacaoDireta(forma) {
        const nome = String(forma || '').toLowerCase().trim();
        if (nome === 'dinheiro') return 'manual';
        if (['cartao', 'cartao_credito', 'cartao_debito', 'credito', 'debito', 'pix', 'pix_tef', 'tef'].includes(nome)) {
            return 'tef';
        }
        return 'manual';
    }

    return { criar, modoConfirmacaoDireta };
}));
