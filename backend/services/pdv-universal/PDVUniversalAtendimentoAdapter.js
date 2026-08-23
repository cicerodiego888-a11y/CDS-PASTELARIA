/**
 * Adapter carrinho PDV Universal → itens oficiais do MUV (Sprint 05.06).
 * Não agrupa. Não consulta estoque. Não inventa empresa.
 */
'use strict';

function erroAt(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function montarItensAtendimento(itens) {
  if (!Array.isArray(itens) || itens.length === 0) {
    throw erroAt('CARRINHO_VAZIO', 'Carrinho vazio.');
  }
  return itens.map((item) => {
    const produtoId = Number(item.produto_id != null ? item.produto_id : item.produtoId);
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      throw erroAt('PRODUTO_ID_OBRIGATORIO', 'produto_id é obrigatório.');
    }
    const empresaId = Number(item.empresa_id != null ? item.empresa_id : item.empresaId);
    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      throw erroAt('EMPRESA_ITEM_OBRIGATORIA', 'empresa_id do item é obrigatório.');
    }
    const quantidade = Number(item.quantidade);
    const valorUnitario = item.valor_unitario != null
      ? Number(item.valor_unitario)
      : Number(item.preco_unitario);
    return {
      produtoId,
      empresaId,
      quantidade,
      valorUnitario
    };
  });
}

function normalizarRespostaAtendimento(preview) {
  const id = preview.atendimentoId || preview.atendimento_id;
  return {
    sucesso: true,
    modo_operacao_venda: 'MULTIEMPRESA',
    modo: 'MULTIEMPRESA',
    checkout_concluido: false,
    pagamento_pendente: true,
    venda_concluida: false,
    atendimento_id: id,
    atendimento: {
      id,
      codigo: preview.codigo,
      status: preview.status
    },
    operacoes: (preview.operacoes || []).map((op) => ({
      id: op.operacaoId || op.id,
      empresa_id: op.empresaId || op.empresa_id,
      status: op.status
    }))
  };
}

module.exports = {
  montarItensAtendimento,
  normalizarRespostaAtendimento,
  erroAt
};
