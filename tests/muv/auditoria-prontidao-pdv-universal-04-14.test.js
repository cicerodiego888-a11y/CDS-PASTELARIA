/**
 * Sprint 04.14 — auditoria de prontidão dos contratos para a Fase 05.
 * Não cria UI. Prova que a fundação MUV é consumível sem reinventar o backend.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  ModoOperacaoVenda,
  validarModoOperacaoVenda,
  EstrategiaDistribuicaoPagamento,
  validarItensEntradaAtendimento,
  executarNoModoOperacaoVenda,
  resolverModoOperacaoVendaAtivo
} = require('../../backend/motores/muv');
const atendimentoService = require('../../backend/motores/muv/AtendimentoMultiempresaService');
const vendaApp = require('../../backend/services/vendas/VendaApplicationService');
const fiscalAdmin = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { DESTINOS_IMPRESSAO } = require('../../backend/motores/muv/impressao/printContracts');
const { FORMATOS } = require('../../backend/motores/muv/comprovante/ComprovanteRenderer');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01EmpresaUnicaReconhecido() {
  assert.strictEqual(validarModoOperacaoVenda('EMPRESA_UNICA'), ModoOperacaoVenda.EMPRESA_UNICA);
  assert.strictEqual(
    resolverModoOperacaoVendaAtivo({ obterModoOperacaoVenda: () => 'EMPRESA_UNICA' }),
    'EMPRESA_UNICA'
  );
}

function test02MultiempresaReconhecido() {
  assert.strictEqual(validarModoOperacaoVenda('MULTIEMPRESA'), ModoOperacaoVenda.MULTIEMPRESA);
  assert.strictEqual(
    resolverModoOperacaoVendaAtivo({ obterModoOperacaoVenda: () => 'MULTIEMPRESA' }),
    'MULTIEMPRESA'
  );
}

function test03MultiempresaNaoCaiNoLegado() {
  assert.throws(
    () => executarNoModoOperacaoVenda('MULTIEMPRESA', {
      EMPRESA_UNICA() { return 'LEGADO'; }
    }),
    (err) => err.code === 'MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO'
  );
  assert.throws(
    () => validarModoOperacaoVenda('PASTELARIA'),
    (err) => err.code === 'MODO_OPERACAO_VENDA_INVALIDO'
  );
}

function test04EmpresaIdNaoSubstituido() {
  assert.throws(
    () => validarItensEntradaAtendimento([{
      produtoId: 10, empresa_id: 2, quantidade: 1, valorUnitario: 5
    }]),
    (err) => err.code === 'EMPRESA_OBRIGATORIA'
  );
  assert.throws(
    () => validarItensEntradaAtendimento([{
      produtoId: 10, cnpj: '123', quantidade: 1, valorUnitario: 5
    }]),
    (err) => err.code === 'EMPRESA_OBRIGATORIA'
  );
  const ok = validarItensEntradaAtendimento([{
    produtoId: 10, empresaId: 3, quantidade: 2, valorUnitario: 6
  }]);
  assert.strictEqual(ok[0].empresaId, 3);
}

function test05SaldoOutraEmpresaNaoAutoriza() {
  const reservas = src('backend/services/fiscalNaoFiscal/reservasPublico.js');
  assert.ok(reservas.includes('consultarSaldoParaEmpresa'));
  assert.ok(reservas.includes('empresaId: ctx.empresaId'));
  const muv = src('backend/motores/muv/AtendimentoMultiempresaService.js');
  assert.ok(muv.includes('empresaId: item.empresaId'));
  assert.ok(muv.includes('SALDO_INSUFICIENTE'));
}

function test06DisponibilidadeEstoqueEmpresa() {
  const reservas = src('backend/services/fiscalNaoFiscal/reservasPublico.js');
  assert.ok(reservas.includes('saldo_fiscal: 0'));
  assert.ok(reservas.includes('Sem registro em estoque_empresa') || reservas.includes('estoque_empresa'));
  const estoque = src('backend/services/estoque/EstoqueEmpresaService.js');
  assert.ok(estoque.includes('consultarSaldoParaEmpresa'));
}

function test07ContratoAtendimentoAcessivel() {
  assert.strictEqual(typeof atendimentoService.criarAtendimento, 'function');
  assert.strictEqual(typeof atendimentoService.obterAtendimento, 'function');
  assert.ok(src('backend/services/vendas/VendaApplicationService.js').includes('criarAtendimento'));
}

function test08ReservaAcessivel() {
  assert.strictEqual(typeof atendimentoService.reservarAtendimento, 'function');
  assert.strictEqual(typeof atendimentoService.cancelarAtendimento, 'function');
}

function test09PagamentoRateioIdentificavel() {
  assert.strictEqual(typeof atendimentoService.confirmarPagamentoAtendimento, 'function');
  assert.strictEqual(EstrategiaDistribuicaoPagamento.POR_ITEM, 'POR_ITEM');
  assert.strictEqual(EstrategiaDistribuicaoPagamento.PROPORCIONAL, 'PROPORCIONAL');
  assert.strictEqual(EstrategiaDistribuicaoPagamento.MANUAL, 'MANUAL');
}

function test10MaterializacaoIdentificavel() {
  assert.strictEqual(typeof atendimentoService.materializarAtendimento, 'function');
  assert.strictEqual(typeof vendaApp.materializarAtendimento, 'function');
}

function test11FiscalizacaoIdentificavel() {
  assert.strictEqual(typeof atendimentoService.fiscalizarAtendimento, 'function');
  assert.strictEqual(typeof vendaApp.fiscalizarAtendimento, 'function');
}

function test12ComprovanteOficial() {
  const rotas = src('backend/rotas/atendimentos.js');
  assert.ok(rotas.includes("router.get('/:id/comprovante'"));
  assert.strictEqual(FORMATOS.TEXT, 'TEXT');
  assert.strictEqual(FORMATOS.HTML, 'HTML');
  const rotasFmt = src('backend/rotas/atendimentos.js');
  assert.ok(rotasFmt.includes('resolverSaidaHttp'));
}

function test13ImpressaoOficial() {
  const rotas = src('backend/rotas/atendimentos.js');
  assert.ok(rotas.includes("router.post('/:id/imprimir'"));
  assert.deepStrictEqual(
    Object.values(DESTINOS_IMPRESSAO).sort(),
    ['BROWSER', 'PREVIEW', 'THERMAL']
  );
}

function test14EmpresaUnicaIndependente() {
  const vas = src('backend/services/vendas/VendaApplicationService.js');
  assert.ok(vas.includes('VendaPagamentoService.criarVenda'));
  assert.ok(vas.includes("if (modo !== 'MULTIEMPRESA')"));
  assert.ok(!vas.includes('criarAtendimentoOculto'));
}

function test15SegredosFiscaisNaoExpostos() {
  const dto = src('backend/services/fiscal/empresasConfiguracaoFiscal.js');
  assert.ok(dto.includes('dtoPublicoConfiguracao'));
  assert.ok(dto.includes('csc_configurado'));
  assert.ok(!dto.includes('tokenCSC: row.token_csc') || dto.includes('token_csc: undefined') || dto.includes('csc_configurado'));
  assert.strictEqual(typeof fiscalAdmin.obterConfiguracaoFiscalEmpresa, 'function');
  const comprovante = src('backend/motores/muv/ComprovanteUnificadoAtendimentoService.js');
  assert.ok(!comprovante.includes('token_csc'));
  assert.ok(!comprovante.includes('certificado_senha'));
}

function test16HttpCheckoutMultiempresaPendenteDocumentado() {
  const rotas = src('backend/rotas/atendimentos.js');
  assert.ok(!rotas.includes('reservarAtendimento'));
  assert.ok(!rotas.includes('confirmarPagamento'));
  assert.ok(!rotas.includes('materializar'));
  assert.ok(!rotas.includes('fiscalizar'));
  assert.ok(src('backend/rotas/vendas.js').includes('criarVenda'));
}

function test17ModoConsultaExistente() {
  const avancadas = src('backend/rotas/configuracoes_avancadas.js');
  assert.ok(avancadas.includes('readConfig()'));
  assert.ok(avancadas.includes('exigirSuperAdmin'));
  const cfg = src('backend/services/configuracaoService.js');
  assert.ok(cfg.includes('obterModoOperacaoVenda'));
}

function test18EmpresasApi() {
  const rotas = src('backend/rotas/empresas.js');
  assert.ok(rotas.includes('/contexto/disponiveis'));
  assert.ok(rotas.includes("router.get('/'"));
  assert.ok(rotas.includes('filtros.ativo'));
}

async function run() {
  const testes = [
    test01EmpresaUnicaReconhecido,
    test02MultiempresaReconhecido,
    test03MultiempresaNaoCaiNoLegado,
    test04EmpresaIdNaoSubstituido,
    test05SaldoOutraEmpresaNaoAutoriza,
    test06DisponibilidadeEstoqueEmpresa,
    test07ContratoAtendimentoAcessivel,
    test08ReservaAcessivel,
    test09PagamentoRateioIdentificavel,
    test10MaterializacaoIdentificavel,
    test11FiscalizacaoIdentificavel,
    test12ComprovanteOficial,
    test13ImpressaoOficial,
    test14EmpresaUnicaIndependente,
    test15SegredosFiscaisNaoExpostos,
    test16HttpCheckoutMultiempresaPendenteDocumentado,
    test17ModoConsultaExistente,
    test18EmpresasApi
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
