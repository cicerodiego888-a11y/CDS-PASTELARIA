/**
 * Sprint 07 · S07-3B — Interface de gestão de roteamento de cozinhas.
 * Banco temporário. Sem migration no oficial. Sem S07-3C / despacho / Pedidos→KDS.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-3b-roteamento-ui.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-3b-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-3b-ui';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');
const {
  garantirSchemaCozinhaRoteamento,
  verificarSchemaCozinhaRoteamento
} = require('../../backend/services/cozinha/cozinhaRoteamentoSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');
const ui = require('../../frontend/erp/js/cozinha-roteamento.js');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

describe('S07-3B — UI markup e helpers', () => {
  it('renderiza tela com modos, padrão e segmentos', () => {
    const html = ui.montarMarkup();
    assert.match(html, /Configurações Avançadas/);
    assert.match(html, /Gestão de Cozinhas/);
    assert.match(html, /Gestão de Roteamento de Cozinhas/);
    assert.match(html, /COZINHA_PADRAO/);
    assert.match(html, /COZINHA_POR_SEGMENTO/);
    assert.match(html, /coz-rot-unidade-padrao/);
    // S07-3C substitui segmentos fixos por canais dinâmicos na UI.
    assert.match(html, /coz-rot-tbody-canais|Canais de pedidos/);
    assert.match(html, /coz-rot-schema-alerta/);
    assert.match(html, /coz-rot-previa-alerta/);
    assert.match(html, /data-coz-rot-gravacao="1"/);
    assert.match(html, /Salvar modo/);
    assert.match(html, /Salvar cozinha padrão/);
  });

  it('renderLinhasSegmentos associa selects por segmento permitido', () => {
    const html = ui.renderLinhasSegmentos(
      ['LOJA', 'IFOOD', 'PEDIDO_ONLINE'],
      [{ segmento: 'IFOOD', unidade_id: 2 }],
      [
        { id: 1, codigo: 'COZ-01', ativo: 1 },
        { id: 2, codigo: 'COZ-02', ativo: 1 },
        { id: 3, codigo: 'OFF', ativo: 0 }
      ]
    );
    assert.match(html, /data-segmento="LOJA"/);
    assert.match(html, /data-segmento="IFOOD"/);
    assert.match(html, /data-segmento="PEDIDO_ONLINE"/);
    assert.match(html, /COZ-01/);
    assert.match(html, /value="2" selected/);
    assert.doesNotMatch(html, />OFF \(#3\)</);
  });

  it('mensagem 503 explica dependência de schema controlado', () => {
    const msg = ui.mensagemSchemaIndisponivel({
      codigo: 'SCHEMA_ROTEAMENTO_INDISPONIVEL',
      mensagem: 'Schema ausente.'
    });
    assert.match(msg, /migration S07-3A|aplicação controlada do schema/i);
    assert.match(msg, /Schema ausente/);
  });

  it('ACL e navegação registram cozinha-roteamento em Configurações Avançadas', () => {
    const raiz = path.resolve(__dirname, '../..');
    const indexHtml = fs.readFileSync(path.join(raiz, 'frontend/erp/index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(raiz, 'frontend/erp/js/app.js'), 'utf8');
    const acl = fs.readFileSync(path.join(raiz, 'frontend/shared/js/access-control.js'), 'utf8');
    const centro = fs.readFileSync(path.join(raiz, 'frontend/erp/js/cds-centro-configuracoes.js'), 'utf8');

    assert.match(indexHtml, /data-page="cozinha-roteamento"/);
    assert.match(indexHtml, /id="nav-cozinha-roteamento"/);
    assert.match(appJs, /'cozinha-roteamento':\s*\['\/erp\/js\/cozinha-roteamento\.js'\]/);
    assert.match(appJs, /case 'cozinha-roteamento'/);
    assert.match(appJs, /loadCozinhaRoteamento/);
    assert.match(acl, /'cozinha-roteamento':\s*'configuracoes'/);
    assert.match(acl, /page === 'cozinha-unidades' \|\| page === 'cozinha-roteamento'/);
    assert.match(centro, /data-cfg-pane="cozinhas"/);
    assert.match(centro, /loadPage\('cozinha-roteamento'\)/);
    assert.match(centro, /Gestão de Roteamento/);
  });

  it('preserva S06 e seleção de unidade S07-2 (sem alteração nestes arquivos-chave)', () => {
    const raiz = path.resolve(__dirname, '../..');
    // Arquivos de impressão S06 e KDS sessão não devem ser tocados nesta sprint UI.
    const s06Candidates = [
      'backend/services/cozinha/cozinhaImpressaoService.js',
      'backend/services/cozinha/CozinhaDespachoService.js'
    ];
    for (const rel of s06Candidates) {
      const full = path.join(raiz, rel);
      if (fs.existsSync(full)) {
        const txt = fs.readFileSync(full, 'utf8');
        assert.doesNotMatch(txt, /S07-3B/);
      }
    }
    const sessao = fs.readFileSync(
      path.join(raiz, 'backend/services/cozinha/CozinhaSessaoUnidadeService.js'),
      'utf8'
    );
    assert.doesNotMatch(sessao, /roteamento\/modo|S07-3B/);
  });
});

describe('S07-3B — interação UI com fetch (mock) e HTTP real', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let adminId;
  let opId;
  let unA;
  let unB;
  let tokenAdmin;
  let tokenOp;
  let calls;

  function requestJson(method, urlPath, { token, body } = {}) {
    const u = new URL(urlPath, baseUrl);
    const payload = body != null ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Empresa-Id': String(empresaId),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { json = { raw }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function criarHostFake() {
    const store = new Map();
    function makeEl(id) {
      if (store.has(id)) return store.get(id);
      const listeners = {};
      const el = {
        id,
        className: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        checked: false,
        value: '',
        classList: {
          _set: new Set(['d-none'].filter(() => false)),
          add(c) { this._set.add(c); el.className = [...this._set].join(' '); },
          remove(c) { this._set.delete(c); el.className = [...this._set].join(' '); },
          toggle(c, on) {
            if (arguments.length > 1) {
              if (on) this.add(c);
              else this.remove(c);
            } else if (this._set.has(c)) this.remove(c);
            else this.add(c);
          },
          contains(c) { return this._set.has(c); }
        },
        querySelector(sel) {
          if (sel === '[data-coz-rot-gravacao="1"]' || String(sel).includes('data-coz-rot-gravacao')) {
            return makeEl('coz-rot-btn-salvar-modo');
          }
          return null;
        },
        querySelectorAll(sel) {
          const s = String(sel);
          if (s.includes('data-coz-rot-gravacao') || s.includes('coz-rot-modo')) {
            return [
              makeEl('coz-rot-btn-salvar-modo'),
              makeEl('coz-rot-btn-salvar-padrao'),
              makeEl('coz-rot-unidade-padrao'),
              makeEl('coz-rot-modo-padrao'),
              makeEl('coz-rot-modo-segmento'),
              makeEl('coz-rot-btn-seg-proxy')
            ];
          }
          return [];
        },
        addEventListener(type, fn) {
          listeners[type] = listeners[type] || [];
          listeners[type].push(fn);
        },
        closest() { return null; },
        getAttribute() { return null; },
        setAttribute() {},
        focus() {}
      };
      // Conteúdo inicia oculto como no markup real.
      if (id === 'coz-rot-conteudo') el.classList.add('d-none');
      store.set(id, el);
      return el;
    }

    const host = {
      innerHTML: '',
      querySelector(sel) {
        const m = String(sel).match(/^#([\w-]+)$/);
        if (m) return makeEl(m[1]);
        if (sel === 'input[name="coz-rot-modo"]:checked') {
          const p = makeEl('coz-rot-modo-padrao');
          const s = makeEl('coz-rot-modo-segmento');
          if (p.checked) return p;
          if (s.checked) return s;
          return null;
        }
        if (String(sel).startsWith('input[name="coz-rot-modo"]')) {
          return makeEl('coz-rot-modo-padrao');
        }
        if (String(sel).includes('coz-rot-seg-unidade')) {
          const el = makeEl('coz-rot-seg-unidade-proxy');
          el.value = String(unA);
          return el;
        }
        if (String(sel).includes('salvar-segmento')) {
          return makeEl('coz-rot-btn-seg-proxy');
        }
        return null;
      },
      querySelectorAll(sel) {
        if (String(sel).includes('coz-rot-modo') || String(sel).includes('data-coz-rot-gravacao')) {
          return [
            makeEl('coz-rot-modo-padrao'),
            makeEl('coz-rot-modo-segmento'),
            makeEl('coz-rot-btn-salvar-modo'),
            makeEl('coz-rot-btn-salvar-padrao'),
            makeEl('coz-rot-unidade-padrao')
          ];
        }
        return [];
      },
      addEventListener() {}
    };
    return { host, makeEl, store };
  }

  before(async () => {
    dbHttp = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DB timeout')), 60000);
      dbHttp.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    for (let i = 0; i < 100; i += 1) {
      const row = await get(dbHttp, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_notificacoes'
      `);
      const st = getCozinhaSchemaStatus();
      if (row && row.name === 'cozinha_notificacoes' && (st.operacional || st.erro)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    let schemaOut = null;
    let ultimoErro = null;
    for (let t = 0; t < 8; t += 1) {
      try {
        schemaOut = await garantirSchemaCozinha(dbHttp);
        ultimoErro = null;
        break;
      } catch (err) {
        ultimoErro = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!schemaOut || !schemaOut.operacional) {
      throw ultimoErro || new Error('Schema Cozinha não operacional');
    }
    // DDL apenas no setup de teste (temp). APIs de produção não criam schema.
    await garantirSchemaCozinhaRoteamento(dbHttp);
    assert.equal((await verificarSchemaCozinhaRoteamento(dbHttp)).disponivel, true);
    assert.equal(isCozinhaOperacional(), true);

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('44556677000188', 'Emp R3B', 'R3B', 1)
    `);
    empresaId = emp.lastID;
    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_r3b_ui', 'hash', 'admin', 'ADMIN', 1, 'Admin')
    `);
    adminId = adm.lastID;
    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_r3b_ui', 'hash', 'operador', 'USUARIO', 1, 'Op')
    `);
    opId = op.lastID;
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [adminId, empresaId]);
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [opId, empresaId]);

    const u1 = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3B-01', 1)
    `, [empresaId]);
    unA = u1.lastID;
    const u2 = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3B-02', 1)
    `, [empresaId]);
    unB = u2.lastID;

    tokenAdmin = jwt.sign({
      id: adminId, username: 'admin_r3b_ui', role: 'admin', perfil: 'ADMIN', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenOp = jwt.sign({
      id: opId, username: 'op_r3b_ui', role: 'operador', perfil: 'USUARIO', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const app = express();
    app.use(express.json());
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('HTTP: carrega unidades e configura os dois modos + segmentos', async () => {
    const unidades = await requestJson('GET', '/api/cozinha/unidades', { token: tokenAdmin });
    assert.equal(unidades.status, 200);
    assert.ok((unidades.body.unidades || []).some((u) => u.codigo === 'R3B-01'));

    const padrao = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unA }
    });
    assert.equal(padrao.status, 200);
    assert.equal(padrao.body.unidade_padrao_id, unA);

    const segLoja = await requestJson('PUT', '/api/cozinha/roteamento/segmentos', {
      token: tokenAdmin,
      body: { segmento: 'LOJA', unidade_id: unA }
    });
    assert.equal(segLoja.status, 200);

    const segIfood = await requestJson('PUT', '/api/cozinha/roteamento/segmentos', {
      token: tokenAdmin,
      body: { segmento: 'IFOOD', unidade_id: unB }
    });
    assert.equal(segIfood.status, 200);

    const modoSeg = await requestJson('PUT', '/api/cozinha/roteamento/modo', {
      token: tokenAdmin,
      body: { modo: 'COZINHA_POR_SEGMENTO' }
    });
    assert.equal(modoSeg.status, 200);
    assert.equal(modoSeg.body.modo, 'COZINHA_POR_SEGMENTO');

    const modoPad = await requestJson('PUT', '/api/cozinha/roteamento/modo', {
      token: tokenAdmin,
      body: { modo: 'COZINHA_PADRAO' }
    });
    assert.equal(modoPad.status, 200);
    assert.equal(modoPad.body.modo, 'COZINHA_PADRAO');

    const leitura = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenAdmin });
    assert.equal(leitura.status, 200);
    assert.equal(leitura.body.unidade_padrao_id, unA);
    assert.ok(leitura.body.segmentos.some((s) => s.segmento === 'IFOOD' && s.unidade_id === unB));
  });

  it('HTTP: operador sem permissão recebe 403 ADMIN_OPERACIONAL_OBRIGATORIO', async () => {
    const r = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenOp });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'ADMIN_OPERACIONAL_OBRIGATORIO');
  });

  it('UI: carrega unidades/config via fetch e trata 503 schema', async () => {
    calls = [];
    const { host, makeEl } = criarHostFake();
    makeEl('coz-rot-modo-padrao').value = 'COZINHA_PADRAO';
    makeEl('coz-rot-modo-padrao').checked = true;
    makeEl('coz-rot-unidade-padrao').value = String(unA);

    const fakeGlobal = {
      API_URL: baseUrl + '/api',
      document: {
        addEventListener() {},
        removeEventListener() {}
      },
      localStorage: {
        getItem(k) { return k === 'token' ? tokenAdmin : null; }
      },
      CdsEmpresaContexto: {
        temEmpresaSelecionada() { return true; },
        headersJson(extra) {
          return Object.assign({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenAdmin}`,
            'X-Empresa-Id': String(empresaId)
          }, extra || {});
        }
      },
      fetch: async (url, opts) => {
        calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
        // Proxy to real HTTP server
        const u = new URL(url, baseUrl);
        const pathUrl = u.pathname + u.search;
        const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
        const r = await requestJson((opts && opts.method) || 'GET', pathUrl.replace(/^\/api/, '') ? pathUrl : pathUrl, {
          token: tokenAdmin,
          body
        });
        // requestJson paths are /api/cozinha/...
        const full = pathUrl.startsWith('/api') ? pathUrl : '/api' + pathUrl;
        const rr = await requestJson((opts && opts.method) || 'GET', full.startsWith('/api') ? full : '/api' + full, {
          token: tokenAdmin,
          body
        });
        void r;
        return {
          ok: rr.status >= 200 && rr.status < 300,
          status: rr.status,
          async json() { return rr.body; }
        };
      }
    };

    // Simpler fetch: hit the test server correctly
    fakeGlobal.fetch = async (url, opts) => {
      const abs = String(url);
      const u = new URL(abs, baseUrl);
      calls.push({ url: abs, method: (opts && opts.method) || 'GET' });
      const payload = opts && opts.body ? JSON.parse(opts.body) : undefined;
      const rr = await requestJson((opts && opts.method) || 'GET', u.pathname + u.search, {
        token: tokenAdmin,
        body: payload
      });
      return {
        ok: rr.status >= 200 && rr.status < 300,
        status: rr.status,
        async json() { return rr.body; }
      };
    };

    const ctrl = ui.montarNoNavegador(fakeGlobal);
    await ctrl.iniciar(host);
    assert.ok(calls.some((c) => /\/cozinha\/unidades/.test(c.url)));
    assert.ok(calls.some((c) => /\/cozinha\/roteamento$/.test(c.url) || /\/cozinha\/roteamento\?/.test(c.url) || c.url.endsWith('/cozinha/roteamento')));
    assert.equal(ctrl.getEstado().schemaIndisponivel, false);

    // Simula 503 em recarga
    const fetchOk = fakeGlobal.fetch;
    fakeGlobal.fetch = async (url, opts) => {
      if (String(url).includes('/roteamento') && (!opts || !opts.method || opts.method === 'GET')) {
        return {
          ok: false,
          status: 503,
          async json() {
            return {
              success: false,
              codigo: 'SCHEMA_ROTEAMENTO_INDISPONIVEL',
              mensagem: 'Schema de roteamento indisponível.'
            };
          }
        };
      }
      return fetchOk(url, opts);
    };
    await ctrl.recarregar();
    assert.equal(ctrl.getEstado().schemaIndisponivel, true);
    assert.equal(ctrl.getEstado().previaVisual, true);
    const alerta = makeEl('coz-rot-schema-alerta');
    assert.match(alerta.innerHTML || alerta.textContent, /Schema indisponível|aplicação controlada|migration/i);
    const previa = makeEl('coz-rot-previa-alerta');
    assert.match(previa.innerHTML || previa.textContent, /Prévia visual|não são configurações salvas/i);
    const conteudo = makeEl('coz-rot-conteudo');
    assert.equal(conteudo.classList.contains('d-none'), false, 'painel permanece visível no 503');
    assert.equal(makeEl('coz-rot-btn-salvar-modo').disabled, true);
    assert.equal(makeEl('coz-rot-btn-salvar-padrao').disabled, true);
    assert.equal(makeEl('coz-rot-unidade-padrao').disabled, true);
    assert.equal(makeEl('coz-rot-modo-padrao').disabled, true);
    const meta = makeEl('coz-rot-meta');
    assert.match(meta.textContent, /Prévia visual|sem configuração persistida/i);
    assert.doesNotMatch(meta.textContent, /Atualizado em:/);
  });

  it('UI: API 200 apresenta dados reais com gravação habilitada', async () => {
    const { host, makeEl } = criarHostFake();
    const fakeGlobal = {
      API_URL: baseUrl + '/api',
      document: { addEventListener() {}, removeEventListener() {} },
      localStorage: { getItem(k) { return k === 'token' ? tokenAdmin : null; } },
      CdsEmpresaContexto: {
        temEmpresaSelecionada() { return true; },
        headersJson(extra) {
          return Object.assign({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenAdmin}`,
            'X-Empresa-Id': String(empresaId)
          }, extra || {});
        }
      },
      fetch: async (url, opts) => {
        const u = new URL(String(url), baseUrl);
        const rr = await requestJson((opts && opts.method) || 'GET', u.pathname + u.search, {
          token: tokenAdmin,
          body: opts && opts.body ? JSON.parse(opts.body) : undefined
        });
        return {
          ok: rr.status >= 200 && rr.status < 300,
          status: rr.status,
          async json() { return rr.body; }
        };
      }
    };
    const ctrl = ui.montarNoNavegador(fakeGlobal);
    await ctrl.iniciar(host);
    assert.equal(ctrl.getEstado().schemaIndisponivel, false);
    assert.equal(ctrl.getEstado().previaVisual, false);
    assert.equal(makeEl('coz-rot-conteudo').classList.contains('d-none'), false);
    assert.equal(makeEl('coz-rot-btn-salvar-modo').disabled, false);
    assert.equal(makeEl('coz-rot-unidade-padrao').disabled, false);
    const cfg = ctrl.getEstado().config;
    assert.ok(cfg);
    assert.equal(cfg.unidade_padrao_id, unA);
  });

  it('UI: PUT 503 mantém gravação desabilitada após finally (modo/padrão/segmento)', async () => {
    const caminhos = [
      {
        nome: 'modo',
        pathRe: /\/roteamento\/modo/,
        preparar(makeEl) {
          makeEl('coz-rot-modo-padrao').checked = true;
          makeEl('coz-rot-modo-padrao').value = 'COZINHA_PADRAO';
          makeEl('coz-rot-modo-segmento').checked = false;
        },
        acionar(ctrl) { return ctrl.salvarModo(); },
        botaoId: 'coz-rot-btn-salvar-modo'
      },
      {
        nome: 'padrao',
        pathRe: /\/roteamento\/padrao/,
        preparar(makeEl) {
          makeEl('coz-rot-unidade-padrao').value = String(unA);
        },
        acionar(ctrl) { return ctrl.salvarPadrao(); },
        botaoId: 'coz-rot-btn-salvar-padrao'
      },
      {
        nome: 'segmento',
        pathRe: /\/roteamento\/segmentos/,
        preparar(makeEl) {
          const sel = makeEl('coz-rot-seg-unidade-proxy');
          sel.value = String(unA);
        },
        acionar(ctrl) { return ctrl.salvarSegmento('LOJA'); },
        botaoId: 'coz-rot-btn-seg-proxy'
      }
    ];

    for (const caminho of caminhos) {
      const { host, makeEl } = criarHostFake();
      caminho.preparar(makeEl);
      let putCount = 0;
      const puts = [];

      const fakeGlobal = {
        API_URL: baseUrl + '/api',
        document: { addEventListener() {}, removeEventListener() {} },
        localStorage: { getItem(k) { return k === 'token' ? tokenAdmin : null; } },
        CdsEmpresaContexto: {
          temEmpresaSelecionada() { return true; },
          headersJson(extra) {
            return Object.assign({
              Accept: 'application/json',
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tokenAdmin}`,
              'X-Empresa-Id': String(empresaId)
            }, extra || {});
          }
        },
        fetch: async (url, opts) => {
          const method = (opts && opts.method) || 'GET';
          const abs = String(url);
          if (method === 'PUT' && /\/roteamento\//.test(abs)) {
            putCount += 1;
            puts.push({ url: abs, method });
            return {
              ok: false,
              status: 503,
              async json() {
                return {
                  success: false,
                  codigo: 'SCHEMA_ROTEAMENTO_INDISPONIVEL',
                  mensagem: 'Schema de roteamento indisponível.'
                };
              }
            };
          }
          // GET unidades / roteamento → 200 real (gravação inicialmente liberada)
          const u = new URL(abs, baseUrl);
          const rr = await requestJson(method, u.pathname + u.search, {
            token: tokenAdmin,
            body: opts && opts.body ? JSON.parse(opts.body) : undefined
          });
          return {
            ok: rr.status >= 200 && rr.status < 300,
            status: rr.status,
            async json() { return rr.body; }
          };
        }
      };

      const ctrl = ui.montarNoNavegador(fakeGlobal);
      await ctrl.iniciar(host);
      assert.equal(ctrl.getEstado().schemaIndisponivel, false, `${caminho.nome}: schema disponível na carga`);
      assert.equal(makeEl(caminho.botaoId).disabled, false, `${caminho.nome}: botão habilitado antes do PUT`);

      putCount = 0;
      puts.length = 0;
      caminho.preparar(makeEl);
      await caminho.acionar(ctrl);

      assert.equal(putCount, 1, `${caminho.nome}: exatamente um PUT 503`);
      assert.ok(puts.every((p) => caminho.pathRe.test(p.url)), `${caminho.nome}: PUT no endpoint esperado`);
      assert.equal(ctrl.getEstado().schemaIndisponivel, true, `${caminho.nome}: schemaIndisponivel após 503`);
      assert.equal(ctrl.getEstado().previaVisual, true, `${caminho.nome}: prévia após 503`);
      assert.equal(makeEl('coz-rot-conteudo').classList.contains('d-none'), false, `${caminho.nome}: painel visível`);
      assert.match(
        makeEl('coz-rot-previa-alerta').innerHTML || makeEl('coz-rot-previa-alerta').textContent,
        /Prévia visual|não são configurações salvas/i,
        `${caminho.nome}: banner de prévia`
      );
      assert.equal(makeEl(caminho.botaoId).disabled, true, `${caminho.nome}: botão permanece disabled após finally`);
      assert.equal(makeEl('coz-rot-btn-salvar-modo').disabled, true, `${caminho.nome}: salvar modo disabled`);
      assert.equal(makeEl('coz-rot-btn-salvar-padrao').disabled, true, `${caminho.nome}: salvar padrão disabled`);
      assert.equal(makeEl('coz-rot-unidade-padrao').disabled, true, `${caminho.nome}: select padrão disabled`);
      assert.equal(makeEl('coz-rot-modo-padrao').disabled, true, `${caminho.nome}: radio disabled`);
      assert.equal(makeEl('coz-rot-modo-segmento').disabled, true, `${caminho.nome}: radio segmento disabled`);

      const putsAposPrimeiro = putCount;
      await caminho.acionar(ctrl);
      assert.equal(
        putCount,
        putsAposPrimeiro,
        `${caminho.nome}: segunda tentativa não dispara outro PUT (early return)`
      );
      assert.equal(makeEl(caminho.botaoId).disabled, true, `${caminho.nome}: botão ainda disabled na 2ª tentativa`);
    }
  });

  it('UI: bloqueio de operador (403) na carga', async () => {
    const { host, makeEl } = criarHostFake();
    const fakeGlobal = {
      API_URL: baseUrl + '/api',
      document: { addEventListener() {}, removeEventListener() {} },
      localStorage: { getItem(k) { return k === 'token' ? tokenOp : null; } },
      CdsEmpresaContexto: {
        temEmpresaSelecionada() { return true; },
        headersJson(extra) {
          return Object.assign({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOp}`,
            'X-Empresa-Id': String(empresaId)
          }, extra || {});
        }
      },
      fetch: async (url, opts) => {
        const u = new URL(String(url), baseUrl);
        const rr = await requestJson((opts && opts.method) || 'GET', u.pathname + u.search, {
          token: tokenOp,
          body: opts && opts.body ? JSON.parse(opts.body) : undefined
        });
        return {
          ok: rr.status >= 200 && rr.status < 300,
          status: rr.status,
          async json() { return rr.body; }
        };
      }
    };
    const ctrl = ui.montarNoNavegador(fakeGlobal);
    await ctrl.iniciar(host);
    assert.equal(ctrl.getEstado().bloqueado, true);
    const box = makeEl('coz-rot-bloqueio');
    assert.match(box.textContent, /administrador operacional|permissão/i);
  });

  it('flags de isolamento e DB_DIR temporário', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB == null, true);
    assert.ok(String(dbDir).includes('cds-cozinha-s07-3b'));
  });
});
