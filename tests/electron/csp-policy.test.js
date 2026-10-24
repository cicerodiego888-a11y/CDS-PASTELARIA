/**
 * Microsprint segurança — CSP Electron/HTTP do CDS (+ ajuste frame-ancestors).
 * Isolado: sem banco oficial, sem SEFAZ, sem mutar NSU.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '../..');
const {
  CSP_HTTP,
  CSP_META,
  CSP_RENDERER,
  CSP_DIRETIVAS,
  metaTagCsp,
  validarCspSegura,
  cspBloqueiaUnsafeEval,
  documentarDiferencaEntregaCsp
} = require('../../cds-csp-policy');

const HTML_PRINCIPAIS = [
  'frontend/erp/index.html',
  'frontend/pdv/index.html',
  'frontend/shared/login.html',
  'frontend/pdv-universal/index.html'
];

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function extrairMetaCsp(html) {
  // content="..." — aspas internas da CSP são simples ('self'), então capturar até ".
  const m = String(html).match(
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"/i
  );
  return m ? m[1] : null;
}

describe('CSP CDS — política e wiring', () => {
  it('1. CSP_HTTP segura com frame-ancestors; sem unsafe-eval', () => {
    const v = validarCspSegura(CSP_HTTP, { exigirFrameAncestors: true });
    assert.equal(v.ok, true, v.motivos.join('; '));
    assert.equal(cspBloqueiaUnsafeEval(CSP_HTTP), true);
    assert.doesNotMatch(CSP_HTTP, /unsafe-eval/i);
    assert.match(CSP_HTTP, /object-src 'none'/);
    assert.match(CSP_HTTP, /base-uri 'self'/);
    assert.match(CSP_HTTP, /script-src 'self'/);
    assert.match(CSP_HTTP, /frame-ancestors 'none'/);
    assert.equal(CSP_RENDERER, CSP_HTTP);
    assert.ok(CSP_DIRETIVAS.length >= 8);
  });

  it('2. CSP_META sem frame-ancestors; alinhada à base HTTP', () => {
    const v = validarCspSegura(CSP_META, { proibirFrameAncestors: true });
    assert.equal(v.ok, true, v.motivos.join('; '));
    assert.doesNotMatch(CSP_META, /frame-ancestors/i);
    assert.doesNotMatch(CSP_META, /unsafe-eval/i);
    assert.match(CSP_META, /object-src 'none'/);
    const doc = documentarDiferencaEntregaCsp();
    assert.match(doc.diferenca, /frame-ancestors/);
    assert.equal(doc.http, CSP_HTTP);
    assert.equal(doc.meta, CSP_META);
    const metaHtml = metaTagCsp();
    assert.doesNotMatch(metaHtml, /frame-ancestors/i);
  });

  it('3. validarCspSegura rejeita unsafe-eval e ausência de object-src', () => {
    const comEval = validarCspSegura(
      "default-src 'self'; script-src 'self' 'unsafe-eval'; object-src 'none'; base-uri 'self'"
    );
    assert.equal(comEval.ok, false);
    assert.ok(comEval.motivos.some((m) => /unsafe-eval/i.test(m)));

    const semObject = validarCspSegura("default-src 'self'; script-src 'self'; base-uri 'self'");
    assert.equal(semObject.ok, false);
  });

  it('4. Electron aplica CSP_HTTP (frame-ancestors) sem duplicar headers', () => {
    const common = src('electron-common.js');
    const main = src('electron.js');
    const cspMod = src('electron-csp.js');
    assert.match(common, /aplicarCspElectron/);
    assert.match(main, /aplicarCspElectron/);
    assert.match(cspMod, /CSP_HTTP/);
    assert.match(cspMod, /exigirFrameAncestors:\s*true/);
    assert.match(cspMod, /onHeadersReceived/);
    // Remove header prévio antes de setar um único valor
    assert.match(cspMod, /content-security-policy/);
    assert.match(cspMod, /delete responseHeaders/);
    assert.match(common, /nodeIntegration:\s*false/);
    assert.match(common, /contextIsolation:\s*true/);
  });

  it('5. Express middleware usa CSP_HTTP com frame-ancestors', () => {
    const mw = src('backend/middleware/cspHeaders.js');
    const server = src('backend/server.js');
    assert.match(mw, /CSP_HTTP/);
    assert.match(mw, /exigirFrameAncestors:\s*true/);
    assert.match(server, /cspHeadersMiddleware/);
  });

  it('6. Meta tags HTML sem frame-ancestors e sem unsafe-eval', () => {
    for (const rel of HTML_PRINCIPAIS) {
      const html = src(rel);
      const meta = extrairMetaCsp(html);
      assert.ok(meta, `meta CSP ausente em ${rel}`);
      assert.doesNotMatch(meta, /frame-ancestors/i, rel);
      assert.doesNotMatch(meta, /unsafe-eval/i, rel);
      assert.match(meta, /object-src 'none'/, rel);
      assert.equal(meta, CSP_META, `meta diverge de CSP_META em ${rel}`);
    }
  });

  it('7. webPreferences de segurança permanecem', () => {
    const common = src('electron-common.js');
    assert.match(common, /nodeIntegration:\s*false/);
    assert.match(common, /contextIsolation:\s*true/);
    assert.match(common, /sandbox:\s*false/);
    const portal = src('electron-portal-nfe.js');
    assert.match(portal, /sandbox:\s*true/);
    assert.match(portal, /contextIsolation:\s*true/);
  });

  it('8. HTTP: header mantém frame-ancestors nas rotas HTML relevantes', async () => {
    const { cspHeadersMiddleware, CSP_HTTP: cspMw } = require('../../backend/middleware/cspHeaders');
    assert.match(cspMw, /frame-ancestors 'none'/);
    assert.equal(cspBloqueiaUnsafeEval(cspMw), true);

    const app = express();
    app.use(cspHeadersMiddleware);
    app.use(express.static(path.join(ROOT, 'frontend')));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const caminhos = [
      '/erp/index.html',
      '/pdv/index.html',
      '/shared/login.html',
      '/pdv-universal/index.html'
    ];

    try {
      for (const caminho of caminhos) {
        const headers = await new Promise((resolve, reject) => {
          http.get({ hostname: '127.0.0.1', port, path: caminho }, (res) => {
            assert.equal(res.statusCode, 200, caminho);
            resolve(res.headers);
            res.resume();
          }).on('error', reject);
        });
        const csp = headers['content-security-policy'];
        assert.ok(csp, `CSP ausente em ${caminho}`);
        assert.match(csp, /frame-ancestors 'none'/, caminho);
        assert.doesNotMatch(csp, /unsafe-eval/i, caminho);
        assert.equal(csp, CSP_HTTP, caminho);
        // Um único header (string, não array multi-valor conflituoso)
        assert.equal(typeof csp, 'string');
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('9. código de app (não-minificado) não usa eval/new Function no frontend', () => {
    const raiz = path.join(ROOT, 'frontend');
    const ofensores = [];
    function andar(dir) {
      for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
        if (nome.name === 'vendor' || nome.name === 'node_modules') continue;
        const full = path.join(dir, nome.name);
        if (nome.isDirectory()) {
          andar(full);
          continue;
        }
        if (!nome.name.endsWith('.js') || nome.name.includes('.min.')) continue;
        const texto = fs.readFileSync(full, 'utf8');
        if (/\beval\s*\(|new\s+Function\s*\(/.test(texto)) {
          ofensores.push(path.relative(ROOT, full));
        }
      }
    }
    andar(raiz);
    assert.deepEqual(ofensores, [], `eval/new Function em: ${ofensores.join(', ')}`);
  });

  it('10. Central de Entradas permanece no bundle ERP (mesma CSP do erp/index.html)', () => {
    const erp = src('frontend/erp/index.html');
    assert.match(erp, /central-entradas\.js/);
    const meta = extrairMetaCsp(erp);
    assert.doesNotMatch(meta, /frame-ancestors/i);
    assert.equal(meta, CSP_META);
  });
});
