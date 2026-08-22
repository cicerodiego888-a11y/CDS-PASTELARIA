/**
 * Fase 2 / Implementação 03.10 — auditoria final dos escritores de estoque e reserva.
 *
 * Sem migração. Sem estoque_empresa. Confirma o mapa pós-03.9.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');

const SRC = {
  ajuste: path.join(BACKEND, 'services/ajusteEstoqueService.js'),
  recalc: path.join(BACKEND, 'services/estoqueFiscalService.js'),
  credCompra: path.join(BACKEND, 'services/compras/creditoEstoqueCompraViaPorta.js'),
  debCompra: path.join(BACKEND, 'services/compras/debitoEstoqueCompraViaPorta.js'),
  credVenda: path.join(BACKEND, 'services/vendas/creditoEstoqueVendaViaPorta.js'),
  debVenda: path.join(BACKEND, 'services/vendas/debitoEstoqueVendaViaPorta.js'),
  pdvReserva: path.join(BACKEND, 'services/estoque/EstoqueReservaService.js'),
  pdvConsumo: path.join(BACKEND, 'services/estoque/EstoqueConsumoReserva.js'),
  nfeRevert: path.join(BACKEND, 'services/fiscal/estoqueNfeDevolucaoVenda.js'),
  ponte: path.join(BACKEND, 'services/estoque/pedidoReservaPonteNucleo.js'),
  repair: path.join(BACKEND, 'motores/comercial/ReservaRepairService.js'),
  produtos: path.join(BACKEND, 'rotas/produtos.js'),
  lotes: path.join(BACKEND, 'services/lotesService.js'),
  portaSaldo: path.join(BACKEND, 'services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
  portaReserva: path.join(BACKEND, 'services/fiscalNaoFiscal/reservasPublico.js')
};

const RE_UPDATE_PRODUTOS_OPERACIONAL = /UPDATE\s+produtos\b[\s\S]{0,500}?SET[\s\S]{0,400}?(saldo_fiscal|saldo_nao_fiscal|estoque_atual|reservado_fiscal|reservado_nao_fiscal)\s*=/gi;

const ALLOWLIST_SET = new Set([
  path.normalize(SRC.portaSaldo),
  path.normalize(SRC.portaReserva),
  path.normalize(SRC.lotes),
  path.normalize(path.join(BACKEND, 'certification/ReleaseCertificationService.js')),
  path.normalize(path.join(BACKEND, 'scripts/backfill-saldos-fiscais.js'))
]);

function read(p) {
  return fs.readFileSync(p, 'utf8');
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

function arquivosComSetOperacional() {
  const hits = [];
  for (const file of walkJs(BACKEND)) {
    const src = read(file);
    if (!/UPDATE\s+produtos/i.test(src)) continue;
    if (!RE_UPDATE_PRODUTOS_OPERACIONAL.test(src)) continue;
    hits.push(path.normalize(file));
  }
  return hits;
}

function test01Escritores02xPelaPorta() {
  assert.ok(read(SRC.ajuste).includes('estoqueSaldosPublico'));
  assert.ok(read(SRC.ajuste).includes('creditarSaldo'));
  assert.ok(read(SRC.recalc).includes('estoqueSaldosPublico'));
  assert.ok(read(SRC.credCompra).includes('creditarSaldo'));
  assert.ok(read(SRC.debCompra).includes('debitarSaldo'));
  assert.ok(read(SRC.credVenda).includes('creditarSaldo'));
  assert.ok(read(SRC.debVenda).includes('debitarSaldo'));
  assert.ok(read(SRC.pdvReserva).includes('reservarQuantidade'));
  assert.ok(read(SRC.pdvConsumo).includes('liberarQuantidadeReservada'));
  assert.ok(!/UPDATE\s+produtos[\s\S]{0,200}saldo_fiscal/i.test(read(SRC.ajuste)));
  assert.ok(!/UPDATE\s+produtos[\s\S]{0,200}reservado_fiscal/i.test(read(SRC.pdvReserva)));
}

function test02RevertSemUpdateDireto() {
  const src = read(SRC.nfeRevert);
  assert.ok(src.includes('debitarSaldo'));
  assert.ok(!/UPDATE\s+produtos/i.test(src));
  assert.ok(!/SET\s+saldo_fiscal/i.test(src));
}

function test03ConsumoPedidoSemUpdateReservado() {
  const src = read(SRC.ponte);
  assert.ok(src.includes('liberarQuantidadeReservada'));
  assert.ok(!/UPDATE\s+produtos/i.test(src));
  assert.ok(!/SET\s+reservado_fiscal/i.test(src));
}

function test04RepairSemUpdateReservado() {
  const src = read(SRC.repair);
  assert.ok(src.includes('reservasPublico'));
  assert.ok(!/UPDATE\s+produtos/i.test(src));
  assert.ok(!/SET\s+reservado_fiscal\s*=/i.test(src));
}

function test05CreateUsaPortaSaldoInicial() {
  const src = read(SRC.produtos);
  const inicio = src.indexOf("router.post('/', (req, res) => {");
  const fim = src.indexOf("router.get('/vencimentos/estatisticas'");
  assert.ok(inicio >= 0 && fim > inicio);
  const post = src.slice(inicio, fim);
  assert.ok(post.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(post.includes('0, estoque_minimo || 0, fornecedor'));
  assert.ok(!/estoqueInicial, estoque_minimo/.test(post));
}

function test06LotesNaoEEscritorOperacional() {
  const src = read(SRC.lotes);
  const criar = src.slice(
    src.indexOf('function criarLoteComLoteGerado'),
    src.indexOf('function buscarLotesProduto')
  );
  const consumir = src.slice(
    src.indexOf('function consumirLotesFEFO'),
    src.indexOf('function registrarConsumoVenda')
  );
  assert.ok(!/UPDATE\s+produtos\b/i.test(criar));
  assert.ok(!/UPDATE\s+produtos\b/i.test(consumir));
  assert.ok(src.includes('function atualizarEstoqueConsolidado'));
  const callers = walkJs(BACKEND).filter((f) => {
    if (path.normalize(f) === path.normalize(SRC.lotes)) return false;
    return read(f).includes('atualizarEstoqueConsolidado');
  });
  assert.deepStrictEqual(callers, []);
}

function test07NenhumEscritorOperacionalPendente() {
  const hits = arquivosComSetOperacional();
  const extras = hits.filter((f) => !ALLOWLIST_SET.has(f));
  assert.deepStrictEqual(
    extras.map((f) => path.relative(ROOT, f)),
    [],
    `escritor operacional pendente: ${extras.map((f) => path.relative(ROOT, f)).join(', ') || '(nenhum)'}`
  );
  assert.ok(hits.includes(path.normalize(SRC.portaSaldo)));
  assert.ok(hits.includes(path.normalize(SRC.lotes)));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/database/estoque_empresa')));
}

async function main() {
  const testes = [
    ['01 escritores 02.x pela porta', test01Escritores02xPelaPorta],
    ['02 03.5 revert sem UPDATE direto de saldo', test02RevertSemUpdateDireto],
    ['03 03.6 sem UPDATE direto de reservado', test03ConsumoPedidoSemUpdateReservado],
    ['04 03.7 Repair sem UPDATE direto de reservado', test04RepairSemUpdateReservado],
    ['05 03.8 CREATE usa porta para saldo inicial', test05CreateUsaPortaSaldoInicial],
    ['06 03.9 lotes nao e escritor operacional', test06LotesNaoEEscritorOperacional],
    ['07 nenhum escritor operacional pendente', test07NenhumEscritorOperacionalPendente]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nauditoria-final-escritores: ${ok}/${testes.length} OK — PENDENTE=NÃO`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
