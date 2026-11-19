/**
 * Hash determinístico SHA-256 para idempotência da Cozinha (V1.2.3 adendo).
 * JSON canônico: chaves lexicográficas; arrays preservam ordem; qty com 3 casas.
 */
'use strict';

const crypto = require('crypto');
const { serializarQtyParaHash } = require('./cozinhaQuantidade');

const TIPOS_OPERACAO = Object.freeze({
  AUTORIZAR_QTY: 'AUTORIZAR_QTY',
  REDUZIR_TETO: 'REDUZIR_TETO',
  DESPACHO_LOTE: 'DESPACHO_LOTE',
  PREPARACAO_INICIADA: 'PREPARACAO_INICIADA',
  ITEM_PRONTO: 'ITEM_PRONTO',
  BEBIDA_ENTREGUE: 'BEBIDA_ENTREGUE',
  RETIRADA_CONFIRMADA: 'RETIRADA_CONFIRMADA'
});

/** Campos que nunca entram no hash (não determinísticos / gerados pelo servidor). */
const CAMPOS_EXCLUIDOS = new Set([
  'created_at',
  'updated_at',
  'autorizada_em',
  'reduzida_em',
  'enviada_em',
  'concluded_at',
  'publicado_em',
  'processando_em',
  'assumida_em',
  'entregue_em',
  'cancelado_em',
  'registrado_em',
  'sequencia_global',
  'id',
  'rodada_id',
  'cozinha_item_id',
  'job_id',
  'spooler_job_token',
  'timestamp',
  'agora',
  'server_now',
  'Date.now',
  'trace_id',
  'request_id',
  'ip',
  'user_agent'
]);

const CAMPOS_QTY = new Set([
  'qty_adicional',
  'qty_solicitada',
  'qty_entregue',
  'nova_qty_referencia',
  'quantidade',
  'qty'
]);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function normalizarValor(chave, valor) {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (CAMPOS_EXCLUIDOS.has(chave)) return undefined;
  if (CAMPOS_QTY.has(chave)) {
    return serializarQtyParaHash(valor);
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    // Números não-qty: inteiros sem .0; demais como string estável sem float drift no hash
    if (Number.isInteger(valor)) return valor;
    return String(valor);
  }
  if (typeof valor === 'string' || typeof valor === 'boolean') return valor;
  if (Array.isArray(valor)) {
    return valor.map((item, idx) => {
      if (isPlainObject(item)) return normalizarObjeto(item);
      if (typeof item === 'number' && !Number.isInteger(item)) return String(item);
      return item;
    });
  }
  if (isPlainObject(valor)) return normalizarObjeto(valor);
  return String(valor);
}

function normalizarObjeto(obj) {
  const out = {};
  const chaves = Object.keys(obj).filter((k) => !CAMPOS_EXCLUIDOS.has(k)).sort();
  for (const k of chaves) {
    const v = normalizarValor(k, obj[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Serializa payload para JSON canônico (sem espaços).
 * @param {object} payload
 * @returns {string}
 */
function canonicalJson(payload) {
  const normalizado = isPlainObject(payload)
    ? normalizarObjeto(payload)
    : Array.isArray(payload)
      ? payload.map((item) => (isPlainObject(item) ? normalizarObjeto(item) : item))
      : payload;
  return JSON.stringify(normalizado);
}

/**
 * Calcula SHA-256 hex do payload normalizado.
 * @param {object} payload
 * @returns {string}
 */
function calcularPayloadHash(payload) {
  const canon = canonicalJson(payload);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

/**
 * Monta payload semântico mínimo por tipo (campos do adendo).
 * Não inclui timestamps/ids de servidor.
 */
function montarPayloadSemantico(tipoOperacao, dados = {}) {
  const tipo = String(tipoOperacao || '').toUpperCase();
  if (tipo === TIPOS_OPERACAO.AUTORIZAR_QTY) {
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.AUTORIZAR_QTY,
      pedido_item_id: dados.pedido_item_id,
      empresa_id: dados.empresa_id,
      qty_adicional: dados.qty_adicional,
      motivo: dados.motivo == null ? dados.motivo : String(dados.motivo).trim(),
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  if (tipo === TIPOS_OPERACAO.REDUZIR_TETO) {
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.REDUZIR_TETO,
      pedido_item_id: dados.pedido_item_id,
      nova_qty_referencia: dados.nova_qty_referencia,
      motivo: dados.motivo == null ? dados.motivo : String(dados.motivo).trim(),
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  if (tipo === TIPOS_OPERACAO.DESPACHO_LOTE) {
    const itens = Array.isArray(dados.itens)
      ? dados.itens.map((it) => ({
        pedido_id: it.pedido_id,
        pedido_item_id: it.pedido_item_id,
        comanda_id: it.comanda_id,
        qty_solicitada: it.qty_solicitada
      }))
      : [];
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.DESPACHO_LOTE,
      empresa_id: dados.empresa_id,
      unidade_id: dados.unidade_id,
      atendimento_id: dados.atendimento_id,
      mesa_id: dados.mesa_id,
      pedido_id: dados.pedido_id,
      itens,
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  if (tipo === TIPOS_OPERACAO.PREPARACAO_INICIADA) {
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.PREPARACAO_INICIADA,
      empresa_id: dados.empresa_id,
      item_id: Number(dados.item_id),
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  if (tipo === TIPOS_OPERACAO.ITEM_PRONTO) {
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.ITEM_PRONTO,
      empresa_id: dados.empresa_id,
      item_id: Number(dados.item_id),
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  if (tipo === TIPOS_OPERACAO.BEBIDA_ENTREGUE) {
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.BEBIDA_ENTREGUE,
      empresa_id: dados.empresa_id,
      item_id: Number(dados.item_id),
      qty_entregue: dados.qty_entregue,
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  if (tipo === TIPOS_OPERACAO.RETIRADA_CONFIRMADA) {
    return normalizarObjeto({
      tipo_operacao: TIPOS_OPERACAO.RETIRADA_CONFIRMADA,
      empresa_id: dados.empresa_id,
      rodada_alvo_id: Number(dados.rodada_alvo_id),
      responsavel_operador_id: dados.responsavel_operador_id
    });
  }
  const err = new Error(`tipo_operacao inválido: ${tipoOperacao}`);
  err.codigo = 'IDEMPOTENCY_TIPO_INVALIDO';
  err.statusCode = 400;
  throw err;
}

function calcularHashOperacao(tipoOperacao, dados) {
  return calcularPayloadHash(montarPayloadSemantico(tipoOperacao, dados));
}

module.exports = {
  TIPOS_OPERACAO,
  CAMPOS_EXCLUIDOS,
  canonicalJson,
  calcularPayloadHash,
  montarPayloadSemantico,
  calcularHashOperacao,
  normalizarObjeto
};
