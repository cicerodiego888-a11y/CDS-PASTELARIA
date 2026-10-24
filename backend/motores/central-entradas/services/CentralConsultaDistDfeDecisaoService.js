/**
 * CentralConsultaDistDfeDecisaoService — Decisão unificada pré-DistDFe (P0.11).
 *
 * Único ponto para avaliar se uma empresa pode iniciar consulta DistDFe localmente:
 * empresa válida, cooldown NSU, Gate 656/593, mutex/concorrência e rate limit.
 *
 * PRONTO_PARA_CONSULTA = verificações locais OK (não implica sucesso SEFAZ).
 * Origem (BACKGROUND / MANUAL / ABRIR_CENTRAL / CONSULTA_DFE_REAL) NÃO bypassa.
 * `forcar` NÃO bypassa cooldown NSU nem Gate (exceto admin Gate já existente no Gate).
 *
 * Fail-closed: falha de leitura/Gate ⇒ bloqueio com código explícito.
 *
 * @module motores/central-entradas/services/CentralConsultaDistDfeDecisaoService
 */

'use strict';

const CentralNsuService = require('./CentralNsuService');
const { logCentral, logCentralErro } = require('../utils/centralLog');
const { obterMutexTransmissaoSefaz } = require('../../../services/fiscal/SefazTransmissaoMutex');

/** Códigos estáveis da decisão (contrato P0.11). */
const CODIGOS_DECISAO = Object.freeze({
  COOLDOWN_ATIVO: 'COOLDOWN_ATIVO',
  FILA_ESGOTADA: 'FILA_ESGOTADA',
  ESTADO_NSU_INCONSISTENTE: 'ESTADO_NSU_INCONSISTENTE',
  AUTORIZACAO_AUSENTE: 'AUTORIZACAO_AUSENTE',
  EMPRESA_INVALIDA: 'EMPRESA_INVALIDA',
  CONSULTA_EM_ANDAMENTO: 'CONSULTA_EM_ANDAMENTO',
  RATE_LIMIT_ATIVO: 'RATE_LIMIT_ATIVO',
  PRONTO_PARA_CONSULTA: 'PRONTO_PARA_CONSULTA',
  GATE_INDISPONIVEL: 'GATE_INDISPONIVEL',
  NSU_INDISPONIVEL: 'NSU_INDISPONIVEL',
  CONTEXTO_INVALIDO: 'CONTEXTO_INVALIDO'
});

/** Intervalo mínimo entre tentativas DistDFe da mesma empresa (anti-rajada local). */
const INTERVALO_RATE_LIMIT_MS = 30 * 1000;

function empresaIdValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

function normalizarAmbiente(ambiente) {
  return Number(ambiente) === 1 ? 1 : 2;
}

function maxIso(...candidatos) {
  let melhor = null;
  let melhorMs = -Infinity;
  for (const c of candidatos) {
    if (!c) continue;
    const ms = new Date(c).getTime();
    if (!Number.isNaN(ms) && ms > melhorMs) {
      melhorMs = ms;
      melhor = new Date(ms).toISOString();
    }
  }
  return melhor;
}

class CentralConsultaDistDfeDecisaoService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    this._nsuService = deps.nsuService
      ?? new CentralNsuService({
        nsuRepository: deps.nsuRepository,
        db: deps.db,
        agora: deps.agora
      });
    this._agora = deps.agora || (() => new Date());
    // gate === null|false → desligado só para testes legados; produção carrega o singleton.
    this._gateDesligado = deps.gate === null || deps.gate === false;
    if (this._gateDesligado) {
      this._gate = null;
    } else if (deps.gate) {
      this._gate = deps.gate;
    } else {
      try {
        this._gate = require('./CentralSefazOperationalGate');
      } catch {
        this._gate = null;
      }
    }
    this._mutex = deps.mutexTransmissaoSefaz || obterMutexTransmissaoSefaz();
    this._syncExecucao = deps.syncExecucao || null;
    this._rateLimitMs = Number.isFinite(deps.rateLimitMs)
      ? Math.max(0, deps.rateLimitMs)
      : INTERVALO_RATE_LIMIT_MS;
    /** @private Map<string, number> empresaId|cnpj|ambiente → epoch ms última tentativa */
    this._ultimasTentativas = deps.ultimasTentativas || new Map();
    this._exigirAutorizacao = deps.exigirAutorizacao !== false;
  }

  static get CODIGOS() {
    return CODIGOS_DECISAO;
  }

  static get INTERVALO_RATE_LIMIT_MS() {
    return INTERVALO_RATE_LIMIT_MS;
  }

  /**
   * Registra tentativa local (após decisão PRONTO / início efetivo).
   * Não avança NSU.
   */
  registrarTentativaLocal({ empresaId, cnpj, ambiente } = {}) {
    const chave = this._chaveContexto({ empresaId, cnpj, ambiente });
    if (!chave) return;
    this._ultimasTentativas.set(chave, this._agora().getTime());
  }

  resetRateLimitParaTeste() {
    this._ultimasTentativas.clear();
  }

  /**
   * Avalia se a empresa pode iniciar DistDFe (somente checks locais).
   *
   * @param {Object} params
   * @param {number} params.empresaId
   * @param {string} params.cnpj
   * @param {number|string} params.ambiente
   * @param {string} [params.origem]
   * @param {Object|null} [params.autorizacaoTransmissaoSefaz]
   * @param {boolean} [params.verificarAutorizacao=true]
   * @param {boolean} [params.verificarRateLimit=true]
   * @param {boolean} [params.verificarMutex=true]
   * @param {boolean} [params.verificarGate=true]
   * @param {boolean} [params.verificarCooldownNsu=true]
   * @param {string} [params.correlationId]
   * @returns {Promise<Object>}
   */
  async avaliar(params = {}) {
    const origem = params.origem || null;
    const correlationId = params.correlationId || null;
    const empresaId = empresaIdValido(params.empresaId);
    const cnpj = normalizarCnpj(params.cnpj);
    const ambiente = params.ambiente == null || params.ambiente === ''
      ? null
      : normalizarAmbiente(params.ambiente);

    const base = {
      permitido: false,
      codigo: CODIGOS_DECISAO.EMPRESA_INVALIDA,
      empresaId,
      cnpj: cnpj || null,
      ambiente,
      origem,
      correlationId,
      consultaExecutada: false,
      sefazConsultada: false,
      cooldownAtivo: false,
      proximaConsultaEm: null,
      motivoCooldown: null,
      detalhe: {}
    };

    if (!empresaId) {
      return this._bloquear(base, {
        codigo: CODIGOS_DECISAO.EMPRESA_INVALIDA,
        mensagem: 'empresaId explícito é obrigatório para consulta DistDFe.',
        mensagemAmigavel: 'Selecione a empresa antes de consultar a SEFAZ.'
      });
    }

    if (cnpj.length !== 14 || ambiente == null) {
      return this._bloquear(base, {
        codigo: CODIGOS_DECISAO.CONTEXTO_INVALIDO,
        mensagem: 'CNPJ e ambiente fiscais são obrigatórios para decidir a consulta DistDFe.',
        mensagemAmigavel: 'Contexto fiscal da empresa incompleto (CNPJ/ambiente).'
      });
    }

    base.empresaId = empresaId;
    base.cnpj = cnpj;
    base.ambiente = ambiente;

    // 1) Mutex / consulta em andamento (escopo CNPJ+ambiente quando disponível)
    if (params.verificarMutex !== false) {
      const emAndamento = this._avaliarMutex({ cnpj, ambiente });
      if (emAndamento) {
        return this._bloquear(base, {
          codigo: CODIGOS_DECISAO.CONSULTA_EM_ANDAMENTO,
          mensagem: emAndamento.mensagem,
          mensagemAmigavel: emAndamento.mensagem,
          detalhe: { lockDono: emAndamento.lockDono }
        });
      }
    }

    // 2) Rate limit local por empresa+CNPJ+ambiente
    if (params.verificarRateLimit !== false && this._rateLimitMs > 0) {
      const rl = this._avaliarRateLimit({ empresaId, cnpj, ambiente });
      if (rl.ativo) {
        return this._bloquear(base, {
          codigo: CODIGOS_DECISAO.RATE_LIMIT_ATIVO,
          mensagem: `Consulta DistDFe recente para esta empresa. Aguarde até ${rl.proximaConsultaEm}.`,
          mensagemAmigavel: 'Evite consultas repetidas em sequência. Aguarde alguns segundos e tente novamente.',
          proximaConsultaEm: rl.proximaConsultaEm,
          detalhe: { rateLimitMs: this._rateLimitMs }
        });
      }
    }

    // 3) Cooldown NSU (fonte: central_entradas_nsu.cooldown_ate / fila esgotada)
    let cooldownNsu = { ativo: false };
    if (params.verificarCooldownNsu !== false) {
      try {
        const controle = await this._nsuService.buscarPorCnpjAmbiente(cnpj, ambiente);
        cooldownNsu = this._nsuService.avaliarCooldown(controle) || { ativo: false };
        base.detalhe.ultNsu = controle?.ultNsu || null;
        base.detalhe.maxNsu = controle?.maxNsu || null;
        base.detalhe.ultimoCstat = controle?.ultimoCstat || controle?.ultimo_cstat || null;
      } catch (error) {
        logCentralErro('DISTDFE_DECISAO', error, {
          Motivo: 'nsu_indisponivel',
          EmpresaId: empresaId,
          CorrelationId: correlationId
        });
        return this._bloquear(base, {
          codigo: CODIGOS_DECISAO.NSU_INDISPONIVEL,
          mensagem: 'Estado do NSU/cooldown indisponível — consulta bloqueada (fail-closed).',
          mensagemAmigavel: 'Não foi possível verificar o cooldown da empresa. Consulta não enviada.',
          detalhe: { erro: error.message }
        });
      }
    }

    // 4) Gate operacional (656 progressivo / 593) — fail-closed se Gate falhar
    let bloqueioGate = null;
    if (params.verificarGate !== false && !this._gateDesligado) {
      const gate = this._obterGate();
      if (!gate || typeof gate.avaliarBloqueioContexto !== 'function') {
        logCentral('DISTDFE_DECISAO', {
          Evento: 'GATE_INDISPONIVEL',
          EmpresaId: empresaId,
          CorrelationId: correlationId,
          Resultado: 'BLOQUEADO'
        });
        return this._bloquear(base, {
          codigo: CODIGOS_DECISAO.GATE_INDISPONIVEL,
          mensagem: 'Gate operacional SEFAZ indisponível — consulta bloqueada (fail-closed).',
          mensagemAmigavel: 'Gate operacional indisponível. Consulta DistDFe não enviada.'
        });
      }
      try {
        const aval = await gate.avaliarBloqueioContexto({
          empresaId,
          cnpj,
          ambiente,
          origem,
          correlationId
        });
        if (aval && aval.bloqueado) {
          bloqueioGate = aval;
        }
      } catch (error) {
        logCentralErro('DISTDFE_DECISAO', error, {
          Motivo: 'gate_falha_avaliacao',
          EmpresaId: empresaId,
          CorrelationId: correlationId
        });
        return this._bloquear(base, {
          codigo: CODIGOS_DECISAO.GATE_INDISPONIVEL,
          mensagem: `Falha ao avaliar Gate SEFAZ: ${error.message}`,
          mensagemAmigavel: 'Falha ao verificar bloqueio operacional. Consulta não enviada.',
          detalhe: { erro: error.message }
        });
      }
    }

    const nsuBloqueia = !!cooldownNsu.ativo;
    const gate656 = !!(bloqueioGate && bloqueioGate.cStat === '656');
    const proxima = maxIso(
      nsuBloqueia ? cooldownNsu.proximaConsultaEm : null,
      bloqueioGate?.bloqueio656?.bloqueadoAte || bloqueioGate?.proximaConsultaEm || null
    );

    if (nsuBloqueia || gate656) {
      const msgNsu = nsuBloqueia
        ? CentralNsuService.montarMensagemCooldown(cooldownNsu)
        : null;
      let codigo = CODIGOS_DECISAO.COOLDOWN_ATIVO;
      if (nsuBloqueia && cooldownNsu.motivo === 'FILA_ESGOTADA') {
        codigo = CODIGOS_DECISAO.FILA_ESGOTADA;
      } else if (nsuBloqueia && cooldownNsu.motivo === 'ESTADO_NSU_INCONSISTENTE') {
        codigo = CODIGOS_DECISAO.ESTADO_NSU_INCONSISTENTE;
      }
      return this._bloquear(base, {
        codigo,
        mensagem: msgNsu
          || 'Consulta DistDFe bloqueada: cooldown/consumo indevido (cStat 656) ainda vigente.',
        mensagemAmigavel: msgNsu
          || 'Cooldown SEFAZ ativo (cStat 656). Aguarde a liberação antes de nova consulta.',
        cooldownAtivo: true,
        proximaConsultaEm: proxima,
        motivoCooldown: cooldownNsu.motivo
          || (bloqueioGate ? 'GATE_656' : null),
        detalhe: {
          ...base.detalhe,
          cooldownNsu: nsuBloqueia ? {
            motivo: cooldownNsu.motivo,
            proximaConsultaEm: cooldownNsu.proximaConsultaEm,
            detalhe: cooldownNsu.detalhe || null
          } : null,
          gate: bloqueioGate ? {
            cStat: bloqueioGate.cStat,
            escopo: bloqueioGate.escopo,
            bloqueadoAte: bloqueioGate.bloqueio656?.bloqueadoAte || null
          } : null
        }
      });
    }

    if (bloqueioGate && bloqueioGate.cStat === '593') {
      return this._bloquear(base, {
        codigo: 'ERRO_CONFIGURACAO_CERTIFICADO',
        mensagem: 'Consultas suspensas: CNPJ-base diferente do certificado (cStat 593).',
        mensagemAmigavel: 'Configuração de certificado inválida (593). Corrija antes de consultar.',
        detalhe: { gate: { cStat: '593', escopo: bloqueioGate.escopo } }
      });
    }

    // 5) Autorização de transmissão (CE-PASTELARIA-04 — fail-closed).
    // BACKGROUND / ABRIR_CENTRAL / CONSULTA_DFE_REAL nunca bypassam via permitirSemAutorizacao.
    // somenteDiagnostico=true (diagnosticarEmpresa) permanece sem exigir auth (não transmite).
    const origemNorm = String(origem || '').toLowerCase();
    const origemExigeAuth = origemNorm === 'background'
      || origemNorm === 'abrir_central'
      || origemNorm === 'diagnostico_probe'
      || origemNorm === 'diagnostico'
      || String(origem) === 'CONSULTA_DFE_REAL'
      || String(origem) === 'DIAGNOSTICO_PROBE';
    const somenteDiagnostico = params.somenteDiagnostico === true;
    const verificarAuth = !somenteDiagnostico
      && this._exigirAutorizacao
      && (origemExigeAuth || params.verificarAutorizacao !== false);

    if (verificarAuth) {
      const auth = params.autorizacaoTransmissaoSefaz;
      const permitirSem = !origemExigeAuth && params.permitirSemAutorizacao === true;
      if (!auth || !auth.modo) {
        if (!permitirSem) {
          return this._bloquear(base, {
            codigo: CODIGOS_DECISAO.AUTORIZACAO_AUSENTE,
            mensagem: 'Transmissão DistDFe sem autorização operacional. Consulta não enviada.',
            mensagemAmigavel: 'Falta autorização operacional para consultar a SEFAZ nesta origem.'
          });
        }
      } else {
        const authEmp = empresaIdValido(auth.empresaId);
        if (authEmp != null && authEmp !== empresaId) {
          return this._bloquear(base, {
            codigo: CODIGOS_DECISAO.AUTORIZACAO_AUSENTE,
            mensagem: 'Autorização DistDFe vinculada a outra empresa. Consulta não enviada.',
            mensagemAmigavel: 'A autorização operacional não corresponde à empresa selecionada.',
            detalhe: { empresaIdAuth: authEmp, empresaIdSolicitada: empresaId }
          });
        }
      }
    }

    logCentral('DISTDFE_DECISAO', {
      Evento: 'PRONTO_PARA_CONSULTA',
      EmpresaId: empresaId,
      Origem: origem,
      CorrelationId: correlationId,
      Ambiente: ambiente,
      Resultado: 'OK'
    });

    return {
      ...base,
      permitido: true,
      codigo: CODIGOS_DECISAO.PRONTO_PARA_CONSULTA,
      mensagem: 'Verificações locais OK. Pronto para consulta DistDFe autorizada '
        + '(não implica aceitação pela SEFAZ).',
      mensagemAmigavel: 'Empresa liberada localmente para consulta controlada. '
        + 'A SEFAZ pode ainda rejeitar a consulta.',
      cooldownAtivo: false,
      proximaConsultaEm: null
    };
  }

  /**
   * Diagnóstico sem SOAP: estado de cooldown/prontidão para uma empresa.
   * Não registra rate limit nem dispara consulta.
   */
  async diagnosticarEmpresa(params = {}) {
    return this.avaliar({
      ...params,
      verificarAutorizacao: false,
      verificarRateLimit: false,
      verificarMutex: true,
      permitirSemAutorizacao: true,
      somenteDiagnostico: true
    });
  }

  /** @private */
  _obterGate() {
    if (this._gate === null || this._gate === false) return null;
    return this._gate;
  }

  /** @private */
  _chaveContexto({ empresaId, cnpj, ambiente }) {
    const id = empresaIdValido(empresaId);
    const c = normalizarCnpj(cnpj);
    if (!id || c.length !== 14 || ambiente == null) return null;
    return `${id}|${c}|${normalizarAmbiente(ambiente)}`;
  }

  /** @private */
  _avaliarMutex(escopo = {}) {
    if (this._syncExecucao && typeof this._syncExecucao.estaExecutando === 'function') {
      if (this._syncExecucao.estaExecutando()) {
        const estado = typeof this._syncExecucao.obterEstado === 'function'
          ? this._syncExecucao.obterEstado()
          : {};
        return {
          ativo: true,
          lockDono: estado.lockDono || 'sync',
          mensagem: `Consulta DistDFe já em andamento (${estado.lockDono || 'sync'}).`
        };
      }
    }
    if (this._mutex && typeof this._mutex.estaOcupado === 'function'
      && this._mutex.estaOcupado({ cnpj: escopo.cnpj, ambiente: escopo.ambiente, tipo: 'distNSU' })) {
      if (typeof this._mutex.estaNoContexto === 'function' && this._mutex.estaNoContexto()) {
        return null;
      }
      return {
        ativo: true,
        lockDono: typeof this._mutex.dono === 'function' ? this._mutex.dono() : null,
        mensagem: `Transmissão SEFAZ já em andamento (${this._mutex.dono?.() || 'mutex'}).`
      };
    }
    return null;
  }

  /** @private */
  _avaliarRateLimit({ empresaId, cnpj, ambiente }) {
    const chave = this._chaveContexto({ empresaId, cnpj, ambiente });
    if (!chave) return { ativo: false };
    const ultima = this._ultimasTentativas.get(chave);
    if (ultima == null) return { ativo: false };
    const agora = this._agora().getTime();
    const liberacao = ultima + this._rateLimitMs;
    if (agora < liberacao) {
      return { ativo: true, proximaConsultaEm: new Date(liberacao).toISOString() };
    }
    return { ativo: false };
  }

  /** @private */
  _bloquear(base, campos) {
    const out = {
      ...base,
      permitido: false,
      codigo: campos.codigo,
      mensagem: campos.mensagem,
      mensagemAmigavel: campos.mensagemAmigavel || campos.mensagem,
      cooldownAtivo: campos.cooldownAtivo === true
        || campos.codigo === CODIGOS_DECISAO.COOLDOWN_ATIVO
        || campos.codigo === CODIGOS_DECISAO.FILA_ESGOTADA
        || campos.codigo === CODIGOS_DECISAO.ESTADO_NSU_INCONSISTENTE,
      proximaConsultaEm: campos.proximaConsultaEm || null,
      motivoCooldown: campos.motivoCooldown || null,
      detalhe: { ...base.detalhe, ...(campos.detalhe || {}) }
    };
    logCentral('DISTDFE_DECISAO', {
      Evento: 'BLOQUEIO',
      Codigo: out.codigo,
      EmpresaId: out.empresaId,
      Origem: out.origem,
      CorrelationId: out.correlationId,
      ProximaConsultaEm: out.proximaConsultaEm,
      Resultado: 'BLOQUEADO'
    });
    return out;
  }
}

module.exports = CentralConsultaDistDfeDecisaoService;
module.exports.CentralConsultaDistDfeDecisaoService = CentralConsultaDistDfeDecisaoService;
module.exports.CODIGOS_DECISAO = CODIGOS_DECISAO;
