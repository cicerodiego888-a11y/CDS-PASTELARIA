/**
 * Sprint 04.01 — invariantes arquiteturais do Motor Universal de Vendas.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const muv = require('../../backend/motores/muv');
const {
  EntidadeUniversal,
  ModoOperacaoVenda,
  EstrategiaDistribuicaoPagamento,
  AtomicidadeMuv,
  resolverModoOperacaoVenda,
  exigirEmpresaIdOperacao,
  validarDistribuicaoPagamento,
  itemExigeEmpresaNoModo,
  PROIBICOES_MUV
} = muv;

const ROOT = path.resolve(__dirname, '../..');

function readRel(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01ModosReconhecidos() {
  assert.strictEqual(resolverModoOperacaoVenda('EMPRESA_UNICA'), ModoOperacaoVenda.EMPRESA_UNICA);
  assert.strictEqual(resolverModoOperacaoVenda('MULTIEMPRESA'), ModoOperacaoVenda.MULTIEMPRESA);
  assert.strictEqual(resolverModoOperacaoVenda({ modo_operacao_venda: 'empresa_unica' }), 'EMPRESA_UNICA');
}

function test02ModoDesconhecidoRejeitado() {
  assert.throws(() => resolverModoOperacaoVenda('PASTELARIA'), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
  assert.throws(() => resolverModoOperacaoVenda('EMPRESA_1'), { code: 'MODO_OPERACAO_VENDA_INVALIDO' });
}

function test03DefaultEmpresaUnica() {
  assert.strictEqual(resolverModoOperacaoVenda(null), ModoOperacaoVenda.EMPRESA_UNICA);
  assert.strictEqual(resolverModoOperacaoVenda(''), ModoOperacaoVenda.EMPRESA_UNICA);
  assert.strictEqual(resolverModoOperacaoVenda({}), ModoOperacaoVenda.EMPRESA_UNICA);
}

function test04EmpresaNaoVemDoBody() {
  assert.throws(() => exigirEmpresaIdOperacao({ body: { empresaId: 1 } }), { code: 'EMPRESA_OBRIGATORIA' });
  assert.throws(() => exigirEmpresaIdOperacao({ empresa_id: 7 }), { code: 'EMPRESA_OBRIGATORIA' });
  assert.throws(() => exigirEmpresaIdOperacao({ cnpj: '11222333000181' }), { code: 'EMPRESA_OBRIGATORIA' });
  assert.strictEqual(exigirEmpresaIdOperacao({ empresaId: 12 }), 12);
}

function test05ProdutoGlobalContrato() {
  assert.strictEqual(PROIBICOES_MUV.naoDuplicarProdutosPorEmpresa, true);
  const produtos = readRel('backend/database.js');
  assert.ok(produtos.includes('CREATE TABLE IF NOT EXISTS produtos'));
  assert.ok(!/CREATE TABLE IF NOT EXISTS produtos_empresa\b/i.test(produtos));
}

function test06EstoqueIsoladoReutilizado() {
  assert.strictEqual(PROIBICOES_MUV.naoCriarEstoqueParalelo, true);
  const porta = readRel('backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
  const reservas = readRel('backend/services/fiscalNaoFiscal/reservasPublico.js');
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  assert.ok(reservas.includes('consultarSaldoParaEmpresa'));
  const muvIdx = readRel('backend/motores/muv/index.js');
  assert.ok(!muvIdx.includes('CREATE TABLE'));
  assert.ok(!readRel('backend/motores/muv/contratos.js').includes('CREATE TABLE'));
}

function test07OperacaoExigeEmpresa() {
  assert.throws(() => exigirEmpresaIdOperacao(null), { code: 'EMPRESA_OBRIGATORIA' });
  assert.throws(() => exigirEmpresaIdOperacao(0), { code: 'EMPRESA_OBRIGATORIA' });
  assert.strictEqual(exigirEmpresaIdOperacao(4), 4);
  assert.strictEqual(itemExigeEmpresaNoModo('MULTIEMPRESA', { empresaId: 3 }), 3);
  assert.strictEqual(itemExigeEmpresaNoModo('EMPRESA_UNICA', { produto_id: 1 }), null);
}

function test08SomaDistribuicao() {
  validarDistribuicaoPagamento(100, [
    { empresaId: 1, valor: 20 },
    { empresaId: 2, valor: 30 },
    { empresaId: 3, valor: 50 }
  ]);
  assert.throws(
    () => validarDistribuicaoPagamento(100, [
      { empresaId: 1, valor: 20 },
      { empresaId: 2, valor: 30 }
    ]),
    { code: 'DISTRIBUICAO_DIVERGENTE' }
  );
}

function test09SemMtsParalelo() {
  assert.strictEqual(PROIBICOES_MUV.naoCriarMtsParalelo, true);
  const muvDir = path.join(ROOT, 'backend/motores/muv');
  for (const nome of fs.readdirSync(muvDir)) {
    const src = fs.readFileSync(path.join(muvDir, nome), 'utf8');
    assert.ok(!/transferirSaldo/.test(src), `${nome} não deve reimplementar MTS`);
    assert.ok(!/debitarSaldo/.test(src), `${nome} não deve reimplementar porta de saldos`);
  }
}

function test10EntidadeAtendimento() {
  assert.strictEqual(EntidadeUniversal.ATENDIMENTO, 'ATENDIMENTO');
  assert.ok(!Object.prototype.hasOwnProperty.call(EntidadeUniversal, 'VENDA_MESTRE'));
  assert.strictEqual(PROIBICOES_MUV.naoSubstituirTabelaVendas, true);
  assert.strictEqual(AtomicidadeMuv.ROLLBACK_TOTAL, 'ROLLBACK_TOTAL');
  assert.ok(EstrategiaDistribuicaoPagamento.PROPORCIONAL);
  const app = readRel('backend/services/vendas/VendaApplicationService.js');
  assert.ok(app.includes('criarVendaComContexto'));
  assert.ok(readRel('backend/services/vendas/VendaOrigin.js').includes('PDV:'));
}

async function main() {
  const testes = [
    ['01 modo EMPRESA_UNICA / MULTIEMPRESA', test01ModosReconhecidos],
    ['02 modo desconhecido rejeitado', test02ModoDesconhecidoRejeitado],
    ['03 default EMPRESA_UNICA', test03DefaultEmpresaUnica],
    ['04 empresa nao inventada pelo body', test04EmpresaNaoVemDoBody],
    ['05 produto continua global', test05ProdutoGlobalContrato],
    ['06 estoque isolado reutilizado', test06EstoqueIsoladoReutilizado],
    ['07 operacao exige empresa_id', test07OperacaoExigeEmpresa],
    ['08 soma distribuicao = pagamento', test08SomaDistribuicao],
    ['09 MUV nao cria MTS/estoque paralelo', test09SemMtsParalelo],
    ['10 entidade ATENDIMENTO e porta existente', test10EntidadeAtendimento]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nmotor-universal-vendas-04-01: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
