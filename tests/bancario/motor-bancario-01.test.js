/**
 * Sprint MBC-01 — fundação do Motor Bancário (sem Open Finance).
 * Executar: node --test tests/bancario/motor-bancario-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const {
  obterMotorBancario,
  CONTRATO,
  chaveIdempotencia,
  normalizarTransacao,
  resolverEmpresaIdParaBancario,
  ERROS
} = require('../../backend/motores/bancario');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, valor REAL, empresa_id INTEGER
  )`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  return {
    db,
    empresaA,
    empresaB,
    depsMulti: {
      db,
      obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
    }
  };
}

describe('MBC-01 fundação', () => {
  it('T01 — módulo pode ser carregado', () => {
    const motor = obterMotorBancario();
    assert.equal(motor.versao.CODIGO, 'MBC-01');
    assert.ok(Array.isArray(motor.contrato));
  });

  it('T06 — contrato do motor está disponível', () => {
    assert.ok(CONTRATO.includes('listarContas'));
    assert.ok(CONTRATO.includes('listarTransacoes'));
    assert.ok(CONTRATO.includes('importarTransacoes'));
    assert.ok(CONTRATO.includes('conciliarTransacao'));
    const motor = obterMotorBancario();
    assert.equal(typeof motor.listarContas, 'function');
    assert.equal(typeof motor.importarTransacoes, 'function');
  });

  it('T02 — contexto empresarial é obrigatório', () => {
    const motor = obterMotorBancario();
    assert.throws(() => motor.listarContas({}), (err) => err.code === ERROS.EMPRESA_OBRIGATORIA);
    assert.throws(() => motor.exigirEmpresaId(null), (err) => err.code === ERROS.EMPRESA_OBRIGATORIA);
    assert.throws(() => motor.exigirEmpresaId(0), (err) => err.code === ERROS.EMPRESA_OBRIGATORIA);
  });

  it('T03 — empresa não pode ser inferida de usuário', async () => {
    const ctx = await setup();
    try {
      await resolverEmpresaIdParaBancario(
        { user: { id: 1 } },
        ctx.depsMulti
      );
      assert.fail('deveria exigir empresa do contexto');
    } catch (err) {
      assert.ok(err.code);
      assert.notEqual(err.code, undefined);
      assert.ok(err.statusCode === 400 || err.statusCode === 403 || err.code.includes('EMPRESA'));
    }
    await closeDb(ctx.db);
  });

  it('T04 — usuário autorizado pode acessar contexto', async () => {
    const ctx = await setup();
    const resolved = await resolverEmpresaIdParaBancario(
      { user: { id: 1 }, empresaId: ctx.empresaA.id },
      ctx.depsMulti
    );
    assert.equal(resolved.empresaId, ctx.empresaA.id);
    await closeDb(ctx.db);
  });

  it('T05 — usuário não autorizado é bloqueado', async () => {
    const ctx = await setup();
    try {
      await resolverEmpresaIdParaBancario(
        { user: { id: 2 }, empresaId: ctx.empresaB.id },
        ctx.depsMulti
      );
      assert.fail('esperado 403');
    } catch (err) {
      assert.equal(err.code, 'EMPRESA_NAO_AUTORIZADA');
    }
    await closeDb(ctx.db);
  });

  it('T07 — importar não gera duplicação financeira', async () => {
    const ctx = await setup();
    const motor = obterMotorBancario({ db: ctx.db });
    const antes = await new Promise((resolve, reject) => {
      ctx.db.get('SELECT COUNT(*) AS n FROM financeiro', [], (e, row) => (e ? reject(e) : resolve(row.n)));
    });
    assert.throws(
      () => motor.importarTransacoes({ empresaId: ctx.empresaA.id }),
      (err) => err.code === ERROS.SINCRONIZACAO_FORA_ESCOPO
    );
    const depois = await new Promise((resolve, reject) => {
      ctx.db.get('SELECT COUNT(*) AS n FROM financeiro', [], (e, row) => (e ? reject(e) : resolve(row.n)));
    });
    assert.equal(depois, antes);
    assert.equal(depois, 0);
    const srcMotor = src('backend/motores/bancario/MotorBancarioService.js');
    assert.doesNotMatch(srcMotor, /INSERT INTO financeiro/i);
    await closeDb(ctx.db);
  });

  it('T08 — transação possui ownership empresarial definido', () => {
    const dto = normalizarTransacao({
      empresaId: 7,
      accountId: 3,
      date: '2026-09-01',
      amount: 100,
      direction: 'entrada',
      description: 'PIX'
    });
    assert.equal(dto.empresa_id, 7);
    assert.equal(dto.conta_bancaria_id, 3);
    assert.throws(
      () => normalizarTransacao({ accountId: 1, amount: 1, direction: 'entrada' }),
      (err) => err.code === ERROS.EMPRESA_OBRIGATORIA
    );
  });

  it('T09 — identificador externo pode ser representado', () => {
    const dto = normalizarTransacao({
      empresa_id: 1,
      conta_bancaria_id: 2,
      amount: 50,
      direction: 'saida',
      externalId: 'E2E123',
      externalSource: 'open_finance:ispb:123'
    });
    assert.equal(dto.external_id, 'E2E123');
    assert.equal(dto.external_source, 'open_finance:ispb:123');
  });

  it('T10 — estrutura preparada para idempotência', () => {
    const k = chaveIdempotencia({
      empresaId: 4,
      contaBancariaId: 9,
      externalSource: 'of:banco-x',
      externalId: 'tx-1'
    });
    assert.equal(k, '4|9|of:banco-x|tx-1');
    const semId = chaveIdempotencia({ empresaId: 4, contaBancariaId: 9, externalSource: 'of:banco-x' });
    assert.equal(semId, null);
  });

  it('fundação não cria Open Finance', () => {
    const idx = src('backend/motores/bancario/index.js');
    assert.match(idx, /MBC-01/);
    assert.doesNotMatch(src('backend/motores/bancario/MotorBancarioService.js'), /oauth/i);
    assert.doesNotMatch(src('backend/rotas/bancario.js'), /oauth/i);
  });
});
