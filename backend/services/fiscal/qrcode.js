const crypto = require('crypto');

/**
 * Normaliza a URL base de consulta QR Code para terminar em `?p=`.
 * Aceita bases com ou sem `?` / `?p=` (compatível com todas as UFs).
 * Sem fallback de host — a URL deve vir da configuração fiscal.
 */
function normalizarUrlBaseQr(consultaUrl) {
  const base = String(consultaUrl || '').trim();

  if (!base) {
    throw new Error(
      'URL de consulta QR Code NFC-e não configurada. ' +
      'Configure fiscal_csc_qrcode_url_producao (ambiente 1) ou ' +
      'fiscal_csc_qrcode_url_homologacao (ambiente 2).'
    );
  }

  if (/\?p=$/i.test(base)) {
    return base;
  }

  if (/\?p=/i.test(base)) {
    return base.replace(/(\?p=).*$/i, '$1');
  }

  if (base.endsWith('?')) {
    return `${base}p=`;
  }

  return `${base.replace(/\/+$/, '')}?p=`;
}

function mascararCscNaStringHash(dadosParaHash) {
  return `${dadosParaHash}***`;
}

function auditarQrCodeHomologacao({
  uf,
  tpAmb,
  versaoQR,
  urlBase,
  idToken,
  dadosParaHash,
  hashCSC,
  qrFinal
}) {
  if (Number(tpAmb) !== 2) {
    return;
  }

  console.log([
    '[FISCAL QRCODE AUDIT]',
    `UF: ${uf || '(não informado)'}`,
    `Ambiente: ${tpAmb} (Homologação)`,
    `Versão QR: ${versaoQR}`,
    `URL utilizada: ${urlBase}`,
    `ID CSC: ${idToken}`,
    `String SHA1: ${mascararCscNaStringHash(dadosParaHash)}`,
    `SHA1 gerado: ${hashCSC}`,
    `QR final: ${qrFinal}`
  ].join('\n'));
}

function rejeitarCscQr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function idTokenQrObrigatorio(idCSC) {
  const texto = idCSC == null ? '' : String(idCSC);
  if (!texto || texto !== texto.trim() || !/^[0-9]+$/.test(texto)) {
    throw rejeitarCscQr(
      texto ? 'CSC_ID_INVALIDO' : 'CSC_NAO_CONFIGURADO_PARA_AMBIENTE',
      'ID CSC ausente ou inválido. O QR Code não foi gerado.'
    );
  }
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw rejeitarCscQr('CSC_ID_INVALIDO', 'ID CSC ausente ou inválido. O QR Code não foi gerado.');
  }
  return String(n);
}

function tokenQrObrigatorio(CSC) {
  const token = CSC == null ? '' : String(CSC);
  if (!token.trim()) {
    throw rejeitarCscQr(
      'CSC_NAO_CONFIGURADO_PARA_AMBIENTE',
      'CSC não configurado para o ambiente da NFC-e. O QR Code não foi gerado.'
    );
  }
  return token.trim();
}

/**
 * Gera a URL do QR Code NFC-e (versão 2 — emissão online).
 * Algoritmo de hash: SHA-1(chNFe|2|tpAmb|cIdToken + CSC) em hex maiúsculo.
 * A URL base vem exclusivamente da configuração fiscal (sem hardcode).
 */
function gerarQRCodeNFCe({
  chave,
  ambiente,
  idCSC,
  CSC,
  consultaUrl,
  uf
}) {
  const versaoQR = '2';
  const tpAmb = String(Number(ambiente || 2));
  const idToken = idTokenQrObrigatorio(idCSC);
  const token = tokenQrObrigatorio(CSC);
  const urlBase = normalizarUrlBaseQr(consultaUrl);

  const dadosParaHash = `${chave}|${versaoQR}|${tpAmb}|${idToken}`;

  const hashCSC = crypto
    .createHash('sha1')
    .update(dadosParaHash + token)
    .digest('hex')
    .toUpperCase();

  const qrFinal = `${urlBase}${chave}|${versaoQR}|${tpAmb}|${idToken}|${hashCSC}`;

  auditarQrCodeHomologacao({
    uf,
    tpAmb,
    versaoQR,
    urlBase,
    idToken,
    dadosParaHash,
    hashCSC,
    qrFinal
  });

  return qrFinal;
}

module.exports = {
  gerarQRCodeNFCe,
  normalizarUrlBaseQr
};
