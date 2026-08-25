/**
 * Sprint 05.38.B — Modo Operacional Global (fundação central).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const configService = require('../backend/services/configuracaoService');
const {
  ModoOperacionalGlobal,
  DEFAULT_MODO_OPERACIONAL_GLOBAL,
  validarModoOperacionalGlobal,
  capacidadesParaModoGlobal,
  resolverModoOperacionalGlobalAtivo,
  modoGlobalParaModoVenda,
  PoliticaEmpresaSimples,
  ContratoOperacionalService
} = require('../backend/core/modo-operacional');
const { resolverModoOperacaoVendaAtivo } = require('../backend/motores/muv/modoOperacaoVenda');
const { obterContexto } = require('../backend/motores/pdv-universal/PDVUniversalApplicationService');

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modo-global-0538b-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function configPathFromDbDir(dbDir) {
  return path.join(dbDir, 'config', 'configuracoes.json');
}

function writeConfig(dbDir, obj) {
  const p = configPathFromDbDir(dbDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

function readRaw(dbDir) {
  return JSON.parse(fs.readFileSync(configPathFromDbDir(dbDir), 'utf8'));
}

const EMP_A = { id: 2, razao_social: 'Empresa A', cnpj: '11111111000191', ativo: 1 };
const EMP_B = { id: 3, razao_social: 'Empresa B', cnpj: '22222222000182', ativo: 1 };

function test01BootstrapPadraoEmpresaSimples() {
  withTempDbDir((dir) => {
    configService.ensureConfigFile();
    const raw = readRaw(dir);
    assert.strictEqual(raw.modo_operacional_global, 'EMPRESA_SIMPLES');
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'EMPRESA_SIMPLES');
    assert.strictEqual(DEFAULT_MODO_OPERACIONAL_GLOBAL, 'EMPRESA_SIMPLES');
  });
}

function test02EmpresaSimplesResolve() {
  withTempDbDir(() => {
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES',
      confirmacao_modo_operacional: false
    });
    assert.strictEqual(resolverModoOperacionalGlobalAtivo(), 'EMPRESA_SIMPLES');
    assert.strictEqual(modoGlobalParaModoVenda('EMPRESA_SIMPLES'), 'EMPRESA_UNICA');
  });
}

function test03MultiempresaResolve() {
  withTempDbDir(() => {
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    assert.strictEqual(resolverModoOperacionalGlobalAtivo(), 'MULTIEMPRESA');
    assert.strictEqual(modoGlobalParaModoVenda('MULTIEMPRESA'), 'MULTIEMPRESA');
  });
}

function test04ValorInvalidoRejeitado() {
  assert.throws(
    () => validarModoOperacionalGlobal('PASTELARIA'),
    { code: 'MODO_OPERACIONAL_GLOBAL_INVALIDO' }
  );
}

function test05UmaEmpresaMultiempresaContinuaMultiempresa() {
  withTempDbDir(() => {
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    assert.strictEqual(
      resolverModoOperacionalGlobalAtivo({
        obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
        listarEmpresasAtivas: async () => [EMP_A]
      }),
      'MULTIEMPRESA'
    );
  });
}

function test06VariasEmpresasEmpresaSimplesContinua() {
  withTempDbDir(() => {
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES'
    });
    assert.strictEqual(
      resolverModoOperacionalGlobalAtivo({
        obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES'
      }),
      'EMPRESA_SIMPLES'
    );
  });
}

function test07EmpresaSimplesNaoHabilitaMuv() {
  const caps = capacidadesParaModoGlobal('EMPRESA_SIMPLES');
  assert.strictEqual(caps.muv, false);
  assert.strictEqual(caps.multiempresa, false);
}

function test08MultiempresaHabilitaMuv() {
  const caps = capacidadesParaModoGlobal('MULTIEMPRESA');
  assert.strictEqual(caps.muv, true);
  assert.strictEqual(caps.multiempresa, true);
}

function test09EmpresaSimplesNaoHabilitaSelecao() {
  const caps = capacidadesParaModoGlobal('EMPRESA_SIMPLES');
  assert.strictEqual(caps.selecao_empresa, false);
}

function test10MultiempresaHabilitaSelecao() {
  const caps = capacidadesParaModoGlobal('MULTIEMPRESA');
  assert.strictEqual(caps.selecao_empresa, true);
}

async function test11PdvCompatEmpresaSimplesParaEmpresaUnica() {
  const ctx = await obterContexto(
    { user: { id: 1 } },
    {
      obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA',
      obterEmpresaOperacionalId: () => 2,
      listarEmpresasAtivas: async () => [EMP_A],
      buscarEmpresaAtivaPorId: async (id) => (id === 2 ? EMP_A : null),
      listarEmpresasDisponiveis: async () => [EMP_A]
    }
  );
  assert.strictEqual(ctx.modo_operacional_global, 'EMPRESA_SIMPLES');
  assert.strictEqual(ctx.modo_operacao, 'EMPRESA_UNICA');
  assert.strictEqual(ctx.empresa_selecionada.id, 2);
  assert.strictEqual(ctx.exige_selecao, false);
}

async function test12PdvPreservaMultiempresa() {
  const ctx = await obterContexto(
    { user: { id: 1 } },
    {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      obterModoOperacaoVenda: () => 'MULTIEMPRESA',
      listarEmpresasDisponiveis: async () => [EMP_A, EMP_B]
    }
  );
  assert.strictEqual(ctx.modo_operacional_global, 'MULTIEMPRESA');
  assert.strictEqual(ctx.modo_operacao, 'MULTIEMPRESA');
}

async function test13FalhaSemEmpresaOperacionalValida() {
  await assert.rejects(
    () => PoliticaEmpresaSimples.resolverEmpresaOperacional({
      obterEmpresaOperacionalId: () => null,
      listarEmpresasAtivas: async () => []
    }),
    (err) => err.code === 'EMPRESA_OPERACIONAL_AUSENTE'
  );

  await assert.rejects(
    () => PoliticaEmpresaSimples.resolverEmpresaOperacional({
      obterEmpresaOperacionalId: () => null,
      listarEmpresasAtivas: async () => [EMP_A, EMP_B]
    }),
    (err) => err.code === 'EMPRESA_OPERACIONAL_AMBIGUA'
  );
}

function test14MudancaModoExigeConfirmacao() {
  withTempDbDir(() => {
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES'
    });
    assert.throws(
      () => configService.saveConfig({
        ...configService.readConfig(),
        modo_operacional_global: 'MULTIEMPRESA'
      }),
      (err) => err.code === 'MODO_OPERACIONAL_ALTERACAO_REQUER_CONFIRMACAO'
    );
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'MULTIEMPRESA',
      confirmacao_modo_operacional: true
    });
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'MULTIEMPRESA');
  });
}

function test15ModoOperacaoVendaLegadoCompativel() {
  withTempDbDir((dir) => {
    writeConfig(dir, { modo_operacao_venda: 'MULTIEMPRESA' });
    configService.bootstrapModoOperacionalGlobal();
    assert.strictEqual(configService.obterModoOperacionalGlobal(), 'MULTIEMPRESA');
    assert.strictEqual(configService.obterModoOperacaoVenda(), 'MULTIEMPRESA');
    assert.strictEqual(readRaw(dir).modo_operacao_venda, 'MULTIEMPRESA');
  });
}

async function test16ContratoOperacional() {
  const contrato = await ContratoOperacionalService.montarContratoOperacional({
    obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
    obterEmpresaOperacionalId: () => 2,
    listarEmpresasAtivas: async () => [EMP_A],
    buscarEmpresaAtivaPorId: async () => EMP_A
  });
  assert.strictEqual(contrato.modo_operacional, 'EMPRESA_SIMPLES');
  assert.strictEqual(contrato.modo_operacao_venda, 'EMPRESA_UNICA');
  assert.strictEqual(contrato.empresa_operacional.empresa_id, 2);
}

function test17ResolverModoVendaViaGlobal() {
  withTempDbDir(() => {
    configService.saveConfig({
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES'
    });
    assert.strictEqual(resolverModoOperacaoVendaAtivo(), 'EMPRESA_UNICA');
  });
}

const TESTS = [
  ['01 bootstrap padrão EMPRESA_SIMPLES', test01BootstrapPadraoEmpresaSimples],
  ['02 EMPRESA_SIMPLES resolve', test02EmpresaSimplesResolve],
  ['03 MULTIEMPRESA resolve', test03MultiempresaResolve],
  ['04 valor inválido rejeitado', test04ValorInvalidoRejeitado],
  ['05 1 empresa + MULTIEMPRESA continua MULTIEMPRESA', test05UmaEmpresaMultiempresaContinuaMultiempresa],
  ['06 N empresas + EMPRESA_SIMPLES continua EMPRESA_SIMPLES', test06VariasEmpresasEmpresaSimplesContinua],
  ['07 EMPRESA_SIMPLES não habilita MUV', test07EmpresaSimplesNaoHabilitaMuv],
  ['08 MULTIEMPRESA habilita MUV', test08MultiempresaHabilitaMuv],
  ['09 EMPRESA_SIMPLES não habilita seleção', test09EmpresaSimplesNaoHabilitaSelecao],
  ['10 MULTIEMPRESA habilita seleção', test10MultiempresaHabilitaSelecao],
  ['11 PDV EMPRESA_SIMPLES → EMPRESA_UNICA', test11PdvCompatEmpresaSimplesParaEmpresaUnica],
  ['12 PDV preserva MULTIEMPRESA', test12PdvPreservaMultiempresa],
  ['13 falha sem empresa operacional válida', test13FalhaSemEmpresaOperacionalValida],
  ['14 mudança de modo exige confirmação', test14MudancaModoExigeConfirmacao],
  ['15 modo_operacao_venda legado compatível', test15ModoOperacaoVendaLegadoCompativel],
  ['16 contrato operacional', test16ContratoOperacional],
  ['17 resolver modo venda via global', test17ResolverModoVendaViaGlobal]
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
