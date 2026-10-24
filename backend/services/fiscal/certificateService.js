const fs = require('fs');
const forge = require('node-forge');

function isCaCertificate(cert) {
  const bc = cert.getExtension('basicConstraints');
  return !!(bc && bc.cA === true);
}

function isSelfSigned(cert) {
  try {
    return cert.issuer.hash === cert.subject.hash;
  } catch {
    return false;
  }
}

function bytesToHexSafe(value) {
  try {
    return value ? forge.util.bytesToHex(value) : null;
  } catch {
    return null;
  }
}

const OID_CNPJ_ICP_BRASIL = '2.16.76.1.3.3';
/** DER: OID tag+len+value para 2.16.76.1.3.3 */
const DER_OID_CNPJ_ICP = String.fromCharCode(0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03);

function apenasDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

/** Algoritmo oficial de dígitos verificadores do CNPJ (não usa nome de arquivo). */
function cnpjDigitosValidos(cnpj) {
  const d = apenasDigitos(cnpj);
  if (!/^\d{14}$/.test(d)) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (base, pesos) => {
    let soma = 0;
    for (let i = 0; i < pesos.length; i += 1) soma += Number(base[i]) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(d.slice(0, 12) + String(d1), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d[12] === String(d1) && d[13] === String(d2);
}

/**
 * Converte valor de atributo X.509 (string forge, bytes, Buffer) em texto útil.
 * Certificados ICP-Brasil frequentemente expõem o OID CNPJ como bytes ASCII, não string limpa.
 */
function valorAtributoParaTexto(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    // Preferir sequência imprimível; se falhar, extrair só dígitos da string binária.
    const printable = value.replace(/[^\x20-\x7E]/g, '').trim();
    if (printable) return printable;
    return value;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value.toString('latin1');
  }
  if (Array.isArray(value)) {
    return value.map((v) => valorAtributoParaTexto(v)).join('');
  }
  return String(value);
}

/**
 * @param {*} value
 * @param {{ exigirDv?: boolean }} [opts] — DV obrigatório só fora do OID ICP-Brasil
 */
function cnpjDeValorBruto(value, opts = {}) {
  const exigirDv = opts.exigirDv === true;
  const aceitar = (dig) => {
    if (!dig || dig.length !== 14) return null;
    if (exigirDv && !cnpjDigitosValidos(dig)) return null;
    return dig;
  };
  const texto = valorAtributoParaTexto(value);
  const soDigitos = apenasDigitos(texto);
  const direto = aceitar(soDigitos);
  if (direto) return direto;
  // OID/campo com lixo ao redor: primeira sequência de 14 dígitos
  if (soDigitos.length > 14) {
    const m = soDigitos.match(/\d{14}/);
    if (m) {
      const cand = aceitar(m[0]);
      if (cand) return cand;
    }
  }
  if (typeof value === 'string' && value.length === 14 && /^\d{14}$/.test(value)) {
    return aceitar(value);
  }
  const labeled = texto.match(/\bCNPJ\s*[:=]\s*([\d./-]{14,18})/i);
  if (labeled) {
    const dig = aceitar(apenasDigitos(labeled[1]));
    if (dig) return dig;
  }
  // Padrão comum em CN: "RAZAO SOCIAL:38204469000115"
  const trailing = texto.match(/(?:^|[^0-9])(\d{14})(?:[^0-9]|$)/);
  if (trailing) return aceitar(trailing[1]);
  return null;
}

function atributoEhOidCnpj(attribute) {
  if (!attribute) return false;
  const tipo = String(attribute.type || attribute.name || '').trim();
  return tipo === OID_CNPJ_ICP_BRASIL || tipo.endsWith(OID_CNPJ_ICP_BRASIL);
}

/** Varre o DER do certificado por OID ICP-Brasil CNPJ seguido de string de 14 dígitos. */
function coletarCnpjViaDer(cert, destino) {
  try {
    const asn1 = forge.pki.certificateToAsn1(cert);
    const der = forge.asn1.toDer(asn1).getBytes();
    let from = 0;
    while (from < der.length) {
      const idx = der.indexOf(DER_OID_CNPJ_ICP, from);
      if (idx < 0) break;
      const janela = der.slice(idx, Math.min(der.length, idx + 96));
      for (let i = DER_OID_CNPJ_ICP.length; i < janela.length - 15; i += 1) {
        const tag = janela.charCodeAt(i);
        const len = janela.charCodeAt(i + 1);
        // PrintableString / UTF8 / IA5 / OCTET STRING com 14 octetos
        if ((tag === 0x13 || tag === 0x0c || tag === 0x16 || tag === 0x04) && len === 14) {
          const raw = janela.slice(i + 2, i + 2 + 14);
          // OID ICP-Brasil: aceita 14 dígitos sem exigir DV (CA já atestou).
          if (/^\d{14}$/.test(raw)) {
            destino.add(raw);
          }
        }
      }
      from = idx + 1;
    }
  } catch {
    /* ignore — fallbacks cobrem outros formatos */
  }
}

function coletarCnpjDeSan(cert, destino) {
  try {
    const ext = cert.getExtension('subjectAltName');
    if (!ext) return;
    const altNames = ext.altNames || [];
    for (const alt of altNames) {
      if (!alt) continue;
      // otherName / directoryName / valor textual
      const candidatos = [alt.value, alt.ip, alt.valueTagClass];
      if (alt.type === 0 || alt.type === 'otherName') {
        if (alt.value && typeof alt.value === 'object') {
          candidatos.push(alt.value.value, alt.value.hex);
        }
      }
      for (const c of candidatos) {
        const dig = cnpjDeValorBruto(c, { exigirDv: true });
        if (dig) destino.add(dig);
      }
    }
    if (ext.value) {
      const dig = cnpjDeValorBruto(ext.value, { exigirDv: true });
      if (dig) destino.add(dig);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Extrai o CNPJ comprovável do certificado (PEM).
 * Não usa nome de arquivo. Aceita OID ICP-Brasil em subject/DER/SAN e rótulos explícitos.
 */
function extrairCnpjDoCertificadoPem(certPem) {
  const erroIdentidade = (message, cause) => {
    const error = new Error(message);
    error.code = 'CERTIFICADO_CNPJ_NAO_COMPROVADO';
    if (cause) error.cause = cause;
    return error;
  };
  if (typeof certPem !== 'string' || !certPem.trim()) {
    throw erroIdentidade('Identidade CNPJ do certificado não comprovada.');
  }

  let cert;
  try {
    cert = forge.pki.certificateFromPem(certPem);
  } catch (cause) {
    throw erroIdentidade('Não foi possível ler a identidade do certificado.', cause);
  }

  const fromOid = new Set();
  const fromOutros = new Set();

  (cert.subject?.attributes || []).forEach((attribute) => {
    if (atributoEhOidCnpj(attribute)) {
      const digOid = cnpjDeValorBruto(attribute.value, { exigirDv: false });
      if (digOid) fromOid.add(digOid);
      return;
    }
    const dig = cnpjDeValorBruto(attribute.value, { exigirDv: true });
    if (!dig) return;
    // serialNumber (2.5.4.5) às vezes carrega o CNPJ em A1 ICP-Brasil
    const tipo = String(attribute.type || '');
    const short = String(attribute.shortName || attribute.name || '');
    if (tipo === '2.5.4.5' || short === 'serialNumber' || short === 'SERIALNUMBER') {
      fromOutros.add(dig);
      return;
    }
    const texto = valorAtributoParaTexto(attribute.value);
    if (/\bCNPJ\s*[:=]/i.test(texto) || /:\d{14}\s*$/.test(texto.trim())) {
      fromOutros.add(dig);
    }
  });

  coletarCnpjViaDer(cert, fromOid);
  coletarCnpjDeSan(cert, fromOutros);

  // Preferir identidade do OID ICP-Brasil; só usar outros se OID ausente.
  const preferidos = fromOid.size ? fromOid : fromOutros;
  if (preferidos.size === 1) {
    return [...preferidos][0];
  }
  if (preferidos.size > 1) {
    throw erroIdentidade('O certificado contém identidades CNPJ conflitantes.');
  }
  throw erroIdentidade('O certificado não contém um CNPJ verificável nos campos de identidade.');
}

function carregarCertificadoPfx(certificadoPath, senha) {
  if (!certificadoPath) {
    throw new Error('Caminho do certificado não configurado.');
  }

  if (!fs.existsSync(certificadoPath)) {
    throw new Error(`Certificado não encontrado em: ${certificadoPath}`);
  }

  const pfxBuffer = fs.readFileSync(certificadoPath);
  const p12Der = forge.util.createBuffer(pfxBuffer.toString('binary'));
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha || '');

  let privateKeyPem = '';
  let certPem = '';
  let certBase64 = '';
  let certBundlePem = '';

  const keyBags =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] || [];

  if (!keyBags.length || !keyBags[0]?.key) {
    throw new Error('Chave privada não encontrada no PFX.');
  }

  const keyBag = keyBags[0];
  privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);

  const keyLocalKeyId =
    keyBag.attributes &&
    keyBag.attributes.localKeyId &&
    keyBag.attributes.localKeyId[0]
      ? bytesToHexSafe(keyBag.attributes.localKeyId[0])
      : null;

  const certBags =
    p12.getBags({ bagType: forge.pki.oids.certBag })[
      forge.pki.oids.certBag
    ] || [];

  if (!certBags.length) {
    throw new Error('Nenhum certificado encontrado dentro do PFX.');
  }

  const certs = certBags.filter((bag) => bag?.cert);

  let certBagFolha = null;

  if (keyLocalKeyId) {
    certBagFolha = certs.find((bag) => {
      const certLocalKeyId =
        bag.attributes &&
        bag.attributes.localKeyId &&
        bag.attributes.localKeyId[0]
          ? bytesToHexSafe(bag.attributes.localKeyId[0])
          : null;

      return certLocalKeyId && certLocalKeyId === keyLocalKeyId;
    });
  }

  if (!certBagFolha) {
    certBagFolha = certs.find((bag) => {
      const cert = bag.cert;
      if (!cert) return false;
      return !isCaCertificate(cert);
    }) || certs[0];
  }

  if (!certBagFolha || !certBagFolha.cert) {
    throw new Error('Certificado folha não encontrado no PFX.');
  }

  certPem = forge.pki.certificateToPem(certBagFolha.cert);
  certBase64 = forge.util.encode64(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certBagFolha.cert)).getBytes()
  );

  const intermediarios = certs
    .filter((bag) => bag.cert && bag.cert !== certBagFolha.cert)
    .map((bag) => bag.cert)
    .filter((cert) => isCaCertificate(cert) && !isSelfSigned(cert));

  certBundlePem = [certPem, ...intermediarios.map((c) => forge.pki.certificateToPem(c))].join('\n');

  if (!privateKeyPem || !certPem || !certBase64) {
    throw new Error('Não foi possível extrair chave privada e certificado do PFX.');
  }

  return {
    privateKeyPem,
    certPem,
    certBase64,
    certBundlePem
  };
}

function extrairNomeEmpresaDoCertificado(certificadoPath, senha) {
  try {
    const pfx = carregarCertificadoPfx(certificadoPath, senha);
    const certPem = pfx.certPem;
    const cert = forge.pki.certificateFromPem(certPem);
    
    const subject = cert.subject;
    if (subject && subject.attributes) {
      const cnAttribute = subject.attributes.find(attr => 
        attr.name === 'commonName' || 
        attr.shortName === 'CN' ||
        attr.type === '2.5.4.3'
      );
      
      if (cnAttribute && cnAttribute.value) {
        return cnAttribute.value;
      }
      
      const orgAttribute = subject.attributes.find(attr => 
        attr.name === 'organizationName' || 
        attr.shortName === 'O' ||
        attr.type === '2.5.4.10'
      );
      
      if (orgAttribute && orgAttribute.value) {
        return orgAttribute.value;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Erro ao extrair nome do certificado:', error);
    return null;
  }
}

module.exports = {
  carregarCertificadoPfx,
  extrairNomeEmpresaDoCertificado,
  extrairCnpjDoCertificadoPem,
  cnpjDigitosValidos,
  OID_CNPJ_ICP_BRASIL
};
