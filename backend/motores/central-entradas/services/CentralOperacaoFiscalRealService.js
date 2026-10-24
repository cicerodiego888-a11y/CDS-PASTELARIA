/**
 * Ativação controlada da operação fiscal real (DistDFe) por empresa.
 *
 * Não usa apenas variável de ambiente. Exige:
 * - habilitação administrativa persistida por empresa;
 * - pré-voo (empresa, certificado apto, ambiente produção, endpoint, NSU/cooldown);
 * - confirmação explícita da consulta real na requisição;
 * - autorização OPERACAO_REAL de curta duração (sem 210210).
 *
 * Não executa SOAP por si só — apenas valida e emite autorização para o sync.
 */
'use strict';

const crypto = require('crypto');
const {
  MODO_OPERACAO_REAL,
  TIPOS_CONSULTA_DFE_SEFAZ,
  TIPOS_CONSULTA_SEFAZ,
  CODIGOS_AUTORIZACAO_SEFAZ,
  empresaIdValido,
  normalizarCnpjAuth,
  criarAutorizacaoOperacaoReal,
  avaliarAutorizacaoTransmissao,
  criarErroTransmissaoNaoAutorizada
} = require('../../../services/fiscal/autorizacaoTransmissaoSefaz');
const CentralConfigRepository = require('../repositories/CentralConfigRepository');
const CentralConfiguracaoService = require('./CentralConfiguracaoService');
const CentralNsuService = require('./CentralNsuService');
const CentralConsultaDistDfeDecisaoService = require('./CentralConsultaDistDfeDecisaoService');
const { exigirCertificadoAptoParaUsoFiscal } = require('../../../services/fiscal/CertificadoUsoFiscalGate');

const CHAVE_PREFIX = 'operacao_fiscal_real_empresa_';

/** Etapas estáveis para diagnóstico HTTP (P0.9.3). */
const ETAPAS_BLOQUEIO = Object.freeze({
  EMPRESA: 'empresa',
  CONFIRMACAO: 'confirmacao',
  ATIVACAO: 'ativacao',
  AMBIENTE: 'ambiente',
  CERTIFICADO: 'certificado',
  CNPJ: 'cnpj',
  ENDPOINT: 'endpoint',
  NSU: 'nsu',
  COOLDOWN: 'cooldown',
  AUTORIZACAO: 'autorizacao',
  PRE_VOO: 'pre_voo',
  DESCONHECIDO: 'desconhecido'
});

function chaveAtivacao(empresaId) {
  return `${CHAVE_PREFIX}${empresaId}`;
}

function perfilAdmin(usuario) {
  if (!usuario) return false;
  const p = String(usuario.perfil || usuario.role || '').toUpperCase();
  return p === 'SUPER_ADMIN' || p === 'ADMIN' || p === 'admin' || usuario.role === 'admin';
}

function etapaPorCodigoPreVoo(codigo) {
  const c = String(codigo || '');
  if (
    c === 'COOLDOWN_ATIVO'
    || c === 'FILA_ESGOTADA'
    || c === 'ESTADO_NSU_INCONSISTENTE'
  ) {
    return ETAPAS_BLOQUEIO.COOLDOWN;
  }
  if (c === 'EMPRESA_OBRIGATORIA' || c === 'CONTEXTO_INVALIDO') return ETAPAS_BLOQUEIO.EMPRESA;
  if (c === 'AMBIENTE_NAO_PRODUCAO') return ETAPAS_BLOQUEIO.AMBIENTE;
  if (c === 'CNPJ_AUSENTE' || c === 'IDENTIDADE_FISCAL_INCONSISTENTE') return ETAPAS_BLOQUEIO.CNPJ;
  if (/CERTIFICADO/i.test(c)) return ETAPAS_BLOQUEIO.CERTIFICADO;
  if (/ENDPOINT/i.test(c)) return ETAPAS_BLOQUEIO.ENDPOINT;
  if (c === 'NSU_INDISPONIVEL') return ETAPAS_BLOQUEIO.NSU;
  return ETAPAS_BLOQUEIO.PRE_VOO;
}

function formatarHorarioLiberacao(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
  } catch {
    return String(iso);
  }
}

function montarErroConsultaDfe({ codigo, mensagem, mensagemAmigavel, statusCode, preVoo, etapa, proximaConsultaEm } = {}) {
  const err = new Error(mensagem || 'Consulta DF-e bloqueada.');
  err.code = codigo || 'CONSULTA_DFE_BLOQUEADA';
  err.codigo = err.code;
  err.statusCode = statusCode || 422;
  err.etapa = etapa || etapaPorCodigoPreVoo(codigo) || ETAPAS_BLOQUEIO.DESCONHECIDO;
  err.mensagemAmigavel = mensagemAmigavel || mensagem || err.message;
  err.preVoo = preVoo || null;
  err.proximaConsultaEm = proximaConsultaEm
    || preVoo?.proximaConsultaEm
    || preVoo?.nsu?.proximaConsultaEm
    || null;
  err.consultaExecutada = false;
  err.sefazConsultada = false;
  return err;
}

function logBloqueioConsultaDfe(extra = {}) {
  // Sem tokens, senhas ou seed — apenas diagnóstico operacional.
  const payload = {
    area: 'OPERACAO_FISCAL_REAL',
    evento: 'CONSULTA_DFE_BLOQUEADA',
    etapa: extra.etapa || null,
    codigo: extra.codigo || null,
    empresaId: extra.empresaId || null,
    proximaConsultaEm: extra.proximaConsultaEm || null,
    mensagem: extra.mensagem || null
  };
  try {
    // eslint-disable-next-line no-console
    console.warn('[CentralEntradas][OPERACAO_FISCAL_REAL]', JSON.stringify(payload));
  } catch { /* ignore */ }
}

class CentralOperacaoFiscalRealService {
  constructor(deps = {}) {
    this._configRepo = deps.configRepository || new CentralConfigRepository({ db: deps.db });
    this._configuracao = deps.configuracaoService || new CentralConfiguracaoService(deps);
    this._nsuService = deps.nsuService || new CentralNsuService(deps);
    this._decisaoDistDfe = deps.decisaoDistDfe
      || new CentralConsultaDistDfeDecisaoService({
        nsuService: this._nsuService,
        gate: deps.gate,
        agora: deps.agora,
        rateLimitMs: deps.rateLimitMs != null ? deps.rateLimitMs : 0
      });
    this._exigirCert = deps.exigirCertificadoAptoParaUsoFiscal || exigirCertificadoAptoParaUsoFiscal;
    this._db = deps.db || null;
  }

  async _lerAtivacao(empresaId) {
    const reg = await this._configRepo.buscarPorChave(chaveAtivacao(empresaId));
    if (!reg) return null;
    const valor = this._configRepo.parseValor(reg);
    return valor && typeof valor === 'object' ? valor : null;
  }

  async _gravarAtivacao(empresaId, dados) {
    await this._configRepo.salvar(chaveAtivacao(empresaId), dados, 'json');
    return dados;
  }

  /**
   * Pré-voo sem SOAP. Retorna checklist estruturado.
   */
  async executarPreVoo(empresaId, opts = {}) {
    const id = empresaIdValido(empresaId);
    const itens = [];
    const falhou = (codigo, mensagem) => {
      itens.push({ ok: false, codigo, mensagem });
      return {
        ok: false,
        empresaId: id,
        itens,
        codigo,
        mensagem,
        mensagemAmigavel: mensagem,
        etapa: etapaPorCodigoPreVoo(codigo)
      };
    };

    if (!id) {
      return falhou('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório para operação fiscal real.');
    }
    itens.push({ ok: true, codigo: 'EMPRESA_OK', mensagem: `Empresa ${id} identificada.` });

    const ctxResult = await this._configuracao.obterContextoOperacional({
      empresaId: id,
      permitirFallbackGlobal: false,
      db: opts.db || this._db
    });
    if (!ctxResult.ok) {
      return falhou(ctxResult.codigoErro || 'CONTEXTO_INVALIDO', ctxResult.mensagem || 'Contexto fiscal inválido.');
    }
    const ctx = ctxResult.contexto;
    const ambiente = Number(ctx.ambiente) === 1 ? 1 : 2;
    if (ambiente !== 1 && opts.exigirProducao !== false) {
      return falhou(
        'AMBIENTE_NAO_PRODUCAO',
        'Operação fiscal real exige ambiente de produção selecionado explicitamente (tpAmb=1). '
          + `Ambiente atual: ${ambiente === 1 ? 'Produção' : 'Homologação'}.`
      );
    }
    itens.push({
      ok: true,
      codigo: 'AMBIENTE_OK',
      mensagem: ambiente === 1 ? 'Ambiente de produção.' : 'Homologação (ativação de teste controlada).'
    });

    if (!ctx.cnpj) {
      return falhou('CNPJ_AUSENTE', 'CNPJ da empresa não encontrado no contexto fiscal.');
    }
    itens.push({ ok: true, codigo: 'CNPJ_OK', mensagem: `CNPJ ${ctx.cnpj}.` });

    if (opts.exigirEndpoint !== false) {
      try {
        const core = require('../../../services/fiscal/core');
        const FiscalWebServices = core.FiscalWebServices || core;
        const EnvironmentType = core.EnvironmentType;
        const ModelType = core.ModelType;
        const OperationType = core.OperationType;
        const platform = typeof FiscalWebServices === 'function'
          ? new FiscalWebServices()
          : new core.FiscalWebServices();
        const resolution = platform.resolve({
          modelo: ModelType.NFE,
          operacao: OperationType.DISTRIBUICAO_DFE,
          ambiente: ambiente === 1 ? EnvironmentType.PRODUCAO : EnvironmentType.HOMOLOGACAO,
          uf: 'SVRS',
          versao: '1.01'
        });
        if (resolution && resolution.success) {
          itens.push({
            ok: true,
            codigo: 'ENDPOINT_OK',
            mensagem: 'Endpoint DF-e resolvido pelo mecanismo oficial.'
          });
        } else {
          // Soft: o envio DistDFe revalida o endpoint oficial; não bloquear ativação só pelo probe.
          itens.push({
            ok: true,
            codigo: 'ENDPOINT_PENDENTE',
            mensagem: 'Endpoint DF-e não confirmado no pré-voo; será exigido no envio SOAP oficial.'
          });
        }
      } catch (err) {
        itens.push({
          ok: true,
          codigo: 'ENDPOINT_SKIP',
          mensagem: 'Resolver de endpoint será validado no envio SOAP.'
        });
      }
    }

    try {
      await this._exigirCert({
        empresaId: id,
        db: opts.db || this._db,
        persistirSnapshot: false
      });
      itens.push({ ok: true, codigo: 'CERTIFICADO_OK', mensagem: 'Certificado A1 apto para uso fiscal.' });
    } catch (err) {
      return falhou(
        err.code || 'CERTIFICADO_INVALIDO',
        err.message || 'Certificado A1 inválido ou não apto.'
      );
    }

    let nsuInfo = null;
    try {
      const controle = await this._nsuService.buscarPorCnpjAmbiente(ctx.cnpj, ambiente);
      // P0.11 — decisão unificada (NSU + Gate). Diagnóstico não dispara SOAP.
      const decisao = await this._decisaoDistDfe.diagnosticarEmpresa({
        empresaId: id,
        cnpj: ctx.cnpj,
        ambiente,
        origem: 'PRE_VOO_OPERACAO_REAL'
      });
      const cooldownAtivo = decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.COOLDOWN_ATIVO
        || decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.FILA_ESGOTADA
        || decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.ESTADO_NSU_INCONSISTENTE
        || decisao.cooldownAtivo === true;
      const codigoBloqueioNsu = (
        decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.FILA_ESGOTADA
        || decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.ESTADO_NSU_INCONSISTENTE
        || decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.COOLDOWN_ATIVO
      ) ? decisao.codigo : 'COOLDOWN_ATIVO';
      nsuInfo = {
        ultNsu: controle?.ultNsu || decisao.detalhe?.ultNsu || '000000000000000',
        maxNsu: controle?.maxNsu || decisao.detalhe?.maxNsu || null,
        cooldownAtivo,
        proximaConsultaEm: decisao.proximaConsultaEm || null,
        motivoCooldown: decisao.motivoCooldown || null,
        codigoDecisao: decisao.codigo,
        estadoDecisao: decisao.codigo
      };
      if (cooldownAtivo) {
        const liberacaoIso = nsuInfo.proximaConsultaEm;
        const liberacaoLabel = formatarHorarioLiberacao(liberacaoIso) || liberacaoIso || 'após a janela oficial';
        const msgCd = decisao.mensagemAmigavel
          || decisao.mensagem
          || `Cooldown SEFAZ ativo. Nova consulta a partir de ${liberacaoLabel}.`;
        const bloquearPorCooldown = opts.bloquearPorCooldown !== false;
        if (bloquearPorCooldown) {
          return {
            ok: false,
            empresaId: id,
            itens: itens.concat([{ ok: false, codigo: codigoBloqueioNsu, mensagem: msgCd }]),
            codigo: codigoBloqueioNsu,
            etapa: ETAPAS_BLOQUEIO.COOLDOWN,
            mensagem: `Consulta DistDFe bloqueada localmente até ${liberacaoLabel}.`,
            mensagemAmigavel: msgCd,
            nsu: nsuInfo,
            decisao,
            proximaConsultaEm: liberacaoIso,
            contexto: { cnpj: ctx.cnpj, ambiente }
          };
        }
        itens.push({
          ok: true,
          codigo: 'COOLDOWN_AVISO',
          mensagem: `${msgCd} A ativação pode seguir; a consulta DistDFe permanecerá bloqueada até a liberação.`
        });
        return {
          ok: true,
          empresaId: id,
          itens,
          nsu: nsuInfo,
          decisao,
          avisoCooldown: true,
          proximaConsultaEm: liberacaoIso,
          contexto: {
            cnpj: ctx.cnpj,
            ambiente,
            nomeEmpresa: ctx.nomeEmpresa || ctx.razaoSocial || null
          },
          mensagem: `Pré-voo OK para ativação. Consulta DistDFe bloqueada por cooldown até ${liberacaoLabel}.`
        };
      }
      if (
        decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.CONSULTA_EM_ANDAMENTO
        || decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.NSU_INDISPONIVEL
        || decisao.codigo === CentralConsultaDistDfeDecisaoService.CODIGOS.GATE_INDISPONIVEL
        || decisao.codigo === 'ERRO_CONFIGURACAO_CERTIFICADO'
      ) {
        if (opts.bloquearPorCooldown !== false) {
          return {
            ok: false,
            empresaId: id,
            itens: itens.concat([{
              ok: false,
              codigo: decisao.codigo,
              mensagem: decisao.mensagemAmigavel || decisao.mensagem
            }]),
            codigo: decisao.codigo,
            etapa: etapaPorCodigoPreVoo(decisao.codigo),
            mensagem: decisao.mensagem,
            mensagemAmigavel: decisao.mensagemAmigavel || decisao.mensagem,
            nsu: nsuInfo,
            decisao,
            proximaConsultaEm: decisao.proximaConsultaEm || null,
            contexto: { cnpj: ctx.cnpj, ambiente }
          };
        }
      }
      itens.push({
        ok: true,
        codigo: 'NSU_OK',
        mensagem: `NSU pronto (ultNSU=${nsuInfo.ultNsu}). Decisão: ${decisao.codigo}.`
      });
    } catch (err) {
      itens.push({
        ok: false,
        codigo: 'NSU_INDISPONIVEL',
        mensagem: err.message || 'Não foi possível ler o estado do NSU.'
      });
      return {
        ok: false,
        empresaId: id,
        itens,
        codigo: 'NSU_INDISPONIVEL',
        etapa: ETAPAS_BLOQUEIO.NSU,
        mensagem: 'Estado do NSU indisponível.',
        mensagemAmigavel: err.message || 'Estado do NSU indisponível.'
      };
    }

    return {
      ok: true,
      empresaId: id,
      itens,
      nsu: nsuInfo,
      contexto: {
        cnpj: ctx.cnpj,
        ambiente,
        nomeEmpresa: ctx.nomeEmpresa || ctx.razaoSocial || null
      }
    };
  }

  async obterStatus(empresaId) {
    const id = empresaIdValido(empresaId);
    if (!id) {
      return {
        ativa: false,
        empresaId: null,
        codigo: 'EMPRESA_OBRIGATORIA',
        mensagem: 'Selecione a empresa para ver o status da operação fiscal real.'
      };
    }
    const ativacao = await this._lerAtivacao(id);
    const preVoo = await this.executarPreVoo(id, { exigirProducao: true });
    return {
      ativa: !!(ativacao && ativacao.ativa),
      empresaId: id,
      ativadaEm: ativacao?.ativadaEm || null,
      ativadaPorUsuarioId: ativacao?.ativadaPorUsuarioId || null,
      tiposPermitidos: ativacao?.tiposPermitidos || [...TIPOS_CONSULTA_DFE_SEFAZ],
      manifestacaoAutomatica: false,
      modo: MODO_OPERACAO_REAL,
      preVoo,
      mensagem: ativacao?.ativa
        ? (preVoo.ok
          ? 'Operação fiscal real habilitada. Use a ação explícita de consulta DF-e.'
          : `Habilitada, mas pré-voo bloqueado: ${preVoo.mensagem}`)
        : 'Operação fiscal real desabilitada. Consultas DistDFe permanecem bloqueadas.'
    };
  }

  async habilitar({ empresaId, usuario, confirmarAmbienteProducao, confirmarRisco } = {}) {
    if (!perfilAdmin(usuario)) {
      const err = new Error('Apenas administrador autorizado pode habilitar a operação fiscal real.');
      err.code = 'ADMIN_OBRIGATORIO';
      err.statusCode = 403;
      throw err;
    }
    if (confirmarAmbienteProducao !== true || confirmarRisco !== true) {
      const err = new Error(
        'Confirme explicitamente o ambiente de produção e o risco operacional para habilitar.'
      );
      err.code = 'CONFIRMACAO_OBRIGATORIA';
      err.statusCode = 400;
      throw err;
    }
    // Ativação admin: não bloqueia por cooldown (só cert/ambiente/CNPJ/NSU).
    // Consulta DistDFe continua exigindo pré-voo com bloquearPorCooldown (padrão).
    const pre = await this.executarPreVoo(empresaId, {
      exigirProducao: true,
      bloquearPorCooldown: false
    });
    if (!pre.ok) {
      const err = montarErroConsultaDfe({
        codigo: pre.codigo || 'PRE_VOO_BLOQUEADO',
        mensagem: pre.mensagem || 'Pré-voo falhou.',
        mensagemAmigavel: pre.mensagemAmigavel || pre.mensagem || 'Pré-voo falhou.',
        statusCode: 422,
        preVoo: pre,
        etapa: pre.etapa || etapaPorCodigoPreVoo(pre.codigo)
      });
      logBloqueioConsultaDfe({
        empresaId: empresaIdValido(empresaId),
        codigo: err.code,
        etapa: err.etapa,
        mensagem: err.mensagemAmigavel
      });
      throw err;
    }
    const seed = crypto.randomBytes(24).toString('hex');
    const dados = {
      ativa: true,
      empresaId: pre.empresaId,
      ativadaEm: new Date().toISOString(),
      ativadaPorUsuarioId: usuario?.id || null,
      ambienteExigido: 1,
      tiposPermitidos: [...TIPOS_CONSULTA_DFE_SEFAZ],
      manifestacaoAutomatica: false,
      tokenSeed: seed,
      cnpj: pre.contexto.cnpj
    };
    await this._gravarAtivacao(pre.empresaId, dados);
    const msgCooldown = pre.avisoCooldown
      ? ` Cooldown SEFAZ ativo — consulta DistDFe só após ${formatarHorarioLiberacao(pre.proximaConsultaEm) || pre.proximaConsultaEm || 'a liberação'}.`
      : '';
    return {
      sucesso: true,
      ...dados,
      tokenSeed: undefined,
      preVoo: pre,
      avisoCooldown: !!pre.avisoCooldown,
      proximaConsultaEm: pre.proximaConsultaEm || null,
      mensagem: 'Operação fiscal real habilitada para a empresa. A primeira consulta exige confirmação explícita.'
        + msgCooldown,
      mensagemAmigavel: 'Operação fiscal real habilitada.'
        + (pre.avisoCooldown
          ? ' Consulta DistDFe ainda bloqueada por cooldown SEFAZ.'
          : '')
    };
  }

  async desabilitar({ empresaId, usuario } = {}) {
    if (!perfilAdmin(usuario)) {
      const err = new Error('Apenas administrador autorizado pode desabilitar a operação fiscal real.');
      err.code = 'ADMIN_OBRIGATORIO';
      err.statusCode = 403;
      throw err;
    }
    const id = empresaIdValido(empresaId);
    if (!id) {
      const err = new Error('empresaId obrigatório.');
      err.code = 'EMPRESA_OBRIGATORIA';
      throw err;
    }
    const atual = await this._lerAtivacao(id);
    // P0.9 — revoga seed imediatamente (autorizações já emitidas falham no assert pré-SOAP).
    await this._gravarAtivacao(id, {
      ...(atual || {}),
      ativa: false,
      desativadaEm: new Date().toISOString(),
      desativadaPorUsuarioId: usuario?.id || null,
      tokenSeed: null,
      seedRevogadoEm: new Date().toISOString(),
      // seed fantasma impede reutilização acidental do valor antigo em caches
      tokenSeedAnteriorHash: atual?.tokenSeed
        ? crypto.createHash('sha256').update(String(atual.tokenSeed)).digest('hex').slice(0, 16)
        : null
    });
    return {
      sucesso: true,
      empresaId: id,
      ativa: false,
      mensagem: 'Operação fiscal real desabilitada. Autorizações emitidas foram revogadas; DistDFe bloqueado.'
    };
  }

  /**
   * Revalida autorização OPERACAO_REAL contra ativação persistida (pré-SOAP).
   * Garante que desativação invalida tokens ainda dentro do TTL.
   */
  async assertAutorizacaoViva(autorizacao, { empresaId, cnpj, tipoConsulta } = {}) {
    const id = empresaIdValido(empresaId || autorizacao?.empresaId);
    if (!id) {
      throw criarErroTransmissaoNaoAutorizada(
        'Transmissão SEFAZ exige empresaId explícito. A consulta não foi executada.',
        { codigo: CODIGOS_AUTORIZACAO_SEFAZ.EMPRESA_AUSENTE }
      );
    }
    const ativacao = await this._lerAtivacao(id);
    const cnpjCtx = normalizarCnpjAuth(cnpj)
      || normalizarCnpjAuth(autorizacao?.cnpj)
      || normalizarCnpjAuth(ativacao?.cnpj);
    const avaliacao = avaliarAutorizacaoTransmissao({
      autorizacao,
      empresaId: id,
      tipoConsulta: tipoConsulta || TIPOS_CONSULTA_SEFAZ.DIST_NSU,
      exigirSeedPersistido: true,
      ativacaoAtiva: !!(ativacao && ativacao.ativa && ativacao.tokenSeed),
      tokenSeedAtivo: ativacao?.tokenSeed || null,
      cnpjEmpresa: cnpjCtx
    });
    if (!avaliacao.ok) {
      throw criarErroTransmissaoNaoAutorizada(avaliacao.mensagem, {
        codigo: avaliacao.codigo,
        detalhe: avaliacao
      });
    }
    if (
      ativacao?.cnpj
      && cnpjCtx
      && normalizarCnpjAuth(ativacao.cnpj) !== cnpjCtx
    ) {
      throw criarErroTransmissaoNaoAutorizada(
        'CNPJ da ativação diverge do contexto da transmissão. A consulta não foi executada.',
        { codigo: CODIGOS_AUTORIZACAO_SEFAZ.CNPJ_DIVERGENTE }
      );
    }
    return avaliacao;
  }

  /**
   * Emite autorização OPERACAO_REAL após pré-voo + ativação + confirmações da requisição.
   * Não inclui 210210.
   */
  async emitirAutorizacaoConsultaReal(params = {}) {
    const id = empresaIdValido(params.empresaId);
    if (!id) {
      const err = montarErroConsultaDfe({
        codigo: 'EMPRESA_OBRIGATORIA',
        mensagem: 'empresaId obrigatório para consulta real.',
        statusCode: 400,
        etapa: ETAPAS_BLOQUEIO.EMPRESA
      });
      logBloqueioConsultaDfe({ ...err, empresaId: null, codigo: err.code, etapa: err.etapa, mensagem: err.message });
      throw err;
    }
    if (params.confirmacaoConsultaReal !== true || params.confirmacaoAmbienteProducao !== true) {
      const err = montarErroConsultaDfe({
        codigo: 'CONFIRMACAO_CONSULTA_OBRIGATORIA',
        mensagem: 'Consulta real exige confirmação explícita da empresa/ambiente e da operação DistDFe.',
        statusCode: 400,
        etapa: ETAPAS_BLOQUEIO.CONFIRMACAO
      });
      logBloqueioConsultaDfe({ empresaId: id, codigo: err.code, etapa: err.etapa, mensagem: err.message });
      throw err;
    }
    const ativacao = await this._lerAtivacao(id);
    if (!ativacao || !ativacao.ativa || !ativacao.tokenSeed) {
      const err = montarErroConsultaDfe({
        codigo: 'OPERACAO_REAL_DESABILITADA',
        mensagem: 'Operação fiscal real não está habilitada para esta empresa. Um administrador deve ativá-la antes.',
        statusCode: 403,
        etapa: ETAPAS_BLOQUEIO.ATIVACAO
      });
      logBloqueioConsultaDfe({ empresaId: id, codigo: err.code, etapa: err.etapa, mensagem: err.message });
      throw err;
    }
    const pre = await this.executarPreVoo(id, { exigirProducao: true });
    if (!pre.ok) {
      const etapa = pre.etapa || etapaPorCodigoPreVoo(pre.codigo);
      const liberacao = formatarHorarioLiberacao(pre.proximaConsultaEm || pre.nsu?.proximaConsultaEm);
      const msgAmigavel = (
        pre.codigo === 'COOLDOWN_ATIVO'
        || pre.codigo === 'FILA_ESGOTADA'
        || pre.codigo === 'ESTADO_NSU_INCONSISTENTE'
      )
        ? (pre.mensagemAmigavel
          || pre.itens?.find((i) => i.codigo === pre.codigo || i.codigo === 'COOLDOWN_ATIVO')?.mensagem
          || `Consulta DistDFe bloqueada localmente. Nova avaliação a partir de ${liberacao || 'a liberação oficial'}.`)
        : (pre.mensagemAmigavel || pre.mensagem || 'Pré-voo bloqueou a consulta real.');
      const err = montarErroConsultaDfe({
        codigo: pre.codigo || 'PRE_VOO_BLOQUEADO',
        mensagem: pre.mensagem || 'Pré-voo bloqueou a consulta real.',
        mensagemAmigavel: msgAmigavel,
        statusCode: 422,
        preVoo: pre,
        etapa
      });
      logBloqueioConsultaDfe({
        empresaId: id,
        codigo: err.code,
        etapa: err.etapa,
        proximaConsultaEm: err.proximaConsultaEm,
        mensagem: err.mensagemAmigavel
      });
      throw err;
    }
    if (ativacao.cnpj && pre.contexto.cnpj && String(ativacao.cnpj) !== String(pre.contexto.cnpj)) {
      const err = montarErroConsultaDfe({
        codigo: 'IDENTIDADE_FISCAL_INCONSISTENTE',
        mensagem: 'CNPJ da ativação diverge do contexto fiscal atual. Reative a operação.',
        statusCode: 403,
        etapa: ETAPAS_BLOQUEIO.CNPJ,
        preVoo: pre
      });
      logBloqueioConsultaDfe({ empresaId: id, codigo: err.code, etapa: err.etapa, mensagem: err.message });
      throw err;
    }

    const tipos = Array.isArray(ativacao.tiposPermitidos) && ativacao.tiposPermitidos.length
      ? ativacao.tiposPermitidos.filter((t) => TIPOS_CONSULTA_DFE_SEFAZ.includes(t))
      : [...TIPOS_CONSULTA_DFE_SEFAZ];

    // Nunca incluir manifestação automática
    const tiposLimpos = tipos.filter((t) => t !== TIPOS_CONSULTA_SEFAZ.MANIFESTACAO_210210);

    return {
      autorizacao: criarAutorizacaoOperacaoReal({
        empresaId: id,
        cnpj: pre.contexto.cnpj,
        tiposConsulta: tiposLimpos,
        tokenSeed: ativacao.tokenSeed,
        usuarioId: params.usuario?.id || null,
        confirmacaoConsultaReal: true,
        confirmacaoAmbienteProducao: true
      }),
      preVoo: pre,
      ativacao: {
        empresaId: id,
        ativadaEm: ativacao.ativadaEm,
        tiposPermitidos: tiposLimpos,
        cnpj: normalizarCnpjAuth(pre.contexto.cnpj)
      }
    };
  }

  /**
   * Diagnóstico de conectividade SEM DistDFe (não altera NSU).
   */
  async testarProntidaoSemConsulta(empresaId) {
    const status = await this.obterStatus(empresaId);
    return {
      sucesso: status.preVoo?.ok === true,
      consultaExecutada: false,
      sefazConsultada: false,
      tipoTeste: 'PRONTIDAO_LOCAL',
      mensagem: status.preVoo?.ok
        ? 'Prontidão local OK (empresa, certificado, ambiente, NSU/cooldown). Nenhuma consulta DistDFe foi enviada.'
        : (status.preVoo?.mensagem || status.mensagem),
      mensagemAmigavel: status.preVoo?.ok
        ? 'Teste de prontidão concluído sem consultar a SEFAZ.'
        : (status.preVoo?.mensagem || 'Prontidão incompleta — consulta real permanecerá bloqueada.'),
      statusOperacaoReal: status,
      preVoo: status.preVoo
    };
  }

  /**
   * Liberação operacional da FILA_ESGOTADA (CE-PASTELARIA-02).
   * Não envia SOAP, não altera NSU, não contorna cooldown explícito 656.
   */
  async liberarFilaEsgotada({
    empresaId,
    usuario,
    confirmacaoLiberacaoFila,
    motivo
  } = {}) {
    if (!perfilAdmin(usuario)) {
      const err = new Error('Apenas administrador autorizado pode liberar a fila esgotada.');
      err.code = 'ADMIN_OBRIGATORIO';
      err.statusCode = 403;
      throw err;
    }
    if (confirmacaoLiberacaoFila !== true) {
      const err = montarErroConsultaDfe({
        codigo: 'CONFIRMACAO_LIBERACAO_FILA_OBRIGATORIA',
        mensagem: 'Informe confirmacaoLiberacaoFila=true para liberar a fila esgotada localmente.',
        statusCode: 400,
        etapa: ETAPAS_BLOQUEIO.CONFIRMACAO
      });
      throw err;
    }
    const id = empresaIdValido(empresaId);
    if (!id) {
      const err = montarErroConsultaDfe({
        codigo: 'EMPRESA_OBRIGATORIA',
        mensagem: 'empresaId é obrigatório.',
        statusCode: 400,
        etapa: ETAPAS_BLOQUEIO.EMPRESA
      });
      throw err;
    }
    const ativacao = await this._lerAtivacao(id);
    if (!ativacao || !ativacao.ativa) {
      const err = montarErroConsultaDfe({
        codigo: 'OPERACAO_REAL_DESABILITADA',
        mensagem: 'Operação fiscal real desabilitada. Habilite-a antes de liberar a fila.',
        statusCode: 403,
        etapa: ETAPAS_BLOQUEIO.ATIVACAO
      });
      throw err;
    }

    const ctxRes = await this._configuracao.obterContextoOperacional({
      empresaId: id,
      permitirFallbackGlobal: false
    });
    if (!ctxRes.ok || !ctxRes.contexto?.cnpj) {
      const err = montarErroConsultaDfe({
        codigo: ctxRes.codigoErro || 'CONTEXTO_INVALIDO',
        mensagem: ctxRes.mensagem || 'Contexto fiscal da empresa indisponível.',
        statusCode: 422,
        etapa: ETAPAS_BLOQUEIO.EMPRESA
      });
      throw err;
    }
    const ambiente = Number(ctxRes.contexto.ambiente) === 1 ? 1 : 2;
    const cnpj = normalizarCnpjAuth(ctxRes.contexto.cnpj);
    const controle = await this._nsuService.buscarPorCnpjAmbiente(cnpj, ambiente);
    if (!controle) {
      const err = montarErroConsultaDfe({
        codigo: 'NSU_INDISPONIVEL',
        mensagem: 'Controle NSU não encontrado para a empresa.',
        statusCode: 422,
        etapa: ETAPAS_BLOQUEIO.NSU
      });
      throw err;
    }

    try {
      const correlationId = `fila-lib-${id}-${cnpj}-${ambiente}-${Date.now()}`;
      const out = await this._nsuService.liberarFilaEsgotadaAutorizada({
        controle,
        confirmacaoLiberacaoFila: true,
        autorizacao: { modo: MODO_OPERACAO_REAL, empresaId: id },
        empresaId: id,
        usuarioId: usuario?.id || null,
        motivo: motivo || 'liberacao_admin_central_ui',
        origem: 'liberacao_admin_central_ui',
        correlationId
      });
      const preVoo = await this.executarPreVoo(id, { exigirProducao: true });
      return {
        sucesso: true,
        consultaExecutada: false,
        sefazConsultada: false,
        empresaId: id,
        cnpj,
        ambiente,
        ultNsu: out.ultNsu,
        maxNsu: out.maxNsu,
        ultimoCstat: out.ultimoCstat,
        correlationId: out.correlationId || correlationId,
        eventoId: out.eventoId || null,
        jaLiberada: out.jaLiberada === true,
        preVoo,
        mensagem: out.mensagem,
        mensagemAmigavel: preVoo.ok
          ? 'Fila esgotada liberada localmente. Você pode iniciar a consulta DistDFe com confirmação.'
          : `Fila liberada localmente, mas a consulta ainda está bloqueada: ${
            preVoo.mensagemAmigavel || preVoo.mensagem || preVoo.codigo
          }`
      };
    } catch (error) {
      const err = montarErroConsultaDfe({
        codigo: error.code || error.codigo || 'LIBERACAO_FILA_FALHOU',
        mensagem: error.message,
        mensagemAmigavel: error.message,
        statusCode: error.code === 'COOLDOWN_EXPLICITO_ATIVO' ? 422 : (error.statusCode || 422),
        etapa: error.code === 'COOLDOWN_EXPLICITO_ATIVO'
          ? ETAPAS_BLOQUEIO.COOLDOWN
          : (error.code === 'EVENTO_LIBERACAO_FALHOU'
            ? ETAPAS_BLOQUEIO.DESCONHECIDO
            : ETAPAS_BLOQUEIO.NSU),
        proximaConsultaEm: error.proximaConsultaEm || null
      });
      throw err;
    }
  }
}

module.exports = CentralOperacaoFiscalRealService;
module.exports.ETAPAS_BLOQUEIO = ETAPAS_BLOQUEIO;
module.exports.etapaPorCodigoPreVoo = etapaPorCodigoPreVoo;
module.exports.montarErroConsultaDfe = montarErroConsultaDfe;
module.exports.formatarHorarioLiberacao = formatarHorarioLiberacao;
module.exports.logBloqueioConsultaDfe = logBloqueioConsultaDfe;
