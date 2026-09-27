/**
 * Validação de certificado/private key Itaú (sem logar material).
 * @module motores/bancario/providers/itau/ItauCertificadoUtil
 */
'use strict';

const { X509Certificate, createPrivateKey } = require('crypto');

function temPem(valor, marcador) {
  const s = String(valor || '');
  return s.includes('BEGIN') && s.includes(marcador);
}

/**
 * @returns {{
 *   ok: boolean,
 *   errorCode?: string,
 *   message?: string,
 *   valid_from?: string|null,
 *   valid_to?: string|null,
 *   expirado?: boolean,
 *   subject_cn?: string|null
 * }}
 */
function validarMaterialTls(params = {}) {
  const certificate = params.certificate != null ? String(params.certificate).trim() : '';
  const privateKey = params.private_key != null ? String(params.private_key).trim() : '';
  const exigir = params.exigir === true;

  if (!certificate && !privateKey && !exigir) {
    return { ok: true, valid_from: null, valid_to: null, expirado: false, subject_cn: null };
  }
  if (!certificate) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_AUSENTE',
      message: 'Certificado cliente Itaú ausente.'
    };
  }
  if (!privateKey) {
    return {
      ok: false,
      errorCode: 'PRIVATE_KEY_AUSENTE',
      message: 'Private key Itaú ausente.'
    };
  }
  if (!temPem(certificate, 'CERTIFICATE')) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
      message: 'Certificado Itaú inválido (esperado PEM).'
    };
  }
  if (!temPem(privateKey, 'PRIVATE KEY') && !temPem(privateKey, 'RSA PRIVATE KEY')) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
      message: 'Private key Itaú inválida (esperado PEM).'
    };
  }

  let x509;
  try {
    x509 = new X509Certificate(certificate);
  } catch (_) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
      message: 'Não foi possível ler o certificado Itaú.'
    };
  }

  let keyObj;
  try {
    keyObj = createPrivateKey(privateKey);
  } catch (_) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
      message: 'Não foi possível ler a private key Itaú.'
    };
  }

  try {
    // Preferir checkPrivateKey (Node 15+). Evita createPublicKey(x509.publicKey),
    // que em Node 24+ falha quando publicKey já é KeyObject público.
    if (typeof x509.checkPrivateKey === 'function') {
      if (!x509.checkPrivateKey(keyObj)) {
        return {
          ok: false,
          errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
          message: 'Certificado e private key Itaú não formam um par válido.'
        };
      }
    } else {
      const { createPublicKey } = require('crypto');
      const pubFromCert = createPublicKey(x509.publicKey.export({ type: 'spki', format: 'der' }));
      const pubFromKey = createPublicKey(keyObj);
      const a = pubFromCert.export({ type: 'spki', format: 'der' });
      const b = pubFromKey.export({ type: 'spki', format: 'der' });
      if (Buffer.compare(a, b) !== 0) {
        return {
          ok: false,
          errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
          message: 'Certificado e private key Itaú não formam um par válido.'
        };
      }
    }
  } catch (_) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
      message: 'Falha ao validar associação certificado/private key Itaú.'
    };
  }

  const validFrom = x509.validFrom ? new Date(x509.validFrom) : null;
  const validTo = x509.validTo ? new Date(x509.validTo) : null;
  const agora = Date.now();
  const expirado = !!(validTo && Number.isFinite(validTo.getTime()) && validTo.getTime() < agora);
  if (expirado) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_EXPIRADO',
      message: 'Certificado Itaú expirado.',
      valid_from: validFrom && Number.isFinite(validFrom.getTime()) ? validFrom.toISOString() : null,
      valid_to: validTo.toISOString(),
      expirado: true,
      subject_cn: extrairCn(x509.subject)
    };
  }
  if (validFrom && Number.isFinite(validFrom.getTime()) && validFrom.getTime() > agora) {
    return {
      ok: false,
      errorCode: 'CERTIFICADO_CHAVE_INVALIDOS',
      message: 'Certificado Itaú ainda não é válido (validFrom no futuro).',
      valid_from: validFrom.toISOString(),
      valid_to: validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
      expirado: false,
      subject_cn: extrairCn(x509.subject)
    };
  }

  return {
    ok: true,
    valid_from: validFrom && Number.isFinite(validFrom.getTime()) ? validFrom.toISOString() : null,
    valid_to: validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
    expirado: false,
    subject_cn: extrairCn(x509.subject)
  };
}

function extrairCn(subject) {
  if (!subject) return null;
  const m = String(subject).match(/CN\s*=\s*([^,\n]+)/i);
  return m ? String(m[1]).trim().slice(0, 120) : String(subject).slice(0, 120);
}

/**
 * Metadados públicos do certificado (sem PEM).
 */
function metadadosCertificadoPublico(certificate) {
  if (!certificate || !String(certificate).trim()) {
    return {
      certificado_configurado: false,
      certificado_valido_ate: null,
      certificado_expirado: false,
      certificado_subject_cn: null
    };
  }
  try {
    const x509 = new X509Certificate(String(certificate));
    const validTo = x509.validTo ? new Date(x509.validTo) : null;
    const expirado = !!(validTo && Number.isFinite(validTo.getTime()) && validTo.getTime() < Date.now());
    return {
      certificado_configurado: true,
      certificado_valido_ate: validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
      certificado_expirado: expirado,
      certificado_subject_cn: extrairCn(x509.subject)
    };
  } catch (_) {
    return {
      certificado_configurado: true,
      certificado_valido_ate: null,
      certificado_expirado: false,
      certificado_subject_cn: null,
      certificado_ilegivel: true
    };
  }
}

module.exports = {
  validarMaterialTls,
  metadadosCertificadoPublico,
  extrairCn
};
