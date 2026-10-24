/**
 * Resolução de empresa + gate de certificado para pipelines NF-e modelo 55.
 * Reutiliza exigirCertificadoAptoParaUsoFiscal (P0.2) — sem segunda crypto.
 */
'use strict';

const { getFiscalConfig } = require('./configService');
const { normalizarEmpresaId } = require('./empresasConfiguracaoFiscal');
const { exigirCertificadoAptoParaUsoFiscal } = require('./CertificadoUsoFiscalGate');
const {
  CODIGOS_CERTIFICADO_A1,
  MENSAGENS_CERTIFICADO_A1,
  ESTADOS_CERTIFICADO_A1
} = require('./certificadoEstados');
const { erroValidacao } = require('./ValidarCertificadoA1Service');

function erroEmpresaNfe(codigo, mensagem, statusCode = 400) {
  const err = erroValidacao(
    ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO,
    codigo,
    mensagem,
    { statusCode }
  );
  err.sefaz_chamado = false;
  return err;
}

/**
 * Empresa proprietária do documento NF-e 55 — sem fallback global.
 * @param {{ venda?: object, compra?: object, empresaId?: *, empresaIdContexto?: * }} args
 */
function resolverEmpresaIdDocumentoNfe(args = {}) {
  const candidatos = [
    args.empresaId,
    args.empresaIdContexto,
    args.venda && args.venda.empresa_id,
    args.compra && args.compra.empresa_id
  ];
  for (const c of candidatos) {
    const id = normalizarEmpresaId(c);
    if (id != null) return id;
  }
  throw erroEmpresaNfe(
    CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA_USO,
    MENSAGENS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA,
    400
  );
}

/**
 * Carrega config da empresa e aplica o gate criptográfico.
 * Mutaciona `config` com path/senha seguros.
 *
 * @returns {{ empresaId: number, config: object, certApto: object }}
 */
async function carregarConfigEAplicarGateCertificadoNfe(opts = {}) {
  const empresaId = resolverEmpresaIdDocumentoNfe(opts);
  const getFiscalConfigFn = opts.getFiscalConfigFn || getFiscalConfig;
  const exigirGate = typeof opts.exigirCertificadoAptoParaUsoFiscal === 'function'
    ? opts.exigirCertificadoAptoParaUsoFiscal
    : exigirCertificadoAptoParaUsoFiscal;

  const config = opts.config || await getFiscalConfigFn({
    empresaId,
    db: opts.db,
    validarUrls: opts.validarUrls !== false
  });

  if (!config || (config.fonte && config.fonte !== 'EMPRESA')) {
    // getFiscalConfig com empresaId sempre retorna fonte EMPRESA; defesa extra.
    if (config && config.fonte === 'GLOBAL') {
      throw erroEmpresaNfe(
        CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA_USO,
        MENSAGENS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA,
        409
      );
    }
  }

  const certApto = await exigirGate({
    empresaId,
    db: opts.db,
    config,
    getFiscalConfigFn,
    deps: opts.certDeps || opts.deps || {},
    persistirSnapshot: opts.persistirSnapshot
  });

  config.certificadoPath = certApto.certificadoPath;
  config.certificadoSenha = certApto.certificadoSenha;
  config.empresaId = empresaId;

  return { empresaId, config, certApto };
}

/**
 * Converte erro do gate em resposta de emissão NF-e (sem falso sucesso).
 */
function respostaBloqueioCertificadoNfe(err) {
  return {
    success: false,
    status: 'certificado_bloqueado',
    message: err && err.message
      ? String(err.message)
      : MENSAGENS_CERTIFICADO_A1.FALHA_INTERNA,
    code: (err && err.code) || CODIGOS_CERTIFICADO_A1.ERRO,
    codigo: (err && err.code) || CODIGOS_CERTIFICADO_A1.ERRO,
    estado: (err && err.estado) || null,
    sefaz_chamado: false,
    apto_certificado_criptografico: false
  };
}

module.exports = {
  resolverEmpresaIdDocumentoNfe,
  carregarConfigEAplicarGateCertificadoNfe,
  respostaBloqueioCertificadoNfe
};
