/**
 * Sprint 05.17 — recuperação de contexto do PDV Universal.
 */
'use strict';

const assert = require('assert');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const acesso = require('../../frontend/shared/js/pdv-acesso-oficial.js');
const { obterContexto } = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');

const EMP_A = { id: 2, razao_social: 'A', nome_fantasia: 'A', cnpj: '11', ativo: 1 };
const EMP_B = { id: 3, razao_social: 'B', nome_fantasia: 'B', cnpj: '22', ativo: 1 };

function deps(modo, empresas) {
  return {
    obterModoOperacaoVenda: () => modo,
    listarEmpresasDisponiveis: async () => empresas
  };
}

async function test01Valido() {
  const ctx = await obterContexto({ user: { id: 1 }, empresaId: 2 }, deps('EMPRESA_UNICA', [EMP_A]));
  assert.strictEqual(ctx.empresa_selecionada.id, 2);
}

async function test02MultiSemEmpresa() {
  const ctx = await obterContexto({ user: { id: 1 } }, deps('MULTIEMPRESA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.empresa_selecionada, null);
  assert.strictEqual(tela.montarModeloVisual(ctx).estado, 'READY');
}

async function test03e04e05InvalidaLimpaRetry() {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    if (n === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ code: 'EMPRESA_OPERACIONAL_INVALIDA', error: 'inválida' })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ modo_operacao: 'MULTIEMPRESA', empresa_selecionada: null })
    };
  };
  const ctx = await tela.carregarContextoComRecuperacao(fetchFn);
  assert.strictEqual(n, 2);
  assert.strictEqual(ctx.modo_operacao, 'MULTIEMPRESA');
}

function test06Auth401() {
  const info = tela.classificarErroContexto({ status: 401, code: 'SESSAO_INVALIDA' });
  assert.strictEqual(info.acao, 'LOGIN');
}

function test07Auth403() {
  const info = tela.classificarErroContexto({ status: 403, code: 'SESSAO_INVALIDA' });
  assert.strictEqual(info.acao, 'LOGIN');
}

function test08NaoTrata409ComoSessao() {
  const info = tela.classificarErroContexto({
    status: 409,
    code: 'NENHUMA_EMPRESA_DISPONIVEL'
  });
  assert.notStrictEqual(info.acao, 'LOGIN');
  assert.strictEqual(info.tipo, 'SEM_EMPRESA');
}

async function test09UnicaSemEmpresa() {
  await assert.rejects(
    () => obterContexto({ user: { id: 1, nome: 'Op' } }, deps('EMPRESA_UNICA', [])),
    (err) => err.code === 'NENHUMA_EMPRESA_DISPONIVEL' && err.statusCode === 409
  );
}

function test10Navegacao() {
  assert.strictEqual(acesso.urlPdvUniversalOficial(), '/pdv-universal/');
  assert.strictEqual(acesso.urlPdvLegadoOficial(), '/pdv');
}

async function run() {
  const testes = [
    test01Valido,
    test02MultiSemEmpresa,
    test03e04e05InvalidaLimpaRetry,
    test06Auth401,
    test07Auth403,
    test08NaoTrata409ComoSessao,
    test09UnicaSemEmpresa,
    test10Navegacao
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log('05.17 pdv contexto 8/8');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
