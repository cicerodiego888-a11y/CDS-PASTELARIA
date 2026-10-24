const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '../..');
process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bloqueio-pdvu-'));

const server = require('../../backend/server');

function get(porta, caminho) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  const falhas = [];
  const bloqueadas = [
    '/pdv-universal', '/pdv-universal/', '/pdv-universal/index.html', '/PDV-Universal/',
    '/pdv-universal/pdv-universal.js', '/pdv-universal/pdv-universal.css', '/pdv-universal//index.html',
    '/%70dv-universal/', '/pdv-universal%2Findex.html', '/pdv-universal/?x=1', '/pdv-universal/../pdv-universal/index.html'
  ];
  try {
    for (const rota of bloqueadas) {
      const r = await get(porta, rota);
      assert.strictEqual(r.status, 302, `${rota} deveria redirecionar (obtido ${r.status})`);
      assert.strictEqual(r.location, '/pdv', `${rota} deveria ir a /pdv`);
      console.log(`  OK bloqueada ${rota} -> ${r.status} ${r.location}`);
    }
    // /pdv oficial mantém o comportamento (exige autenticação, não redireciona ao Universal)
    const pdv = await get(porta, '/pdv');
    assert.notStrictEqual(pdv.location, '/pdv');
    console.log(`  OK /pdv segue no fluxo atual -> ${pdv.status} ${pdv.location || ''}`);
    const pdvBarra = await get(porta, '/pdv/');
    assert.ok([200, 401, 403].includes(pdvBarra.status), `/pdv/ inesperado: ${pdvBarra.status}`);
    console.log(`  OK /pdv/ continua acessível -> ${pdvBarra.status}`);
    const api = await get(porta, '/api/pdv-universal/contexto');
    assert.notStrictEqual(api.status, 404, 'endpoint interno /api/pdv-universal deve continuar montado');
    console.log(`  OK /api/pdv-universal/contexto preservado (exige auth) -> ${api.status}`);
  } catch (e) {
    falhas.push(e);
  }
  server.close();
  try { fs.rmSync(process.env.DB_DIR, { recursive: true, force: true }); } catch (_) { /* banco ainda aberto no Windows */ }

  // Pasta e rota de API preservadas
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend/pdv-universal/index.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'backend/rotas/pdv-universal.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'backend/services/pdv-universal')));
  assert.ok(fs.existsSync(path.join(ROOT, 'backend/motores/pdv-universal')));

  if (falhas.length) throw falhas[0];
  console.log('bloqueio-rota-pdv-universal: OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
