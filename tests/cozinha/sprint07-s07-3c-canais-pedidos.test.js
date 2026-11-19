/**
 * Sprint 07 · S07-3C — Canais dinâmicos de pedidos.
 * Banco temporário. Sem migration no oficial. Sem despacho / iFood / S07-3D+.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-3c-canais-pedidos.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-3c-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-3c-canais';
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
const {
  garantirSchemaCozinhaRoteamento
} = require('../../backend/services/cozinha/cozinhaRoteamentoSchema');
const {
  garantirSchemaCozinhaCanais,
  verificarSchemaCozinhaCanais
} = require('../../backend/services/cozinha/cozinhaCanaisSchema');
const Canais = require('../../backend/services/cozinha/CozinhaCanaisService');
const Roteamento = require('../../backend/services/cozinha/CozinhaRoteamentoConfigService');
const ui = require('../../frontend/erp/js/cozinha-roteamento.js');
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

async function prepararBase(db, { comCanais = true, comRoteamento = true } = {}) {
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
  if (comRoteamento) await garantirSchemaCozinhaRoteamento(db);
  if (comCanais) await garantirSchemaCozinhaCanais(db);

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
    VALUES ('admin_r3c', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);
  const op = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_r3c', 'hash', 'operador', 'USUARIO', 1, 'Op')
  `);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [admin.lastID, emp1.lastID]);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [op.lastID, emp1.lastID]);

  const unA = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-01', 1)`, [emp1.lastID]);
  const unB = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-02', 1)`, [emp1.lastID]);
  const unInativa = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-OFF', 0)`, [emp1.lastID]);
  const unOutra = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'COZ-X', 1)`, [emp2.lastID]);

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
  return { id: ctx.adminId, username: 'admin_r3c', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}
function userOp(ctx) {
  return { id: ctx.opId, username: 'op_r3c', role: 'operador', perfil: 'USUARIO', permissoes: [] };
}

describe('S07-3C — serviço canais (memória)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('cria canal LOJA sem duplicação', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const a = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    assert.ok(a.canais.some((c) => c.codigo === 'LOJA' && c.sistema));
    const b = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    assert.equal(b.canais.filter((c) => c.codigo === 'LOJA').length, 1);
    await close(db);
  });

  it('cadastra canal personalizado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await Canais.criarCanal({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      nomeRaw: 'WhatsApp Delivery',
      bodyEmpresaIdIgnored: ctx.emp2
    }, { db });
    assert.equal(out.canal.nome, 'WhatsApp Delivery');
    assert.equal(out.canal.origem_tipo, 'MANUAL');
    assert.equal(out.canal.ativo, true);
    assert.ok(out.canal.codigo);
    assert.notEqual(out.canal.codigo, 'LOJA');
    assert.equal(out.canal.empresa_id, ctx.emp1);
    await close(db);
  });

  it('rejeita nome vazio', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: '  ' }, { db }),
      (err) => err.codigo === 'NOME_CANAL_OBRIGATORIO'
    );
    await close(db);
  });

  it('previne duplicidade de nome', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: 'App Próprio' }, { db });
    await assert.rejects(
      () => Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: 'app próprio' }, { db }),
      (err) => err.codigo === 'NOME_CANAL_DUPLICADO'
    );
    await close(db);
  });

  it('edita nome do canal', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const criado = await Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: 'Canal X' }, { db });
    const codigoAntes = criado.canal.codigo;
    const out = await Canais.atualizarCanal({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      canalIdRaw: criado.canal.id,
      nomeRaw: 'Canal Y',
      bodyCodigoIgnored: 'HACK'
    }, { db });
    assert.equal(out.canal.nome, 'Canal Y');
    assert.equal(out.canal.codigo, codigoAntes);
    await close(db);
  });

  it('ativa e desativa canal manual', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const criado = await Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: 'Temp' }, { db });
    const off = await Canais.atualizarCanal({
      user: userAdmin(ctx), empresaId: ctx.emp1, canalIdRaw: criado.canal.id, ativoRaw: false
    }, { db });
    assert.equal(off.canal.ativo, false);
    const on = await Canais.atualizarCanal({
      user: userAdmin(ctx), empresaId: ctx.emp1, canalIdRaw: criado.canal.id, ativoRaw: true
    }, { db });
    assert.equal(on.canal.ativo, true);
    await close(db);
  });

  it('protege canal LOJA contra desativação', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const loja = lista.canais.find((c) => c.codigo === 'LOJA');
    await assert.rejects(
      () => Canais.atualizarCanal({
        user: userAdmin(ctx), empresaId: ctx.emp1, canalIdRaw: loja.id, ativoRaw: false
      }, { db }),
      (err) => err.codigo === 'CANAL_LOJA_PROTEGIDO'
    );
    await close(db);
  });

  it('vincula canal a unidade ativa da mesma empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const loja = lista.canais.find((c) => c.codigo === 'LOJA');
    const out = await Canais.definirDestinoCanal({
      user: userAdmin(ctx),
      empresaId: ctx.emp1,
      canalIdRaw: loja.id,
      unidadeIdRaw: ctx.unA,
      bodyEmpresaIdIgnored: ctx.emp2
    }, { db });
    assert.equal(out.canal.destino.unidade_id, ctx.unA);
    assert.equal(out.canal.destino.unidade_codigo, 'COZ-01');
    await close(db);
  });

  it('rejeita unidade inativa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const loja = lista.canais.find((c) => c.codigo === 'LOJA');
    await assert.rejects(
      () => Canais.definirDestinoCanal({
        user: userAdmin(ctx), empresaId: ctx.emp1, canalIdRaw: loja.id, unidadeIdRaw: ctx.unInativa
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INATIVA'
    );
    await close(db);
  });

  it('rejeita unidade de outra empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const lista = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const loja = lista.canais.find((c) => c.codigo === 'LOJA');
    await assert.rejects(
      () => Canais.definirDestinoCanal({
        user: userAdmin(ctx), empresaId: ctx.emp1, canalIdRaw: loja.id, unidadeIdRaw: ctx.unOutra
      }, { db }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );
    await close(db);
  });

  it('isolamento entre empresas', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: 'Só Emp1' }, { db });
    const outra = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp2 }, { db });
    assert.ok(outra.canais.some((c) => c.codigo === 'LOJA'));
    assert.ok(!outra.canais.some((c) => c.nome === 'Só Emp1'));
    await close(db);
  });

  it('operador sem autorização é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => Canais.listarCanais({ user: userOp(ctx), empresaId: ctx.emp1 }, { db }),
      (err) => err.codigo === 'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
    await close(db);
  });

  it('schema ausente: erro controlado sem DDL', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db, { comCanais: false, comRoteamento: false });
    const antes = await verificarSchemaCozinhaCanais(db);
    assert.equal(antes.disponivel, false);
    await assert.rejects(
      () => Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db }),
      (err) => err.codigo === 'SCHEMA_CANAIS_INDISPONIVEL' && err.statusCode === 503
    );
    const depois = await verificarSchemaCozinhaCanais(db);
    assert.equal(depois.disponivel, false);
    assert.deepEqual(depois.faltando, antes.faltando);
    await close(db);
  });

  it('persistência: nova leitura mantém canais e destinos', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const criado = await Canais.criarCanal({ user: userAdmin(ctx), empresaId: ctx.emp1, nomeRaw: 'Persist' }, { db });
    await Canais.definirDestinoCanal({
      user: userAdmin(ctx), empresaId: ctx.emp1, canalIdRaw: criado.canal.id, unidadeIdRaw: ctx.unB
    }, { db });
    const novamente = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    const canal = novamente.canais.find((c) => c.id === criado.canal.id);
    assert.equal(canal.nome, 'Persist');
    assert.equal(canal.destino.unidade_id, ctx.unB);
    await close(db);
  });

  it('compatibilidade APIs antigas de roteamento (S07-3A)', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await Roteamento.definirCozinhaPadrao({
      user: userAdmin(ctx), empresaId: ctx.emp1, unidadeIdRaw: ctx.unA
    }, { db });
    await Roteamento.associarSegmento({
      user: userAdmin(ctx), empresaId: ctx.emp1, segmentoRaw: 'IFOOD', unidadeIdRaw: ctx.unB
    }, { db });
    const cfg = await Roteamento.obterConfiguracao({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    assert.equal(cfg.unidade_padrao_id, ctx.unA);
    assert.ok(cfg.segmentos.some((s) => s.segmento === 'IFOOD'));
    const canais = await Canais.listarCanais({ user: userAdmin(ctx), empresaId: ctx.emp1 }, { db });
    assert.ok(canais.canais.some((c) => c.codigo === 'LOJA'));
    await close(db);
  });
});

describe('S07-3C — rotas registradas em cozinha.js', () => {
  it('GET/POST/PATCH/PUT canais com auth, pedidos e empresa do contexto', () => {
    const rotasPath = path.resolve(__dirname, '../../backend/rotas/cozinha.js');
    const src = fs.readFileSync(rotasPath, 'utf8');

    assert.match(src, /router\.use\(exigirRecurso\('pedidos'\)\)/);
    assert.match(src, /criarMiddlewareContextoEmpresa/);
    assert.match(src, /empresaIdDoReqPedido/);

    assert.match(src, /router\.get\('\/canais'/);
    assert.match(src, /router\.post\('\/canais'/);
    assert.match(src, /router\.patch\('\/canais\/:id'/);
    assert.match(src, /router\.put\('\/canais\/:id\/destino'/);

    // Cada handler de canais exige cozinha operacional e empresa do contexto (não do body).
    const blocoCanais = src.slice(src.indexOf("router.get('/canais'"));
    assert.match(blocoCanais, /exigirCozinhaOperacional/);
    assert.match(blocoCanais, /empresaId:\s*empresaIdDoReqPedido\(req\)/);
    assert.match(blocoCanais, /bodyEmpresaIdIgnored/);
    // Admin operacional é aplicado no serviço (isAdminOperacional → ADMIN_OPERACIONAL_OBRIGATORIO).
    const svc = fs.readFileSync(
      path.resolve(__dirname, '../../backend/services/cozinha/CozinhaCanaisService.js'),
      'utf8'
    );
    assert.match(svc, /exigirAdminOperacional/);
    assert.match(svc, /ADMIN_OPERACIONAL_OBRIGATORIO/);
  });
});

describe('S07-3C — HTTP canais + UI (recursoHabilitado real)', () => {
  let server;
  let baseUrl;
  let recursoFnOriginal;
  let configAntes;
  let dbHttp;
  let empresaId;
  let adminId;
  let opId;
  let unA;
  let unInativa;
  let unOutra;
  let tokenAdmin;
  let tokenOp;

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
    await garantirSchemaCozinhaRoteamento(dbHttp);
    await garantirSchemaCozinhaCanais(dbHttp);
    assert.equal(isCozinhaOperacional(), true);

    // Entitlement real — sem monkeypatch de recursoHabilitado (padrão S07-3A).
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
      VALUES ('55667788000199', 'Emp R3C', 'R3C', 1)
    `);
    empresaId = emp.lastID;
    const emp2 = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('55667788000270', 'Emp R3C B', 'R3CB', 1)
    `);

    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_r3c_http', 'hash', 'admin', 'ADMIN', 1, 'Admin')
    `);
    adminId = adm.lastID;
    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_r3c_http', 'hash', 'operador', 'USUARIO', 1, 'Op')
    `);
    opId = op.lastID;
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [adminId, empresaId]);
    await run(dbHttp, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`, [opId, empresaId]);

    const u1 = await run(dbHttp, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3C-01', 1)`, [empresaId]);
    unA = u1.lastID;
    const uOff = await run(dbHttp, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3C-OFF', 0)`, [empresaId]);
    unInativa = uOff.lastID;
    const uX2 = await run(dbHttp, `INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'R3C-X', 1)`, [emp2.lastID]);
    unOutra = uX2.lastID;

    tokenAdmin = jwt.sign({
      id: adminId, username: 'admin_r3c_http', role: 'admin', perfil: 'ADMIN', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokenOp = jwt.sign({
      id: opId, username: 'op_r3c_http', role: 'operador', perfil: 'USUARIO', permissoes: []
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const app = express();
    app.use(express.json());
    // Mesma cadeia: token + exigirRecurso('pedidos') real (sem mock do middleware).
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

  it('HTTP: admin + pedidos habilitado — CRUD canal + destino + proteção LOJA', async () => {
    assert.strictEqual(configService.recursoHabilitado, recursoFnOriginal);
    assert.equal(configService.recursoHabilitado('pedidos'), true);

    const lista = await requestJson('GET', '/api/cozinha/canais', { token: tokenAdmin });
    assert.equal(lista.status, 200);
    assert.ok(lista.body.canais.some((c) => c.codigo === 'LOJA' && c.sistema));

    const criado = await requestJson('POST', '/api/cozinha/canais', {
      token: tokenAdmin,
      body: { nome: 'iFood (cadastro manual)', empresa_id: 999 }
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.equal(criado.body.canal.origem_tipo, 'MANUAL');
    assert.equal(criado.body.canal.empresa_id, empresaId, 'empresa_id do body é ignorado');
    const canalId = criado.body.canal.id;

    const patch = await requestJson('PATCH', `/api/cozinha/canais/${canalId}`, {
      token: tokenAdmin,
      body: { nome: 'iFood Manual' }
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.canal.nome, 'iFood Manual');

    const dest = await requestJson('PUT', `/api/cozinha/canais/${canalId}/destino`, {
      token: tokenAdmin,
      body: { unidade_id: unA }
    });
    assert.equal(dest.status, 200);
    assert.equal(dest.body.canal.destino.unidade_id, unA);

    const inativa = await requestJson('PUT', `/api/cozinha/canais/${canalId}/destino`, {
      token: tokenAdmin,
      body: { unidade_id: unInativa }
    });
    assert.equal(inativa.status, 409);
    assert.equal(inativa.body.codigo, 'UNIDADE_INATIVA');

    const outra = await requestJson('PUT', `/api/cozinha/canais/${canalId}/destino`, {
      token: tokenAdmin,
      body: { unidade_id: unOutra }
    });
    assert.equal(outra.status, 403);
    assert.equal(outra.body.codigo, 'UNIDADE_EMPRESA_ISOLAMENTO');

    const loja = lista.body.canais.find((c) => c.codigo === 'LOJA');
    const bloqLoja = await requestJson('PATCH', `/api/cozinha/canais/${loja.id}`, {
      token: tokenAdmin,
      body: { ativo: false }
    });
    assert.equal(bloqLoja.status, 409);
    assert.equal(bloqLoja.body.codigo, 'CANAL_LOJA_PROTEGIDO');

    // Compat roteamento 3A
    const padrao = await requestJson('PUT', '/api/cozinha/roteamento/padrao', {
      token: tokenAdmin,
      body: { unidade_id: unA }
    });
    assert.equal(padrao.status, 200);
  });

  it('HTTP: operador continua 403 ADMIN_OPERACIONAL_OBRIGATORIO com pedidos habilitado', async () => {
    assert.equal(configService.recursoHabilitado('pedidos'), true);
    const opGet = await requestJson('GET', '/api/cozinha/canais', { token: tokenOp });
    assert.equal(opGet.status, 403);
    assert.equal(opGet.body.codigo, 'ADMIN_OPERACIONAL_OBRIGATORIO');
  });

  it('HTTP: pedidos desabilitado via saveConfig → MODULO_NAO_LICENCIADO (sem monkeypatch)', async () => {
    configService.saveConfig({ modulo_pedidos: false });
    assert.strictEqual(configService.recursoHabilitado, recursoFnOriginal);
    assert.equal(configService.recursoHabilitado('pedidos'), false);

    const g = await requestJson('GET', '/api/cozinha/canais', { token: tokenAdmin });
    assert.equal(g.status, 403);
    assert.equal(g.body.erro, 'MODULO_NAO_LICENCIADO');
    assert.equal(g.body.modulo, 'pedidos');

    const p = await requestJson('POST', '/api/cozinha/canais', {
      token: tokenAdmin,
      body: { nome: 'Bloqueado' }
    });
    assert.equal(p.status, 403);
    assert.equal(p.body.erro, 'MODULO_NAO_LICENCIADO');

    configService.saveConfig({ modulo_pedidos: true });
    assert.equal(configService.recursoHabilitado('pedidos'), true);
  });

  it('UI markup lista canais dinâmicos', () => {
    const html = ui.montarMarkup();
    assert.match(html, /Canais de pedidos/);
    assert.match(html, /coz-rot-tbody-canais/);
    assert.match(html, /Novo canal/);
    const linhas = ui.renderLinhasCanais([
      {
        id: 1, codigo: 'LOJA', nome: 'Loja', origem_tipo: 'SISTEMA', sistema: true, ativo: true, destino: null
      },
      {
        id: 2, codigo: 'WHATSAPP', nome: 'WhatsApp', origem_tipo: 'MANUAL', sistema: false, ativo: true,
        destino: { unidade_id: 10, unidade_codigo: 'COZ-01', unidade_ativa: true }
      }
    ], [{ id: 10, codigo: 'COZ-01', ativo: 1 }]);
    assert.match(linhas, /Sistema/);
    assert.match(linhas, /Manual/);
    assert.match(linhas, /Sem destino configurado/);
    assert.match(linhas, /WHATSAPP/);
  });

  it('flags de isolamento e DB_DIR temporário', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB == null, true);
    assert.ok(String(dbDir).includes('cds-cozinha-s07-3c'));
    console.log('BANCO DE TESTE EM USO (S07-3C):\n' + path.join(dbDir, 'mercadao.db'));
  });
});
