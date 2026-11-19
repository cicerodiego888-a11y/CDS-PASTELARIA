/**
 * Unidade operacional da Cozinha — origem autenticada (JWT / sessão).
 * Sprint 05 correção de homologação: não confiar só em body/query.
 */
'use strict';

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

/**
 * Extrai e valida a unidade autorizada da sessão autenticada.
 * @param {object} user — req.user (JWT verificado)
 * @returns {number}
 */
function unidadeCozinhaDaSessao(user) {
  if (!user || typeof user !== 'object') {
    throw erro(
      'Sessão sem unidade operacional de cozinha.',
      400,
      'UNIDADE_OBRIGATORIA'
    );
  }
  const raw = user.unidade_cozinha_id != null
    ? user.unidade_cozinha_id
    : user.unidadeCozinhaId;
  if (raw == null || String(raw).trim() === '') {
    throw erro(
      'Sessão sem unidade operacional de cozinha.',
      400,
      'UNIDADE_OBRIGATORIA'
    );
  }
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro(
      'Unidade operacional de cozinha inválida na sessão.',
      400,
      'UNIDADE_OBRIGATORIA'
    );
  }
  return id;
}

/**
 * Resolve a unidade efetiva da requisição.
 * - Fonte autoritativa: JWT (`req.user.unidade_cozinha_id`).
 * - body/query.unidade_id, se presente e não vazio, deve coincidir com a sessão.
 * - Campo vazio no cliente não é tratado como “omitido”.
 *
 * @param {import('express').Request} req
 * @returns {number}
 */
function resolverUnidadeOperacionalReq(req) {
  const unidadeSessao = unidadeCozinhaDaSessao(req && req.user);

  const body = (req && req.body) || {};
  const query = (req && req.query) || {};
  const clienteInformou = Object.prototype.hasOwnProperty.call(body, 'unidade_id')
    || Object.prototype.hasOwnProperty.call(query, 'unidade_id');

  if (clienteInformou) {
    const raw = body.unidade_id !== undefined ? body.unidade_id : query.unidade_id;
    if (raw == null || String(raw).trim() === '') {
      throw erro(
        'unidade_id vazia não é permitida.',
        400,
        'UNIDADE_OBRIGATORIA'
      );
    }
    const cliente = Number(raw);
    if (!Number.isInteger(cliente) || cliente <= 0) {
      throw erro('unidade_id inválida.', 400, 'UNIDADE_INVALIDA');
    }
    if (cliente !== unidadeSessao) {
      throw erro(
        'unidade_id diverge da unidade autorizada na sessão.',
        409,
        'UNIDADE_ISOLAMENTO'
      );
    }
  }

  return unidadeSessao;
}

/**
 * Valida unidade obrigatória no serviço (chamadas diretas / já resolvidas pela rota).
 * @param {*} valor
 * @returns {number}
 */
function exigirUnidadeOperacional(valor) {
  if (valor == null || String(valor).trim() === '') {
    throw erro(
      'Unidade operacional obrigatória.',
      400,
      'UNIDADE_OBRIGATORIA'
    );
  }
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro(
      'Unidade operacional inválida.',
      400,
      'UNIDADE_OBRIGATORIA'
    );
  }
  return id;
}

module.exports = {
  unidadeCozinhaDaSessao,
  resolverUnidadeOperacionalReq,
  exigirUnidadeOperacional
};
