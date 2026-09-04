/**
 * Contexto empresarial do MIS (Bloco 4).
 * Reutiliza o resolver de venda/contrato. Não cria contexto HTTP próprio.
 * Autorização via usuario_empresas (inclusive EMPRESA_SIMPLES).
 *
 * @module services/mis/MisEmpresaContextoService
 */
'use strict';

const {
  resolverEmpresaIdParaVenda,
  statusDeErroEmpresaVenda,
  responderErroEmpresaVenda
} = require('../vendas/VendaEmpresaContextoService');

/**
 * Resolve a empresa do MIS: EMPRESA_SIMPLES → empresa_operacional_id;
 * MULTIEMPRESA → req.empresaId / X-Empresa-Id.
 * Sem primeira empresa, empresa 1 ou COMPAT.
 */
async function resolverEmpresaIdParaMis(req, deps = {}) {
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
        || require('../empresas/UsuarioEmpresaService');
      await UsuarioEmpresaService.exigirEmpresaAutorizada(uid, resolved.empresaId, { db });
    }
  }

  return resolved;
}

module.exports = {
  resolverEmpresaIdParaMis,
  statusDeErroEmpresaMis: statusDeErroEmpresaVenda,
  responderErroEmpresaMis: responderErroEmpresaVenda
};
