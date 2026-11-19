/**
 * Sprint 06 — Bloco A: fundação e contratos de impressão de cozinha.
 * Banco temporário. Sem impressão física. Sem Blocos B–E.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06a-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = 'test-only-s06a-bloco-a';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

const {
  garantirSchemaCozinha,
  COZINHA_SCHEMA_VERSION,
  garantirIndiceEstacoesCodigoPorUnidade,
  lerVersaoSchema
} = require('../../backend/utils/cozinhaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EstacaoService = require('../../backend/services/cozinha/CozinhaImpressaoEstacaoService');
const {
  montarPayloadSnapshot,
  serializarSnapshot,
  snapshotContemCamposProibidos,
  normalizarLarguraMm
} = require('../../backend/services/cozinha/cozinhaImpressaoContratos');
const {
  renderizarTexto,
  renderizarTesteEstacao
} = require('../../backend/services/cozinha/CozinhaImpressaoRenderer');
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

async function preparar(db) {
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaCozinha(db);
  assert.equal(COZINHA_SCHEMA_VERSION, 4);

  const e1 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('11111111000111', 'Emp 1', 'E1', 1)
  `);
  const e2 = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES ('22222222000122', 'Emp 2', 'E2', 1)
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

  return {
    empresa1: e1.lastID,
    empresa2: e2.lastID,
    unidade1a: u1a.lastID,
    unidade1b: u1b.lastID,
    unidade2: u2.lastID
  };
}

describe('Sprint 06 Bloco A — UNIQUE codigo_estacao por unidade', () => {
  it('1) mesmo codigo_estacao em unidades distintas da mesma empresa é permitido', async () => {
    const db = await openMem();
    const ids = await preparar(db);

    await EstacaoService.criarEstacao({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      codigo_estacao: 'PASTEL',
      largura_mm: 80
    });
    await EstacaoService.criarEstacao({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1b,
      codigo_estacao: 'PASTEL',
      largura_mm: 80
    });

    const rows = await all(db, `
      SELECT unidade_id, codigo_estacao FROM cozinha_estacoes_impressao
      WHERE empresa_id = ? AND codigo_estacao = 'PASTEL'
      ORDER BY unidade_id
    `, [ids.empresa1]);
    assert.equal(rows.length, 2);

    // índice legado empresa+codigo não deve existir
    const idx = await all(db, `PRAGMA index_list('cozinha_estacoes_impressao')`);
    const nomes = idx.map((r) => r.name);
    assert.ok(!nomes.includes('ux_cozinha_estacoes_empresa_codigo'));
    assert.ok(nomes.includes('ux_cozinha_estacoes_empresa_unidade_codigo'));

    await close(db);
  });

  it('2) mesmo codigo_estacao na mesma unidade é rejeitado', async () => {
    const db = await openMem();
    const ids = await preparar(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a, codigo_estacao: 'BEBIDA'
    });
    await assert.rejects(
      () => EstacaoService.criarEstacao({
        db, empresaId: ids.empresa1, unidadeId: ids.unidade1a, codigo_estacao: 'BEBIDA'
      }),
      (err) => err.codigo === 'ESTACAO_CODIGO_DUPLICADO'
    );
    await close(db);
  });

  it('3) DROP do índice legado + recreate idempotente; versão do schema não muda', async () => {
    const db = await openMem();
    const ids = await preparar(db);

    const versaoRegistrada = await lerVersaoSchema(db);
    assert.equal(versaoRegistrada, COZINHA_SCHEMA_VERSION);
    assert.equal(COZINHA_SCHEMA_VERSION, 4);

    const rowMeta = await get(db, `
      SELECT valor FROM cozinha_schema_meta WHERE chave = 'schema_version'
    `);
    assert.ok(rowMeta, 'meta schema_version deve existir no banco');
    assert.equal(Number(rowMeta.valor), COZINHA_SCHEMA_VERSION);

    // simula legado
    await run(db, 'DROP INDEX IF EXISTS ux_cozinha_estacoes_empresa_unidade_codigo');
    await run(db, `
      CREATE UNIQUE INDEX ux_cozinha_estacoes_empresa_codigo
      ON cozinha_estacoes_impressao(empresa_id, codigo_estacao)
    `);
    await garantirIndiceEstacoesCodigoPorUnidade(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a, codigo_estacao: 'OUTRO'
    });
    await EstacaoService.criarEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1b, codigo_estacao: 'OUTRO'
    });

    const versaoApos = await lerVersaoSchema(db);
    assert.equal(versaoApos, versaoRegistrada, 'ajuste de índice não pode mudar a versão');
    const rowApos = await get(db, `
      SELECT valor FROM cozinha_schema_meta WHERE chave = 'schema_version'
    `);
    assert.equal(Number(rowApos.valor), versaoRegistrada);
    await close(db);
  });
});

describe('Sprint 06 Bloco A — CRUD estações', () => {
  let db;
  let ids;

  before(async () => {
    db = await openMem();
    ids = await preparar(db);
  });
  after(async () => {
    await close(db);
  });

  it('4) cria, lista, obtém e atualiza estação na unidade autenticada', async () => {
    const criado = await EstacaoService.criarEstacao({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      codigo_estacao: 'pastel',
      device_name: 'EPSON-TM-T20',
      largura_mm: 80,
      vias: 2,
      modelo_individual: 1,
      modelo_agrupado: 0
    });
    assert.equal(criado.estacao.codigo_estacao, 'PASTEL');
    assert.equal(criado.estacao.largura_mm, 80);
    assert.equal(criado.estacao.vias, 2);
    assert.equal(criado.estacao.modelo_agrupado, false);

    const lista = await EstacaoService.listarEstacoes({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a
    });
    assert.ok(lista.estacoes.some((e) => e.codigo_estacao === 'PASTEL'));

    const obtido = await EstacaoService.obterEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a, id: criado.estacao.id
    });
    assert.equal(obtido.estacao.device_name, 'EPSON-TM-T20');

    const upd = await EstacaoService.atualizarEstacao({
      db,
      empresaId: ids.empresa1,
      unidadeId: ids.unidade1a,
      id: criado.estacao.id,
      dados: { largura_mm: 58, ativo: 0 }
    });
    assert.equal(upd.estacao.largura_mm, 58);
    assert.equal(upd.estacao.ativo, false);
  });

  it('5) rejeita estação de outra empresa / outra unidade', async () => {
    const local = await EstacaoService.criarEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a, codigo_estacao: 'ISO-A'
    });
    await assert.rejects(
      () => EstacaoService.obterEstacao({
        db, empresaId: ids.empresa2, unidadeId: ids.unidade2, id: local.estacao.id
      }),
      (err) => err.codigo === 'ESTACAO_NAO_ENCONTRADA'
    );
    await assert.rejects(
      () => EstacaoService.obterEstacao({
        db, empresaId: ids.empresa1, unidadeId: ids.unidade1b, id: local.estacao.id
      }),
      (err) => err.codigo === 'ESTACAO_NAO_ENCONTRADA'
    );
    await assert.rejects(
      () => EstacaoService.criarEstacao({
        db, empresaId: ids.empresa1, unidadeId: ids.unidade2, codigo_estacao: 'X'
      }),
      (err) => err.codigo === 'UNIDADE_EMPRESA_ISOLAMENTO'
    );
  });

  it('6) largura_mm 58/80 ok; demais rejeitados', async () => {
    assert.equal(normalizarLarguraMm(58), 58);
    assert.equal(normalizarLarguraMm(80), 80);
    assert.throws(() => normalizarLarguraMm(72), (err) => err.codigo === 'ESTACAO_LARGURA_INVALIDA');
    await assert.rejects(
      () => EstacaoService.criarEstacao({
        db, empresaId: ids.empresa1, unidadeId: ids.unidade1a,
        codigo_estacao: 'LARG', largura_mm: 100
      }),
      (err) => err.codigo === 'ESTACAO_LARGURA_INVALIDA'
    );
  });
});

describe('Sprint 06 Bloco A — snapshot e renderer', () => {
  it('7) snapshot canônico sem preços/fiscais; input sujo é descartado', () => {
    const snap = montarPayloadSnapshot({
      empresa_id: 1,
      unidade_id: 2,
      rodada_id: 3,
      sequencia_global: 10,
      mesa_numero: '7',
      modelo: 'AGRUPADO',
      largura_mm: 80,
      preco_total: 99.9,
      ncm: '21069090',
      itens: [{
        cozinha_item_id: 11,
        comanda_id: 5,
        tipo_item: 'PASTEL',
        descricao: 'Carne',
        qty: '2.000',
        preco: 12.5,
        valor: 25,
        observacao: 'sem cebola',
        ingredientes: [{ nome: 'Queijo', qty: '1.000', selecionado: true }]
      }]
    });
    assert.equal(snap.itens[0].descricao, 'Carne');
    assert.equal(snap.itens[0].preco, undefined);
    assert.equal(snap.preco_total, undefined);
    const proibidos = snapshotContemCamposProibidos(snap);
    assert.deepEqual(proibidos, []);
    const json = serializarSnapshot(snap);
    assert.ok(!/"preco"/i.test(json));
    assert.ok(!/"ncm"/i.test(json));
  });

  it('8) renderer gera texto 80/58 e marca impressao_fisica=false', () => {
    const snap = montarPayloadSnapshot({
      empresa_id: 1,
      unidade_id: 1,
      rodada_id: 1,
      mesa_numero: '3',
      sequencia_global: 4,
      modelo: 'INDIVIDUAL',
      largura_mm: 80,
      itens: [{
        cozinha_item_id: 1,
        comanda_id: 2,
        tipo_item: 'BEBIDA',
        descricao: 'Refrigerante',
        qty: '1.000'
      }]
    });
    const r80 = renderizarTexto(snap);
    assert.equal(r80.impressao_fisica, false);
    assert.equal(r80.largura_mm, 80);
    assert.match(r80.texto, /COZINHA/);
    assert.match(r80.texto, /Refrigerante/);

    const r58 = renderizarTexto(snap, { largura_mm: 58 });
    assert.equal(r58.largura_mm, 58);
    assert.equal(r58.colunas, 32);
    assert.equal(r58.impressao_fisica, false);
  });

  it('9) teste de estação (D6) não imprime e não exige fila', async () => {
    const db = await openMem();
    const ids = await preparar(db);
    const criado = await EstacaoService.criarEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a,
      codigo_estacao: 'TESTE', device_name: 'DEV-NULL', largura_mm: 80
    });
    const out = await EstacaoService.testarEstacao({
      db, empresaId: ids.empresa1, unidadeId: ids.unidade1a, id: criado.estacao.id
    });
    assert.equal(out.impressao_fisica, false);
    assert.equal(out.teste.impressao_fisica, false);
    assert.equal(out.teste.modo, 'TESTE_ESTACAO');
    assert.match(out.teste.texto, /Teste estacao TESTE/);

    const fila = await all(db, `SELECT id FROM cozinha_impressao_fila`);
    assert.equal(fila.length, 0);

    const preview = renderizarTesteEstacao(criado.estacao);
    assert.equal(preview.impressao_fisica, false);
    await close(db);
  });

  it('10) rejeita modelo/tipo inválidos no snapshot', () => {
    assert.throws(
      () => montarPayloadSnapshot({
        empresa_id: 1, unidade_id: 1, rodada_id: 1, modelo: 'XYZ', itens: []
      }),
      (err) => err.codigo === 'SNAPSHOT_MODELO_INVALIDO'
    );
    assert.throws(
      () => montarPayloadSnapshot({
        empresa_id: 1, unidade_id: 1, rodada_id: 1,
        itens: [{ tipo_item: 'LANCHE', descricao: 'x' }]
      }),
      (err) => err.codigo === 'SNAPSHOT_TIPO_ITEM_INVALIDO'
    );
  });

  it('11) snapshot e elementos internos são imutáveis (deep freeze)', () => {
    const snap = montarPayloadSnapshot({
      empresa_id: 1,
      unidade_id: 1,
      rodada_id: 1,
      modelo: 'AGRUPADO',
      itens: [{
        cozinha_item_id: 1,
        comanda_id: 2,
        tipo_item: 'PASTEL',
        descricao: 'Carne',
        qty: '1.000',
        ingredientes: [{ nome: 'Queijo', qty: '1.000', selecionado: true }]
      }]
    });
    assert.ok(Object.isFrozen(snap));
    assert.ok(Object.isFrozen(snap.itens));
    assert.ok(Object.isFrozen(snap.itens[0]));
    assert.ok(Object.isFrozen(snap.itens[0].ingredientes));
    assert.ok(Object.isFrozen(snap.itens[0].ingredientes[0]));

    assert.throws(() => { snap.mesa_numero = 'HACK'; }, TypeError);
    assert.throws(() => { snap.itens.push({ tipo_item: 'OUTRO' }); }, TypeError);
    assert.throws(() => { snap.itens[0].descricao = 'HACK'; }, TypeError);
    assert.throws(() => { snap.itens[0].ingredientes[0].nome = 'HACK'; }, TypeError);
    assert.equal(snap.itens[0].descricao, 'Carne');
    assert.equal(snap.itens[0].ingredientes[0].nome, 'Queijo');
  });

  it('12) serializarSnapshot normaliza e remove campos comerciais/fiscais', () => {
    const sujo = {
      empresa_id: 1,
      unidade_id: 1,
      rodada_id: 9,
      modelo: 'AGRUPADO',
      preco_total: 50,
      ncm: '1234',
      itens: [{
        tipo_item: 'BEBIDA',
        descricao: 'Suco',
        qty: '1.000',
        preco: 8,
        valor: 8
      }]
    };
    const json = serializarSnapshot(sujo);
    const parsed = JSON.parse(json);
    assert.equal(parsed.rodada_id, 9);
    assert.equal(parsed.itens[0].descricao, 'Suco');
    assert.equal(parsed.preco_total, undefined);
    assert.equal(parsed.itens[0].preco, undefined);
    assert.ok(!/"preco"/i.test(json));
    assert.ok(!/"ncm"/i.test(json));
    assert.ok(!/"valor"/i.test(json));
    assert.deepEqual(snapshotContemCamposProibidos(parsed), []);
  });
});

describe('Sprint 06 Bloco A — isolamento JWT na rota POST estacoes (rota real)', () => {
  let dbProd;
  let server;
  let baseUrl;
  let recursoOriginal;
  let empresaAuth;
  let unidadeAuth;
  let empresaFalsa;
  let unidadeFalsa;
  let operadorId;

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
    // Carrega módulos de produção apenas neste bloco (mesmo DB_DIR temporário).
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
    // database.js inicia schema Cozinha em Promise encadeada (não bloqueia whenReady).
    // Aguarda a tentativa assíncrona terminar (sucesso ou FALHA_SCHEMA) antes de forçar.
    marcarCozinhaOperacional(false, new Error('aguardando-init-arquivo-s06a'));
    for (let i = 0; i < 60; i++) {
      const st = getCozinhaSchemaStatus();
      const msg = st.erro && st.erro.mensagem ? String(st.erro.mensagem) : '';
      if (st.operacional === true) break;
      if (st.erro && msg !== 'aguardando-init-arquivo-s06a') break;
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
    assert.equal(getCozinhaSchemaStatus().operacional, true);
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
      VALUES ('55555555000155', 'Empresa Auth S06A', 'AUTH', 1)
    `);
    empresaAuth = empAuth.lastID;
    const empFake = await run(dbProd, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('66666666000166', 'Empresa Fake S06A', 'FAKE', 1)
    `);
    empresaFalsa = empFake.lastID;

    const op = await run(dbProd, `
      INSERT INTO usuarios (username, password_hash, role, perfil, ativo, nome)
      VALUES ('op_s06a_rota_real', 'hash', 'operador', 'USUARIO', 1, 'Op S06A')
    `);
    operadorId = op.lastID;
    await run(dbProd, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)
    `, [operadorId, empresaAuth]);

    const unAuth = await run(dbProd, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-AUTH', 1)
    `, [empresaAuth]);
    unidadeAuth = unAuth.lastID;
    const unFake = await run(dbProd, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-FAKE', 1)
    `, [empresaFalsa]);
    unidadeFalsa = unFake.lastID;

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    const app = express();
    app.use(express.json());
    // Rota REAL de produção (backend/rotas/cozinha.js)
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

  it('13) rota real: body com IDs falsos não sobrescreve empresa/unidade da sessão', async () => {
    // Confirma que o fonte de produção é o carregado.
    const rotaPath = require.resolve('../../backend/rotas/cozinha');
    assert.match(rotaPath.replace(/\\/g, '/'), /backend\/rotas\/cozinha\.js$/);

    const token = jwt.sign({
      id: operadorId,
      usuario_id: operadorId,
      username: 'op_s06a_rota_real',
      role: 'operador',
      perfil: 'USUARIO',
      unidade_cozinha_id: unidadeAuth
    }, JWT_SECRET, { expiresIn: '1h' });

    const decoded = jwt.verify(token, JWT_SECRET);
    assert.equal(decoded.unidade_cozinha_id, unidadeAuth);

    const resBody = await requestJson('POST', '/api/cozinha/impressao/estacoes', {
      token,
      headers: { 'X-Empresa-Id': String(empresaAuth) },
      body: {
        codigo_estacao: 'ROTA-REAL-ISO',
        largura_mm: 80,
        empresaId: empresaFalsa,
        unidadeId: unidadeFalsa,
        empresa_id: 999999,
        unidade_id: 999999
      }
    });

    assert.equal(resBody.status, 201, JSON.stringify(resBody.body));
    assert.equal(resBody.body.estacao.empresa_id, empresaAuth);
    assert.equal(resBody.body.estacao.unidade_id, unidadeAuth);
    assert.notEqual(resBody.body.estacao.empresa_id, empresaFalsa);
    assert.notEqual(resBody.body.estacao.unidade_id, unidadeFalsa);
    assert.notEqual(resBody.body.estacao.empresa_id, 999999);
    assert.notEqual(resBody.body.estacao.unidade_id, 999999);

    const rowAuth = await get(dbProd, `
      SELECT empresa_id, unidade_id, codigo_estacao
      FROM cozinha_estacoes_impressao
      WHERE codigo_estacao = 'ROTA-REAL-ISO'
    `);
    assert.ok(rowAuth);
    assert.equal(rowAuth.empresa_id, empresaAuth);
    assert.equal(rowAuth.unidade_id, unidadeAuth);

    const rowFake = await get(dbProd, `
      SELECT id FROM cozinha_estacoes_impressao
      WHERE codigo_estacao = 'ROTA-REAL-ISO'
        AND (empresa_id = ? OR unidade_id = ? OR empresa_id = 999999 OR unidade_id = 999999)
    `, [empresaFalsa, unidadeFalsa]);
    assert.equal(rowFake, null);
  });
});

describe('Sprint 06 Bloco A — não acopla impressão comercial', () => {
  it('14) módulos de impressão cozinha não referenciam impressora_cupom /api/impressao', () => {
    const root = path.join(__dirname, '..', '..', 'backend', 'services', 'cozinha');
    const files = [
      'cozinhaImpressaoContratos.js',
      'CozinhaImpressaoRenderer.js',
      'CozinhaImpressaoEstacaoService.js'
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      assert.ok(!/impressora_cupom/.test(src), f);
      assert.ok(!/\/api\/impressao/.test(src), f);
      assert.ok(!/ComprovantePrintService/.test(src), f);
      assert.ok(!/fiscalImpressao/.test(src), f);
    }
  });
});
