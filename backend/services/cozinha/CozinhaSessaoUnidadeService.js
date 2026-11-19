/**
 * Sprint 07 · S07-2 — Listagem e seleção de unidade operacional para KDS.
 * Reutiliza validarUnidadeCozinhaNoLogin; emite JWT com o mesmo segredo oficial.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../middleware/auth');
const {
  validarUnidadeCozinhaNoLogin,
  garantirTabelaOperadorUnidades,
  isAdminOperacional,
  parsePositiveInteger
} = require('./cozinhaAuthUnidade');

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function exigirUsuario(user) {
  if (!user || typeof user !== 'object') {
    throw erro('Sessão inválida.', 401, 'SESSAO_INVALIDA');
  }
  const id = Number(user.id != null ? user.id : user.usuario_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro('Sessão sem operador.', 401, 'SESSAO_INVALIDA');
  }
  return { ...user, id, usuario_id: id };
}

/**
 * Claims permitidas na reemissão (whitelist — não copia claims privilegiadas arbitrárias).
 */
function montarClaimsSessao(user, unidadeCozinhaId) {
  const id = Number(user.id || user.usuario_id);
  const terminal = parsePositiveInteger(user.terminal_id);
  const caixa = parsePositiveInteger(user.caixa_sessao_id);
  return {
    id,
    usuario_id: id,
    username: user.username,
    nome: user.nome || user.username,
    role: user.role,
    perfil: user.perfil || 'USUARIO',
    permissoes: Array.isArray(user.permissoes) ? user.permissoes : [],
    terminal_id: terminal,
    caixa_sessao_id: caixa,
    unidade_cozinha_id: unidadeCozinhaId
  };
}

/**
 * Preserva o `exp` original do token quando possível (não amplia nem reduz por conveniência).
 * Fallback: mesma política do login (`8h`) se não houver exp legível.
 */
function emitirJwtComUnidade({ user, unidadeCozinhaId, tokenAtual }) {
  if (!JWT_SECRET) {
    throw erro(
      'Autenticação indisponível: JWT_SECRET não configurado.',
      503,
      'JWT_SECRET_AUSENTE'
    );
  }
  const claims = montarClaimsSessao(user, unidadeCozinhaId);
  let expAbs = null;
  if (tokenAtual) {
    try {
      const decoded = jwt.decode(tokenAtual);
      if (decoded && Number.isFinite(Number(decoded.exp))) {
        expAbs = Number(decoded.exp);
      }
    } catch (_e) { /* ignora */ }
  }
  const agora = Math.floor(Date.now() / 1000);
  if (expAbs != null && expAbs > agora) {
    return jwt.sign({ ...claims, exp: expAbs }, JWT_SECRET);
  }
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '8h' });
}

/**
 * Lista unidades ativas autorizadas na empresa do contexto.
 */
async function listarUnidadesDisponiveis({ user, empresaId }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  const empId = exigirEmpresa(empresaId);
  await garantirTabelaOperadorUnidades(db);

  const adminOperacional = isAdminOperacional(usuario);

  // Contagem da empresa (diagnóstico): distingue ausência de cadastro vs ausência de vínculo.
  const contagem = await all(db, `
    SELECT COUNT(1) AS total
    FROM cozinha_unidades u
    WHERE u.empresa_id = ?
      AND u.ativo = 1
  `, [empId]);
  const unidadesAtivasEmpresa = Number(contagem[0] && contagem[0].total) || 0;

  let rows;
  if (adminOperacional) {
    // Admin/perfil operacional: todas as ativas da empresa — sem vínculo individual.
    rows = await all(db, `
      SELECT u.id, u.codigo, u.empresa_id, u.ativo
      FROM cozinha_unidades u
      WHERE u.empresa_id = ?
        AND u.ativo = 1
      ORDER BY u.codigo ASC, u.id ASC
    `, [empId]);
  } else {
    // Operador comum: somente vínculo ativo na empresa do contexto.
    rows = await all(db, `
      SELECT u.id, u.codigo, u.empresa_id, u.ativo
      FROM cozinha_unidades u
      INNER JOIN cozinha_operador_unidades v
        ON v.unidade_id = u.id
       AND v.empresa_id = u.empresa_id
       AND v.operador_id = ?
       AND v.ativo = 1
      WHERE u.empresa_id = ?
        AND u.ativo = 1
      ORDER BY u.codigo ASC, u.id ASC
    `, [usuario.id, empId]);
  }

  const unidades = (rows || []).map((r) => ({
    id: Number(r.id),
    codigo: r.codigo != null ? String(r.codigo) : null
  }));

  let codigo;
  let mensagem;
  if (!unidades.length) {
    if (unidadesAtivasEmpresa === 0) {
      codigo = 'SEM_UNIDADES_CADASTRADAS';
      mensagem = 'Não há unidades de cozinha cadastradas e ativas nesta empresa. '
        + 'Cadastre uma unidade operacional antes de usar o KDS.';
    } else if (!adminOperacional) {
      codigo = 'SEM_VINCULO_OPERADOR';
      mensagem = 'Nenhuma unidade de cozinha vinculada a este operador nesta empresa. '
        + 'Solicite o vínculo ativo ao administrador.';
    } else {
      codigo = 'SEM_UNIDADES_DISPONIVEIS';
      mensagem = 'Nenhuma unidade de cozinha autorizada para este usuário nesta empresa.';
    }
  }

  return {
    success: true,
    empresa_id: empId,
    admin_operacional: adminOperacional,
    unidades_ativas_empresa: unidadesAtivasEmpresa,
    unidades,
    codigo,
    mensagem
  };
}

/**
 * Valida unidade novamente e emite novo JWT contextualizado.
 */
async function selecionarUnidadeSessao({
  user,
  empresaId,
  unidadeCozinhaIdRaw,
  tokenAtual
}, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  const empId = exigirEmpresa(empresaId);

  const unidadeValidada = await validarUnidadeCozinhaNoLogin({
    db,
    usuario,
    unidadeCozinhaIdRaw,
    empresaIdRaw: empId
  });

  if (unidadeValidada == null) {
    throw erro(
      'unidade_cozinha_id é obrigatória.',
      400,
      'UNIDADE_OBRIGATORIA'
    );
  }

  const token = emitirJwtComUnidade({
    user: usuario,
    unidadeCozinhaId: unidadeValidada,
    tokenAtual
  });

  const userOut = {
    id: usuario.id,
    usuario_id: usuario.id,
    username: usuario.username,
    nome: usuario.nome || usuario.username,
    role: usuario.role,
    perfil: usuario.perfil || 'USUARIO',
    permissoes: Array.isArray(usuario.permissoes) ? usuario.permissoes : [],
    terminal_id: parsePositiveInteger(usuario.terminal_id),
    caixa_sessao_id: parsePositiveInteger(usuario.caixa_sessao_id),
    unidade_cozinha_id: unidadeValidada
  };

  return {
    success: true,
    token,
    user: userOut,
    unidade_cozinha_id: unidadeValidada,
    empresa_id: empId
  };
}

module.exports = {
  listarUnidadesDisponiveis,
  selecionarUnidadeSessao,
  emitirJwtComUnidade,
  montarClaimsSessao
};
