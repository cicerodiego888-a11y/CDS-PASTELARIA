/**
 * Sprint 07 · S07-2 — Gestão administrativa de unidades de cozinha.
 * Banco temporário. Sem banco oficial. Sem impressão / SEFAZ / pagamentos / S07-3.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-2-gestao-unidades-admin.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-2-gestao-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-2-gestao';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');
const { garantirTabelaOperadorUnidades } = require('../../backend/services/cozinha/cozinhaAuthUnidade');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CozinhaUnidadeCadastro = require('../../backend/services/cozinha/CozinhaUnidadeCadastroService');
const CozinhaSessaoUnidade = require('../../backend/services/cozinha/CozinhaSessaoUnidadeService');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');
const ui = require('../../frontend/erp/js/cozinha-unidades.js');

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
function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function prepararBase(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'operador',
      perfil TEXT DEFAULT 'USUARIO',
      ativo INTEGER DEFAULT 1,
      nome TEXT
    )
  `);
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  await garantirTabelaOperadorUnidades(db);

  const emp1 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111', 'Empresa 1', 'E1', 1)
  `);
  const emp2 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122', 'Empresa 2', 'E2', 1)
  `);

  const op = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_gestao', 'hash', 'operador', 'USUARIO', 1, 'Operador')
  `);
  const admin = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('admin_gestao', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);

  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [op.lastID, emp1.lastID]);
  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [admin.lastID, emp1.lastID]);

  const unA = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UA', 1)
  `, [emp1.lastID]);
  const unOutra = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UX', 1)
  `, [emp2.lastID]);

  await run(db, `
    INSERT INTO cozinha_operador_unidades (empresa_id, operador_id, unidade_id, ativo)
    VALUES (?, ?, ?, 1)
  `, [emp1.lastID, op.lastID, unA.lastID]);

  return {
    emp1: emp1.lastID,
    emp2: emp2.lastID,
    opId: op.lastID,
    adminId: admin.lastID,
    unA: unA.lastID,
    unOutra: unOutra.lastID
  };
}

function userOp(ctx) {
  return { id: ctx.opId, username: 'op_gestao', role: 'operador', perfil: 'USUARIO', permissoes: [] };
}
function userAdmin(ctx) {
  return { id: ctx.adminId, username: 'admin_gestao', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}

describe('S07-2 gestão — serviço (memória)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('admin lista ativas e inativas da empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UI', 0)
    `, [ctx.emp1]);
    const out = await CozinhaUnidadeCadastro.listarUnidadesGestao({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    const codigos = out.unidades.map((u) => u.codigo).sort();
    assert.deepEqual(codigos, ['UA', 'UI']);
    assert.ok(out.unidades.some((u) => u.codigo === 'UI' && u.ativo === false));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unOutra));
    await close(db);
  });

  it('operador comum é bloqueado na listagem de gestão', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaUnidadeCadastro.listarUnidadesGestao({
        user: userOp(ctx),
        empresaId: ctx.emp1
      }, { db }),
      (err) => err.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO' && err.statusCode === 403
    );
    await close(db);
  });

  it('admin cadastra unidade na empresa do contexto', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaUnidadeCadastro.criarUnidade({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      codigoRaw: 'COZ-01',
      ativoRaw: true,
      bodyEmpresaIdIgnored: ctx.emp2
    }, { db });
    assert.equal(out.success, true);
    assert.equal(out.unidade.codigo, 'COZ-01');
    assert.equal(out.unidade.empresa_id, ctx.emp1);
    assert.equal(out.unidade.ativo, true);
    const row = await get(db, 'SELECT empresa_id FROM cozinha_unidades WHERE id = ?', [out.unidade.id]);
    assert.equal(Number(row.empresa_id), ctx.emp1);
    await close(db);
  });

  it('código duplicado é rejeitado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaUnidadeCadastro.criarUnidade({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        codigoRaw: 'UA'
      }, { db }),
      (err) => err.codigo === 'CODIGO_DUPLICADO' && err.statusCode === 409
    );
    await close(db);
  });

  it('mesmo código em outra empresa é permitido', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaUnidadeCadastro.criarUnidade({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      codigoRaw: 'UX'
    }, { db });
    assert.equal(out.unidade.codigo, 'UX');
    assert.equal(out.unidade.empresa_id, ctx.emp1);
    await close(db);
  });

  it('operador não pode cadastrar', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaUnidadeCadastro.criarUnidade({
        user: userOp(ctx),
        empresaId: ctx.emp1,
        codigoRaw: 'NOVA'
      }, { db }),
      (err) => err.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
    await close(db);
  });

  it('código vazio é rejeitado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaUnidadeCadastro.criarUnidade({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        codigoRaw: '   '
      }, { db }),
      (err) => err.codigo === 'CODIGO_OBRIGATORIO'
    );
    await close(db);
  });

  it('PATCH inativa unidade da própria empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaUnidadeCadastro.alterarSituacaoUnidade({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      unidadeIdRaw: ctx.unA,
      ativoRaw: false
    }, { db });
    assert.equal(out.unidade.ativo, false);
    const row = await get(db, 'SELECT ativo FROM cozinha_unidades WHERE id = ?', [ctx.unA]);
    assert.equal(Number(row.ativo), 0);
    await close(db);
  });

  it('PATCH em unidade de outra empresa é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaUnidadeCadastro.alterarSituacaoUnidade({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        unidadeIdRaw: ctx.unOutra,
        ativoRaw: false
      }, { db }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO' && err.statusCode === 403
    );
    const row = await get(db, 'SELECT ativo FROM cozinha_unidades WHERE id = ?', [ctx.unOutra]);
    assert.equal(Number(row.ativo), 1);
    await close(db);
  });

  it('unidade inativa não aparece na seleção KDS; admin vê só ativas', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await CozinhaUnidadeCadastro.criarUnidade({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      codigoRaw: 'UB',
      ativoRaw: true
    }, { db });
    await CozinhaUnidadeCadastro.alterarSituacaoUnidade({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      unidadeIdRaw: ctx.unA,
      ativoRaw: false
    }, { db });

    const kdsAdmin = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.deepEqual(kdsAdmin.unidades.map((u) => u.codigo).sort(), ['UB']);
    assert.ok(!kdsAdmin.unidades.some((u) => u.codigo === 'UA'));

    const kdsOp = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userOp(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(kdsOp.unidades.length, 0);
    assert.equal(kdsOp.codigo, 'SEM_VINCULO_OPERADOR');
    await close(db);
  });

  it('operador continua limitado aos vínculos após cadastro admin', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await CozinhaUnidadeCadastro.criarUnidade({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      codigoRaw: 'UB'
    }, { db });
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userOp(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.deepEqual(out.unidades.map((u) => u.codigo), ['UA']);
    await close(db);
  });
});

describe('S07-2 gestão — UI markup', () => {
  it('breadcrumb e campos mínimos presentes', () => {
    const html = ui.montarMarkup();
    assert.match(html, /Gestão de Cozinhas/);
    assert.match(html, /Unidades de Cozinha/);
    assert.match(html, /coz-un-codigo/);
    assert.match(html, /coz-un-ativo/);
    assert.match(html, /Nova Unidade/);
  });

  it('renderLinhas distingue ativa/inativa', () => {
    const html = ui.renderLinhas([
      { id: 1, codigo: 'A', empresa_id: 10, ativo: true },
      { id: 2, codigo: 'B', empresa_id: 10, ativo: false }
    ], 10);
    assert.match(html, /Ativa/);
    assert.match(html, /Inativa/);
    assert.match(html, /data-acao="inativar"/);
    assert.match(html, /data-acao="ativar"/);
  });
});

describe('S07-2 gestão — HTTP', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let empresaOutraId;
  let adminId;
  let opId;
  let unidadeOutraEmp;
  let tokenAdmin;
  let tokenOp;

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
    let ultimoErroSchema = null;
    for (let tentativa = 0; tentativa < 8; tentativa += 1) {
      try {
        schemaOut = await garantirSchemaCozinha(dbHttp);
        ultimoErroSchema = null;
        break;
      } catch (err) {
        ultimoErroSchema = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!schemaOut || !schemaOut.operacional) {
      throw ultimoErroSchema || new Error('Schema Cozinha não operacional');
    }
    await garantirTabelaOperadorUnidades(dbHttp);
    assert.equal(isCozinhaOperacional(), true);

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('99887766000155', 'Emp Gestao', 'EG', 1)
    `);
    empresaId = emp.lastID;
    const emp2 = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('99887766000236', 'Emp Gestao B', 'EGB', 1)
    `);
    empresaOutraId = emp2.lastID;

    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_gestao_http', 'hash', 'admin', 'ADMIN', 1, 'Admin HTTP')
    `);
    adminId = adm.lastID;
    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_gestao_http', 'hash', 'operador', 'USUARIO', 1, 'Op HTTP')
    `);
    opId = op.lastID;

    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [adminId, empresaId]);
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [opId, empresaId]);

    const unOutra = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'OUTRA', 1)
    `, [empresaOutraId]);
    unidadeOutraEmp = unOutra.lastID;

    tokenAdmin = jwt.sign({
      id: adminId, username: 'admin_gestao_http', role: 'admin', perfil: 'ADMIN', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenOp = jwt.sign({
      id: opId, username: 'op_gestao_http', role: 'operador', perfil: 'USUARIO', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const app = express();
    app.use(express.json());
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('POST cria unidade e GET lista incluindo inativas', async () => {
    const created = await requestJson('POST', '/api/cozinha/unidades', {
      token: tokenAdmin,
      body: { codigo: 'GEST-01', ativo: true, empresa_id: empresaOutraId }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.unidade.codigo, 'GEST-01');
    assert.equal(created.body.unidade.empresa_id, empresaId);

    const id = created.body.unidade.id;
    await requestJson('PATCH', `/api/cozinha/unidades/${id}`, {
      token: tokenAdmin,
      body: { ativo: false }
    });

    const lista = await requestJson('GET', '/api/cozinha/unidades', { token: tokenAdmin });
    assert.equal(lista.status, 200);
    const gest = (lista.body.unidades || []).find((u) => u.codigo === 'GEST-01');
    assert.ok(gest);
    assert.equal(gest.ativo, false);

    const kds = await requestJson('GET', '/api/cozinha/unidades-disponiveis', { token: tokenAdmin });
    assert.equal(kds.status, 200);
    assert.ok(!(kds.body.unidades || []).some((u) => u.codigo === 'GEST-01'));
  });

  it('POST duplicado → 409', async () => {
    await requestJson('POST', '/api/cozinha/unidades', {
      token: tokenAdmin,
      body: { codigo: 'DUP-01' }
    });
    const r = await requestJson('POST', '/api/cozinha/unidades', {
      token: tokenAdmin,
      body: { codigo: 'DUP-01' }
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'CODIGO_DUPLICADO');
  });

  it('operador → 403 nas rotas de gestão', async () => {
    const g = await requestJson('GET', '/api/cozinha/unidades', { token: tokenOp });
    assert.equal(g.status, 403);
    const p = await requestJson('POST', '/api/cozinha/unidades', {
      token: tokenOp,
      body: { codigo: 'X' }
    });
    assert.equal(p.status, 403);
  });

  it('PATCH unidade de outra empresa → 403', async () => {
    const r = await requestJson('PATCH', `/api/cozinha/unidades/${unidadeOutraEmp}`, {
      token: tokenAdmin,
      body: { ativo: false }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_EMPRESA_ISOLAMENTO');
  });

  it('flags de isolamento ativas', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.ok(String(dbDir).includes(os.tmpdir()) || String(dbDir).includes('cds-cozinha-s07-2-gestao'));
  });
});
