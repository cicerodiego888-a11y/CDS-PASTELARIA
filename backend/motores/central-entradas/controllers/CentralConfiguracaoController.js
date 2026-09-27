/**
 * CentralConfiguracaoController — HTTP da Configuração Enterprise (RC4).
 *
 * @module motores/central-entradas/controllers/CentralConfiguracaoController
 */

const CentralConfiguracaoService = require('../services/CentralConfiguracaoService');
const { logCentralErro } = require('../utils/centralLog');

class CentralConfiguracaoController {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    /** @private */
    this._service = deps.configuracaoService ?? new CentralConfiguracaoService();
    /** @private */
    this._orchestrator = deps.orchestrator || null;
    /** @private */
    this._resolverEmpresa = deps.resolverEmpresa || ((req) => {
      const { resolverEmpresaParaCentral } = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');
      return resolverEmpresaParaCentral({ req, empresaId: req.empresaId });
    });
    /** @private — cadeia única de contexto (matriz padrão na visão global) */
    this._resolverContextoEmpresa = deps.resolverContextoEmpresa || ((params) => {
      const { resolverContextoEmpresaOperacional } = require('../../../services/empresas/ContextoEmpresaOperacionalService');
      return resolverContextoEmpresaOperacional(params);
    });
  }

  /** @private */
  async _contextoEmpresaPublico(params) {
    try {
      const { contextoPublico } = require('../../../services/empresas/ContextoEmpresaOperacionalService');
      return contextoPublico(await this._resolverContextoEmpresa(params));
    } catch {
      return null;
    }
  }

  /**
   * Painel: sem seleção explícita no MULTIEMPRESA, abre na matriz resolvida pelo contexto único.
   * Sem matriz válida mantém EMPRESA_NAO_SELECIONADA. Ações (testar SEFAZ/certificado)
   * continuam exigindo empresa explícita.
   * @private
   */
  async _empresaDoPainel(req) {
    const r = await this._empresaDaRequisicao(req);
    if (r.empresa) {
      r.contextoEmpresa = await this._contextoEmpresaPublico({ req, empresaId: r.empresa.empresaId });
      return r;
    }
    if (r.empresaErro && r.empresaErro.codigo === 'EMPRESA_CENTRAL_AUSENTE') {
      const ctx = await this._contextoEmpresaPublico({ req });
      if (ctx && ctx.empresaId != null) {
        return {
          empresa: {
            empresaId: ctx.empresaId,
            cnpj: ctx.cnpj || null,
            modo: ctx.modo,
            origem: ctx.origens && ctx.origens.origemEmpresa
          },
          contextoEmpresa: ctx
        };
      }
      if (ctx && ctx.codigo) {
        r.empresaErro = { codigo: ctx.codigo, mensagem: ctx.mensagem || r.empresaErro.mensagem };
      }
      r.contextoEmpresa = ctx;
    }
    return r;
  }

  /** @private */
  _orch() {
    return this._orchestrator || require('../CentralEntradasOrchestrator');
  }

  /**
   * CE-06 — empresa da requisição (seletor global / X-Empresa-Id).
   * Falha de resolução vira estado explícito; nunca cai na configuração global.
   * @private
   */
  async _empresaDaRequisicao(req) {
    try {
      const r = await this._resolverEmpresa(req);
      return { empresa: { empresaId: r.empresaId, cnpj: r.cnpj || null, modo: r.modo } };
    } catch (error) {
      return {
        empresaErro: {
          codigo: error.code || 'EMPRESA_CENTRAL_AUSENTE',
          mensagem: error.message || 'Empresa não selecionada.'
        }
      };
    }
  }

  async obter(req, res) {
    try {
      const alvo = await this._empresaDoPainel(req);
      const painel = await this._service.obterPainelCompleto({
        empresa: alvo.empresa,
        empresaErro: alvo.empresaErro
      });
      return res.json({ ...painel, contextoEmpresa: alvo.contextoEmpresa || null });
    } catch (error) {
      logCentralErro('CONFIG', error);
      return res.status(500).json({
        sucesso: false,
        mensagemAmigavel: 'Não foi possível carregar a configuração da Central.',
        error: error.message
      });
    }
  }

  async atualizar(req, res) {
    try {
      const painel = await this._service.atualizar(req.body || {});
      const { emitirEvento, TIPOS_EVENTO } = require('../utils/centralEventosEmitter');
      await emitirEvento({
        tipo: TIPOS_EVENTO.CONFIG_ALTERADA,
        origem: 'api',
        descricao: 'Configuração Enterprise da Central atualizada',
        resultado: 'sucesso',
        sucesso: true,
        usuarioId: req.user?.id || null,
        detalhe: { campos: Object.keys(req.body || {}) }
      });
      try {
        await this._orch()._obterSyncBackground?.().reiniciar?.();
      } catch {
        const bg = require('../services/CentralSyncBackgroundService');
        if (typeof bg.reiniciar === 'function') await bg.reiniciar();
      }
      return res.json(painel);
    } catch (error) {
      logCentralErro('CONFIG', error);
      return res.status(400).json({
        sucesso: false,
        mensagemAmigavel: error.message || 'Falha ao salvar configuração.',
        error: error.message
      });
    }
  }

  async restaurarPadrao(req, res) {
    try {
      const painel = await this._service.restaurarPadrao(req.body || {});
      return res.json(painel);
    } catch (error) {
      return res.status(500).json({ sucesso: false, error: error.message });
    }
  }

  async testarSefaz(req, res) {
    try {
      const resultado = await this._orch().testarSefazDiagnostico(await this._empresaDaRequisicao(req));
      return res.json(resultado);
    } catch (error) {
      return res.status(422).json({
        sucesso: false,
        mensagemAmigavel: error.message,
        error: error.message
      });
    }
  }

  async testarCertificado(req, res) {
    try {
      const resultado = await this._orch().testarCertificadoDiagnostico(await this._empresaDaRequisicao(req));
      return res.json(resultado);
    } catch (error) {
      return res.status(422).json({
        sucesso: false,
        mensagemAmigavel: error.message,
        error: error.message
      });
    }
  }

  async health(req, res) {
    try {
      const resultado = await this._orch().executarHealthCheckDiagnostico();
      return res.json(resultado);
    } catch (error) {
      return res.status(500).json({ sucesso: false, error: error.message });
    }
  }

  async limparCache(req, res) {
    try {
      const resultado = this._orch().limparCacheDiagnostico();
      return res.json(resultado);
    } catch (error) {
      return res.status(500).json({ sucesso: false, error: error.message });
    }
  }
}

module.exports = CentralConfiguracaoController;
