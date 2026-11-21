'use strict';

const db = require('../database');
const {
  normalizarInstallationId,
  MOBILE_HOST_PREFIX
} = require('../services/TerminalPdvMobileService');
const {
  resolverEmpresaIdParaCaixa,
  statusDeErroEmpresa
} = require('../services/caixa/CaixaEmpresaContextoService');
const UsuarioEmpresaService = require('../services/empresas/UsuarioEmpresaService');
const { parsePositiveInteger } = require('../utils/multiCaixa');

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function obterTerminalId(req) {
  return parsePositiveInteger(
    req.body?.terminal_id
      || req.query?.terminal_id
      || req.headers['x-terminal-id']
      || req.user?.terminal_id
  );
}

function responderErro(res, err) {
  const status = Number(err && (err.status || err.statusCode))
    || statusDeErroEmpresa(err)
    || 500;
  if (status >= 500) console.error('Erro ao validar terminal Mobile:', err);
  return res.status(status).json({
    error: err && err.message ? err.message : 'Erro ao validar terminal Mobile.',
    code: err && err.code ? err.code : 'TERMINAL_MOBILE_VALIDACAO_ERRO'
  });
}

async function validarTerminalMobile(req, res, next) {
  const terminalId = obterTerminalId(req);
  const installationIdRaw = req.headers['x-mobile-installation-id'];
  const installationId = installationIdRaw
    ? normalizarInstallationId(installationIdRaw)
    : null;

  if (installationIdRaw && !installationId) {
    return res.status(400).json({
      error: 'Identidade da instalação Mobile inválida.',
      code: 'IDENTIDADE_MOBILE_INVALIDA'
    });
  }
  if (installationId && !terminalId) {
    return res.status(400).json({
      error: 'terminal_id é obrigatório para esta instalação Mobile.',
      code: 'TERMINAL_ID_OBRIGATORIO'
    });
  }
  if (!terminalId && !installationId) return next();

  try {
    const terminal = await dbGet(
      `SELECT id, hostname, usuario_id, ativo
       FROM terminais WHERE id = ?`,
      [terminalId]
    );
    if (!terminal) {
      if (installationId) {
        return res.status(404).json({
          error: 'Terminal Mobile não encontrado.',
          code: 'TERMINAL_MOBILE_NAO_ENCONTRADO'
        });
      }
      return next();
    }

    const ehMobile = String(terminal.hostname || '').startsWith(MOBILE_HOST_PREFIX);
    if (!installationId) {
      if (ehMobile) {
        return res.status(403).json({
          error: 'A instalação Mobile não foi confirmada.',
          code: 'IDENTIDADE_MOBILE_OBRIGATORIA'
        });
      }
      return next();
    }

    const reqUserId = Number(req.user && (req.user.id || req.user.usuario_id));
    const hostnameEsperado = MOBILE_HOST_PREFIX + installationId;
    if (!ehMobile || terminal.hostname !== hostnameEsperado || Number(terminal.id) !== terminalId) {
      return res.status(403).json({
        error: 'terminal_id não corresponde a esta instalação Mobile.',
        code: 'TERMINAL_MOBILE_DIVERGENTE'
      });
    }
    if (!Number.isInteger(reqUserId) || reqUserId <= 0
      || Number(terminal.usuario_id) !== reqUserId) {
      return res.status(403).json({
        error: 'Este terminal Mobile pertence a outro usuário.',
        code: 'TERMINAL_MOBILE_NAO_AUTORIZADO'
      });
    }
    if (Number(terminal.ativo) !== 1) {
      return res.status(403).json({
        error: 'Terminal Mobile inativo.',
        code: 'TERMINAL_MOBILE_INATIVO'
      });
    }

    const contexto = await resolverEmpresaIdParaCaixa(req, { db });
    await UsuarioEmpresaService.exigirEmpresaAutorizada(req.user, contexto.empresaId, { db });

    const sessaoOutraEmpresa = await dbGet(
      `SELECT id, empresa_id FROM caixa_sessoes
       WHERE terminal_id = ? AND status = 'aberto' AND empresa_id != ?
       ORDER BY id DESC LIMIT 1`,
      [terminalId, contexto.empresaId]
    );
    if (sessaoOutraEmpresa) {
      return res.status(403).json({
        error: 'O terminal Mobile já possui uma sessão de caixa aberta em outra empresa.',
        code: 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
      });
    }

    req.terminalId = terminalId;
    req.mobileInstallationId = installationId;
    req.mobileEmpresaId = contexto.empresaId;
    return next();
  } catch (err) {
    return responderErro(res, err);
  }
}

module.exports = validarTerminalMobile;
