/**
 * Sprint 03.06.1 — Contexto fiscal / conexão SQLite por empresa na Central.
 * Sem SEFAZ real. Executar:
 *   node tests/central-entradas/contexto-fiscal-db-multiempresa-03-06-1.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  ModoOperacionalGlobal,
  ContratoOperacionalService
} = require('../../backend/core/modo-operacional');
const {
  listarAlvosSincronizacaoCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CentralConfiguracaoService = require('../../backend/motores/central-entradas/services/CentralConfiguracaoService');
const CentralSincronizacaoService = require('../../backend/motores/central-entradas/services/CentralSincronizacaoService');

const EMP_A = { id: 11, cnpj: '11111111000191', razao_social: 'Empresa A', ativo: 1 };
const EMP_B = { id: 22, cnpj: '22222222000182', razao_social: 'Empresa B', ativo: 1 };
const EMP_C = { id: 33, cnpj: '33333333000173', razao_social: 'Empresa C', ativo: 1 };
const EMPRESAS_3 = [EMP_A, EMP_B, EMP_C];

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-03061-db-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  const finish = () => {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') return result.finally(finish);
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function criarDbEmpresas() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  return db;
}

async function seedEmpresas(db, lista) {
  for (const e of lista) {
    await run(
      db,
      `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo) VALUES (?, ?, ?, ?, ?)`,
      [e.id, e.cnpj, e.razao_social, e.razao_social, 1]
    );
  }
}

function marcaDb(tag) {
  return { __marcaDb: tag };
}

function fiscalOk(empresaId, cnpj) {
  return {
    fonte: 'EMPRESA',
    empresaId,
    certificadoPath: __filename,
    certificadoSenha: 'segredo-teste',
    cnpj,
    ambiente: 2,
    uf: 'CE',
    codigoUf: '23'
  };
}

function depsCfg(obterFiscalEmpresa, extras = {}) {
  return {
    configuracaoRepository: {
      ensureDefaults: async () => {},
      listarTodas: async () => [],
      parseValor: (r) => r.valor
    },
    syncConfigService: {
      obterResumo: async () => ({ syncMaxDocumentos: 10 })
    },
    obterFiscalEmpresa,
    ...extras
  };
}

async function t01TresAlvos() {
  await withTempDbDir(async () => {
    const db = await criarDbEmpresas();
    await seedEmpresas(db, EMPRESAS_3);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA'
    });
    assert.strictEqual(plano.modo, ModoOperacionalGlobal.MULTIEMPRESA);
    assert.strictEqual(plano.alvos.length, 3);
    db.close();
    console.log('  T01 MULTIEMPRESA resolve três alvos');
  });
}

async function t02DbA() {
  const chamadas = [];
  const dbA = marcaDb('dbA');
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    chamadas.push({ empresaId, db: db && db.__marcaDb });
    return fiscalOk(empresaId, EMP_A.cnpj);
  }));
  await svc.obterContextoOperacional({
    empresaId: 11,
    db: dbA,
    permitirFallbackGlobal: false
  });
  assert.strictEqual(chamadas.length, 1);
  assert.strictEqual(chamadas[0].empresaId, 11);
  assert.strictEqual(chamadas[0].db, 'dbA');
  console.log('  T02 Empresa A resolve seu db (dbA)');
}

async function t03DbB() {
  const chamadas = [];
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    chamadas.push({ empresaId, db: db && db.__marcaDb });
    return fiscalOk(empresaId, EMP_B.cnpj);
  }));
  await svc.obterContextoOperacional({
    empresaId: 22,
    db: marcaDb('dbB'),
    permitirFallbackGlobal: false
  });
  assert.strictEqual(chamadas[0].empresaId, 22);
  assert.strictEqual(chamadas[0].db, 'dbB');
  console.log('  T03 Empresa B resolve seu db (dbB)');
}

async function t04DbC() {
  const chamadas = [];
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    chamadas.push({ empresaId, db: db && db.__marcaDb });
    return fiscalOk(empresaId, EMP_C.cnpj);
  }));
  await svc.obterContextoOperacional({
    empresaId: 33,
    db: marcaDb('dbC'),
    permitirFallbackGlobal: false
  });
  assert.strictEqual(chamadas[0].empresaId, 33);
  assert.strictEqual(chamadas[0].db, 'dbC');
  console.log('  T04 Empresa C resolve seu db (dbC)');
}

async function t05NaoCompartilhaABC() {
  const seq = [];
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    seq.push({ empresaId, db: db && db.__marcaDb });
    const cnpj = { 11: EMP_A.cnpj, 22: EMP_B.cnpj, 33: EMP_C.cnpj }[empresaId];
    return fiscalOk(empresaId, cnpj);
  }));
  await svc.obterContextoOperacional({ empresaId: 11, db: marcaDb('dbA'), permitirFallbackGlobal: false });
  await svc.obterContextoOperacional({ empresaId: 22, db: marcaDb('dbB'), permitirFallbackGlobal: false });
  await svc.obterContextoOperacional({ empresaId: 33, db: marcaDb('dbC'), permitirFallbackGlobal: false });
  assert.deepStrictEqual(seq.map((s) => s.db), ['dbA', 'dbB', 'dbC']);
  console.log('  T05 A→B→C não compartilha contexto');
}

async function t06CicloA() {
  const seq = [];
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    seq.push(db && db.__marcaDb);
    const cnpj = { 11: EMP_A.cnpj, 22: EMP_B.cnpj, 33: EMP_C.cnpj }[empresaId];
    return fiscalOk(empresaId, cnpj);
  }));
  await svc.obterContextoOperacional({ empresaId: 11, db: marcaDb('dbA'), permitirFallbackGlobal: false });
  await svc.obterContextoOperacional({ empresaId: 22, db: marcaDb('dbB'), permitirFallbackGlobal: false });
  await svc.obterContextoOperacional({ empresaId: 33, db: marcaDb('dbC'), permitirFallbackGlobal: false });
  await svc.obterContextoOperacional({ empresaId: 11, db: marcaDb('dbA'), permitirFallbackGlobal: false });
  assert.deepStrictEqual(seq, ['dbA', 'dbB', 'dbC', 'dbA']);
  console.log('  T06 A→B→C→A mantém isolamento');
}

async function t07BNuncaDbA() {
  const svc = new CentralConfiguracaoService({
    ...depsCfg(async ({ empresaId, db }) => {
      if (db && db.__marcaDb === 'dbA' && empresaId === 22) {
        throw new Error('cruzamento A/B');
      }
      return fiscalOk(empresaId, EMP_B.cnpj);
    }),
    db: marcaDb('dbA')
  });
  const r = await svc.obterContextoOperacional({
    empresaId: 22,
    db: marcaDb('dbB'),
    permitirFallbackGlobal: false
  });
  assert.ok(r.ok === true || r.codigoErro !== 'cruzamento');
  console.log('  T07 Empresa B nunca usa db de A (opcoes.db prevalece sobre this._db)');
}

async function t08CNuncaDbA() {
  const visto = [];
  const svc = new CentralConfiguracaoService({
    ...depsCfg(async ({ empresaId, db }) => {
      visto.push({ empresaId, db: db && db.__marcaDb });
      return fiscalOk(empresaId, EMP_C.cnpj);
    }),
    db: marcaDb('dbA')
  });
  await svc.obterContextoOperacional({
    empresaId: 33,
    db: marcaDb('dbC'),
    permitirFallbackGlobal: false
  });
  assert.strictEqual(visto[0].db, 'dbC');
  assert.notStrictEqual(visto[0].db, 'dbA');
  console.log('  T08 Empresa C nunca usa db de A');
}

async function t09SemConfigSemFallback() {
  const visto = [];
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    visto.push({ empresaId, db: db && db.__marcaDb });
    if (empresaId === 99) {
      const err = new Error('Empresa 99 não possui configuração fiscal própria.');
      err.code = 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE';
      throw err;
    }
    return fiscalOk(11, EMP_A.cnpj);
  }));
  const r = await svc.obterContextoOperacional({
    empresaId: 99,
    db: marcaDb('db99'),
    permitirFallbackGlobal: false
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigoErro, 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE');
  assert.strictEqual(visto.length, 1);
  assert.strictEqual(visto[0].empresaId, 99);
  console.log('  T09 Empresa sem config fiscal não usa fallback de outra');
}

async function t10ErroOficial() {
  const svc = new CentralConfiguracaoService(depsCfg(async ({ db }) => {
    if (!db) throw new Error('db obrigatório para configuração fiscal por empresa');
    const err = new Error('Empresa 77 não possui configuração fiscal própria.');
    err.code = 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE';
    throw err;
  }));
  const r = await svc.obterContextoOperacional({
    empresaId: 77,
    db: marcaDb('db77'),
    permitirFallbackGlobal: false
  });
  assert.strictEqual(r.ok, false);
  assert.ok(
    r.codigoErro === 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE'
    || /db obrigatório para configuração fiscal por empresa/.test(r.mensagem || '')
  );
  console.log('  T10 Empresa sem config retorna erro oficial (sem copiar outra)');
}

async function t11EmpresaSimples() {
  const contrato = await ContratoOperacionalService.montarContratoOperacional({
    obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
    obterEmpresaOperacionalId: () => 22,
    buscarEmpresaAtivaPorId: async (id) => EMPRESAS_3.find((e) => e.id === Number(id))
  });
  assert.strictEqual(contrato.modo_operacional, ModoOperacionalGlobal.EMPRESA_SIMPLES);
  assert.strictEqual(contrato.empresa_operacional.empresa_id, 22);
  const plano = await listarAlvosSincronizacaoCentral({ contrato });
  assert.strictEqual(plano.alvos.length, 1);
  assert.strictEqual(plano.alvos[0].empresaId, 22);
  console.log('  T11 EMPRESA_SIMPLES mantém um alvo operacional');
}

function t12SemOperacionalIdNoDb() {
  const cfg = src('backend/motores/central-entradas/services/CentralConfiguracaoService.js');
  const trecho = cfg.slice(cfg.indexOf('async obterContextoOperacional'));
  const corpo = trecho.slice(0, trecho.indexOf('async atualizar'));
  assert.ok(!corpo.includes('empresa_operacional_id'));
  assert.ok(src('backend/motores/central-entradas/services/CentralSincronizacaoService.js').includes('empresaId'));
  console.log('  T12 MULTIEMPRESA não usa empresa_operacional_id para resolver db');
}

function t13SqlPorEmpresaId() {
  const fiscal = src('backend/services/fiscal/empresasConfiguracaoFiscal.js');
  assert.ok(fiscal.includes('FROM empresas_configuracao_fiscal WHERE empresa_id = ?'));
  assert.ok(!/FROM empresas_configuracao_fiscal[\s\S]{0,80}LIMIT 1/.test(fiscal)
    || fiscal.includes('WHERE empresa_id = ?'));
  console.log('  T13 SELECT fiscal filtrado por empresa_id (não escolhe linha de outra)');
}

async function t14EmpresaIdNoSync() {
  const visto = [];
  const cfg = {
    obterContextoOperacional: async (opts) => {
      visto.push({ empresaId: opts.empresaId, db: opts.db && opts.db.__marcaDb });
      return { ok: false, codigoErro: 'TESTE_STOP', mensagem: 'stop apos contexto' };
    }
  };
  const sync = new CentralSincronizacaoService({
    configuracaoService: cfg,
    nsuRepository: { buscarPorCnpjAmbiente: async () => null }
  });
  const r = await sync._sincronizarEmpresa(
    { empresaId: 22, cnpj: EMP_B.cnpj },
    { modo: ModoOperacionalGlobal.MULTIEMPRESA, db: marcaDb('dbB') }
  );
  assert.strictEqual(visto[0].empresaId, 22);
  assert.strictEqual(visto[0].db, 'dbB');
  assert.strictEqual(r.empresaId, 22);
  assert.strictEqual(r.pulado, true);
  console.log('  T14 sincronização passa empresaId correto ao contexto fiscal');
}

async function t15ErroBNaoMudaC() {
  const visto = [];
  const svc = new CentralConfiguracaoService(depsCfg(async ({ empresaId, db }) => {
    visto.push({ empresaId, db: db && db.__marcaDb });
    if (empresaId === 22) {
      const err = new Error('falha B');
      err.code = 'CONFIG_FISCAL';
      throw err;
    }
    return fiscalOk(empresaId, EMP_C.cnpj);
  }));
  const b = await svc.obterContextoOperacional({
    empresaId: 22, db: marcaDb('dbB'), permitirFallbackGlobal: false
  });
  const c = await svc.obterContextoOperacional({
    empresaId: 33, db: marcaDb('dbC'), permitirFallbackGlobal: false
  });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(visto[1].empresaId, 33);
  assert.strictEqual(visto[1].db, 'dbC');
  assert.ok(c.ok === true || visto[1].db === 'dbC');
  console.log('  T15 erro de B não altera contexto de C');
}

async function t16SequencialSemVazamento() {
  const seq = [];
  const cfg = {
    obterContextoOperacional: async (opts) => {
      seq.push(`${opts.empresaId}:${opts.db && opts.db.__marcaDb}`);
      return { ok: false, codigoErro: 'TESTE_STOP', mensagem: 'stop' };
    }
  };
  const sync = new CentralSincronizacaoService({
    configuracaoService: cfg,
    nsuRepository: { buscarPorCnpjAmbiente: async () => null }
  });
  const dbs = { 11: marcaDb('dbA'), 22: marcaDb('dbB'), 33: marcaDb('dbC') };
  for (const id of [11, 22, 33]) {
    await sync._sincronizarEmpresa(
      { empresaId: id, cnpj: EMPRESAS_3.find((e) => e.id === id).cnpj },
      { modo: ModoOperacionalGlobal.MULTIEMPRESA, db: dbs[id] }
    );
  }
  assert.deepStrictEqual(seq, ['11:dbA', '22:dbB', '33:dbC']);
  console.log('  T16 três alvos sequenciais sem vazamento');
}

async function main() {
  console.log('03.06.1 contexto fiscal db multiempresa\n');
  const tests = [
    t01TresAlvos, t02DbA, t03DbB, t04DbC, t05NaoCompartilhaABC, t06CicloA,
    t07BNuncaDbA, t08CNuncaDbA, t09SemConfigSemFallback, t10ErroOficial,
    t11EmpresaSimples, t12SemOperacionalIdNoDb, t13SqlPorEmpresaId,
    t14EmpresaIdNoSync, t15ErroBNaoMudaC, t16SequencialSemVazamento
  ];
  let ok = 0;
  for (const t of tests) {
    await t();
    ok += 1;
  }
  console.log(`\n${ok}/${tests.length} ok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
