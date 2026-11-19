/**
 * Sessão operacional de cozinha no processo Electron main — E-03.
 * Fonte de verdade: JWT verificado (getJwtSecret) + unidade persistida (empresa_id).
 * Renderer não escolhe livremente empresa/unidade.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../../config/secrets');
const { erroImpressao, parsePositiveInteger } = require('./cozinhaImpressaoContratos');

let _sessao = null;

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function obterSessaoAutenticadaCozinha() {
  return _sessao ? { ..._sessao } : null;
}

function limparSessaoAutenticadaCozinha() {
  _sessao = null;
}

/**
 * Estabelece sessão a partir de JWT (processo main).
 * empresaId vem do cadastro da unidade — não do renderer.
 * Em falha de autenticação, a sessão anterior é invalidada.
 */
async function estabelecerSessaoApartirDoToken({ token, db }) {
  if (!db) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao('Banco indisponível para sessão cozinha.', 500, 'DB_INDISPONIVEL');
  }
  const raw = String(token || '').trim();
  if (!raw) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao('Token de sessão obrigatório.', 401, 'IMPRESSAO_SESSAO_TOKEN_OBRIGATORIO');
  }

  let payload;
  try {
    // Lê o segredo no momento da verificação (não cachear valor de boot).
    payload = jwt.verify(raw, getJwtSecret());
  } catch (err) {
    limparSessaoAutenticadaCozinha();
    if (err && err.name === 'TokenExpiredError') {
      throw erroImpressao(
        'Token de sessão expirado.',
        401,
        'IMPRESSAO_SESSAO_TOKEN_EXPIRADO'
      );
    }
    throw erroImpressao(
      'Token de sessão inválido.',
      401,
      'IMPRESSAO_SESSAO_TOKEN_INVALIDO'
    );
  }

  const unidadeId = parsePositiveInteger(payload.unidade_cozinha_id);
  if (!unidadeId) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao(
      'Sessão sem unidade de cozinha autenticada.',
      403,
      'IMPRESSAO_SESSAO_SEM_UNIDADE'
    );
  }

  const unidade = await dbGet(db, `
    SELECT id, empresa_id, ativo
    FROM cozinha_unidades
    WHERE id = ?
  `, [unidadeId]);

  if (!unidade) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao('Unidade da sessão inexistente.', 403, 'IMPRESSAO_SESSAO_UNIDADE_INEXISTENTE');
  }
  if (Number(unidade.ativo) !== 1) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao('Unidade da sessão inativa.', 403, 'IMPRESSAO_SESSAO_UNIDADE_INATIVA');
  }

  const empresaId = parsePositiveInteger(unidade.empresa_id);
  if (!empresaId) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao('Empresa da unidade inválida.', 403, 'IMPRESSAO_SESSAO_EMPRESA_INVALIDA');
  }

  // Se o JWT trouxer empresa_id, deve coincidir com a unidade (isolamento).
  const empresaClaim = parsePositiveInteger(payload.empresa_id);
  if (empresaClaim != null && empresaClaim !== empresaId) {
    limparSessaoAutenticadaCozinha();
    throw erroImpressao(
      'empresa_id do token divergente da unidade autenticada.',
      403,
      'IMPRESSAO_SESSAO_EMPRESA_DIVERGENTE',
      { detalhes: { token_empresa_id: empresaClaim, unidade_empresa_id: empresaId } }
    );
  }

  _sessao = {
    empresaId,
    unidadeId,
    usuarioId: parsePositiveInteger(payload.id != null ? payload.id : payload.usuario_id),
    estabelecido_em: new Date().toISOString()
  };
  return { ..._sessao };
}

/**
 * Valida IDs opcionais do renderer contra a sessão autenticada no main.
 * Se IDs forem enviados e divergirem → rejeita.
 * Retorna sempre o contexto canônico da sessão.
 */
function validarContextoContraSessaoAutenticada(raw = {}, sessao = null) {
  const s = sessao || _sessao;
  if (!s || !s.empresaId || !s.unidadeId) {
    throw erroImpressao(
      'Sessão autenticada de cozinha ausente no processo principal.',
      401,
      'IMPRESSAO_SESSAO_AUSENTE'
    );
  }

  const empRaw = raw.empresaId != null ? raw.empresaId : raw.empresa_id;
  const unRaw = raw.unidadeId != null ? raw.unidadeId
    : (raw.unidade_id != null ? raw.unidade_id : raw.unidade_cozinha_id);

  if (empRaw != null && empRaw !== '' && parsePositiveInteger(empRaw) !== Number(s.empresaId)) {
    throw erroImpressao(
      'empresa_id divergente da sessão autenticada.',
      403,
      'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO',
      { detalhes: { sessao_empresa_id: s.empresaId, recebido: empRaw } }
    );
  }
  if (unRaw != null && unRaw !== '' && parsePositiveInteger(unRaw) !== Number(s.unidadeId)) {
    throw erroImpressao(
      'unidade_id divergente da sessão autenticada.',
      403,
      'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO',
      { detalhes: { sessao_unidade_id: s.unidadeId, recebido: unRaw } }
    );
  }

  return {
    empresaId: Number(s.empresaId),
    unidadeId: Number(s.unidadeId)
  };
}

/** Somente testes auxiliares — não substitui os testes JWT reais. */
function _definirSessaoAutenticadaParaTeste(sessao) {
  if (!sessao) {
    _sessao = null;
    return null;
  }
  _sessao = {
    empresaId: parsePositiveInteger(sessao.empresaId != null ? sessao.empresaId : sessao.empresa_id),
    unidadeId: parsePositiveInteger(
      sessao.unidadeId != null ? sessao.unidadeId
        : (sessao.unidade_id != null ? sessao.unidade_id : sessao.unidade_cozinha_id)
    ),
    usuarioId: parsePositiveInteger(sessao.usuarioId != null ? sessao.usuarioId : sessao.usuario_id),
    estabelecido_em: new Date().toISOString()
  };
  return { ..._sessao };
}

module.exports = {
  obterSessaoAutenticadaCozinha,
  limparSessaoAutenticadaCozinha,
  estabelecerSessaoApartirDoToken,
  validarContextoContraSessaoAutenticada,
  _definirSessaoAutenticadaParaTeste
};
