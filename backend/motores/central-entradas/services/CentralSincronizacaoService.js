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
const {
  sincronizarDistribuicaoDFe,
  consultarNotaPorChave
} = require('../../../services/fiscal/distribuicaoDFe');
const { paraInboxDTO } = require('../utils/centralEntradasMapper');
const {
  listarAlvosSincronizacaoCentral
} = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../../core/modo-operacional');
const {
  enriquecerMensagemSefazDfeHttp,
  codigoErroSincronizacaoDfe
} = require('../utils/mensagemSefazDfeHttp');

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
    this._deps = deps;
    /** @private */
    this._consultarNotaPorChave = deps.consultarNotaPorChave || consultarNotaPorChave;
    /** @private */
    this._sincronizarDfe = deps.sincronizarDistribuicaoDFe || sincronizarDistribuicaoDFe;
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

    if (!opcoes.ignorarCooldown) {
      try {
        const ambiente = Number(contexto.ambiente) === 1 ? 1 : 2;
        const controle = await this._nsuService.buscarPorCnpjAmbiente(contexto.cnpj, ambiente);
        const cooldown = this._nsuService.avaliarCooldown(controle);
        if (cooldown && cooldown.ativo) {
          return {
            sucesso: true,
            ignorado: true,
            pulado: true,
            empresaId,
            cnpj: contexto.cnpj,
            codigo: 'AGUARDAR_JANELA_DFE',
            mensagem: 'Consulta DF-e adiada (cooldown por CNPJ).',
            proximaConsultaEm: cooldown.proximaConsultaEm,
            ultNsu: cooldown.ultNsu,
            maxNsu: cooldown.maxNsu,
            notasNovas: 0,
            notasDuplicadas: 0
          };
        }
      } catch { /* cooldown indisponível — segue */ }
    }

    const persistencia = new CentralDfePersistenciaService({
      documentosRepository: this._documentosRepository,
      empresaId
    });

    try {
      const resultado = await this._sincronizarDfe({
        maxIteracoes: opcoes.maxIteracoes ?? contexto.syncMaxDocumentos,
        contextoCentral: contexto,
        nsuRepository: this._nsuRepository,
        nsuService: this._nsuService,
        persistenciaService: persistencia,
        correlationId: opcoes.correlationId || null
      });

      const mensagem = enriquecerMensagemSefazDfeHttp(
        resultado.mensagem || (resultado.erros && resultado.erros[0]) || '',
        { ambiente: contexto.ambiente }
      );

      return {
        ...resultado,
        sucesso: resultado.sucesso !== false,
        empresaId,
        cnpj: contexto.cnpj,
        ambiente: contexto.ambiente,
        mensagem: mensagem || resultado.mensagem,
        mensagemAmigavel: mensagem || resultado.mensagemAmigavel || resultado.mensagem
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
      let algumSucesso = false;
      let ultimoOk = null;

      for (const alvo of plano.alvos) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this._sincronizarEmpresa(alvo, {
          ...opcoes,
          modo: plano.modo
        });
        porEmpresa.push({
          empresaId: r.empresaId,
          cnpj: r.cnpj,
          sucesso: r.sucesso !== false,
          pulado: !!r.pulado,
          ignorado: !!r.ignorado,
          notasNovas: r.notasNovas || 0,
          notasDuplicadas: r.notasDuplicadas || 0,
          ultNsu: r.ultNsu || null,
          maxNsu: r.maxNsu || null,
          cStat: r.cStat || null,
          mensagem: r.mensagem || null,
          codigoErro: r.codigoErro || r.codigo || null
        });

        notasNovas += Number(r.notasNovas) || 0;
        notasDuplicadas += Number(r.notasDuplicadas) || 0;
        ignorados += Number(r.ignorados) || 0;
        if (r.sucesso !== false && !r.pulado) {
          algumSucesso = true;
          ultimoOk = r;
        } else if (r.sucesso === false && r.mensagem) {
          erros.push(`[empresa ${r.empresaId}] ${r.mensagem}`);
        }
      }

      const sucesso = algumSucesso || (erros.length === 0 && porEmpresa.every((p) => p.sucesso));
      const mensagem = sucesso
        ? (plano.modo === ModoOperacionalGlobal.MULTIEMPRESA
          ? `Sincronização multiempresa: ${porEmpresa.length} empresa(s)`
          : (ultimoOk && ultimoOk.mensagem) || 'Sincronização concluída')
        : (erros[0] || 'Falha na sincronização');
      const codigosFalha = porEmpresa
        .filter((p) => p.sucesso === false)
        .map((p) => p.codigoErro)
        .filter(Boolean);
      const codigoErro = sucesso
        ? null
        : (codigosFalha.find((c) => c === 'CERTIFICADO' || c === 'CNPJ' || c === 'CONFIG_FISCAL')
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
          codigoErro
        }).toJSON(),
        modoOperacional: plano.modo,
        porEmpresa
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
        'Modo MULTIEMPRESA exige empresa explícita (X-Empresa-Id) para consultar a chave.'
      );
      erro.code = 'EMPRESA_CENTRAL_AUSENTE';
      erro.statusCode = 400;
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
      throw erro;
    }

    // RC3.4.1 — Gate único também cobre consChNFe (buscar-chave).
    if (this._deps.pularGateConsultaChave !== true) {
      try {
        const gate = require('./CentralSefazOperationalGate');
        const auth = await gate.autorizarConsultaDistDfe({
          chave: chaveLimpa,
          motivo: 'buscar_chave_consChNFe',
          origem: 'api'
        });
        if (!auth.permitido) {
          const erro = new Error(auth.mensagem || 'Consulta bloqueada pelo Gate SEFAZ.');
          erro.statusCode = 429;
          erro.codigoErro = auth.codigo;
          erro.detalhe = auth;
          throw erro;
        }
      } catch (gateErr) {
        if (gateErr.statusCode) throw gateErr;
        // Gate indisponível: não bloqueia busca manual pontual (compat).
      }
    }

    const resultado = await this._consultarNotaPorChave(chaveLimpa, {
      contextoCentral: { ...ctxResult.contexto, empresaId }
    });

    try {
      if (this._deps.pularGateConsultaChave !== true && resultado?.cStat) {
        await require('./CentralSefazOperationalGate').processarRespostaSefaz(resultado, {
          chave: chaveLimpa
        });
      }
    } catch { /* ignore */ }

    const documento = await this._documentosRepository.buscarPorChave(chaveLimpa, empresaId);

    return {
      ...resultado,
      novo: resultado.notasNovas > 0,
      documento: documento ? paraInboxDTO(documento).toJSON() : null
    };
  }
}

module.exports = CentralSincronizacaoService;
