/**
 * 03.30 — req.empresaId (contexto validado) é a única autoridade HTTP
 * de Pedido / Expedição. body / query / user / CNPJ não substituem.
 * Sem import de F×NF: Pedido não conhece a porta.
 */
'use strict';

function empresaIdDoReqPedido(req) {
  if (!req || req.empresaId == null || req.empresaId === '') return null;
  const n = Number(req.empresaId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

module.exports = { empresaIdDoReqPedido };
