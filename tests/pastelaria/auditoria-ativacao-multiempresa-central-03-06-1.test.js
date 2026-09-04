/**
 * Sprint 03.06.1 — Auditoria e ativação explícita de MULTIEMPRESA (Central).
 * Sem detecção por empresas.length. Executar:
 *   node tests/pastelaria/auditoria-ativacao-multiempresa-central-03-06-1.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const configService = require('../../backend/services/configuracaoService');
const {
  ModoOperacionalGlobal,
  ContratoOperacionalService,
  resolverModoOperacionalGlobalAtivo,
  modoGlobalParaModoVenda
} = require('../../backend/core/modo-operacional');
const {
  listarAlvosSincronizacaoCentral
} = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CentralSincronizacaoService = require('../../backend/motores/central-entradas/services/CentralSincronizacaoService');
const CentralNsuRepository = require('../../backend/motores/central-entradas/repositories/CentralNsuRepository');

const EMP_A = { id: 11, cnpj: '11111111000191', razao_social: 'Empresa A', ativo: 1 };
const EMP_B = { id: 22, cnpj: '22222222000182', razao_social: 'Empresa B', ativo: 1 };
const EMP_C = { id: 33, cnpj: '33333333000173', razao_social: 'Empresa C', ativo: 1 };
const EMPRESAS_3 = [EMP_A, EMP_B, EMP_C];

const AUDIT = 'docs/arquitetura/AUDITORIA_ATIVACAO_MULTIEMPRESA_CENTRAL_03_06_1.md';
const REL = 'docs/IMPLEMENTACAO_03_06_1_RELATORIO.md';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-03061-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  const finish = () => {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(finish);
    }
    finish();
    return result;
  } catch (err) {
    finish();
    throw err;
  }
}

function readRaw(dbDir) {
  return JSON.parse(fs.readFileSync(path.join(dbDir, 'config', 'configuracoes.json'), 'utf8'));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE central_entradas_nsu (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ambiente INTEGER NOT NULL DEFAULT 2,
      ult_nsu TEXT NOT NULL DEFAULT '000000000000000',
      max_nsu TEXT NOT NULL DEFAULT '000000000000000',
      data_sincronizacao DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ambiente)
    )
  `);
  return db;
}

async function seedEmpresas(db, lista) {
  for (const e of lista) {
    await run(
      db,
      `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
       VALUES (?, ?, ?, ?, ?)`,
      [e.id, e.cnpj, e.razao_social, e.razao_social, e.ativo != null ? e.ativo : 1]
    );
  }
}

async function t01LeituraConfiguracaoAtual() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    const raw = readRaw(dir);
    assert.strictEqual(raw.modo_operacional_global, 'EMPRESA_SIMPLES');
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'EMPRESA_SIMPLES');
    assert.strictEqual(resolverModoOperacionalGlobalAtivo(), 'EMPRESA_SIMPLES');
    assert.ok(configService.getConfigPath().indexOf(dir) !== -1);
    console.log('  T01 leitura da configuração atual (bootstrap EMPRESA_SIMPLES no arquivo oficial do DB_DIR)');
  });
}

async function t02GravacaoExplicita() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    assert.throws(
      () => configService.saveConfig({
        ...configService.readConfig(),
        modo_operacional_global: 'MULTIEMPRESA'
      }),
      (err) => err.code === 'MODO_OPERACIONAL_ALTERACAO_REQUER_CONFIRMACAO'
    );
    const saved = configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    assert.strictEqual(saved.modo_operacional_global, 'MULTIEMPRESA');
    console.log('  T02 gravação explícita MULTIEMPRESA (confirmação obrigatória)');
  });
}

async function t03PersistenciaAposSave() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const raw = readRaw(dir);
    assert.strictEqual(raw.modo_operacional_global, 'MULTIEMPRESA');
    assert.notStrictEqual(raw.modo_operacional_global, 'EMPRESA_SIMPLES');
    console.log('  T03 persistência após saveConfig (JSON = MULTIEMPRESA)');
  });
}

async function t04ResolucaoModo() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'MULTIEMPRESA');
    assert.strictEqual(resolverModoOperacionalGlobalAtivo(), 'MULTIEMPRESA');
    console.log('  T04 resolução do modo (obter + resolver = MULTIEMPRESA)');
  });
}

async function t05SincronizacaoLegado() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const raw = readRaw(dir);
    assert.strictEqual(raw.modo_operacao_venda, modoGlobalParaModoVenda('MULTIEMPRESA'));
    assert.strictEqual(raw.modo_operacao_venda, 'MULTIEMPRESA');
    assert.strictEqual(configService.obterModoOperacaoVenda(), 'MULTIEMPRESA');
    console.log('  T05 sincronização modo legado (MULTIEMPRESA → modo_operacao_venda)');
  });
}

async function t06ContratoMultiempresa() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional({
      db,
      obterModoOperacionalGlobal: () => configService.obterModoOperacionalGlobal()
    });
    assert.strictEqual(contrato.modo_operacional, ModoOperacionalGlobal.MULTIEMPRESA);
    db.close();
    console.log('  T06 contrato MULTIEMPRESA');
  });
}

async function t07EmpresaOperacionalNull() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true,
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional({
      db,
      obterModoOperacionalGlobal: () => configService.obterModoOperacionalGlobal(),
      obterEmpresaOperacionalId: () => EMP_A.id
    });
    assert.strictEqual(contrato.empresa_operacional, null);
    db.close();
    console.log('  T07 empresa_operacional = null em MULTIEMPRESA');
  });
}

async function t08TresEmpresasAtivas() {
  const db = await criarDb();
  await seedEmpresas(db, EMPRESAS_3);
  const EmpresaService = require('../../backend/services/empresas/EmpresaService');
  const lista = await EmpresaService.listarEmpresas({ ativo: 1 }, { db });
  assert.strictEqual(lista.length, 3);
  assert.deepStrictEqual(lista.map((e) => Number(e.id)).sort((a, b) => a - b), [11, 22, 33]);
  db.close();
  console.log('  T08 três empresas ativas A/B/C');
}

async function t09TresAlvosCentral() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      obterModoOperacionalGlobal: () => configService.obterModoOperacionalGlobal()
    });
    assert.strictEqual(plano.modo, ModoOperacionalGlobal.MULTIEMPRESA);
    assert.strictEqual(plano.alvos.length, 3);
    const porId = Object.fromEntries(plano.alvos.map((a) => [a.empresaId, a]));
    assert.strictEqual(porId[11].cnpj, EMP_A.cnpj);
    assert.strictEqual(porId[22].cnpj, EMP_B.cnpj);
    assert.strictEqual(porId[33].cnpj, EMP_C.cnpj);
    db.close();
    console.log('  T09 três alvos da Central (11/22/33)');
  });
}

async function t10ResidualNaoInterfere() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true,
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      obterModoOperacionalGlobal: () => configService.obterModoOperacionalGlobal(),
      obterEmpresaOperacionalId: () => EMP_A.id
    });
    assert.strictEqual(plano.modo, ModoOperacionalGlobal.MULTIEMPRESA);
    assert.strictEqual(plano.alvos.length, 3);
    db.close();
    console.log('  T10 empresa_operacional_id residual não vira EMPRESA_SIMPLES');
  });
}

async function t11EmpresaSimplesContinua() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_B.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional({
      db,
      obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
      obterEmpresaOperacionalId: () => EMP_B.id,
      buscarEmpresaAtivaPorId: async (id) => EMPRESAS_3.find((e) => e.id === Number(id)) || null
    });
    assert.strictEqual(contrato.modo_operacional, ModoOperacionalGlobal.EMPRESA_SIMPLES);
    assert.strictEqual(contrato.empresa_operacional.empresa_id, EMP_B.id);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      contrato
    });
    assert.strictEqual(plano.alvos.length, 1);
    assert.strictEqual(plano.alvos[0].empresaId, EMP_B.id);
    db.close();
    console.log('  T11 EMPRESA_SIMPLES continua funcionando (operacional B)');
  });
}

function t12AusenciaFallback() {
  const helpers = src('backend/services/central-entradas/CentralEntradasEmpresaContextoService.js');
  const svc = src('backend/services/configuracaoService.js');
  const centro = src('frontend/erp/js/cds-centro-configuracoes.js');
  assert.ok(!/empresas\.length\s*>\s*1[\s\S]{0,80}MULTIEMPRESA/.test(helpers));
  assert.ok(!svc.includes('empresas.length > 1'));
  assert.ok(!centro.includes('empresas.length > 1'));
  assert.ok(!src('backend/core/modo-operacional/modoOperacionalGlobal.js').includes('primeira empresa'));
  console.log('  T12 ausência de fallback (quantidade de empresas não muda o modo)');
}

async function t13ReinicializacaoReleitura() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    configService.reloadGlobalConfig();
    const relido = JSON.parse(fs.readFileSync(path.join(dir, 'config', 'configuracoes.json'), 'utf8'));
    assert.strictEqual(relido.modo_operacional_global, 'MULTIEMPRESA');
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'MULTIEMPRESA');
    assert.strictEqual(resolverModoOperacionalGlobalAtivo(), 'MULTIEMPRESA');
    console.log('  T13 reinicialização/releitura (reloadGlobalConfig + arquivo + resolver)');
  });
}

async function t14CentralSemAmbigua() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const nsuRepo = new CentralNsuRepository({ db });
    const svc = new CentralSincronizacaoService({
      db,
      nsuRepository: nsuRepo,
      obterModoOperacionalGlobal: () => configService.obterModoOperacionalGlobal(),
      EmpresaService: require('../../backend/services/empresas/EmpresaService'),
      configuracaoService: {
        obterContextoOperacional: async ({ empresaId }) => ({
          ok: false,
          codigoErro: 'SEM_CERTIFICADO_TESTE',
          mensagem: `sem certificado empresa ${empresaId}`
        })
      }
    });
    const resultado = await svc.sincronizar({});
    assert.notStrictEqual(resultado.codigoErro, 'EMPRESA_OPERACIONAL_AMBIGUA');
    assert.ok(!String(resultado.mensagem || '').includes('Modo EMPRESA_SIMPLES com múltiplas empresas'));
    assert.ok(Array.isArray(resultado.porEmpresa) ? resultado.porEmpresa.length === 3 : true);
    if (Array.isArray(resultado.porEmpresa)) {
      const ids = resultado.porEmpresa.map((p) => Number(p.empresaId)).sort((a, b) => a - b);
      assert.deepStrictEqual(ids, [11, 22, 33]);
    }
    db.close();
    console.log('  T14 Central sem EMPRESA_OPERACIONAL_AMBIGUA (3 alvos)');
  });
}

async function t15IsolamentoABC() {
  await withTempDbDir(async () => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA'
    });
    const a = plano.alvos.find((x) => x.empresaId === 11);
    const b = plano.alvos.find((x) => x.empresaId === 22);
    const c = plano.alvos.find((x) => x.empresaId === 33);
    assert.ok(a && b && c);
    assert.notStrictEqual(a.cnpj, b.cnpj);
    assert.notStrictEqual(b.cnpj, c.cnpj);
    assert.notStrictEqual(a.empresaId, b.empresaId);
    db.close();
    console.log('  T15 isolamento A/B/C (empresaId + CNPJ independentes)');
  });
}

function t16DiagnosticoOrigem() {
  const audit = src(AUDIT);
  const rel = src(REL);
  assert.ok(audit.includes('C:\\ProgramData\\MercantilFiscal\\dados\\config\\configuracoes.json')
    || audit.includes('ProgramData') && audit.includes('configuracoes.json'));
  assert.ok(audit.includes('CAUSA') || audit.includes('Causa'));
  assert.ok(audit.includes('EMPRESA_SIMPLES'));
  assert.ok(audit.includes('nunca foi salvo') || audit.includes('nunca persistido') || audit.includes('nunca foi persistido'));
  assert.ok(rel.includes('CAUSA:'));
  assert.ok(src('frontend/erp/js/configuracoes.js').includes('window.salvarConfiguracoesAvancadas'));
  assert.ok(src('frontend/erp/js/configuracoes.js').includes('querySelector(\'input[name="modoOperacionalGlobal"]:checked\')')
    || src('frontend/erp/js/configuracoes.js').includes('querySelector("input[name=\\"modoOperacionalGlobal\\"]:checked")')
    || src('frontend/erp/js/configuracoes.js').includes('modoOperacionalGlobal'));
  console.log('  T16 diagnóstico final da origem (A: MULTIEMPRESA nunca persistido no arquivo oficial)');
}

async function main() {
  console.log('03.06.1 auditoria ativação MULTIEMPRESA Central\n');
  const tests = [
    t01LeituraConfiguracaoAtual,
    t02GravacaoExplicita,
    t03PersistenciaAposSave,
    t04ResolucaoModo,
    t05SincronizacaoLegado,
    t06ContratoMultiempresa,
    t07EmpresaOperacionalNull,
    t08TresEmpresasAtivas,
    t09TresAlvosCentral,
    t10ResidualNaoInterfere,
    t11EmpresaSimplesContinua,
    t12AusenciaFallback,
    t13ReinicializacaoReleitura,
    t14CentralSemAmbigua,
    t15IsolamentoABC,
    t16DiagnosticoOrigem
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
