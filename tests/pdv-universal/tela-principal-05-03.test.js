/**
 * Sprint 05.03 — tela principal do PDV Universal (somente contexto oficial).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ctxUnica = {
  modo_operacao: 'EMPRESA_UNICA',
  empresa_selecionada: { id: 4, nome: 'Pastelaria', cnpj: '11' },
  empresas_disponiveis: [{ id: 4, nome: 'Pastelaria', cnpj: '11', ativa: true }],
  exige_selecao: false,
  capacidades: {
    permite_selecao_empresa: true,
    exige_empresa_unica_para_checkout: true,
    permite_multiplas_empresas_no_atendimento: false,
    empresa_por_item: false
  }
};

const ctxExige = {
  modo_operacao: 'EMPRESA_UNICA',
  empresa_selecionada: null,
  empresas_disponiveis: [
    { id: 2, nome: 'Empresa A' },
    { id: 3, nome: 'Empresa B' }
  ],
  exige_selecao: true,
  capacidades: {
    permite_selecao_empresa: true,
    exige_empresa_unica_para_checkout: true,
    permite_multiplas_empresas_no_atendimento: false,
    empresa_por_item: false
  }
};

const ctxMulti = {
  modo_operacao: 'MULTIEMPRESA',
  empresa_selecionada: null,
  empresas_disponiveis: [{ id: 2, nome: 'A' }, { id: 3, nome: 'B' }],
  exige_selecao: false,
  capacidades: {
    permite_selecao_empresa: true,
    exige_empresa_unica_para_checkout: false,
    permite_multiplas_empresas_no_atendimento: true,
    empresa_por_item: true
  }
};

function test01FonteOficial() {
  assert.ok(tela.urlContexto().endsWith('/pdv-universal/contexto'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('/pdv-universal/contexto'));
}

function test02ModoNaoHardcoded() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!/modo_operacao_venda\s*=\s*['"]EMPRESA_UNICA['"]/.test(js));
  assert.strictEqual(tela.rotuloModo({}), '—');
  assert.strictEqual(tela.rotuloModo(ctxUnica), 'EMPRESA ÚNICA');
  assert.strictEqual(tela.rotuloModo(ctxMulti), 'MULTIEMPRESA');
}

function test03EmpresaResolvida() {
  const m = tela.montarModeloVisual(ctxUnica);
  assert.strictEqual(m.empresa_rotulo, 'Pastelaria');
  assert.strictEqual(m.empresa_id, 4);
}

function test04ExigeSelecao() {
  const caps = tela.aplicarCapabilities(ctxExige);
  assert.strictEqual(caps.mostrar_seletor, true);
  assert.strictEqual(tela.rotuloEmpresa(ctxExige), null);
}

function test05MultiNull() {
  assert.strictEqual(tela.rotuloEmpresa(ctxMulti), null);
  assert.strictEqual(tela.aplicarCapabilities(ctxMulti).mostrar_painel_empresas_atendimento, true);
}

function test06NenhumaEmpresa() {
  const err = { code: 'NENHUMA_EMPRESA_DISPONIVEL' };
  assert.ok(tela.mensagemErro(err).toLowerCase().includes('nenhuma empresa'));
}

function test07ListaSoBackend() {
  const lista = tela.empresasDoContexto(ctxExige);
  assert.deepStrictEqual(lista.map((e) => e.id), [2, 3]);
  assert.ok(!src('frontend/pdv-universal/index.html').includes('Empresa A hardcoded'));
}

async function test08SelecaoEndpointOficial() {
  const chamadas = [];
  const fetchFn = async (url, op) => {
    chamadas.push({ url, op });
    return {
      ok: true,
      json: async () => (op.method === 'PUT' ? { sucesso: true } : ctxUnica)
    };
  };
  await tela.selecionarEmpresaOperacional(4, fetchFn);
  assert.ok(chamadas[0].url.endsWith('/pdv-universal/contexto/empresa'));
  assert.strictEqual(chamadas[0].op.method, 'PUT');
  assert.deepStrictEqual(JSON.parse(chamadas[0].op.body), { empresa_id: 4 });
  assert.ok(chamadas[1].url.endsWith('/pdv-universal/contexto'));
}

function test09NaoAssumeEmpresa1() {
  assert.strictEqual(tela.montarModeloVisual(ctxExige).empresa_id, null);
  assert.ok(tela.nuncaAssumirEmpresaUm(ctxExige));
  assert.ok(!src('frontend/pdv-universal/pdv-universal.js').includes('empresa_id = 1'));
}

function test10Capabilities() {
  const u = tela.aplicarCapabilities(ctxUnica);
  assert.strictEqual(u.exige_empresa_unica_para_checkout, true);
  assert.strictEqual(u.mostrar_painel_empresas_atendimento, false);
  const m = tela.aplicarCapabilities(ctxMulti);
  assert.strictEqual(m.empresa_por_item, true);
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('function aplicarCapabilities'));
}

function test11FinalizarDesabilitado() {
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('id="pdvu-finalizar"'));
  assert.ok(html.includes('disabled'));
  assert.strictEqual(tela.montarModeloVisual(ctxUnica).finalizar_desabilitado, true);
  assert.strictEqual(tela.aplicarCapabilities(ctxUnica).finalizar_habilitado, false);
}

function test12SemPostVendas() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!/\/api\/vendas/.test(js));
  assert.ok(!/POST/.test(js));
}

function test13SemAtendimentoMuv() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!js.includes('AtendimentoMultiempresaService'));
  assert.ok(!js.includes('criarAtendimento('));
}

function test14RetryErro() {
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('pdvu-retry'));
  assert.ok(html.includes('TENTAR NOVAMENTE'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('TENTAR') || html.includes('pdvu-retry'));
}

function test15PdvLegadoIntacto() {
  const server = src('backend/server.js');
  assert.ok(server.includes("frontendRoot, 'pdv/index.html'"));
  assert.ok(server.includes("frontendRoot, 'pdv-universal/index.html'"));
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
}

async function run() {
  const testes = [
    test01FonteOficial,
    test02ModoNaoHardcoded,
    test03EmpresaResolvida,
    test04ExigeSelecao,
    test05MultiNull,
    test06NenhumaEmpresa,
    test07ListaSoBackend,
    test08SelecaoEndpointOficial,
    test09NaoAssumeEmpresa1,
    test10Capabilities,
    test11FinalizarDesabilitado,
    test12SemPostVendas,
    test13SemAtendimentoMuv,
    test14RetryErro,
    test15PdvLegadoIntacto
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
