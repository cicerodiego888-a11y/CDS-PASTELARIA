/**
 * Sprint 04.02 — modo_operacao_venda (contrato, bootstrap, leitura, porta).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const muv = require('../../backend/motores/muv');
const {
  ModoOperacaoVenda,
  MODOS_OPERACAO_VENDA,
  DEFAULT_MODO_OPERACAO_VENDA,
  validarModoOperacaoVenda,
  resolverModoOperacaoVenda,
  executarNoModoOperacaoVenda,
  CODIGO_MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO
} = muv;

const configService = require('../../backend/services/configuracaoService');

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muv-0402-'));
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

function mockRes() {
  const state = { statusCode: null, body: null };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return payload;
    }
  };
}

function loadAppWithFakePagamento() {
  const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
  const appPath = path.resolve(__dirname, '../../backend/services/vendas/VendaApplicationService.js');
  const originalPag = require.cache[pagamentoPath];
  const originalApp = require.cache[appPath];

  let pagamentoChamado = 0;
  require.cache[pagamentoPath] = {
    id: pagamentoPath,
    filename: pagamentoPath,
    loaded: true,
    exports: {
      criarVenda() {
        pagamentoChamado += 1;
        return 'DELEGATED_PDV';
      }
    }
  };
  delete require.cache[appPath];
  const app = require('../../backend/services/vendas/VendaApplicationService');
  return {
    app,
    getPagamentoChamado: () => pagamentoChamado,
    restore() {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      if (originalApp) require.cache[appPath] = originalApp;
      else delete require.cache[appPath];
    }
  };
}

function test01ContratoEmpresaUnica() {
  assert.strictEqual(MODOS_OPERACAO_VENDA.EMPRESA_UNICA, 'EMPRESA_UNICA');
  assert.strictEqual(ModoOperacaoVenda.EMPRESA_UNICA, 'EMPRESA_UNICA');
  assert.strictEqual(validarModoOperacaoVenda('EMPRESA_UNICA'), 'EMPRESA_UNICA');
  assert.strictEqual(validarModoOperacaoVenda('empresa_unica'), 'EMPRESA_UNICA');
}

function test02ContratoMultiempresa() {
  assert.strictEqual(MODOS_OPERACAO_VENDA.MULTIEMPRESA, 'MULTIEMPRESA');
  assert.strictEqual(validarModoOperacaoVenda('MULTIEMPRESA'), 'MULTIEMPRESA');
  assert.strictEqual(validarModoOperacaoVenda('multiempresa'), 'MULTIEMPRESA');
}

function test03ValorInvalidoRejeitado() {
  assert.throws(() => validarModoOperacaoVenda('PASTELARIA'), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
  assert.throws(() => validarModoOperacaoVenda('EMPRESA_1'), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
  assert.throws(() => validarModoOperacaoVenda(''), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
}

function test04NullRejeitado() {
  assert.throws(() => validarModoOperacaoVenda(null), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
}

function test05UndefinedRejeitado() {
  assert.throws(() => validarModoOperacaoVenda(undefined), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
}

function test06DefaultEmpresaUnica() {
  assert.strictEqual(DEFAULT_MODO_OPERACAO_VENDA, 'EMPRESA_UNICA');
  assert.strictEqual(configService.DEFAULT.modo_operacao_venda, 'EMPRESA_UNICA');
  assert.strictEqual(resolverModoOperacaoVenda(null), 'EMPRESA_UNICA');
  assert.strictEqual(resolverModoOperacaoVenda(''), 'EMPRESA_UNICA');
}

function test07BootstrapCriaQuandoAusente() {
  withTempDbDir((dir) => {
    const p = configPathFromDbDir(dir);
    writeConfig(dir, { tipoImplantacao: 'ERP_SEM_FISCAL', porta: 3001 });
    assert.ok(!Object.prototype.hasOwnProperty.call(readRaw(dir), 'modo_operacao_venda'));
    const criado = configService.bootstrapModoOperacaoVenda();
    assert.strictEqual(criado, 'EMPRESA_UNICA');
    assert.ok(fs.existsSync(p));
    assert.strictEqual(readRaw(dir).modo_operacao_venda, 'EMPRESA_UNICA');
    assert.strictEqual(readRaw(dir).tipoImplantacao, 'ERP_SEM_FISCAL');
  });
}

function test08BootstrapNaoSobrescreveMultiempresa() {
  withTempDbDir((dir) => {
    writeConfig(dir, {
      tipoImplantacao: 'ERP_FISCAL',
      modo_operacao_venda: 'MULTIEMPRESA'
    });
    configService.bootstrapModoOperacaoVenda();
    configService.bootstrapModoOperacaoVenda();
    const raw = readRaw(dir);
    assert.strictEqual(raw.modo_operacao_venda, 'MULTIEMPRESA');
    assert.strictEqual(raw.tipoImplantacao, 'ERP_FISCAL');
  });
}

function test09LeituraEmpresaUnica() {
  withTempDbDir((dir) => {
    writeConfig(dir, { modo_operacao_venda: 'EMPRESA_UNICA' });
    assert.strictEqual(configService.obterModoOperacaoVenda(), 'EMPRESA_UNICA');
    assert.strictEqual(
      configService.obterModoOperacaoVenda({ modo_operacao_venda: 'EMPRESA_UNICA' }),
      'EMPRESA_UNICA'
    );
  });
}

function test10LeituraMultiempresa() {
  withTempDbDir((dir) => {
    writeConfig(dir, { modo_operacao_venda: 'MULTIEMPRESA' });
    assert.strictEqual(configService.obterModoOperacaoVenda(), 'MULTIEMPRESA');
    assert.strictEqual(
      configService.obterModoOperacaoVenda({ modo_operacao_venda: 'MULTIEMPRESA' }),
      'MULTIEMPRESA'
    );
  });
}

function test11InvalidoPersistidoNaoSilencia() {
  withTempDbDir((dir) => {
    writeConfig(dir, { modo_operacao_venda: 'PASTELARIA' });
    assert.throws(
      () => configService.obterModoOperacaoVenda(),
      { code: 'MODO_OPERACAO_VENDA_INVALIDO' }
    );
    configService.bootstrapModoOperacaoVenda();
    assert.strictEqual(readRaw(dir).modo_operacao_venda, 'PASTELARIA');
    assert.throws(
      () => configService.obterModoOperacaoVenda(),
      { code: 'MODO_OPERACAO_VENDA_INVALIDO' }
    );
  });
}

function test12VendaApplicationServiceResolveModo() {
  const { app, restore } = loadAppWithFakePagamento();
  try {
    const req = { body: { total: 10, itens: [] } };
    const res = mockRes();
    app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(req.vendaContext.modo_operacao_venda, 'EMPRESA_UNICA');
  } finally {
    restore();
  }
}

function test13EmpresaUnicaMantemFluxo() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const req = { body: { total: 10, itens: [] } };
    const res = mockRes();
    const result = app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
    assert.strictEqual(req.vendaContext.origem, 'PDV');
  } finally {
    restore();
  }
}

async function test14MultiempresaNaoCaiNoLegado() {
  assert.throws(
    () => executarNoModoOperacaoVenda('MULTIEMPRESA', {
      EMPRESA_UNICA() {
        return 'LEGADO';
      }
    }),
    { code: CODIGO_MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO }
  );

  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const req = { body: { total: 10, itens: [] } };
    const res = mockRes();
    const result = await app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA',
      db: { run() { throw new Error('db de produção não deve ser aberto neste teste'); } }
    });
    assert.notStrictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 0);
    assert.ok(res.state.body);
    assert.strictEqual(res.state.body.venda_concluida, false);
    assert.strictEqual(res.state.body.modo_operacao_venda, 'MULTIEMPRESA');
    assert.notStrictEqual(res.state.body.code, undefined);
    assert.notStrictEqual(res.state.body.code, 'DELEGATED_PDV');
  } finally {
    restore();
  }
}

async function main() {
  const testes = [
    ['01 contrato reconhece EMPRESA_UNICA', test01ContratoEmpresaUnica],
    ['02 contrato reconhece MULTIEMPRESA', test02ContratoMultiempresa],
    ['03 valor inválido é rejeitado', test03ValorInvalidoRejeitado],
    ['04 null é rejeitado', test04NullRejeitado],
    ['05 undefined é rejeitado', test05UndefinedRejeitado],
    ['06 default é EMPRESA_UNICA', test06DefaultEmpresaUnica],
    ['07 bootstrap cria a configuração quando ausente', test07BootstrapCriaQuandoAusente],
    ['08 bootstrap não sobrescreve MULTIEMPRESA', test08BootstrapNaoSobrescreveMultiempresa],
    ['09 leitura retorna EMPRESA_UNICA', test09LeituraEmpresaUnica],
    ['10 leitura retorna MULTIEMPRESA', test10LeituraMultiempresa],
    ['11 valor inválido persistido não é silenciado', test11InvalidoPersistidoNaoSilencia],
    ['12 VendaApplicationService resolve o modo ativo', test12VendaApplicationServiceResolveModo],
    ['13 EMPRESA_UNICA mantém o fluxo existente', test13EmpresaUnicaMantemFluxo],
    ['14 MULTIEMPRESA não cai silenciosamente como EMPRESA_UNICA', test14MultiempresaNaoCaiNoLegado]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nmodo-operacao-venda-04-02: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
