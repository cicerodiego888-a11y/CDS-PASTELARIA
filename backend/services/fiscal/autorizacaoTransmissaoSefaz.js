/**
 * Barreira de autorização imediatamente anterior à transmissão DistDFe,
 * consChNFe, manifestação do destinatário (210210 / 210200 / 210220 / 210240)
 * e cancelamento NFC-e/NF-e (evento 110111).
 *
 * Modos:
 * - TESTE_ISOLADO: token de suíte (nunca produção).
 * - OPERACAO_REAL: emitida por CentralOperacaoFiscalRealService após ativação
 *   administrativa + pré-voo + confirmação explícita da consulta (P0.8 fiscal).
 *
 * Variável de ambiente sozinha NÃO autoriza SOAP.
 * Manifestação 210210 NÃO é autorizada por OPERACAO_REAL.
 *
 * @module services/fiscal/autorizacaoTransmissaoSefaz
 */

'use strict';

const crypto = require('crypto');
const { getManifestacaoEventoCode } = require('./core/OperationType');

const MODO_TESTE_ISOLADO = 'TESTE_ISOLADO';
const TOKEN_TESTE_ISOLADO = 'CDS_SEFAZ_AUTH_TESTE_ISOLADO_P08';
const MODO_OPERACAO_REAL = 'OPERACAO_REAL';
const TOKEN_PREFIXO_OPERACAO_REAL = 'CDS_SEFAZ_AUTH_OPERACAO_REAL_';
/** Autorização de sessão: 15 minutos. */
const TTL_OPERACAO_REAL_MS = 15 * 60 * 1000;

const CODIGOS = Object.freeze({
  NAO_AUTORIZADA: 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA',
  EMPRESA_AUSENTE: 'EMPRESA_CENTRAL_AUSENTE',
  EMPRESA_DIVERGENTE: 'IDENTIDADE_FISCAL_INCONSISTENTE',
  TIPO_NAO_COBERTO: 'TRANSMISSAO_SEFAZ_TIPO_NAO_COBERTO',
  PRODUCAO_INDISPONIVEL: 'TRANSMISSAO_SEFAZ_PRODUCAO_INDISPONIVEL',
  OPERACAO_REAL_INVALIDA: 'TRANSMISSAO_SEFAZ_OPERACAO_REAL_INVALIDA',
  OPERACAO_REAL_REVOGADA: 'TRANSMISSAO_SEFAZ_OPERACAO_REAL_REVOGADA',
  CONFIRMACAO_AUSENTE: 'TRANSMISSAO_SEFAZ_CONFIRMACAO_AUSENTE',
  CNPJ_DIVERGENTE: 'TRANSMISSAO_SEFAZ_CNPJ_DIVERGENTE'
});

const TIPOS_CONSULTA = Object.freeze({
  DIST_NSU: 'distNSU',
  CONS_CH_NFE: 'consChNFe',
  CONS_NSU: 'consNSU',
  MANIFESTACAO_210210: '210210',
  MANIFESTACAO_210200: '210200',
  MANIFESTACAO_210220: '210220',
  MANIFESTACAO_210240: '210240',
  CANCELAMENTO_110111: '110111',
  /** Status do serviço NF-e (diagnóstico remoto). Mesma barreira TESTE_ISOLADO. */
  STATUS_SERVICO: 'statusServico'
});

const TIPOS_MANIFESTACAO = Object.freeze([
  TIPOS_CONSULTA.MANIFESTACAO_210210,
  TIPOS_CONSULTA.MANIFESTACAO_210200,
  TIPOS_CONSULTA.MANIFESTACAO_210220,
  TIPOS_CONSULTA.MANIFESTACAO_210240
]);

const TIPOS_CONSULTA_DFE = Object.freeze([
  TIPOS_CONSULTA.DIST_NSU,
  TIPOS_CONSULTA.CONS_CH_NFE,
  TIPOS_CONSULTA.CONS_NSU
]);

const TIPOS_CANCELAMENTO = Object.freeze([
  TIPOS_CONSULTA.CANCELAMENTO_110111
]);

const ESTADOS_CONSULTA = Object.freeze({
  NAO_EXECUTADA: 'NAO_EXECUTADA',
  SEM_DOCUMENTO: 'SEM_DOCUMENTO',
  RESPOSTA_RECEBIDA: 'RESPOSTA_RECEBIDA',
  PERSISTENCIA_PENDENTE: 'PERSISTENCIA_PENDENTE',
  RECUPERACAO_CONCLUIDA: 'RECUPERACAO_CONCLUIDA',
  JA_EXISTE_LOCALMENTE: 'JA_EXISTE_LOCALMENTE'
});

function empresaIdValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function criarErroTransmissaoNaoAutorizada(mensagem, extra = {}) {
  const codigo = extra.codigo || CODIGOS.NAO_AUTORIZADA;
  const err = new Error(mensagem);
  err.code = codigo;
  err.codigo = codigo;
  err.codigoErro = codigo;
  err.statusCode = extra.statusCode || 403;
  err.consultaExecutada = false;
  err.sefazConsultada = false;
  err.respostaRecebida = false;
  err.persistenciaCompleta = false;
  err.recuperacaoConcluida = false;
  err.estadoConsulta = ESTADOS_CONSULTA.NAO_EXECUTADA;
  err.bloqueadoAutorizacao = extra.bloqueadoAutorizacao !== false;
  if (extra.detalhe) err.detalhe = extra.detalhe;
  return err;
}

function resultadoConsultaNaoExecutada(extra = {}) {
  const codigo = extra.codigo || CODIGOS.NAO_AUTORIZADA;
  return {
    sucesso: false,
    consultaExecutada: false,
    sefazConsultada: false,
    respostaRecebida: false,
    persistenciaCompleta: false,
    recuperacaoConcluida: false,
    ignorado: true,
    bloqueadoAutorizacao: extra.bloqueadoAutorizacao !== false,
    codigo,
    motivoIgnorado: extra.motivoIgnorado || codigo,
    estadoConsulta: ESTADOS_CONSULTA.NAO_EXECUTADA,
    notasNovas: 0,
    notasDuplicadas: 0,
    ignorados: 0,
    mensagem: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. A consulta não foi executada.',
    mensagemAmigavel: extra.mensagemAmigavel
      || extra.mensagem
      || 'Consulta à SEFAZ não executada: falta autorização operacional explícita.',
    erros: extra.erros || []
  };
}

/**
 * Autorização exclusiva de testes isolados. Nunca persiste. Nunca é produção.
 * @param {{ empresaId: number, tipoConsulta?: string, tiposConsulta?: string[] }} params
 */
function tipoConsultaManifestacao(operacao) {
  if (operacao && TIPOS_MANIFESTACAO.includes(String(operacao))) {
    return String(operacao);
  }
  return getManifestacaoEventoCode(operacao) || null;
}

function criarAutorizacaoTesteIsolado(params = {}) {
  const empresaId = empresaIdValido(params.empresaId);
  if (!empresaId) {
    throw new Error('Autorização de teste isolado exige empresaId válido.');
  }
  const tipos = Array.isArray(params.tiposConsulta) && params.tiposConsulta.length
    ? params.tiposConsulta
    : (params.tipoConsulta
      ? [params.tipoConsulta]
      : [...TIPOS_CONSULTA_DFE]);
  return Object.freeze({
    modo: MODO_TESTE_ISOLADO,
    token: TOKEN_TESTE_ISOLADO,
    producao: false,
    operacional: false,
    empresaId,
    tiposConsulta: Object.freeze([...tipos]),
    emitidoEm: Date.now(),
    origem: 'teste_isolado_p08'
  });
}

function anexarAutorizacaoTesteSefaz(deps = {}, extra = {}) {
  const empresaId = empresaIdValido(
    extra.empresaId
    || deps.empresaId
    || (deps.contextoCentral && deps.contextoCentral.empresaId)
  );
  return {
    ...deps,
    autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({
      empresaId,
      tipoConsulta: extra.tipoConsulta,
      tiposConsulta: extra.tiposConsulta
    })
  };
}

function anexarAutorizacaoTesteManifestacao(input = {}, extra = {}) {
  const empresaId = empresaIdValido(
    extra.empresaId
    || input.empresaId
    || (input.contextoCentral && input.contextoCentral.empresaId)
  );
  return {
    ...input,
    empresaId,
    autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({
      empresaId,
      tiposConsulta: extra.tiposConsulta || [...TIPOS_MANIFESTACAO]
    })
  };
}

function anexarAutorizacaoTesteCancelamento(input = {}, extra = {}) {
  const empresaId = empresaIdValido(
    extra.empresaId
    || input.empresaId
    || (input.contextoCentral && input.contextoCentral.empresaId)
  );
  return {
    ...input,
    empresaId,
    autorizacaoTransmissaoSefaz: criarAutorizacaoTesteIsolado({
      empresaId,
      tiposConsulta: extra.tiposConsulta || [...TIPOS_CANCELAMENTO]
    })
  };
}

function resultadoCancelamentoNaoExecutado(extra = {}) {
  const codigo = extra.codigo || CODIGOS.NAO_AUTORIZADA;
  return {
    success: false,
    sucesso: false,
    consultaExecutada: false,
    sefazConsultada: false,
    transmissaoExecutada: false,
    bloqueadoAutorizacao: extra.bloqueadoAutorizacao !== false,
    codigo,
    code: codigo,
    error: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. O cancelamento não foi executado.',
    message: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. O cancelamento não foi executado.',
    mensagem: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. O cancelamento não foi executado.',
    body: null,
    statusCode: extra.statusCode || 403,
    fallbackUtilizado: false,
    transmissionState: 'NOT_SENT',
    resultado: 'NAO_EXECUTADO'
  };
}

function resultadoManifestacaoNaoExecutada(extra = {}) {
  const codigo = extra.codigo || CODIGOS.NAO_AUTORIZADA;
  return {
    success: false,
    sucesso: false,
    consultaExecutada: false,
    sefazConsultada: false,
    transmissaoExecutada: false,
    bloqueadoAutorizacao: extra.bloqueadoAutorizacao !== false,
    codigo,
    code: codigo,
    error: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. A manifestação não foi executada.',
    message: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. A manifestação não foi executada.',
    mensagem: extra.mensagem
      || 'Transmissão SEFAZ não autorizada. A manifestação não foi executada.',
    body: null,
    statusCode: extra.statusCode || 403,
    fallbackUtilizado: false
  };
}

function montarTokenOperacaoReal(empresaId, tokenSeed, emitidoEm) {
  const base = `${TOKEN_PREFIXO_OPERACAO_REAL}${empresaId}:${tokenSeed}:${emitidoEm}`;
  const hash = crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
  return `${TOKEN_PREFIXO_OPERACAO_REAL}${hash}`;
}

function normalizarCnpjAuth(valor) {
  const d = String(valor || '').replace(/\D/g, '');
  return d.length === 14 ? d : null;
}

/**
 * Autorização de operação real (curta duração). Emitida só pelo serviço de ativação.
 * Nunca inclui 210210. Env sozinha não gera este objeto.
 * Vinculada a empresaId + CNPJ + tokenSeed da ativação persistida.
 */
function criarAutorizacaoOperacaoReal(params = {}) {
  const empresaId = empresaIdValido(params.empresaId);
  if (!empresaId) {
    throw new Error('Autorização de operação real exige empresaId válido.');
  }
  if (!params.tokenSeed || !String(params.tokenSeed).trim()) {
    throw new Error('Autorização de operação real exige tokenSeed da ativação.');
  }
  const cnpj = normalizarCnpjAuth(params.cnpj);
  if (!cnpj) {
    throw new Error('Autorização de operação real exige CNPJ da empresa (14 dígitos).');
  }
  if (params.confirmacaoConsultaReal !== true || params.confirmacaoAmbienteProducao !== true) {
    throw criarErroTransmissaoNaoAutorizada(
      'Consulta real exige confirmação explícita de ambiente e operação.',
      { codigo: CODIGOS.CONFIRMACAO_AUSENTE }
    );
  }
  const tiposBrutos = Array.isArray(params.tiposConsulta) && params.tiposConsulta.length
    ? params.tiposConsulta
    : [...TIPOS_CONSULTA_DFE];
  const tipos = tiposBrutos.filter((t) => !TIPOS_MANIFESTACAO.includes(String(t)));
  if (!tipos.length) {
    throw new Error('Autorização de operação real sem tipos DF-e permitidos.');
  }
  const emitidoEm = Date.now();
  const token = montarTokenOperacaoReal(empresaId, String(params.tokenSeed), emitidoEm);
  return Object.freeze({
    modo: MODO_OPERACAO_REAL,
    token,
    tokenSeed: String(params.tokenSeed),
    producao: true,
    operacional: true,
    empresaId,
    cnpj,
    tiposConsulta: Object.freeze([...tipos]),
    emitidoEm,
    expiraEm: emitidoEm + TTL_OPERACAO_REAL_MS,
    origem: 'ativacao_controlada_operacao_real',
    usuarioId: params.usuarioId || null,
    confirmacaoConsultaReal: true,
    confirmacaoAmbienteProducao: true,
    manifestacaoAutomatica: false
  });
}

/**
 * @param {object} autorizacao
 * @param {number} emp
 * @param {string|null} tipoConsulta
 * @param {{ tokenSeedAtivo?: string|null, ativacaoAtiva?: boolean, cnpjEmpresa?: string|null, exigirSeedPersistido?: boolean }} [extras]
 */
function avaliarOperacaoReal(autorizacao, emp, tipoConsulta, extras = {}) {
  if (autorizacao.modo !== MODO_OPERACAO_REAL) {
    return {
      ok: false,
      codigo: CODIGOS.OPERACAO_REAL_INVALIDA,
      mensagem: 'Autorização de operação real inválida. A consulta não foi executada.'
    };
  }
  if (empresaIdValido(autorizacao.empresaId) !== emp) {
    return {
      ok: false,
      codigo: CODIGOS.EMPRESA_DIVERGENTE,
      mensagem: 'Autorização de operação real vinculada a outra empresa. A consulta não foi executada.'
    };
  }
  if (
    autorizacao.confirmacaoConsultaReal !== true
    || autorizacao.confirmacaoAmbienteProducao !== true
  ) {
    return {
      ok: false,
      codigo: CODIGOS.CONFIRMACAO_AUSENTE,
      mensagem: 'Consulta real sem confirmação explícita. A transmissão não foi executada.'
    };
  }
  const emitidoEm = Number(autorizacao.emitidoEm) || 0;
  const expiraEm = Number(autorizacao.expiraEm) || (emitidoEm + TTL_OPERACAO_REAL_MS);
  if (!emitidoEm || Date.now() > expiraEm) {
    return {
      ok: false,
      codigo: CODIGOS.OPERACAO_REAL_INVALIDA,
      mensagem: 'Autorização de operação real expirada. Solicite nova confirmação de consulta.'
    };
  }
  const esperado = montarTokenOperacaoReal(emp, String(autorizacao.tokenSeed || ''), emitidoEm);
  if (!autorizacao.token || autorizacao.token !== esperado) {
    return {
      ok: false,
      codigo: CODIGOS.OPERACAO_REAL_INVALIDA,
      mensagem: 'Token de operação real inválido. A consulta não foi executada.'
    };
  }
  // P0.9 — desativação invalida imediatamente: seed persistido deve coincidir.
  if (extras.exigirSeedPersistido === true) {
    if (extras.ativacaoAtiva !== true || !extras.tokenSeedAtivo) {
      return {
        ok: false,
        codigo: CODIGOS.OPERACAO_REAL_REVOGADA,
        mensagem: 'Operação fiscal real desabilitada ou revogada. A transmissão não foi executada.'
      };
    }
    if (String(autorizacao.tokenSeed) !== String(extras.tokenSeedAtivo)) {
      return {
        ok: false,
        codigo: CODIGOS.OPERACAO_REAL_REVOGADA,
        mensagem: 'Autorização revogada (seed de ativação alterado). Solicite nova consulta.'
      };
    }
  }
  const cnpjAuth = normalizarCnpjAuth(autorizacao.cnpj);
  const cnpjEmp = normalizarCnpjAuth(extras.cnpjEmpresa);
  if (!cnpjAuth) {
    return {
      ok: false,
      codigo: CODIGOS.OPERACAO_REAL_INVALIDA,
      mensagem: 'Autorização de operação real sem CNPJ vinculado. A consulta não foi executada.'
    };
  }
  if (cnpjEmp && cnpjAuth !== cnpjEmp) {
    return {
      ok: false,
      codigo: CODIGOS.CNPJ_DIVERGENTE,
      mensagem: 'CNPJ da autorização diverge do contexto da empresa. A consulta não foi executada.'
    };
  }
  if (TIPOS_MANIFESTACAO.includes(String(tipoConsulta || ''))) {
    return {
      ok: false,
      codigo: CODIGOS.TIPO_NAO_COBERTO,
      mensagem: 'Operação real não autoriza manifestação automática do destinatário.'
    };
  }
  const tipos = Array.isArray(autorizacao.tiposConsulta) ? autorizacao.tiposConsulta : [];
  if (tipoConsulta && !tipos.includes(tipoConsulta)) {
    return {
      ok: false,
      codigo: CODIGOS.TIPO_NAO_COBERTO,
      mensagem: `Autorização de operação real não cobre ${tipoConsulta}. A consulta não foi executada.`
    };
  }
  return {
    ok: true,
    empresaId: emp,
    modo: MODO_OPERACAO_REAL,
    tipoConsulta: tipoConsulta || null,
    producao: true,
    cnpj: cnpjAuth
  };
}

function avaliarAutorizacaoTransmissao({
  autorizacao,
  empresaId,
  tipoConsulta,
  tokenSeedAtivo,
  ativacaoAtiva,
  cnpjEmpresa,
  exigirSeedPersistido
} = {}) {
  const emp = empresaIdValido(empresaId);
  if (!emp) {
    return {
      ok: false,
      codigo: CODIGOS.EMPRESA_AUSENTE,
      mensagem: 'Transmissão SEFAZ exige empresaId explícito. A consulta não foi executada.'
    };
  }

  if (!autorizacao || typeof autorizacao !== 'object' || Array.isArray(autorizacao)) {
    return {
      ok: false,
      codigo: CODIGOS.NAO_AUTORIZADA,
      mensagem: 'Transmissão SEFAZ não autorizada. A consulta não foi executada.'
    };
  }

  // OPERACAO_REAL controlada (P0.8 fiscal) — antes do rejeite genérico de "producao".
  if (autorizacao.modo === MODO_OPERACAO_REAL) {
    return avaliarOperacaoReal(autorizacao, emp, tipoConsulta, {
      tokenSeedAtivo,
      ativacaoAtiva,
      cnpjEmpresa,
      exigirSeedPersistido
    });
  }

  // Flags soltas de produção sem modo OPERACAO_REAL continuam bloqueadas.
  if (
    autorizacao.producao === true
    || autorizacao.operacional === true
    || autorizacao.modo === 'PRODUCAO'
    || autorizacao.modo === 'OPERACIONAL'
  ) {
    return {
      ok: false,
      codigo: CODIGOS.PRODUCAO_INDISPONIVEL,
      mensagem: 'Autorização de produção sem ativação controlada OPERACAO_REAL. A consulta não foi executada.'
    };
  }

  if (autorizacao.modo !== MODO_TESTE_ISOLADO || autorizacao.token !== TOKEN_TESTE_ISOLADO) {
    return {
      ok: false,
      codigo: CODIGOS.NAO_AUTORIZADA,
      mensagem: 'Transmissão SEFAZ não autorizada. A consulta não foi executada.'
    };
  }

  if (empresaIdValido(autorizacao.empresaId) !== emp) {
    return {
      ok: false,
      codigo: CODIGOS.EMPRESA_DIVERGENTE,
      mensagem: 'Autorização de transmissão vinculada a outra empresa. A consulta não foi executada.'
    };
  }

  const tipos = Array.isArray(autorizacao.tiposConsulta) ? autorizacao.tiposConsulta : [];
  if (tipoConsulta && !tipos.includes(tipoConsulta)) {
    return {
      ok: false,
      codigo: CODIGOS.TIPO_NAO_COBERTO,
      mensagem: `Autorização de teste não cobre ${tipoConsulta}. A consulta não foi executada.`
    };
  }

  return {
    ok: true,
    empresaId: emp,
    modo: MODO_TESTE_ISOLADO,
    tipoConsulta: tipoConsulta || null
  };
}

function exigirAutorizacaoTransmissao(params = {}) {
  const avaliacao = avaliarAutorizacaoTransmissao(params);
  if (!avaliacao.ok) {
    throw criarErroTransmissaoNaoAutorizada(avaliacao.mensagem, {
      codigo: avaliacao.codigo,
      detalhe: avaliacao
    });
  }
  return avaliacao;
}

module.exports = {
  MODO_TESTE_ISOLADO,
  TOKEN_TESTE_ISOLADO,
  MODO_OPERACAO_REAL,
  TOKEN_PREFIXO_OPERACAO_REAL,
  TTL_OPERACAO_REAL_MS,
  CODIGOS_AUTORIZACAO_SEFAZ: CODIGOS,
  TIPOS_CONSULTA_SEFAZ: TIPOS_CONSULTA,
  TIPOS_MANIFESTACAO_SEFAZ: TIPOS_MANIFESTACAO,
  TIPOS_CONSULTA_DFE_SEFAZ: TIPOS_CONSULTA_DFE,
  TIPOS_CANCELAMENTO_SEFAZ: TIPOS_CANCELAMENTO,
  ESTADOS_CONSULTA_SEFAZ: ESTADOS_CONSULTA,
  empresaIdValido,
  normalizarCnpjAuth,
  tipoConsultaManifestacao,
  criarAutorizacaoTesteIsolado,
  criarAutorizacaoOperacaoReal,
  montarTokenOperacaoReal,
  anexarAutorizacaoTesteSefaz,
  anexarAutorizacaoTesteManifestacao,
  anexarAutorizacaoTesteCancelamento,
  avaliarAutorizacaoTransmissao,
  exigirAutorizacaoTransmissao,
  criarErroTransmissaoNaoAutorizada,
  resultadoConsultaNaoExecutada,
  resultadoManifestacaoNaoExecutada,
  resultadoCancelamentoNaoExecutado
};
