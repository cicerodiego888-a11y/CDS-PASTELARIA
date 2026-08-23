/**
 * Sprint 05.02 — contexto operacional e seleção de empresa do PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');
const { validarItensEntradaAtendimento } = require('../../backend/motores/muv/contratos');
const {
  obterContexto,
  selecionarEmpresa
} = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const ctxSvc = require('../../backend/services/pdv-universal/PDVUniversalContextService');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function depsBase(modo, empresas, extras = {}) {
  return {
    obterModoOperacaoVenda: () => modo,
    listarEmpresasDisponiveis: async () => empresas,
    ...extras
  };
}

const EMP_A = { id: 2, razao_social: 'Empresa A', nome_fantasia: 'A', cnpj: '11', ativo: 1 };
const EMP_B = { id: 3, razao_social: 'Empresa B', nome_fantasia: 'B', cnpj: '22', ativo: 1 };
const EMP_INATIVA = { id: 8, razao_social: 'Inativa', cnpj: '33', ativo: 0 };

function mockEmpresaService(mapa) {
  return {
    async buscarEmpresaPorId(id) {
      const e = mapa[id];
      if (!e) {
        const err = new Error('Empresa não encontrada.');
        err.code = 'EMPRESA_NAO_ENCONTRADA';
        throw err;
      }
      return e;
    },
    async selecionarEmpresaContexto(fonte) {
      const id = Number(fonte.empresaId || fonte.empresa_id);
      const e = mapa[id];
      if (!e) {
        const err = new Error('Empresa não encontrada.');
        err.code = 'EMPRESA_NAO_ENCONTRADA';
        throw err;
      }
      if (Number(e.ativo) !== 1) {
        const err = new Error('inativa');
        err.code = 'EMPRESA_INATIVA';
        throw err;
      }
      return { id: e.id, cnpj: e.cnpj, razao_social: e.razao_social, nome_fantasia: e.nome_fantasia };
    }
  };
}

async function test01ModoEmpresaUnica() {
  const ctx = await obterContexto({ user: { id: 1, nome: 'Op' } }, depsBase('EMPRESA_UNICA', [EMP_A]));
  assert.strictEqual(ctx.modo_operacao, 'EMPRESA_UNICA');
}

async function test02ModoMultiempresa() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('MULTIEMPRESA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.modo_operacao, 'MULTIEMPRESA');
}

async function test03SelecionadaValida() {
  const ctx = await obterContexto(
    { user: { id: 1 }, empresaId: 3 },
    depsBase('EMPRESA_UNICA', [EMP_A, EMP_B])
  );
  assert.strictEqual(ctx.empresa_selecionada.id, 3);
  assert.strictEqual(ctx.contexto.empresa_id, 3);
}

async function test04MultiempresaNull() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('MULTIEMPRESA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.empresa_selecionada, null);
  assert.strictEqual(ctx.contexto.empresa_id, null);
}

async function test05EmpresaUnicaExigeSelecao() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('EMPRESA_UNICA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.empresa_selecionada, null);
  assert.strictEqual(ctx.exige_selecao, true);
  assert.strictEqual(ctx.pronto_para_checkout, false);
}

async function test06UnicaDisponivelAuto() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('EMPRESA_UNICA', [EMP_B]));
  assert.strictEqual(ctx.empresa_selecionada.id, 3);
  assert.strictEqual(ctx.contexto.origem_selecao, 'UNICA_DISPONIVEL');
}

async function test07NenhumaEmpresa() {
  await assert.rejects(
    () => obterContexto({ user: { id: 9, nome: 'Op' } }, depsBase('EMPRESA_UNICA', [])),
    (err) => err.code === 'NENHUMA_EMPRESA_DISPONIVEL'
  );
}

async function test08InexistenteNaoSeleciona() {
  await assert.rejects(
    () => selecionarEmpresa({ empresa_id: 99 }, { user: { id: 1 } }, {
      ...depsBase('EMPRESA_UNICA', [EMP_A]),
      EmpresaService: mockEmpresaService({ 2: EMP_A })
    }),
    (err) => err.code === 'EMPRESA_NAO_ENCONTRADA'
  );
}

async function test09InativaNaoSeleciona() {
  await assert.rejects(
    () => selecionarEmpresa({ empresa_id: 8 }, { user: { id: 1 } }, {
      ...depsBase('EMPRESA_UNICA', [EMP_A]),
      EmpresaService: mockEmpresaService({ 8: EMP_INATIVA, 2: EMP_A })
    }),
    (err) => err.code === 'EMPRESA_INATIVA'
  );
}

async function test10NuncaEmpresa1() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('EMPRESA_UNICA', [EMP_A, EMP_B]));
  assert.notStrictEqual(ctx.contexto.empresa_id, 1);
  assert.strictEqual(ctx.empresa_selecionada, null);
}

async function test11SelecaoNaoAlteraEstoque() {
  const blob = src('backend/services/pdv-universal/PDVUniversalContextService.js')
    + src('backend/rotas/pdv-universal.js');
  assert.ok(!/debitarSaldo|creditarSaldo|estoque_empresa/.test(blob));
}

async function test12SelecaoNaoCriaVenda() {
  const blob = src('backend/services/pdv-universal/PDVUniversalContextService.js');
  assert.ok(!/criarVenda|INSERT INTO vendas/.test(blob));
}

async function test13SelecaoNaoCriaAtendimento() {
  const blob = src('backend/services/pdv-universal/PDVUniversalContextService.js');
  assert.ok(!/criarAtendimento/.test(blob));
}

async function test14CapsUnica() {
  const caps = capacidadesParaModo('EMPRESA_UNICA');
  assert.strictEqual(caps.exige_empresa_unica_para_checkout, true);
  assert.strictEqual(caps.permite_multiplas_empresas_no_atendimento, false);
  assert.strictEqual(caps.empresa_por_item, false);
}

async function test15CapsMulti() {
  const caps = capacidadesParaModo('MULTIEMPRESA');
  assert.strictEqual(caps.exige_empresa_unica_para_checkout, false);
  assert.strictEqual(caps.permite_multiplas_empresas_no_atendimento, true);
  assert.strictEqual(caps.empresa_por_item, true);
}

async function test16ContextoNaoSubstituiItem() {
  assert.strictEqual(ctxSvc.empresaContextoNaoSubstituiItem(), true);
  assert.throws(
    () => validarItensEntradaAtendimento([{
      produtoId: 10, quantidade: 1, valorUnitario: 5
    }]),
    (err) => err.code === 'EMPRESA_OBRIGATORIA' || err.code === 'ITEM_ATENDIMENTO_INVALIDO'
  );
}

async function test17MuvCompativel() {
  const ctx = await obterContexto({ user: { id: 1 }, empresaId: 2 }, depsBase('MULTIEMPRESA', [EMP_A, EMP_B]));
  assert.strictEqual(ctx.integracao.porta, 'AtendimentoMultiempresaService');
  assert.strictEqual(ctx.contexto.empresa_selecionada_nao_substitui_item, true);
  const itens = validarItensEntradaAtendimento([
    { produtoId: 1, empresaId: 2, quantidade: 1, valorUnitario: 1 },
    { produtoId: 2, empresaId: 3, quantidade: 1, valorUnitario: 1 }
  ]);
  assert.strictEqual(itens[0].empresaId, 2);
  assert.strictEqual(itens[1].empresaId, 3);
}

async function test18SemSegredo() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('MULTIEMPRESA', [EMP_A]));
  const blob = JSON.stringify(ctx);
  assert.ok(!/token_csc|certificado_senha|certificado_pfx|path_certificado/.test(blob));
}

async function test19EndpointAutenticado() {
  const server = src('backend/server.js');
  assert.ok(server.includes("app.use('/api/pdv-universal', verificarToken"));
}

async function test20Regressao0501() {
  const ctx = await obterContexto({}, depsBase('MULTIEMPRESA', []));
  assert.strictEqual(ctx.camada, 'PDV_UNIVERSAL');
  assert.ok(ctx.contexto);
  assert.ok(ctx.capacidades);
  assert.strictEqual(ctx.contexto.empresa_id, null);
  assert.ok(!ctx.capacidades.atendimento === false || ctx.capacidades.multiempresa === true);
}

async function test21TrocaEmpresa() {
  const deps = {
    ...depsBase('EMPRESA_UNICA', [EMP_A, EMP_B]),
    EmpresaService: mockEmpresaService({ 2: EMP_A, 3: EMP_B })
  };
  const a = await selecionarEmpresa({ empresa_id: 2 }, { user: { id: 1 } }, deps);
  const b = await selecionarEmpresa({ empresa_id: 3 }, { user: { id: 1 } }, deps);
  assert.strictEqual(a.contexto.empresa_id, 2);
  assert.strictEqual(b.contexto.empresa_id, 3);
}

async function test22SelecionadaInvalida() {
  await assert.rejects(
    () => obterContexto({ user: { id: 1 }, empresaId: 1 }, depsBase('EMPRESA_UNICA', [EMP_A, EMP_B])),
    (err) => err.code === 'EMPRESA_OPERACIONAL_INVALIDA'
  );
}

async function test23Idempotencia() {
  const deps = {
    ...depsBase('MULTIEMPRESA', [EMP_A, EMP_B]),
    EmpresaService: mockEmpresaService({ 2: EMP_A, 3: EMP_B })
  };
  const a = await selecionarEmpresa({ empresa_id: 2 }, { user: { id: 1 } }, deps);
  const b = await selecionarEmpresa({ empresaId: 2 }, { user: { id: 1 } }, deps);
  assert.strictEqual(a.contexto.empresa_id, b.contexto.empresa_id);
}

async function test24DivergenciaIds() {
  await assert.rejects(
    () => selecionarEmpresa({ empresa_id: 2, empresaId: 3 }, { user: { id: 1 } }, {
      ...depsBase('EMPRESA_UNICA', [EMP_A, EMP_B]),
      EmpresaService: mockEmpresaService({ 2: EMP_A, 3: EMP_B })
    }),
    (err) => err.code === 'CONTEXTO_OPERACIONAL_INVALIDO'
  );
}

async function test25InativaFiltradaDaLista() {
  const ctx = await obterContexto({ user: { id: 1 } }, depsBase('MULTIEMPRESA', [EMP_A, EMP_INATIVA]));
  assert.ok(ctx.empresas_disponiveis.every((e) => e.id !== 8));
}

async function run() {
  const testes = [
    test01ModoEmpresaUnica,
    test02ModoMultiempresa,
    test03SelecionadaValida,
    test04MultiempresaNull,
    test05EmpresaUnicaExigeSelecao,
    test06UnicaDisponivelAuto,
    test07NenhumaEmpresa,
    test08InexistenteNaoSeleciona,
    test09InativaNaoSeleciona,
    test10NuncaEmpresa1,
    test11SelecaoNaoAlteraEstoque,
    test12SelecaoNaoCriaVenda,
    test13SelecaoNaoCriaAtendimento,
    test14CapsUnica,
    test15CapsMulti,
    test16ContextoNaoSubstituiItem,
    test17MuvCompativel,
    test18SemSegredo,
    test19EndpointAutenticado,
    test20Regressao0501,
    test21TrocaEmpresa,
    test22SelecionadaInvalida,
    test23Idempotencia,
    test24DivergenciaIds,
    test25InativaFiltradaDaLista
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
