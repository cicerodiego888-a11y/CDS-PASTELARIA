/**
 * Contratos oficiais do Motor Universal de Vendas (Sprint 04.01).
 * Sem persistência, sem UI, sem alteração de estoque/MTS/TEF.
 *
 * @module motores/muv/contratos
 */
'use strict';

const EntidadeUniversal = Object.freeze({
  ATENDIMENTO: 'ATENDIMENTO'
});

const ModoOperacaoVenda = Object.freeze({
  EMPRESA_UNICA: 'EMPRESA_UNICA',
  MULTIEMPRESA: 'MULTIEMPRESA'
});

/** Alias oficial 04.02 — mesmos valores de ModoOperacaoVenda. */
const MODOS_OPERACAO_VENDA = ModoOperacaoVenda;

const DEFAULT_MODO_OPERACAO_VENDA = ModoOperacaoVenda.EMPRESA_UNICA;

const EstrategiaDistribuicaoPagamento = Object.freeze({
  PROPORCIONAL: 'PROPORCIONAL',
  POR_ITEM: 'POR_ITEM',
  MANUAL: 'MANUAL'
});

const AtomicidadeMuv = Object.freeze({
  ROLLBACK_TOTAL: 'ROLLBACK_TOTAL'
});

const MODOS = Object.freeze(Object.values(ModoOperacaoVenda));

function erroContrato(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validação pura de valor explícito (sem banco, sem default silencioso).
 * null e undefined são inválidos — ausência é responsabilidade do bootstrap/leitura.
 */
function validarModoOperacaoVenda(valor) {
  if (valor === null || valor === undefined) {
    throw erroContrato(
      'MODO_OPERACAO_VENDA_INVALIDO',
      'modo_operacao_venda nulo não é valor explícito válido. Use EMPRESA_UNICA ou MULTIEMPRESA.'
    );
  }
  if (typeof valor === 'object') {
    throw erroContrato(
      'MODO_OPERACAO_VENDA_INVALIDO',
      'modo_operacao_venda deve ser a string EMPRESA_UNICA ou MULTIEMPRESA.'
    );
  }
  const s = String(valor).toUpperCase().trim();
  if (!MODOS.includes(s)) {
    throw erroContrato(
      'MODO_OPERACAO_VENDA_INVALIDO',
      `modo_operacao_venda inválido: ${String(valor)}. Use EMPRESA_UNICA ou MULTIEMPRESA.`
    );
  }
  return s;
}

/**
 * Modo a partir de fonte opcional (configuração / objeto).
 * Nunca inventa a partir de CNPJ, empresa 1, body ou cliente.
 * Ausente / vazio → EMPRESA_UNICA (compatível com o PDV atual).
 * Valor presente e desconhecido → MODO_OPERACAO_VENDA_INVALIDO (não escolhe MULTIEMPRESA).
 */
function resolverModoOperacaoVenda(fonte) {
  if (fonte == null || fonte === '') return DEFAULT_MODO_OPERACAO_VENDA;
  const bruto = typeof fonte === 'object'
    ? fonte.modo_operacao_venda
    : fonte;
  if (bruto == null || bruto === '') return DEFAULT_MODO_OPERACAO_VENDA;
  return validarModoOperacaoVenda(bruto);
}

function exigirEmpresaIdOperacao(fonte) {
  const raw = fonte && typeof fonte === 'object'
    ? fonte.empresaId
    : fonte;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw erroContrato(
      'EMPRESA_OBRIGATORIA',
      'Operação empresarial exige empresaId validado. Body/query/CNPJ não inventam empresa.'
    );
  }
  return n;
}

/**
 * Invariante: soma das partes = total do pagamento (tolerância 1 centavo).
 */
function validarDistribuicaoPagamento(totalPagamento, partes, tolerancia = 0.01) {
  const total = Number(totalPagamento);
  if (!Number.isFinite(total) || total < 0) {
    throw erroContrato('PAGAMENTO_INVALIDO', 'Total de pagamento inválido.');
  }
  if (!Array.isArray(partes) || partes.length === 0) {
    throw erroContrato('DISTRIBUICAO_INVALIDA', 'Informe ao menos uma distribuição por empresa.');
  }
  let soma = 0;
  for (const parte of partes) {
    exigirEmpresaIdOperacao(parte);
    const v = Number(parte.valor);
    if (!Number.isFinite(v) || v < 0) {
      throw erroContrato('DISTRIBUICAO_INVALIDA', 'Valor de distribuição inválido.');
    }
    soma += v;
  }
  if (Math.abs(soma - total) > tolerancia) {
    throw erroContrato(
      'DISTRIBUICAO_DIVERGENTE',
      'A soma das distribuições deve ser igual ao total do pagamento.'
    );
  }
  return true;
}

function itemExigeEmpresaNoModo(modo, item) {
  const m = resolverModoOperacaoVenda(modo);
  if (m !== ModoOperacaoVenda.MULTIEMPRESA) return null;
  return exigirEmpresaIdOperacao(item);
}

const PROIBICOES_MUV = Object.freeze({
  naoCriarEstoqueParalelo: true,
  naoCriarMtsParalelo: true,
  naoCriarMotorComercialParalelo: true,
  naoDuplicarProdutosPorEmpresa: true,
  naoSubstituirTabelaVendas: true,
  naoInventarEmpresaPorBody: true
});

const STATUS_ATENDIMENTO = Object.freeze({
  ABERTO: 'ABERTO',
  VALIDADO: 'VALIDADO',
  AGUARDANDO_PAGAMENTO: 'AGUARDANDO_PAGAMENTO',
  CONCLUIDO: 'CONCLUIDO',
  CANCELADO: 'CANCELADO'
});

const STATUS_OPERACAO_EMPRESARIAL = Object.freeze({
  ABERTA: 'ABERTA',
  VALIDADA: 'VALIDADA',
  AGUARDANDO_CONCLUSAO: 'AGUARDANDO_CONCLUSAO',
  CONCLUIDA: 'CONCLUIDA',
  CANCELADA: 'CANCELADA'
});

const TIPO_FISCAL_ITEM_ATENDIMENTO = Object.freeze({
  TOTAL: 'TOTAL',
  FISCAL: 'FISCAL',
  NAO_FISCAL: 'NAO_FISCAL'
});

const FLUXO_ATENDIMENTO_04_03 = Object.freeze([
  STATUS_ATENDIMENTO.ABERTO,
  STATUS_ATENDIMENTO.VALIDADO
]);

const FLUXO_OPERACAO_04_03 = Object.freeze([
  STATUS_OPERACAO_EMPRESARIAL.ABERTA,
  STATUS_OPERACAO_EMPRESARIAL.VALIDADA
]);

function arredondarCentavosMuv(valor) {
  return Math.round(Number(valor || 0) * 100) / 100;
}

function arredondarQuantidadeMuv(valor) {
  return Math.round(Number(valor || 0) * 1000) / 1000;
}

function valorTotalItemAtendimento(quantidade, valorUnitario) {
  return arredondarCentavosMuv(arredondarQuantidadeMuv(quantidade) * Number(valorUnitario));
}

function normalizarTipoFiscalItemAtendimento(valor) {
  if (valor == null || valor === '') return TIPO_FISCAL_ITEM_ATENDIMENTO.TOTAL;
  const s = String(valor).toUpperCase().trim().replace(/[\s-]+/g, '_');
  if (s === 'TOTAL') return TIPO_FISCAL_ITEM_ATENDIMENTO.TOTAL;
  if (s === 'FISCAL' || s === 'F') return TIPO_FISCAL_ITEM_ATENDIMENTO.FISCAL;
  if (s === 'NAO_FISCAL' || s === 'NAOFISCAL' || s === 'NF') {
    return TIPO_FISCAL_ITEM_ATENDIMENTO.NAO_FISCAL;
  }
  throw erroContrato(
    'ITEM_ATENDIMENTO_INVALIDO',
    `tipoFiscal inválido: ${valor}. Use TOTAL, FISCAL ou NAO_FISCAL.`
  );
}

function itemTentaSubstituirEmpresaId(item) {
  if (!item || typeof item !== 'object') return false;
  const temOficial = Object.prototype.hasOwnProperty.call(item, 'empresaId')
    && item.empresaId != null
    && item.empresaId !== '';
  if (temOficial) return false;
  return item.empresa_id != null
    || item.cnpj != null
    || item.nome_empresa != null
    || item.nomeEmpresa != null;
}

function exigirProdutoIdAtendimento(item) {
  const raw = item && typeof item === 'object' ? item.produtoId : item;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw erroContrato(
      'PRODUTO_OBRIGATORIO',
      'Item do atendimento exige produtoId. produto_id não substitui o contrato oficial.'
    );
  }
  return n;
}

function validarItemEntradaAtendimento(item, indice = 0) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw erroContrato(
      'ITEM_ATENDIMENTO_INVALIDO',
      `Item ${indice} inválido.`
    );
  }
  if (itemTentaSubstituirEmpresaId(item)) {
    throw erroContrato(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório. empresa_id, CNPJ ou nome da empresa não substituem.'
    );
  }
  const empresaId = exigirEmpresaIdOperacao(item);
  const produtoId = exigirProdutoIdAtendimento(item);
  const quantidade = arredondarQuantidadeMuv(item.quantidade);
  if (!(quantidade > 0) || !Number.isFinite(Number(item.quantidade))) {
    throw erroContrato(
      'QUANTIDADE_INVALIDA',
      `Quantidade inválida no produto ${produtoId} / empresa ${empresaId}.`
    );
  }
  if (item.valorUnitario == null || item.valorUnitario === '') {
    throw erroContrato(
      'ITEM_ATENDIMENTO_INVALIDO',
      `valorUnitario obrigatório no produto ${produtoId} / empresa ${empresaId}.`
    );
  }
  const valorUnitario = arredondarCentavosMuv(item.valorUnitario);
  if (!Number.isFinite(Number(item.valorUnitario)) || valorUnitario < 0) {
    throw erroContrato(
      'ITEM_ATENDIMENTO_INVALIDO',
      `valorUnitario inválido no produto ${produtoId} / empresa ${empresaId}.`
    );
  }
  const tipoFiscal = normalizarTipoFiscalItemAtendimento(item.tipoFiscal);
  const valorTotal = valorTotalItemAtendimento(quantidade, valorUnitario);
  return Object.freeze({
    produtoId,
    empresaId,
    quantidade,
    valorUnitario,
    valorTotal,
    tipoFiscal
  });
}

function validarItensEntradaAtendimento(itens) {
  if (!Array.isArray(itens) || itens.length === 0) {
    throw erroContrato(
      'ITENS_ATENDIMENTO_OBRIGATORIOS',
      'Informe ao menos um item para o atendimento multiempresa.'
    );
  }
  return itens.map((item, i) => validarItemEntradaAtendimento(item, i));
}

/**
 * Agrupa por empresa. Mesmo produto+empresa só soma se valor e tipo fiscal
 * forem iguais; senão ITEM_ATENDIMENTO_INCONSISTENTE.
 */
function agruparItensPorEmpresa(itensValidos) {
  const porEmpresa = new Map();
  for (const item of itensValidos) {
    if (!porEmpresa.has(item.empresaId)) {
      porEmpresa.set(item.empresaId, []);
    }
    const lista = porEmpresa.get(item.empresaId);
    const existente = lista.find((x) => x.produtoId === item.produtoId);
    if (!existente) {
      lista.push({ ...item });
      continue;
    }
    if (
      existente.valorUnitario !== item.valorUnitario
      || existente.tipoFiscal !== item.tipoFiscal
    ) {
      throw erroContrato(
        'ITEM_ATENDIMENTO_INCONSISTENTE',
        `Produto ${item.produtoId} na empresa ${item.empresaId} com atributos comerciais incompatíveis.`
      );
    }
    existente.quantidade = arredondarQuantidadeMuv(existente.quantidade + item.quantidade);
    existente.valorTotal = valorTotalItemAtendimento(existente.quantidade, existente.valorUnitario);
  }

  const empresas = [...porEmpresa.keys()].sort((a, b) => a - b);
  return empresas.map((empresaId) => {
    const itens = porEmpresa.get(empresaId);
    const subtotal = arredondarCentavosMuv(
      itens.reduce((acc, it) => acc + it.valorTotal, 0)
    );
    return Object.freeze({
      empresaId,
      itens: itens.map((it) => Object.freeze({ ...it })),
      quantidadeItens: itens.length,
      subtotal
    });
  });
}

module.exports = {
  EntidadeUniversal,
  ModoOperacaoVenda,
  MODOS_OPERACAO_VENDA,
  DEFAULT_MODO_OPERACAO_VENDA,
  EstrategiaDistribuicaoPagamento,
  AtomicidadeMuv,
  MODOS,
  STATUS_ATENDIMENTO,
  STATUS_OPERACAO_EMPRESARIAL,
  TIPO_FISCAL_ITEM_ATENDIMENTO,
  FLUXO_ATENDIMENTO_04_03,
  FLUXO_OPERACAO_04_03,
  validarModoOperacaoVenda,
  resolverModoOperacaoVenda,
  exigirEmpresaIdOperacao,
  validarDistribuicaoPagamento,
  itemExigeEmpresaNoModo,
  arredondarCentavosMuv,
  arredondarQuantidadeMuv,
  valorTotalItemAtendimento,
  validarItemEntradaAtendimento,
  validarItensEntradaAtendimento,
  agruparItensPorEmpresa,
  PROIBICOES_MUV
};
