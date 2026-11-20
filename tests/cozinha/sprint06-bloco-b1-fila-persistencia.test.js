/**
 * Sprint 06 — Bloco B1: fila persistente (inclusão, snapshot, listagem, isolamento).
 * Sem B2 (idempotência avançada). Sem worker. Sem print físico. Sem Blocos C–E.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06b1-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = 'test-only-s06b1-fila';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
const JWT_SECRET = process.env.JWT_SECRET;

const {
  garantirSchemaCozinha,
  COZINHA_SCHEMA_VERSION
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EstacaoService = require('../../backend/services/cozinha/CozinhaImpressaoEstacaoService');
const FilaService = require('../../backend/services/cozinha/CozinhaImpressaoFilaService');
const {
  ESTADOS_FILA,
  snapshotContemCamposProibidos
} = require('../../backend/services/cozinha/cozinhaImpressaoContratos');

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
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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

async function prepararContexto(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  assert.ok(COZINHA_SCHEMA_VERSION >= 4);

  const e1 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111', 'Emp B1-1', 'E1', 1)
  `);
  const e2 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122', 'Emp B1-2', 'E2', 1)
  `);

  const u1a = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U1A', 1)
  `, [e1.lastID]);
  const u1b = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U1B', 1)
  `, [e1.lastID]);
  const u2 = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U2', 1)
  `, [e2.lastID]);

  const r1 = await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global, enviada_em
    ) VALUES (?, ?, 7, 100, 1, 10, '2026-11-16T12:00:00Z')
  `, [e1.lastID, u1a.lastID]);
  const r1b = await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
    ) VALUES (?, ?, 8, 101, 1, 11)
  `, [e1.lastID, u1b.lastID]);
  const r2 = await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
    ) VALUES (?, ?, 9, 200, 1, 20)
  `, [e2.lastID, u2.lastID]);

  const est1 = await EstacaoService.criarEstacao({
    db,
    empresaId: e1.lastID,
    unidadeId: u1a.lastID,
    codigo_estacao: 'PASTEL',
    device_name: 'DEV-U1A',
    largura_mm: 80,
    vias: 2,
    modelo_agrupado: 1
  });
  const est1b = await EstacaoService.criarEstacao({
    db,
    empresaId: e1.lastID,
    unidadeId: u1b.lastID,
    codigo_estacao: 'PASTEL',
    largura_mm: 58
  });
  const est2 = await EstacaoService.criarEstacao({
    db,
    empresaId: e2.lastID,
    unidadeId: u2.lastID,
    codigo_estacao: 'PASTEL',
    largura_mm: 80
  });

  return {
    empresa1: e1.lastID,
    empresa2: e2.lastID,
    unidade1a: u1a.lastID,
    unidade1b: u1b.lastID,
    unidade2: u2.lastID,
    rodada1: r1.lastID,
    rodada1b: r1b.lastID,
    rodada2: r2.lastID,
    estacao1: est1.estacao.id,
    estacao1b: est1b.estacao.id,
    estacao2: est2.estacao.id
  };
}

function snapshotBase(ids, extras = {}) {
  return Object.assign({
    mesa_numero: '7',
    itens: [{
      cozinha_item_id: 1,
      comanda_id: 5,
      tipo_item: 'PASTEL',
      descricao: 'Carne',
      qty: '2.000',
      observacao: 'sem cebola',
      preco: 99.9,
      ncm: '21069090',
      ingredientes: [{ nome: 'Queijo', qty: '1.000', selecionado: true }]
    }]
  }, extras);
}

describe('Sprint 06 Bloco B1 — inclusão e persistência', () => {
  it('1) enfileira job PENDENTE com vínculos empresa/unidade/estação/rodada', async () => {
    const db = await openMem();
    const ids = await prepararContexto(db);

    const out = await FilaService.enfileirarJob({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      rodadaId: ids.rodada1,
      estacaoImpressaoId: ids.estacao1,
      modelo: 'AGRUPADO',
      idempotency_key: `imp:${ids.empresa1}:${ids.unidade1a}:${ids.rodada1}:${ids.estacao1}:AGRUPADO:all`,
      snapshot: snapshotBase(ids)
    });

    assert.equal(out.success, true);
    assert.equal(out.impressao_fisica, false);
    assert.equal(out.job.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(out.job.empresa_id, ids.empresa1);
    assert.equal(out.job.unidade_id, ids.unidade1a);
    assert.equal(out.job.estacao_impressao_id, ids.estacao1);
    assert.equal(out.job.rodada_id, ids.rodada1);
    assert.equal(out.job.modelo, 'AGRUPADO');
    assert.equal(out.job.vias, 2);
    assert.equal(out.job.tentativas, 0);

    const row = await get(db, `
      SELECT empresa_id, unidade_id, estacao_impressao_id, rodada_id, estado, vias, payload_snapshot
      FROM cozinha_impressao_fila WHERE id = ?
    `, [out.job.id]);
    assert.equal(row.empresa_id, ids.empresa1);
    assert.equal(row.unidade_id, ids.unidade1a);
    assert.equal(row.estacao_impressao_id, ids.estacao1);
    assert.equal(row.rodada_id, ids.rodada1);
    assert.equal(row.estado, 'PENDENTE');
    assert.ok(row.payload_snapshot);

    await close(db);
  });

  it('2) snapshot persistido é canônico (sem preço/fiscal) e reparseável', async () => {
    const db = await openMem();
    const ids = await prepararContexto(db);

    const out = await FilaService.enfileirarJob({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      rodadaId: ids.rodada1,
      estacaoImpressaoId: ids.estacao1,
      idempotency_key: 'b1-snap-canonico',
      snapshot: snapshotBase(ids)
    });

    const snap = out.job.snapshot;
    assert.ok(snap);
    assert.equal(snap.empresa_id, ids.empresa1);
    assert.equal(snap.unidade_id, ids.unidade1a);
    assert.equal(snap.rodada_id, ids.rodada1);
    assert.equal(snap.itens[0].descricao, 'Carne');
    assert.equal(snap.itens[0].preco, undefined);
    assert.equal(snap.preco_total, undefined);
    assert.deepEqual(snapshotContemCamposProibidos(snap), []);
    assert.ok(!/"preco"/i.test(out.job.payload_snapshot));
    assert.ok(!/"ncm"/i.test(out.job.payload_snapshot));

    const detalhe = await FilaService.obterJob({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      id: out.job.id
    });
    assert.equal(detalhe.job.snapshot.itens[0].descricao, 'Carne');
    assert.equal(detalhe.job.snapshot.itens[0].ingredientes[0].nome, 'Queijo');

    await close(db);
  });

  it('3) rejeita estação/rodada fora da unidade ou empresa', async () => {
    const db = await openMem();
    const ids = await prepararContexto(db);

    await assert.rejects(
      () => FilaService.enfileirarJob({
        db,
        empresaId: ids.empresa1,
        unidadeId: ids.unidade1a,
        rodadaId: ids.rodada1,
        estacaoImpressaoId: ids.estacao1b,
        idempotency_key: 'b1-estacao-outra-unidade',
        snapshot: snapshotBase(ids)
      }),
      (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
    );

    await assert.rejects(
      () => FilaService.enfileirarJob({
        db,
        empresaId: ids.empresa1,
        unidadeId: ids.unidade1a,
        rodadaId: ids.rodada2,
        estacaoImpressaoId: ids.estacao1,
        idempotency_key: 'b1-rodada-outra-empresa',
        snapshot: snapshotBase(ids)
      }),
      (err) => err.codigo === 'IMPRESSAO_RODADA_NAO_ENCONTRADA'
    );

    await assert.rejects(
      () => FilaService.enfileirarJob({
        db,
        empresaId: ids.empresa1,
        unidadeId: ids.unidade1a,
        rodadaId: ids.rodada1b,
        estacaoImpressaoId: ids.estacao1,
        idempotency_key: 'b1-rodada-outra-unidade',
        snapshot: snapshotBase(ids)
      }),
      (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
    );

    const n = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(n.n, 0);
    await close(db);
  });
});

describe('Sprint 06 Bloco B1 — listagem e isolamento', () => {
  it('4) lista por unidade/estado/rodada; não vaza entre empresas/unidades', async () => {
    const db = await openMem();
    const ids = await prepararContexto(db);

    await FilaService.enfileirarJob({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      rodadaId: ids.rodada1,
      estacaoImpressaoId: ids.estacao1,
      idempotency_key: 'b1-list-1a',
      snapshot: snapshotBase(ids)
    });
    await FilaService.enfileirarJob({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1b,
      rodadaId: ids.rodada1b,
      estacaoImpressaoId: ids.estacao1b,
      idempotency_key: 'b1-list-1b',
      snapshot: snapshotBase(ids, { mesa_numero: '8' })
    });
    await FilaService.enfileirarJob({
      db,
      empresaId: ids.empresa2,
      unidadeId: ids.unidade2,
      rodadaId: ids.rodada2,
      estacaoImpressaoId: ids.estacao2,
      idempotency_key: 'b1-list-2',
      snapshot: snapshotBase(ids, { mesa_numero: '9' })
    });

    const lista1a = await FilaService.listarFila({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a
    });
    assert.equal(lista1a.total, 1);
    assert.equal(lista1a.jobs[0].idempotency_key, 'b1-list-1a');
    assert.equal(lista1a.jobs[0].estado, 'PENDENTE');

    const porRodada = await FilaService.listarFila({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      rodada_id: ids.rodada1,
      estado: 'PENDENTE'
    });
    assert.equal(porRodada.total, 1);

    const lista1b = await FilaService.listarFila({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1b
    });
    assert.equal(lista1b.total, 1);
    assert.equal(lista1b.jobs[0].idempotency_key, 'b1-list-1b');

    await assert.rejects(
      () => FilaService.obterJob({
        db,
        empresaId: ids.empresa1,
        unidadeId: ids.unidade1a,
        id: lista1b.jobs[0].id
      }),
      (err) => err.codigo === 'IMPRESSAO_JOB_NAO_ENCONTRADO'
    );

    const lista2 = await FilaService.listarFila({
      db, empresaId: ids.empresa2, unidadeId: ids.unidade2
    });
    assert.equal(lista2.total, 1);
    await assert.rejects(
      () => FilaService.obterJob({
        db,
        empresaId: ids.empresa1,
        unidadeId: ids.unidade1a,
        id: lista2.jobs[0].id
      }),
      (err) => err.codigo === 'IMPRESSAO_JOB_NAO_ENCONTRADO'
    );

    await close(db);
  });

  it('5) inclusão na mesma TX: rollback remove o job (integridade)', async () => {
    const db = await openMem();
    const ids = await prepararContexto(db);

    await run(db, 'BEGIN');
    await FilaService.enfileirarJob({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      rodadaId: ids.rodada1,
      estacaoImpressaoId: ids.estacao1,
      idempotency_key: 'b1-tx-rollback',
      snapshot: snapshotBase(ids)
    });
    const mid = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(mid.n, 1);
    await run(db, 'ROLLBACK');

    const after = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(after.n, 0);
    await close(db);
  });

  it('6) módulo de fila não acopla impressão comercial', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'backend', 'services', 'cozinha', 'CozinhaImpressaoFilaService.js'),
      'utf8'
    );
    assert.ok(!/impressora_cupom/.test(src));
    assert.ok(!/\/api\/impressao/.test(src));
    assert.ok(!/ComprovantePrintService/.test(src));
    assert.ok(!/fiscalImpressao/.test(src));
    assert.ok(!/webContents\.print/.test(src));
    // enfileirarDaRodada existe a partir do B2 (mesmo módulo); B1 exige só zero acoplamento comercial.
  });
});

describe('Sprint 06 Bloco B1 — HTTP real GET /impressao/fila', () => {
  let dbProd;
  let server;
  let baseUrl;
  let recursoOriginal;
  let empresaAuth;
  let unidadeAuth;
  let unidadeMesmaEmpresa2;
  let empresaOutra;
  let unidadeOutra;
  let operadorId;
  let jobAuthId;
  let jobMesmaEmpresaU2Id;
  let jobOutraId;
  let tokenAuth;

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
          resolve({ status: res.statusCode, body: json, raw });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  before(async () => {
    dbProd = require('../../backend/database');
    const cozinhaRoutes = require('../../backend/rotas/cozinha');
    const { verificarToken } = require('../../backend/middleware/auth');
    const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
    const configService = require('../../backend/services/configuracaoService');
    const {
      garantirSchemaCozinha: garantirSchema,
      isCozinhaOperacional,
      marcarCozinhaOperacional,
      getCozinhaSchemaStatus
    } = require('../../backend/utils/cozinhaSchema');
    const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');

    await whenReady(dbProd);
    marcarCozinhaOperacional(false, new Error('aguardando-init-arquivo-s06b1'));
    for (let i = 0; i < 60; i++) {
      const st = getCozinhaSchemaStatus();
      const msg = st.erro && st.erro.mensagem ? String(st.erro.mensagem) : '';
      if (st.operacional === true) break;
      if (st.erro && msg !== 'aguardando-init-arquivo-s06b1') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    let lastErr = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await garantirSchema(dbProd);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!/LOCKED|busy/i.test(String(err && err.message))) throw err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (lastErr) throw lastErr;
    marcarCozinhaOperacional(true);
    assert.equal(isCozinhaOperacional(), true);
    await garantirSchemaUsuarioEmpresasAsync(dbProd);

    await run(dbProd, `
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

    const empAuth = await run(dbProd, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('77777777000177', 'Empresa Auth B1 HTTP', 'AUTH-B1', 1)
    `);
    empresaAuth = empAuth.lastID;
    const empOutra = await run(dbProd, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('88888888000188', 'Empresa Outra B1 HTTP', 'OUTRA-B1', 1)
    `);
    empresaOutra = empOutra.lastID;

    const op = await run(dbProd, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_s06b1_http', 'hash', 'operador', 'USUARIO', 1, 'Op B1 HTTP')
    `);
    operadorId = op.lastID;
    await run(dbProd, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [operadorId, empresaAuth]);

    const unAuth = await run(dbProd, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-AUTH-B1', 1)
    `, [empresaAuth]);
    unidadeAuth = unAuth.lastID;
    // Unidade 2 da MESMA empresa (isolamento entre unidades — auditoria final B1).
    const unMesmaEmp2 = await run(dbProd, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-AUTH-B1-U2', 1)
    `, [empresaAuth]);
    unidadeMesmaEmpresa2 = unMesmaEmp2.lastID;
    const unOutra = await run(dbProd, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-OUTRA-B1', 1)
    `, [empresaOutra]);
    unidadeOutra = unOutra.lastID;

    const rodAuth = await run(dbProd, `
      INSERT INTO cozinha_rodadas (
        empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global, enviada_em
      ) VALUES (?, ?, 1, 501, 1, 501, '2026-11-16T22:00:00Z')
    `, [empresaAuth, unidadeAuth]);
    const rodMesmaEmp2 = await run(dbProd, `
      INSERT INTO cozinha_rodadas (
        empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
      ) VALUES (?, ?, 3, 502, 1, 502)
    `, [empresaAuth, unidadeMesmaEmpresa2]);
    const rodOutra = await run(dbProd, `
      INSERT INTO cozinha_rodadas (
        empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
      ) VALUES (?, ?, 2, 601, 1, 601)
    `, [empresaOutra, unidadeOutra]);

    const estAuth = await EstacaoService.criarEstacao({
      db: dbProd,
      empresaId: empresaAuth,
      unidadeId: unidadeAuth,
      codigo_estacao: 'PASTEL',
      largura_mm: 80
    });
    const estMesmaEmp2 = await EstacaoService.criarEstacao({
      db: dbProd,
      empresaId: empresaAuth,
      unidadeId: unidadeMesmaEmpresa2,
      codigo_estacao: 'PASTEL',
      largura_mm: 80
    });
    const estOutra = await EstacaoService.criarEstacao({
      db: dbProd,
      empresaId: empresaOutra,
      unidadeId: unidadeOutra,
      codigo_estacao: 'PASTEL',
      largura_mm: 80
    });

    const jobAuth = await FilaService.enfileirarJob({
      db: dbProd,
      empresaId: empresaAuth,
      unidadeId: unidadeAuth,
      rodadaId: rodAuth.lastID,
      estacaoImpressaoId: estAuth.estacao.id,
      idempotency_key: `b1-http-auth:${empresaAuth}:${unidadeAuth}`,
      snapshot: {
        mesa_numero: '1',
        itens: [{ tipo_item: 'PASTEL', descricao: 'Auth', qty: '1.000' }]
      }
    });
    jobAuthId = jobAuth.job.id;

    const jobMesmaEmpU2 = await FilaService.enfileirarJob({
      db: dbProd,
      empresaId: empresaAuth,
      unidadeId: unidadeMesmaEmpresa2,
      rodadaId: rodMesmaEmp2.lastID,
      estacaoImpressaoId: estMesmaEmp2.estacao.id,
      idempotency_key: `b1-http-mesma-emp-u2:${empresaAuth}:${unidadeMesmaEmpresa2}`,
      snapshot: {
        mesa_numero: '3',
        itens: [{ tipo_item: 'PASTEL', descricao: 'MesmaEmp-U2', qty: '1.000' }]
      }
    });
    jobMesmaEmpresaU2Id = jobMesmaEmpU2.job.id;
    assert.equal(jobMesmaEmpU2.job.empresa_id, empresaAuth);
    assert.equal(jobMesmaEmpU2.job.unidade_id, unidadeMesmaEmpresa2);
    assert.notEqual(unidadeMesmaEmpresa2, unidadeAuth);

    const jobOutra = await FilaService.enfileirarJob({
      db: dbProd,
      empresaId: empresaOutra,
      unidadeId: unidadeOutra,
      rodadaId: rodOutra.lastID,
      estacaoImpressaoId: estOutra.estacao.id,
      idempotency_key: `b1-http-outra:${empresaOutra}:${unidadeOutra}`,
      snapshot: {
        mesa_numero: '2',
        itens: [{ tipo_item: 'PASTEL', descricao: 'Outra', qty: '1.000' }]
      }
    });
    jobOutraId = jobOutra.job.id;

    tokenAuth = jwt.sign({
      id: operadorId,
      usuario_id: operadorId,
      username: 'op_s06b1_http',
      role: 'operador',
      perfil: 'USUARIO',
      unidade_cozinha_id: unidadeAuth
    }, JWT_SECRET, { expiresIn: '1h' });

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    const app = express();
    app.use(express.json());
    // Rota REAL de produção
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);

    server = await new Promise((resolve, reject) => {
      const inst = app.listen(0, '127.0.0.1', () => resolve(inst));
      inst.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    const configService = require('../../backend/services/configuracaoService');
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((r) => server.close(() => r()));
  });

  it('7) rota real: GET /impressao/fila e /:id sem autenticação → 401', async () => {
    const rotaPath = require.resolve('../../backend/rotas/cozinha');
    assert.match(rotaPath.replace(/\\/g, '/'), /backend\/rotas\/cozinha\.js$/);

    const lista = await requestJson('GET', '/api/cozinha/impressao/fila');
    assert.equal(lista.status, 401, JSON.stringify(lista.body));

    const detalhe = await requestJson('GET', `/api/cozinha/impressao/fila/${jobAuthId}`);
    assert.equal(detalhe.status, 401, JSON.stringify(detalhe.body));
  });

  it('8) rota real: GET /impressao/fila lista só jobs da empresa/unidade da sessão', async () => {
    const res = await requestJson('GET', '/api/cozinha/impressao/fila', {
      token: tokenAuth,
      headers: { 'X-Empresa-Id': String(empresaAuth) }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.empresa_id, empresaAuth);
    assert.equal(res.body.unidade_id, unidadeAuth);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.jobs.length, 1);
    assert.equal(res.body.jobs[0].id, jobAuthId);
    assert.equal(res.body.jobs[0].empresa_id, empresaAuth);
    assert.equal(res.body.jobs[0].unidade_id, unidadeAuth);
    assert.notEqual(res.body.jobs[0].id, jobOutraId);
    assert.ok(!res.body.jobs.some((j) => j.empresa_id === empresaOutra));
    assert.ok(!res.body.jobs.some((j) => j.unidade_id === unidadeOutra));
  });

  it('9) rota real: GET /impressao/fila/:id retorna job da sessão e isola o de outra empresa', async () => {
    const ok = await requestJson('GET', `/api/cozinha/impressao/fila/${jobAuthId}`, {
      token: tokenAuth,
      headers: { 'X-Empresa-Id': String(empresaAuth) }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.job.id, jobAuthId);
    assert.equal(ok.body.job.empresa_id, empresaAuth);
    assert.equal(ok.body.job.unidade_id, unidadeAuth);
    assert.ok(ok.body.job.snapshot);
    assert.equal(ok.body.job.snapshot.itens[0].descricao, 'Auth');

    const isolado = await requestJson('GET', `/api/cozinha/impressao/fila/${jobOutraId}`, {
      token: tokenAuth,
      headers: { 'X-Empresa-Id': String(empresaAuth) }
    });
    assert.equal(isolado.status, 404, JSON.stringify(isolado.body));
    assert.equal(isolado.body.codigo, 'IMPRESSAO_JOB_NAO_ENCONTRADO');
  });

  it('10) rota real: isolamento entre duas unidades da MESMA empresa', async () => {
    // Pré-condição do cenário: U1 e U2 sob a mesma empresa; JWT só da U1.
    assert.equal(
      (await get(dbProd, `SELECT empresa_id FROM cozinha_unidades WHERE id = ?`, [unidadeAuth])).empresa_id,
      empresaAuth
    );
    assert.equal(
      (await get(dbProd, `SELECT empresa_id FROM cozinha_unidades WHERE id = ?`, [unidadeMesmaEmpresa2])).empresa_id,
      empresaAuth
    );
    assert.notEqual(unidadeAuth, unidadeMesmaEmpresa2);

    const decoded = jwt.verify(tokenAuth, JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, unidadeAuth);
    assert.notEqual(decoded.unidade_cozinha_id, unidadeMesmaEmpresa2);

    const lista = await requestJson('GET', '/api/cozinha/impressao/fila', {
      token: tokenAuth,
      headers: { 'X-Empresa-Id': String(empresaAuth) }
    });
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    assert.equal(lista.body.empresa_id, empresaAuth);
    assert.equal(lista.body.unidade_id, unidadeAuth);
    assert.ok(lista.body.jobs.some((j) => j.id === jobAuthId), 'job da Unidade 1 deve aparecer');
    assert.ok(
      !lista.body.jobs.some((j) => j.id === jobMesmaEmpresaU2Id),
      'job da Unidade 2 (mesma empresa) NÃO deve aparecer'
    );
    assert.ok(!lista.body.jobs.some((j) => j.unidade_id === unidadeMesmaEmpresa2));

    const detalheU2 = await requestJson('GET', `/api/cozinha/impressao/fila/${jobMesmaEmpresaU2Id}`, {
      token: tokenAuth,
      headers: { 'X-Empresa-Id': String(empresaAuth) }
    });
    assert.equal(detalheU2.status, 404, JSON.stringify(detalheU2.body));
    assert.equal(detalheU2.body.codigo, 'IMPRESSAO_JOB_NAO_ENCONTRADO');
  });
});
