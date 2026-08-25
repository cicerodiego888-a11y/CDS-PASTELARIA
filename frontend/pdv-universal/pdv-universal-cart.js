/**
 * Carrinho operacional do PDV Universal (Sprint 05.04).
 * Preview visual. Sem venda, reserva, pagamento ou atendimento.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PDVUniversalCart = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function erroCart(code, message) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    function arred2(n) {
        return Math.round(Number(n) * 100) / 100;
    }

    /** Precisão de quantidade por peso: até 3 casas (sem novo motor financeiro). */
    function arredQtd3(n) {
        return Math.round(Number(n) * 1000) / 1000;
    }

    function chaveItem(produtoId, empresaId) {
        return `${Number(produtoId)}:${Number(empresaId)}`;
    }

    /**
     * Regra oficial do cadastro/consulta-pdv (normalizarProdutoResposta):
     * produto_fracionado === produto_pesavel === vendido_por_peso.
     */
    function produtoVendidoPorPeso(fonte) {
        if (!fonte || typeof fonte !== 'object') return false;
        return Number(
            fonte.produto_fracionado ?? fonte.produto_pesavel ?? fonte.vendido_por_peso ?? 0
        ) === 1;
    }

    function flagFracionadoDeEntrada(entrada) {
        return produtoVendidoPorPeso(entrada) ? 1 : 0;
    }

    function formatarQuantidadeUi(qtd, porPeso) {
        const n = Number(qtd);
        if (!Number.isFinite(n) || n <= 0) return porPeso ? '0,000' : '1';
        if (!porPeso) return String(Math.trunc(n));
        return arredQtd3(n).toFixed(3).replace('.', ',');
    }

    function validarQuantidade(qtd, permiteDecimal) {
        const n = Number(qtd);
        if (!Number.isFinite(n) || n <= 0) {
            throw erroCart('QUANTIDADE_INVALIDA', 'Quantidade deve ser maior que zero.');
        }
        if (!permiteDecimal) {
            if (Math.abs(n - Math.round(n)) > 1e-9) {
                throw erroCart('QUANTIDADE_INVALIDA', 'Produto por unidade aceita somente quantidade inteira.');
            }
            return Math.round(n);
        }
        const arred = arredQtd3(n);
        if (Math.abs(n - arred) > 1e-9) {
            throw erroCart('QUANTIDADE_INVALIDA', 'Quantidade por peso permite até 3 casas decimais.');
        }
        return arred;
    }

    /**
     * Interpretação de quantidade inteira na UI (05.26).
     * Decimais / texto inválido / vazio → restaurar. Zero ou negativo → remover.
     */
    function interpretarQuantidadeInteiraUi(raw, quantidadeAnterior) {
        const prev = Number(quantidadeAnterior);
        const anterior = Number.isFinite(prev) && prev > 0 ? prev : 1;
        if (raw === '' || raw == null) {
            return { acao: 'restaurar', quantidade: anterior };
        }
        const s = String(raw).trim();
        if (s === '') {
            return { acao: 'restaurar', quantidade: anterior };
        }
        if (!/^-?\d+$/.test(s)) {
            return { acao: 'restaurar', quantidade: anterior };
        }
        const n = parseInt(s, 10);
        if (n <= 0) {
            return { acao: 'remover', quantidade: 0 };
        }
        return { acao: 'aplicar', quantidade: n };
    }

    /**
     * Interpretação operacional (05.28): inteiro ou decimal conforme produto por peso.
     */
    function interpretarQuantidadeUi(raw, quantidadeAnterior, opcoes) {
        const permiteDecimal = !!(opcoes && opcoes.permiteDecimal);
        if (!permiteDecimal) {
            return interpretarQuantidadeInteiraUi(raw, quantidadeAnterior);
        }
        const prev = Number(quantidadeAnterior);
        const anterior = Number.isFinite(prev) && prev > 0 ? prev : 1;
        if (raw === '' || raw == null) {
            return { acao: 'restaurar', quantidade: anterior };
        }
        const bruto = String(raw).trim();
        if (bruto === '') {
            return { acao: 'restaurar', quantidade: anterior };
        }
        const normalizado = bruto.replace(',', '.');
        if (!/^-?\d+(\.\d+)?$/.test(normalizado)) {
            return { acao: 'restaurar', quantidade: anterior };
        }
        const frac = normalizado.replace(/^-/, '').split('.')[1];
        if (frac && frac.length > 3) {
            return { acao: 'restaurar', quantidade: anterior };
        }
        const n = Number(normalizado);
        if (!Number.isFinite(n)) {
            return { acao: 'restaurar', quantidade: anterior };
        }
        if (n <= 0) {
            return { acao: 'remover', quantidade: 0 };
        }
        return { acao: 'aplicar', quantidade: arredQtd3(n) };
    }

    function identificarEmpresaOperacional(entrada) {
        const empresaPorItem = !!(entrada && entrada.empresa_por_item);
        const contextoId = entrada && entrada.empresa_contexto_id != null
            ? Number(entrada.empresa_contexto_id)
            : null;
        const empresas = (entrada && entrada.empresas_disponiveis) || [];

        if (!empresaPorItem) {
            if (!Number.isInteger(contextoId) || contextoId <= 0) {
                throw erroCart(
                    'EMPRESA_OPERACIONAL_NAO_SELECIONADA',
                    'Selecione a empresa operacional antes de adicionar itens.'
                );
            }
            const hit = empresas.find((e) => Number(e.empresa_id) === contextoId);
            if (!hit) {
                throw erroCart(
                    'PRODUTO_SEM_DISPONIBILIDADE',
                    'Produto sem disponibilidade na empresa operacional.'
                );
            }
            return {
                empresa_id: contextoId,
                nome: hit.nome,
                origem_identificacao_empresa: 'CONTEXTO_EMPRESA_UNICA',
                exige_escolha: false,
                disponibilidade: hit.disponibilidade
            };
        }

        if (empresas.length === 0) {
            throw erroCart('PRODUTO_SEM_DISPONIBILIDADE', 'Produto sem disponibilidade operacional.');
        }
        if (empresas.length === 1) {
            const unica = empresas[0];
            return {
                empresa_id: Number(unica.empresa_id),
                nome: unica.nome,
                origem_identificacao_empresa: 'UNICA_COM_DISPONIBILIDADE',
                exige_escolha: false,
                disponibilidade: unica.disponibilidade
            };
        }
        return {
            empresa_id: null,
            origem_identificacao_empresa: null,
            exige_escolha: true,
            candidatos: empresas
        };
    }

    function criarCarrinho() {
        const itens = [];

        function obterItens() {
            return itens.map((i) => ({ ...i }));
        }

        function calcularTotal() {
            return arred2(itens.reduce((acc, i) => acc + i.subtotal, 0));
        }

        function localizar(produtoId, empresaId) {
            const k = chaveItem(produtoId, empresaId);
            return itens.find((i) => chaveItem(i.produto_id, i.empresa_id) === k) || null;
        }

        function adicionarItem(entrada, disponivelMax) {
            const produtoId = Number(entrada.produto_id || entrada.produtoId);
            const empresaId = Number(entrada.empresa_id || entrada.empresaId);
            if (!Number.isInteger(produtoId) || produtoId <= 0) {
                throw erroCart('PRODUTO_OBRIGATORIO', 'produto_id é obrigatório.');
            }
            if (!Number.isInteger(empresaId) || empresaId <= 0) {
                throw erroCart('EMPRESA_OBRIGATORIA', 'empresa_id é obrigatório no item.');
            }
            const flagFrac = flagFracionadoDeEntrada(entrada);
            const permiteDecimal = flagFrac === 1;
            const quantidade = validarQuantidade(
                entrada.quantidade == null ? 1 : entrada.quantidade,
                permiteDecimal
            );
            const valor = arred2(entrada.valor_unitario != null ? entrada.valor_unitario : entrada.preco);
            if (!Number.isFinite(valor) || valor < 0) {
                throw erroCart('VALOR_INVALIDO', 'valor_unitario inválido.');
            }
            const atual = localizar(produtoId, empresaId);
            const somaQtd = atual ? (atual.quantidade + quantidade) : quantidade;
            const novaQtd = permiteDecimal || (atual && produtoVendidoPorPeso(atual))
                ? arredQtd3(somaQtd)
                : arred2(somaQtd);
            const qtdFinal = validarQuantidade(novaQtd, permiteDecimal || produtoVendidoPorPeso(atual));
            const teto = disponivelMax != null ? Number(disponivelMax) : Infinity;
            if (Number.isFinite(teto) && qtdFinal - teto > 1e-9) {
                throw erroCart('ESTOQUE_INSUFICIENTE', 'Quantidade acima da disponibilidade.');
            }
            if (atual) {
                atual.quantidade = qtdFinal;
                atual.subtotal = arred2(atual.quantidade * atual.valor_unitario);
                atual.disponibilidade = entrada.disponibilidade || atual.disponibilidade;
                if (entrada.unidade != null) atual.unidade = entrada.unidade;
                if (flagFrac) {
                    atual.produto_fracionado = 1;
                    atual.produto_pesavel = 1;
                    atual.vendido_por_peso = 1;
                }
                return { ...atual };
            }
            const item = {
                produto_id: produtoId,
                descricao: entrada.descricao || entrada.nome || 'Produto',
                quantidade: qtdFinal,
                valor_unitario: valor,
                subtotal: arred2(qtdFinal * valor),
                empresa_id: empresaId,
                empresa_nome: entrada.empresa_nome || entrada.empresaNome || null,
                disponibilidade: entrada.disponibilidade || null,
                origem_identificacao_empresa: entrada.origem_identificacao_empresa || null,
                unidade: entrada.unidade || (permiteDecimal ? 'KG' : 'UN'),
                produto_fracionado: flagFrac,
                produto_pesavel: flagFrac,
                vendido_por_peso: flagFrac
            };
            itens.push(item);
            return { ...item };
        }

        function alterarQuantidade(produtoId, empresaId, quantidade, disponivelMax) {
            const atual = localizar(produtoId, empresaId);
            if (!atual) throw erroCart('ITEM_NAO_ENCONTRADO', 'Item não está no carrinho.');
            const n = Number(quantidade);
            if (!Number.isFinite(n) || n <= 0) {
                return removerItem(produtoId, empresaId);
            }
            const permiteDecimal = produtoVendidoPorPeso(atual);
            const qtd = validarQuantidade(n, permiteDecimal);
            const teto = disponivelMax != null ? Number(disponivelMax) : Infinity;
            if (Number.isFinite(teto) && qtd - teto > 1e-9) {
                throw erroCart('ESTOQUE_INSUFICIENTE', 'Quantidade acima da disponibilidade.');
            }
            atual.quantidade = qtd;
            atual.subtotal = arred2(atual.quantidade * atual.valor_unitario);
            return { ...atual };
        }

        /**
         * Aplica quantidade local (produto_id + empresa_id). Sem HTTP.
         * Inteiro para unidade; decimal (até 3 casas) para produto por peso.
         */
        function aplicarQuantidadeInteira(produtoId, empresaId, quantidade) {
            return alterarQuantidade(produtoId, empresaId, quantidade, Infinity);
        }

        function removerItem(produtoId, empresaId) {
            const k = chaveItem(produtoId, empresaId);
            const idx = itens.findIndex((i) => chaveItem(i.produto_id, i.empresa_id) === k);
            if (idx < 0) return false;
            itens.splice(idx, 1);
            return true;
        }

        function limpar() {
            itens.splice(0, itens.length);
        }

        function finalizarPreview() {
            if (!itens.length) {
                throw erroCart('CARRINHO_VAZIO', 'Carrinho vazio.');
            }
            return {
                code: 'CHECKOUT_AINDA_NAO_IMPLEMENTADO',
                itens: obterItens(),
                total_preview: calcularTotal()
            };
        }

        return {
            adicionarItem,
            removerItem,
            alterarQuantidade,
            aplicarQuantidadeInteira,
            limpar,
            obterItens,
            calcularTotal,
            localizar,
            finalizarPreview,
            chaveItem
        };
    }

    return {
        criarCarrinho,
        identificarEmpresaOperacional,
        chaveItem,
        produtoVendidoPorPeso,
        formatarQuantidadeUi,
        interpretarQuantidadeInteiraUi,
        interpretarQuantidadeUi,
        arred2,
        arredQtd3
    };
});
