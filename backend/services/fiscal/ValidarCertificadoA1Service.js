/**
 * Validação criptográfica local do certificado A1 (PKCS#12).
 * Reutiliza certificateService.carregarCertificadoPfx — não cria segunda implementação.
 * Não chama SEFAZ, SOAP, PFX de produção nem grava senha em log/resposta.
 */
'use strict';

const fs = require('fs');
const forge = require('node-forge');
const {
  carregarCertificadoPfx,
  extrairCnpjDoCertificadoPem
} = require('./certificateService');
const {
  ESTADOS_CERTIFICADO_A1,
  CODIGOS_CERTIFICADO_A1,
  MENSAGENS_CERTIFICADO_A1
} = require('./certificadoEstados');

function digits(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function novoDiagnosticoId() {
  return `diag-cert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizarTextoCertificado(texto) {
  let t = String(texto || '');
  t = t.replace(/-----BEGIN[\s\S]*?-----END [A-Z ]+-----/g, '[pem omitido]');
  t = t.replace(/(senha|password|passphrase)\s*[=:]\s*\S+/gi, '$1=[omitida]');
  t = t.replace(/PKCS#12 MAC could not be verified\.?\s*Invalid password\??/gi,
    'a senha não confere com o certificado');
  return t;
}

function logErroCertificado(err, extra = {}) {
  const tecnico = sanitizarTextoCertificado(err && err.message ? err.message : err);
  const payload = {
    codigo: extra.codigo || null,
    estado: extra.estado || null,
    empresaId: extra.empresaId || null,
    diagnosticoId: extra.diagnosticoId || null,
    tecnico
  };
  console.error('[certificado-a1]', JSON.stringify(payload));
}

function classificarErroCriptografico(err) {
  const msg = String(err && err.message ? err.message : err || '');
  if (/MAC could not be verified|Invalid password|invalid password/i.test(msg)) {
    return {
      estado: ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA,
      codigo: CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA
    };
  }
  if (
    /Too few bytes|ASN\.?1|fromDer|OID|integer too large|DER|not enough data|truncated/i.test(msg)
    || /Chave privada não encontrada|Nenhum certificado encontrado|Certificado folha/i.test(msg)
    || /não encontrado|ENOENT|EISDIR/i.test(msg)
  ) {
    return {
      estado: ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      codigo: CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    };
  }
  if (err && err.code === 'CERTIFICADO_CNPJ_NAO_COMPROVADO') {
    return {
      estado: ESTADOS_CERTIFICADO_A1.ERRO_DE_VALIDACAO,
      codigo: CODIGOS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO
    };
  }
  return {
    estado: ESTADOS_CERTIFICADO_A1.ERRO_DE_VALIDACAO,
    codigo: CODIGOS_CERTIFICADO_A1.ERRO
  };
}

function mensagemPublica(estado, codigo, diagnosticoId, extras = {}) {
  if (estado === ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA) {
    return extras.preservarAnterior === false
      ? MENSAGENS_CERTIFICADO_A1.SENHA_INVALIDA_TESTE
      : MENSAGENS_CERTIFICADO_A1.SENHA_INVALIDA;
  }
  if (estado === ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO) {
    return MENSAGENS_CERTIFICADO_A1.ARQUIVO_INVALIDO;
  }
  if (estado === ESTADOS_CERTIFICADO_A1.EXPIRADO) {
    const ate = extras.validadeAte
      ? new Date(extras.validadeAte).toLocaleDateString('pt-BR')
      : null;
    return ate
      ? `${MENSAGENS_CERTIFICADO_A1.EXPIRADO} Validade: ${ate}.`
      : MENSAGENS_CERTIFICADO_A1.EXPIRADO;
  }
  if (estado === ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE) {
    return MENSAGENS_CERTIFICADO_A1.CNPJ_DIVERGENTE;
  }
  if (codigo === CODIGOS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO) {
    return extras.mensagemCnpj || MENSAGENS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO;
  }
  if (estado === ESTADOS_CERTIFICADO_A1.VALIDO) {
    return MENSAGENS_CERTIFICADO_A1.VALIDO;
  }
  const id = diagnosticoId ? ` [${diagnosticoId}]` : '';
  return `${MENSAGENS_CERTIFICADO_A1.FALHA_INTERNA}${id}`;
}

function erroValidacao(estado, codigo, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.estado = estado;
  err.statusCode = extra.statusCode || 400;
  err.diagnosticoId = extra.diagnosticoId || null;
  err.detalhe = extra.detalhe || null;
  return err;
}

function extrairIdentidade(certPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const notBefore = cert.validity && cert.validity.notBefore
    ? new Date(cert.validity.notBefore)
    : null;
  const notAfter = cert.validity && cert.validity.notAfter
    ? new Date(cert.validity.notAfter)
    : null;
  let titular = null;
  const attrs = (cert.subject && cert.subject.attributes) || [];
  const cn = attrs.find((a) => a.name === 'commonName' || a.shortName === 'CN' || a.type === '2.5.4.3');
  const org = attrs.find((a) => a.name === 'organizationName' || a.shortName === 'O' || a.type === '2.5.4.10');
  if (cn && cn.value) titular = String(cn.value);
  else if (org && org.value) titular = String(org.value);
  return { notBefore, notAfter, titular, cert };
}

/**
 * @param {object} opts
 * @param {string} opts.caminho
 * @param {string} opts.senha
 * @param {string} [opts.cnpjEmpresa]
 * @param {boolean} [opts.exigirCnpj=true]
 * @param {boolean} [opts.preservarAnterior=true] — mensagem de senha menciona preservação
 * @param {number} [opts.empresaId]
 * @returns {object} resultado (ok true/false) — nunca inclui senha nem PEM
 */
function validarArquivoPfx(opts = {}) {
  const diagnosticoId = novoDiagnosticoId();
  const caminho = opts.caminho ? String(opts.caminho) : '';
  const senha = opts.senha == null ? '' : String(opts.senha);
  const cnpjEmpresa = digits(opts.cnpjEmpresa);
  const exigirCnpj = opts.exigirCnpj !== false;
  const preservarAnterior = opts.preservarAnterior !== false;

  const base = {
    ok: false,
    diagnosticoId,
    sefazChamado: false,
    titular: null,
    cnpjCertificado: null,
    validadeDe: null,
    validadeAte: null,
    diasRestantes: null
  };

  if (!caminho) {
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO,
      codigo: CODIGOS_CERTIFICADO_A1.ARQUIVO_OBRIGATORIO,
      mensagem: MENSAGENS_CERTIFICADO_A1.NAO_CONFIGURADO
    };
  }

  if (!fs.existsSync(caminho)) {
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      codigo: CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      mensagem: MENSAGENS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    };
  }

  if (!String(senha).length) {
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA,
      codigo: CODIGOS_CERTIFICADO_A1.SENHA_OBRIGATORIA,
      mensagem: MENSAGENS_CERTIFICADO_A1.SENHA_OBRIGATORIA
    };
  }

  let pfx;
  try {
    pfx = carregarCertificadoPfx(caminho, senha);
  } catch (err) {
    const cls = classificarErroCriptografico(err);
    logErroCertificado(err, {
      codigo: cls.codigo,
      estado: cls.estado,
      empresaId: opts.empresaId,
      diagnosticoId
    });
    return {
      ...base,
      estado: cls.estado,
      codigo: cls.codigo,
      mensagem: mensagemPublica(cls.estado, cls.codigo, diagnosticoId, { preservarAnterior })
    };
  }

  if (!pfx || !pfx.certPem || !pfx.privateKeyPem) {
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      codigo: CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      mensagem: MENSAGENS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    };
  }

  let identidade;
  try {
    identidade = extrairIdentidade(pfx.certPem);
  } catch (err) {
    logErroCertificado(err, {
      codigo: CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      estado: ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      empresaId: opts.empresaId,
      diagnosticoId
    });
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      codigo: CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO,
      mensagem: MENSAGENS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    };
  }

  const agora = new Date();
  const validadeAte = identidade.notAfter;
  const validadeDe = identidade.notBefore;
  const diasRestantes = validadeAte
    ? Math.ceil((validadeAte.getTime() - agora.getTime()) / 86400000)
    : null;

  if (validadeAte && agora > validadeAte) {
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.EXPIRADO,
      codigo: CODIGOS_CERTIFICADO_A1.EXPIRADO,
      mensagem: mensagemPublica(
        ESTADOS_CERTIFICADO_A1.EXPIRADO,
        CODIGOS_CERTIFICADO_A1.EXPIRADO,
        diagnosticoId,
        { validadeAte }
      ),
      titular: identidade.titular,
      validadeDe: validadeDe ? validadeDe.toISOString() : null,
      validadeAte: validadeAte.toISOString(),
      diasRestantes
    };
  }

  let cnpjCertificado = null;
  try {
    cnpjCertificado = extrairCnpjDoCertificadoPem(pfx.certPem);
  } catch (err) {
    if (exigirCnpj && cnpjEmpresa) {
      const msgTech = String(err && err.message ? err.message : '');
      const mensagemCnpj = /conflitantes/i.test(msgTech)
        ? MENSAGENS_CERTIFICADO_A1.CNPJ_CONFLITANTE
        : MENSAGENS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO;
      logErroCertificado(err, {
        codigo: CODIGOS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO,
        estado: ESTADOS_CERTIFICADO_A1.ERRO_DE_VALIDACAO,
        empresaId: opts.empresaId,
        diagnosticoId
      });
      return {
        ...base,
        estado: ESTADOS_CERTIFICADO_A1.ERRO_DE_VALIDACAO,
        codigo: CODIGOS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO,
        mensagem: mensagemCnpj,
        titular: identidade.titular,
        validadeDe: validadeDe ? validadeDe.toISOString() : null,
        validadeAte: validadeAte ? validadeAte.toISOString() : null,
        diasRestantes
      };
    }
  }

  if (exigirCnpj && cnpjEmpresa && cnpjCertificado && cnpjCertificado !== cnpjEmpresa) {
    return {
      ...base,
      estado: ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE,
      codigo: CODIGOS_CERTIFICADO_A1.CNPJ_DIVERGENTE,
      mensagem: MENSAGENS_CERTIFICADO_A1.CNPJ_DIVERGENTE,
      titular: identidade.titular,
      cnpjCertificado,
      validadeDe: validadeDe ? validadeDe.toISOString() : null,
      validadeAte: validadeAte ? validadeAte.toISOString() : null,
      diasRestantes
    };
  }

  return {
    ok: true,
    diagnosticoId,
    sefazChamado: false,
    estado: ESTADOS_CERTIFICADO_A1.VALIDO,
    codigo: CODIGOS_CERTIFICADO_A1.VALIDACAO_OK,
    mensagem: MENSAGENS_CERTIFICADO_A1.VALIDO,
    titular: identidade.titular,
    cnpjCertificado,
    validadeDe: validadeDe ? validadeDe.toISOString() : null,
    validadeAte: validadeAte ? validadeAte.toISOString() : null,
    diasRestantes
  };
}

function dtoPublicoValidacao(resultado) {
  if (!resultado || typeof resultado !== 'object') return {};
  return {
    ok: !!resultado.ok,
    estado: resultado.estado,
    codigo: resultado.codigo,
    mensagem: resultado.mensagem,
    diagnostico_id: resultado.diagnosticoId || null,
    titular: resultado.titular || null,
    cnpj_certificado: resultado.cnpjCertificado || null,
    validade_de: resultado.validadeDe || null,
    validade_ate: resultado.validadeAte || null,
    dias_restantes: resultado.diasRestantes,
    sefaz_chamado: false
  };
}

module.exports = {
  validarArquivoPfx,
  dtoPublicoValidacao,
  classificarErroCriptografico,
  sanitizarTextoCertificado,
  logErroCertificado,
  erroValidacao,
  novoDiagnosticoId,
  ESTADOS_CERTIFICADO_A1,
  CODIGOS_CERTIFICADO_A1,
  MENSAGENS_CERTIFICADO_A1
};
