/**
 * Correção 05 — Testes HTTP de segurança da rota real Cozinha.
 * Banco temporário. Não altera middlewares globais.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint02-http-seguranca.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, before, after } = require('node:test');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s02-http-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = 'test-only-cozinha-http-secret';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const db = require('../../backend/database');
const cozinhaRoutes = require('../../backend/rotas/cozinha');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');
const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');

function whenReady(database) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Banco isolado não ficou pronto a tempo.')), 60000);
    database.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function run(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function requestJson(baseUrl, method, urlPath, { token, headers = {}, body } = {}) {
  const u = new URL(urlPath, baseUrl);
  const payload = body == null ? null : JSON.stringify(body);
  const hdrs = { ...headers };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  if (payload) hdrs['Content-Type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        ...hdrs,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_e) { json = { raw }; }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Sprint 02 — HTTP segurança /api/cozinha', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let tokenAutorizado;
  let tokenSemVinculo;
  let empresaId;

  before(async () => {
    await whenReady(db);
    // Aguarda init assíncrono do database.js para evitar SQLITE_LOCKED na corrida de schema.
    for (let i = 0; i < 40 && !getCozinhaSchemaStatus().operacional; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await garantirSchemaCozinha(db);
    marcarCozinhaOperacional(true);

    // Habilita recurso pedidos sem alterar o middleware exigirRecurso
    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    // usuários reais (FK de usuario_empresas → usuarios)
    await run(db, `
      INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
      VALUES (50, 'op_cozinha_ok', 'hash-teste', 'operador', 'USUARIO', 1)
    `);
    await run(db, `
      INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
      VALUES (51, 'op_cozinha_no', 'hash-teste', 'operador', 'USUARIO', 1)
    `);

    const emp = await run(db, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('12345678000199', 'Empresa Audit Cozinha', 'Audit Cozinha', 1)
    `);
    empresaId = emp.lastID;

    await run(db, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo)
      VALUES (50, ?, 1)
    `, [empresaId]);

    tokenAutorizado = jwt.sign(
      { id: 50, role: 'operador', perfil: 'USUARIO' },
      process.env.JWT_SECRET
    );
    tokenSemVinculo = jwt.sign(
      { id: 51, role: 'operador', perfil: 'USUARIO' },
      process.env.JWT_SECRET
    );

    const app = express();
    app.use(express.json());
    // Espelha o mount de backend/server.js
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);

    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });

  it('1) sem autenticação → 401', async () => {
    const status = await requestJson(baseUrl, 'GET', '/api/cozinha/status');
    assert.equal(status.status, 401);
    const despacho = await requestJson(baseUrl, 'POST', '/api/cozinha/despacho', {
      body: { unidade_id: 1, mesa_id: 1, atendimento_id: 1, itens: [] }
    });
    assert.equal(despacho.status, 401);
  });

  it('2) autenticado sem contexto de empresa → EMPRESA_CONTEXT_REQUIRED', async () => {
    const res = await requestJson(baseUrl, 'POST', '/api/cozinha/despacho', {
      token: tokenAutorizado,
      headers: { 'Idempotency-Key': 'http-sem-empresa' },
      body: {
        unidade_id: 1,
        mesa_id: 1,
        atendimento_id: 1,
        itens: [{ pedido_id: 1, pedido_item_id: 1, comanda_id: 1, qty_solicitada: '1.000' }]
      }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.codigo, 'EMPRESA_CONTEXT_REQUIRED');
  });

  it('3) autenticado sem vínculo com a empresa → 403', async () => {
    const res = await requestJson(baseUrl, 'POST', '/api/cozinha/despacho', {
      token: tokenSemVinculo,
      headers: {
        'Idempotency-Key': 'http-sem-vinculo',
        'X-Empresa-Id': String(empresaId)
      },
      body: {
        unidade_id: 1,
        mesa_id: 1,
        atendimento_id: 1,
        itens: [{ pedido_id: 1, pedido_item_id: 1, comanda_id: 1, qty_solicitada: '1.000' }]
      }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code || res.body.codigo, 'EMPRESA_NAO_AUTORIZADA');
  });

  it('4) usuário autorizado com empresa válida alcança o handler', async () => {
    const res = await requestJson(baseUrl, 'GET', '/api/cozinha/status', {
      token: tokenAutorizado,
      headers: { 'X-Empresa-Id': String(empresaId) }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.operacional, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, 'schema'));
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, 'detalhes'));
  });

  it('5) status não expõe erro interno de schema', async () => {
    marcarCozinhaOperacional(false, new Error('SQL path C:\\segredo\\erp.sqlite falhou'));
    const res = await requestJson(baseUrl, 'GET', '/api/cozinha/status', {
      token: tokenAutorizado,
      headers: { 'X-Empresa-Id': String(empresaId) }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.operacional, false);
    const raw = JSON.stringify(res.body);
    assert.ok(!/segredo|erp\.sqlite|SQL path/i.test(raw));
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, 'schema'));
    // restaura operacional para não contaminar
    marcarCozinhaOperacional(true);
    assert.equal(getCozinhaSchemaStatus().operacional, true);
  });
});
