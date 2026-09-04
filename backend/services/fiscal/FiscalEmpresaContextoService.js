/**
 * Ownership fiscal da NFC-e (Sprint 05.46).
 * Fonte da empresa da operação: vendas.empresa_id.
 * O contexto do request só autoriza; nunca substitui a empresa da venda.
 *
 * @module services/fiscal/FiscalEmpresaContextoService
 */
'use strict';

const { erroModoGlobal } = require('../../core/modo-operacional');
const { getFiscalConfig } = require('./configService');
const { normalizarEmpresaId } = require('./empresasConfiguracaoFiscal');

const CODIGO_EMPRESA_OWNERSHIP_REQUIRED = 'EMPRESA_OWNERSHIP_REQUIRED';
const CODIGO_VENDA_NAO_ENCONTRADA = 'VENDA_NAO_ENCONTRADA';
const CODIGO_CONFIG_AUSENTE = 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE';
const CODIGO_CONFIG_NAO_ENCONTRADA = 'CONFIGURACAO_FISCAL_NAO_ENCONTRADA';
const CODIGO_CONFIG_INCOMPLETA = 'CONFIGURACAO_FISCAL_EMPRESA_INCOMPLETA';

const CHAVES_SECRETAS = Object.freeze([
  'csc', 'tokenCSC', 'token_csc', 'CSC',
  'certificadoSenha', 'certificado_senha', 'senha',
  'privateKey', 'privateKeyPem', 'chavePrivada'
]);

function erroFiscalEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function statusDeErroFiscalEmpresa(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (code === CODIGO_VENDA_NAO_ENCONTRADA || code === 'NFCE_NAO_ENCONTRADA') return 404;
  if (
    code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
    || code === CODIGO_CONFIG_AUSENTE
    || code === CODIGO_CONFIG_NAO_ENCONTRADA
    || code === CODIGO_CONFIG_INCOMPLETA
    || code === 'CONFIGURACAO_FISCAL_EMPRESA_INVALIDA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_CONTEXT_REQUIRED'
  ) {
    return 400;
  }
  return 500;
}

function mensagemErroFiscalSanitizada(err) {
  const raw = err && (err.message || String(err));
  let texto = String(raw || 'Erro fiscal.');
  CHAVES_SECRETAS.forEach((chave) => {
    const re = new RegExp(`${chave}\\s*[:=]\\s*[^\\s,;]+`, 'gi');
    texto = texto.replace(re, `${chave}=[REDACTED]`);
  });
  return texto;
}

/**
 * Empresa fiscal da venda. Não infere caixa, usuário, COMPAT ou config global.
 */
function resolverEmpresaFiscalDaVenda({ venda, empresaIdContexto } = {}) {
  if (!venda) {
    throw erroFiscalEmpresa(CODIGO_VENDA_NAO_ENCONTRADA, 'Venda não encontrada.', 404);
  }
  const empresaFiscal = normalizarEmpresaId(venda.empresa_id);
  if (empresaFiscal == null) {
    throw erroFiscalEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Empresa é obrigatória para operação fiscal da venda.',
      400,
      { venda_id: venda.id != null ? venda.id : undefined }
    );
  }
  if (empresaIdContexto != null && empresaIdContexto !== '') {
    const ctx = normalizarEmpresaId(empresaIdContexto);
    if (ctx == null || ctx !== empresaFiscal) {
      throw erroFiscalEmpresa(CODIGO_VENDA_NAO_ENCONTRADA, 'Venda não encontrada.', 404, {
        empresa_id: ctx
      });
    }
  }
  return empresaFiscal;
}

function exigirEmpresaFiscalDaVenda(args) {
  return resolverEmpresaFiscalDaVenda(args);
}

function preencherTexto(valor) {
  return valor != null && String(valor).trim() !== '';
}

/**
 * Configuração fiscal da empresa informada. Nunca cai no perfil global.
 */
async function exigirContextoFiscalDaEmpresa({ empresaId, db, validarUrls = true, getFiscalConfigFn } = {}) {
  const id = normalizarEmpresaId(empresaId);
  if (id == null) {
    throw erroFiscalEmpresa('EMPRESA_OBRIGATORIA', 'empresaId é obrigatório para configuração fiscal.', 400);
  }
  const obter = getFiscalConfigFn || getFiscalConfig;
  let config;
  try {
    config = await obter({ empresaId: id, db, validarUrls });
  } catch (err) {
    if (err && err.code === CODIGO_CONFIG_AUSENTE) {
      err.code = CODIGO_CONFIG_NAO_ENCONTRADA;
      if (err.statusCode == null) err.statusCode = 409;
    }
    throw err;
  }
  if (!config || config.fonte !== 'EMPRESA' || Number(config.empresaId) !== id) {
    throw erroFiscalEmpresa(
      CODIGO_CONFIG_NAO_ENCONTRADA,
      'Configuração fiscal da empresa não encontrada.',
      409,
      { empresa_id: id }
    );
  }
  return config;
}

async function resolverCredenciaisNfceDaEmpresa({ empresaId, db, validarUrls = true, getFiscalConfigFn } = {}) {
  const config = await exigirContextoFiscalDaEmpresa({ empresaId, db, validarUrls, getFiscalConfigFn });
  if (!preencherTexto(config.tokenCSC) || !preencherTexto(config.idCSC)) {
    throw erroFiscalEmpresa(
      CODIGO_CONFIG_INCOMPLETA,
      'CSC da empresa não configurado.',
      409,
      { empresa_id: Number(config.empresaId) }
    );
  }
  return {
    empresaId: Number(config.empresaId),
    fonte: config.fonte,
    csc: config.tokenCSC,
    idCsc: config.idCSC,
    ambiente: config.ambiente,
    serie: config.serie,
    uf: config.uf,
    codigoUf: config.codigoUf,
    cnpj: config.cnpj,
    certificadoPath: config.certificadoPath || '',
    certificadoSenha: config.certificadoSenha || '',
    config
  };
}

async function obterCertificadoDaEmpresa({ empresaId, db, getFiscalConfigFn } = {}) {
  const cred = await resolverCredenciaisNfceDaEmpresa({
    empresaId,
    db,
    validarUrls: false,
    getFiscalConfigFn
  });
  if (!preencherTexto(cred.certificadoPath)) {
    throw erroFiscalEmpresa(
      CODIGO_CONFIG_NAO_ENCONTRADA,
      'Certificado digital da empresa não encontrado.',
      409,
      { empresa_id: cred.empresaId }
    );
  }
  return {
    empresaId: cred.empresaId,
    certificadoPath: cred.certificadoPath,
    certificadoSenha: cred.certificadoSenha
  };
}

function coerenciaDocumentoComVenda({ nota, empresaFiscal } = {}) {
  if (!nota) return null;
  const notaEmp = normalizarEmpresaId(nota.empresa_id);
  if (notaEmp != null && notaEmp !== Number(empresaFiscal)) {
    throw erroFiscalEmpresa(
      CODIGO_VENDA_NAO_ENCONTRADA,
      'Venda não encontrada.',
      404
    );
  }
  return nota;
}

module.exports = {
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_VENDA_NAO_ENCONTRADA,
  CODIGO_CONFIG_AUSENTE,
  CODIGO_CONFIG_NAO_ENCONTRADA,
  CODIGO_CONFIG_INCOMPLETA,
  resolverEmpresaFiscalDaVenda,
  exigirEmpresaFiscalDaVenda,
  exigirContextoFiscalDaEmpresa,
  resolverCredenciaisNfceDaEmpresa,
  obterCertificadoDaEmpresa,
  coerenciaDocumentoComVenda,
  statusDeErroFiscalEmpresa,
  mensagemErroFiscalSanitizada,
  erroFiscalEmpresa
};
