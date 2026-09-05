/**
 * PKCE S256. Verifier só no servidor / ISecretStore.
 * @module mercado-pago/pkce
 */
'use strict';

const crypto = require('crypto');

function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function gerarPkceS256() {
  const code_verifier = base64Url(crypto.randomBytes(32));
  const code_challenge = base64Url(crypto.createHash('sha256').update(code_verifier).digest());
  return {
    code_verifier,
    code_challenge,
    code_challenge_method: 'S256'
  };
}

function chaveVerifierConsentimento(consentimentoId) {
  return 'mbc.mp.pkce.verifier.' + Number(consentimentoId);
}

async function persistirVerifier(secretStore, consentimentoId, verifier) {
  if (!secretStore || consentimentoId == null) return false;
  await secretStore.set(chaveVerifierConsentimento(consentimentoId), String(verifier));
  return true;
}

module.exports = {
  gerarPkceS256,
  chaveVerifierConsentimento,
  persistirVerifier
};
