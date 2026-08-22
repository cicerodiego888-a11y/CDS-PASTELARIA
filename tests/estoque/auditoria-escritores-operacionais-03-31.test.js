/**
 * Fase 2 / Implementação 03.31 — auditoria de fechamento dos escritores
 * operacionais de estoque multiempresa.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');

const SRC = {
  portaSaldo: 'services/fiscalNaoFiscal/estoqueSaldosPublico.js',
  portaReserva: 'services/fiscalNaoFiscal/reservasPublico.js',
  ajuste: 'services/ajusteEstoqueService.js',
  recalc: 'services/estoqueFiscalService.js',
  credCompra: 'services/compras/creditoEstoqueCompraViaPorta.js',
  debCompra: 'services/compras/debitoEstoqueCompraViaPorta.js',
  credVenda: 'services/vendas/creditoEstoqueVendaViaPorta.js',
  debVenda: 'services/vendas/debitoEstoqueVendaViaPorta.js',
  pdvReserva: 'services/estoque/EstoqueReservaService.js',
  pdvConsumo: 'services/estoque/EstoqueConsumoReserva.js',
  nfeRevert: 'services/fiscal/estoqueNfeDevolucaoVenda.js',
  ponte: 'services/estoque/pedidoReservaPonteNucleo.js',
  repair: 'motores/comercial/ReservaRepairService.js',
  mts: 'motores/mts/MtsService.js',
  comercial: 'motores/comercial/MotorComercialService.js',
  produtos: 'rotas/produtos.js',
  vendas: 'rotas/vendas.js',
  lotes: 'services/lotesService.js',
  migracaoUnidades: 'services/migracaoConversaoUnidades.js',
  cert: 'certification/ReleaseCertificationService.js'
};

function abs(rel) {
  return path.join(BACKEND, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function walkJs(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walkJs(full, acc);
    } else if (ent.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function relBackend(full) {
  return path.relative(BACKEND, full).replace(/\\/g, '/');
}

const CLASSIFICACAO = Object.freeze([
  { fluxo: 'ajuste administrativo / saldo inicial / recálculo / importação', arquivo: SRC.ajuste, tipo: 'saldo', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.28)' },
  { fluxo: 'recálculo HTTP', arquivo: SRC.recalc, tipo: 'saldo', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.28)' },
  { fluxo: 'crédito compra', arquivo: SRC.credCompra, tipo: 'saldo', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.27)' },
  { fluxo: 'débito compra / cancel / devolução compra', arquivo: SRC.debCompra, tipo: 'saldo', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.27)' },
  { fluxo: 'baixa venda', arquivo: SRC.debVenda, tipo: 'saldo', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.25)' },
  { fluxo: 'crédito cancel/devolução venda', arquivo: SRC.credVenda, tipo: 'saldo', classe: 'B', empresaId: 'req.empresaId', acao: 'corrigido nesta Sprint' },
  { fluxo: 'NF-e devolução venda (retorno + revert)', arquivo: SRC.nfeRevert, tipo: 'saldo', classe: 'B', empresaId: 'req.empresaId', acao: 'corrigido nesta Sprint' },
  { fluxo: 'reservas PDV', arquivo: SRC.pdvReserva, tipo: 'reserva', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.26)' },
  { fluxo: 'consumo reserva PDV', arquivo: SRC.pdvConsumo, tipo: 'reserva', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.26)' },
  { fluxo: 'Pedido / Expedição → Motor Comercial → MTS', arquivo: SRC.comercial, tipo: 'saldo', classe: 'A', empresaId: 'params.empresaId', acao: 'não alterar (03.29/03.30)' },
  { fluxo: 'MTS F↔NF', arquivo: SRC.mts, tipo: 'saldo', classe: 'A', empresaId: 'params.empresaId', acao: 'não alterar (03.29)' },
  { fluxo: 'consumo reserva pedido (ponte)', arquivo: SRC.ponte, tipo: 'reserva', classe: 'C', empresaId: 'opcoes.empresaId ou COMPAT', acao: 'COMPAT quando caller não tem empresa' },
  { fluxo: 'ReservaRepairService', arquivo: SRC.repair, tipo: 'reserva', classe: 'C', empresaId: 'ausente (sem HTTP)', acao: 'COMPAT; sem rota' },
  { fluxo: 'CREATE produto saldo 0 + crédito inicial', arquivo: SRC.produtos, tipo: 'saldo', classe: 'A', empresaId: 'req.empresaId', acao: 'não alterar (03.8/03.28)' },
  { fluxo: 'lotes atualizarEstoqueConsolidado', arquivo: SRC.lotes, tipo: 'EA legado', classe: 'D', empresaId: 'n/a', acao: 'código morto (03.9/03.10)' },
  { fluxo: 'migração conversão unidades', arquivo: SRC.migracaoUnidades, tipo: 'cadastro', classe: 'D', empresaId: 'n/a', acao: 'não toca saldo' },
  { fluxo: 'certificação ReleaseCertification', arquivo: SRC.cert, tipo: 'fixture', classe: 'D', empresaId: 'n/a', acao: 'não migrar' },
  { fluxo: 'produção / ficha técnica / transformação', arquivo: '(inexistente)', tipo: 'saldo', classe: '—', empresaId: 'n/a', acao: 'domínio inexistente' }
]);

function arquivosComChamada(re) {
  const hits = [];
  for (const file of walkJs(BACKEND)) {
    const src = fs.readFileSync(file, 'utf8');
    if (re.test(src)) hits.push(relBackend(file));
  }
  return hits.sort();
}

function test01EscritoresEncontrados() {
  const saldos = arquivosComChamada(/estoqueSaldosPublico|creditarSaldo|debitarSaldo/);
  const reservas = arquivosComChamada(/reservasPublico|reservarQuantidade|liberarQuantidadeReservada/);
  assert.ok(saldos.includes(SRC.portaSaldo));
  assert.ok(saldos.includes(SRC.ajuste));
  assert.ok(saldos.includes(SRC.credCompra));
  assert.ok(saldos.includes(SRC.debCompra));
  assert.ok(saldos.includes(SRC.credVenda));
  assert.ok(saldos.includes(SRC.debVenda));
  assert.ok(saldos.includes(SRC.mts));
  assert.ok(saldos.includes(SRC.nfeRevert));
  assert.ok(reservas.includes(SRC.portaReserva));
  assert.ok(reservas.includes(SRC.pdvReserva));
  assert.ok(reservas.includes(SRC.pdvConsumo));
  assert.ok(reservas.includes(SRC.ponte));
  assert.ok(reservas.includes(SRC.repair));
  assert.ok(!saldos.some((f) => /ficha.?tecnica|producaoEstoque|transformacaoEstoque/i.test(f)));
}

function test02Classificacao() {
  const classes = new Set(CLASSIFICACAO.map((r) => r.classe));
  assert.ok(classes.has('A'));
  assert.ok(classes.has('B'));
  assert.ok(classes.has('C'));
  assert.ok(classes.has('D'));
  const b = CLASSIFICACAO.filter((r) => r.classe === 'B');
  assert.strictEqual(b.length, 2);
  assert.ok(b.every((r) => r.acao.includes('corrigido')));
  const producao = CLASSIFICACAO.find((r) => r.fluxo.startsWith('produção'));
  assert.strictEqual(producao.arquivo, '(inexistente)');
}

function test03SemSqlDiretoNovo() {
  const re = /UPDATE\s+produtos\b[\s\S]{0,500}?SET[\s\S]{0,400}?(saldo_fiscal|saldo_nao_fiscal|estoque_atual|reservado_fiscal|reservado_nao_fiscal)\s*=/i;
  const allow = new Set([
    SRC.portaSaldo,
    SRC.portaReserva,
    SRC.lotes,
    SRC.cert,
    'scripts/backfill-saldos-fiscais.js'
  ]);
  const hits = [];
  for (const file of walkJs(BACKEND)) {
    const rel = relBackend(file);
    const src = fs.readFileSync(file, 'utf8');
    if (!re.test(src)) continue;
    if (!allow.has(rel)) hits.push(rel);
  }
  assert.deepStrictEqual(hits, [], `SQL direto de saldo fora da porta: ${hits.join(', ')}`);
}

function test04PortaCentralizada() {
  const credVenda = read(SRC.credVenda);
  const nfe = read(SRC.nfeRevert);
  assert.ok(credVenda.includes("require('../fiscalNaoFiscal/estoqueSaldosPublico')"));
  assert.ok(credVenda.includes('creditarSaldo'));
  assert.ok(!credVenda.includes('EstoqueEmpresaService'));
  assert.ok(nfe.includes("require('../fiscalNaoFiscal/estoqueSaldosPublico')"));
  assert.ok(nfe.includes('debitarSaldo'));
  assert.ok(!nfe.includes('EstoqueEmpresaService'));
  assert.ok(!fs.existsSync(path.join(BACKEND, 'services/estoque/portaParalela.js')));
}

function test05EmpresaIdChegaCorrigidos() {
  const credVenda = read(SRC.credVenda);
  const nfe = read(SRC.nfeRevert);
  const vendas = read(SRC.vendas);
  const emitir = read('services/fiscal/nfeDevolucaoVenda.js');
  assert.ok(credVenda.includes('resolverEmpresaId(req && req.empresaId)'));
  assert.ok(credVenda.includes('resolverEmpresaId(opcoes.empresaId)'));
  assert.ok(nfe.includes('resolverEmpresaId(opcoes.empresaId)'));
  assert.ok(nfe.includes('optsCredito'));
  assert.ok(vendas.includes('empresaId: resolverEmpresaId(req.empresaId)'));
  assert.ok(emitir.includes('empresaId: opcoes.empresaId'));
}

function test06BodyNaoSubstitui() {
  const credVenda = read(SRC.credVenda);
  const nfe = read(SRC.nfeRevert);
  const vendas = read(SRC.vendas);
  assert.ok(!credVenda.includes('empresaIdDoReqOperacional'));
  assert.ok(!credVenda.includes('opcoes.contexto'));
  assert.ok(!nfe.includes('opcoes.contexto'));
  assert.ok(!/empresaId:\s*req\.body/.test(vendas));
}

function test07QueryNaoSubstitui() {
  const credVenda = read(SRC.credVenda);
  const vendas = read(SRC.vendas);
  assert.ok(!credVenda.includes('req.query'));
  assert.ok(!/empresaId:\s*req\.query/.test(vendas));
}

function test08IsolamentoDocumentado() {
  const b = CLASSIFICACAO.filter((r) => r.classe === 'B');
  assert.ok(b.some((r) => r.arquivo === SRC.credVenda));
  assert.ok(b.some((r) => r.arquivo === SRC.nfeRevert));
}

function test09CompatPreservado() {
  const credVenda = read(SRC.credVenda);
  const nfe = read(SRC.nfeRevert);
  const repair = read(SRC.repair);
  assert.ok(credVenda.includes('COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA'));
  assert.ok(credVenda.includes('modoLegadoSemEmpresa: true'));
  assert.ok(nfe.includes('COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA'));
  assert.ok(repair.includes('COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA') || repair.includes('modoLegadoSemEmpresa'));
  assert.ok(!credVenda.includes('empresaId = 1'));
  assert.ok(!nfe.includes('empresaId = 1'));
}

function test10RegressaoDominios() {
  const js = walkJs(BACKEND).map(relBackend).join('\n');
  assert.ok(!/ficha_tecnica|fichaTecnica/.test(js) || !/creditarSaldo|debitarSaldo/.test(read(SRC.ajuste)));
  const producaoWriters = arquivosComChamada(/consumoInsumo|baixaIngrediente|transformarEstoque/);
  assert.deepStrictEqual(producaoWriters, []);
  assert.ok(read(SRC.ajuste).includes('empresaIdDoReqAjuste') || read(SRC.ajuste).includes('resolverEmpresaId(req && req.empresaId)'));
  assert.ok(read(SRC.debVenda).includes('resolverEmpresaId(req && req.empresaId)'));
  assert.ok(read(SRC.pdvReserva).includes('empresaIdDoReqReservaPdv') || read(SRC.pdvReserva).includes('resolverEmpresaId(req && req.empresaId)'));
  const muc = fs.readFileSync(path.join(BACKEND, 'motores/muc/index.js'), 'utf8');
  assert.ok(!muc.includes('estoqueSaldosPublico'));
  assert.ok(!muc.includes('creditarSaldo'));
}

function main() {
  const testes = [
    ['01 escritores operacionais encontrados', test01EscritoresEncontrados],
    ['02 classificacao A/B/C/D', test02Classificacao],
    ['03 nenhum SQL direto novo', test03SemSqlDiretoNovo],
    ['04 porta publica centralizada', test04PortaCentralizada],
    ['05 empresaId chega aos fluxos corrigidos', test05EmpresaIdChegaCorrigidos],
    ['06 body nao substitui req.empresaId', test06BodyNaoSubstitui],
    ['07 query nao substitui req.empresaId', test07QueryNaoSubstitui],
    ['08 isolamento A/B no dominio corrigido', test08IsolamentoDocumentado],
    ['09 COMPAT preservado sem contexto', test09CompatPreservado],
    ['10 regressao / dominios ausentes', test10RegressaoDominios]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nauditoria-escritores-operacionais-03-31: ${ok}/${testes.length} OK`);
}

main();
