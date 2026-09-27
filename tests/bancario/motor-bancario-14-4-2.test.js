/**
 * Sprint MBC-14.4.2 — persistência Client Secret entre requests/motores independentes.
 * Executar: node --test tests/bancario/motor-bancario-14-4-2.test.js
 * Nunca imprime Client Secret nem MBC_SECRET_STORE_KEY.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { ERROS } = require('../../backend/motores/bancario/contracts/constantes');
const {
  EncryptedLocalSecretStore,
  obterSecretStore
} = require('../../backend/motores/bancario/secrets/EncryptedLocalSecretStore');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { chaveSecretMercadoPago } = require('../../backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CLIENT_ID = 'APP-ID-PUBLICO-1442';

/** Valor de teste — não logar. */
const TEST_ENV_KEY = crypto.createHash('sha256').update('mbc-14-4-2-fixture').digest('hex');
const TEST_SECRET = 'client-secret-fixture-1442';

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
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function seedContaConfig(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  const motorSeed = obterMotorBancario({ db, secretStore: new MemorySecretStore() });
  const inst = await motorSeed.criarInstituicao({ nome: 'MP', codigo: '323' });
  const contaA = await motorSeed.criarConta({
    empresaId: empresaA.id,
    instituicao_financeira_id: inst.id,
    nome: 'CA',
    tipo: 'CORRENTE',
    numero: '1'
  });
  const cfgA = await motorSeed.criarConfiguracaoIntegracao({
    empresaId: empresaA.id,
    conta_bancaria_id: contaA.id,
    provider: 'OPEN_FINANCE_REAL',
    ambiente: 'SANDBOX'
  });
  return { empresaA, contaA, cfgA };
}

describe('MBC-14.4.2 persistência Client Secret', () => {
  let prevKey;

  before(() => {
    prevKey = process.env.MBC_SECRET_STORE_KEY;
  });

  after(() => {
    if (prevKey === undefined) delete process.env.MBC_SECRET_STORE_KEY;
    else process.env.MBC_SECRET_STORE_KEY = prevKey;
  });

  it('T01 — factory sem MemorySecretStore silencioso', () => {
    delete process.env.MBC_SECRET_STORE_KEY;
    assert.throws(
      () => obterSecretStore({}),
      (e) => e.code === ERROS.SECRET_KEY_AUSENTE && e.statusCode === 503
    );
    const js = src('backend/motores/bancario/secrets/EncryptedLocalSecretStore.js');
    assert.equal(/require\(['"]\.\/MemorySecretStore['"]\)/.test(js), false);
    assert.equal(/new\s+MemorySecretStore/.test(js), false);
  });

  it('T02 — sem chave: configurar Client Secret é rejeitado (sem falso sucesso)', async () => {
    delete process.env.MBC_SECRET_STORE_KEY;
    const db = await openDb();
    const { empresaA, cfgA } = await seedContaConfig(db);
    // Motor operacional sem store injetado (como server.js)
    const motorA = obterMotorBancario({ db });
    await assert.rejects(
      () => motorA.configurarCredenciaisMercadoPago({
        empresaId: empresaA.id,
        id: cfgA.id,
        client_id: CLIENT_ID,
        client_secret: TEST_SECRET,
        ambiente: 'SANDBOX'
      }),
      (e) => e.code === ERROS.SECRET_KEY_AUSENTE && e.statusCode === 503
    );
    const motorB = obterMotorBancario({ db });
    const st = await motorB.obterStatusCredenciaisIntegracao({ empresaId: empresaA.id, id: cfgA.id });
    assert.equal(st.secret_configurado, false);
    const row = await get(db, 'SELECT aplicacao_ref FROM config_integracao_bancaria WHERE id = ?', [cfgA.id]);
    assert.equal(row.aplicacao_ref == null || row.aplicacao_ref === '', true);
    const secrets = await all(db, 'SELECT chave FROM mbc_secret_store');
    assert.equal(secrets.length, 0);
    await closeDb(db);
  });

  it('T03 — com chave: REQUEST A salva e REQUEST B (motor novo) mantém secret_configurado', async () => {
    process.env.MBC_SECRET_STORE_KEY = TEST_ENV_KEY;
    const db = await openDb();
    const { empresaA, cfgA } = await seedContaConfig(db);

    const motorA = obterMotorBancario({ db });
    assert.ok(motorA.secretStore instanceof EncryptedLocalSecretStore);
    const outA = await motorA.configurarCredenciaisMercadoPago({
      empresaId: empresaA.id,
      id: cfgA.id,
      client_id: CLIENT_ID,
      client_secret: TEST_SECRET,
      ambiente: 'SANDBOX'
    });
    assert.equal(outA.secret_configurado, true);
    assert.equal(outA.client_id_configurado, true);
    assert.equal(outA.client_secret, undefined);

    // Descarta motorA — novo motor, sem compartilhar instância do store
    const motorB = obterMotorBancario({ db });
    assert.notEqual(motorA.secretStore, motorB.secretStore);
    assert.ok(motorB.secretStore instanceof EncryptedLocalSecretStore);
    const outB = await motorB.obterStatusCredenciaisIntegracao({ empresaId: empresaA.id, id: cfgA.id });
    assert.equal(outB.secret_configurado, true);
    assert.equal(outB.client_id, CLIENT_ID);
    assert.equal(outB.client_secret, undefined);

    const has = await motorB.secretStore.has(chaveSecretMercadoPago(cfgA.id));
    assert.equal(has, true);
    await closeDb(db);
  });

  it('T04 — Client Secret não vai para config SQLite nem GET público', async () => {
    process.env.MBC_SECRET_STORE_KEY = TEST_ENV_KEY;
    const db = await openDb();
    const { empresaA, cfgA } = await seedContaConfig(db);
    const motorA = obterMotorBancario({ db });
    await motorA.configurarCredenciaisMercadoPago({
      empresaId: empresaA.id,
      id: cfgA.id,
      client_id: CLIENT_ID,
      client_secret: TEST_SECRET
    });
    const rows = await all(db, 'SELECT * FROM config_integracao_bancaria WHERE id = ?', [cfgA.id]);
    const blob = JSON.stringify(rows);
    assert.equal(blob.includes(TEST_SECRET), false);
    assert.equal(rows[0].aplicacao_ref, CLIENT_ID);

    const st = await obterMotorBancario({ db }).obterStatusCredenciaisIntegracao({
      empresaId: empresaA.id,
      id: cfgA.id
    });
    assert.equal(st.secret_configurado, true);
    assert.equal('client_secret' in st, false);
    assert.equal(JSON.stringify(st).includes(TEST_SECRET), false);

    const storeJson = JSON.stringify(obterMotorBancario({ db }).secretStore);
    assert.equal(storeJson.includes(TEST_SECRET), false);
    assert.equal(storeJson.includes('[REDACTED]'), true);

    const secRows = await all(db, 'SELECT chave, ciphertext FROM mbc_secret_store');
    assert.equal(secRows.length, 1);
    assert.equal(secRows[0].chave, chaveSecretMercadoPago(cfgA.id));
    assert.equal(String(secRows[0].ciphertext).includes(TEST_SECRET), false);
    await closeDb(db);
  });

  it('T05 — MemorySecretStore só por injeção explícita', async () => {
    delete process.env.MBC_SECRET_STORE_KEY;
    const mem = new MemorySecretStore();
    const db = await openDb();
    await garantirSchemaBancarioAsync(db);
    const motor = obterMotorBancario({ db, secretStore: mem });
    assert.equal(motor.secretStore, mem);
    await mem.set('mbc.config.1', 'x');
    assert.equal(await mem.has('mbc.config.1'), true);
    await closeDb(db);
  });

  it('T06 — documentação e sprint', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.4.2-RELATORIO.md')));
    const rel = src('docs/bancario/MBC-14.4.2-RELATORIO.md');
    assert.match(rel, /MBC_SECRET_STORE_KEY/);
    assert.match(rel, /fail closed|FAIL CLOSED|fail-closed/i);
  });

  it('T07 — UI mantém máscara de pontos quando secret_configurado', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /MP_SECRET_MASK|aplicarCampoMpSecret/);
    assert.match(js, /isMpSecretMascara/);
    assert.match(js, /data-mbc-secret-mascarado/);
    assert.doesNotMatch(js, /localStorage\.setItem\([^)]*mbcMpSecret/);
  });

  it('T08 — bootstrap local gera chave em arquivo sem logar valor', () => {
    const { garantirMbcSecretStoreKey, NOME_ARQUIVO } = require('../../backend/motores/bancario/secrets/garantirMbcSecretStoreKey');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mbc-key-'));
    const prev = process.env.MBC_SECRET_STORE_KEY;
    delete process.env.MBC_SECRET_STORE_KEY;
    try {
      const r1 = garantirMbcSecretStoreKey({ dir });
      assert.equal(r1.ok, true);
      assert.ok(r1.origem === 'gerado' || r1.origem === 'arquivo');
      assert.ok(process.env.MBC_SECRET_STORE_KEY);
      const valor1 = process.env.MBC_SECRET_STORE_KEY;
      delete process.env.MBC_SECRET_STORE_KEY;
      const r2 = garantirMbcSecretStoreKey({ dir });
      assert.equal(r2.ok, true);
      assert.equal(r2.origem, 'arquivo');
      assert.equal(process.env.MBC_SECRET_STORE_KEY, valor1);
      assert.ok(fs.existsSync(path.join(dir, NOME_ARQUIVO)));
      const srcBoot = src('backend/motores/bancario/secrets/garantirMbcSecretStoreKey.js');
      assert.doesNotMatch(srcBoot, /console\.log\([^)]*MBC_SECRET/);
    } finally {
      if (prev === undefined) delete process.env.MBC_SECRET_STORE_KEY;
      else process.env.MBC_SECRET_STORE_KEY = prev;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });
});
