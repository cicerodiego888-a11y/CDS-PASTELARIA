/**
 * Sprint 05.54 — Ativação explícita de MULTIEMPRESA (Central de Entradas).
 * Executar: node tests/central-entradas/modo-multiempresa-05-54.test.js
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
  validarModoOperacionalGlobal,
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

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-0554-'));
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

function writeConfig(dbDir, obj) {
  const p = path.join(dbDir, 'config', 'configuracoes.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
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
      [e.id, e.cnpj, e.razao_social, e.nome_fantasia || e.razao_social, e.ativo != null ? e.ativo : 1]
    );
  }
}

function depsContrato(db, extras = {}) {
  return {
    db,
    listarEmpresasAtivas: async () => EMPRESAS_3,
    buscarEmpresaAtivaPorId: async (id) => EMPRESAS_3.find((e) => e.id === Number(id)) || null,
    ...extras
  };
}

async function t01EmpresaSimplesAmbigua() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: null
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    await assert.rejects(
      () => ContratoOperacionalService.montarContratoOperacional(depsContrato(db, {
        obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
        obterEmpresaOperacionalId: () => null
      })),
      (err) => err.code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    );
    db.close();
  });
}

async function t02EmpresaSimplesComIdValido() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: EMP_B.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional(depsContrato(db, {
      obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
      obterEmpresaOperacionalId: () => EMP_B.id
    }));
    assert.strictEqual(contrato.modo_operacional, ModoOperacionalGlobal.EMPRESA_SIMPLES);
    assert.strictEqual(contrato.empresa_operacional.empresa_id, EMP_B.id);
    db.close();
  });
}

async function t03MultiempresaContratoValido() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional(depsContrato(db, {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA'
    }));
    assert.strictEqual(contrato.modo_operacional, ModoOperacionalGlobal.MULTIEMPRESA);
    db.close();
  });
}

async function t04EmpresaOperacionalNull() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional(depsContrato(db, {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      obterEmpresaOperacionalId: () => EMP_A.id
    }));
    assert.strictEqual(contrato.empresa_operacional, null);
    db.close();
  });
}

async function t05AlvosTresEmpresas() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, { modo_operacional_global: 'MULTIEMPRESA' });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA'
    });
    assert.strictEqual(plano.modo, ModoOperacionalGlobal.MULTIEMPRESA);
    assert.strictEqual(plano.alvos.length, 3);
    db.close();
  });
}

async function t06AlvosCnpjProprio() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, { modo_operacional_global: 'MULTIEMPRESA' });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA'
    });
    const porId = new Map(plano.alvos.map((a) => [a.empresaId, a.cnpj]));
    assert.strictEqual(porId.get(EMP_A.id), EMP_A.cnpj);
    assert.strictEqual(porId.get(EMP_B.id), EMP_B.cnpj);
    assert.strictEqual(porId.get(EMP_C.id), EMP_C.cnpj);
    db.close();
  });
}

async function t07NaoEscolheEmpresaAutomaticamente() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, {
      modo_operacional_global: 'MULTIEMPRESA',
      empresa_operacional_id: EMP_A.id
    });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const contrato = await ContratoOperacionalService.montarContratoOperacional(depsContrato(db, {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      obterEmpresaOperacionalId: () => EMP_A.id
    }));
    const plano = await listarAlvosSincronizacaoCentral({
      db,
      contrato
    });
    assert.strictEqual(contrato.empresa_operacional, null);
    const ids = plano.alvos.map((a) => a.empresaId).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [EMP_A.id, EMP_B.id, EMP_C.id]);
    assert.notStrictEqual(plano.alvos.length, 1);
    db.close();
  });
}

function t08ValorInvalidoRejeitado() {
  assert.throws(
    () => validarModoOperacionalGlobal('PASTELARIA'),
    { code: 'MODO_OPERACIONAL_GLOBAL_INVALIDO' }
  );
  withTempDbDir(() => {
    configService.ensureConfigFile();
    assert.throws(
      () => configService.saveConfig({
        ...configService.readConfig(),
        modo_operacional_global: 'TRI_EMPRESA'
      }),
      (err) => {
        const details = err.details || [];
        return String(err.message || '').includes('modo_operacional_global inválido')
          || details.includes('modo_operacional_global inválido');
      }
    );
  });
}

function t09SalvarMultiempresaSincronizaModoVenda() {
  withTempDbDir((dir) => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      empresa_operacional_id: EMP_A.id,
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    const raw = readRaw(dir);
    assert.strictEqual(raw.modo_operacional_global, 'MULTIEMPRESA');
    assert.strictEqual(raw.modo_operacao_venda, modoGlobalParaModoVenda('MULTIEMPRESA'));
    assert.strictEqual(raw.modo_operacao_venda, 'MULTIEMPRESA');
    assert.strictEqual(raw.empresa_operacional_id, EMP_A.id);
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'MULTIEMPRESA');
  });
}

async function t10VoltarEmpresaSimplesExigeOperacional() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true,
      empresa_operacional_id: null
    });
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES',
      confirmacao_modo_operacional: true,
      empresa_operacional_id: null
    });
    assert.strictEqual(readRaw(dir).modo_operacional_global, 'EMPRESA_SIMPLES');
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    await assert.rejects(
      () => ContratoOperacionalService.montarContratoOperacional(depsContrato(db, {
        obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
        obterEmpresaOperacionalId: () => null
      })),
      (err) => err.code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    );
    db.close();
  });
}

async function t11FluxoSyncCentralTresEmpresas() {
  await withTempDbDir(async (dir) => {
    writeConfig(dir, { modo_operacional_global: 'MULTIEMPRESA' });
    const db = await criarDb();
    await seedEmpresas(db, EMPRESAS_3);
    const nsuRepo = new CentralNsuRepository({ db });
    const nsuPorCnpj = {};
    const contextosVistos = [];

    class SyncTeste extends CentralSincronizacaoService {
      async _sincronizarEmpresa(alvo) {
        const empresaId = Number(alvo.empresaId);
        const cnpj = String(alvo.cnpj || '');
        contextosVistos.push({ empresaId, cnpj });

        if (empresaId === EMP_B.id) {
          return {
            sucesso: false,
            pulado: true,
            empresaId,
            cnpj,
            notasNovas: 0,
            notasDuplicadas: 0,
            erros: ['Certificado digital não configurado para a empresa 22.'],
            mensagem: 'Certificado digital não configurado para a empresa 22.',
            codigoErro: 'CERTIFICADO'
          };
        }

        const ambiente = 2;
        const ctrl = await nsuRepo.obterOuCriar(cnpj, ambiente);
        const novoUlt = empresaId === EMP_A.id ? '000000000000111' : '000000000000333';
        await nsuRepo.atualizarSincronizacao(ctrl.id, { ultNsu: novoUlt, maxNsu: novoUlt });
        nsuPorCnpj[cnpj] = novoUlt;
        return {
          sucesso: true,
          empresaId,
          cnpj,
          notasNovas: 1,
          notasDuplicadas: 0,
          ultNsu: novoUlt,
          maxNsu: novoUlt,
          mensagem: 'ok'
        };
      }
    }

    const sync = new SyncTeste({ db });
    const resultado = await sync.sincronizar();

    assert.notStrictEqual(resultado.codigoErro, 'EMPRESA_OPERACIONAL_AMBIGUA');
    assert.strictEqual(resultado.modoOperacional, ModoOperacionalGlobal.MULTIEMPRESA);
    assert.strictEqual(resultado.porEmpresa.length, 3);

    const ids = resultado.porEmpresa.map((p) => p.empresaId).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, [EMP_A.id, EMP_B.id, EMP_C.id]);

    const linhaB = resultado.porEmpresa.find((p) => p.empresaId === EMP_B.id);
    assert.strictEqual(linhaB.codigoErro, 'CERTIFICADO');
    assert.ok(String(linhaB.mensagem).includes('empresa 22'));

    const linhaA = resultado.porEmpresa.find((p) => p.empresaId === EMP_A.id);
    const linhaC = resultado.porEmpresa.find((p) => p.empresaId === EMP_C.id);
    assert.strictEqual(linhaA.sucesso, true);
    assert.strictEqual(linhaC.sucesso, true);
    assert.strictEqual(linhaA.cnpj, EMP_A.cnpj);
    assert.strictEqual(linhaC.cnpj, EMP_C.cnpj);

    assert.deepStrictEqual(
      contextosVistos.map((c) => c.empresaId),
      [EMP_A.id, EMP_B.id, EMP_C.id]
    );

    const nsuA = await nsuRepo.buscarPorCnpjAmbiente(EMP_A.cnpj, 2);
    const nsuB = await nsuRepo.buscarPorCnpjAmbiente(EMP_B.cnpj, 2);
    const nsuC = await nsuRepo.buscarPorCnpjAmbiente(EMP_C.cnpj, 2);
    assert.strictEqual(nsuA.ultNsu, '000000000000111');
    assert.strictEqual(nsuC.ultNsu, '000000000000333');
    assert.ok(!nsuB || nsuB.ultNsu === '000000000000000');

    db.close();
  });
}

function t12UiModoExplicitoSemAutoDetect() {
  const ui = src('frontend/erp/js/cds-centro-configuracoes.js');
  assert.ok(ui.includes('name="modoOperacionalGlobal"'));
  assert.ok(ui.includes('value="EMPRESA_SIMPLES"'));
  assert.ok(ui.includes('value="MULTIEMPRESA"'));
  assert.ok(ui.includes('Opera com uma única empresa operacional.'));
  assert.ok(ui.includes('Permite operar várias empresas/CNPJs utilizando o contexto da empresa selecionada.'));
  assert.ok(!/empresas\.length\s*>\s*1/.test(ui));
  const rota = src('backend/rotas/configuracoes_avancadas.js');
  assert.ok(rota.includes('saveConfig'));
  const syncSrc = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(syncSrc.includes('listarAlvosSincronizacaoCentral'));
}

const TESTS = [
  ['T01 EMPRESA_SIMPLES sem id → AMBIGUA', t01EmpresaSimplesAmbigua],
  ['T02 EMPRESA_SIMPLES + id válido', t02EmpresaSimplesComIdValido],
  ['T03 MULTIEMPRESA contrato válido', t03MultiempresaContratoValido],
  ['T04 MULTIEMPRESA empresa_operacional null', t04EmpresaOperacionalNull],
  ['T05 alvos = 3 empresas', t05AlvosTresEmpresas],
  ['T06 cada alvo com empresaId e CNPJ', t06AlvosCnpjProprio],
  ['T07 sem escolha automática', t07NaoEscolheEmpresaAutomaticamente],
  ['T08 valor inválido rejeitado', t08ValorInvalidoRejeitado],
  ['T09 salvar MULTIEMPRESA sincroniza modo_venda', t09SalvarMultiempresaSincronizaModoVenda],
  ['T10 voltar EMPRESA_SIMPLES exige operacional', t10VoltarEmpresaSimplesExigeOperacional],
  ['T11 fluxo sync Central 3 empresas (cert B falha)', t11FluxoSyncCentralTresEmpresas],
  ['T12 UI + endpoint existente + alvos Central', t12UiModoExplicitoSemAutoDetect]
];

(async () => {
  let ok = 0;
  let fail = 0;
  for (const [nome, fn] of TESTS) {
    try {
      await fn();
      ok += 1;
      console.log(`  OK  ${nome}`);
    } catch (err) {
      fail += 1;
      console.error(`  FAIL ${nome}:`, err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
