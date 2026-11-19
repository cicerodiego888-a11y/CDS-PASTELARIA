/**
 * Camada central de entrada de pedidos.
 *
 * Recebe solicitações de adaptadores internos autorizados, valida empresa e canal e delega a criação
 * ao PedidoOperacionalService (única fonte de regras: itens, totais, mesa, Motor Comercial e reservas).
 * Não possui CRUD, tabela nem regras de negócio próprias.
 *
 * O canal NUNCA é lido do corpo da requisição: quem define a origem é o adaptador (código servidor)
 * que chama `receber`. Isso evita que um cliente declare livremente um canal.
 *
 * S07-3D: o adaptador EQUIPE (garçom / operação da loja) permanece o contrato de entrada;
 * a resolução de cozinha mapeia EQUIPE → canal LOJA (ver CozinhaResolucaoDestinoService).
 * Integrações futuras (IFOOD, WHATSAPP, etc.) devem chamar `receber` com o código do canal
 * correspondente — sem inventar fluxos paralelos nesta sprint.
 */
'use strict';

const PedidoOperacional = require('./PedidoOperacionalService');
const { empresaIdDoReqPedido } = require('./empresaIdDoReqPedido');
const CanalVendaEmpresaService = require('../vendas/CanalVendaEmpresaService');

const CanalOrigem = Object.freeze({
  EQUIPE: 'EQUIPE',
  BALCAO: 'BALCAO',
  MESA: 'MESA',
  CARDAPIO_WEB: 'CARDAPIO_WEB'
});

// Somente canais com adaptador existente. Os demais fazem parte do contrato, mas permanecem desabilitados.
const CANAIS_HABILITADOS = Object.freeze([CanalOrigem.EQUIPE]);

function erro(mensagem, statusCode, codigo) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  return err;
}

function validarCanal(canal) {
  const valor = String(canal || '').trim().toUpperCase();
  if (!Object.values(CanalOrigem).includes(valor)) {
    throw erro('Canal de origem desconhecido.', 400, 'CANAL_ORIGEM_INVALIDO');
  }
  if (!CANAIS_HABILITADOS.includes(valor)) {
    throw erro('Canal de origem não habilitado.', 403, 'CANAL_ORIGEM_NAO_HABILITADO');
  }
  return valor;
}

/**
 * @param {object} entrada
 * @param {string} entrada.canal canal definido pelo adaptador (não vem do cliente)
 * @param {object} entrada.body dados do pedido (mesmo contrato do Pedido Operacional)
 * @param {number|string} entrada.empresaId empresa explícita do contexto autenticado
 * @param {number|null} [entrada.operadorId]
 * @returns {Promise<{success:boolean,pedido:object}>} resultado do Pedido Operacional
 */
async function receber({
  canal,
  body,
  empresaId,
  operadorId = null,
  chaveIdempotencia,
  canalVendaCodigo,
  usuario,
  db
} = {}) {
  let origemCanal = validarCanal(canal);
  const empresa = empresaIdDoReqPedido({ empresaId });
  if (!empresa) {
    throw erro('Contexto de empresa obrigatório.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }

  if (canalVendaCodigo !== undefined && canalVendaCodigo !== null) {
    const banco = db || require('../../database');
    const resolucao = await CanalVendaEmpresaService.resolverEmpresaDoCanal(
      banco,
      { codigo: canalVendaCodigo, usuario },
      { db: banco }
    );
    if (
      resolucao.aplicada
      && Number(resolucao.empresa_id) !== Number(empresa)
    ) {
      throw erro(
        'A empresa do canal de venda diverge da empresa selecionada para a operação.',
        409,
        'CANAL_EMPRESA_DIVERGENTE'
      );
    }
    if (!resolucao.aplicada && resolucao.motivo !== 'PDV_MULTIPLAS') {
      throw erro(
        'O canal de venda não possui uma empresa responsável aplicável.',
        409,
        'CANAL_EMPRESA_NAO_RESOLVIDA'
      );
    }
    origemCanal = resolucao.codigo;
  }

  return PedidoOperacional.criar(body || {}, operadorId, {
    ...(db ? { db } : {}),
    empresaId: empresa,
    origemCanal,
    chaveIdempotencia,
    exigirChaveIdempotencia: true
  });
}

module.exports = { receber, validarCanal, CanalOrigem, CANAIS_HABILITADOS };
