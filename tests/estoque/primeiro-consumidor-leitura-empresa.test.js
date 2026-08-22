/**
 * Fase 2 / Implementação 03.17 — auditoria: nenhum consumidor seguro de leitura.
 * Código: NENHUM_CONSUMIDOR_SEGURO_ENCONTRADO
 * Sem migração. Sem endpoint artificial.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = {
  service: path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaService.js'),
  porta: path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
  produtos: path.join(ROOT, 'backend/rotas/produtos.js'),
  ajuste: path.join(ROOT, 'backend/services/ajusteEstoqueService.js'),
  compras: path.join(ROOT, 'backend/rotas/compras.js'),
  vendas: path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js'),
  pdv: path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
  repair: path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js'),
  nfe: path.join(ROOT, 'backend/services/fiscal/estoqueNfeDevolucaoVenda.js'),
  mts: path.join(ROOT, 'backend/motores/mts/MtsService.js'),
  muc: path.join(ROOT, 'backend/motores/muc/index.js'),
  dashboard: path.join(ROOT, 'backend/rotas/dashboard.js'),
  alertas: path.join(ROOT, 'backend/monitoring/intelligence/MonitoringAlertService.js')
};

function test01MetodoTecnicoExiste() {
  const src = fs.readFileSync(SRC.service, 'utf8');
  assert.ok(src.includes('async function consultarSaldoParaEmpresa'));
}

function test02PortaContinuaEmProdutos() {
  const porta = fs.readFileSync(SRC.porta, 'utf8');
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(porta));
}

function test03NenhumFluxoOperacionalRedirecionado() {
  const arquivos = [
    SRC.produtos, SRC.ajuste, SRC.compras, SRC.vendas, SRC.pdv,
    SRC.repair, SRC.nfe, SRC.mts, SRC.muc, SRC.dashboard, SRC.alertas
  ];
  for (const arquivo of arquivos) {
    const src = fs.readFileSync(arquivo, 'utf8');
    assert.ok(
      !src.includes('consultarSaldoParaEmpresa'),
      `${path.relative(ROOT, arquivo)} não deve consumir consultarSaldoParaEmpresa`
    );
  }
}

function test04WritersIntacto() {
  const ajuste = fs.readFileSync(SRC.ajuste, 'utf8');
  assert.ok(ajuste.includes('espelharSaldoInicialEmEstoqueEmpresa'));
  assert.ok(!ajuste.includes('consultarSaldoParaEmpresa'));
}

function test05SemEndpointArtificial() {
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/rotas/estoque-empresa.js')));
  const produtos = fs.readFileSync(SRC.produtos, 'utf8');
  assert.ok(!produtos.includes('consultarSaldoParaEmpresa'));
}

function test06DocumentacaoDaConclusao() {
  const doc = fs.readFileSync(
    path.join(ROOT, 'docs/arquitetura/IMPLEMENTACAO_03_17_PRIMEIRO_CONSUMIDOR_LEITURA_EMPRESA.md'),
    'utf8'
  );
  assert.ok(doc.includes('NENHUM_CONSUMIDOR_SEGURO_ENCONTRADO'));
}

function main() {
  const testes = [
    ['01 consultarSaldoParaEmpresa permanece tecnico', test01MetodoTecnicoExiste],
    ['02 porta publica continua em produtos', test02PortaContinuaEmProdutos],
    ['03 nenhum fluxo operacional redirecionado', test03NenhumFluxoOperacionalRedirecionado],
    ['04 writers / dual-write intactos', test04WritersIntacto],
    ['05 sem endpoint artificial', test05SemEndpointArtificial],
    ['06 conclusao documentada', test06DocumentacaoDaConclusao]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nprimeiro-consumidor-leitura-empresa: ${ok}/${testes.length} OK`);
  console.log('NENHUM_CONSUMIDOR_SEGURO_ENCONTRADO');
  process.exit(0);
}

main();
