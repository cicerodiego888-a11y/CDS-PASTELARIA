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

    function chaveItem(produtoId, empresaId) {
        return `${Number(produtoId)}:${Number(empresaId)}`;
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

    function validarQuantidade(qtd) {
        const n = Number(qtd);
        if (!Number.isFinite(n) || n <= 0) {
            throw erroCart('QUANTIDADE_INVALIDA', 'Quantidade deve ser maior que zero.');
        }
        return n;
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
            const quantidade = validarQuantidade(entrada.quantidade == null ? 1 : entrada.quantidade);
            const valor = arred2(entrada.valor_unitario != null ? entrada.valor_unitario : entrada.preco);
            if (!Number.isFinite(valor) || valor < 0) {
                throw erroCart('VALOR_INVALIDO', 'valor_unitario inválido.');
            }
            const atual = localizar(produtoId, empresaId);
            const novaQtd = atual ? arred2(atual.quantidade + quantidade) : quantidade;
            const teto = disponivelMax != null ? Number(disponivelMax) : Infinity;
            if (Number.isFinite(teto) && novaQtd - teto > 1e-9) {
                throw erroCart('ESTOQUE_INSUFICIENTE', 'Quantidade acima da disponibilidade.');
            }
            if (atual) {
                atual.quantidade = novaQtd;
                atual.subtotal = arred2(atual.quantidade * atual.valor_unitario);
                atual.disponibilidade = entrada.disponibilidade || atual.disponibilidade;
                return { ...atual };
            }
            const item = {
                produto_id: produtoId,
                descricao: entrada.descricao || entrada.nome || 'Produto',
                quantidade: novaQtd,
                valor_unitario: valor,
                subtotal: arred2(novaQtd * valor),
                empresa_id: empresaId,
                empresa_nome: entrada.empresa_nome || entrada.empresaNome || null,
                disponibilidade: entrada.disponibilidade || null,
                origem_identificacao_empresa: entrada.origem_identificacao_empresa || null
            };
            itens.push(item);
            return { ...item };
        }

        function alterarQuantidade(produtoId, empresaId, quantidade, disponivelMax) {
            const atual = localizar(produtoId, empresaId);
            if (!atual) throw erroCart('ITEM_NAO_ENCONTRADO', 'Item não está no carrinho.');
            if (quantidade === 0) {
                return removerItem(produtoId, empresaId);
            }
            const qtd = validarQuantidade(quantidade);
            const teto = disponivelMax != null ? Number(disponivelMax) : Infinity;
            if (Number.isFinite(teto) && qtd - teto > 1e-9) {
                throw erroCart('ESTOQUE_INSUFICIENTE', 'Quantidade acima da disponibilidade.');
            }
            atual.quantidade = qtd;
            atual.subtotal = arred2(atual.quantidade * atual.valor_unitario);
            return { ...atual };
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
        arred2
    };
});
