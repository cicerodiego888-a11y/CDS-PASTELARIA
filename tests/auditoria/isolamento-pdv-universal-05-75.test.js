/**
 * Sprint 05.75 — Isolamento/congelamento do PDV Universal (auditoria).
 * Não remove o Universal. Executar: node tests/auditoria/isolamento-pdv-universal-05-75.test.js
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

function listarJs(dirRel) {
  const dir = path.join(ROOT, dirRel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .map((n) => path.join(dirRel, n).replace(/\\/g, '/'));
}

function t01() {
  assert.ok(existe('frontend/pdv-universal/index.html'));
  assert.ok(existe('backend/rotas/pdv-universal.js'));
  assert.ok(existe('backend/motores/pdv-universal/PDVUniversalApplicationService.js'));
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('PDV UNIVERSAL') || html.includes('PDV Universal'));
  const porta = src('backend/rotas/pdv-universal.js');
  assert.ok(porta.includes('CONGELADO'));
  const doc = src('docs/arquitetura/PDV_UNIVERSAL_CONGELADO.md');
  assert.ok(doc.includes('CONGELADO'));
  assert.ok(doc.includes('PDV NORMAL'));
  console.log('  T01 PDV Universal identificado (legado congelado)');
}

function t02() {
  assert.ok(existe('frontend/pdv/index.html'));
  assert.ok(existe('frontend/pdv/js/pdv.js'));
  const server = src('backend/server.js');
  assert.ok(server.includes("app.get(['/pdv', '/pdv/']"));
  const pdv = src('frontend/pdv/js/pdv.js');
  assert.ok(pdv.includes('${API_URL}/vendas'));
  const iso = src('docs/arquitetura/ISOLAMENTO_PDV_UNIVERSAL_05_75.md');
  assert.ok(iso.includes('PDV NORMAL'));
  assert.ok(iso.includes('/pdv'));
  console.log('  T02 PDV Normal identificado (/pdv, frontend/pdv)');
}

function t03() {
  const iso = src('docs/arquitetura/ISOLAMENTO_PDV_UNIVERSAL_05_75.md');
  assert.ok(iso.includes('dashboard-command.js'));
  assert.ok(iso.includes('pdv/index.html'));
  assert.ok(iso.includes('pdv-acesso-oficial.js'));
  assert.ok(iso.includes('server.js'));
  assert.ok(src('frontend/erp/js/dashboard-command.js').includes('urlPdvUniversalOficial'));
  assert.ok(src('frontend/erp/index.html').includes('href="/pdv-universal/"'));
  assert.ok(src('frontend/pdv/index.html').includes('href="/pdv-universal/"'));
  console.log('  T03 inventário de chamadores disponível');
}

function t04() {
  const iso = src('docs/arquitetura/ISOLAMENTO_PDV_UNIVERSAL_05_75.md');
  assert.ok(iso.includes('VendaApplicationService'));
  assert.ok(iso.includes('reservasPublico'));
  const eu = src('backend/motores/pdv-universal/adaptadores/EmpresaUnicaAdapter.js');
  assert.ok(eu.includes('VendaApplicationService'));
  const disp = src('backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js');
  assert.ok(disp.includes('reservasPublico'));
  console.log('  T04 dependências compartilhadas identificadas');
}

function t05() {
  const rota = src('backend/rotas/pdv-universal.js');
  assert.ok(rota.includes("router.get('/contexto'"));
  assert.ok(rota.includes("router.post('/checkout'"));
  assert.ok(rota.includes("router.put('/contexto/empresa'"));
  assert.ok(rota.includes("router.get('/produtos/:produtoId/disponibilidade'"));
  assert.ok(rota.includes("router.post('/atendimentos/:id/reservar'"));
  assert.ok(rota.includes("router.post('/atendimentos/:id/pagamento'"));
  assert.ok(rota.includes("router.post('/atendimentos/:id/cancelar'"));
  assert.ok(rota.includes("router.post('/atendimentos/:id/materializar'"));
  assert.ok(rota.includes("router.post('/atendimentos/:id/fiscalizar'"));
  assert.ok(rota.includes("router.get('/atendimentos/:id/comprovante'"));
  const server = src('backend/server.js');
  assert.ok(server.includes("app.use('/api/pdv-universal'"));
  assert.ok(server.includes("app.get(['/pdv-universal', '/pdv-universal/']"));
  console.log('  T05 rotas do Universal identificadas');
}

function t06() {
  assert.ok(existe('backend/services/pdv-universal/PDVUniversalContextService.js'));
  assert.ok(existe('backend/services/pdv-universal/PDVUniversalDisponibilidadeService.js'));
  assert.ok(existe('backend/services/pdv-universal/PDVUniversalVendaAdapter.js'));
  assert.ok(existe('backend/services/pdv-universal/PDVUniversalAtendimentoAdapter.js'));
  const app = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
  assert.strictEqual(typeof app.obterContexto, 'function');
  assert.strictEqual(typeof app.finalizarCheckout, 'function');
  console.log('  T06 serviços do Universal identificados');
}

function t07() {
  const js = listarJs('frontend/pdv/js');
  assert.ok(js.length >= 1);
  for (const rel of js) {
    const t = src(rel);
    assert.ok(!/pdv-universal/i.test(t), `import Universal em ${rel}`);
    assert.ok(!/PdvUniversal/.test(t), `PdvUniversal em ${rel}`);
  }
  const vendasRotas = src('backend/rotas/vendas.js');
  assert.ok(!vendasRotas.includes("require('../rotas/pdv-universal')"));
  assert.ok(!vendasRotas.includes("require('../motores/pdv-universal"));
  console.log('  T07 nenhuma dependência JS Normal → Universal (menu HTML pré-existente)');
}

function t08() {
  const app = require('../../backend/motores/pdv-universal/PDVUniversalApplicationService');
  assert.strictEqual(typeof app.finalizarCheckout, 'function');
  assert.strictEqual(typeof app.selecionarEmpresa, 'function');
  const rota = require('../../backend/rotas/pdv-universal');
  assert.ok(rota);
  const tela = require('../../frontend/pdv-universal/pdv-universal.js');
  assert.ok(tela && typeof tela.urlContexto === 'function');
  assert.ok(String(tela.urlContexto()).includes('/pdv-universal/contexto'));
  console.log('  T08 Universal continua funcional (módulos e checkout)');
}

function t09() {
  assert.ok(existe('frontend/pdv/js/pdv.js'));
  const pdv = src('frontend/pdv/js/pdv.js');
  assert.ok(pdv.includes('/vendas'));
  const server = src('backend/server.js');
  assert.ok(server.includes("frontendRoot, 'pdv/index.html'"));
  console.log('  T09 PDV Normal continua funcional (HTML + POST vendas)');
}

function t10() {
  const rota = src('backend/rotas/pdv-universal.js');
  const metodos = rota.match(/router\.(get|post|put)\(/g) || [];
  assert.strictEqual(metodos.length, 10, '10 rotas API Universal');
  assert.ok(src('backend/server.js').includes("app.use('/api/pdv-universal'"));
  console.log('  T10 nenhuma rota existente foi removida');
}

function t11() {
  const pastas = [
    'backend/rotas/pdv-universal.js',
    'backend/motores/pdv-universal/PDVUniversalApplicationService.js',
    'backend/services/pdv-universal/PDVUniversalContextService.js'
  ];
  for (const rel of pastas) {
    const t = src(rel);
    assert.ok(!/DROP TABLE/i.test(t));
    assert.ok(!/CREATE TABLE\s+pdv_universal/i.test(t));
  }
  console.log('  T11 nenhuma tabela exclusiva do Universal (nem removida)');
}

function t12() {
  const app = src('backend/motores/pdv-universal/PDVUniversalApplicationService.js');
  assert.ok(app.includes('async function finalizarCheckout'));
  assert.ok(app.includes('CONGELADO'));
  assert.ok(!app.includes('migrar para PDV Normal'));
  const htmlU = src('frontend/pdv-universal/index.html');
  assert.ok(htmlU.includes('pdv-universal-checkout.js'));
  const pdvJs = src('frontend/pdv/js/pdv.js');
  assert.ok(!pdvJs.includes('pdv-universal-checkout'));
  console.log('  T12 Universal não migrado/alterado indevidamente (só bandeira CONGELADO)');
}

function main() {
  console.log('05.75 isolamento PDV Universal');
  t01();
  t02();
  t03();
  t04();
  t05();
  t06();
  t07();
  t08();
  t09();
  t10();
  t11();
  t12();
  console.log('OK 12/12');
}

main();
