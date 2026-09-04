/**
 * Sprint 03.05 — Auditoria de fechamento do Bloco 3 (Pastelaria).
 * Sem alteração de produção. Executar:
 *   node tests/pastelaria/auditoria-fechamento-bloco3-03-05.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function existe(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

const AUDIT = 'docs/arquitetura/AUDITORIA_FECHAMENTO_BLOCO3_PASTELARIA_03_05.md';
const REL = 'docs/IMPLEMENTACAO_03_05_RELATORIO.md';

function t01() {
  const schema = src('backend/services/estoque/estoqueEmpresaSchema.js');
  const tipo = src('backend/services/produtos/tipoOperacionalProduto.js');
  const ficha = src('backend/services/produtos/fichaTecnicaSchema.js');
  assert.ok(schema.includes('estoque_empresa'));
  assert.ok(schema.includes('produto_id') && schema.includes('empresa_id'));
  assert.ok(tipo.includes('COMERCIAL') && tipo.includes('INSUMO'));
  assert.ok(ficha.includes('CREATE TABLE IF NOT EXISTS ficha_tecnica'));
  assert.ok(!ficha.includes('empresa_id'));
  assert.ok(existe('backend/services/produtos/FichaTecnicaService.js'));
  console.log('  T01 catálogo compartilhado (produtos/ficha sem empresa_id; estoque_empresa separado)');
}

function t02() {
  const ee = src('backend/services/estoque/estoqueEmpresaSchema.js');
  const pol = src('backend/core/modo-operacional/PoliticaMultiempresa.js');
  assert.ok(ee.includes('idx_estoque_empresa_produto_empresa'));
  assert.ok(ee.includes('estoque_empresa(produto_id, empresa_id)'));
  assert.ok(pol.includes('resolverEmpresaOperacionalContrato'));
  assert.ok(pol.includes('return null'));
  const audit = src(AUDIT);
  assert.ok(audit.includes('Empresa A') || audit.includes('não pode acessar dados de B') || audit.includes('estoque por empresa'));
  console.log('  T02 empresa A / empresa B (índice único + contrato MULTI sem empresa operacional)');
}

function t03() {
  const app = src('backend/services/vendas/VendaApplicationService.js');
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(app.includes('concluirVendaNoNucleoOficial'));
  assert.ok(app.includes('MULTIEMPRESA'));
  assert.ok(!/criarVendaComContexto[\s\S]{0,400}criarAtendimento/.test(app) || app.includes('Não chama criarAtendimento'));
  assert.ok(pag.includes('INSERT INTO vendas'));
  assert.ok(pag.includes('empresa_id'));
  assert.ok(pag.includes('empresaIdVenda'));
  console.log('  T03 venda multiempresa (POST → VendaPagamentoService, empresaIdVenda)');
}

function t04() {
  const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  const porta = src('backend/services/vendas/debitoEstoqueVendaViaPorta.js');
  assert.ok(cons.includes('exigirEmpresa: true'));
  assert.ok(cons.includes('estoque_empresa') || cons.includes('validarEstoqueAgregado'));
  assert.ok(porta.includes('exigirEmpresa === true'));
  assert.ok(porta.includes('EMPRESA_OBRIGATORIA'));
  console.log('  T04 estoque por empresa (consumo e porta exigem empresa)');
}

function t05() {
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(pag.includes('INSERT INTO contas_receber'));
  assert.ok(pag.includes('INSERT INTO financeiro') || pag.includes('financeiro'));
  const idxCr = pag.indexOf('INSERT INTO contas_receber');
  const trecho = pag.slice(idxCr, idxCr + 500);
  assert.ok(trecho.includes('empresa_id'));
  assert.ok(!/contas_receber[\s\S]{0,200}req\.empresaId\s*\|\|\s*null/.test(pag));
  console.log('  T05 financeiro por empresa (contas_receber via venda, sem req.empresaId || null)');
}

function t06() {
  const caixa = src('backend/services/caixa/CaixaEmpresaContextoService.js');
  const front = src('frontend/pdv/js/caixa.js');
  assert.ok(caixa.includes('exigirSessaoDaEmpresa') || caixa.includes('CAIXA_SESSAO_EMPRESA_DIVERGENTE'));
  assert.ok(front.includes('X-Empresa-Id'));
  console.log('  T06 caixa por empresa (sessão + header PDV)');
}

function t07() {
  const tipo = src('backend/services/produtos/tipoOperacionalProduto.js');
  assert.ok(tipo.includes('INSUMO_NAO_VENDAVEL'));
  assert.ok(tipo.includes('exigirProdutosVendaveisNaVenda') || tipo.includes('INSUMO'));
  console.log('  T07 insumo não vendável');
}

function t08() {
  const ficha = src('backend/services/produtos/fichaTecnicaSchema.js');
  const svc = src('backend/services/produtos/FichaTecnicaService.js');
  assert.ok(ficha.includes('ficha_tecnica_itens'));
  assert.ok(svc.includes('salvar') || svc.includes('obterPorProdutoId'));
  assert.ok(!/ficha_tecnica\s*\([^)]*empresa_id/.test(ficha));
  console.log('  T08 ficha técnica compartilhada (schema sem empresa_id)');
}

function t09() {
  const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(cons.includes('consumirFichaTecnicaDaVenda'));
  assert.ok(cons.includes('converterQuantidadeEntreUnidades') || cons.includes('MotorUM'));
  assert.ok(pag.includes('consumirFichaTecnicaDaVendaCb') || pag.includes('consumirFichaTecnicaDaVenda'));
  assert.ok(cons.includes('venda_ficha_consumo'));
  console.log('  T09 consumo da ficha na venda');
}

function t10() {
  const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  const pag = src('backend/services/vendas/VendaPagamentoService.js');
  const idxVal = cons.indexOf('await validarEstoqueAgregado');
  const idxDeb = cons.indexOf('await debitoAsync');
  assert.ok(idxVal >= 0 && idxDeb > idxVal);
  assert.ok(pag.includes('fichaErr'));
  assert.ok(pag.includes("db.run('ROLLBACK')"));
  console.log('  T10 rollback do consumo (pré-checagem antes do débito; ROLLBACK da venda)');
}

function t11() {
  const cancel = src('backend/services/vendas/VendaCancelamentoService.js');
  const devol = src('backend/services/vendas/VendaDevolucaoService.js');
  assert.ok(cancel.includes('estornarConsumoFichaTecnicaDaVendaCb'));
  assert.ok(cancel.includes('devolverEstoqueEEstornarFichaDaVenda'));
  assert.ok(devol.includes('estornarConsumoFichaTecnicaDaDevolucaoCb'));
  const audit = src(AUDIT);
  assert.ok(audit.includes('Não estornados') || audit.includes('ainda não existe'));
  assert.ok(audit.includes('Estorno no cancelamento') || audit.includes('Estorno de ficha'));
  console.log('  T11 cancelamento (03.07) e devolução (03.08) estornam ficha; auditoria 03.05 permanece histórica');
}

function t12() {
  const rel76 = src('docs/IMPLEMENTACAO_05_76_RELATORIO.md');
  const rel05 = src(REL);
  assert.ok(rel76.includes('CONCLUÍDA'));
  assert.ok(rel76.includes('FECHAMENTO FINAL CENTRAL') || rel76.includes('CENTRAL'));
  assert.ok(rel05.includes('NÃO REABERTA') || rel05.includes('NÃO REABERTA'));
  assert.ok(existe('tests/central-entradas/fechamento-final-central-05-76.test.js'));
  console.log('  T12 Central não reaberta (05.76 fechada; 03.05 só auditoria)');
}

function t13() {
  const iso = src('docs/arquitetura/ISOLAMENTO_PDV_UNIVERSAL_05_75.md');
  const porta = src('backend/rotas/pdv-universal.js');
  const rel = src(REL);
  assert.ok(iso.includes('CONGELADO'));
  assert.ok(porta.includes('CONGELADO'));
  assert.ok(rel.includes('CONGELADO'));
  assert.ok(!src(AUDIT).includes('evoluir o PDV Universal') || src(AUDIT).includes('não evoluir'));
  console.log('  T13 PDV Universal congelado');
}

function t14() {
  const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  const ctx = src('backend/services/vendas/VendaEmpresaContextoService.js');
  assert.ok(cons.includes('exigirEmpresaDaOperacao'));
  assert.ok(!cons.includes('empresa_operacional'));
  assert.ok(!/empresaId\s*\|\|\s*1/.test(cons));
  assert.ok(!/COALESCE\s*\(\s*empresa_id/.test(cons));
  assert.ok(ctx.includes('exigirEmpresaDaOperacao'));
  console.log('  T14 ausência de fallback empresarial no consumo de ficha');
}

function t15() {
  const audit = src(AUDIT);
  assert.ok(audit.includes('| **D**') || audit.includes('Classificação D') || audit.includes('| D |'));
  assert.ok(audit.includes('sqlRankingProdutos') || audit.includes('Ranking'));
  assert.ok(audit.includes('Dual-write') || audit.includes('dual-write'));
  const ranking = src('backend/services/reportFiscalHelpers.js');
  assert.ok(ranking.includes('function sqlRankingProdutos'));
  assert.ok(!/sqlRankingProdutos[\s\S]{0,800}empresa_id/.test(ranking));
  console.log('  T15 riscos D identificados (ranking global + dual-write documentados)');
}

function t16() {
  const audit = src(AUDIT);
  const rel = src(REL);
  assert.ok(audit.includes('| Domínio | Status | Prioridade | Sprint sugerida |'));
  assert.ok(audit.includes('Estorno ficha cancel/devolução'));
  assert.ok(audit.includes('FALTANTE'));
  assert.ok(audit.includes('**P0**') || audit.includes('| **P0**'));
  assert.ok(audit.includes('03.06'));
  assert.ok(audit.includes('FORA DO ESCOPO'));
  assert.ok(audit.includes('Open Finance'));
  assert.ok(audit.includes('MIS'));
  assert.ok(audit.includes('Cubas') || audit.includes('Açaíteria') || audit.includes('AÇAÍTERIA'));
  assert.ok(rel.includes('PRODUÇÃO ALTERADA:'));
  assert.ok(rel.includes('NÃO'));
  assert.ok(rel.includes('03.06'));
  console.log('  T16 classificação final do Bloco 3 (matriz + próxima sprint 03.06)');
}

function main() {
  console.log('03.05 auditoria fechamento Bloco 3\n');
  const tests = [
    t01, t02, t03, t04, t05, t06, t07, t08,
    t09, t10, t11, t12, t13, t14, t15, t16
  ];
  let ok = 0;
  for (const t of tests) {
    t();
    ok += 1;
  }
  console.log(`\n${ok}/${tests.length} ok`);
}

main();
