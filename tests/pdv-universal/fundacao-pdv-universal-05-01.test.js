/**
 * Sprint 05.01 — fundação do PDV Universal (contratos, modo, contexto HTTP).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const configService = require('../../backend/services/configuracaoService');
const {
  DEFAULT_MODO_OPERACAO_VENDA,
  ModoOperacaoVenda,
  CAPACIDADES_EMPRESA_UNICA,
  CAPACIDADES_MULTIEMPRESA,
  capacidadesParaModo,
  dtoContemSegredo
} = require('../../backend/motores/pdv-universal/contratos');
const {
  resolverModoOficial,
  obterContexto,
  despacharVenda,
  EmpresaUnicaAdapter,
  MultiempresaAdapter
} = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
const rota = require('../../backend/rotas/pdv-universal');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function depsModo(modo) {
  return { obterModoOperacaoVenda: () => modo };
}

async function test01DefaultEmpresaUnica() {
  assert.strictEqual(DEFAULT_MODO_OPERACAO_VENDA, 'EMPRESA_UNICA');
  assert.strictEqual(configService.DEFAULT.modo_operacao_venda, 'EMPRESA_UNICA');
}

async function test02ResolveEmpresaUnica() {
  assert.strictEqual(resolverModoOficial(depsModo('EMPRESA_UNICA')), 'EMPRESA_UNICA');
}

async function test03ResolveMultiempresa() {
  assert.strictEqual(resolverModoOficial(depsModo('MULTIEMPRESA')), 'MULTIEMPRESA');
}

async function test04Invalido() {
  assert.throws(
    () => resolverModoOficial(depsModo('PASTELARIA')),
    (err) => err.code === 'MODO_OPERACAO_VENDA_INVALIDO'
  );
}

async function test05MultiempresaNaoCaiNoLegado() {
  assert.throws(
    () => EmpresaUnicaAdapter.exigirModoEmpresaUnica(depsModo('MULTIEMPRESA')),
    (err) => err.code === 'MODO_OPERACAO_VENDA_INVALIDO'
  );
  const rec = MultiempresaAdapter.reconhecer(depsModo('MULTIEMPRESA'));
  assert.strictEqual(rec.fonte, 'MUV');
  assert.strictEqual(rec.criaVendaLegada, false);
  assert.strictEqual(rec.porta, 'AtendimentoMultiempresaService');
}

async function test06EmpresaUnicaNaoCriaAtendimento() {
  assert.strictEqual(EmpresaUnicaAdapter.criaAtendimento, false);
  const ctx = await obterContexto({}, {
    ...depsModo('EMPRESA_UNICA'),
    listarEmpresasDisponiveis: async () => []
  });
  assert.strictEqual(ctx.integracao.cria_atendimento, false);
  assert.ok(!ctx.capacidades.atendimento);
}

async function test07ContratoEstavel() {
  const ctx = await obterContexto({ user: { id: 9 } }, {
    ...depsModo('EMPRESA_UNICA'),
    listarEmpresasDisponiveis: async () => [{ id: 4, razao_social: 'A', cnpj: '1', ativo: 1 }]
  });
  assert.strictEqual(ctx.camada, 'PDV_UNIVERSAL');
  assert.ok(ctx.contexto);
  assert.ok(ctx.capacidades);
  assert.ok(Object.prototype.hasOwnProperty.call(ctx.contexto, 'empresa_id'));
  assert.ok(Array.isArray(ctx.contexto.empresas_disponiveis));
  assert.strictEqual(ctx.contexto.operador_id, 9);
}

async function test08CapsEmpresaUnica() {
  const caps = capacidadesParaModo('EMPRESA_UNICA');
  assert.deepStrictEqual(caps, { ...CAPACIDADES_EMPRESA_UNICA });
}

async function test09CapsMultiempresa() {
  const caps = capacidadesParaModo('MULTIEMPRESA');
  assert.deepStrictEqual(caps, { ...CAPACIDADES_MULTIEMPRESA });
}

async function test10EndpointNaoAlteraEstado() {
  const rotas = src('backend/rotas/pdv-universal.js');
  assert.ok(rotas.includes("router.get('/contexto'"));
  assert.ok(rotas.includes("router.put('/contexto/empresa'"));
  const svc = src('backend/motores/pdv-universal/PDVUniversalApplicationService.js');
  assert.ok(!/INSERT |UPDATE |DELETE |BEGIN /.test(svc));
}

async function test11SemSegredoFiscal() {
  const ctx = await obterContexto({}, {
    ...depsModo('MULTIEMPRESA'),
    listarEmpresasDisponiveis: async () => []
  });
  assert.strictEqual(dtoContemSegredo(ctx), false);
  const blob = JSON.stringify(ctx);
  assert.ok(!/token_csc|certificado_senha|certificado_pfx/.test(blob));
}

async function test12NaoAssumeEmpresa1() {
  const ctx = await obterContexto({}, {
    ...depsModo('MULTIEMPRESA'),
    listarEmpresasDisponiveis: async () => []
  });
  assert.strictEqual(ctx.contexto.empresa_id, null);
  assert.notStrictEqual(ctx.contexto.empresa_id, 1);
}

async function test13EmpresaAusentePermitida() {
  const ctx = await obterContexto({ empresaId: null }, {
    ...depsModo('EMPRESA_UNICA'),
    listarEmpresasDisponiveis: async () => []
  });
  assert.strictEqual(ctx.contexto.empresa_id, null);
}

async function test14PdvAtualIntacto() {
  const vendas = src('backend/rotas/vendas.js');
  assert.ok(vendas.includes('criarVenda'));
  const pdv = src('frontend/pdv/js/pdv.js');
  assert.ok(pdv.includes("url: `${API_URL}/vendas`"));
  const server = src('backend/server.js');
  assert.ok(server.includes("app.use('/api/vendas'"));
  assert.ok(server.includes("app.use('/api/pdv-universal'"));
}

async function test15MuvFonteOficial() {
  const rec = MultiempresaAdapter.reconhecer(depsModo('MULTIEMPRESA'));
  assert.strictEqual(rec.fonte, 'MUV');
  const servico = MultiempresaAdapter.obterServico();
  assert.strictEqual(typeof servico.criarAtendimento, 'function');
  assert.strictEqual(typeof servico.reservarAtendimento, 'function');
  assert.strictEqual(typeof servico.confirmarPagamentoAtendimento, 'function');
  const despacho = despacharVenda({}, {}, depsModo('MULTIEMPRESA'));
  assert.strictEqual(despacho.porta, 'AtendimentoMultiempresaService');
}

async function run() {
  const testes = [
    test01DefaultEmpresaUnica,
    test02ResolveEmpresaUnica,
    test03ResolveMultiempresa,
    test04Invalido,
    test05MultiempresaNaoCaiNoLegado,
    test06EmpresaUnicaNaoCriaAtendimento,
    test07ContratoEstavel,
    test08CapsEmpresaUnica,
    test09CapsMultiempresa,
    test10EndpointNaoAlteraEstado,
    test11SemSegredoFiscal,
    test12NaoAssumeEmpresa1,
    test13EmpresaAusentePermitida,
    test14PdvAtualIntacto,
    test15MuvFonteOficial
  ];
  assert.ok(rota);
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
