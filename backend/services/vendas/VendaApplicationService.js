/**
 * VendaApplicationService — Porta oficial de aplicação do Núcleo Transacional da Venda.
 *
 * Sprint 2.0: fachada pura de entrada.
 * Sprint 2.2: reconhece VendaOrigin / VendaContext / VendaContract.
 * Sprint 04.02: resolve o modo de operação (EMPRESA_UNICA | MULTIEMPRESA)
 *               num único ponto. EMPRESA_UNICA = fluxo atual.
 * Sprint 04.03: MULTIEMPRESA → AtendimentoMultiempresaService (preview VALIDADO).
 *               Não chama VendaPagamentoService. Não cria vendas.
 *
 * Política de porta:
 * - origem PDV → delega integralmente a VendaPagamentoService (comportamento atual)
 * - origem FATURAMENTO → delega ao núcleo sem exigir caixa (Sprint 3.1)
 * - demais origens → reconhece sem concluir
 *
 * Proibido neste módulo:
 * - regras do Motor Fiscal × Não Fiscal
 * - estoque, pagamentos, persistência, emissão
 *
 * Fluxo oficial:
 *   Controller → VendaApplicationService(contract, context) → VendaPagamentoService
 *
 * @module services/vendas/VendaApplicationService
 */

'use strict';

const VendaPagamentoService = require('./VendaPagamentoService');
const { criarVendaContract } = require('./VendaContract');
const { criarVendaContext } = require('./VendaContext');
const {
  VendaOrigin,
  origemPodeConcluirVenda,
  resolverVendaOrigin
} = require('./VendaOrigin');
const {
  resolverModoOperacaoVendaAtivo,
  executarNoModoOperacaoVenda
} = require('../../motores/muv');

/**
 * Resposta arquitetural para origens ainda não habilitadas a concluir venda.
 * @param {import('express').Response} res
 * @param {import('./VendaContext').VendaContext} context
 * @param {import('./VendaContract').VendaContract} contract
 */
function responderOrigemReconhecidaSemConclusao(res, context, contract) {
  return res.status(200).json({
    success: true,
    reconhecida: true,
    origem: context.origem,
    venda_concluida: false,
    exige_caixa: false,
    mensagem:
      'Origem reconhecida pelo Núcleo Transacional. ' +
      'Conclusão de venda para esta origem ainda não habilitada (Sprint 2.2 — preparação multi-origem).',
    contract: {
      total: contract.total,
      itens: Array.isArray(contract.itens) ? contract.itens.length : 0,
      tipo_venda: contract.tipo_venda
    }
  });
}

function responderErroModoOperacao(res, err) {
  if (res && typeof res.status === 'function') {
    return res.status(500).json({
      success: false,
      code: err.code || 'MODO_OPERACAO_VENDA_INVALIDO',
      mensagem: err.message
    });
  }
  throw err;
}

async function executarAtendimentoMultiempresa(req, res, ctx, ctr, opcoes = {}) {
  const service = opcoes.AtendimentoMultiempresaService
    || require('../../motores/muv/AtendimentoMultiempresaService');
  try {
    const preview = await service.criarAtendimento({
      origem: ctx.origem,
      itens: Array.isArray(ctr.itens) ? ctr.itens : []
    }, {
      db: opcoes.db,
      consultarDisponibilidade: opcoes.consultarDisponibilidade,
      aposPersistirParcial: opcoes.aposPersistirParcial
    });
    return res.status(200).json({
      success: true,
      reconhecida: true,
      origem: ctx.origem,
      modo_operacao_venda: 'MULTIEMPRESA',
      modo_operacao: preview.modo_operacao,
      atendimentoId: preview.atendimentoId,
      codigo: preview.codigo,
      status: preview.status,
      total: preview.total,
      valor_total: preview.total,
      operacoes: preview.operacoes,
      venda_concluida: false,
      pagamento_pendente: true,
      exige_caixa: false
    });
  } catch (e) {
    const status = e.statusCode
      || (e.code === 'SALDO_INSUFICIENTE' ? 409 : 400);
    if (res && typeof res.status === 'function') {
      return res.status(status).json({
        success: false,
        code: e.code || 'ATENDIMENTO_INVALIDO',
        mensagem: e.message,
        detalhes: e.detalhes || null,
        origem: ctx.origem,
        modo_operacao_venda: 'MULTIEMPRESA',
        venda_concluida: false,
        pagamento_pendente: true
      });
    }
    throw e;
  }
}

/**
 * Porta oficial: recebe contrato + contexto e aplica política de origem.
 * PDV / FATURAMENTO → delegação integral ao núcleo. Demais → reconhecimento sem conclusão.
 *
 * @param {import('./VendaContract').VendaContract} contract
 * @param {import('./VendaContext').VendaContext} context
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} [opcoes] injeção de leitura do modo (testes). Express `next` é ignorado.
 * @returns {*}
 */
function criarVendaComContexto(contract, context, req, res, opcoes) {
  const ctx = context && context.origem
    ? context
    : criarVendaContext(req);
  const ctr = contract && contract.payload
    ? contract
    : criarVendaContract(req);

  req.vendaContract = ctr;
  req.vendaContext = ctx;

  let modo;
  try {
    modo = resolverModoOperacaoVendaAtivo(opcoes);
  } catch (e) {
    if (e && e.code === 'MODO_OPERACAO_VENDA_INVALIDO') {
      return responderErroModoOperacao(res, e);
    }
    throw e;
  }

  ctx.modo_operacao_venda = modo;
  req.vendaContext = ctx;

  return executarNoModoOperacaoVenda(modo, {
    EMPRESA_UNICA() {
      if (!origemPodeConcluirVenda(ctx.origem)) {
        return responderOrigemReconhecidaSemConclusao(res, ctx, ctr);
      }
      return VendaPagamentoService.criarVenda(req, res);
    },
    MULTIEMPRESA() {
      return executarAtendimentoMultiempresa(req, res, ctx, ctr, opcoes && typeof opcoes === 'object'
        ? opcoes
        : {});
    }
  });
}

/**
 * Adapter HTTP — monta VendaContract + VendaContext e entra na porta oficial.
 * Compatível com a assinatura Sprint 2.0 `(req, res)`.
 * Express pode passar `next` como 3º argumento; não é usado como configuração.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} [opcoes]
 * @returns {*}
 */
function criarVenda(req, res, opcoes) {
  const contract = criarVendaContract(req);
  const context = criarVendaContext(req);
  return criarVendaComContexto(contract, context, req, res, opcoes);
}

module.exports = {
  criarVenda,
  criarVendaComContexto,
  VendaOrigin,
  resolverVendaOrigin
};
