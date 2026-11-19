/**
 * S07-3A — Homologação HTTP com configService.recursoHabilitado ORIGINAL.
 * Sem monkeypatch. Banco temporário. Sem S07-3B / sem oficial / sem despacho.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-3a-roteamento-recurso-real.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-3a-recurso-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-3a-recurso-real';
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

describe('S07-3A — HTTP recursoHabilitado real (sem monkeypatch)', () => {
  let server;
  let baseUrl;
  let dbHttp;
  let empresaId;
  let unA;
  let adminId;
  let opId;
  let tokenAdmin;
  let tokenOp;
  let configAntes;
  let recursoFnOriginal;

  function requestJson(method, urlPath, { token, body, empresaHeader } = {}) {
    const u = new URL(urlPath, baseUrl);
    const emp = empresaHeader != null ? empresaHeader : empresaId;
    const payload = body != null ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(emp != null ? { 'X-Empresa-Id': String(emp) } : {}),
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

  before(async () => {
    recursoFnOriginal = configService.recursoHabilitado;
    assert.equal(typeof recursoFnOriginal, 'function');

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
    // Migration controlada no setup de teste (DB temp) — APIs não fazem DDL.
    await garantirSchemaCozinhaRoteamento(dbHttp);
    const stRot = await verificarSchemaCozinhaRoteamento(dbHttp);
    assert.equal(stRot.disponivel, true);
    assert.equal(isCozinhaOperacional(), true);

    configAntes = configService.readConfig();
    configService.saveConfig({
      tipoImplantacao: 'ERP_SEM_FISCAL',
      modoOperacao: 'LOCAL',
      modulo_pedidos: true,
      habilitar_expedicao: false,
      habilitar_faturamento: false
    });
    assert.strictEqual(
      configService.recursoHabilitado,
      recursoFnOriginal,
      'recursoHabilitado não deve ser substituído neste teste'
    );
    assert.equal(configService.recursoHabilitado('pedidos'), true);
    assert.equal(configService.getRecursos().recursos.pedidos, true);

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('99887766000133', 'Emp R3A Recurso', 'R3AR', 1)
    `);
    empresaId = emp.lastID;

    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_r3a_recurso', 'hash', 'admin', 'ADMIN', 1, 'Admin')
    `);
    adminId = adm.lastID;
    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_r3a_recurso', 'hash', 'operador', 'USUARIO', 1, 'Op')
    `);
    opId = op.lastID;

    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [adminId, empresaId]);
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [opId, empresaId]);

    const u1 = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3A-R-01', 1)
    `, [empresaId]);
    unA = u1.lastID;

    tokenAdmin = jwt.sign({
      id: adminId, username: 'admin_r3a_recurso', role: 'admin', perfil: 'ADMIN', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenOp = jwt.sign({
      id: opId, username: 'op_r3a_recurso', role: 'operador', perfil: 'USUARIO', permissoes: []
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
    assert.strictEqual(
      configService.recursoHabilitado,
      recursoFnOriginal,
      'recursoHabilitado permanece a função original ao final'
    );
    if (configAntes) {
      try {
        configService.saveConfig({
          modulo_pedidos: configAntes.modulo_pedidos,
          habilitar_expedicao: configAntes.habilitar_expedicao,
          habilitar_faturamento: configAntes.habilitar_faturamento,
          tipoImplantacao: configAntes.tipoImplantacao,
          modoOperacao: configAntes.modoOperacao
        });
      } catch (_e) { /* temp dir */ }
    }
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('pedidos habilitado: admin autorizado opera GET/PUT roteamento', async () => {
    assert.strictEqual(configService.recursoHabilitado, recursoFnOriginal);
    assert.equal(configService.recursoHabilitado('pedidos'), true);

    const padrao = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unA }
    });
    assert.equal(padrao.status, 200, JSON.stringify(padrao.body));
    assert.equal(padrao.body.unidade_padrao_id, unA);

    const getCfg = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenAdmin });
    assert.equal(getCfg.status, 200);
    assert.equal(getCfg.body.unidade_padrao_id, unA);
  });

  it('operador continua 403 ADMIN_OPERACIONAL_OBRIGATORIO com pedidos habilitado', async () => {
    assert.equal(configService.recursoHabilitado('pedidos'), true);
    const r = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenOp });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'ADMIN_OPERACIONAL_OBRIGATORIO');
  });

  it('pedidos desabilitado via saveConfig → 403 MODULO_NAO_LICENCIADO (sem monkeypatch)', async () => {
    configService.saveConfig({ modulo_pedidos: false });
    assert.strictEqual(configService.recursoHabilitado, recursoFnOriginal);
    assert.equal(configService.recursoHabilitado('pedidos'), false);

    const g = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenAdmin });
    assert.equal(g.status, 403);
    assert.equal(g.body.erro, 'MODULO_NAO_LICENCIADO');
    assert.equal(g.body.modulo, 'pedidos');

    const p = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unA }
    });
    assert.equal(p.status, 403);
    assert.equal(p.body.erro, 'MODULO_NAO_LICENCIADO');

    configService.saveConfig({ modulo_pedidos: true });
    assert.equal(configService.recursoHabilitado('pedidos'), true);
  });

  it('flags de isolamento e DB temporário', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB == null, true);
    assert.ok(String(dbDir).includes('cds-cozinha-s07-3a-recurso'));
  });
});
