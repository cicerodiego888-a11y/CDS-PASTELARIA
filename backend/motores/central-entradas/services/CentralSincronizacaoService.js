/**
 * CentralSincronizacaoService — Orquestração da sincronização DF-e na Central.
 *
 * RC4: obtém contexto via CentralConfiguracaoService (sem leitura fiscal direta).
 * 05.38.E: sincroniza por empresa conforme Modo Operacional Global
 * (EMPRESA_SIMPLES = 1 CNPJ; MULTIEMPRESA = loop de empresas ativas).
 *
 * @class CentralSincronizacaoService
 */

const SincronizacaoResultadoDTO = require('../contracts/SincronizacaoResultadoDTO');
const CentralDocumentosRepository = require('../repositories/CentralDocumentosRepository');
const CentralConfiguracaoService = require('./CentralConfiguracaoService');
const CentralNsuRepository = require('../repositories/CentralNsuRepository');
const CentralNsuService = require('./CentralNsuService');
const CentralDfePersistenciaService = require('./CentralDfePersistenciaService');
const CentralConsultaDistDfeDecisaoService = require('./CentralConsultaDistDfeDecisaoService');
const {
  sincronizarDistribuicaoDFe,
  consultarNotaPorChave
} = require('../../../services/fiscal/distribuicaoDFe');
const { resolverIdentidadeConsultaChave } = require(
  '../../../services/fiscal/identidadeConsultaChave'
);
const { paraInboxDTO } = require('../utils/centralEntradasMapper');
const {
  listarAlvosSincronizacaoCentral
} = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../../core/modo-operacional');
const {
  enriquecerMensagemSefazDfeHttp,
  codigoErroSincronizacaoDfe
} = require('../utils/mensagemSefazDfeHttp');
const { emitirSefazConsulta } = require('../observability/SefazConsultaTrace');
const { ESTADOS_CONSULTA_SEFAZ } = require('../../../services/fiscal/autorizacaoTransmissaoSefaz');
const { logCentralErro } = require('../utils/centralLog');

class CentralSincronizacaoService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    /** @private */
    this._documentosRepository = deps.documentosRepository ?? new CentralDocumentosRepository();
    /** @private */
    this._configuracao = deps.configuracaoService ?? new CentralConfiguracaoService({
      db: deps.db ?? null
    });
    /** @private */
    this._nsuRepository = deps.nsuRepository
      ?? new CentralNsuRepository({ db: deps.db ?? null });
    /** @private */
    this._nsuService = deps.nsuService
      ?? new CentralNsuService({ nsuRepository: this._nsuRepository });
    /** @private */
    this._decisaoDistDfe = deps.decisaoDistDfe
      ?? new CentralConsultaDistDfeDecisaoService({
        nsuService: this._nsuService,
        nsuRepository: this._nsuRepository,
        gate: deps.gate,
        mutexTransmissaoSefaz: deps.mutexTransmissaoSefaz,
        syncExecucao: deps.syncExecucao || null,
        rateLimitMs: deps.rateLimitMs,
        agora: deps.agora
      });
    /** @private */
    this._deps = deps;
    /** @private */
    this._consultarNotaPorChave = deps.consultarNotaPorChave || consultarNotaPorChave;
    /** @private */
    this._sincronizarDfe = deps.sincronizarDistribuicaoDFe || sincronizarDistribuicaoDFe;
  }

  /** Gate SEFAZ oficial (singleton), ou o injetado; `gate: null` desliga (somente testes legados). */
  _obterGate() {
    if (this._deps.gate === null || this._deps.gate === false) return null;
    if (this._deps.gate) return this._deps.gate;
    try {
      return require('./CentralSefazOperationalGate');
    } catch {
      return null;
    }
  }

  async _autorizarGateEmpresa(contexto, extra = {}) {
    // gate: null|false = desligado só em testes legados; produção sempre tem Gate.
    if (this._deps.gate === null || this._deps.gate === false) {
      return null;
    }
    const gate = this._obterGate();
    if (!gate || typeof gate.autorizarConsultaDistDfe !== 'function') {
      logCentralErro('SYNC', new Error('Gate SEFAZ indisponível'), {
        Motivo: 'gate_ausente_fail_closed',
        EmpresaId: contexto.empresaId
      });
      return {
        permitido: false,
        codigo: 'GATE_INDISPONIVEL',
        mensagem: 'Gate operacional SEFAZ indisponível — consulta bloqueada (fail-closed).'
      };
    }
    try {
      const auth = await gate.autorizarConsultaDistDfe({
        empresaId: contexto.empresaId,
        cnpj: contexto.cnpj,
        ambiente: contexto.ambiente,
        origem: 'CentralSincronizacaoService',
        ...extra
      });
      return auth && auth.permitido === false ? auth : null;
    } catch (error) {
      logCentralErro('SYNC', error, {
        Motivo: 'gate_falha_autorizacao_fail_closed',
        EmpresaId: contexto.empresaId
      });
      return {
        permitido: false,
        codigo: 'GATE_INDISPONIVEL',
        mensagem: `Falha ao avaliar Gate SEFAZ: ${error.message}`
      };
    }
  }

  /**
   * Sincroniza uma empresa isolada (CNPJ + NSU + persistência com empresa_id).
   * @param {{ empresaId: number, cnpj?: string|null }} alvo
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   * @private
   */
  async _sincronizarEmpresa(alvo, opcoes = {}) {
    const empresaId = Number(alvo.empresaId);
    const modo = opcoes.modo || null;
    const permitirFallbackGlobal = modo === ModoOperacionalGlobal.EMPRESA_SIMPLES;

    const ctxResult = await this._configuracao.obterContextoOperacional({
      empresaId,
      permitirFallbackGlobal,
      db: opcoes.db || this._deps.db
    });

    if (!ctxResult.ok) {
      return {
        sucesso: false,
        pulado: true,
        empresaId,
        cnpj: alvo.cnpj || null,
        notasNovas: 0,
        notasDuplicadas: 0,
        erros: [ctxResult.mensagem],
        mensagem: ctxResult.mensagem,
        codigoErro: ctxResult.codigoErro
      };
    }

    const contexto = {
      ...ctxResult.contexto,
      empresaId
    };

    // P0.11 / CE-PASTELARIA-04 — decisão unificada (cooldown + Gate + mutex + auth).
    // `ignorarCooldown` / `forcar` NÃO bypassam. BACKGROUND / abrir_central /
    // MANUAL / sync sem OPERACAO_REAL são bloqueados na decisão (fail-closed),
    // sem depender apenas da barreira SOAP.
    const autorizacao = opcoes.autorizacaoTransmissaoSefaz
      || this._deps.autorizacaoTransmissaoSefaz
      || null;
    const origemSync = opcoes.origem || null;
    const decisao = await this._decisaoDistDfe.avaliar({
      empresaId,
      cnpj: contexto.cnpj,
      ambiente: contexto.ambiente,
      origem: origemSync,
      correlationId: opcoes.correlationId || null,
      autorizacaoTransmissaoSefaz: autorizacao,
      verificarAutorizacao: true,
      permitirSemAutorizacao: false,
      verificarCooldownNsu: true,
      verificarGate: true,
      // Mutex já é adquirido por CentralSyncExecucaoService.comLockDistDfe.
      verificarMutex: opcoes.verificarMutex === true,
      verificarRateLimit: opcoes.verificarRateLimit !== false
    });

    if (!decisao.permitido) {
      const codigoDecisao = decisao.codigo || 'DISTDFE_BLOQUEADO';
      // Compat: APIs/testes legados usam AGUARDAR_JANELA_DFE; motivo/codigoDecisao
      // preservam FILA_ESGOTADA / COOLDOWN_ATIVO / ESTADO_NSU_INCONSISTENTE.
      const codigosJanela = new Set([
        CentralConsultaDistDfeDecisaoService.CODIGOS.COOLDOWN_ATIVO,
        CentralConsultaDistDfeDecisaoService.CODIGOS.FILA_ESGOTADA,
        CentralConsultaDistDfeDecisaoService.CODIGOS.ESTADO_NSU_INCONSISTENTE
      ]);
      let codigo = codigoDecisao;
      if (codigosJanela.has(codigoDecisao)) {
        codigo = 'AGUARDAR_JANELA_DFE';
      }
      const eventoTrace = codigosJanela.has(codigoDecisao)
        || codigo === 'AGUARDAR_JANELA_DFE'
        ? 'BLOQUEADA_COOLDOWN'
        : (codigoDecisao === CentralConsultaDistDfeDecisaoService.CODIGOS.AUTORIZACAO_AUSENTE
          ? 'BLOQUEADA_AUTORIZACAO'
          : 'BLOQUEADA_GATE');
      emitirSefazConsulta(eventoTrace, {
        origem: opcoes.origem || null,
        correlationId: opcoes.correlationId || null,
        empresaId,
        cnpj: contexto.cnpj,
        tipoConsulta: 'distNSU',
        codigo,
        motivo: decisao.motivoCooldown || decisao.mensagem,
        nsuAnterior: decisao.detalhe?.ultNsu,
        maxNsu: decisao.detalhe?.maxNsu,
        resultado: 'bloqueada'
      });
      return {
        sucesso: false,
        consultaExecutada: false,
        ignorado: true,
        pulado: true,
        bloqueadoGate: codigoDecisao === 'GATE_INDISPONIVEL'
          || codigoDecisao === 'ERRO_CONFIGURACAO_CERTIFICADO'
          || codigoDecisao === 'BLOQUEADO_CONSUMO_INDEVIDO_656',
        empresaId,
        cnpj: contexto.cnpj,
        ambiente: contexto.ambiente,
        codigo,
        codigoDecisao,
        motivoIgnorado: decisao.motivoCooldown || codigo,
        mensagem: decisao.mensagem,
        mensagemAmigavel: decisao.mensagemAmigavel || decisao.mensagem,
        proximaConsultaEm: decisao.proximaConsultaEm || null,
        ultNsu: decisao.detalhe?.ultNsu || null,
        maxNsu: decisao.detalhe?.maxNsu || null,
        cooldownAtivo: decisao.cooldownAtivo === true,
        notasNovas: 0,
        notasDuplicadas: 0
      };
    }

    // Telemetria Gate (já liberado pela decisão; falha aqui não autoriza implícito).
    const negadoGate = await this._autorizarGateEmpresa(contexto, {
      correlationId: opcoes.correlationId || null,
      motivo: 'distNSU_sincronizacao'
    });
    if (negadoGate) {
      emitirSefazConsulta('BLOQUEADA_GATE', {
        origem: opcoes.origem || null,
        correlationId: opcoes.correlationId || null,
        empresaId,
        cnpj: contexto.cnpj,
        tipoConsulta: 'distNSU',
        codigo: negadoGate.codigo || 'GATE_BLOQUEADO',
        cStat: negadoGate.cStat,
        estadoGate: negadoGate.estadoOperacional || negadoGate.codigo,
        motivo: negadoGate.mensagem,
        resultado: 'bloqueada'
      });
      return {
        sucesso: false,
        consultaExecutada: false,
        ignorado: true,
        pulado: true,
        bloqueadoGate: true,
        empresaId,
        cnpj: contexto.cnpj,
        ambiente: contexto.ambiente,
        codigo: negadoGate.codigo || 'GATE_BLOQUEADO',
        motivoIgnorado: 'GATE_BLOQUEADO',
        mensagem: negadoGate.mensagem || 'Consulta DF-e não executada: bloqueada pelo Gate SEFAZ da empresa.',
        proximaConsultaEm: negadoGate.proximaConsultaEm || null,
        notasNovas: 0,
        notasDuplicadas: 0
      };
    }

    this._decisaoDistDfe.registrarTentativaLocal({
      empresaId,
      cnpj: contexto.cnpj,
      ambiente: contexto.ambiente
    });

    const persistencia = new CentralDfePersistenciaService({
      documentosRepository: this._documentosRepository,
      empresaId
    });

    try {
      const gate = this._obterGate();
      const resultado = await this._sincronizarDfe({
        gateSefaz: gate || undefined,
        origemGate: 'CentralSincronizacaoService',
        maxIteracoes: opcoes.maxIteracoes ?? contexto.syncMaxDocumentos,
        contextoCentral: contexto,
        empresaId,
        nsuRepository: this._nsuRepository,
        nsuService: this._nsuService,
        persistenciaService: persistencia,
        correlationId: opcoes.correlationId || null,
        origemConsulta: opcoes.origem || null,
        autorizacaoTransmissaoSefaz: opcoes.autorizacaoTransmissaoSefaz
          || this._deps.autorizacaoTransmissaoSefaz
          || null,
        operacaoFiscalRealService: opcoes.operacaoFiscalRealService
          || this._deps.operacaoFiscalRealService
          || null,
        mutexTransmissaoSefaz: this._deps.mutexTransmissaoSefaz
      });

      const mensagem = enriquecerMensagemSefazDfeHttp(
        resultado.mensagem || (resultado.erros && resultado.erros[0]) || '',
        { ambiente: contexto.ambiente }
      );

      const errosPersistencia = Array.isArray(resultado.errosPersistencia)
        ? resultado.errosPersistencia
        : [];
      return {
        ...resultado,
        sucesso: resultado.sucesso !== false && errosPersistencia.length === 0,
        consultaExecutada: resultado.consultaExecutada !== false,
        ignorado: resultado.ignorado === true,
        empresaId,
        cnpj: contexto.cnpj,
        ambiente: contexto.ambiente,
        mensagem: mensagem || resultado.mensagem,
        mensagemAmigavel: mensagem || resultado.mensagemAmigavel || resultado.mensagem,
        errosPersistencia
      };
    } catch (error) {
      const mensagem = enriquecerMensagemSefazDfeHttp(error.message, {
        ambiente: contexto.ambiente
      });
      return {
        sucesso: false,
        empresaId,
        cnpj: contexto.cnpj,
        ambiente: contexto.ambiente,
        notasNovas: 0,
        notasDuplicadas: 0,
        erros: [mensagem],
        mensagem,
        mensagemAmigavel: mensagem,
        codigoErro: error.code || codigoErroSincronizacaoDfe(mensagem)
      };
    }
  }

  /**
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async sincronizar(opcoes = {}) {
    try {
      const plano = await listarAlvosSincronizacaoCentral(this._deps);
      if (!plano.alvos.length) {
        return SincronizacaoResultadoDTO.create({
          sucesso: false,
          notasNovas: 0,
          notasDuplicadas: 0,
          erros: ['Nenhuma empresa ativa para sincronização'],
          mensagem: 'Nenhuma empresa ativa para sincronização',
          mensagemAmigavel: 'Nenhuma empresa ativa para sincronização',
          codigoErro: 'EMPRESA_CENTRAL_AUSENTE'
        }).toJSON();
      }

      const porEmpresa = [];
      let notasNovas = 0;
      let notasDuplicadas = 0;
      let ignorados = 0;
      const erros = [];
      const errosPersistencia = [];
      let algumSucesso = false;
      let ultimoOk = null;
      let algumaConsulta = false;

      const alvos = opcoes.empresaIdFiltro
        ? plano.alvos.filter((a) => Number(a.empresaId) === Number(opcoes.empresaIdFiltro))
        : plano.alvos;
      if (!alvos.length) {
        return SincronizacaoResultadoDTO.create({
          sucesso: false,
          notasNovas: 0,
          notasDuplicadas: 0,
          erros: ['Empresa solicitada não está entre os alvos de sincronização'],
          mensagem: 'Empresa não elegível para sincronização DF-e',
          mensagemAmigavel: 'Empresa não elegível para sincronização DF-e',
          codigoErro: 'EMPRESA_CENTRAL_AUSENTE'
        }).toJSON();
      }

      for (const alvo of alvos) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this._sincronizarEmpresa(alvo, {
          ...opcoes,
          modo: plano.modo
        });
        const consultaExecutada = r.consultaExecutada === true
          || (r.consultaExecutada !== false && !r.ignorado && !r.pulado && !r.bloqueadoGate);
        porEmpresa.push({
          empresaId: r.empresaId,
          cnpj: r.cnpj,
          sucesso: r.sucesso !== false,
          consultaExecutada,
          pulado: !!r.pulado,
          ignorado: !!r.ignorado,
          motivoIgnorado: r.motivoIgnorado || null,
          bloqueadoGate: !!r.bloqueadoGate,
          proximaConsultaEm: r.proximaConsultaEm || null,
          notasNovas: r.notasNovas || 0,
          notasDuplicadas: r.notasDuplicadas || 0,
          ultNsu: r.ultNsu || null,
          maxNsu: r.maxNsu || null,
          cStat: r.cStat || null,
          mensagem: r.mensagem || null,
          codigoErro: r.codigoErro || r.codigo || null,
          errosPersistencia: Array.isArray(r.errosPersistencia) ? r.errosPersistencia : []
        });

        notasNovas += Number(r.notasNovas) || 0;
        notasDuplicadas += Number(r.notasDuplicadas) || 0;
        ignorados += Number(r.ignorados) || 0;
        if (Array.isArray(r.errosPersistencia)) {
          errosPersistencia.push(...r.errosPersistencia);
        }
        if (consultaExecutada) algumaConsulta = true;
        if (r.sucesso !== false && consultaExecutada) {
          algumSucesso = true;
          ultimoOk = r;
        } else if (r.sucesso === false && r.mensagem && !r.ignorado) {
          erros.push(`[empresa ${r.empresaId}] ${r.mensagem}`);
        }
      }

      const todasIgnoradas = porEmpresa.length > 0 && porEmpresa.every((p) => p.ignorado);
      const sucesso = algumaConsulta && algumSucesso && errosPersistencia.length === 0;
      const codigoIgnorado = todasIgnoradas
        ? (porEmpresa[0].codigoErro || 'AGUARDAR_JANELA_DFE')
        : null;
      const mensagem = !algumaConsulta && todasIgnoradas
        ? (porEmpresa[0].mensagem || 'Consulta DF-e não executada (cooldown ou Gate).')
        : (sucesso
          ? (plano.modo === ModoOperacionalGlobal.MULTIEMPRESA
            ? `Sincronização multiempresa: ${porEmpresa.length} empresa(s)`
            : (ultimoOk && ultimoOk.mensagem) || 'Sincronização concluída')
          : (erros[0] || porEmpresa.find((p) => p.mensagem)?.mensagem || 'Falha na sincronização'));
      const codigosFalha = porEmpresa
        .filter((p) => p.sucesso === false)
        .map((p) => p.codigoErro)
        .filter(Boolean);
      const codigoErro = sucesso
        ? null
        : (codigoIgnorado
          || (errosPersistencia.length ? 'PERSISTENCIA_DFE_INCOMPLETA' : null)
          || codigosFalha.find((c) => c === 'CERTIFICADO' || c === 'CNPJ' || c === 'CONFIG_FISCAL')
          || codigosFalha[0]
          || codigoErroSincronizacaoDfe(mensagem));

      return {
        ...SincronizacaoResultadoDTO.create({
          sucesso,
          notasNovas,
          notasDuplicadas,
          ignorados,
          ultNsu: ultimoOk ? ultimoOk.ultNsu : (porEmpresa[0] && porEmpresa[0].ultNsu),
          maxNsu: ultimoOk ? ultimoOk.maxNsu : (porEmpresa[0] && porEmpresa[0].maxNsu),
          iteracoes: ultimoOk ? ultimoOk.iteracoes : null,
          cStat: ultimoOk ? ultimoOk.cStat : (porEmpresa[0] && porEmpresa[0].cStat),
          mensagem,
          mensagemAmigavel: mensagem,
          ultimaSincronizacao: ultimoOk ? ultimoOk.ultimaSincronizacao : null,
          erros,
          codigoErro,
          consultaExecutada: algumaConsulta,
          ignorado: todasIgnoradas,
          motivoIgnorado: todasIgnoradas ? (porEmpresa[0].motivoIgnorado || null) : null,
          errosPersistencia,
          codigo: codigoIgnorado || (errosPersistencia.length ? 'PERSISTENCIA_DFE_INCOMPLETA' : null),
          proximaConsultaEm: todasIgnoradas
            ? (porEmpresa[0].proximaConsultaEm || null)
            : null
        }).toJSON(),
        modoOperacional: plano.modo,
        porEmpresa,
        gateProcessado: this._obterGate() ? true : undefined
      };
    } catch (error) {
      const mensagem = error.message || String(error);
      const mensagemEnriquecida = enriquecerMensagemSefazDfeHttp(mensagem);
      const codigoErro = error.code || codigoErroSincronizacaoDfe(mensagemEnriquecida);
      return SincronizacaoResultadoDTO.create({
        sucesso: false,
        notasNovas: 0,
        notasDuplicadas: 0,
        erros: [mensagemEnriquecida],
        mensagem: mensagemEnriquecida,
        mensagemAmigavel: mensagemEnriquecida,
        codigoErro
      }).toJSON();
    }
  }

  /**
   * Lookup documental: chave + empresa do contexto HTTP (05.72).
   * Sem empresaId válido não consulta SQL nem SEFAZ.
   *
   * @param {string} chave
   * @param {{ empresaId?: number|string, modo?: string }} [opcoes]
   * @returns {Promise<Object>}
   */
  async buscarPorChave(chave, opcoes = {}) {
    const empresaId = Number(opcoes.empresaId);
    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      const erro = new Error(
        'Modo MULTIEMPRESA exige empresa explícita (X-Empresa-Id) para consultar a chave. A SEFAZ não foi consultada.'
      );
      erro.code = 'EMPRESA_CENTRAL_AUSENTE';
      erro.statusCode = 400;
      erro.consultaExecutada = false;
      erro.rejeicaoSefaz = false;
      throw erro;
    }

    const chaveLimpa = String(chave || '').replace(/\D/g, '');
    const permitirFallbackGlobal = opcoes.modo === ModoOperacionalGlobal.EMPRESA_SIMPLES;

    const ctxResult = await this._configuracao.obterContextoOperacional({
      empresaId,
      permitirFallbackGlobal,
      db: opcoes.db || this._deps.db
    });
    if (!ctxResult.ok) {
      const erro = new Error(ctxResult.mensagem);
      erro.statusCode = 422;
      erro.codigoErro = ctxResult.codigoErro;
      erro.code = ctxResult.codigoErro;
      erro.consultaExecutada = false;
      erro.rejeicaoSefaz = false;
      throw erro;
    }

    const contextoEmpresa = {
      ...ctxResult.contexto,
      empresaId,
      modo: opcoes.modo
    };
    await resolverIdentidadeConsultaChave({
      contextoCentral: contextoEmpresa,
      modo: opcoes.modo,
      empresaId,
      permitirConfigFiscalGlobal: opcoes.modo === ModoOperacionalGlobal.EMPRESA_SIMPLES
    });

    const documento = await this._documentosRepository.buscarPorChave(chaveLimpa, empresaId);
    const dto = documento ? paraInboxDTO(documento).toJSON() : null;

    return {
      sucesso: Boolean(dto),
      consultaExecutada: false,
      sefazConsultada: false,
      respostaRecebida: false,
      persistenciaCompleta: Boolean(dto),
      recuperacaoConcluida: false,
      estadoConsulta: dto
        ? ESTADOS_CONSULTA_SEFAZ.JA_EXISTE_LOCALMENTE
        : ESTADOS_CONSULTA_SEFAZ.NAO_EXECUTADA,
      codigo: dto ? null : 'CONSULTA_SEFAZ_NAO_AUTORIZADA',
      novo: false,
      notasNovas: 0,
      notasDuplicadas: 0,
      documento: dto,
      mensagem: dto
        ? 'Documento localizado no banco da empresa. A SEFAZ não foi consultada.'
        : 'GET /buscar-chave é somente leitura local. A SEFAZ não foi consultada.'
    };
  }
}

module.exports = CentralSincronizacaoService;
