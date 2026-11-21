/**
 * Sprint 05 — Última correção: autorização operador↔unidade no login.
 * Banco temporário. Sem banco oficial.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint05-login-unidade-auth.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s05-login-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = 'test-only-s05-login-unidade';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  validarUnidadeCozinhaNoLogin,
  garantirTabelaOperadorUnidades
} = require('../../backend/services/cozinha/cozinhaAuthUnidade');
const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirUnidadeOperacional } = require('../../backend/services/cozinha/cozinhaUnidadeOperacional');
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
    VALUES ('op_cozinha', 'hash', 'operador', 'USUARIO', 1, 'Operador')
  `);
  const admin = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('admin_cozinha', 'hash', 'admin', 'ADMIN', 1, 'Admin')
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
  const unB = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UB', 1)
  `, [emp1.lastID]);
  const unOutraEmp = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UX', 1)
  `, [emp2.lastID]);
  const unInativa = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UI', 0)
  `, [emp1.lastID]);

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
    unB: unB.lastID,
    unOutraEmp: unOutraEmp.lastID,
    unInativa: unInativa.lastID
  };
}

describe('Sprint 05 — Login autentica unidade no cadastro', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('1) login autorizado na própria unidade', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const id = await validarUnidadeCozinhaNoLogin({
      db,
      usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
      unidadeCozinhaIdRaw: ctx.unA,
      empresaIdRaw: ctx.emp1
    });
    assert.equal(id, ctx.unA);
    await close(db);
  });

  it('2) login em unidade não autorizada (mesma empresa, sem vínculo)', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => validarUnidadeCozinhaNoLogin({
        db,
        usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
        unidadeCozinhaIdRaw: ctx.unB,
        empresaIdRaw: ctx.emp1
      }),
      (err) => err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('3) login em unidade de outra empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => validarUnidadeCozinhaNoLogin({
        db,
        usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
        unidadeCozinhaIdRaw: ctx.unOutraEmp,
        empresaIdRaw: ctx.emp1
      }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
        || err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await assert.rejects(
      () => validarUnidadeCozinhaNoLogin({
        db,
        usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
        unidadeCozinhaIdRaw: ctx.unOutraEmp,
        empresaIdRaw: ctx.emp2
      }),
      (err) => err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('4) unidade inexistente ou inativa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => validarUnidadeCozinhaNoLogin({
        db,
        usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
        unidadeCozinhaIdRaw: 999999,
        empresaIdRaw: ctx.emp1
      }),
      (err) => err.codigo === 'UNIDADE_INEXISTENTE'
    );
    await assert.rejects(
      () => validarUnidadeCozinhaNoLogin({
        db,
        usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
        unidadeCozinhaIdRaw: ctx.unInativa,
        empresaIdRaw: ctx.emp1
      }),
      (err) => err.codigo === 'UNIDADE_INATIVA'
    );
    await close(db);
  });

  it('5) JWT emitido só com unidade validada (claim espelha cadastro)', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const unidade = await validarUnidadeCozinhaNoLogin({
      db,
      usuario: { id: ctx.opId, role: 'operador', perfil: 'USUARIO' },
      unidadeCozinhaIdRaw: ctx.unA,
      empresaIdRaw: ctx.emp1
    });
    const token = jwt.sign(
      { id: ctx.opId, role: 'operador', unidade_cozinha_id: unidade },
      process.env.JWT_SECRET
    );
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, ctx.unA);
    assert.notEqual(decoded.unidade_cozinha_id, ctx.unB);
    await close(db);
  });

  it('6) middleware rejeita token inválido; ops rejeitam JWT sem unidade', async () => {
    const req = {
      headers: { authorization: 'Bearer token-invalido' },
      originalUrl: '/api/cozinha/status',
      path: '/api/cozinha/status',
      method: 'GET',
      accepts: () => false
    };
    const res = {
      statusCode: 200,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }
    };
    await new Promise((resolve) => {
      verificarToken(req, res, () => resolve('next'));
      setTimeout(() => resolve('done'), 80);
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'SESSAO_INVALIDA');

    assert.throws(
      () => exigirUnidadeOperacional(null),
      (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
    );
    assert.throws(
      () => exigirUnidadeOperacional(''),
      (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
    );
  });
});

describe('Sprint 05 — HTTP real: login validado + 3 operações', () => {
  let server;
  let baseUrl;
  let db;
  let recursoOriginal;
  let empresaId;
  let unidadeId;
  let operadorId;
  let passwordPlain = 'senha-teste-123';

  function requestJson(method, urlPath, { token, headers = {}, body } = {}) {
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
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  before(async () => {
    db = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('db timeout')), 60000);
      db.whenReady((err) => {
        clearTimeout(t);
        if (err) reject(err);
        else resolve();
      });
    });

    await run(db, `
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'operador',
        perfil TEXT DEFAULT 'USUARIO',
        ativo INTEGER DEFAULT 1,
        nome TEXT,
        troca_senha_obrigatoria INTEGER DEFAULT 0
      )
    `);
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);

    // Aguarda inicialização assíncrona do database.js (pode recriar schema Cozinha).
    for (let i = 0; i < 40 && !isCozinhaOperacional(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await garantirSchemaCozinha(db);
    assert.equal(isCozinhaOperacional(), true);
    await garantirTabelaOperadorUnidades(db);

    const emp = await run(db, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('33333333000133', 'Empresa HTTP Cozinha', 'HTTP', 1)
    `);
    empresaId = emp.lastID;

    const hash = await bcrypt.hash(passwordPlain, 4);
    const op = await run(db, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_http_cozinha', ?, 'operador', 'USUARIO', 1, 'Op HTTP')
    `, [hash]);
    operadorId = op.lastID;
    await run(db, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [operadorId, empresaId]);

    const un = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
      VALUES (?, 'U-HTTP', 1, 0)
    `, [empresaId]);
    unidadeId = un.lastID;
    await run(db, `
      INSERT INTO cozinha_operador_unidades (empresa_id, operador_id, unidade_id, ativo)
      VALUES (?, ?, ?, 1)
    `, [empresaId, operadorId, unidadeId]);

    const unNegada = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-NEG', 1)
    `, [empresaId]);

    // seed produto pastel
    const cat = await run(db, `INSERT INTO categorias (nome) VALUES ('Diversos')`);
    const prod = await run(db, `
      INSERT INTO produtos (
        nome, tipo_operacional, utiliza_ficha_tecnica, categoria_id, preco_venda, comercializavel
      ) VALUES ('Pastel HTTP', 'COMERCIAL', 1, ?, 10, 0)
    `, [cat.lastID]);
    await run(db, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [prod.lastID]);
    const catRef = await run(db, `INSERT INTO categorias (nome) VALUES ('Refrigerantes')`);
    const prodBeb = await run(db, `
      INSERT INTO produtos (
        nome, tipo_operacional, comercializavel, categoria_id, preco_venda
      ) VALUES ('Fanta HTTP', 'INSUMO', 1, ?, 5)
    `, [catRef.lastID]);
    const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 1, 1)`, [empresaId]);
    const at = await run(db, `
      INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
      VALUES (?, ?, 'OCUPADA', ?)
    `, [empresaId, mesa.lastID, operadorId]);
    const ped = await run(db, `
      INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido)
      VALUES ('PH1', 'PEDIDO', ?, ?, ?, 10, date('now'))
    `, [empresaId, mesa.lastID, at.lastID]);
    const item = await run(db, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, classificacao_operacional_snapshot, produto_nome_snapshot,
        preco_unitario, subtotal
      ) VALUES (?, ?, 1, 'COMERCIAL', 'Pastel HTTP', 10, 10)
    `, [ped.lastID, prod.lastID]);
    const pedB = await run(db, `
      INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido)
      VALUES ('PH2', 'PEDIDO', ?, ?, ?, 5, date('now'))
    `, [empresaId, mesa.lastID, at.lastID]);
    const itemB = await run(db, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, classificacao_operacional_snapshot, produto_nome_snapshot,
        preco_unitario, subtotal
      ) VALUES (?, ?, 2, 'INSUMO', 'Fanta HTTP', 5, 10)
    `, [pedB.lastID, prodBeb.lastID]);
    const cmd = await run(db, `
      INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
      VALUES (?, ?, 1, ?)
    `, [empresaId, at.lastID, ped.lastID]);
    const cmdB = await run(db, `
      INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
      VALUES (?, ?, 2, ?)
    `, [empresaId, at.lastID, pedB.lastID]);

    // despacho na unidade autorizada (pastel + bebida)
    await CozinhaDespacho.despacharLote({
      empresaId,
      operadorId,
      idempotencyKey: 'http-s05-desp',
      unidade_id: unidadeId,
      mesa_id: mesa.lastID,
      atendimento_id: at.lastID,
      itens: [
        {
          pedido_id: ped.lastID,
          pedido_item_id: item.lastID,
          comanda_id: cmd.lastID,
          qty_solicitada: '1.000'
        },
        {
          pedido_id: pedB.lastID,
          pedido_item_id: itemB.lastID,
          comanda_id: cmdB.lastID,
          qty_solicitada: '2.000'
        }
      ]
    }, { db });

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    const authRouter = require('../../backend/rotas/auth').router;
    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);

    server = await new Promise((resolve, reject) => {
      const inst = app.listen(0, '127.0.0.1', () => resolve(inst));
      inst.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((r) => server.close(() => r()));
  });

  it('7) HTTP: login autorizado emite JWT; login negado; 3 ops com token validado', async () => {
    const loginOk = await requestJson('POST', '/api/auth/login', {
      body: {
        username: 'op_http_cozinha',
        password: passwordPlain,
        empresa_id: empresaId,
        unidade_cozinha_id: unidadeId
      }
    });
    assert.equal(loginOk.status, 200, JSON.stringify(loginOk.body));
    assert.ok(loginOk.body.token);
    assert.equal(loginOk.body.user.unidade_cozinha_id, unidadeId);
    const decoded = jwt.verify(loginOk.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, unidadeId);

    const unNeg = await get(db, `
      SELECT id FROM cozinha_unidades WHERE codigo='U-NEG' AND empresa_id=?
    `, [empresaId]);
    const loginNeg = await requestJson('POST', '/api/auth/login', {
      body: {
        username: 'op_http_cozinha',
        password: passwordPlain,
        empresa_id: empresaId,
        unidade_cozinha_id: unNeg.id
      }
    });
    assert.equal(loginNeg.status, 403);
    assert.equal(loginNeg.body.codigo, 'UNIDADE_NAO_AUTORIZADA');
    assert.ok(!loginNeg.body.token);

    const itemPastel = await get(db, `
      SELECT id FROM cozinha_itens
      WHERE empresa_id=? AND unidade_id=? AND tipo_item='PASTEL'
      ORDER BY id LIMIT 1
    `, [empresaId, unidadeId]);
    const itemBebida = await get(db, `
      SELECT id, qty_solicitada_millis, qty_cancelada_millis FROM cozinha_itens
      WHERE empresa_id=? AND unidade_id=? AND tipo_item='BEBIDA'
      ORDER BY id LIMIT 1
    `, [empresaId, unidadeId]);
    assert.ok(itemPastel);
    assert.ok(itemBebida);

    const ini = await requestJson('POST', `/api/cozinha/itens/${itemPastel.id}/iniciar`, {
      token: loginOk.body.token,
      headers: { 'X-Empresa-Id': String(empresaId), 'Idempotency-Key': 'http-ini-1' },
      body: {}
    });
    assert.equal(ini.status, 200, JSON.stringify(ini.body));
    assert.equal(ini.body.item.estado_preparacao, 'EM_PREPARACAO');

    const pronto = await requestJson('POST', `/api/cozinha/itens/${itemPastel.id}/pronto`, {
      token: loginOk.body.token,
      headers: { 'X-Empresa-Id': String(empresaId), 'Idempotency-Key': 'http-pronto-1' },
      body: {}
    });
    assert.equal(pronto.status, 200, JSON.stringify(pronto.body));
    assert.equal(pronto.body.item.estado_preparacao, 'PRONTO');

    const iniciarBebida = await requestJson('POST', `/api/cozinha/itens/${itemBebida.id}/iniciar`, {
      token: loginOk.body.token,
      headers: { 'X-Empresa-Id': String(empresaId), 'Idempotency-Key': 'http-beb-iniciar' },
      body: {}
    });
    assert.equal(iniciarBebida.status, 200, JSON.stringify(iniciarBebida.body));
    const prontoBebida = await requestJson('POST', `/api/cozinha/itens/${itemBebida.id}/pronto`, {
      token: loginOk.body.token,
      headers: { 'X-Empresa-Id': String(empresaId), 'Idempotency-Key': 'http-beb-pronto' },
      body: {}
    });
    assert.equal(prontoBebida.status, 200, JSON.stringify(prontoBebida.body));

    const beb = await requestJson('POST', `/api/cozinha/itens/${itemBebida.id}/bebida/entregar`, {
      token: loginOk.body.token,
      headers: { 'X-Empresa-Id': String(empresaId), 'Idempotency-Key': 'http-beb-1' },
      body: { qty_millis: 1 }
    });
    assert.ok([200, 201].includes(beb.status), JSON.stringify(beb.body));
    assert.equal(beb.body.success, true);
    assert.equal(
      Math.round(Number(beb.body.entrega.qty_entregue) * 1000),
      Number(itemBebida.qty_solicitada_millis) - Number(itemBebida.qty_cancelada_millis || 0),
      'A rota deve ignorar a quantidade enviada pelo cliente e calcular o saldo no servidor.'
    );

    const tokenManipulado = jwt.sign(
      { id: operadorId, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: 999001 },
      process.env.JWT_SECRET
    );
    const bad = await requestJson('POST', `/api/cozinha/itens/${itemPastel.id}/iniciar`, {
      token: tokenManipulado,
      headers: { 'X-Empresa-Id': String(empresaId), 'Idempotency-Key': 'http-bad-1' },
      body: {}
    });
    assert.ok([403, 409].includes(bad.status));
    assert.equal(bad.body.codigo, 'UNIDADE_ISOLAMENTO');
  });
});
