/**
 * Camada central de entrada de pedidos.
 *
 * Recebe solicitações de adaptadores internos autorizados, valida empresa e canal e delega a criação
 * ao PedidoOperacionalService (única fonte de regras: itens, totais, mesa, Motor Comercial e reservas).
 * Não possui CRUD, tabela nem regras de negócio próprias.
 *
 * O canal NUNCA é lido do corpo da requisição: quem define a origem é o adaptador (código servidor)
 * que chama `receber`. Isso evita que um cliente declare livremente um canal.
 */
'use strict';

const PedidoOperacional = require('./PedidoOperacionalService');
const { empresaIdDoReqPedido } = require('./empresaIdDoReqPedido');

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
  chaveIdempotencia
} = {}) {
  const origemCanal = validarCanal(canal);
  const empresa = empresaIdDoReqPedido({ empresaId });
  if (!empresa) {
    throw erro('Contexto de empresa obrigatório.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return PedidoOperacional.criar(body || {}, operadorId, {
    empresaId: empresa,
    origemCanal,
    chaveIdempotencia,
    exigirChaveIdempotencia: true
  });
}

module.exports = { receber, validarCanal, CanalOrigem, CANAIS_HABILITADOS };
