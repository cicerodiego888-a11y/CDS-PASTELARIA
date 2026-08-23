/**
 * Sprint 05.17.1 — validação do acesso real ao PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const acesso = require('../../frontend/shared/js/pdv-acesso-oficial.js');
const { obterContexto } = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01Rota() {
  assert.strictEqual(acesso.urlPdvUniversalOficial(), '/pdv-universal/');
  assert.ok(src('backend/server.js').includes("'/pdv-universal/'"));
}

function test02Menu() {
  assert.ok(src('frontend/erp/index.html').includes('href="/pdv-universal/"'));
}

function test03NaoLegado() {
  assert.notStrictEqual(acesso.urlPdvUniversalOficial(), '/pdv');
  assert.strictEqual(acesso.urlPdvLegadoOficial(), '/pdv');
}

function test04e05Sessao() {
  assert.strictEqual(tela.classificarErroContexto({ status: 401 }).acao, 'LOGIN');
  assert.strictEqual(tela.classificarErroContexto({ status: 403 }).acao, 'LOGIN');
}

function test06NaoLogout409() {
  const info = tela.classificarErroContexto({ status: 409, code: 'NENHUMA_EMPRESA_DISPONIVEL' });
  assert.notStrictEqual(info.acao, 'LOGIN');
}

async function test07InvalidaRetry() {
  let n = 0;
  const ctx = await tela.carregarContextoComRecuperacao(async () => {
    n += 1;
    if (n === 1) {
      return { ok: false, status: 400, json: async () => ({ code: 'EMPRESA_OPERACIONAL_INVALIDA' }) };
    }
    return { ok: true, status: 200, json: async () => ({ modo_operacao: 'MULTIEMPRESA', empresa_selecionada: null }) };
  });
  assert.strictEqual(n, 2);
  assert.strictEqual(ctx.empresa_selecionada, null);
}

function test08UnicaSelecao() {
  const caps = tela.aplicarCapabilities({
    modo_operacao: 'EMPRESA_UNICA',
    exige_selecao: true,
    empresa_selecionada: null,
    capacidades: { permite_selecao_empresa: true }
  });
  assert.strictEqual(caps.mostrar_seletor, true);
}

async function test09MultiNull() {
  const ctx = await obterContexto(
    { user: { id: 1 } },
    {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA',
      listarEmpresasDisponiveis: async () => [
        { id: 2, razao_social: 'A', ativo: 1 },
        { id: 3, razao_social: 'B', ativo: 1 }
      ]
    }
  );
  assert.strictEqual(ctx.empresa_selecionada, null);
}

async function run() {
  const testes = [
    test01Rota, test02Menu, test03NaoLegado, test04e05Sessao,
    test06NaoLogout409, test07InvalidaRetry, test08UnicaSelecao, test09MultiNull
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log('05.17.1 pdv 8/8');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
