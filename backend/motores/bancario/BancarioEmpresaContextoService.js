/**
 * Contexto empresarial do Motor Bancário.
 * Reutiliza o resolver oficial de venda + UsuarioEmpresaService.
 * Sem empresa_id=1. Sem inferir empresa pelo usuário.
 * @module motores/bancario/BancarioEmpresaContextoService
 */
'use strict';

const {
  resolverEmpresaIdParaVenda,
  statusDeErroEmpresaVenda
} = require('../../services/vendas/VendaEmpresaContextoService');

async function resolverEmpresaIdParaBancario(req, deps = {}) {
  const db = deps.db || (req && req.db) || null;
  const resolved = await resolverEmpresaIdParaVenda(req, {
    ...deps,
    db,
    exigirAutorizacaoUsuario: false
  });

  if (deps.exigirAutorizacaoUsuario !== false && req && req.user) {
    const uid = req.user.id != null ? req.user.id : req.user.usuario_id;
    if (uid) {
      const UsuarioEmpresaService = deps.UsuarioEmpresaService
        || require('../../services/empresas/UsuarioEmpresaService');
      await UsuarioEmpresaService.exigirEmpresaAutorizada(uid, resolved.empresaId, { db });
    }
  }

  return resolved;
}

module.exports = {
  resolverEmpresaIdParaBancario,
  statusDeErroEmpresaBancario: statusDeErroEmpresaVenda
};
