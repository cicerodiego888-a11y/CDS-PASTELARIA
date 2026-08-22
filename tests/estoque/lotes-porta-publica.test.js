/**
 * Fase 2 / Implementação 03.9 — auditoria de lotes vs porta pública.
 *
 * Conclusão: o módulo de lotes NÃO é escritor operacional de saldo/reserva.
 * Não houve migração. Este arquivo só comprova a descoberta.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC_LOTES = path.join(ROOT, 'backend/services/lotesService.js');
const SRC_CREATE = path.join(ROOT, 'backend/rotas/produtos.js');
const SRC_REPAIR = path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js');
const SRC_PONTE = path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js');
const SRC_NFE = path.join(ROOT, 'backend/services/fiscal/estoqueNfeDevolucaoVenda.js');
const SRC_MTS = path.join(ROOT, 'backend/motores/mts/MtsService.js');
const SRC_MUC = path.join(ROOT, 'backend/motores/muc/index.js');
const SRC_PORTA_SALDO = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const SRC_PORTA_RESERVA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js');

function sliceFn(src, startNeedle, endNeedle) {
  const inicio = src.indexOf(startNeedle);
  const fim = src.indexOf(endNeedle, inicio + 1);
  assert.ok(inicio >= 0 && fim > inicio, `função não encontrada: ${startNeedle}`);
  return src.slice(inicio, fim);
}

function test01MetodosVivosSoRastreiamLotes() {
  const src = fs.readFileSync(SRC_LOTES, 'utf8');
  const criar = sliceFn(src, 'function criarLoteComLoteGerado', 'function buscarLotesProduto');
  const consumir = sliceFn(src, 'function consumirLotesFEFO', 'function registrarConsumoVenda');
  const registrar = sliceFn(src, 'function registrarConsumoVenda', 'function restaurarLotesVenda');
  const restaurar = sliceFn(src, 'function restaurarLotesVenda', 'function buscarLotesVencendo');

  for (const [nome, fn] of [
    ['criarLote', criar],
    ['consumirLotesFEFO', consumir],
    ['registrarConsumoVenda', registrar],
    ['restaurarLotesVenda', restaurar]
  ]) {
    assert.ok(!/UPDATE\s+produtos\b/i.test(fn), `${nome} não deve UPDATE produtos`);
    assert.ok(!/INSERT\s+INTO\s+produtos\b/i.test(fn), `${nome} não deve INSERT produtos`);
    assert.ok(!/saldo_fiscal/i.test(fn), `${nome} não escreve saldo_fiscal`);
    assert.ok(!/reservado_/i.test(fn), `${nome} não escreve reserva`);
  }

  assert.ok(criar.includes('INSERT INTO produtos_lotes'));
  assert.ok(consumir.includes('UPDATE produtos_lotes'));
  assert.ok(registrar.includes('INSERT INTO venda_lotes'));
  assert.ok(restaurar.includes('UPDATE produtos_lotes'));
}

function test02ConsolidadoNaoEEscritorOperacionalDaPorta() {
  const src = fs.readFileSync(SRC_LOTES, 'utf8');
  const consolidado = sliceFn(src, 'function atualizarEstoqueConsolidado', 'function obterConfiguracoesValidade');

  assert.ok(/UPDATE\s+produtos/.test(consolidado));
  assert.ok(/SET estoque_atual = \?/.test(consolidado));
  const update = consolidado.slice(consolidado.indexOf('db.run'));
  assert.ok(!/saldo_fiscal/.test(update));
  assert.ok(!/saldo_nao_fiscal/.test(update));
  assert.ok(!update.includes('reservado_fiscal'));
  assert.ok(!consolidado.includes('estoqueSaldosPublico'));
  assert.ok(!consolidado.includes('creditarSaldo'));
  assert.ok(!consolidado.includes('debitarSaldo'));

  const backend = path.join(ROOT, 'backend');
  const callers = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(full);
      } else if (ent.name.endsWith('.js') && full !== SRC_LOTES) {
        const txt = fs.readFileSync(full, 'utf8');
        if (txt.includes('atualizarEstoqueConsolidado')) callers.push(path.relative(ROOT, full));
      }
    }
  }
  walk(backend);
  assert.deepStrictEqual(callers, [], `atualizarEstoqueConsolidado não deve ter callers: ${callers}`);
}

function test03NaoInventouPortaNemCompat() {
  const src = fs.readFileSync(SRC_LOTES, 'utf8');
  assert.ok(!src.includes('estoqueSaldosPublico'));
  assert.ok(!src.includes('reservasPublico'));
  assert.ok(!src.includes('COMPAT_LOTES_PRE_MULTIEMPRESA'));
  assert.ok(!/empresaId\s*=\s*1/.test(src));
  assert.ok(!src.includes('configuracoes.cnpj'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/database/estoque_empresa')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/lotesPublico2.js')));
}

function test04FluxosAnterioresIntacto() {
  const create = fs.readFileSync(SRC_CREATE, 'utf8');
  const repair = fs.readFileSync(SRC_REPAIR, 'utf8');
  const ponte = fs.readFileSync(SRC_PONTE, 'utf8');
  const nfe = fs.readFileSync(SRC_NFE, 'utf8');
  const mts = fs.readFileSync(SRC_MTS, 'utf8');
  const muc = fs.readFileSync(SRC_MUC, 'utf8');
  const portaSaldo = fs.readFileSync(SRC_PORTA_SALDO, 'utf8');
  const portaReserva = fs.readFileSync(SRC_PORTA_RESERVA, 'utf8');

  assert.ok(create.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(repair.includes('reservasPublico'));
  assert.ok(ponte.includes('liberarQuantidadeReservada'));
  assert.ok(nfe.includes('debitarSaldo') || nfe.includes('estoqueSaldosPublico'));
  assert.ok(!mts.includes('atualizarEstoqueConsolidado'));
  assert.ok(!muc.includes('atualizarEstoqueConsolidado'));
  assert.ok(portaSaldo.includes('creditarSaldo'));
  assert.ok(portaReserva.includes('reservarQuantidade'));
}

async function main() {
  const testes = [
    ['01 metodos vivos so rastreiam lotes', test01MetodosVivosSoRastreiamLotes],
    ['02 consolidado nao e escritor operacional da porta', test02ConsolidadoNaoEEscritorOperacionalDaPorta],
    ['03 nao inventou porta nem COMPAT', test03NaoInventouPortaNemCompat],
    ['04 fluxos anteriores intactos', test04FluxosAnterioresIntacto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nlotes-porta-publica: ${ok}/${testes.length} OK (auditoria — sem migração)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
