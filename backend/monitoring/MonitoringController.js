/**
 * Controller HTTP do CDS Monitoring Engine.
 */

const { monitoringEngine } = require('./MonitoringEngine');
const { criarMonitoringContext } = require('./MonitoringContext');
const {
  resolverContextoEmpresaOperacional,
  diagnosticarContextoEmpresa,
  contextoPublico
} = require('../services/empresas/ContextoEmpresaOperacionalService');

async function anexarContextoEmpresa(context, req, deps = {}) {
  try {
    context.contextoEmpresa = contextoPublico(await resolverContextoEmpresaOperacional({ req }, deps));
  } catch (err) {
    context.contextoEmpresa = {
      estado: 'CONTEXTO_EMPRESA_INVALIDO',
      codigo: err.code || 'CONTEXTO_EMPRESA_ERRO',
      mensagem: err.message || String(err),
      contextoResolvido: false,
      empresaId: null,
      ambienteFiscal: null,
      ambienteLabel: 'Não configurado',
      certificado: null,
      origens: {}
    };
  }
  return context;
}

async function getSummary(req, res) {
  try {
    const context = await anexarContextoEmpresa(criarMonitoringContext(req), req);
    const result = await monitoringEngine.summary(context);
    const status = result.success ? 200 : 207;
    return res.status(status).json({
      success: result.success,
      timestamp: result.timestamp,
      source: result.source,
      metrics: result.metrics,
      ...result.data,
      warnings: result.warnings,
      errors: result.errors
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Falha ao obter summary do Monitoring Engine',
      error: err.message || String(err)
    });
  }
}

async function getContextoEmpresa(req, res) {
  try {
    const context = criarMonitoringContext(req);
    const diagnostico = await diagnosticarContextoEmpresa({
      req,
      competencia: { ...context.competencia, origem: req.query && (req.query.ano || req.query.mes || req.query.competencia) ? 'parametro ano/mes da requisição' : 'mês corrente (padrão)' }
    });
    return res.json({
      success: true,
      ...diagnostico,
      contexto: contextoPublico(diagnostico.contexto)
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Falha ao diagnosticar contexto de empresa',
      error: err.message || String(err)
    });
  }
}

async function getProviders(_req, res) {
  return res.json({
    success: true,
    providers: monitoringEngine.listProviders()
  });
}

module.exports = {
  getSummary,
  getContextoEmpresa,
  getProviders,
  anexarContextoEmpresa
};
