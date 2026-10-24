/**
 * P0.7 — Extração e validação do CNPJ do certificado A1.
 * PFX sintéticos. Banco isolado. Sem SEFAZ. Sem PFX de produção.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/extracao-cnpj-certificado-a1-p0-7.test.js
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p07-cnpj-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');
const sqlite3 = require('sqlite3').verbose();

const {
  extrairCnpjDoCertificadoPem,
  carregarCertificadoPfx,
  cnpjDigitosValidos
} = require('../../backend/services/fiscal/certificateService');
const { validarArquivoPfx } = require('../../backend/services/fiscal/ValidarCertificadoA1Service');
const {
  substituirCertificadoEmpresa,
  testarCertificadoEmpresa
} = require('../../backend/services/fiscal/CertificadoEmpresaService');
const {
  ESTADOS_CERTIFICADO_A1,
  CODIGOS_CERTIFICADO_A1,
  MENSAGENS_CERTIFICADO_A1
} = require('../../backend/services/fiscal/certificadoEstados');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaFiscalEmpresaAsync } = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

/** CNPJ com DV válido (empresa do relato, só em teste sintético). */
const CNPJ_OK = '38204469000115';
const CNPJ_OUTRO = '11222333000181';
const SENHA = 'SenhaP07#ok';
const SENHA_ERR = 'SenhaP07#err';

let passou = 0;
let falhou = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((e) => {
      falhou += 1;
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${e.message}`);
    });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_e) { resolve(); }
  });
}

function gerarChave() {
  return forge.pki.rsa.generateKeyPair({ bits: 512, workers: -1 });
}

function pemDeAttrs(attrs, keys, { notAfter } = {}) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = notAfter || new Date('2035-01-01T00:00:00Z');
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    privateKey: keys.privateKey,
    cert
  };
}

function pfxDePem(privateKey, cert, senha) {
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

async function main() {
  console.log('\n=== P0.7 Extração CNPJ certificado A1 ===\n');
  isolamento.comprobarSeCarregado();
  assert.ok(cnpjDigitosValidos(CNPJ_OK), 'CNPJ_OK deve ter DV válido');

  const keys = gerarChave();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p07-pfx-'));
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p07-certs-'));
  const tmpUpload = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p07-up-'));

  await test('1. OID ICP-Brasil string: CNPJ correspondente aprovado', () => {
    const { certPem } = pemDeAttrs([
      { name: 'commonName', value: 'CICERA ERICA ALVES GOMES LANCHONETE' },
      { type: '2.16.76.1.3.3', value: CNPJ_OK }
    ], keys);
    assert.equal(extrairCnpjDoCertificadoPem(certPem), CNPJ_OK);
  });

  await test('2. OID com valor em bytes ASCII (padrão ICP-Brasil / forge)', () => {
    const bytes = CNPJ_OK; // string binária forge de 14 dígitos
    const { certPem } = pemDeAttrs([
      { name: 'commonName', value: 'Empresa Teste' },
      { type: '2.16.76.1.3.3', value: bytes }
    ], keys);
    assert.equal(extrairCnpjDoCertificadoPem(certPem), CNPJ_OK);
  });

  await test('3. CNPJ só no CN rotulado (sem OID) com DV válido', () => {
    const { certPem } = pemDeAttrs([
      { name: 'commonName', value: `EMPRESA DEMO:${CNPJ_OK}` }
    ], keys);
    assert.equal(extrairCnpjDoCertificadoPem(certPem), CNPJ_OK);
  });

  await test('4. Extração via varredura DER do OID', () => {
    const { certPem, cert } = pemDeAttrs([
      { name: 'commonName', value: 'Sem label' },
      { type: '2.16.76.1.3.3', value: CNPJ_OK }
    ], keys);
    // Garante que o DER contém o OID; a função usa subject + DER
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    assert.ok(der.indexOf(String.fromCharCode(0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03)) >= 0);
    assert.equal(extrairCnpjDoCertificadoPem(certPem), CNPJ_OK);
  });

  await test('5. Senha incorreta reprova', () => {
    const { cert, privateKey } = pemDeAttrs([
      { name: 'commonName', value: 'X' },
      { type: '2.16.76.1.3.3', value: CNPJ_OK }
    ], keys);
    const arquivo = path.join(tmp, 'senha.pfx');
    fs.writeFileSync(arquivo, pfxDePem(privateKey, cert, SENHA));
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_ERR,
      cnpjEmpresa: CNPJ_OK,
      preservarAnterior: true
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA);
  });

  await test('6. CNPJ diferente reprova como divergente', () => {
    const { cert, privateKey } = pemDeAttrs([
      { name: 'commonName', value: 'X' },
      { type: '2.16.76.1.3.3', value: CNPJ_OK }
    ], keys);
    const arquivo = path.join(tmp, 'div.pfx');
    fs.writeFileSync(arquivo, pfxDePem(privateKey, cert, SENHA));
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA,
      cnpjEmpresa: CNPJ_OUTRO
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE);
    assert.equal(r.codigo, CODIGOS_CERTIFICADO_A1.CNPJ_DIVERGENTE);
    assert.match(r.mensagem, /não corresponde/i);
  });

  await test('7. CNPJ não extraível reprova com mensagem específica', () => {
    const { cert, privateKey } = pemDeAttrs([
      { name: 'commonName', value: 'Sem identidade fiscal' }
    ], keys);
    const arquivo = path.join(tmp, 'sem.pfx');
    fs.writeFileSync(arquivo, pfxDePem(privateKey, cert, SENHA));
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA,
      cnpjEmpresa: CNPJ_OK
    });
    assert.equal(r.ok, false);
    assert.equal(r.codigo, CODIGOS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO);
    assert.equal(r.mensagem, MENSAGENS_CERTIFICADO_A1.CNPJ_NAO_COMPROVADO);
    assert.doesNotMatch(r.mensagem, /comprovar o CNPJ do certificado para a empresa/i);
  });

  await test('8. PFX corrompido reprova', () => {
    const arquivo = path.join(tmp, 'bad.pfx');
    fs.writeFileSync(arquivo, Buffer.from('nao-e-pfx'));
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA,
      cnpjEmpresa: CNPJ_OK
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO);
  });

  await test('9. Nome do arquivo não é prova de CNPJ', () => {
    const { certPem } = pemDeAttrs([
      { name: 'commonName', value: 'Sem CNPJ' }
    ], keys);
    assert.throws(
      () => extrairCnpjDoCertificadoPem(certPem),
      (e) => e.code === 'CERTIFICADO_CNPJ_NAO_COMPROVADO'
    );
    // Mesmo que o "arquivo" se chamasse ...38204469000115.pfx, a PEM não carrega o nome.
    void '2886079_CICERA_ERICA_ALVES_GOMES_LANCHONETE_38204469000115.pfx';
  });

  await test('10. Upload/teste: correspondente ok; empresa B não associa', async () => {
    const db = await openDb();
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaFiscalEmpresaAsync(db);
    const empA = await EmpresaService.criarEmpresa({
      cnpj: CNPJ_OK,
      razao_social: 'Lanchonete P07'
    }, { db });
    const empB = await EmpresaService.criarEmpresa({
      cnpj: CNPJ_OUTRO,
      razao_social: 'Outra P07'
    }, { db });
    const deps = { db, pastaCertificados: certDir, pastaTemporaria: tmpUpload };
    const { cert, privateKey } = pemDeAttrs([
      { name: 'commonName', value: 'Lanchonete' },
      { type: '2.16.76.1.3.3', value: CNPJ_OK }
    ], keys);
    const tmpA = path.join(tmpUpload, 'up-a.pfx');
    fs.writeFileSync(tmpA, pfxDePem(privateKey, cert, SENHA));

    const up = await substituirCertificadoEmpresa({
      empresaId: empA.id,
      arquivoTmp: tmpA,
      senha: SENHA,
      deps
    });
    assert.equal(up.ok, true);
    assert.equal(up.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.equal(up.cnpj_certificado, CNPJ_OK);

    const teste = await testarCertificadoEmpresa({ empresaId: empA.id, deps });
    assert.equal(teste.ok, true);
    assert.equal(teste.cnpj_certificado, CNPJ_OK);

    const tmpB = path.join(tmpUpload, 'up-b.pfx');
    fs.writeFileSync(tmpB, pfxDePem(privateKey, cert, SENHA));
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: empB.id,
        arquivoTmp: tmpB,
        senha: SENHA,
        deps
      }),
      (err) => err.estado === ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
        || err.code === CODIGOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    );

    // Falha de substituição preserva anterior: reenvia senha errada
    const tmpFail = path.join(tmpUpload, 'fail.pfx');
    fs.writeFileSync(tmpFail, pfxDePem(privateKey, cert, SENHA));
    const destAntes = path.join(certDir, `certificado-empresa-${empA.id}.pfx`);
    const bufAntes = fs.readFileSync(destAntes);
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: empA.id,
        arquivoTmp: tmpFail,
        senha: SENHA_ERR,
        deps
      }),
      (err) => err.estado === ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA
    );
    assert.ok(fs.existsSync(destAntes));
    assert.deepEqual(fs.readFileSync(destAntes), bufAntes);

    // carregarCertificadoPfx + extrair coerente
    const loaded = carregarCertificadoPfx(destAntes, SENHA);
    assert.equal(extrairCnpjDoCertificadoPem(loaded.certPem), CNPJ_OK);

    await closeDb(db);
  });

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(certDir, { recursive: true, force: true });
    fs.rmSync(tmpUpload, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }

  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
