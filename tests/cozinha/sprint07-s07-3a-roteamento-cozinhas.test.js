/**
 * Sprint 07 · S07-3A — Configuração de roteamento de cozinhas.
 * Banco temporário. Sem banco oficial. Sem despacho / KDS / S07-3B+.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-3a-roteamento-cozinhas.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-3a-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-3a-roteamento';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const Roteamento = require('../../backend/services/cozinha/CozinhaRoteamentoConfigService');
const {
  garantirSchemaCozinhaRoteamento,
  verificarSchemaCozinhaRoteamento
} = require('../../backend/services/cozinha/cozinhaRoteamentoSchema');
const {
  SEGMENTOS_BASE,
  listarSegmentosPermitidos,
  registrarSegmentoExtra,
  limparSegmentosExtra
} = require('../../backend/services/cozinha/cozinhaRoteamentoSegmentos');
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
  // DDL só no setup de teste — APIs usam exigirSchema (sem CREATE).
  await garantirSchemaCozinhaRoteamento(db);

  const emp1 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111', 'Empresa 1', 'E1', 1)
  `);
  const emp2 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122', 'Empresa 2', 'E2', 1)
  `);

  const admin = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('admin_r3a', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);
  const op = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_r3a', 'hash', 'operador', 'USUARIO', 1, 'Op')
  `);

  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [admin.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [op.lastID, emp1.lastID]);

  const unA = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-01', 1)
  `, [emp1.lastID]);
  const unB = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-02', 1)
  `, [emp1.lastID]);
  const unInativa = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-OFF', 0)
  `, [emp1.lastID]);
  const unOutra = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-X', 1)
  `, [emp2.lastID]);

  return {
    emp1: emp1.lastID,
    emp2: emp2.lastID,
    adminId: admin.lastID,
    opId: op.lastID,
    unA: unA.lastID,
    unB: unB.lastID,
    unInativa: unInativa.lastID,
    unOutra: unOutra.lastID
  };
}

function userAdmin(ctx) {
  return { id: ctx.adminId, username: 'admin_r3a', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}
function userOp(ctx) {
  return { id: ctx.opId, username: 'op_r3a', role: 'operador', perfil: 'USUARIO', permissoes: [] };
}

describe('S07-3A — serviço roteamento (memória)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('cria e lê configuração (cozinha padrão)', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const padrao = await Roteamento.definirCozinhaPadrao({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      unidadeIdRaw: ctx.unA,
      bodyEmpresaIdIgnored: ctx.emp2
    }, { db });
    assert.equal(padrao.configurado, true);
    assert.equal(padrao.modo, 'COZINHA_PADRAO');
    assert.equal(padrao.unidade_padrao_id, ctx.unA);
    assert.equal(padrao.empresa_id, ctx.emp1);

    const leitura = await Roteamento.obterConfiguracao({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(leitura.unidade_padrao_id, ctx.unA);
    assert.equal(leitura.unidade_padrao.codigo, 'COZ-01');
    await close(db);
  });

  it('altera entre COZINHA_PADRAO e COZINHA_POR_SEGMENTO', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Roteamento.definirCozinhaPadrao({
      user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unA
    }, { db });
    const seg = await Roteamento.associarSegmento({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      segmentoRaw: 'IFOOD',
      unidadeIdRaw: ctx.unB
    }, { db });
    assert.ok(seg.segmentos.some((s) => s.segmento === 'IFOOD' && s.unidade_id === ctx.unB));

    const modoSeg = await Roteamento.definirModo({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      modoRaw: 'COZINHA_POR_SEGMENTO'
    }, { db });
    assert.equal(modoSeg.modo, 'COZINHA_POR_SEGMENTO');

    const volta = await Roteamento.definirModo({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      modoRaw: 'COZINHA_PADRAO'
    }, { db });
    assert.equal(volta.modo, 'COZINHA_PADRAO');
    assert.equal(volta.unidade_padrao_id, ctx.unA);
    await close(db);
  });

  it('cozinha padrão inexistente é rejeitada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Roteamento.definirCozinhaPadrao({
        user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: 999999
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INEXISTENTE'
    );
    await close(db);
  });

  it('cozinha inativa é rejeitada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Roteamento.definirCozinhaPadrao({
        user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unInativa
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INATIVA' && err.statusCode === 409
    );
    await assert.rejects(
      () => Roteamento.associarSegmento({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        segmentoRaw: 'LOJA',
        unidadeIdRaw: ctx.unInativa
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INATIVA'
    );
    await close(db);
  });

  it('unidade de outra empresa é bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Roteamento.definirCozinhaPadrao({
        user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unOutra
      }, { db }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO' && err.statusCode === 403
    );
    await assert.rejects(
      () => Roteamento.associarSegmento({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        segmentoRaw: 'PEDIDO_ONLINE',
        unidadeIdRaw: ctx.unOutra
      }, { db }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );
    await close(db);
  });

  it('segmento sem destino é rejeitado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Roteamento.associarSegmento({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        segmentoRaw: 'LOJA',
        unidadeIdRaw: null
      }, { db }),
      (err) => err.codigo === 'SEGMENTO_SEM_DESTINO' && err.statusCode === 400
    );
    await close(db);
  });

  it('operador sem autorização é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Roteamento.obterConfiguracao({ user: userOp(ctx), empresaId: ctx.emp1 }, { db }),
      (err) => err.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
    await assert.rejects(
      () => Roteamento.definirCozinhaPadrao({
        user: userOp(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unA
      }, { db }),
      (err) => err.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
    await close(db);
  });

  it('isolamento: config da empresa 1 não vaza para empresa 2', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Roteamento.definirCozinhaPadrao({
      user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unA
    }, { db });
    await Roteamento.associarSegmento({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      segmentoRaw: 'IFOOD',
      unidadeIdRaw: ctx.unB
    }, { db });

    const outra = await Roteamento.obterConfiguracao({
      user: userAdmin(ctx),
      empresaId: ctx.emp2
    }, { db });
    assert.equal(outra.configurado, false);
    assert.equal(outra.unidade_padrao_id, null);
    assert.equal(outra.segmentos.length, 0);
    await close(db);
  });

  it('persistência: nova leitura mantém modo e associações', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Roteamento.definirCozinhaPadrao({
      user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unA
    }, { db });
    await Roteamento.associarSegmento({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      segmentoRaw: 'LOJA',
      unidadeIdRaw: ctx.unA
    }, { db });
    await Roteamento.definirModo({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      modoRaw: 'COZINHA_POR_SEGMENTO'
    }, { db });

    const novamente = await Roteamento.obterConfiguracao({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(novamente.modo, 'COZINHA_POR_SEGMENTO');
    assert.equal(novamente.unidade_padrao_id, ctx.unA);
    assert.deepEqual(
      novamente.segmentos.map((s) => ({ segmento: s.segmento, unidade_id: s.unidade_id })),
      [{ segmento: 'LOJA', unidade_id: ctx.unA }]
    );
    await close(db);
  });

  it('modo PADRAO sem cozinha padrão prévia é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Roteamento.definirModo({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        modoRaw: 'COZINHA_PADRAO'
      }, { db }),
      (err) => err.codigo === 'COZINHA_PADRAO_OBRIGATORIA'
    );
    await close(db);
  });

  it('schema ausente: API retorna SCHEMA_ROTEAMENTO_INDISPONIVEL sem DDL', async () => {
    const db = await openMem();
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

    const antes = await verificarSchemaCozinhaRoteamento(db);
    assert.equal(antes.disponivel, false);
    assert.ok(antes.faltando.includes('cozinha_roteamento_config'));

    const emp = await run(db, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('55555555000155', 'Emp Schema', 'ES', 1)
    `);
    const adm = await run(db, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_schema', 'hash', 'admin', 'ADMIN', 1, 'Admin')
    `);

    await assert.rejects(
      () => Roteamento.obterConfiguracao({
        user: { id: adm.lastID, role: 'admin', perfil: 'ADMIN' },
        empresaId: emp.lastID
      }, { db }),
      (err) => err.codigo === 'SCHEMA_ROTEAMENTO_INDISPONIVEL' && err.statusCode === 503
    );
    await assert.rejects(
      () => Roteamento.definirCozinhaPadrao({
        user: { id: adm.lastID, role: 'admin', perfil: 'ADMIN' },
        empresaId: emp.lastID,
        unidadeIdRaw: 1
      }, { db }),
      (err) => err.codigo === 'SCHEMA_ROTEAMENTO_INDISPONIVEL'
    );

    const depois = await verificarSchemaCozinhaRoteamento(db);
    assert.equal(depois.disponivel, false, 'APIs não devem criar tabelas');
    assert.deepEqual(depois.faltando, antes.faltando);
    await close(db);
  });

  it('segmentos base preservados e extensão sem alterar lógica central', async () => {
    limparSegmentosExtra();
    assert.deepEqual(SEGMENTOS_BASE, ['LOJA', 'IFOOD', 'PEDIDO_ONLINE']);
    assert.deepEqual(listarSegmentosPermitidos(), ['LOJA', 'IFOOD', 'PEDIDO_ONLINE']);

    registrarSegmentoExtra('UBER_EATS');
    assert.ok(listarSegmentosPermitidos().includes('UBER_EATS'));
    assert.deepEqual(SEGMENTOS_BASE, ['LOJA', 'IFOOD', 'PEDIDO_ONLINE']);

    const db = await openMem();
    const ctx = await prepararBase(db);
    const assoc = await Roteamento.associarSegmento({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      segmentoRaw: 'UBER_EATS',
      unidadeIdRaw: ctx.unA
    }, { db });
    assert.ok(assoc.segmentos.some((s) => s.segmento === 'UBER_EATS' && s.unidade_id === ctx.unA));
    assert.ok(assoc.segmentos_permitidos.includes('UBER_EATS'));
    assert.deepEqual(assoc.segmentos_base, ['LOJA', 'IFOOD', 'PEDIDO_ONLINE']);

    await assert.rejects(
      () => Roteamento.associarSegmento({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        segmentoRaw: 'PLATAFORMA_DESCONHECIDA',
        unidadeIdRaw: ctx.unA
      }, { db }),
      (err) => err.codigo === 'SEGMENTO_INVALIDO'
    );

    limparSegmentosExtra();
    await close(db);
  });
});

describe('S07-3A — HTTP roteamento', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let empresaOutraId;
  let adminId;
  let opId;
  let unA;
  let unOutra;
  let unInativa;
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
    // DDL controlado no setup de teste — não via API.
    await garantirSchemaCozinhaRoteamento(dbHttp);
    assert.equal(isCozinhaOperacional(), true);

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('33445566000177', 'Emp R3A', 'R3A', 1)
    `);
    empresaId = emp.lastID;
    const emp2 = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('33445566000258', 'Emp R3A B', 'R3AB', 1)
    `);
    empresaOutraId = emp2.lastID;

    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_r3a_http', 'hash', 'admin', 'ADMIN', 1, 'Admin')
    `);
    adminId = adm.lastID;
    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_r3a_http', 'hash', 'operador', 'USUARIO', 1, 'Op')
    `);
    opId = op.lastID;
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [adminId, empresaId]);
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [opId, empresaId]);

    const u1 = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3A-01', 1)
    `, [empresaId]);
    unA = u1.lastID;
    const uOff = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3A-OFF', 0)
    `, [empresaId]);
    unInativa = uOff.lastID;
    const uX = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3A-X', 1)
    `, [empresaOutraId]);
    unOutra = uX.lastID;

    tokenAdmin = jwt.sign({
      id: adminId, username: 'admin_r3a_http', role: 'admin', perfil: 'ADMIN', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenOp = jwt.sign({
      id: opId, username: 'op_r3a_http', role: 'operador', perfil: 'USUARIO', permissoes: []
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

  it('GET/PUT padrao + segmentos + modo via HTTP', async () => {
    const vazio = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenAdmin });
    assert.equal(vazio.status, 200);
    assert.equal(vazio.body.configurado, false);

    const padrao = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unA, empresa_id: empresaOutraId }
    });
    assert.equal(padrao.status, 200);
    assert.equal(padrao.body.unidade_padrao_id, unA);
    assert.equal(padrao.body.empresa_id, empresaId);

    const seg = await requestJson('PUT', '/api/cozinha/roteamento/segmentos', {
      token: tokenAdmin,
      body: { segmento: 'IFOOD', unidade_id: unA }
    });
    assert.equal(seg.status, 200);
    assert.ok(seg.body.segmentos.some((s) => s.segmento === 'IFOOD'));

    const modo = await requestJson('PUT', '/api/cozinha/roteamento/modo', {
      token: tokenAdmin,
      body: { modo: 'COZINHA_POR_SEGMENTO' }
    });
    assert.equal(modo.status, 200);
    assert.equal(modo.body.modo, 'COZINHA_POR_SEGMENTO');

    const leitura = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenAdmin });
    assert.equal(leitura.body.modo, 'COZINHA_POR_SEGMENTO');
    assert.equal(leitura.body.unidade_padrao_id, unA);
  });

  it('HTTP: inativa / outra empresa / sem destino / operador', async () => {
    const inativa = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unInativa }
    });
    assert.equal(inativa.status, 409);
    assert.equal(inativa.body.codigo, 'UNIDADE_INATIVA');

    const outra = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unOutra }
    });
    assert.equal(outra.status, 403);
    assert.equal(outra.body.codigo, 'UNIDADE_EMPRESA_ISOLAMENTO');

    const semDest = await requestJson('PUT', '/api/cozinha/roteamento/segmentos', {
      token: tokenAdmin,
      body: { segmento: 'LOJA' }
    });
    assert.equal(semDest.status, 400);
    assert.equal(semDest.body.codigo, 'SEGMENTO_SEM_DESTINO');

    const opGet = await requestJson('GET', '/api/cozinha/roteamento', { token: tokenOp });
    assert.equal(opGet.status, 403);
    assert.equal(opGet.body.codigo, 'ADMIN_OPERACIONAL_OBRIGATORIO');
  });

  it('flags de isolamento e DB_DIR temporário', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB == null, true);
    assert.ok(String(dbDir).includes('cds-cozinha-s07-3a'));
  });
});
