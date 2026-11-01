/**
 * Sprint 23 — inclusão sequencial de parcelas no PDV Express.
 * Autoriza cada parcela TEF uma vez e preserva as já aprovadas.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.PagamentoSequencial = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
    let parcelas = [];
    let composicao = null;
    let emCurso = false;
    let sequencia = 0;
    let sessaoPagamento = null;

    function arredondar(valor) {
        return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
    }

    function formaUsaTefPadrao(forma) {
        return formaExigeAutorizador(forma);
    }

    function formaExigeAutorizador(forma) {
        const f = String(forma || '').toLowerCase().trim();
        return ['cartao', 'cartao_credito', 'cartao_debito', 'credito', 'debito', 'pix', 'pix_tef', 'tef'].includes(f);
    }

    function classificarRetornoAutorizador(retorno) {
        if (!retorno) return 'erro';
        const status = String(retorno.status || '').toLowerCase();
        const codigo = String(retorno.codigo || '').toUpperCase();
        const tipoErro = String(retorno.tipo_erro || '').toLowerCase();
        if (codigo === 'TEF_JA_VINCULADO' || codigo === 'TEF_EMPRESA_DIVERGENTE') return 'recusado';
        if (codigo === 'TIMEOUT' || tipoErro === 'timeout' || status === 'timeout') return 'timeout';
        if (status === 'pendente' || status === 'pending' || status === 'processando') return 'pendente';
        const id = retorno.transacao_id || retorno.transacaoId;
        if ((retorno.aprovado === true || status === 'aprovado') && id) return 'aprovado';
        if (status === 'erro' || codigo === 'ERRO' || tipoErro === 'erro') return 'erro';
        if (
            retorno.aprovado === false
            || status === 'negado'
            || status === 'negada'
            || status === 'rejeitado'
            || status === 'rejeitada'
            || status === 'recusado'
            || status === 'recusada'
        ) return 'recusado';
        return 'erro';
    }

    function contaComoRecebido(parcela) {
        return String(parcela && parcela.status_autorizacao || '').toLowerCase() !== 'pendente';
    }

    function parcelaJaAutorizada(pagamento) {
        if (!pagamento) return false;
        const id = pagamento.tef_transacao_id || (pagamento.tef && pagamento.tef.transacao_id);
        const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
        return Boolean(id) && (status === 'aprovada' || status === 'aprovado' || pagamento.aprovado === true);
    }

    function soma() {
        return arredondar(parcelas.reduce((total, parcela) => (
            contaComoRecebido(parcela) ? total + Number(parcela.valor || 0) : total
        ), 0));
    }

    function assinatura() {
        return parcelas.map((parcela) => [
            parcela.local_id,
            parcela.forma_pagamento,
            Number(parcela.valor || 0).toFixed(2),
            parcela.tef_transacao_id || '',
            parcela.status_autorizacao || ''
        ].join(':')).join('|');
    }

    function snapshot() {
        return parcelas.map((parcela) => ({ ...parcela }));
    }

    function invalidarComposicao() {
        composicao = null;
    }

    function garantirSessaoPagamento() {
        if (!sessaoPagamento) {
            sessaoPagamento = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        }
        return sessaoPagamento;
    }

    function reset() {
        parcelas = [];
        composicao = null;
        emCurso = false;
        sequencia = 0;
        sessaoPagamento = null;
    }

    function exportar() {
        return snapshot()
            .filter((parcela) => contaComoRecebido(parcela))
            .map((parcela) => {
                const eletronica = formaExigeAutorizador(parcela.forma_pagamento);
                const linha = {
                    forma_pagamento: parcela.forma_pagamento,
                    valor: parcela.valor,
                    tef_transacao_id: parcela.tef_transacao_id || null,
                    nsu: eletronica ? (parcela.nsu || null) : null,
                    autorizacao: eletronica ? (parcela.autorizacao || null) : null,
                    status_autorizacao: parcela.status_autorizacao,
                    idempotency_key: parcela.idempotency_key || null,
                    tipo_recebimento: eletronica ? 'fiscal' : 'nao_fiscal',
                    confirmacao_manual: eletronica ? 0 : 1,
                    confirmacao_modalidade: eletronica ? 'tef' : 'manual'
                };
                if (eletronica) linha.aprovado = parcela.status_autorizacao === 'aprovada';
                return linha;
            });
    }

    function formaEhDinheiroLocal(forma) {
        const nome = String(forma || '').toLowerCase().trim();
        return nome === 'dinheiro' || nome === 'especie' || nome === 'cash';
    }

    function recomposicaoNecessaria() {
        return parcelas.some((parcela) => formaEhDinheiroLocal(parcela.forma_pagamento));
    }

    function autorizacaoDigitalPendente() {
        return parcelas.some((parcela) => {
            if (!formaExigeAutorizador(parcela.forma_pagamento)) return false;
            const status = String(parcela.status_autorizacao || '').toLowerCase();
            return status !== 'aprovada' && status !== 'aprovado';
        });
    }

    function composicaoValida() {
        if (recomposicaoNecessaria() && autorizacaoDigitalPendente()) return false;
        return Boolean(composicao && composicao.valida && composicao.assinatura === assinatura());
    }

    function registrarComposicao(resultado) {
        const atual = assinatura();
        if (!resultado || resultado.sucesso !== true) {
            invalidarComposicao();
            return { ok: false, codigo: 'COMPOSICAO_INVALIDA' };
        }
        composicao = {
            valida: true,
            assinatura: atual,
            resultado
        };
        return { ok: true, composicao };
    }

    async function adicionar(entrada = {}) {
        const forma = String(entrada.forma || entrada.forma_pagamento || '').toLowerCase().trim();
        const valor = arredondar(entrada.valor);
        const totalVenda = arredondar(entrada.totalVenda);
        const eletronica = formaExigeAutorizador(forma);
        const usaTef = eletronica || (typeof entrada.formaUsaTef === 'function'
            ? entrada.formaUsaTef(forma)
            : false);

        if (!forma) return { ok: false, codigo: 'FORMA_AUSENTE', parcelas: snapshot() };
        if (!(valor > 0)) return { ok: false, codigo: 'VALOR_INVALIDO', parcelas: snapshot() };
        if (valor - arredondar(totalVenda - soma()) > 0.009) {
            return { ok: false, codigo: 'VALOR_ACIMA_DO_RESTANTE', parcelas: snapshot() };
        }
        if (eletronica && typeof entrada.autorizarTef !== 'function') {
            return { ok: false, codigo: 'AUTORIZADOR_AUSENTE', parcelas: snapshot() };
        }
        if (usaTef && emCurso) {
            return { ok: false, codigo: 'AUTORIZACAO_EM_CURSO', parcelas: snapshot() };
        }

        const parcela = {
            local_id: ++sequencia,
            forma_pagamento: forma,
            valor,
            status_autorizacao: usaTef ? 'pendente' : 'informada',
            idempotency_key: usaTef
                ? `pdv-${garantirSessaoPagamento()}-${sequencia}-${forma}-${valor.toFixed(2)}`
                : null
        };

        if (usaTef) {
            emCurso = true;
            try {
                const retorno = await entrada.autorizarTef(forma, valor, parcela.idempotency_key);
                const tipo = classificarRetornoAutorizador(retorno);
                if (tipo === 'aprovado') {
                    parcela.tef_transacao_id = retorno.transacao_id || retorno.transacaoId;
                    parcela.nsu = retorno.nsu || null;
                    parcela.autorizacao = retorno.autorizacao || null;
                    parcela.status_autorizacao = 'aprovada';
                    parcela.aprovado = true;
                } else if (tipo === 'pendente') {
                    parcela.status_autorizacao = 'pendente';
                    parcela.aprovado = false;
                    parcelas.push(parcela);
                    invalidarComposicao();
                    return { ok: false, codigo: 'PENDENTE', parcela, parcelas: snapshot() };
                } else {
                    const codigos = { recusado: 'TEF_REJEITADO', timeout: 'TIMEOUT', erro: 'ERRO' };
                    return {
                        ok: false,
                        codigo: codigos[tipo] || 'ERRO',
                        mensagem: retorno && retorno.mensagem ? retorno.mensagem : null,
                        parcela: { ...parcela, status_autorizacao: tipo === 'recusado' ? 'rejeitada' : 'falha' },
                        parcelas: snapshot()
                    };
                }
            } catch (error) {
                return {
                    ok: false,
                    codigo: 'TEF_FALHA',
                    mensagem: error && error.message ? error.message : 'Falha de comunicação TEF.',
                    parcela: { ...parcela, status_autorizacao: 'falha' },
                    parcelas: snapshot()
                };
            } finally {
                emCurso = false;
            }
        }

        parcelas.push(parcela);
        invalidarComposicao();
        return { ok: true, parcela, parcelas: snapshot(), assinatura: assinatura() };
    }

    function cancelar(localId) {
        const parcela = parcelas.find((item) => item.local_id === localId);
        if (!parcela) return { ok: false, codigo: 'PARCELA_AUSENTE', parcelas: snapshot() };
        if (parcelaJaAutorizada(parcela)) {
            return { ok: false, codigo: 'PARCELA_TEF_APROVADA', parcelas: snapshot() };
        }
        parcelas = parcelas.filter((item) => item.local_id !== localId);
        invalidarComposicao();
        return { ok: true, parcelas: snapshot() };
    }

    function alterar(localId, novoValor) {
        const parcela = parcelas.find((item) => item.local_id === localId);
        if (!parcela) return { ok: false, codigo: 'PARCELA_AUSENTE', parcelas: snapshot() };
        if (parcelaJaAutorizada(parcela)) {
            return { ok: false, codigo: 'PARCELA_TEF_APROVADA', parcelas: snapshot() };
        }
        const valor = arredondar(novoValor);
        if (!(valor > 0)) return { ok: false, codigo: 'VALOR_INVALIDO', parcelas: snapshot() };
        parcela.valor = valor;
        parcela.status_autorizacao = 'informada';
        invalidarComposicao();
        return { ok: true, parcelas: snapshot(), assinatura: assinatura() };
    }

    async function autorizarParcelasPendentes(pagamentos, opcoes = {}) {
        const lista = Array.isArray(pagamentos) ? pagamentos : [];
        const formaUsaTef = opcoes.formaUsaTef || formaUsaTefPadrao;
        const tefHabilitado = opcoes.tefHabilitado !== false;
        const saida = [];
        for (const pagamento of lista) {
            const valor = Number(pagamento && pagamento.valor || 0);
            if (!(valor > 0)) continue;
            const forma = pagamento.forma_pagamento;
            if (String(pagamento.status_autorizacao || '').toLowerCase() === 'pendente') {
                continue;
            }
            if (!tefHabilitado || !formaUsaTef(forma) || parcelaJaAutorizada(pagamento)) {
                saida.push({ ...pagamento });
                continue;
            }
            if (emCurso) {
                const err = new Error('Já existe uma autorização TEF em andamento.');
                err.code = 'AUTORIZACAO_EM_CURSO';
                throw err;
            }
            emCurso = true;
            try {
                const retorno = await opcoes.autorizarTef(
                    forma,
                    valor,
                    pagamento.idempotency_key || null
                );
                const aprovado = classificarRetornoAutorizador(retorno) === 'aprovado';
                if (!aprovado) {
                    const err = new Error(`Pagamento TEF não aprovado para ${forma}.`);
                    err.code = 'TEF_REJEITADO';
                    throw err;
                }
                saida.push({
                    ...pagamento,
                    tef_transacao_id: retorno.transacao_id,
                    nsu: retorno.nsu,
                    autorizacao: retorno.autorizacao,
                    status_autorizacao: 'aprovada',
                    aprovado: true
                });
            } finally {
                emCurso = false;
            }
        }
        return saida;
    }

    return {
        adicionar,
        cancelar,
        alterar,
        exportar,
        reset,
        snapshot,
        soma,
        assinatura,
        invalidarComposicao,
        registrarComposicao,
        composicaoValida,
        recomposicaoNecessaria,
        autorizacaoDigitalPendente,
        composicaoAtual: () => composicao,
        parcelaJaAutorizada,
        formaExigeAutorizador,
        classificarRetornoAutorizador,
        autorizarParcelasPendentes,
        emAutorizacao: () => emCurso
    };
}));
