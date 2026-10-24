/**
 * CentralConfiguracaoService — Provider operacional da Central (RC4 + RC3.1).
 *
 * RC3.1 — Fonte fiscal única:
 *   Ambiente SEFAZ + UF emitente + certificado + CNPJ vêm exclusivamente de
 *   getFiscalConfig() (Configurações Avançadas → fiscal_ambiente / fiscal_uf_*).
 *   A Central NÃO persiste nem grava ambiente/UF emitente.
 *
 * Endpoints DF-e e Manifestação (SOAP) vêm exclusivamente do UrlResolver (Plataforma Fiscal).
 * Timeouts, sync, proxy e debug permanecem na tabela central_entradas_config.
 *
 * Demais módulos da Central NÃO devem importar getFiscalConfig diretamente —
 * consomem via obterContextoOperacional() / obterPainelCompleto().
 *
 * @module motores/central-entradas/services/CentralConfiguracaoService
 */

const path = require('path');
const fs = require('fs');
const CentralConfiguracaoRepository = require('../repositories/CentralConfiguracaoRepository');
const CentralConfigService = require('./CentralConfigService');
const centralEntradasFlags = require('../config/centralEntradasFlags');
const { logCentral, logCentralErro } = require('../utils/centralLog');

const CHAVES = Object.freeze({
  URL_DFE_PROD: 'sefaz_url_dfe_producao',
  URL_DFE_HOM: 'sefaz_url_dfe_homologacao',
  URL_CONSULTA_PROD: 'sefaz_url_consulta_chave_producao',
  URL_CONSULTA_HOM: 'sefaz_url_consulta_chave_homologacao',
  URL_MANIF_PROD: 'sefaz_url_manifestacao_producao',
  URL_MANIF_HOM: 'sefaz_url_manifestacao_homologacao',
  VERSAO_SERVICO: 'sefaz_versao_servico',
  TIMEOUT_MS: 'sefaz_timeout_ms',
  MAX_TENTATIVAS: 'sefaz_max_tentativas',
  INTERVALO_TENTATIVAS: 'sefaz_intervalo_tentativas_ms',
  POLITICA_MANIFESTACAO: 'manifestacao_destinatario_politica',
  REPROCESSAMENTO: 'sync_reprocessamento_automatico',
  HTTP_TIMEOUT: 'http_timeout_ms',
  HTTP_RETRY: 'http_retry',
  PROXY_HAB: 'proxy_habilitado',
  PROXY_URL: 'proxy_url',
  LOG_DETALHADO: 'log_detalhado',
  MODO_DEBUG: 'modo_debug',
  RECUP_XML_ATIVA: 'recuperacao_xml_ativa',
  RECUP_XML_INTERVALO: 'recuperacao_xml_intervalo_minutos',
  RECUP_XML_MAX_TENT: 'recuperacao_xml_max_tentativas',
  RECUP_XML_MAX_DIAS: 'recuperacao_xml_max_dias_monitoramento',
  RECUP_XML_LOTE: 'recuperacao_xml_lote_por_ciclo'
});

const POLITICAS_MANIFESTACAO = Object.freeze([
  'MANUAL',
  'AUTOMATICA_CIENCIA',
  'CONFIRMAR_OPERADOR'
]);

/** Campos de endpoint SOAP que a Central não persiste nem usa (UrlResolver). */
const CAMPOS_ENDPOINT_SOAP_IGNORADOS = Object.freeze([
  'urlDistribuicaoDfeProducao',
  'urlDistribuicaoDfeHomologacao',
  'urlConsultaChaveProducao',
  'urlConsultaChaveHomologacao',
  'urlManifestacaoProducao',
  'urlManifestacaoHomologacao'
]);

/**
 * Campos oficiais do cadastro fiscal — Central só consome (RC3.1).
 * Também ignora chaves legadas no flat do PUT.
 */
const CAMPOS_FISCAL_SOMENTE_LEITURA = Object.freeze([
  'ambiente',
  'uf',
  'codigoUf',
  'codigo',
  'central_ambiente',
  'central_uf',
  'central_codigo_uf'
]);

class CentralConfiguracaoService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    /** @private */
    this._db = deps.db ?? null;
    /** @private */
    this._repository = deps.configuracaoRepository
      ?? deps.configRepository
      ?? new CentralConfiguracaoRepository();
    /** @private */
    this._syncConfig = deps.syncConfigService
      ?? new CentralConfigService({
        configRepository: this._repository,
        flags: deps.flags ?? centralEntradasFlags
      });
    /** @private */
    this._flags = deps.flags ?? centralEntradasFlags;
    /** @private */
    this._getFiscalConfig = deps.getFiscalConfig
      || ((opts = {}) => require('../../../services/fiscal/configService').getFiscalConfig({
        validarUrls: false,
        ...opts
      }));
    /** @private — testes: loader por empresaId + conexão SQLite */
    this._obterFiscalEmpresa = typeof deps.obterFiscalEmpresa === 'function'
      ? deps.obterFiscalEmpresa
      : null;
    /** @private */
    this._carregarCertificado = deps.carregarCertificado
      || ((p, s) => require('../../../services/fiscal/certificateService').carregarCertificadoPfx(p, s));
    /** @private — testes: CNPJ oficial de empresas.cnpj */
    this._obterCnpjEmpresa = typeof deps.obterCnpjEmpresa === 'function'
      ? deps.obterCnpjEmpresa
      : null;
  }

  /**
   * CNPJ oficial do cadastro da empresa (`empresas.cnpj`).
   * Normaliza só em memória — não grava o valor.
   * @private
   */
  async _obterCnpjCadastroEmpresa(empresaId, opcoes = {}) {
    if (typeof this._obterCnpjEmpresa === 'function') {
      const bruto = await this._obterCnpjEmpresa({
        empresaId,
        db: this._resolverConexaoSqlite(opcoes)
      });
      return String(bruto || '').replace(/\D/g, '');
    }
    try {
      const EmpresaService = require('../../../services/empresas/EmpresaService');
      const empresa = await EmpresaService.buscarEmpresaPorId(empresaId, {
        db: this._resolverConexaoSqlite(opcoes)
      });
      return String((empresa && empresa.cnpj) || '').replace(/\D/g, '');
    } catch {
      return '';
    }
  }

  /**
   * Conexão SQLite para ler empresas_configuracao_fiscal.
   * Não é um banco por CNPJ: é a conexão do ERP (mesma tabela, filtro empresa_id).
   * Ordem: db da chamada → db do serviço → resolver oficial da Central (database.js).
   * Não reutiliza conexão de outra iteração armazenada no serviço.
   */
  _resolverConexaoSqlite(opcoes = {}) {
    if (opcoes.db) return opcoes.db;
    if (this._db) return this._db;
    const { resolverDb } = require('../repositories/dbHelpers');
    return resolverDb(null);
  }

  async _carregarFiscalDaEmpresa(empresaId, opcoes = {}) {
    const db = this._resolverConexaoSqlite(opcoes);
    if (typeof this._obterFiscalEmpresa === 'function') {
      return this._obterFiscalEmpresa({ empresaId, db });
    }
    return this._getFiscalConfig({
      empresaId,
      db,
      validarUrls: false
    });
  }

  /**
   * @param {Object} [opcoes]
   * @param {{ empresaId?: number|null, cnpj?: string|null, modo?: string }} [opcoes.empresa]
   *   empresa resolvida pela rota (CE-06 P04/P09) — painel passa a ser por empresa.
   * @param {{ codigo: string, mensagem: string }} [opcoes.empresaErro]
   *   empresa não resolvida (ex.: EMPRESA_CENTRAL_AUSENTE no MULTIEMPRESA).
   * @returns {Promise<Object>}
   */
  async obterPainelCompleto(opcoes = {}) {
    await this._repository.ensureDefaults();
    const porEmpresa = Boolean(opcoes.empresa || opcoes.empresaErro);
    const [sync, mapa, certificadoGlobal, meta, fiscalSnap, empresaContexto] = await Promise.all([
      this._syncConfig.obterResumo(),
      this._obterMapaValores(),
      porEmpresa ? null : this._obterVisaoCertificado(),
      this._obterMetadadosAlteracao(),
      porEmpresa ? null : this._obterSnapshotFiscal(),
      porEmpresa ? this.obterContextoEmpresaPainel(opcoes) : null
    ]);

    const certificado = porEmpresa ? empresaContexto.certificado : certificadoGlobal;
    const ambienteCode = porEmpresa ? empresaContexto.ambiente.codigo : fiscalSnap.ambiente;
    const ambientePainel = porEmpresa
      ? {
        ...empresaContexto.ambiente,
        somenteLeitura: true,
        atualizadoEm: meta.atualizadoEm,
        ultimaAlteracao: meta.ultimaAlteracao
      }
      : {
        codigo: ambienteCode,
        label: ambienteCode === 1 ? 'Produção' : 'Homologação',
        uf: fiscalSnap.uf,
        codigoUf: fiscalSnap.codigoUf,
        somenteLeitura: true,
        origem: 'getFiscalConfig',
        origemLabel: 'Configuração fiscal global (Centro de Configurações)',
        atualizadoEm: meta.atualizadoEm,
        ultimaAlteracao: meta.ultimaAlteracao
      };
    const escolherUrl = (urls) => {
      if (ambienteCode == null) return null;
      return ambienteCode === 1 ? urls.producao : urls.homologacao;
    };
    const endpointsDfe = this._resolverEndpointsDfe();
    const endpointsManif = this._resolverEndpointsManifestacao();
    const endpointsConsulta = this._resolverEndpointsConsultaChave();
    const politicaManifestacao = POLITICAS_MANIFESTACAO.includes(mapa[CHAVES.POLITICA_MANIFESTACAO])
      ? mapa[CHAVES.POLITICA_MANIFESTACAO]
      : 'MANUAL';

    return {
      versaoConfiguracao: 'RC4',
      unificacaoFiscal: 'RC3.1',
      ambiente: ambientePainel,
      empresaContexto,
      sefaz: {
        urlDistribuicaoDfe: escolherUrl(endpointsDfe),
        urlDistribuicaoDfeProducao: endpointsDfe.producao,
        urlDistribuicaoDfeHomologacao: endpointsDfe.homologacao,
        origemEndpointDfe: 'UrlResolver',
        endpointsEditaveis: false,
        // RC4.3.1 — Consulta chave somente leitura via Registry → UrlResolver
        urlConsultaChave: escolherUrl(endpointsConsulta),
        urlConsultaChaveProducao: endpointsConsulta.producao,
        urlConsultaChaveHomologacao: endpointsConsulta.homologacao,
        origemEndpointConsulta: 'UrlResolver',
        endpointConsultaResolvido: Boolean(endpointsConsulta.producao && endpointsConsulta.homologacao),
        // RC4.1 — URLs de Manifestação somente leitura, resolvidas via Registry → UrlResolver
        urlManifestacao: escolherUrl(endpointsManif),
        urlManifestacaoProducao: endpointsManif.producao,
        urlManifestacaoHomologacao: endpointsManif.homologacao,
        origemEndpointManifestacao: 'UrlResolver',
        endpointManifestacaoResolvido: Boolean(endpointsManif.producao && endpointsManif.homologacao),
        versaoServico: mapa[CHAVES.VERSAO_SERVICO] || '1.01',
        timeoutMs: Number(mapa[CHAVES.TIMEOUT_MS]) || 90000,
        maxTentativas: Number(mapa[CHAVES.MAX_TENTATIVAS]) || 2,
        intervaloTentativasMs: Number(mapa[CHAVES.INTERVALO_TENTATIVAS]) || 3000,
        manifestacaoPreparada: true,
        // Compat: "ativa" = automática; UI RC4.1 usa politicaManifestacao (um único estado)
        manifestacaoAtiva: politicaManifestacao === 'AUTOMATICA_CIENCIA',
        politicaManifestacao,
        politicaManifestacaoLabel: this._labelPoliticaManifestacao(politicaManifestacao),
        politicasManifestacaoDisponiveis: [...POLITICAS_MANIFESTACAO]
      },
      plataformaFiscal: {
        registry: true,
        urlResolver: true,
        soapTransport: true,
        endpointResolvido: Boolean(
          escolherUrl(endpointsDfe)
          && escolherUrl(endpointsManif)
          && escolherUrl(endpointsConsulta)
        ),
        modo: this._labelPoliticaManifestacao(politicaManifestacao),
        modoCodigo: politicaManifestacao
      },
      certificado,
      sincronizacao: {
        ...sync,
        reprocessamentoAutomatico: mapa[CHAVES.REPROCESSAMENTO] !== false
      },
      recuperacaoXml: {
        ativa: mapa[CHAVES.RECUP_XML_ATIVA] !== false,
        intervaloMinutos: Number(mapa[CHAVES.RECUP_XML_INTERVALO]) || 60,
        maxTentativas: Number(mapa[CHAVES.RECUP_XML_MAX_TENT]) || 48,
        maxDiasMonitoramento: Number(mapa[CHAVES.RECUP_XML_MAX_DIAS]) || 30,
        lotePorCiclo: Number(mapa[CHAVES.RECUP_XML_LOTE]) || 5,
        intervalosPermitidos: [30, 60, 120, 360, 1440]
      },
      diagnostico: await this._obterResumoDiagnostico(),
      avancado: {
        httpTimeoutMs: Number(mapa[CHAVES.HTTP_TIMEOUT]) || 90000,
        httpRetry: Number(mapa[CHAVES.HTTP_RETRY]) || 2,
        proxyHabilitado: mapa[CHAVES.PROXY_HAB] === true,
        proxyUrl: mapa[CHAVES.PROXY_URL] || '',
        proxyFuncional: false,
        logDetalhado: mapa[CHAVES.LOG_DETALHADO] === true,
        modoDebug: mapa[CHAVES.MODO_DEBUG] === true
      },
      certificadosFiliais: certificado.presente
        ? [{
          id: porEmpresa ? `empresa:${empresaContexto.empresaId}` : 'principal',
          nome: certificado.nome || 'Principal',
          cnpj: certificado.cnpj,
          status: certificado.status
        }]
        : [],
      preparadoPara: ['manifestacao', 'cte', 'mdfe', 'nfse', 'multiplos_cnpjs', 'proxy']
    };
  }

  /**
   * CE-06 P04/P09 — ambiente e certificado da empresa selecionada, via
   * obterContextoOperacional({ empresaId, permitirFallbackGlobal:false }) no MULTIEMPRESA.
   * Nunca expõe senha; sem empresa não há fallback para a configuração global.
   * @param {Object} opcoes  mesmo formato de obterPainelCompleto
   * @returns {Promise<Object>}
   */
  async obterContextoEmpresaPainel(opcoes = {}) {
    const { ModoOperacionalGlobal } = require('../../../core/modo-operacional');
    const empresa = opcoes.empresa || {};
    const empresaId = Number(empresa.empresaId);
    const multiempresa = empresa.modo
      ? empresa.modo === ModoOperacionalGlobal.MULTIEMPRESA
      : true;
    const semContexto = (estado, codigo, mensagem) => ({
      estado,
      codigo,
      mensagem,
      selecionada: estado !== 'EMPRESA_NAO_SELECIONADA',
      empresaId: Number.isInteger(empresaId) && empresaId > 0 ? empresaId : null,
      cnpj: empresa.cnpj ? String(empresa.cnpj).replace(/\D/g, '') : null,
      modo: empresa.modo || null,
      ambiente: {
        codigo: null,
        label: estado === 'EMPRESA_NAO_SELECIONADA' ? 'Empresa não selecionada' : 'Contexto não resolvido',
        uf: null,
        codigoUf: null,
        origem: null,
        origemLabel: mensagem
      },
      certificado: {
        presente: false,
        empresaId: Number.isInteger(empresaId) && empresaId > 0 ? empresaId : null,
        nome: null,
        cnpj: null,
        validade: null,
        diasRestantes: null,
        status: estado,
        caminho: null,
        mensagem
      }
    });

    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      const erro = opcoes.empresaErro || {};
      return semContexto(
        'EMPRESA_NAO_SELECIONADA',
        erro.codigo || 'EMPRESA_CENTRAL_AUSENTE',
        erro.mensagem || 'Selecione uma empresa para visualizar ambiente e certificado da Central.'
      );
    }

    const resultado = await this.obterContextoOperacional({
      empresaId,
      permitirFallbackGlobal: !multiempresa
    });
    if (!resultado?.ok || !resultado.contexto) {
      return semContexto(
        'CONTEXTO_NAO_RESOLVIDO',
        resultado?.codigoErro || 'CONFIG_FISCAL',
        `Contexto fiscal não resolvido para a empresa ${empresaId}: ${resultado?.mensagem || 'configuração incompleta.'}`
      );
    }

    const ctx = resultado.contexto;
    const ambiente = Number(ctx.ambiente) === 1 ? 1 : 2;
    const daEmpresa = ctx.origemAmbiente === 'empresas_configuracao_fiscal';
    const visao = await this._montarVisaoCertificado({
      certificadoPath: ctx.certificadoPath,
      certificadoSenha: ctx.certificadoSenha,
      cnpj: ctx.cnpj,
      certificadoValidacaoStatus: ctx.certificadoValidacaoStatus,
      certificadoValidadeAte: ctx.certificadoValidadeAte,
      certificadoCnpj: ctx.certificadoCnpj,
      certificadoTitular: ctx.certificadoTitular,
      certificadoValidacaoMensagem: ctx.certificadoValidacaoMensagem
    });
    return {
      estado: 'OK',
      codigo: null,
      mensagem: null,
      selecionada: true,
      empresaId,
      cnpj: ctx.cnpj,
      modo: empresa.modo || null,
      ambiente: {
        codigo: ambiente,
        label: ambiente === 1 ? 'Produção' : 'Homologação',
        uf: ctx.uf || null,
        codigoUf: ctx.codigoUf || null,
        origem: ctx.origemAmbiente,
        origemLabel: daEmpresa
          ? `Configuração fiscal da empresa ${empresaId}`
          : 'Configuração fiscal global (empresa simples)'
      },
      certificado: {
        ...visao,
        empresaId,
        caminho: null,
        arquivo: ctx.certificadoPath ? path.basename(ctx.certificadoPath) : null
      }
    };
  }

  /**
   * Contexto operacional para sync/SOAP — único contrato interno.
   * Ambiente/UF/certificado/CNPJ:
   *   - com empresaId e config fiscal empresarial completa → empresas_configuracao_fiscal
   *   - EMPRESA_SIMPLES / fallback → getFiscalConfig (RC3.1, transparência)
   * @param {Object} [opcoes]
   * @param {number|string} [opcoes.empresaId]
   * @param {boolean} [opcoes.permitirFallbackGlobal=true]
   * @returns {Promise<{ ok: boolean, codigoErro?: string, mensagem?: string, contexto?: Object }>}
   */
  async obterContextoOperacional(opcoes = {}) {
    await this._repository.ensureDefaults();
    const mapa = await this._obterMapaValores();
    const sync = await this._syncConfig.obterResumo();

    const empresaInformada = opcoes.empresaId != null && String(opcoes.empresaId).trim() !== '';
    const empresaIdOpcao = empresaInformada ? Number(opcoes.empresaId) : null;
    const permitirFallbackGlobal = opcoes.permitirFallbackGlobal !== false;

    let fiscal = {};
    let origemAmbiente = 'getFiscalConfig';
    let origemCnpj = null;
    let empresaIdContexto = Number.isInteger(empresaIdOpcao) && empresaIdOpcao > 0
      ? empresaIdOpcao
      : null;

    if (empresaInformada && !empresaIdContexto) {
      return {
        ok: false,
        codigoErro: 'EMPRESA_CENTRAL_INVALIDA',
        mensagem: 'empresaId inválido para sincronização DF-e. Selecione a empresa correta.'
      };
    }

    let cnpjOficial = '';
    if (empresaIdContexto) {
      cnpjOficial = await this._obterCnpjCadastroEmpresa(empresaIdContexto, opcoes);
      if (cnpjOficial.length === 14) origemCnpj = 'empresas';

      try {
        const cfgEmp = await this._carregarFiscalDaEmpresa(empresaIdContexto, opcoes);
        const cnpjEmp = cnpjOficial || String(cfgEmp.cnpj || '').replace(/\D/g, '');
        if (cnpjEmp.length === 14) {
          cnpjOficial = cnpjEmp;
          origemCnpj = origemCnpj || 'empresas';
        }
        fiscal = {
          certificadoPath: cfgEmp.certificadoPath,
          certificadoSenha: cfgEmp.certificadoSenha,
          certificadoValidacaoStatus: cfgEmp.certificadoValidacaoStatus,
          certificadoValidadeAte: cfgEmp.certificadoValidadeAte,
          certificadoCnpj: cfgEmp.certificadoCnpj,
          certificadoTitular: cfgEmp.certificadoTitular,
          certificadoValidacaoMensagem: cfgEmp.certificadoValidacaoMensagem,
          cnpj: cnpjEmp,
          fiscal_ambiente: cfgEmp.ambiente,
          ambiente: cfgEmp.ambiente,
          fiscal_codigo_uf: cfgEmp.codigoUf,
          codigo_uf: cfgEmp.codigoUf,
          fiscal_uf: cfgEmp.uf,
          uf: cfgEmp.uf
        };
        origemAmbiente = 'empresas_configuracao_fiscal';
      } catch (error) {
        if (!permitirFallbackGlobal) {
          return {
            ok: false,
            codigoErro: error.code || 'CONFIG_FISCAL',
            mensagem: `Configuração fiscal da empresa ${empresaIdContexto} não encontrada. ${this._mensagemAmigavel(error.message)}`
          };
        }
      }
    }

    if (!fiscal.certificadoPath) {
      if (!permitirFallbackGlobal) {
        return {
          ok: false,
          codigoErro: empresaIdContexto ? 'CERTIFICADO' : 'EMPRESA_CENTRAL_AUSENTE',
          mensagem: empresaIdContexto
            ? `Certificado digital não configurado para a empresa ${empresaIdContexto}.`
            : 'Selecione a empresa para sincronizar o DF-e. Não há CNPJ global de fallback.'
        };
      }
      try {
        const global = await this._getFiscalConfig();
        fiscal = {
          ...global,
          cnpj: empresaIdContexto ? cnpjOficial : global.cnpj
        };
        origemAmbiente = 'getFiscalConfig';
      } catch (error) {
        return {
          ok: false,
          codigoErro: 'CONFIG_FISCAL',
          mensagem: this._mensagemAmigavel(error.message)
        };
      }
    }

    const ambiente = this._ambienteDeFiscal(fiscal);
    const ufSnap = this._ufDeFiscal(fiscal);

    const certificadoPathConfigurado = fiscal.certificadoPath || null;
    const certificadoPath = this._resolverCaminhoCertificadoExistente(
      certificadoPathConfigurado,
      empresaIdContexto
    );
    const certificadoSenha = fiscal.certificadoSenha || null;
    const cnpj = String(cnpjOficial || fiscal.cnpj || '').replace(/\D/g, '');

    if (!certificadoPath || !certificadoSenha) {
      return {
        ok: false,
        codigoErro: 'CERTIFICADO',
        mensagem: empresaIdContexto
          ? `Certificado digital não configurado para a empresa ${empresaIdContexto}.`
          : 'Certificado digital não configurado. Configure em Configurações Avançadas → Fiscal.'
      };
    }

    if (!cnpj || cnpj.length !== 14) {
      return {
        ok: false,
        codigoErro: 'CNPJ',
        mensagem: empresaIdContexto
          ? `CNPJ do emitente não configurado para a empresa ${empresaIdContexto}. Verifique o cadastro da empresa.`
          : 'CNPJ do emitente não configurado. Selecione a empresa e verifique o cadastro.'
      };
    }

    if (!fs.existsSync(certificadoPath)) {
      return {
        ok: false,
        codigoErro: 'CERTIFICADO',
        mensagem: 'Arquivo do certificado não encontrado no caminho configurado.'
      };
    }

    const urlDfe = this._resolverEndpointDfe(ambiente);
    if (!urlDfe) {
      return {
        ok: false,
        codigoErro: 'URL_SEFAZ',
        mensagem: 'Endpoint DF-e não resolvido pela Plataforma Fiscal (UrlResolver).'
      };
    }

    return {
      ok: true,
      contexto: {
        empresaId: empresaIdContexto,
        ambiente,
        uf: ufSnap.uf,
        codigoUf: ufSnap.codigoUf,
        origemAmbiente,
        origemCnpj: origemCnpj || (empresaIdContexto ? 'empresas' : null),
        cnpj,
        certificadoPath,
        certificadoSenha,
        certificadoValidacaoStatus: fiscal.certificadoValidacaoStatus || null,
        certificadoValidadeAte: fiscal.certificadoValidadeAte || null,
        certificadoCnpj: fiscal.certificadoCnpj || null,
        certificadoTitular: fiscal.certificadoTitular || null,
        certificadoValidacaoMensagem: fiscal.certificadoValidacaoMensagem || null,
        urls: {
          // Somente informativo — SOAP usa UrlResolver em distribuicaoDfeRuntime
          distribuicaoDfe: urlDfe,
          origemDistribuicaoDfe: 'UrlResolver',
          consultaChave: this._urlPorAmbiente(ambiente, mapa[CHAVES.URL_CONSULTA_PROD], mapa[CHAVES.URL_CONSULTA_HOM]),
          manifestacao: this._urlPorAmbiente(ambiente, mapa[CHAVES.URL_MANIF_PROD], mapa[CHAVES.URL_MANIF_HOM])
        },
        versaoServico: mapa[CHAVES.VERSAO_SERVICO] || '1.01',
        timeoutMs: Number(mapa[CHAVES.TIMEOUT_MS]) || Number(mapa[CHAVES.HTTP_TIMEOUT]) || 90000,
        maxTentativas: Number(mapa[CHAVES.MAX_TENTATIVAS]) || 2,
        intervaloTentativasMs: Number(mapa[CHAVES.INTERVALO_TENTATIVAS]) || 3000,
        syncMaxDocumentos: sync.syncMaxDocumentos,
        politicaManifestacao: POLITICAS_MANIFESTACAO.includes(mapa[CHAVES.POLITICA_MANIFESTACAO])
          ? mapa[CHAVES.POLITICA_MANIFESTACAO]
          : 'MANUAL',
        reprocessamentoAutomatico: mapa[CHAVES.REPROCESSAMENTO] !== false,
        logDetalhado: mapa[CHAVES.LOG_DETALHADO] === true,
        modoDebug: mapa[CHAVES.MODO_DEBUG] === true
      }
    };
  }

  /**
   * @param {Object} alteracoes
   * @returns {Promise<Object>}
   */
  async atualizar(alteracoes = {}) {
    await this._repository.ensureDefaults();

    const syncCampos = [
      'syncAutomaticaHabilitada', 'syncIntervaloMinutos', 'syncAoAbrir',
      'syncMaxDocumentos', 'horarioPermitidoInicio', 'horarioPermitidoFim',
      'horarioBloqueadoInicio', 'horarioBloqueadoFim', 'notificarNovasNotas'
    ];
    const syncPayload = {};
    for (const c of syncCampos) {
      if (alteracoes[c] !== undefined) syncPayload[c] = alteracoes[c];
      if (alteracoes.sincronizacao && alteracoes.sincronizacao[c] !== undefined) {
        syncPayload[c] = alteracoes.sincronizacao[c];
      }
    }
    if (Object.keys(syncPayload).length) {
      await this._syncConfig.atualizar(syncPayload);
    }

    const mapaCampos = {
      versaoServico: [CHAVES.VERSAO_SERVICO, 'string'],
      timeoutMs: [CHAVES.TIMEOUT_MS, 'number'],
      maxTentativas: [CHAVES.MAX_TENTATIVAS, 'number'],
      intervaloTentativasMs: [CHAVES.INTERVALO_TENTATIVAS, 'number'],
      politicaManifestacao: [CHAVES.POLITICA_MANIFESTACAO, 'string'],
      reprocessamentoAutomatico: [CHAVES.REPROCESSAMENTO, 'boolean'],
      httpTimeoutMs: [CHAVES.HTTP_TIMEOUT, 'number'],
      httpRetry: [CHAVES.HTTP_RETRY, 'number'],
      proxyHabilitado: [CHAVES.PROXY_HAB, 'boolean'],
      proxyUrl: [CHAVES.PROXY_URL, 'string'],
      logDetalhado: [CHAVES.LOG_DETALHADO, 'boolean'],
      modoDebug: [CHAVES.MODO_DEBUG, 'boolean'],
      recuperacaoXmlAtiva: [CHAVES.RECUP_XML_ATIVA, 'boolean'],
      recuperacaoXmlIntervaloMinutos: [CHAVES.RECUP_XML_INTERVALO, 'number'],
      recuperacaoXmlMaxTentativas: [CHAVES.RECUP_XML_MAX_TENT, 'number'],
      recuperacaoXmlMaxDias: [CHAVES.RECUP_XML_MAX_DIAS, 'number'],
      recuperacaoXmlLotePorCiclo: [CHAVES.RECUP_XML_LOTE, 'number']
    };

    const flat = {
      ...alteracoes,
      ...(alteracoes.sefaz || {}),
      ...(alteracoes.avancado || {}),
      ...(alteracoes.sincronizacao || {}),
      ...(alteracoes.recuperacaoXml
        ? {
          recuperacaoXmlAtiva: alteracoes.recuperacaoXml.ativa,
          recuperacaoXmlIntervaloMinutos: alteracoes.recuperacaoXml.intervaloMinutos,
          recuperacaoXmlMaxTentativas: alteracoes.recuperacaoXml.maxTentativas,
          recuperacaoXmlMaxDias: alteracoes.recuperacaoXml.maxDiasMonitoramento,
          recuperacaoXmlLotePorCiclo: alteracoes.recuperacaoXml.lotePorCiclo
        }
        : {})
    };
    // RC3.1 — bloco ambiente não é persistido (fonte oficial: getFiscalConfig)
    delete flat.ambiente;
    // RC4.3.1 — endpoints SOAP não são persistidos (fonte: UrlResolver)
    delete flat.urlConsultaChaveProducao;
    delete flat.urlConsultaChaveHomologacao;
    delete flat.urlManifestacaoProducao;
    delete flat.urlManifestacaoHomologacao;
    delete flat.urlDistribuicaoDfeProducao;
    delete flat.urlDistribuicaoDfeHomologacao;

    if (
      flat.politicaManifestacao !== undefined
      && !POLITICAS_MANIFESTACAO.includes(String(flat.politicaManifestacao))
    ) {
      throw new Error('Política de manifestação inválida.');
    }

    for (const campoIgnorado of CAMPOS_ENDPOINT_SOAP_IGNORADOS) {
      delete flat[campoIgnorado];
    }
    for (const campoIgnorado of CAMPOS_FISCAL_SOMENTE_LEITURA) {
      delete flat[campoIgnorado];
    }

    for (const [campo, valor] of Object.entries(flat)) {
      if (valor === undefined || !mapaCampos[campo]) continue;
      const [chave, tipo] = mapaCampos[campo];
      await this._repository.salvar(chave, valor, tipo);
    }

    await this._syncConfig.hidratarFlags();
    logCentral('CONFIG', { fase: 'atualizado', unificacaoFiscal: 'RC3.1' });

    // RC3.7.5 — reinicia motor se config de recuperação mudou
    try {
      const { obterMotorRecuperacaoXml } = require('../recuperacao-xml');
      const motor = obterMotorRecuperacaoXml();
      motor.parar({ silencioso: true });
      await motor.iniciar({ delayMs: 5000 });
    } catch { /* ignore */ }

    return this.obterPainelCompleto();
  }

  /**
   * Restaura defaults operacionais da Central (timeouts/sync/etc.).
   * Não toca fiscal_ambiente / UF emitente (fonte oficial externa).
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async restaurarPadrao(opcoes = {}) {
    await this._repository.ensureDefaults();
    for (const [chave, valor, tipo] of CentralConfiguracaoRepository.DEFAULTS) {
      if (!opcoes.incluirSync && String(chave).startsWith('sync_')) continue;
      await this._repository.salvar(chave, tipo === 'number' ? Number(valor) : (tipo === 'boolean' ? valor === 'true' : valor), tipo);
    }
    return this.obterPainelCompleto();
  }

  // —— Compatibilidade com CentralConfigService (sync) ——

  /**
   * Alias oficial RC5 — mesmo contrato de CentralConfigService.obterResumo().
   * @returns {Promise<Object>}
   */
  obterResumo() {
    return this.obterResumoSync();
  }

  obterResumoSync() {
    return this._syncConfig.obterResumo();
  }

  async obterPoliticaManifestacao() {
    await this._repository.ensureDefaults();
    const mapa = await this._obterMapaValores();
    return POLITICAS_MANIFESTACAO.includes(mapa[CHAVES.POLITICA_MANIFESTACAO])
      ? mapa[CHAVES.POLITICA_MANIFESTACAO]
      : 'MANUAL';
  }

  atualizarSync(alteracoes) {
    return this._syncConfig.atualizar(alteracoes);
  }

  hidratarFlags() {
    return this._syncConfig.hidratarFlags();
  }

  obterIntervaloMs() {
    return this._syncConfig.obterIntervaloMs();
  }

  verificarHorarioPermitido(agora) {
    return this._syncConfig.verificarHorarioPermitido(agora);
  }

  /** @private */
  async _obterMapaValores() {
    const registros = await this._repository.listarTodas();
    const mapa = {};
    for (const reg of registros) {
      mapa[reg.chave] = this._repository.parseValor(reg);
    }
    return mapa;
  }

  /**
   * Snapshot seguro do cadastro fiscal oficial (nunca falha o painel).
   * @private
   * @returns {Promise<{ ambiente: number, uf: string, codigoUf: string }>}
   */
  async _obterSnapshotFiscal() {
    try {
      const fiscal = await this._getFiscalConfig();
      return {
        ambiente: this._ambienteDeFiscal(fiscal),
        ...this._ufDeFiscal(fiscal)
      };
    } catch {
      return { ambiente: 2, uf: 'CE', codigoUf: '23' };
    }
  }

  /**
   * @private
   * @param {Object} fiscal
   * @returns {number} 1|2
   */
  _ambienteDeFiscal(fiscal = {}) {
    const code = Number(fiscal.ambiente ?? fiscal.fiscal_ambiente);
    return code === 1 ? 1 : 2;
  }

  /**
   * @private
   * @param {Object} fiscal
   * @returns {{ uf: string, codigoUf: string }}
   */
  _ufDeFiscal(fiscal = {}) {
    const uf = String(fiscal.uf || fiscal.fiscal_uf_sigla || fiscal.fiscal_uf || 'CE').trim().toUpperCase() || 'CE';
    const codigoUf = String(fiscal.codigoUf || fiscal.fiscal_codigo_uf || '23').replace(/\D/g, '').padStart(2, '0') || '23';
    return { uf, codigoUf };
  }

  /**
   * Resolve endpoint DF-e via Plataforma Fiscal (UrlResolver + Registry).
   * A Central não monta nem armazena a URL SOAP efetiva.
   * @private
   * @param {number} ambienteCode 1|2
   * @returns {string|null}
   */
  _resolverEndpointDfe(ambienteCode) {
    try {
      const { FiscalWebServices } = require('../../../services/fiscal/core/FiscalWebServices');
      const { ModelType } = require('../../../services/fiscal/core/ModelType');
      const { OperationType } = require('../../../services/fiscal/core/OperationType');
      const { fromAmbienteCode } = require('../../../services/fiscal/core/EnvironmentType');
      const { UF_AN } = require('../../../services/fiscal/core/RegistryBuilder');

      const ambiente = fromAmbienteCode(ambienteCode);
      if (!ambiente) return null;

      const resolution = new FiscalWebServices().resolve({
        modelo: ModelType.NFE,
        operacao: OperationType.DISTRIBUICAO_DFE,
        ambiente,
        uf: UF_AN,
        versao: '1.01'
      });

      return resolution.success && resolution.definition?.endpoint
        ? resolution.definition.endpoint
        : null;
    } catch (error) {
      logCentralErro('CONFIG', { fase: 'resolver-dfe', erro: error.message });
      return null;
    }
  }

  /**
   * @private
   * @returns {{ producao: string, homologacao: string }}
   */
  _resolverEndpointsDfe() {
    return {
      producao: this._resolverEndpointDfe(1) || '',
      homologacao: this._resolverEndpointDfe(2) || ''
    };
  }

  /**
   * Resolve endpoint de Manifestação (RecepcaoEvento) via Plataforma Fiscal.
   * Somente leitura para o painel — não altera Registry/UrlResolver/Runtime.
   * @private
   * @param {number} ambienteCode 1|2
   * @returns {string|null}
   */
  _resolverEndpointManifestacao(ambienteCode) {
    try {
      const { FiscalWebServices } = require('../../../services/fiscal/core/FiscalWebServices');
      const { ModelType } = require('../../../services/fiscal/core/ModelType');
      const { OperationType } = require('../../../services/fiscal/core/OperationType');
      const { fromAmbienteCode } = require('../../../services/fiscal/core/EnvironmentType');
      const { UF_AN } = require('../../../services/fiscal/core/RegistryBuilder');

      const ambiente = fromAmbienteCode(ambienteCode);
      if (!ambiente) return null;

      const resolution = new FiscalWebServices().resolve({
        modelo: ModelType.NFE,
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente,
        uf: UF_AN,
        versao: '1.00'
      });

      return resolution.success && resolution.definition?.endpoint
        ? resolution.definition.endpoint
        : null;
    } catch (error) {
      logCentralErro('CONFIG', { fase: 'resolver-manifestacao', erro: error.message });
      return null;
    }
  }

  /**
   * @private
   * @returns {{ producao: string, homologacao: string }}
   */
  _resolverEndpointsManifestacao() {
    return {
      producao: this._resolverEndpointManifestacao(1) || '',
      homologacao: this._resolverEndpointManifestacao(2) || ''
    };
  }

  /**
   * Resolve endpoint de Consulta por chave (consSitNFe) via Plataforma Fiscal.
   * RC4.3.1 — somente leitura no painel; não altera Registry/UrlResolver/Runtime.
   * @private
   * @param {number} ambienteCode 1|2
   * @returns {string|null}
   */
  _resolverEndpointConsultaChave(ambienteCode) {
    try {
      const { FiscalWebServices } = require('../../../services/fiscal/core/FiscalWebServices');
      const { ModelType } = require('../../../services/fiscal/core/ModelType');
      const { OperationType } = require('../../../services/fiscal/core/OperationType');
      const { fromAmbienteCode } = require('../../../services/fiscal/core/EnvironmentType');
      const { UF_SVRS } = require('../../../services/fiscal/core/RegistryBuilder');

      const ambiente = fromAmbienteCode(ambienteCode);
      if (!ambiente) return null;

      const resolution = new FiscalWebServices().resolve({
        modelo: ModelType.NFE,
        operacao: OperationType.CONSULTA_PROTOCOLO,
        ambiente,
        uf: UF_SVRS,
        versao: '4.00'
      });

      return resolution.success && resolution.definition?.endpoint
        ? resolution.definition.endpoint
        : null;
    } catch (error) {
      logCentralErro('CONFIG', { fase: 'resolver-consulta-chave', erro: error.message });
      return null;
    }
  }

  /**
   * @private
   * @returns {{ producao: string, homologacao: string }}
   */
  _resolverEndpointsConsultaChave() {
    return {
      producao: this._resolverEndpointConsultaChave(1) || '',
      homologacao: this._resolverEndpointConsultaChave(2) || ''
    };
  }

  /**
   * @private
   * @param {string} politica
   * @returns {string}
   */
  _labelPoliticaManifestacao(politica) {
    const mapa = {
      AUTOMATICA_CIENCIA: 'Automática',
      CONFIRMAR_OPERADOR: 'Solicitar Confirmação',
      MANUAL: 'Manual'
    };
    return mapa[politica] || 'Manual';
  }

  /** @private */
  _urlPorAmbiente(ambiente, prod, hom) {
    return Number(ambiente) === 1 ? (prod || '') : (hom || '');
  }

  /** @private */
  async _obterVisaoCertificado() {
    try {
      const fiscal = await this._getFiscalConfig();
      return await this._montarVisaoCertificado(fiscal);
    } catch (error) {
      return {
        presente: false,
        nome: null,
        cnpj: null,
        validade: null,
        diasRestantes: null,
        status: 'ERRO',
        caminho: null,
        mensagem: this._mensagemAmigavel(error.message)
      };
    }
  }

  /**
   * Resolve PFX existente quando o path absoluto gravado aponta para outra pasta
   * (ex.: `…\\dados\\fiscal\\…` após o cliente operar em `dados-pastelaria`).
   * Preferência: arquivo sob FISCAL_DIR atual (`certificado-empresa-<id>.pfx`).
   * Não altera o banco — só o caminho usado em memória nesta operação.
   *
   * @private
   * @param {string|null} certificadoPath
   * @param {number|null} empresaId
   * @returns {string|null}
   */
  _resolverCaminhoCertificadoExistente(certificadoPath, empresaId) {
    const bruto = certificadoPath ? String(certificadoPath).trim() : '';
    if (bruto && fs.existsSync(bruto)) return bruto;

    let fiscalDir = null;
    try {
      const { getFiscalDir } = require('../../../services/fiscal/paths');
      fiscalDir = getFiscalDir();
    } catch {
      fiscalDir = process.env.FISCAL_DIR || null;
    }
    if (!fiscalDir) return bruto || null;

    const candidatos = [];
    if (empresaId) {
      candidatos.push(path.join(fiscalDir, 'certificados', `certificado-empresa-${empresaId}.pfx`));
    }
    if (bruto) {
      candidatos.push(path.join(fiscalDir, 'certificados', path.basename(bruto)));
    }

    for (const candidato of candidatos) {
      try {
        if (candidato && fs.existsSync(candidato)) return path.resolve(candidato);
      } catch {
        /* ignore */
      }
    }
    return bruto || null;
  }

  /**
   * @private
   * @param {{ certificadoPath?: string, certificadoSenha?: string, cnpj?: string }} fiscal
   */
  async _montarVisaoCertificado(fiscal = {}) {
    const {
      ESTADOS_CERTIFICADO_A1,
      MENSAGENS_CERTIFICADO_A1
    } = require('../../../services/fiscal/certificadoEstados');
    try {
      const certificadoPath = fiscal.certificadoPath;
      const senhaConfigurada = !!(fiscal.certificadoSenha && String(fiscal.certificadoSenha).trim());
      if (!certificadoPath) {
        return {
          presente: false,
          nome: null,
          cnpj: fiscal.cnpj || null,
          validade: null,
          diasRestantes: null,
          status: ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO,
          caminho: null,
          senhaConfigurada: senhaConfigurada ? 'SIM' : 'NÃO',
          mensagem: MENSAGENS_CERTIFICADO_A1.NAO_CONFIGURADO
        };
      }

      const existe = fs.existsSync(certificadoPath);
      if (!existe) {
        return {
          presente: false,
          nome: path.basename(certificadoPath),
          cnpj: fiscal.cnpj || null,
          validade: null,
          diasRestantes: null,
          status: ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
          caminho: certificadoPath,
          senhaConfigurada: senhaConfigurada ? 'SIM' : 'NÃO',
          mensagem: 'Arquivo do certificado não encontrado no caminho configurado.'
        };
      }

      const snapshot = fiscal.certificadoValidacaoStatus
        || fiscal.certificado_validacao_status
        || null;
      if (snapshot && Object.values(ESTADOS_CERTIFICADO_A1).includes(String(snapshot))) {
        const validade = fiscal.certificadoValidadeAte || fiscal.certificado_validade_ate || null;
        let diasRestantes = null;
        if (validade) {
          const dt = new Date(validade);
          if (!Number.isNaN(dt.getTime())) {
            diasRestantes = Math.ceil((dt.getTime() - Date.now()) / 86400000);
          }
        }
        return {
          presente: true,
          nome: fiscal.certificadoTitular || fiscal.certificado_titular || path.basename(certificadoPath),
          cnpj: fiscal.certificadoCnpj || fiscal.certificado_cnpj || fiscal.cnpj || null,
          validade,
          diasRestantes,
          status: String(snapshot),
          caminho: certificadoPath,
          senhaConfigurada: senhaConfigurada ? 'SIM' : 'NÃO',
          mensagem: fiscal.certificadoValidacaoMensagem
            || fiscal.certificado_validacao_mensagem
            || MENSAGENS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
        };
      }

      return {
        presente: true,
        nome: path.basename(certificadoPath),
        cnpj: fiscal.cnpj || null,
        validade: null,
        diasRestantes: null,
        status: ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO,
        caminho: certificadoPath,
        senhaConfigurada: senhaConfigurada ? 'SIM' : 'NÃO',
        mensagem: MENSAGENS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO
      };
    } catch (error) {
      const { sanitizarTextoCertificado } = require('../../../services/fiscal/ValidarCertificadoA1Service');
      return {
        presente: false,
        nome: null,
        cnpj: null,
        validade: null,
        diasRestantes: null,
        status: ESTADOS_CERTIFICADO_A1.ERRO_DE_VALIDACAO,
        caminho: null,
        senhaConfigurada: 'NÃO',
        mensagem: sanitizarTextoCertificado(this._mensagemAmigavel(error.message))
      };
    }
  }

  /** @private */
  async _obterMetadadosAlteracao() {
    const registros = await this._repository.listarTodas();
    let latest = null;
    for (const reg of registros) {
      if (!reg.updatedAt) continue;
      if (!latest || String(reg.updatedAt) > String(latest)) latest = reg.updatedAt;
    }
    return {
      atualizadoEm: latest,
      ultimaAlteracao: latest
    };
  }

  /** @private */
  async _obterResumoDiagnostico() {
    const { VERSAO_MODULO } = require('../CentralEntradasOrchestrator');
    let tempoMedio = null;
    let ultimaSync = null;
    let ultimoErro = null;
    try {
      const eventos = require('./CentralEventosService');
      const svc = new eventos();
      tempoMedio = await svc.obterTempoMedioSyncMs();
      ultimaSync = await svc.obterUltimaSyncConcluida();
      ultimoErro = await svc.obterUltimoErroSync();
    } catch { /* ignore */ }

    return {
      versaoCentral: VERSAO_MODULO,
      versaoPipeline: 'RC3',
      versaoParser: 'oficial',
      versaoMiip: 'RC1',
      tempoMedioSyncMs: tempoMedio,
      ultimaSincronizacao: ultimaSync?.createdAt || null,
      ultimoErro: ultimoErro?.descricao || null,
      sefazOperacional: (() => {
        try {
          return require('./CentralSefazOperationalGate').obterPainelOperacional();
        } catch {
          return null;
        }
      })()
    };
  }

  /** @private */
  _mensagemAmigavel(msg) {
    const m = String(msg || '');
    if (/MAC could not be verified|Invalid password/i.test(m)) {
      return 'A senha informada não confere com o certificado.';
    }
    if (/certificado/i.test(m)) return 'Certificado digital ausente ou inválido. Configure em Configurações Avançadas → Fiscal.';
    if (/cnpj/i.test(m)) return 'CNPJ do emitente não configurado.';
    if (/ambiente fiscal/i.test(m)) return 'Ambiente fiscal não configurado. Defina em Configurações Avançadas.';
    if (/url|autoriza/i.test(m)) return 'Configuração SEFAZ incompleta. Verifique a aba SEFAZ.';
    if (/timeout|ECONNABORTED/i.test(m)) return 'A SEFAZ não respondeu a tempo. Tente novamente.';
    return m || 'Falha na configuração operacional da Central.';
  }
}

CentralConfiguracaoService.CHAVES = CHAVES;
CentralConfiguracaoService.CAMPOS_FISCAL_SOMENTE_LEITURA = CAMPOS_FISCAL_SOMENTE_LEITURA;
CentralConfiguracaoService.POLITICAS_MANIFESTACAO = POLITICAS_MANIFESTACAO;

module.exports = CentralConfiguracaoService;
