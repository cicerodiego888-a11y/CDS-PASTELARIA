/**
 * P0 — Validação criptográfica do certificado A1 no cadastro da empresa.
 * PFX sintéticos. Banco temporário. Sem SEFAZ. Sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/validacao-certificado-empresa-a1.test.js
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-fiscal-cert-a1-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const forge = require('node-forge');

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  garantirSchemaFiscalEmpresaAsync,
  obterConfiguracaoFiscalEmpresa,
  salvarConfiguracaoFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { validarArquivoPfx } = require('../../backend/services/fiscal/ValidarCertificadoA1Service');
const {
  substituirCertificadoEmpresa,
  testarCertificadoEmpresa,
  exigirEmpresaIdExplicito
} = require('../../backend/services/fiscal/CertificadoEmpresaService');
const { ESTADOS_CERTIFICADO_A1, CODIGOS_CERTIFICADO_A1 } = require('../../backend/services/fiscal/certificadoEstados');
const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const SENHA_OK = 'SenhaTesteA1#1';
const SENHA_ERRADA = 'SenhaErrada#9';
const ROOT = path.join(__dirname, '../..');

let passou = 0;
let falhou = 0;
const resultados = [];

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou += 1;
      resultados.push({ nome, ok: true });
      console.log(`  OK  ${nome}`);
    })
    .catch((error) => {
      falhou += 1;
      resultados.push({ nome, ok: false, erro: error.message });
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${error.message}`);
    });
}

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

function montarPfxBuffer({ senha, cnpj, notBefore, notAfter, keys }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = notBefore || new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = notAfter || new Date('2035-01-01T00:00:00Z');
  const attrs = [
    { name: 'commonName', value: `Empresa ${cnpj || 'sem-cnpj'}` }
  ];
  if (cnpj) attrs.push({ type: '2.16.76.1.3.3', value: cnpj });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, {
    algorithm: '3des'
  });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

function gravarPfx(dir, nome, buffer) {
  const destino = path.join(dir, nome);
  fs.writeFileSync(destino, buffer);
  return destino;
}

async function setupEmpresas(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaFiscalEmpresaAsync(db);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Empresa A Cert' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Empresa B Cert' }, { db });
  return { a, b };
}

async function main() {
  console.log('\n=== P0 Validação certificado A1 da empresa ===\n');
  isolamento.comprobarSeCarregado();
  recusarOficial(isolamento.dbDir);

  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cert-a1-files-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cert-a1-tmp-'));
  const keys = gerarChave();
  const pfxA = montarPfxBuffer({ senha: SENHA_OK, cnpj: CNPJ_A, keys });
  const pfxB = montarPfxBuffer({ senha: SENHA_OK, cnpj: CNPJ_B, keys });
  const pfxExpirado = montarPfxBuffer({
    senha: SENHA_OK,
    cnpj: CNPJ_A,
    keys,
    notBefore: new Date('2020-01-01T00:00:00Z'),
    notAfter: new Date('2021-01-01T00:00:00Z')
  });

  const db = await openDb();
  const empresas = await setupEmpresas(db);
  const deps = {
    db,
    pastaCertificados: certDir,
    pastaTemporaria: tmpDir
  };

  await test('1. PFX válido + senha correta → sucesso', async () => {
    const arquivo = gravarPfx(tmpDir, 'ok.pfx', pfxA);
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_OK,
      cnpjEmpresa: CNPJ_A,
      empresaId: empresas.a.id
    });
    assert.equal(r.ok, true);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.equal(r.sefazChamado, false);
    assert.equal(r.cnpjCertificado, CNPJ_A);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SENHA_OK));
  });

  await test('2. PFX válido + senha errada → falha SENHA_INVÁLIDA', async () => {
    const arquivo = gravarPfx(tmpDir, 'senha.pfx', pfxA);
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_ERRADA,
      cnpjEmpresa: CNPJ_A,
      preservarAnterior: true
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA);
    assert.equal(r.codigo, CODIGOS_CERTIFICADO_A1.SENHA_INVALIDA);
    assert.match(r.mensagem, /senha/i);
    assert.match(r.mensagem, /preservado/i);
    assert.doesNotMatch(r.mensagem, /PKCS#12 MAC/i);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SENHA_ERRADA));
  });

  await test('3. Arquivo inválido renomeado para .pfx → falha', async () => {
    const arquivo = path.join(tmpDir, 'falso.pfx');
    fs.writeFileSync(arquivo, 'isto-nao-e-pkcs12');
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_OK,
      cnpjEmpresa: CNPJ_A
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO);
    assert.doesNotMatch(r.mensagem, /senha informada não abre/i);
  });

  await test('4. Arquivo corrompido → falha', async () => {
    const arquivo = path.join(tmpDir, 'corrupto.pfx');
    fs.writeFileSync(arquivo, Buffer.concat([pfxA.slice(0, 40), Buffer.from('xxxx'), pfxA.slice(80)]));
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_OK,
      cnpjEmpresa: CNPJ_A
    });
    assert.equal(r.ok, false);
    assert.ok(
      r.estado === ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
      || r.estado === ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA
      || r.estado === ESTADOS_CERTIFICADO_A1.ERRO_DE_VALIDACAO
    );
  });

  await test('5. Certificado expirado → EXPIRADO', async () => {
    const arquivo = gravarPfx(tmpDir, 'expirado.pfx', pfxExpirado);
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_OK,
      cnpjEmpresa: CNPJ_A
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.EXPIRADO);
    assert.match(r.mensagem, /expirado/i);
  });

  await test('6. CNPJ divergente → bloqueio', async () => {
    const arquivo = gravarPfx(tmpDir, 'div.pfx', pfxB);
    const r = validarArquivoPfx({
      caminho: arquivo,
      senha: SENHA_OK,
      cnpjEmpresa: CNPJ_A
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE);
    assert.match(r.mensagem, /não corresponde/i);
  });

  let bytesAntes;
  await test('7. Upload inválido não substitui o certificado anterior', async () => {
    const tmpOk = gravarPfx(tmpDir, 'up-ok.pfx', pfxA);
    const ok = await substituirCertificadoEmpresa({
      empresaId: empresas.a.id,
      arquivoTmp: tmpOk,
      senha: SENHA_OK,
      deps
    });
    assert.equal(ok.ok, true);
    const destino = path.join(certDir, `certificado-empresa-${empresas.a.id}.pfx`);
    assert.equal(fs.existsSync(destino), true);
    bytesAntes = fs.readFileSync(destino);
    const tmpRuim = path.join(tmpDir, 'up-ruim.pfx');
    fs.writeFileSync(tmpRuim, 'nao-e-certificado');
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: empresas.a.id,
        arquivoTmp: tmpRuim,
        senha: SENHA_OK,
        deps
      }),
      (err) => err.estado === ESTADOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
        || err.code === CODIGOS_CERTIFICADO_A1.ARQUIVO_INVALIDO
    );
    const bytesDepois = fs.readFileSync(destino);
    assert.deepEqual(bytesDepois, bytesAntes);
    const dto = await obterConfiguracaoFiscalEmpresa(empresas.a.id, { db });
    assert.equal(dto.certificado_status, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.equal(dto.certificado_validado, true);
  });

  await test('8. Falha de persistência não deixa config apontando para arquivo ausente', async () => {
    const destino = path.join(certDir, `certificado-empresa-${empresas.a.id}.pfx`);
    const bytes = fs.readFileSync(destino);
    const tmpNovo = gravarPfx(tmpDir, 'up-novo.pfx', pfxA);
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: empresas.a.id,
        arquivoTmp: tmpNovo,
        senha: SENHA_OK,
        deps: {
          ...deps,
          salvarConfiguracaoFiscalEmpresa: async () => {
            throw Object.assign(new Error('falha persistencia'), { code: 'DB_FAIL' });
          }
        }
      }),
      (err) => /persistencia/i.test(err.message)
    );
    assert.equal(fs.existsSync(destino), true);
    assert.deepEqual(fs.readFileSync(destino), bytes);
    const dto = await obterConfiguracaoFiscalEmpresa(empresas.a.id, { db });
    assert.equal(dto.certificado_validado, true);
    assert.equal(fs.existsSync(dto.certificado_nome ? path.join(certDir, dto.certificado_nome) : destino), true);
  });

  await test('9. Teste temporário não persiste senha nem caminho', async () => {
    const tmp = gravarPfx(tmpDir, 'tmp-test.pfx', pfxB);
    const antes = await obterConfiguracaoFiscalEmpresa(empresas.b.id, { db });
    const r = await testarCertificadoEmpresa({
      empresaId: empresas.b.id,
      arquivoTmp: tmp,
      senha: SENHA_OK,
      deps
    });
    assert.equal(r.ok, true);
    assert.equal(r.persistido, false);
    assert.equal(r.origem, 'temporario');
    assert.equal(fs.existsSync(tmp), false);
    const depois = await obterConfiguracaoFiscalEmpresa(empresas.b.id, { db });
    assert.equal(depois.certificado_configurado, antes.certificado_configurado);
    assert.equal(depois.certificado_status, ESTADOS_CERTIFICADO_A1.NAO_CONFIGURADO);
    const blob = JSON.stringify(r);
    assert.doesNotMatch(blob, new RegExp(SENHA_OK));
    assert.doesNotMatch(blob, /certificado_senha/);
    assert.doesNotMatch(blob, /BEGIN CERTIFICATE/);
  });

  await test('10. Empresa A nunca usa o certificado da empresa B', async () => {
    const tmpB = gravarPfx(tmpDir, 'up-b.pfx', pfxB);
    await substituirCertificadoEmpresa({
      empresaId: empresas.b.id,
      arquivoTmp: tmpB,
      senha: SENHA_OK,
      deps
    });
    const destA = path.join(certDir, `certificado-empresa-${empresas.a.id}.pfx`);
    const destB = path.join(certDir, `certificado-empresa-${empresas.b.id}.pfx`);
    assert.ok(fs.existsSync(destA));
    assert.ok(fs.existsSync(destB));
    assert.notEqual(path.resolve(destA), path.resolve(destB));
    const dtoA = await obterConfiguracaoFiscalEmpresa(empresas.a.id, { db });
    const dtoB = await obterConfiguracaoFiscalEmpresa(empresas.b.id, { db });
    assert.notEqual(dtoA.certificado_nome, dtoB.certificado_nome);
    const testeA = await testarCertificadoEmpresa({ empresaId: empresas.a.id, deps });
    assert.equal(testeA.ok, true);
    assert.equal(testeA.cnpj_certificado, CNPJ_A);
    const testeB = await testarCertificadoEmpresa({ empresaId: empresas.b.id, deps });
    assert.equal(testeB.ok, true);
    assert.equal(testeB.cnpj_certificado, CNPJ_B);
  });

  await test('11. Empresa ausente → bloqueio sem fallback global', async () => {
    await assert.rejects(
      () => exigirEmpresaIdExplicito(null),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA
    );
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: null,
        arquivoTmp: gravarPfx(tmpDir, 'sem-emp.pfx', pfxA),
        senha: SENHA_OK,
        deps
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA
    );
    await assert.rejects(
      () => testarCertificadoEmpresa({ empresaId: 0, deps }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_OBRIGATORIA
    );
  });

  await test('12. Mensagens e logs não expõem senha nem conteúdo criptográfico', async () => {
    const arquivos = [
      'backend/services/fiscal/ValidarCertificadoA1Service.js',
      'backend/services/fiscal/CertificadoEmpresaService.js',
      'backend/rotas/fiscal.js',
      'frontend/erp/js/gestao-empresas-fiscal.js'
    ];
    for (const rel of arquivos) {
      const texto = src(rel);
      assert.doesNotMatch(texto, /console\.(log|error|info)\([^)]*senha[^)]*value/i);
    }
    const dto = await obterConfiguracaoFiscalEmpresa(empresas.a.id, { db });
    const json = JSON.stringify(dto);
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
    assert.doesNotMatch(json, new RegExp(SENHA_OK));
    assert.doesNotMatch(json, /BEGIN CERTIFICATE/);
  });

  await test('13. Teste não chama SEFAZ nem transmite eventos', async () => {
    const servico = src('backend/services/fiscal/ValidarCertificadoA1Service.js');
    assert.doesNotMatch(servico, /distribuicaoDFe|SoapTransport|consChNFe|210210/);
    const empresaSvc = src('backend/services/fiscal/CertificadoEmpresaService.js');
    assert.doesNotMatch(empresaSvc, /distribuicaoDFe|SoapTransport|autorizacaoTransmissaoSefaz/);
    const r = await testarCertificadoEmpresa({ empresaId: empresas.a.id, deps });
    assert.equal(r.sefaz_chamado, false);
  });

  await test('14. Interface mostra TESTAR CERTIFICADO, erro e sucesso sem falso positivo', async () => {
    const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
    assert.match(js, /TESTAR CERTIFICADO/);
    assert.match(js, /id="gef-testar-cert"/);
    assert.match(js, /urlCertificadoTestar/);
    assert.match(js, /Certificado válido\. Senha conferida\./);
    assert.match(js, /btnTest\.disabled = !!desabilitar/);
    assert.match(js, /if \(!res\.ok \|\| !data\.success \|\| !data\.ok\)/);
    assert.ok(!js.includes('CERTIFICADO DIGITAL CONFIGURADO COM SUCESSO'));
    assert.equal(G.urlCertificadoTestar(), '/api/fiscal/certificado/testar');
    const visaoValido = G.indicadorCertificadoVisual({
      certificado_configurado: true,
      certificado_validado: true,
      certificado_status: 'VÁLIDO',
      certificado_nome: 'certificado-empresa-1.pfx'
    });
    assert.equal(visaoValido.texto, 'VÁLIDO');
    const visaoCfg = G.indicadorCertificadoVisual({
      certificado_configurado: true,
      certificado_validado: false,
      certificado_status: 'CONFIGURADO_NÃO_VALIDADO'
    });
    assert.equal(visaoCfg.texto, 'CONFIGURADO, NÃO VALIDADO');
    const visaoNao = G.indicadorCertificadoVisual({ certificado_configurado: false });
    assert.equal(visaoNao.texto, 'NÃO CONFIGURADO');
  });

  await test('15. Teste do certificado salvo usa arquivo e empresa corretos', async () => {
    const r = await testarCertificadoEmpresa({ empresaId: empresas.a.id, deps });
    assert.equal(r.ok, true);
    assert.equal(r.origem, 'salvo');
    assert.equal(r.empresa_id, empresas.a.id);
    assert.equal(r.cnpj_certificado, CNPJ_A);
    assert.match(r.certificado_nome, new RegExp(`certificado-empresa-${empresas.a.id}\\.pfx`));
  });

  await test('Upload HTTP exige empresa_id e valida antes de unlink do destino (fonte)', async () => {
    const rotas = src('backend/rotas/fiscal.js');
    assert.match(rotas, /substituirCertificadoEmpresa/);
    assert.match(rotas, /testarCertificadoEmpresa/);
    assert.match(rotas, /router\.post\('\/certificado\/testar'/);
    assert.doesNotMatch(rotas, /if \(fs\.existsSync\(destino\)\) fs\.unlinkSync\(destino\)/);
    const diag = src('backend/motores/central-entradas/services/CentralDiagnosticoService.js');
    assert.match(diag, /CONFIGURADO_NÃO_VALIDADO|NÃO_CONFIGURADO/);
  });

  await closeDb(db);
  recusarOficial(isolamento.dbDir);
  isolamento.comprobarSeCarregado();

  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)\n`);
  if (falhou) process.exit(1);
}

function recusarOficial(alvo) {
  assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(String(alvo || '')), false);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
