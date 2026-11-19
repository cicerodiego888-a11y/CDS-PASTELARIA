/**
 * Sprint 07 · S07-2 — Seleção segura de unidade operacional no KDS.
 * Banco temporário. Sem banco oficial. Sem impressão / SEFAZ / pagamentos.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   set CDS_TEST_ISOLATION=1
 *   set CDS_FORCAR_LOCAL=1
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-2-sessao-unidade-kds.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-2-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-2-sessao';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const { garantirTabelaOperadorUnidades } = require('../../backend/services/cozinha/cozinhaAuthUnidade');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CozinhaSessaoUnidade = require('../../backend/services/cozinha/CozinhaSessaoUnidadeService');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');
const kds = require('../../frontend/erp/js/cozinha-kds.js');

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
    VALUES ('op_s07_2', 'hash', 'operador', 'USUARIO', 1, 'Operador')
  `);
  const admin = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('admin_s07_2', 'hash', 'admin', 'ADMIN', 1, 'Admin')
  `);
  const opSemVinculo = await run(db, `
    INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
    VALUES ('op_sem_vinculo', 'hash', 'operador', 'USUARIO', 1, 'Sem vínculo')
  `);

  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [op.lastID, emp1.lastID]);
  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [admin.lastID, emp1.lastID]);
  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
  `, [opSemVinculo.lastID, emp1.lastID]);

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
    opSemVinculoId: opSemVinculo.lastID,
    unA: unA.lastID,
    unB: unB.lastID,
    unOutraEmp: unOutraEmp.lastID,
    unInativa: unInativa.lastID
  };
}

function userOp(ctx) {
  return { id: ctx.opId, username: 'op_s07_2', role: 'operador', perfil: 'USUARIO', permissoes: [] };
}
function userAdmin(ctx) {
  return { id: ctx.adminId, username: 'admin_s07_2', role: 'admin', perfil: 'ADMIN', permissoes: [] };
}

describe('S07-2 — serviço listagem/seleção (memória)', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('B) listagem retorna somente unidades ativas autorizadas do operador', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userOp(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.success, true);
    assert.deepEqual(out.unidades.map((u) => u.codigo).sort(), ['UA']);
    assert.ok(!out.unidades.some((u) => u.id === ctx.unB));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unOutraEmp));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unInativa));
    await close(db);
  });

  it('C) administrador operacional recebe unidades ativas da empresa', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    const codigos = out.unidades.map((u) => u.codigo).sort();
    assert.deepEqual(codigos, ['UA', 'UB']);
    assert.ok(!out.unidades.some((u) => u.id === ctx.unOutraEmp));
    assert.ok(!out.unidades.some((u) => u.id === ctx.unInativa));
    await close(db);
  });

  it('D) operador comum só vê vínculo ativo', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userOp(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.unidades.length, 1);
    assert.equal(out.unidades[0].id, ctx.unA);
    await close(db);
  });

  it('E) unidade de outra empresa não aparece na listagem', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: userAdmin(ctx),
      empresaId: ctx.emp1
    }, { db });
    assert.ok(!out.unidades.some((u) => Number(u.id) === ctx.unOutraEmp));
    await close(db);
  });

  it('F) selecionar unidade de outra empresa é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: userOp(ctx),
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: ctx.unOutraEmp,
        tokenAtual: jwt.sign(userOp(ctx), process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
        || err.codigo === 'UNIDADE_NAO_AUTORIZADA'
        || err.codigo === 'EMPRESA_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('G) unidade inexistente é bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: userOp(ctx),
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: 999999,
        tokenAtual: jwt.sign(userOp(ctx), process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INEXISTENTE'
    );
    await close(db);
  });

  it('H) unidade inativa é bloqueada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: userAdmin(ctx),
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: ctx.unInativa,
        tokenAtual: jwt.sign(userAdmin(ctx), process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_INATIVA'
    );
    await close(db);
  });

  it('I) operador sem vínculo ativo é bloqueado', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    await assert.rejects(
      () => CozinhaSessaoUnidade.selecionarUnidadeSessao({
        user: {
          id: ctx.opSemVinculoId,
          username: 'op_sem_vinculo',
          role: 'operador',
          perfil: 'USUARIO',
          permissoes: []
        },
        empresaId: ctx.emp1,
        unidadeCozinhaIdRaw: ctx.unA,
        tokenAtual: jwt.sign({ id: ctx.opSemVinculoId, role: 'operador' }, process.env.JWT_SECRET, { expiresIn: '1h' })
      }, { db }),
      (err) => err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('J+K) seleção válida emite JWT com unidade; token anterior permanece sem claim', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const tokenAnterior = jwt.sign(
      { ...userOp(ctx), permissoes: ['vendas'] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    const decodedAntes = jwt.verify(tokenAnterior, process.env.JWT_SECRET);
    assert.equal(decodedAntes.unidade_cozinha_id, undefined);

    const out = await CozinhaSessaoUnidade.selecionarUnidadeSessao({
      user: { ...userOp(ctx), permissoes: ['vendas'] },
      empresaId: ctx.emp1,
      unidadeCozinhaIdRaw: ctx.unA,
      tokenAtual: tokenAnterior
    }, { db });

    assert.equal(out.success, true);
    assert.equal(out.unidade_cozinha_id, ctx.unA);
    const novo = jwt.verify(out.token, process.env.JWT_SECRET);
    assert.equal(novo.unidade_cozinha_id, ctx.unA);
    assert.equal(novo.id, ctx.opId);
    assert.equal(novo.exp, decodedAntes.exp);

    const aindaAntigo = jwt.verify(tokenAnterior, process.env.JWT_SECRET);
    assert.equal(aindaAntigo.unidade_cozinha_id, undefined);
    await close(db);
  });

  it('ausência de unidades / vínculos retorna lista vazia controlada', async () => {
    const db = await openMem();
    const ctx = await prepararBase(db);
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: {
        id: ctx.opSemVinculoId,
        username: 'op_sem_vinculo',
        role: 'operador',
        perfil: 'USUARIO'
      },
      empresaId: ctx.emp1
    }, { db });
    assert.equal(out.success, true);
    assert.equal(out.unidades.length, 0);
    assert.equal(out.codigo, 'SEM_UNIDADES_DISPONIVEIS');
    assert.match(out.mensagem || '', /Nenhuma unidade/i);
    await close(db);
  });
});

describe('S07-2 — UI seleção KDS', () => {
  it('sem unidade no JWT abre seleção e não auto-escolhe', async () => {
    const chamadas = [];
    const control = kds.criarControlador({
      empresaId: 1,
      empresaRotulo: 'E1',
      lerUnidadeJwt: () => null,
      fetchJson: async (method, path) => {
        chamadas.push({ method, path });
        return {
          success: true,
          unidades: [
            { id: 10, codigo: 'UA' },
            { id: 11, codigo: 'UB' }
          ]
        };
      },
      agendar: () => null,
      cancelar: () => {}
    });
    await control.iniciar();
    assert.equal(control.estado.modo, 'selecao');
    assert.equal(control.estado.unidadeSelecionadaId, null);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].path, '/cozinha/unidades-disponiveis');
    const html = control.html();
    assert.match(html, /Selecione a unidade/);
    assert.match(html, /Unidade UA/);
    assert.match(html, /data-acao="confirmar-unidade"/);
    assert.match(html, /disabled/);
  });

  it('com unidade no JWT abre painel normalmente', async () => {
    const chamadas = [];
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => 10,
      fetchJson: async (method, path) => {
        chamadas.push({ method, path });
        return { success: true, empresa_id: 1, unidade_id: 10, rodadas: [] };
      },
      agendar: () => 1,
      cancelar: () => {}
    });
    await control.iniciar();
    assert.equal(control.estado.modo, 'painel');
    assert.equal(chamadas[0].path.startsWith('/cozinha/preparacao/painel'), true);
  });

  it('confirmação atualiza sessão e carrega painel', async () => {
    const sessoes = [];
    const chamadas = [];
    const fakeToken = jwt.sign(
      { id: 1, unidade_cozinha_id: 10 },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => null,
      aoAtualizarSessao: (data) => sessoes.push(data),
      fetchJson: async (method, path, corpo) => {
        chamadas.push({ method, path, corpo });
        if (path === '/cozinha/unidades-disponiveis') {
          return { success: true, unidades: [{ id: 10, codigo: 'UA' }] };
        }
        if (path === '/cozinha/sessao/unidade') {
          return {
            success: true,
            token: fakeToken,
            unidade_cozinha_id: 10,
            user: { id: 1, unidade_cozinha_id: 10 }
          };
        }
        return { success: true, empresa_id: 1, unidade_id: 10, rodadas: [] };
      },
      agendar: () => 1,
      cancelar: () => {}
    });
    await control.iniciar();
    control.definirUnidadeSelecionada(10);
    const r = await control.confirmarUnidade();
    assert.equal(r.ok, true);
    assert.equal(sessoes.length, 1);
    assert.equal(control.estado.modo, 'painel');
    assert.ok(chamadas.some((c) => c.path === '/cozinha/sessao/unidade' && c.method === 'POST'));
    assert.ok(chamadas.some((c) => String(c.path).includes('/cozinha/preparacao/painel')));
  });

  it('falha de lista não dispara chamada repetitiva automática', async () => {
    let n = 0;
    const control = kds.criarControlador({
      empresaId: 1,
      lerUnidadeJwt: () => null,
      fetchJson: async () => {
        n += 1;
        const err = new Error('Rede indisponível');
        err.codigo = 'REDE';
        throw err;
      },
      agendar: () => null,
      cancelar: () => {}
    });
    await control.iniciar();
    assert.equal(n, 1);
    assert.equal(control.estado.selecaoFalhaLista, true);
    const r2 = await control.carregarUnidadesDisponiveis();
    assert.equal(r2.ignorada, true);
    assert.equal(n, 1);
    await control.carregarUnidadesDisponiveis({ forcar: true });
    assert.equal(n, 2);
  });

  it('lerUnidadeCozinhaDoToken lê claim do JWT', () => {
    const token = jwt.sign({ id: 1, unidade_cozinha_id: 42 }, process.env.JWT_SECRET);
    assert.equal(kds.lerUnidadeCozinhaDoToken(token), 42);
    assert.equal(kds.lerUnidadeCozinhaDoToken(jwt.sign({ id: 1 }, process.env.JWT_SECRET)), null);
  });
});

describe('S07-2 — HTTP (listagem, seleção, painel, login)', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let empresaOutraId;
  let unidadeId;
  let unidadeB;
  let unidadeOutraEmp;
  let unidadeInativa;
  let operadorId;
  let adminId;
  let opSemVinculoId;
  let passwordPlain;
  let tokenSemUnidade;
  let tokenAdminSemUnidade;

  function requestJson(method, urlPath, { token, headers = {}, body, empresaHeader } = {}) {
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
          ...headers,
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
    for (let i = 0; i < 80; i += 1) {
      const row = await get(dbHttp, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_comandas'
      `);
      if (row && row.name === 'cozinha_comandas') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await garantirSchemaCozinha(dbHttp);
    await garantirTabelaOperadorUnidades(dbHttp);
    marcarCozinhaOperacional(true);
    assert.equal(isCozinhaOperacional(), true);

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    passwordPlain = 'senha-s07-2';
    const hash = await bcrypt.hash(passwordPlain, 4);

    const op = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_s07_2_http', ?, 'operador', 'USUARIO', 1, 'Op HTTP')
    `, [hash]);
    operadorId = op.lastID;
    const adm = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('admin_s07_2_http', ?, 'admin', 'ADMIN', 1, 'Admin HTTP')
    `, [hash]);
    adminId = adm.lastID;
    const opSv = await run(dbHttp, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_s07_2_sv', ?, 'operador', 'USUARIO', 1, 'Sem vínculo')
    `, [hash]);
    opSemVinculoId = opSv.lastID;

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('55667788000199', 'Empresa S07-2', 'S07-2', 1)
    `);
    empresaId = emp.lastID;
    const emp2 = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('55667788000270', 'Empresa S07-2 B', 'S07-2B', 1)
    `);
    empresaOutraId = emp2.lastID;

    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [operadorId, empresaId]);
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [adminId, empresaId]);
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [opSemVinculoId, empresaId]);

    const un = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-A', 0, 1)
    `, [empresaId]);
    unidadeId = un.lastID;
    const unB = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-B', 0, 1)
    `, [empresaId]);
    unidadeB = unB.lastID;
    const unX = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-X', 0, 1)
    `, [empresaOutraId]);
    unidadeOutraEmp = unX.lastID;
    const unI = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'S072-I', 0, 0)
    `, [empresaId]);
    unidadeInativa = unI.lastID;

    await run(dbHttp, `
      INSERT INTO cozinha_operador_unidades (empresa_id, operador_id, unidade_id, ativo)
      VALUES (?, ?, ?, 1)
    `, [empresaId, operadorId, unidadeId]);

    // Pedido mínimo para painel contextualizado.
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS categorias (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL)
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        tipo_operacional TEXT DEFAULT 'COMERCIAL',
        comercializavel INTEGER DEFAULT 0,
        categoria_id INTEGER,
        utiliza_ficha_tecnica INTEGER DEFAULT 0,
        permite_personalizacao_ingredientes INTEGER DEFAULT 0,
        preco_venda REAL DEFAULT 0
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS ficha_tecnica (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id INTEGER NOT NULL,
        ativo INTEGER DEFAULT 1
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS mesas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL,
        numero INTEGER NOT NULL,
        ativo INTEGER NOT NULL DEFAULT 1
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS mesa_atendimentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa_id INTEGER NOT NULL,
        mesa_id INTEGER NOT NULL,
        estado TEXT NOT NULL,
        operador_abertura_id INTEGER NOT NULL DEFAULT 1,
        aberto_em TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT,
        status TEXT,
        empresa_id INTEGER,
        mesa_id INTEGER,
        mesa_atendimento_id INTEGER,
        total REAL,
        data_pedido TEXT
      )
    `);
    await run(dbHttp, `
      CREATE TABLE IF NOT EXISTS pedidos_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pedido_id INTEGER,
        produto_id INTEGER,
        quantidade REAL,
        preco_unitario REAL,
        subtotal REAL,
        classificacao_operacional_snapshot TEXT,
        produto_nome_snapshot TEXT,
        observacao TEXT
      )
    `);

    const mesa = await run(dbHttp, `
      INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 7, 1)
    `, [empresaId]);
    const at = await run(dbHttp, `
      INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
      VALUES (?, ?, 'OCUPADA', ?)
    `, [empresaId, mesa.lastID, operadorId]);
    const cat = await run(dbHttp, `INSERT INTO categorias (nome) VALUES ('S072')`);
    const prod = await run(dbHttp, `
      INSERT INTO produtos (
        nome, tipo_operacional, comercializavel, categoria_id, utiliza_ficha_tecnica, preco_venda
      ) VALUES ('Pastel S072', 'COMERCIAL', 0, ?, 1, 0)
    `, [cat.lastID]);
    await run(dbHttp, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [prod.lastID]);
    const ped = await run(dbHttp, `
      INSERT INTO pedidos (
        codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido
      ) VALUES ('PS072', 'PEDIDO', ?, ?, ?, 10, date('now'))
    `, [empresaId, mesa.lastID, at.lastID]);
    const pit = await run(dbHttp, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot
      ) VALUES (?, ?, 1, 9.99, 9.99, 'PASTEL', 'Pastel S072')
    `, [ped.lastID, prod.lastID]);
    const cmd = await run(dbHttp, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, 1, ?, ?)
    `, [empresaId, at.lastID, ped.lastID, operadorId]);
    await CozinhaDespacho.despacharLote({
      empresaId,
      operadorId,
      idempotencyKey: 'http-s07-2-despacho',
      unidade_id: unidadeId,
      mesa_id: mesa.lastID,
      atendimento_id: at.lastID,
      itens: [{
        pedido_id: ped.lastID,
        pedido_item_id: pit.lastID,
        comanda_id: cmd.lastID,
        qty_solicitada: 1
      }]
    }, { db: dbHttp });

    tokenSemUnidade = jwt.sign(
      { id: operadorId, username: 'op_s07_2_http', role: 'operador', perfil: 'USUARIO', permissoes: [] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    tokenAdminSemUnidade = jwt.sign(
      { id: adminId, username: 'admin_s07_2_http', role: 'admin', perfil: 'ADMIN', permissoes: [] },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );

    const authRouter = require('../../backend/rotas/auth').router;
    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((r) => server.close(() => r()));
  });

  it('A) login normal sem unidade continua funcionando', async () => {
    const r = await requestJson('POST', '/api/auth/login', {
      body: {
        username: 'op_s07_2_http',
        password: passwordPlain,
        empresa_id: empresaId
      },
      empresaHeader: null
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.token);
    const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, null);
    assert.equal(decoded.id, operadorId);
  });

  it('HTTP B/D) listagem operador: só vínculo ativo', async () => {
    const r = await requestJson('GET', '/api/cozinha/unidades-disponiveis', {
      token: tokenSemUnidade
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.success, true);
    assert.equal(r.body.unidades.length, 1);
    assert.equal(r.body.unidades[0].id, unidadeId);
    assert.ok(!r.body.unidades.some((u) => u.id === unidadeB));
    assert.ok(!r.body.unidades.some((u) => u.id === unidadeOutraEmp));
  });

  it('HTTP C) listagem admin: unidades ativas da empresa', async () => {
    const r = await requestJson('GET', '/api/cozinha/unidades-disponiveis', {
      token: tokenAdminSemUnidade
    });
    assert.equal(r.status, 200);
    const ids = r.body.unidades.map((u) => u.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [unidadeId, unidadeB].sort((a, b) => a - b));
    assert.ok(!ids.includes(unidadeInativa));
    assert.ok(!ids.includes(unidadeOutraEmp));
  });

  it('HTTP F) seleção de outra empresa bloqueada', async () => {
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenSemUnidade,
      body: { unidade_cozinha_id: unidadeOutraEmp }
    });
    assert.ok(r.status >= 400);
    assert.ok(r.body.codigo);
    assert.ok(!r.body.token);
  });

  it('HTTP G) unidade inexistente bloqueada', async () => {
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenSemUnidade,
      body: { unidade_cozinha_id: 999999 }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_INEXISTENTE');
  });

  it('HTTP H) unidade inativa bloqueada', async () => {
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenAdminSemUnidade,
      body: { unidade_cozinha_id: unidadeInativa }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_INATIVA');
  });

  it('HTTP I) operador sem vínculo bloqueado', async () => {
    const token = jwt.sign(
      { id: opSemVinculoId, role: 'operador', perfil: 'USUARIO' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const r = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token,
      body: { unidade_cozinha_id: unidadeId }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.codigo, 'UNIDADE_NAO_AUTORIZADA');
  });

  it('HTTP J/L) seleção válida → JWT → painel OK', async () => {
    const sel = await requestJson('POST', '/api/cozinha/sessao/unidade', {
      token: tokenSemUnidade,
      body: { unidade_cozinha_id: unidadeId }
    });
    assert.equal(sel.status, 200, JSON.stringify(sel.body));
    assert.ok(sel.body.token);
    assert.equal(sel.body.unidade_cozinha_id, unidadeId);
    const decoded = jwt.verify(sel.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, unidadeId);

    const painel = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: sel.body.token
    });
    assert.equal(painel.status, 200, JSON.stringify(painel.body));
    assert.equal(painel.body.unidade_id, unidadeId);
    assert.equal(painel.body.empresa_id, empresaId);
    assert.ok(painel.body.rodadas.length >= 1);
  });

  it('HTTP K/M) JWT anterior sem unidade → UNIDADE_OBRIGATORIA', async () => {
    const aindaAntigo = jwt.verify(tokenSemUnidade, process.env.JWT_SECRET);
    assert.equal(aindaAntigo.unidade_cozinha_id, undefined);
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: tokenSemUnidade
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'UNIDADE_OBRIGATORIA');
  });

  it('HTTP N) query manipulada não substitui unidade do JWT', async () => {
    const token = jwt.sign(
      {
        id: operadorId,
        role: 'operador',
        perfil: 'USUARIO',
        unidade_cozinha_id: unidadeId
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const r = await requestJson(
      'GET',
      `/api/cozinha/preparacao/painel?unidade_id=${unidadeB}`,
      { token }
    );
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'UNIDADE_ISOLAMENTO');
  });

  it('evidência isolamento: DB_DIR temporário e flags ativas', () => {
    assert.equal(process.env.CDS_BLOQUEAR_BANCO_OFICIAL, '1');
    assert.equal(process.env.CDS_TEST_ISOLATION, '1');
    assert.equal(process.env.CDS_FORCAR_LOCAL, '1');
    assert.ok(String(process.env.DB_DIR).includes('cds-cozinha-s07-2-'));
    assert.equal(process.env.CDS_ALLOW_OFFICIAL_DB, undefined);
  });
});
