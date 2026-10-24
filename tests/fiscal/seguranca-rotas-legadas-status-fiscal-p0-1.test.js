/**
 * P0.1 — Segurança das rotas legadas e consistência do status fiscal.
 * Banco temp. PFX sintéticos. Sem SEFAZ. Sem banco oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/fiscal/seguranca-rotas-legadas-status-fiscal-p0-1.test.js
 */
'use strict';

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-fiscal-p01-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const forge = require('node-forge');

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const {
  garantirSchemaFiscalEmpresaAsync,
  obterConfiguracaoFiscalEmpresa,
  salvarConfiguracaoFiscalEmpresa,
  dtoPublicoConfiguracao
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const {
  substituirCertificadoEmpresa,
  testarCertificadoEmpresa,
  resolverCaminhoCertificadoEmpresaSeguro,
  autorizarOperacaoCertificadoEmpresa,
  rejeitarCaminhoCliente,
  caminhoDestinoEmpresa
} = require('../../backend/services/fiscal/CertificadoEmpresaService');
const { ESTADOS_CERTIFICADO_A1, CODIGOS_CERTIFICADO_A1 } = require('../../backend/services/fiscal/certificadoEstados');
const CentralConfiguracaoService = require('../../backend/motores/central-entradas/services/CentralConfiguracaoService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const SENHA_OK = 'SenhaP01#ok';
const SENHA_ERR = 'SenhaP01#err';
const ROOT = path.join(__dirname, '../..');

let passou = 0;
let falhou = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((error) => {
      falhou += 1;
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

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function gerarPfx({ senha, cnpj, notAfter }) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 512, workers: -1 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = notAfter || new Date('2035-01-01T00:00:00Z');
  const attrs = [
    { name: 'commonName', value: `Emp ${cnpj}` },
    { type: '2.16.76.1.3.3', value: cnpj }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12Asn1).getBytes(), 'binary');
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaFiscalEmpresaAsync(db);
  await run(db, `CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY, username TEXT, role TEXT, perfil TEXT
  )`);
  await run(db, `INSERT INTO usuarios (id, username, role, perfil) VALUES (10, 'op', 'user', 'USUARIO')`);
  await run(db, `INSERT INTO usuarios (id, username, role, perfil) VALUES (1, 'admin', 'admin', 'SUPER_ADMIN')`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Emp A P01' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Emp B P01' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(10, a.id, { db });
  return { db, a, b };
}

async function main() {
  console.log('\n=== P0.1 Segurança rotas legadas / status fiscal ===\n');
  isolamento.comprobarSeCarregado();
  assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(isolamento.dbDir), false);

  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p01-certs-'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p01-tmp-'));
  const { db, a, b } = await setup();
  const deps = { db, pastaCertificados: certDir, pastaTemporaria: tmpDir };
  const pfxA = gerarPfx({ senha: SENHA_OK, cnpj: CNPJ_A });
  const pfxB = gerarPfx({ senha: SENHA_OK, cnpj: CNPJ_B });
  const pfxExp = gerarPfx({
    senha: SENHA_OK,
    cnpj: CNPJ_A,
    notAfter: new Date('2021-06-01T00:00:00Z')
  });

  await test('1. Rota legada rejeita caminho absoluto no body (fonte + serviço)', async () => {
    const rotas = src('backend/rotas/fiscal.js');
    assert.match(rotas, /rejeitarCaminhoCliente/);
    assert.match(rotas, /config\/certificado\/testar/);
    assert.doesNotMatch(rotas, /carregarCertificadoPfx\(certificadoPath/);
    assert.throws(
      () => rejeitarCaminhoCliente({ certificadoPath: 'C:\\Windows\\secret.pfx', empresa_id: a.id }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    assert.throws(
      () => rejeitarCaminhoCliente({ path: '/etc/passwd', empresa_id: a.id }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
  });

  await test('2. Rota rejeita traversal ../', async () => {
    assert.throws(
      () => resolverCaminhoCertificadoEmpresaSeguro(a.id, path.join(certDir, '..', 'fora.pfx'), deps),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
    assert.throws(
      () => resolverCaminhoCertificadoEmpresaSeguro(a.id, `${certDir}/../outro/certificado-empresa-${a.id}.pfx`, deps),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
        || err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
  });

  await test('3. Rota rejeita certificado fora do diretório protegido', async () => {
    const fora = path.join(os.tmpdir(), `certificado-empresa-${a.id}.pfx`);
    fs.writeFileSync(fora, pfxA);
    assert.throws(
      () => resolverCaminhoCertificadoEmpresaSeguro(a.id, fora, deps),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
  });

  await test('4. Rota não aceita certificado de outra empresa (nome/path)', async () => {
    const destB = caminhoDestinoEmpresa(b.id, deps);
    fs.writeFileSync(destB, pfxB);
    assert.throws(
      () => resolverCaminhoCertificadoEmpresaSeguro(a.id, destB, deps),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
  });

  await test('5. Empresa ausente é bloqueada', async () => {
    await assert.rejects(
      () => testarCertificadoEmpresa({ empresaId: 99999, deps }),
      (err) => err.code === 'EMPRESA_NAO_ENCONTRADA' || err.statusCode === 404
    );
  });

  await test('6. Empresa não autorizada é bloqueada', async () => {
    await assert.rejects(
      () => autorizarOperacaoCertificadoEmpresa(
        { id: 10, perfil: 'USUARIO', role: 'user' },
        b.id,
        deps
      ),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.EMPRESA_NAO_AUTORIZADA
    );
  });

  await test('7. Empresa A não valida certificado da B alterando ID/path', async () => {
    const tmpA = path.join(tmpDir, 'a.pfx');
    fs.writeFileSync(tmpA, pfxA);
    await substituirCertificadoEmpresa({
      empresaId: a.id,
      arquivoTmp: tmpA,
      senha: SENHA_OK,
      deps
    });
    const tmpB = path.join(tmpDir, 'b.pfx');
    fs.writeFileSync(tmpB, pfxB);
    await substituirCertificadoEmpresa({
      empresaId: b.id,
      arquivoTmp: tmpB,
      senha: SENHA_OK,
      deps
    });
    const rA = await testarCertificadoEmpresa({ empresaId: a.id, deps });
    assert.equal(rA.cnpj_certificado, CNPJ_A);
    assert.equal(rA.empresa_id, a.id);
    assert.match(rA.certificado_nome, new RegExp(`certificado-empresa-${a.id}`));
    await assert.rejects(
      () => testarCertificadoEmpresa({
        empresaId: a.id,
        body: { certificado_path: caminhoDestinoEmpresa(b.id, deps) },
        deps
      }),
      (err) => err.code === CODIGOS_CERTIFICADO_A1.CAMINHO_NEGADO
    );
  });

  await test('8. Nenhuma rota MULTIEMPRESA usa fallback global (fonte)', async () => {
    const rotas = src('backend/rotas/fiscal.js');
    assert.doesNotMatch(rotas, /certificado\.pfx['"]/);
    assert.doesNotMatch(rotas, /fiscal_certificado_path/);
    assert.match(rotas, /EMPRESA_OBRIGATORIA|empresa_id/);
    const diag = src('backend/motores/central-entradas/services/CentralDiagnosticoService.js');
    assert.match(diag, /EMPRESA_OBRIGATORIA/);
    assert.doesNotMatch(diag, /validarArquivoPfx\(\{\s*caminho: ctx\.certificadoPath/);
  });

  await test('9. Certificado antigo sem snapshot → CONFIGURADO_NÃO_VALIDADO', async () => {
    await salvarConfiguracaoFiscalEmpresa(a.id, {
      ambiente: 2,
      serie: 1,
      token_csc: 'CSC',
      id_csc: '1',
      certificado_path: caminhoDestinoEmpresa(a.id, deps),
      certificado_senha: SENHA_OK,
      ws_autorizacao_homologacao: 'https://h.local/a'
    }, { db, pastaCertificados: certDir });
    // Simula legado pré-P0: path+senha sem colunas de validação.
    await run(db, `UPDATE empresas_configuracao_fiscal SET
      certificado_validacao_status = NULL,
      certificado_validacao_em = NULL,
      certificado_validade_ate = NULL,
      certificado_cnpj = NULL,
      certificado_titular = NULL,
      certificado_validacao_codigo = NULL,
      certificado_validacao_mensagem = NULL
      WHERE empresa_id = ?`, [a.id]);
    const dto = await obterConfiguracaoFiscalEmpresa(a.id, { db });
    assert.equal(dto.certificado_configurado, true);
    assert.equal(dto.certificado_validado, false);
    assert.equal(dto.certificado_status, ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO);
    assert.equal(dto.apto_certificado_criptografico, false);
    assert.equal(dto.status, 'PRONTA');
  });

  await test('10. Path+senha não produzem validade criptográfica por inferência', async () => {
    const dto = dtoPublicoConfiguracao(
      { id: 99, cnpj: CNPJ_A, razao_social: 'X', ativo: 1 },
      {
        ambiente: 2,
        serie: 1,
        token_csc: 'x',
        id_csc: '1',
        certificado_path: 'C:/certs/certificado-empresa-99.pfx',
        certificado_senha: 'secreta',
        ws_autorizacao: 'https://x'
      }
    );
    assert.equal(dto.certificado_configurado, true);
    assert.equal(dto.certificado_validado, false);
    assert.equal(dto.apto_certificado_criptografico, false);
    assert.equal(dto.certificado_status, ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO);
    assert.equal(dto.status, 'PRONTA');
    assert.doesNotMatch(JSON.stringify(dto), /secreta/);
  });

  await test('11. Certificado substituído invalida snapshot até nova validação', async () => {
    const tmp1 = path.join(tmpDir, 'sub1.pfx');
    fs.writeFileSync(tmp1, pfxA);
    await substituirCertificadoEmpresa({
      empresaId: a.id,
      arquivoTmp: tmp1,
      senha: SENHA_OK,
      deps
    });
    let dto = await obterConfiguracaoFiscalEmpresa(a.id, { db });
    assert.equal(dto.certificado_validado, true);
    await salvarConfiguracaoFiscalEmpresa(a.id, {
      certificado_senha: 'nova-senha-ainda-nao-validada'
    }, { db });
    dto = await obterConfiguracaoFiscalEmpresa(a.id, { db });
    assert.equal(dto.certificado_status, ESTADOS_CERTIFICADO_A1.CONFIGURADO_NAO_VALIDADO);
    assert.equal(dto.certificado_validado, false);
  });

  await test('12. Certificado válido produz estado coerente', async () => {
    const tmp = path.join(tmpDir, 'ok.pfx');
    fs.writeFileSync(tmp, pfxA);
    const r = await substituirCertificadoEmpresa({
      empresaId: a.id,
      arquivoTmp: tmp,
      senha: SENHA_OK,
      deps
    });
    assert.equal(r.ok, true);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.VALIDO);
    const dto = await obterConfiguracaoFiscalEmpresa(a.id, { db });
    assert.equal(dto.certificado_validado, true);
    assert.equal(dto.apto_certificado_criptografico, true);
    assert.equal(dto.certificado_status, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.equal(dto.certificado_estado_configuracao, 'CONFIGURADO');
  });

  await test('13. Senha errada permanece inválida', async () => {
    const r = await testarCertificadoEmpresa({
      empresaId: a.id,
      senha: SENHA_ERR,
      deps
    });
    assert.equal(r.ok, false);
    assert.equal(r.estado, ESTADOS_CERTIFICADO_A1.SENHA_INVALIDA);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(SENHA_ERR));
  });

  await test('14. Certificado expirado identificado', async () => {
    const tmp = path.join(tmpDir, 'exp.pfx');
    fs.writeFileSync(tmp, pfxExp);
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: a.id,
        arquivoTmp: tmp,
        senha: SENHA_OK,
        deps
      }),
      (err) => err.estado === ESTADOS_CERTIFICADO_A1.EXPIRADO
    );
  });

  await test('15. CNPJ divergente bloqueado', async () => {
    const tmp = path.join(tmpDir, 'div.pfx');
    fs.writeFileSync(tmp, pfxB);
    await assert.rejects(
      () => substituirCertificadoEmpresa({
        empresaId: a.id,
        arquivoTmp: tmp,
        senha: SENHA_OK,
        deps
      }),
      (err) => err.estado === ESTADOS_CERTIFICADO_A1.CNPJ_DIVERGENTE
    );
  });

  await test('16. Diagnóstico não faz leitura criptográfica a cada refresh', async () => {
    const fonte = src('backend/motores/central-entradas/services/CentralConfiguracaoService.js');
    assert.match(fonte, /certificadoValidacaoStatus|CONFIGURADO_NÃO_VALIDADO/);
    assert.doesNotMatch(fonte, /this\._carregarCertificado\(certificadoPath/);
    const svc = new CentralConfiguracaoService({
      carregarCertificado: () => {
        throw new Error('não deveria abrir PFX no refresh');
      }
    });
    const visao = await svc._montarVisaoCertificado({
      certificadoPath: caminhoDestinoEmpresa(a.id, deps),
      certificadoSenha: SENHA_OK,
      certificadoValidacaoStatus: ESTADOS_CERTIFICADO_A1.VALIDO,
      certificadoValidadeAte: '2035-01-01T00:00:00.000Z',
      certificadoTitular: 'Emp',
      cnpj: CNPJ_A
    });
    assert.equal(visao.status, ESTADOS_CERTIFICADO_A1.VALIDO);
    assert.equal(visao.presente, true);
  });

  await test('17. Nenhum teste transmite SEFAZ/manifestação', async () => {
    const arquivos = [
      'backend/services/fiscal/CertificadoEmpresaService.js',
      'backend/services/fiscal/ValidarCertificadoA1Service.js',
      'backend/rotas/fiscal.js'
    ];
    for (const rel of arquivos) {
      const t = src(rel);
      assert.doesNotMatch(t, /distribuicaoDFe|SoapTransport|210210|consChNFe/);
    }
  });

  await test('18. Senha/PFX não aparecem em DTO/resposta/logs de contrato', async () => {
    const dto = await obterConfiguracaoFiscalEmpresa(a.id, { db });
    const json = JSON.stringify(dto);
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
    assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
    assert.doesNotMatch(json, new RegExp(SENHA_OK));
    assert.doesNotMatch(json, /BEGIN CERTIFICATE/);
    const ui = src('frontend/erp/js/fiscal.js');
    assert.match(ui, /empresa_id/);
    assert.doesNotMatch(ui, /certificadoPath,\s*senha/);
    assert.match(ui, /resolverEmpresaIdCertificadoFiscal/);
  });

  await test('Admin pode operar; usuário sem vínculo na A autorizado; B bloqueado', async () => {
    const admin = await autorizarOperacaoCertificadoEmpresa(
      { id: 1, perfil: 'SUPER_ADMIN', role: 'admin' },
      b.id,
      deps
    );
    assert.equal(admin.admin, true);
    const opA = await autorizarOperacaoCertificadoEmpresa(
      { id: 10, perfil: 'USUARIO', role: 'user' },
      a.id,
      deps
    );
    assert.equal(opA.admin, false);
  });

  await closeDb(db);
  isolamento.comprobarSeCarregado();
  console.log(`\nResultado: ${passou} ok, ${falhou} falha(s)\n`);
  if (falhou) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
