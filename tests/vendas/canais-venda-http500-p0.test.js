/**
 * CDS-CANAIS-VENDA-HTTP500-P0
 * Banco em memória. Não abre o banco oficial.
 *
 * node --test --test-concurrency=1 tests/vendas/canais-venda-http500-p0.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-canais-http500-'));
process.env.DB_DIR = dbDir;
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const servico = require('../../backend/services/vendas/CanalVendaEmpresaService');
const schema = require('../../backend/services/vendas/canaisVendaSchema');
const { aplicarCertificacaoSql } = require('../../backend/lib/sqlCertification');

const multiplas = { cfg: { pdv_modelo_empresa: 'MULTIPLAS', pdv_empresa_id: null } };
const unica = (id) => ({ cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: id } });

function abrir() {
  const db = new sqlite3.Database(':memory:');
  aplicarCertificacaoSql(db);
  return db;
}

function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function empresas(db) {
  await run(db, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY,
    cnpj TEXT NOT NULL,
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT,
    ativo INTEGER NOT NULL DEFAULT 1
  )`);
}

test('1. listagem com tabelas inexistentes', async () => {
  const db = abrir();
  await servico.garantirSchema(db);
  const lista = await servico.consultarListagemCanais(db, multiplas);
  assert.deepEqual(lista.canais, []);
  assert.equal(await get(db, "SELECT COUNT(*) AS n FROM canais_venda").then((row) => row.n), 0);
  db.close();
});

test('2. listagem com o schema atual', async () => {
  const db = abrir();
  await empresas(db);
  await servico.garantirSchema(db);
  const canaisColunas = await all(db, 'PRAGMA table_info(canais_venda)');
  const auditoriaColunas = await all(db, 'PRAGMA table_info(canais_venda_auditoria)');
  const tipos = new Map(canaisColunas.map((coluna) => [coluna.name, coluna.type]));
  [
    'id', 'nome', 'codigo', 'descricao', 'tipo_origem', 'empresa_id',
    'ativo', 'criado_em', 'atualizado_em'
  ].forEach((coluna) => assert.equal(tipos.has(coluna), true, coluna));
  assert.equal(tipos.get('id'), 'INTEGER');
  assert.equal(tipos.get('empresa_id'), 'INTEGER');
  [
    'id', 'canal_id', 'empresa_anterior_id', 'empresa_nova_id',
    'ativo_anterior', 'ativo_novo', 'usuario_id', 'criado_em'
  ].forEach((coluna) => {
    assert.equal(auditoriaColunas.some((item) => item.name === coluna), true, coluna);
  });
  const indices = await all(db, 'PRAGMA index_list(canais_venda)');
  assert.equal(indices.some((indice) => Number(indice.unique) === 1), true);
  await run(db, `
    INSERT INTO canais_venda (nome, codigo, descricao, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
    VALUES ('iFood', 'IFOOD', 'App', 'Marketplace', NULL, 1, 't', 't')
  `);
  const lista = await servico.listarCanais(db, multiplas);
  assert.equal(lista[0].codigo, 'IFOOD');
  assert.equal(lista[0].descricao, 'App');
  db.close();
});

test('3. schema legado recebe as colunas e a listagem segue', async () => {
  const db = abrir();
  await empresas(db);
  await run(db, `CREATE TABLE canais_venda (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT NOT NULL UNIQUE,
    empresa_id INTEGER
  )`);
  await run(db, `INSERT INTO canais_venda (nome, codigo, empresa_id) VALUES ('Balcão', 'BALCAO', NULL)`);
  await schema.garantirSchemaCanaisVendaAsync(db);
  const lista = await servico.listarCanais(db, multiplas);
  const colunas = await all(db, 'PRAGMA table_info(canais_venda)');
  const nomes = colunas.map((coluna) => coluna.name);
  ['descricao', 'tipo_origem', 'ativo', 'criado_em', 'atualizado_em'].forEach((nome) => {
    assert.equal(nomes.includes(nome), true, nome);
  });
  assert.equal(lista.some((canal) => canal.codigo === 'BALCAO'), true);
  await schema.reverterIndiceCodigoCanaisVenda(db);
  const indice = await get(db, `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_canais_venda_codigo'`);
  assert.equal(indice, null);
  db.close();
});

test('4. listagem sem empresas cadastradas', async () => {
  const db = abrir();
  await empresas(db);
  await servico.cadastrarCanal(db, {
    nome: 'WhatsApp', codigo: 'WHATSAPP', tipo_origem: 'Mensagem', empresa_id: null, ativo: false
  }, {});
  const lista = await servico.consultarListagemCanais(db, multiplas);
  assert.equal(lista.canais[0].cnpj, null);
  assert.equal(lista.avisos.some((aviso) => /cadastro de empresas/i.test(aviso)), false);
  db.close();
});

test('5. listagem com empresa vinculada', async () => {
  const db = abrir();
  await empresas(db);
  await run(db, `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo) VALUES (4, '044', 'Razão 4', 'Loja 4', 1)`);
  await servico.cadastrarCanal(db, {
    nome: 'Site', codigo: 'SITE', tipo_origem: 'Online', empresa_id: 4
  }, {});
  const lista = await servico.listarCanais(db, multiplas);
  assert.equal(lista[0].cnpj, '044');
  assert.equal(lista[0].nome_fantasia, 'Loja 4');
  db.close();
});

test('6. empresa inexistente no vínculo não derruba a listagem', async () => {
  const db = abrir();
  await empresas(db);
  await servico.garantirSchema(db);
  await run(db, `
    INSERT INTO canais_venda (nome, codigo, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
    VALUES ('App', 'APP', 'Aplicativo', 99, 0, 't', 't')
  `);
  const lista = await servico.listarCanais(db, multiplas);
  assert.equal(lista[0].empresa_id, 99);
  assert.equal(lista[0].cnpj, null);
  db.close();
});

test('6b. JOIN anterior falha em schema de empresa sem nome_fantasia; leitura compatível funciona', async () => {
  const db = abrir();
  await run(db, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY,
    cnpj TEXT,
    razao_social TEXT
  )`);
  await servico.garantirSchema(db);
  await run(db, `
    INSERT INTO canais_venda (nome, codigo, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
    VALUES ('Loja', 'LOJA', 'Fisica', 1, 1, 't', 't')
  `);
  const sqlAnterior = `
    SELECT c.id, c.nome, c.codigo, c.descricao, c.tipo_origem, c.empresa_id, c.ativo,
           c.criado_em, c.atualizado_em, e.cnpj, e.nome_fantasia, e.razao_social
    FROM canais_venda c
    LEFT JOIN empresas e ON e.id = c.empresa_id
    ORDER BY c.nome COLLATE NOCASE
  `;
  const falhaOriginal = await new Promise((resolve) => {
    db.all(sqlAnterior, [], (err) => resolve(err));
  });
  assert.equal(falhaOriginal.code, 'SQLITE_ERROR');
  assert.match(falhaOriginal.message, /no such column: e\.nome_fantasia/i);
  const lista = await servico.listarCanais(db, multiplas);
  assert.equal(lista[0].codigo, 'LOJA');
  assert.equal(lista[0].razao_social, null);
  db.close();
});

test('7 e 8. modelos do PDV resolvem empresa sem registro comercial', async () => {
  const db = abrir();
  await empresas(db);
  await run(db, `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo) VALUES (7, '777', 'Sete', 'Sete', 1)`);
  const multipla = await servico.resolverEmpresaDoCanal(db, { codigo: 'PDV' }, multiplas);
  assert.equal(multipla.aplicada, false);
  assert.equal(multipla.motivo, 'PDV_MULTIPLAS');
  const unicaResolvida = await servico.resolverEmpresaDoCanal(
    db,
    { codigo: 'PDV', usuario: { id: 8, role: 'SUPER_ADMIN' } },
    {
      ...unica(7),
      validarEmpresaPdv: async (id) => ({ empresa_id: id })
    }
  );
  assert.equal(unicaResolvida.aplicada, true);
  assert.equal(unicaResolvida.empresa_id, 7);
  assert.equal(await get(db, `SELECT id FROM canais_venda WHERE codigo = 'PDV'`), null);
  db.close();
});

test('9. falha de configuração não impede a listagem', async () => {
  const db = abrir();
  await empresas(db);
  await servico.cadastrarCanal(db, {
    nome: 'Loja', codigo: 'LOJA', tipo_origem: 'Fisica', empresa_id: null, ativo: false
  }, {});
  const lista = await servico.consultarListagemCanais(db, { cfg: { pdv_modelo_empresa: 'QUEBRADO' } });
  assert.equal(lista.canais[0].codigo, 'LOJA');
  assert.equal(lista.avisos.length > 0, true);
  db.close();
});

test('10. falha SQL vira resposta HTTP sem stack', async () => {
  const db = abrir();
  await servico.garantirSchema(db);
  const original = db.all.bind(db);
  db.all = function (sql, params, cb) {
    if (String(sql).includes('ORDER BY')) {
      const err = new Error('SQLITE_ERROR: disk I/O error');
      err.code = 'SQLITE_ERROR';
      cb(err);
      return;
    }
    return original(sql, params, cb);
  };
  const falha = await servico.listarCanais(db, multiplas).then(() => null, (err) => err);
  const http = servico.respostaHttpListagem(falha);
  assert.equal(http.status, 500);
  assert.equal(http.body.code, 'CANAIS_VENDA_LISTAGEM_FALHOU');
  assert.equal(http.body.error, 'Não foi possível carregar os canais de venda.');
  assert.equal(http.body.stack, undefined);
  assert.doesNotMatch(JSON.stringify(http.body), /SQLITE_ERROR|disk I\/O/);
  db.close();
});

test('11. usuário sem autorização não passa do middleware', async () => {
  const databasePath = require.resolve('../../backend/database');
  const cacheAnterior = require.cache[databasePath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: {}
  };
  const authPath = require.resolve('../../backend/middleware/auth');
  delete require.cache[authPath];
  let exigirSuperAdmin;
  try {
    exigirSuperAdmin = require('../../backend/middleware/auth').exigirSuperAdmin;
  } finally {
    delete require.cache[authPath];
    if (cacheAnterior) require.cache[databasePath] = cacheAnterior;
    else delete require.cache[databasePath];
  }
  const negado = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    exigirSuperAdmin({ user: { perfil: 'ADMIN', role: 'admin' } }, res, () => resolve({ status: 200, next: true }));
  });
  assert.equal(negado.status, 403);
  assert.match(JSON.stringify(negado.body), /SUPER_ADMIN/);
  const liberado = await new Promise((resolve) => {
    exigirSuperAdmin({ user: { perfil: 'SUPER_ADMIN' } }, { status() { return this; }, json() {} }, () => resolve(true));
  });
  assert.equal(liberado, true);
  const rota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/configuracoes_avancadas.js'), 'utf8');
  assert.match(rota, /router\.get\('\/canais-venda', exigirSuperAdmin/);
});

test('12 e 13. GET não grava nem cria um registro comercial PDV', async () => {
  const db = abrir();
  await empresas(db);
  await servico.garantirSchema(db);
  const antes = await get(db, `SELECT COUNT(*) AS n FROM canais_venda`);
  const runOriginal = db.run.bind(db);
  let escritasNaLeitura = 0;
  db.run = function (...args) {
    escritasNaLeitura += 1;
    return runOriginal(...args);
  };
  await servico.listarCanais(db, multiplas);
  await servico.listarCanais(db, multiplas);
  db.run = runOriginal;
  const depois = await get(db, `SELECT COUNT(*) AS n FROM canais_venda`);
  assert.equal(depois.n, antes.n);
  assert.equal(escritasNaLeitura, 0);
  assert.equal(await get(db, `SELECT id FROM canais_venda WHERE codigo = 'PDV'`), null);
  db.close();
});

test('14. resposta HTTP e JSON da listagem', async () => {
  const db = abrir();
  await empresas(db);
  await servico.garantirSchema(db);
  const lista = await servico.consultarListagemCanais(db, multiplas);
  assert.ok(Array.isArray(lista.canais));
  assert.ok(Array.isArray(lista.avisos));
  const rota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/configuracoes_avancadas.js'), 'utf8');
  const get = rota.slice(rota.indexOf("router.get('/canais-venda'"), rota.indexOf("router.post('/canais-venda'"));
  assert.match(get, /res\.json\(lista\)/);
  assert.match(get, /console\.error\('\[canais-venda\] GET/);
  assert.match(get, /respostaHttpListagem/);
  assert.doesNotMatch(get, /error: err\.message/);
  const front = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/cds-centro-configuracoes.js'), 'utf8');
  assert.match(front, /btnRecarregarCanaisVenda/);
  assert.match(front, /A listagem não foi carregada/);
  assert.match(front, /dados\.error \|\| dados\.erro/);
  assert.match(front, /Não foi possível carregar as empresas/);
  db.close();
});

test('15. GET HTTP funciona depois da inicialização controlada do banco temporário', async () => {
  const db = abrir();
  await empresas(db);
  await servico.garantirSchema(db);
  db.dbDir = dbDir;
  db.whenReady = (callback) => callback(null);
  const databasePath = require.resolve('../../backend/database');
  const configPath = require.resolve('../../backend/services/configuracaoService');
  const priorDatabaseModule = require.cache[databasePath];
  const priorConfigModule = require.cache[configPath];
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: db
  };
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { readConfig: () => multiplas.cfg }
  };
  const express = require('express');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { perfil: 'SUPER_ADMIN' };
    next();
  });
  app.use(
    '/api/configuracoes-avancadas',
    require('../../backend/rotas/configuracoes_avancadas')
  );
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const resposta = await new Promise((resolve, reject) => {
      http.get({
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/configuracoes-avancadas/canais-venda'
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (parte) => { body += parte; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (err) {
            reject(err);
          }
        });
      }).on('error', reject);
    });
    assert.equal(resposta.status, 200);
    assert.ok(Array.isArray(resposta.body.canais));
    assert.ok(Array.isArray(resposta.body.avisos));
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    db.close();
    if (priorDatabaseModule) require.cache[databasePath] = priorDatabaseModule;
    else delete require.cache[databasePath];
    if (priorConfigModule) require.cache[configPath] = priorConfigModule;
    else delete require.cache[configPath];
  }
});

test.after(async () => {
  fs.rmSync(dbDir, { recursive: true, force: true });
});
