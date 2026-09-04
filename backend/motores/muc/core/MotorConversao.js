/**
 * MUC RC2 — Facade de conversão (delega ao pipeline oficial)
 * Compatibilidade retroativa RC1 — mesma API pública.
 * @module motores/muc/core/MotorConversao
 */
'use strict';

const PipelineMuc = require('../pipeline/PipelineMuc');
const { criarConversaoDTO } = require('../dto/ConversaoDTO');
const { criarResultadoConversaoDTO } = require('../dto/ResultadoConversaoDTO');
const { inferirConversao } = require('./MotorInferencia');
const { montarItemLegado } = require('./MotorConversaoCalculo');
const LegacyMotor = require('../../../lib/motorConversaoUnidades');
const MotorUM = require('../../../services/unidades/MotorUnidadesMedida');

function converter(input = {}, opcoes = {}) {
  return PipelineMuc.executar(input, opcoes);
}

function validarDistribuicao(input = {}) {
  const dto = criarConversaoDTO(input);
  const inferido = inferirConversao(dto);
  const itemLegado = montarItemLegado(dto, inferido);
  return LegacyMotor.validarDistribuicaoConversaoUnidadesItem(itemLegado);
}

function resolverQuantidadesEstoque(input = {}) {
  const resultado = converter(input);
  return {
    quantidade: resultado.quantidadeEstoque,
    quantidade_fiscal: resultado.quantidadeFiscal,
    quantidade_nao_fiscal: resultado.quantidadeNaoFiscal,
    quantidade_convertida: resultado.quantidadeEstoque
  };
}

function resolverPrecosAposCompra(input = {}) {
  const dto = criarConversaoDTO(input);
  const inferido = inferirConversao(dto);
  const itemLegado = montarItemLegado(dto, inferido);
  const qtds = LegacyMotor.resolverQuantidadesEstoqueCompraItem(itemLegado);
  return LegacyMotor.resolverPrecosCadastroAposCompra({ ...itemLegado, ...qtds });
}

function calcularSubtotal(input = {}) {
  return converter(input).subtotal;
}

function calcularFormacaoPrecoCadastro(input = {}) {
  return MotorUM.calcularFormacaoPrecoCadastro(input);
}

function simularConversao({
  quantidadeCompra,
  quantidadePorApresentacao,
  valorTotal,
  unidadeOrigem,
  unidadeDestino,
  relacoes
} = {}) {
  const convLegado = LegacyMotor.simularConversaoEmbalagem({
    qtdEmbalagens: quantidadeCompra,
    qtdPorEmbalagem: quantidadePorApresentacao,
    valorTotal
  });

  let quantidadeEstoque = convLegado.qtdTotal;
  let fatorConversao = quantidadePorApresentacao;
  let unidadeEstoque = 'un';
  let tipoConversao = 'MULTIPLICADOR';

  if (unidadeOrigem && unidadeDestino) {
    const { converterQuantidade } = require('./MotorConversaoQuantidade');
    const rel = Array.isArray(relacoes) ? [...relacoes] : [];
    const fatorEmb = Number(quantidadePorApresentacao);
    if (fatorEmb > 0) {
      const { normalizarUnidade } = require('./unidadesSi');
      const de = normalizarUnidade(unidadeOrigem);
      const para = 'UN';
      if (de && de !== para) rel.push({ de, para, fator: fatorEmb });
    }
    const conv = converterQuantidade({
      quantidade: quantidadeCompra,
      unidadeOrigem,
      unidadeDestino,
      relacoes: rel
    });
    quantidadeEstoque = conv.quantidade;
    fatorConversao = conv.fatorTotal;
    unidadeEstoque = conv.unidade;
  }

  return criarResultadoConversaoDTO({
    quantidadeCompra,
    fatorConversao,
    quantidadeEstoque,
    unidadeCompra: unidadeOrigem || 'UN',
    unidadeEstoque,
    custoUnitario: convLegado.custoUnitario,
    custoTotal: convLegado.valorTotal,
    subtotal: convLegado.valorTotal,
    tipoConversao,
    confianca: 100,
    metodoInferencia: unidadeDestino ? 'MUC_02_ENCADEAMENTO' : 'SIMULACAO',
    regraAplicada: 'EMBALAGEM_MULTIPLICADOR',
    origemDados: 'SIMULACAO'
  });
}

module.exports = {
  converter,
  validarDistribuicao,
  resolverQuantidadesEstoque,
  resolverPrecosAposCompra,
  calcularSubtotal,
  calcularFormacaoPrecoCadastro,
  simularConversao,
  moeda: LegacyMotor.moeda,
  custoUnitarioVenda: LegacyMotor.custoUnitarioVenda,
  produtoUsaConversaoUnidades: LegacyMotor.produtoUsaConversaoUnidades,
  itemCompraUsaConversaoUnidades: LegacyMotor.itemCompraUsaConversaoUnidades,
  resolverQuantidadesCompraItem: LegacyMotor.resolverQuantidadesCompraItem,
  obterTotalConvertidoItemCompra: LegacyMotor.obterTotalConvertidoItemCompra,
  obterQuantidadeComercial: LegacyMotor.obterQuantidadeComercial,
  /** @deprecated MUC-08 — leitura de item para custo/F-NF. Estoque: obterMuc().converterQuantidade */
  obterQuantidadeConvertida: LegacyMotor.obterQuantidadeConvertida,
  resolverCustoUnitarioCadastro: LegacyMotor.resolverCustoUnitarioCadastro,
  resolverCustoUnitarioProdutoCadastro: LegacyMotor.resolverCustoUnitarioProdutoCadastro
};
