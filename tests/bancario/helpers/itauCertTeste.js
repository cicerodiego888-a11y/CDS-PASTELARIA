/**
 * Gera par certificado/private key efêmero em memória (testes).
 * Não persiste em disco. Não é credencial de produção.
 */
'use strict';

const forge = require('node-forge');

function gerarParCertificadoTeste(opts = {}) {
  const bits = opts.bits || 2048;
  const days = opts.days != null ? opts.days : 365;
  const cn = opts.cn || 'MBC-ITAU-TEST';
  const keys = forge.pki.rsa.generateKeyPair(bits);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  if (opts.expired) {
    cert.validity.notBefore = new Date(Date.now() - 10 * 864e5);
    cert.validity.notAfter = new Date(Date.now() - 864e5);
  } else if (opts.futureOnly) {
    cert.validity.notBefore = new Date(Date.now() + 864e5);
    cert.validity.notAfter = new Date(Date.now() + (days + 1) * 864e5);
  } else {
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + days);
  }
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certificate: forge.pki.certificateToPem(cert),
    private_key: forge.pki.privateKeyToPem(keys.privateKey)
  };
}

function gerarParNaoCorrespondente() {
  const a = gerarParCertificadoTeste({ cn: 'A' });
  const b = gerarParCertificadoTeste({ cn: 'B' });
  return {
    certificate: a.certificate,
    private_key: b.private_key
  };
}

module.exports = {
  gerarParCertificadoTeste,
  gerarParNaoCorrespondente
};
