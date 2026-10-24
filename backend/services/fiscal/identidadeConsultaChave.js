/**
 * Identidade fiscal da consulta individual por chave (consChNFe).
 * MULTIEMPRESA: nunca herda CNPJ/ambiente/certificado globais.
 * Não abre PFX. Não consulta a SEFAZ.
 *
 * @module services/fiscal/identidadeConsultaChave
 */
'use strict';

const { ModoOperacionalGlobal } = require('../../core/modo-operacional/contratos');

const CODIGOS = Object.freeze({
  EMPRESA_CENTRAL_AUSENTE: 'EMPRESA_CENTRAL_AUSENTE',
  CNPJ_NAO_CONFIGURADO: 'CNPJ_NAO_CONFIGURADO',
  AMBIENTE_NAO_CONFIGURADO: 'AMBIENTE_NAO_CONFIGURADO',
  CERTIFICADO: 'CERTIFICADO',
  IDENTIDADE_FISCAL_INCONSISTENTE: 'IDENTIDADE_FISCAL_INCONSISTENTE',
  IDENTIDADE_FISCAL_AUSENTE: 'IDENTIDADE_FISCAL_AUSENTE'
});

function criarErroIdentidadeConsultaChave(codigo, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.codigo = codigo;
  err.codigoErro = codigo;
  err.statusCode = extra.statusCode || 422;
  err.identidadeFiscalIncompleta = true;
  err.consultaExecutada = false;
  err.sefazConsultada = false;
  err.rejeicaoSefaz = false;
  err.pfxAberto = false;
  if (extra.detalhe) err.detalhe = extra.detalhe;
  return err;
}

function empresaIdValido(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizarCnpj(valor) {
  const d = String(valor || '').replace(/\D/g, '');
  return d.length === 14 ? d : '';
}

function normalizarAmbiente(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return n === 1 || n === 2 ? n : null;
}

function modoDe(deps = {}) {
  return deps.modo
    || (deps.contextoCentral && deps.contextoCentral.modo)
    || null;
}

function ehEmpresaSimplesExplicito(deps = {}) {
  return modoDe(deps) === ModoOperacionalGlobal.EMPRESA_SIMPLES;
}

function permitirFallbackGlobalConsultaChave(deps = {}) {
  return ehEmpresaSimplesExplicito(deps) && deps.permitirConfigFiscalGlobal === true;
}

function mensagemSemSefaz(texto) {
  return `${texto} A SEFAZ não foi consultada.`;
}

function montarConfigDeContexto(ctx, cnpj, ambiente) {
  return {
    certificadoPath: String(ctx.certificadoPath).trim(),
    certificadoSenha: String(ctx.certificadoSenha).trim(),
    cnpj,
    fiscal_ambiente: ambiente,
    ambiente,
    fiscal_codigo_uf: ctx.codigoUf || ctx.fiscal_codigo_uf,
    codigo_uf: ctx.codigoUf || ctx.fiscal_codigo_uf
  };
}

/**
 * Resolve CNPJ/ambiente/certificado para consChNFe sem abrir PFX.
 * @param {Object} [deps]
 * @param {Object} [hooks]
 * @param {Function} [hooks.getFiscalConfig]
 */
async function resolverIdentidadeConsultaChave(deps = {}, hooks = {}) {
  const ctx = deps.contextoCentral || null;
  const modo = modoDe(deps);
  const simples = ehEmpresaSimplesExplicito(deps);

  if (ctx) {
    const empresaId = empresaIdValido(ctx.empresaId ?? deps.empresaId);
    const cnpj = normalizarCnpj(ctx.cnpj);
    const ambiente = normalizarAmbiente(ctx.ambiente ?? ctx.fiscal_ambiente);
    const certPath = ctx.certificadoPath != null ? String(ctx.certificadoPath).trim() : '';
    const certSenha = ctx.certificadoSenha != null ? String(ctx.certificadoSenha).trim() : '';

    if (!simples && !empresaId) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.EMPRESA_CENTRAL_AUSENTE,
        mensagemSemSefaz('Consulta por chave em MULTIEMPRESA exige empresaId explícito.'),
        { detalhe: { modo: modo || 'MULTIEMPRESA' } }
      );
    }

    const empresaDeps = empresaIdValido(deps.empresaId);
    if (empresaDeps && empresaId && empresaDeps !== empresaId) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.IDENTIDADE_FISCAL_INCONSISTENTE,
        mensagemSemSefaz('empresaId do contexto diverge do empresaId da operação.'),
        {
          detalhe: { empresaIdContexto: empresaId, empresaIdOperacao: empresaDeps }
        }
      );
    }

    if (!cnpj) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.CNPJ_NAO_CONFIGURADO,
        mensagemSemSefaz('CNPJ da empresa não está configurado para consulta por chave.'),
        { detalhe: { empresaId } }
      );
    }

    if (ambiente == null) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.AMBIENTE_NAO_CONFIGURADO,
        mensagemSemSefaz('Ambiente fiscal da empresa não está configurado para consulta por chave.'),
        { detalhe: { empresaId, cnpjMascarado: `${cnpj.slice(0, 2)}***` } }
      );
    }

    const cnpjOperacao = normalizarCnpj(deps.cnpj);
    if (cnpjOperacao && cnpjOperacao !== cnpj) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.IDENTIDADE_FISCAL_INCONSISTENTE,
        mensagemSemSefaz('CNPJ do contexto diverge do CNPJ da operação.'),
        { detalhe: { empresaId } }
      );
    }

    const ambienteOperacao = normalizarAmbiente(deps.ambiente ?? deps.fiscal_ambiente);
    if (ambienteOperacao != null && ambienteOperacao !== ambiente) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.IDENTIDADE_FISCAL_INCONSISTENTE,
        mensagemSemSefaz('Ambiente fiscal do contexto diverge do ambiente da operação.'),
        { detalhe: { empresaId } }
      );
    }

    if (!certPath || !certSenha) {
      throw criarErroIdentidadeConsultaChave(
        CODIGOS.CERTIFICADO,
        mensagemSemSefaz('Certificado da empresa não está configurado para consulta por chave.'),
        { detalhe: { empresaId, certificadoPathInformado: Boolean(certPath) } }
      );
    }

    return {
      empresaId,
      cnpj,
      ambiente,
      config: montarConfigDeContexto(ctx, cnpj, ambiente),
      origemIdentidade: 'contextoCentral',
      getFiscalConfigChamado: false,
      pfxAberto: false
    };
  }

  if (!permitirFallbackGlobalConsultaChave(deps)) {
    throw criarErroIdentidadeConsultaChave(
      CODIGOS.IDENTIDADE_FISCAL_AUSENTE,
      mensagemSemSefaz(
        'Contexto fiscal da empresa ausente. Fallback global de CNPJ/certificado bloqueado.'
      ),
      {
        detalhe: {
          modo: modo || 'nao_informado',
          permitirConfigFiscalGlobal: deps.permitirConfigFiscalGlobal === true
        }
      }
    );
  }

  const getFiscalConfig = hooks.getFiscalConfig;
  if (typeof getFiscalConfig !== 'function') {
    throw criarErroIdentidadeConsultaChave(
      CODIGOS.IDENTIDADE_FISCAL_AUSENTE,
      mensagemSemSefaz('Fallback EMPRESA_SIMPLES exigido, mas getFiscalConfig não está disponível.')
    );
  }

  const config = await getFiscalConfig({ validarUrls: false });
  const cnpj = normalizarCnpj(config && config.cnpj);
  const ambiente = normalizarAmbiente(config && (config.fiscal_ambiente ?? config.ambiente));
  if (!cnpj) {
    throw criarErroIdentidadeConsultaChave(
      CODIGOS.CNPJ_NAO_CONFIGURADO,
      mensagemSemSefaz('CNPJ global de EMPRESA_SIMPLES não configurado.')
    );
  }
  if (ambiente == null) {
    throw criarErroIdentidadeConsultaChave(
      CODIGOS.AMBIENTE_NAO_CONFIGURADO,
      mensagemSemSefaz('Ambiente global de EMPRESA_SIMPLES não configurado.')
    );
  }
  const certPath = config.certificadoPath != null ? String(config.certificadoPath).trim() : '';
  const certSenha = config.certificadoSenha != null ? String(config.certificadoSenha).trim() : '';
  if (!certPath || !certSenha) {
    throw criarErroIdentidadeConsultaChave(
      CODIGOS.CERTIFICADO,
      mensagemSemSefaz('Certificado global de EMPRESA_SIMPLES não configurado.')
    );
  }

  return {
    empresaId: empresaIdValido(deps.empresaId),
    cnpj,
    ambiente,
    config: {
      ...config,
      cnpj,
      ambiente,
      fiscal_ambiente: ambiente
    },
    origemIdentidade: 'getFiscalConfig:EMPRESA_SIMPLES',
    getFiscalConfigChamado: true,
    pfxAberto: false
  };
}

module.exports = {
  resolverIdentidadeConsultaChave,
  criarErroIdentidadeConsultaChave,
  permitirFallbackGlobalConsultaChave,
  CODIGOS_IDENTIDADE_CONSULTA_CHAVE: CODIGOS,
  ModoOperacionalGlobal
};
