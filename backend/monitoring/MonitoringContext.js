/**
 * Contexto de consulta do Monitoring Engine.
 * Carrega escopo, usuário, flags de visualização e competência fiscal — sem SQL.
 */

const { resolverCompetencia } = require('./monitoringDateHelpers');
const {
  resolverEmpresaId,
  resolverEmpresaIdDaRequisicao
} = require('../services/fiscalNaoFiscal/empresaContexto');

function criarMonitoringContext(req = {}, extras = {}) {
  const query = req.query || {};
  const usuario = req.usuario || req.user || {};
  const competencia = resolverCompetencia({
    ano: query.ano,
    mes: query.mes,
    competencia: query.competencia
  });
  const empresaId = resolverEmpresaId(req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req)
    ?? resolverEmpresaId(extras.empresaId);

  return {
    requestId: extras.requestId || `mon-${Date.now()}`,
    usuarioId: usuario.id || null,
    perfil: usuario.perfil || null,
    role: usuario.role || null,
    permissoes: usuario.permissoes || [],
    empresaId: empresaId != null ? empresaId : null,
    headers: req.headers || {},
    user: usuario,
    modoFiscalUi: query.modo_fiscal === '1' || query.modo_fiscal === 'true',
    competencia,
    ano: competencia.ano,
    mes: competencia.mes,
    agora: new Date(),
    extras: { ...extras }
  };
}

module.exports = {
  criarMonitoringContext,
  MonitoringContext: { create: criarMonitoringContext }
};
