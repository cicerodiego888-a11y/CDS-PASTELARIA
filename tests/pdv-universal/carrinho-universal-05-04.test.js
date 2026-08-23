/**
 * Sprint 05.04 — carrinho universal e identificação operacional por empresa.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cartLib = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const dispSvc = require('../../backend/services/pdv-universal/PDVUniversalDisponibilidadeService');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const EMP_A = { empresa_id: 2, nome: 'Empresa A', disponibilidade: { total: 10, fiscal: 6, nao_fiscal: 4 } };
const EMP_B = { empresa_id: 3, nome: 'Empresa B', disponibilidade: { total: 8, fiscal: 8, nao_fiscal: 0 } };

function test01UnicaSemEmpresaBloqueia() {
  assert.throws(
    () => cartLib.identificarEmpresaOperacional({
      empresa_por_item: false,
      empresa_contexto_id: null,
      empresas_disponiveis: [EMP_A]
    }),
    (e) => e.code === 'EMPRESA_OPERACIONAL_NAO_SELECIONADA'
  );
}

function test02UnicaUsaSelecionada() {
  const r = cartLib.identificarEmpresaOperacional({
    empresa_por_item: false,
    empresa_contexto_id: 2,
    empresas_disponiveis: [EMP_A]
  });
  assert.strictEqual(r.empresa_id, 2);
  assert.strictEqual(r.origem_identificacao_empresa, 'CONTEXTO_EMPRESA_UNICA');
}

function test03NuncaEmpresa1() {
  const r = cartLib.identificarEmpresaOperacional({
    empresa_por_item: true,
    empresas_disponiveis: [EMP_A, EMP_B]
  });
  assert.strictEqual(r.exige_escolha, true);
  assert.strictEqual(r.empresa_id, null);
}

function test04UmaEmpresaAuto() {
  const r = cartLib.identificarEmpresaOperacional({
    empresa_por_item: true,
    empresas_disponiveis: [EMP_B]
  });
  assert.strictEqual(r.empresa_id, 3);
  assert.strictEqual(r.origem_identificacao_empresa, 'UNICA_COM_DISPONIBILIDADE');
}

function test05DuasExigeEscolha() {
  const r = cartLib.identificarEmpresaOperacional({
    empresa_por_item: true,
    empresas_disponiveis: [EMP_A, EMP_B]
  });
  assert.strictEqual(r.exige_escolha, true);
  assert.strictEqual(r.candidatos.length, 2);
}

function test06NenhumaBloqueia() {
  assert.throws(
    () => cartLib.identificarEmpresaOperacional({
      empresa_por_item: true,
      empresas_disponiveis: []
    }),
    (e) => e.code === 'PRODUTO_SEM_DISPONIBILIDADE'
  );
}

async function test07InativaNaoAparece() {
  const dto = await dispSvc.consultarDisponibilidadeProduto(10, { user: { id: 1 } }, {
    listarEmpresasDisponiveis: async () => [
      { id: 2, nome: 'A', ativo: 1 },
      { id: 8, nome: 'Inativa', ativo: 0 }
    ],
    consultarDisponibilidade: async (_p, opts) => ({
      disponivel_total: opts.empresaId === 2 ? 5 : 99,
      disponivel_fiscal: 5,
      disponivel_nao_fiscal: 0
    })
  });
  assert.ok(dto.empresas_disponiveis.every((e) => e.empresa_id !== 8));
}

async function test08EstoqueANaoAutorizaB() {
  assert.throws(
    () => cartLib.identificarEmpresaOperacional({
      empresa_por_item: false,
      empresa_contexto_id: 3,
      empresas_disponiveis: [EMP_A]
    }),
    (e) => e.code === 'PRODUTO_SEM_DISPONIBILIDADE'
  );
}

function test09IdentidadeProdutoEmpresa() {
  assert.strictEqual(cartLib.chaveItem(10, 2), '10:2');
  assert.notStrictEqual(cartLib.chaveItem(10, 2), cartLib.chaveItem(10, 3));
}

function test10MesclaMesmaEmpresa() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 10, empresa_id: 2, quantidade: 2, valor_unitario: 3, descricao: 'Coca' }, 10);
  c.adicionarItem({ produto_id: 10, empresa_id: 2, quantidade: 1, valor_unitario: 3, descricao: 'Coca' }, 10);
  assert.strictEqual(c.obterItens().length, 1);
  assert.strictEqual(c.obterItens()[0].quantidade, 3);
}

function test11NaoMesclaEmpresasDiferentes() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 10, empresa_id: 2, quantidade: 2, valor_unitario: 3 }, 10);
  c.adicionarItem({ produto_id: 10, empresa_id: 3, quantidade: 1, valor_unitario: 3 }, 10);
  assert.strictEqual(c.obterItens().length, 2);
}

function test12QuantidadeZero() {
  const c = cartLib.criarCarrinho();
  assert.throws(
    () => c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 0, valor_unitario: 1 }, 5),
    (e) => e.code === 'QUANTIDADE_INVALIDA'
  );
}

function test13QuantidadeNegativa() {
  const c = cartLib.criarCarrinho();
  assert.throws(
    () => c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: -1, valor_unitario: 1 }, 5),
    (e) => e.code === 'QUANTIDADE_INVALIDA'
  );
}

function test14Remocao() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 1, valor_unitario: 1 }, 5);
  assert.strictEqual(c.removerItem(1, 2), true);
  assert.strictEqual(c.obterItens().length, 0);
}

function test15TotalPreview() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 2, valor_unitario: 12 }, 10);
  c.adicionarItem({ produto_id: 2, empresa_id: 3, quantidade: 3, valor_unitario: 7 }, 10);
  assert.strictEqual(c.calcularTotal(), 45);
}

async function test16SemEstoqueEmpresaZero() {
  const dto = await dispSvc.consultarDisponibilidadeProduto(99, {}, {
    listarEmpresasDisponiveis: async () => [{ id: 2, nome: 'A', ativo: 1 }],
    consultarDisponibilidade: async () => ({
      disponivel_total: 0, disponivel_fiscal: 0, disponivel_nao_fiscal: 0
    })
  });
  assert.strictEqual(dto.empresas_disponiveis.length, 0);
}

async function test17SaldoGlobalNaoAutoriza() {
  const srcDisp = src('backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js');
  assert.ok(srcDisp.includes('consultarDisponibilidade'));
  assert.ok(srcDisp.includes('empresaId: emp.id'));
  assert.ok(!/FROM produtos/.test(srcDisp));
}

function test18AumentoBloqueia() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 4, valor_unitario: 1 }, 5);
  assert.throws(
    () => c.alterarQuantidade(1, 2, 6, 5),
    (e) => e.code === 'ESTOQUE_INSUFICIENTE'
  );
}

function test19Reducao() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 4, valor_unitario: 2 }, 5);
  c.alterarQuantidade(1, 2, 2, 5);
  assert.strictEqual(c.obterItens()[0].quantidade, 2);
  assert.strictEqual(c.obterItens()[0].subtotal, 4);
}

function test20RevalidaDisponibilidade() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('consultarDisponibilidade'));
  assert.ok(js.includes('alterarQuantidade'));
}

function test21SemVenda() {
  const blob = src('backend/rotas/pdv-universal.js')
    + src('backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js');
  assert.ok(!/criarVenda|INSERT INTO vendas/.test(blob));
}

function test22SemAtendimento() {
  const blob = src('backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js');
  assert.ok(!/criarAtendimento/.test(blob));
}

function test23SemReserva() {
  const blob = src('backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js');
  assert.ok(!/reservarQuantidade|reservarAtendimento/.test(blob));
}

function test24FinalizarNaoPaga() {
  const c = cartLib.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 1, valor_unitario: 9 }, 5);
  const r = c.finalizarPreview();
  assert.strictEqual(r.code, 'CHECKOUT_AINDA_NAO_IMPLEMENTADO');
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!/\/api\/tef|OrquestradorPagamento|\/api\/vendas/.test(js));
}

function test25PdvLegado() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
  assert.ok(src('backend/server.js').includes("frontendRoot, 'pdv/index.html'"));
  assert.ok(src('backend/rotas/pdv-universal.js').includes("produtos/:produtoId/disponibilidade"));
}

async function run() {
  const testes = [
    test01UnicaSemEmpresaBloqueia,
    test02UnicaUsaSelecionada,
    test03NuncaEmpresa1,
    test04UmaEmpresaAuto,
    test05DuasExigeEscolha,
    test06NenhumaBloqueia,
    test07InativaNaoAparece,
    test08EstoqueANaoAutorizaB,
    test09IdentidadeProdutoEmpresa,
    test10MesclaMesmaEmpresa,
    test11NaoMesclaEmpresasDiferentes,
    test12QuantidadeZero,
    test13QuantidadeNegativa,
    test14Remocao,
    test15TotalPreview,
    test16SemEstoqueEmpresaZero,
    test17SaldoGlobalNaoAutoriza,
    test18AumentoBloqueia,
    test19Reducao,
    test20RevalidaDisponibilidade,
    test21SemVenda,
    test22SemAtendimento,
    test23SemReserva,
    test24FinalizarNaoPaga,
    test25PdvLegado
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
