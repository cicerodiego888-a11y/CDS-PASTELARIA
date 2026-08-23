/**
 * Sprint 05.16 — auditoria estrutural do PDV Universal (não substitui clique real).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function testRotasMontadas() {
  const server = src('backend/server.js');
  assert.ok(server.includes("app.use('/api/pdv-universal', verificarToken"));
  assert.ok(server.includes("app.get(['/pdv-universal', '/pdv-universal/'], verificarToken"));
  const rota = src('backend/rotas/pdv-universal.js');
  [
    "router.get('/contexto'",
    "router.post('/checkout'",
    "router.post('/atendimentos/:id/reservar'",
    "router.post('/atendimentos/:id/pagamento'",
    "router.post('/atendimentos/:id/materializar'",
    "router.post('/atendimentos/:id/fiscalizar'",
    "router.get('/atendimentos/:id/comprovante'"
  ].forEach((p) => assert.ok(rota.includes(p), p));
}

function testFrontendChama() {
  const tela = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(tela.includes('/pdv-universal/contexto'));
  assert.ok(tela.includes('Authorization'));
  assert.ok(src('frontend/erp/index.html').includes('href="/pdv-universal/"'));
  const pag = src('frontend/pdv-universal/pdv-universal-pagamento.js');
  assert.ok(pag.includes('/reservar'));
  assert.ok(pag.includes('/pagamento'));
  const pos = src('frontend/pdv-universal/pdv-universal-pos-pagamento.js');
  assert.ok(pos.includes('/materializar'));
  assert.ok(pos.includes('/fiscalizar'));
  assert.ok(pos.includes('/comprovante'));
  assert.ok(src('frontend/pdv-universal/pdv-universal-checkout.js').includes('/checkout'));
}

function testBindUi() {
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('PdvUniversalTela.bindUi'));
  assert.ok(html.includes('id="pdvu-finalizar"'));
  assert.ok(html.includes('id="pdvu-busca-input"'));
}

function run() {
  [testRotasMontadas, testFrontendChama, testBindUi].forEach((t) => {
    t();
    console.log('ok', t.name);
  });
  console.log('05.16 pdv 3/3');
}

run();
