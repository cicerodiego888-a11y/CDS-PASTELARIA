'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const canais = require('../../backend/services/vendas/CanalVendaEmpresaService');
const schema = require('../../backend/services/vendas/canaisVendaSchema');

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function executar(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function obter(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function todos(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

function requisitarJson(porta, caminho, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: porta, path: caminho, headers }, (res) => {
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (parte) => { corpo += parte; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(corpo) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function prepararDb() {
  const db = await abrirDb();
  await executar(db, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY,
    nome_fantasia TEXT,
    razao_social TEXT,
    cnpj TEXT,
    ativo INTEGER NOT NULL DEFAULT 1
  )`);
  await executar(db, `INSERT INTO empresas (id, nome_fantasia, cnpj, ativo)
    VALUES (1, 'Empresa 1', '111', 1), (2, 'Empresa 2', '222', 1), (3, 'Empresa 3', '333', 1)`);
  return db;
}

async function cadastrar(db, codigo = 'APP', empresaId = 1) {
  return canais.cadastrarCanal(db, {
    nome: 'Aplicativo',
    codigo,
    descricao: 'Descrição inicial',
    tipo_origem: 'Marketplace',
    empresa_id: empresaId
  }, { usuario: { id: 41 } });
}

test('edita todos os campos mutáveis e registra snapshots completos sem alterar o código', async () => {
  const db = await prepararDb();
  try {
    const canal = await cadastrar(db, 'MKT_APP');
    const editado = await canais.atualizarVinculo(db, canal.id, {
      nome: 'Marketplace Novo',
      descricao: 'Descrição nova',
      tipo_origem: 'Delivery',
      empresa_id: 2,
      ativo: false,
      codigo: 'MKT_APP'
    }, { usuario: { id: 52 } });

    assert.equal(editado.nome, 'Marketplace Novo');
    assert.equal(editado.descricao, 'Descrição nova');
    assert.equal(editado.tipo_origem, 'Delivery');
    assert.equal(Number(editado.empresa_id), 2);
    assert.equal(Number(editado.ativo), 0);
    assert.equal(editado.codigo, 'MKT_APP');

    const auditoria = await obter(db, `
      SELECT * FROM canais_venda_auditoria
      WHERE canal_id = ? AND usuario_id = 52
    `, [canal.id]);
    assert.deepEqual({
      nome_anterior: auditoria.nome_anterior,
      nome_novo: auditoria.nome_novo,
      descricao_anterior: auditoria.descricao_anterior,
      descricao_nova: auditoria.descricao_nova,
      tipo_origem_anterior: auditoria.tipo_origem_anterior,
      tipo_origem_novo: auditoria.tipo_origem_novo,
      empresa_anterior_id: auditoria.empresa_anterior_id,
      empresa_nova_id: auditoria.empresa_nova_id,
      ativo_anterior: auditoria.ativo_anterior,
      ativo_novo: auditoria.ativo_novo,
      usuario_id: auditoria.usuario_id
    }, {
      nome_anterior: 'Aplicativo',
      nome_novo: 'Marketplace Novo',
      descricao_anterior: 'Descrição inicial',
      descricao_nova: 'Descrição nova',
      tipo_origem_anterior: 'Marketplace',
      tipo_origem_novo: 'Delivery',
      empresa_anterior_id: 1,
      empresa_nova_id: 2,
      ativo_anterior: 1,
      ativo_novo: 0,
      usuario_id: 52
    });
    assert.ok(auditoria.criado_em);
  } finally {
    await fecharDb(db);
  }
});

test('inativa e reativa canal preservando o código; códigos alterados são recusados', async () => {
  const db = await prepararDb();
  try {
    const canal = await cadastrar(db, 'APP_FIXO');
    const inativo = await canais.atualizarVinculo(db, canal.id, { ativo: false }, { usuario: { id: 41 } });
    assert.equal(Number(inativo.ativo), 0);
    await assert.rejects(
      canais.resolverEmpresaDoCanal(db, { codigo: 'APP_FIXO', usuario: { id: 41, role: 'ADMIN' } }),
      (err) => err.code === 'CANAL_INATIVO'
    );

    const reativado = await canais.atualizarVinculo(db, canal.id, { ativo: true }, { usuario: { id: 41 } });
    assert.equal(Number(reativado.ativo), 1);
    assert.equal(reativado.codigo, 'APP_FIXO');
    await assert.rejects(
      canais.atualizarVinculo(db, canal.id, { codigo: 'OUTRO_CODIGO' }),
      (err) => err.code === 'CANAL_CODIGO_IMUTAVEL' && err.statusCode === 409
    );
    assert.equal(Number((await obter(db, 'SELECT ativo FROM canais_venda WHERE id = ?', [canal.id])).ativo), 1);
  } finally {
    await fecharDb(db);
  }
});

test('bloqueia reativação se a empresa ficou inativa ou se o código salvo é inválido', async () => {
  const db = await prepararDb();
  try {
    const canal = await cadastrar(db, 'APP_REATIVAR');
    await canais.atualizarVinculo(db, canal.id, { ativo: false });
    await executar(db, 'UPDATE empresas SET ativo = 0 WHERE id = 1');
    await assert.rejects(
      canais.atualizarVinculo(db, canal.id, { ativo: true }),
      (err) => err.code === 'EMPRESA_INATIVA' && err.statusCode === 409
    );
    assert.equal(Number((await obter(db, 'SELECT ativo FROM canais_venda WHERE id = ?', [canal.id])).ativo), 0);

    const outro = await cadastrar(db, 'APP_VALIDO', 2);
    await canais.atualizarVinculo(db, outro.id, { ativo: false });
    await executar(db, `UPDATE canais_venda SET codigo = 'app invalido' WHERE id = ?`, [outro.id]);
    await assert.rejects(
      canais.atualizarVinculo(db, outro.id, { ativo: true }),
      (err) => err.code === 'CANAL_CODIGO_INVALIDO' && err.statusCode === 409
    );
    assert.equal(Number((await obter(db, 'SELECT ativo FROM canais_venda WHERE id = ?', [outro.id])).ativo), 0);
  } finally {
    await fecharDb(db);
  }
});

test('preserva pedidos e vendas históricas ao editar e inativar canal', async () => {
  const db = await prepararDb();
  try {
    await executar(db, 'CREATE TABLE pedidos (id INTEGER PRIMARY KEY, origem_canal TEXT, empresa_id INTEGER)');
    await executar(db, 'CREATE TABLE vendas (id INTEGER PRIMARY KEY, origem TEXT, empresa_id INTEGER)');
    const canal = await cadastrar(db, 'HIST_APP');
    await executar(db, 'INSERT INTO pedidos (id, origem_canal, empresa_id) VALUES (10, ?, 1)', [canal.codigo]);
    await executar(db, 'INSERT INTO vendas (id, origem, empresa_id) VALUES (20, ?, 1)', [canal.codigo]);
    await canais.atualizarVinculo(db, canal.id, {
      nome: 'Nome atualizado',
      empresa_id: 2,
      ativo: false
    });
    assert.deepEqual(await obter(db, 'SELECT origem_canal, empresa_id FROM pedidos WHERE id = 10'), {
      origem_canal: 'HIST_APP',
      empresa_id: 1
    });
    assert.deepEqual(await obter(db, 'SELECT origem, empresa_id FROM vendas WHERE id = 20'), {
      origem: 'HIST_APP',
      empresa_id: 1
    });
  } finally {
    await fecharDb(db);
  }
});

test('rollback da alteração quando a gravação da auditoria falha', async () => {
  const db = await prepararDb();
  try {
    const canal = await cadastrar(db, 'APP_TX');
    const totalAntes = Number((await obter(db, `
      SELECT COUNT(*) AS total FROM canais_venda_auditoria WHERE canal_id = ?
    `, [canal.id])).total);
    await executar(db, `
      CREATE TRIGGER falhar_auditoria_canal
      BEFORE INSERT ON canais_venda_auditoria
      BEGIN
        SELECT RAISE(ABORT, 'falha sintética de auditoria');
      END
    `);
    await assert.rejects(
      canais.atualizarVinculo(db, canal.id, { nome: 'Não persistir' }),
      /falha sintética de auditoria/
    );
    assert.equal((await obter(db, 'SELECT nome FROM canais_venda WHERE id = ?', [canal.id])).nome, 'Aplicativo');
    assert.equal(Number((await obter(db, `
      SELECT COUNT(*) AS total FROM canais_venda_auditoria WHERE canal_id = ?
    `, [canal.id])).total), totalAntes);
  } finally {
    await fecharDb(db);
  }
});

test('grava atualização e auditoria na conexão transacional exclusiva', async () => {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-canais-p11-'));
  const arquivo = path.join(diretorio, 'canais.db');
  const db = await new Promise((resolve, reject) => {
    const conexao = new sqlite3.Database(arquivo, (err) => (err ? reject(err) : resolve(conexao)));
  });
  db.openExclusiveConnection = () => new Promise((resolve, reject) => {
    const exclusiva = new sqlite3.Database(arquivo, (err) => (err ? reject(err) : resolve(exclusiva)));
  });
  try {
    await executar(db, `CREATE TABLE empresas (
      id INTEGER PRIMARY KEY, nome_fantasia TEXT, razao_social TEXT, cnpj TEXT, ativo INTEGER
    )`);
    await executar(db, `INSERT INTO empresas (id, nome_fantasia, ativo) VALUES (1, 'Empresa 1', 1)`);
    const canal = await cadastrar(db, 'APP_EXCLUSIVO');
    await canais.atualizarVinculo(db, canal.id, {
      nome: 'Atualizado na conexão exclusiva'
    }, { usuario: { id: 64 } });
    const gravado = await obter(db, 'SELECT nome FROM canais_venda WHERE id = ?', [canal.id]);
    const auditoria = await obter(db, `
      SELECT nome_anterior, nome_novo FROM canais_venda_auditoria
      WHERE canal_id = ? AND usuario_id = 64
    `, [canal.id]);
    assert.equal(gravado.nome, 'Atualizado na conexão exclusiva');
    assert.deepEqual(auditoria, {
      nome_anterior: 'Aplicativo',
      nome_novo: 'Atualizado na conexão exclusiva'
    });
  } finally {
    await fecharDb(db);
    fs.rmSync(diretorio, { recursive: true, force: true });
  }
});

test('mantém suporte a N empresas e resolve PDV sem registro comercial', async () => {
  const db = await prepararDb();
  try {
    const canaisPorEmpresa = [];
    for (const [codigo, empresaId] of [['APP_1', 1], ['APP_2', 2], ['APP_3', 3]]) {
      const canal = await cadastrar(db, codigo, empresaId);
      canaisPorEmpresa.push(await canais.resolverEmpresaDoCanal(
        db,
        { codigo, usuario: { id: 41, empresas: [1, 2, 3] } }
      ));
    }
    assert.deepEqual(canaisPorEmpresa.map((canal) => canal.empresa_id), [1, 2, 3]);

    await assert.rejects(
      canais.cadastrarCanal(db, {
        nome: 'PDV',
        codigo: 'PDV',
        tipo_origem: 'PDV',
        empresa_id: 2
      }),
      (err) => err.code === 'CANAL_PDV_USA_CONFIG' && err.statusCode === 409
    );
    const resolvido = await canais.resolverEmpresaDoCanal(
      db,
      { codigo: 'PDV', usuario: { id: 41, role: 'SUPER_ADMIN' } },
      {
        cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 2 },
        validarEmpresaPdv: async (id) => ({ empresa_id: id })
      }
    );
    assert.equal(resolvido.empresa_id, 2);
    assert.equal(resolvido.canal_id, null);
    assert.equal(Number((await obter(db, `SELECT COUNT(*) AS total FROM canais_venda`)).total), 3);
  } finally {
    await fecharDb(db);
  }
});

test('evolui auditoria existente de forma aditiva e idempotente sem apagar o histórico legado', async () => {
  const db = await abrirDb();
  try {
    await executar(db, `CREATE TABLE canais_venda (
      id INTEGER PRIMARY KEY, nome TEXT NOT NULL, codigo TEXT NOT NULL UNIQUE,
      tipo_origem TEXT NOT NULL, empresa_id INTEGER, ativo INTEGER NOT NULL,
      criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL
    )`);
    await executar(db, `CREATE TABLE canais_venda_auditoria (
      id INTEGER PRIMARY KEY, canal_id INTEGER NOT NULL, empresa_anterior_id INTEGER,
      empresa_nova_id INTEGER, ativo_anterior INTEGER, ativo_novo INTEGER,
      usuario_id INTEGER, criado_em TEXT NOT NULL
    )`);
    await executar(db, `INSERT INTO canais_venda_auditoria
      (id, canal_id, empresa_anterior_id, empresa_nova_id, ativo_anterior, ativo_novo, criado_em)
      VALUES (1, 1, 1, 2, 1, 0, 'antigo')`);
    await schema.garantirSchemaCanaisVendaAsync(db);
    await schema.garantirSchemaCanaisVendaAsync(db);
    const colunas = await todos(db, 'PRAGMA table_info(canais_venda_auditoria)');
    for (const coluna of [
      'nome_anterior', 'nome_novo', 'descricao_anterior', 'descricao_nova',
      'tipo_origem_anterior', 'tipo_origem_novo'
    ]) {
      assert.ok(colunas.some((item) => item.name === coluna), `${coluna} foi adicionada`);
    }
    assert.deepEqual(
      await obter(db, 'SELECT empresa_anterior_id, empresa_nova_id, criado_em FROM canais_venda_auditoria WHERE id = 1'),
      { empresa_anterior_id: 1, empresa_nova_id: 2, criado_em: 'antigo' }
    );
  } finally {
    await fecharDb(db);
  }
});

test('rotas administrativas exigem SUPER_ADMIN e não expõem exclusão física', async () => {
  const rota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/configuracoes_avancadas.js'), 'utf8');
  for (const trecho of [
    "router.get('/canais-venda', exigirSuperAdmin",
    "router.get('/canais-venda/:id/historico', exigirSuperAdmin",
    "router.post('/canais-venda', exigirSuperAdmin",
    "router.put('/canais-venda/:id', exigirSuperAdmin"
  ]) {
    assert.ok(rota.includes(trecho), `${trecho} protegido`);
  }
  assert.doesNotMatch(rota, /router\.delete\(['"]\/canais-venda/);

  const databasePath = require.resolve('../../backend/database');
  const authPath = require.resolve('../../backend/middleware/auth');
  const cacheAnteriorBanco = require.cache[databasePath];
  const cacheAnteriorAuth = require.cache[authPath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {}
  };
  delete require.cache[authPath];
  let exigirSuperAdmin;
  try {
    exigirSuperAdmin = require('../../backend/middleware/auth').exigirSuperAdmin;
  } finally {
    delete require.cache[authPath];
    if (cacheAnteriorBanco) require.cache[databasePath] = cacheAnteriorBanco;
    else delete require.cache[databasePath];
    if (cacheAnteriorAuth) require.cache[authPath] = cacheAnteriorAuth;
  }
  const negado = await new Promise((resolve) => {
    exigirSuperAdmin(
      { user: { perfil: 'ADMIN' } },
      { status(status) { this.statusCode = status; return this; }, json(body) { resolve({ status: this.statusCode, body }); } },
      () => resolve({ status: 200 })
    );
  });
  assert.equal(negado.status, 403);
  const permitido = await new Promise((resolve) => {
    exigirSuperAdmin(
      { user: { perfil: 'SUPER_ADMIN' } },
      { status() { return this; }, json() {} },
      () => resolve(true)
    );
  });
  assert.equal(permitido, true);
});

test('endpoint de histórico retorna snapshots completos e nega usuário sem perfil SUPER_ADMIN', async () => {
  const db = await prepararDb();
  await schema.garantirSchemaCanaisVendaAsync(db);
  const canal = await cadastrar(db, 'HIST_API');
  await canais.atualizarVinculo(db, canal.id, {
    nome: 'Histórico API',
    descricao: 'Auditoria consultável',
    tipo_origem: 'Online',
    empresa_id: 3
  }, { usuario: { id: 61 } });

  db.whenReady = (callback) => callback(null);
  const databasePath = require.resolve('../../backend/database');
  const routePath = require.resolve('../../backend/rotas/configuracoes_avancadas');
  const cacheAnteriorBanco = require.cache[databasePath];
  const cacheAnteriorRota = require.cache[routePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: db
  };
  delete require.cache[routePath];

  const app = express();
  app.use((req, _res, next) => {
    if (req.headers['x-super-admin'] === 'true') req.user = { perfil: 'SUPER_ADMIN' };
    else req.user = { perfil: 'ADMIN' };
    next();
  });
  app.use('/api/configuracoes-avancadas', require('../../backend/rotas/configuracoes_avancadas'));
  const servidor = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const caminho = `/api/configuracoes-avancadas/canais-venda/${canal.id}/historico`;
    const negado = await requisitarJson(servidor.address().port, caminho);
    assert.equal(negado.status, 403);

    const resposta = await requisitarJson(servidor.address().port, caminho, { 'x-super-admin': 'true' });
    assert.equal(resposta.status, 200);
    assert.ok(Array.isArray(resposta.body.auditoria));
    const evento = resposta.body.auditoria.find((item) => item.usuario_id === 61);
    assert.equal(evento.nome_anterior, 'Aplicativo');
    assert.equal(evento.nome_novo, 'Histórico API');
    assert.equal(evento.descricao_nova, 'Auditoria consultável');
    assert.equal(evento.tipo_origem_novo, 'Online');
    assert.equal(evento.empresa_nova_id, 3);
  } finally {
    await new Promise((resolve, reject) => {
      servidor.close((err) => (err ? reject(err) : resolve()));
    });
    await fecharDb(db);
    if (cacheAnteriorBanco) require.cache[databasePath] = cacheAnteriorBanco;
    else delete require.cache[databasePath];
    if (cacheAnteriorRota) require.cache[routePath] = cacheAnteriorRota;
    else delete require.cache[routePath];
  }
});
