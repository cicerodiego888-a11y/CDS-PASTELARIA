/**
 * Sprint 23 + CDS-PDV-CORRECAO-FLUXO-PAGAMENTOS-ELETRONICOS-01
 * Inclusão sequencial de parcelas. Separação: informada / pendente / confirmada.
 */
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.PagamentoSequencial = api;
}(typeof window !== 'undefined' ? window : globalThis, function (root) {
    let parcelas = [];
    let composicao = null;
    let emCurso = false;
    let sequencia = 0;
    let sessaoPagamento = null;

    function obterDecisao() {
        if (root && root.DecisaoConfirmacaoPagamento) return root.DecisaoConfirmacaoPagamento;
        try {
            return require('./decisaoConfirmacaoPagamento');
        } catch (_e) {
            return null;
        }
    }

    function arredondar(valor) {
        return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
    }

    function formaExigeAutorizador(forma) {
        const decisao = obterDecisao();
        if (decisao && typeof decisao.formaExigeAutorizadorExterno === 'function') {
            return decisao.formaExigeAutorizadorExterno(forma);
        }
        const f = String(forma || '').toLowerCase().trim();
        return ['cartao', 'cartao_credito', 'cartao_debito', 'credito', 'debito', 'pix', 'pix_tef', 'tef'].includes(f);
    }

    function formaUsaTefPadrao(forma) {
        return formaExigeAutorizador(forma);
    }

    function formaEhDinheiroLocal(forma) {
        const decisao = obterDecisao();
        if (decisao && typeof decisao.formaEhDinheiro === 'function') {
            return decisao.formaEhDinheiro(forma);
        }
        const nome = String(forma || '').toLowerCase().trim();
        return nome === 'dinheiro' || nome === 'especie' || nome === 'cash';
    }

    function classificarRetornoAutorizador(retorno) {
        if (!retorno) return 'erro';
        const status = String(retorno.status || '').toLowerCase();
        const codigo = String(retorno.codigo || '').toUpperCase();
        const tipoErro = String(retorno.tipo_erro || '').toLowerCase();
        if (codigo === 'TEF_DESABILITADO') return 'tef_desabilitado';
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

    /** Aloca valor no saldo da venda (inclui PIX informado). Não implica recebimento confirmado. */
    function alocaSaldo(parcela) {
        const decisao = obterDecisao();
        if (decisao && typeof decisao.parcelaAlocaSaldo === 'function') {
            return decisao.parcelaAlocaSaldo(parcela);
        }
        return String(parcela && parcela.status_autorizacao || '').toLowerCase() !== 'pendente';
    }

    /** Recebimento efetivamente comprovado. */
    function contaComoRecebido(parcela) {
        const decisao = obterDecisao();
        if (decisao && typeof decisao.parcelaRecebimentoConfirmado === 'function') {
            return decisao.parcelaRecebimentoConfirmado(parcela);
        }
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
            alocaSaldo(parcela) ? total + Number(parcela.valor || 0) : total
        ), 0));
    }

    function somaConfirmada() {
        return arredondar(parcelas.reduce((total, parcela) => (
            contaComoRecebido(parcela) ? total + Number(parcela.valor || 0) : total
        ), 0));
    }

    function temEletronicaAguardandoConfirmacao() {
        return parcelas.some((parcela) => {
            if (!formaExigeAutorizador(parcela.forma_pagamento)) return false;
            return alocaSaldo(parcela) && !contaComoRecebido(parcela);
        });
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

    function reidratar(estado) {
        const lista = estado && Array.isArray(estado.parcelas) ? estado.parcelas : [];
        parcelas = lista.map((parcela) => ({ ...parcela }));
        sequencia = parcelas.reduce((maior, parcela) => Math.max(maior, Number(parcela.local_id) || 0), 0);
        sessaoPagamento = estado && estado.sessaoPagamento ? String(estado.sessaoPagamento) : null;
        composicao = estado && estado.composicao ? estado.composicao : null;
        emCurso = false;
        return snapshot();
    }

    function exportar() {
        return snapshot()
            .filter((parcela) => alocaSaldo(parcela))
            .map((parcela) => {
                const eletronica = formaExigeAutorizador(parcela.forma_pagamento);
                const viaTef = Boolean(parcela.tef_transacao_id);
                const confirmada = contaComoRecebido(parcela);
                const dinheiro = formaEhDinheiroLocal(parcela.forma_pagamento);
                const viaPix = Boolean(parcela.pix_confirmado && parcela.pix_txid);
                const linha = {
                    forma_pagamento: parcela.forma_pagamento,
                    valor: parcela.valor,
                    tef_transacao_id: parcela.tef_transacao_id || null,
                    nsu: viaTef ? (parcela.nsu || null) : null,
                    autorizacao: viaTef ? (parcela.autorizacao || null) : null,
                    status_autorizacao: parcela.status_autorizacao,
                    idempotency_key: parcela.idempotency_key || null,
                    local_id: parcela.local_id,
                    sessao_pagamento: sessaoPagamento || null,
                    chave_parcela: parcela.chave_parcela || null,
                    tipo_recebimento: eletronica || !dinheiro ? (eletronica ? 'fiscal' : 'nao_fiscal') : 'nao_fiscal',
                    recebimento_confirmado: confirmada,
                    // Não carimba manual em eletrônico informado — confirmação vem no fechamento.
                    confirmacao_manual: dinheiro && confirmada ? 1 : 0,
                    confirmacao_modalidade: viaTef
                        ? 'tef'
                        : (viaPix ? 'pix' : (dinheiro ? 'manual' : null))
                };
                if (eletronica && !dinheiro) {
                    linha.tipo_recebimento = 'fiscal';
                }
                if (viaTef) linha.aprovado = parcela.status_autorizacao === 'aprovada';
                if (viaPix) {
                    linha.pix_txid = parcela.pix_txid;
                    linha.pix_confirmado = true;
                    linha.confirmacao_efetiva = true;
                    linha.aprovado = true;
                }
                if (dinheiro) {
                    linha.valor_entregue = parcela.valor_entregue != null
                        ? parcela.valor_entregue
                        : parcela.valor;
                    linha.troco = parcela.troco != null ? parcela.troco : 0;
                }
                return linha;
            });
    }

    /**
     * Confirma parcela PIX com evidência (txid persistido). Idempotente no mesmo txid.
     */
    function confirmarParcelaPix(entrada = {}) {
        const localId = Number(entrada.localId != null ? entrada.localId : entrada.local_id);
        const txid = String(entrada.txid || entrada.pix_txid || '').trim();
        const valor = entrada.valor != null ? arredondar(entrada.valor) : null;
        if (!(localId > 0)) return { ok: false, codigo: 'PARCELA_AUSENTE', parcelas: snapshot() };
        if (!txid) return { ok: false, codigo: 'PIX_TXID_AUSENTE', parcelas: snapshot() };
        const parcela = parcelas.find((item) => Number(item.local_id) === localId);
        if (!parcela) return { ok: false, codigo: 'PARCELA_AUSENTE', parcelas: snapshot() };
        const forma = String(parcela.forma_pagamento || '').toLowerCase();
        if (forma !== 'pix' && forma !== 'pix_tef') {
            return { ok: false, codigo: 'FORMA_NAO_PIX', parcelas: snapshot() };
        }
        if (valor != null && Math.abs(Number(parcela.valor) - valor) > 0.009) {
            return { ok: false, codigo: 'PIX_VALOR_DIVERGENTE', parcelas: snapshot() };
        }
        if (parcela.pix_confirmado === true && parcela.pix_txid) {
            if (String(parcela.pix_txid) === txid) {
                return { ok: true, parcela, parcelas: snapshot(), idempotente: true };
            }
            return { ok: false, codigo: 'PIX_JA_CONFIRMADO', parcelas: snapshot() };
        }
        const sessao = garantirSessaoPagamento();
        parcela.pix_txid = txid;
        parcela.pix_confirmado = true;
        parcela.confirmacao_efetiva = true;
        parcela.status_autorizacao = 'aprovada';
        parcela.aprovado = true;
        parcela.requer_confirmacao_posterior = false;
        parcela.chave_parcela = parcela.chave_parcela
            || `${sessao}:${parcela.local_id}:${Number(parcela.valor).toFixed(2)}`;
        invalidarComposicao();
        return { ok: true, parcela, parcelas: snapshot(), idempotente: false };
    }

    function recomposicaoNecessaria() {
        return parcelas.some((parcela) => formaEhDinheiroLocal(parcela.forma_pagamento));
    }

    function autorizacaoDigitalPendente() {
        return parcelas.some((parcela) => {
            if (!formaExigeAutorizador(parcela.forma_pagamento)) return false;
            const status = String(parcela.status_autorizacao || '').toLowerCase();
            if (status === 'pendente') return true;
            // Informada sem TEF: aguarda confirmação posterior, não bloqueia composição dinheiro.
            if (!parcela.tef_transacao_id && status === 'informada') return false;
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
        const decisaoApi = obterDecisao();
        const politica = decisaoApi && typeof decisaoApi.resolverRegistroParcela === 'function'
            ? decisaoApi.resolverRegistroParcela({
                forma,
                tefHabilitado: entrada.tefHabilitado,
                pixIntegracaoHabilitada: entrada.pixIntegracaoHabilitada
            })
            : null;

        const eletronica = formaExigeAutorizador(forma);
        let usaTef;
        if (typeof entrada.formaUsaTef === 'function') {
            usaTef = Boolean(entrada.formaUsaTef(forma));
        } else if (politica && typeof politica.usaTef === 'boolean') {
            usaTef = politica.usaTef;
        } else {
            usaTef = eletronica;
        }

        // Bloqueio de política (ex.: cartão sem TEF) só vale se o chamador não forçou TEF.
        if (politica && politica.ok === false && !usaTef) {
            return {
                ok: false,
                codigo: politica.codigo || 'FORMA_BLOQUEADA',
                mensagem: politica.mensagem || null,
                parcelas: snapshot()
            };
        }

        if (!forma) return { ok: false, codigo: 'FORMA_AUSENTE', parcelas: snapshot() };
        if (!(valor > 0)) return { ok: false, codigo: 'VALOR_INVALIDO', parcelas: snapshot() };
        const restante = arredondar(totalVenda - soma());
        let valorAplicado = valor;
        let valorEntregue = valor;
        let troco = 0;
        if (formaEhDinheiroLocal(forma)) {
            const entregueC = Math.round((valor + Number.EPSILON) * 100);
            const restanteC = Math.round((restante + Number.EPSILON) * 100);
            if (restanteC <= 0 || entregueC <= 0) {
                return { ok: false, codigo: 'VALOR_ACIMA_DO_RESTANTE', parcelas: snapshot() };
            }
            const aplicadoC = Math.min(entregueC, restanteC);
            valorAplicado = aplicadoC / 100;
            valorEntregue = entregueC / 100;
            troco = (entregueC - aplicadoC) / 100;
        } else if (valor - restante > 0.009) {
            return { ok: false, codigo: 'VALOR_ACIMA_DO_RESTANTE', parcelas: snapshot() };
        }
        if (usaTef && typeof entrada.autorizarTef !== 'function') {
            return { ok: false, codigo: 'AUTORIZADOR_AUSENTE', parcelas: snapshot() };
        }
        if (usaTef && emCurso) {
            return { ok: false, codigo: 'AUTORIZACAO_EM_CURSO', parcelas: snapshot() };
        }

        const sessao = garantirSessaoPagamento();
        const localId = ++sequencia;
        const parcela = {
            local_id: localId,
            forma_pagamento: forma,
            valor: valorAplicado,
            valor_entregue: formaEhDinheiroLocal(forma) ? valorEntregue : valorAplicado,
            troco: formaEhDinheiroLocal(forma) ? troco : 0,
            status_autorizacao: usaTef ? 'pendente' : (politica && politica.statusInicial) || 'informada',
            idempotency_key: usaTef
                ? `pdv-${sessao}-${localId}-${forma}-${valorAplicado.toFixed(2)}`
                : null,
            sessao_pagamento: sessao,
            chave_parcela: `${sessao}:${localId}:${valorAplicado.toFixed(2)}`,
            requer_confirmacao_posterior: Boolean(politica && politica.requerConfirmacaoPosterior)
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
                    parcela.requer_confirmacao_posterior = false;
                } else if (tipo === 'pendente') {
                    parcela.status_autorizacao = 'pendente';
                    parcela.aprovado = false;
                    parcelas.push(parcela);
                    invalidarComposicao();
                    return { ok: false, codigo: 'PENDENTE', parcela, parcelas: snapshot() };
                } else {
                    const codigos = {
                        recusado: 'TEF_REJEITADO',
                        timeout: 'TIMEOUT',
                        erro: 'ERRO',
                        tef_desabilitado: 'TEF_DESABILITADO'
                    };
                    return {
                        ok: false,
                        codigo: codigos[tipo] || 'ERRO',
                        mensagem: retorno && retorno.mensagem ? retorno.mensagem : null,
                        parcela: {
                            ...parcela,
                            status_autorizacao: tipo === 'recusado' ? 'rejeitada' : 'falha'
                        },
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
        return {
            ok: true,
            parcela,
            parcelas: snapshot(),
            assinatura: assinatura(),
            mensagem: politica && politica.mensagem ? politica.mensagem : null
        };
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
        reidratar,
        snapshot,
        soma,
        somaConfirmada,
        alocaSaldo,
        contaComoRecebido,
        temEletronicaAguardandoConfirmacao,
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
        confirmarParcelaPix,
        sessaoPagamento: () => sessaoPagamento,
        emAutorizacao: () => emCurso
    };
}));
