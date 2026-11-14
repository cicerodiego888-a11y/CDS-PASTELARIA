'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const canais = require('../../backend/services/vendas/CanalVendaEmpresaService');
const schema = require('../../backend/services/vendas/canaisVendaSchema');

const databaseModule = require.resolve('../../backend/database');
const root = path.resolve(__dirname, '../..');

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

function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function prepararSchema(db) {
  await executar(db, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY,
    cnpj TEXT,
    razao_social TEXT,
    nome_fantasia TEXT,
    ativo INTEGER NOT NULL DEFAULT 1
  )`);
  await schema.garantirSchemaCanaisVendaAsync(db);
}

function inicializarBancoTemporario(dbDir) {
  const script = `
    const db = require(${JSON.stringify(databaseModule)});
    db.whenReady((err) => {
      if (err) {
        console.error(err.stack || err);
        process.exitCode = 1;
        db.close(() => {});
        return;
      }
      db.get('SELECT COUNT(*) AS total FROM canais_venda', (queryErr, row) => {
        if (queryErr) {
          console.error(queryErr.stack || queryErr);
          process.exitCode = 1;
        } else {
          console.log('CHANNEL_COUNT:' + row.total);
        }
        db.close((closeErr) => {
          if (closeErr) {
            console.error(closeErr.stack || closeErr);
            process.exitCode = 1;
          }
        });
      });
    });
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      DB_DIR: dbDir,
      CDS_BLOQUEAR_BANCO_OFICIAL: '1',
      CDS_ALLOW_OFFICIAL_DB: ''
    }
  });
}

function assertBootCount(result, expected) {
  assert.equal(result.error, undefined, result.error && result.error.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const match = result.stdout.match(/CHANNEL_COUNT:(\d+)/);
  assert.ok(match, `${result.stdout}\n${result.stderr}`);
  assert.equal(Number(match[1]), expected);
}

async function semearCanalPdv(dbDir) {
  const arquivo = path.join(dbDir, 'mercadao.db');
  const db = await new Promise((resolve, reject) => {
    const conexao = new sqlite3.Database(arquivo, (err) => (err ? reject(err) : resolve(conexao)));
  });
  try {
    await executar(db, `CREATE TABLE canais_venda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      codigo TEXT NOT NULL UNIQUE,
      descricao TEXT,
      tipo_origem TEXT NOT NULL,
      empresa_id INTEGER,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    )`);
    await executar(db, `
      INSERT INTO canais_venda
        (id, nome, codigo, descricao, tipo_origem, empresa_id, ativo, criado_em, atualizado_em)
      VALUES (41, 'PDV Legado', 'PDV', 'Preservar', 'PDV', 73, 0, 'antigo', 'antigo')
    `);
  } finally {
    await fecharDb(db);
  }
}

async function salvarConfiguracoesPelaRota(db, configSalva) {
  const configPath = require.resolve('../../backend/services/configuracaoService');
  const routePath = require.resolve('../../backend/rotas/configuracoes_avancadas');
  const authPath = require.resolve('../../backend/middleware/auth');
  const anteriores = new Map([
    [databaseModule, require.cache[databaseModule]],
    [configPath, require.cache[configPath]],
    [routePath, require.cache[routePath]],
    [authPath, require.cache[authPath]]
  ]);
  const configurarCache = (modulePath, exports) => {
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports
    };
  };
  configurarCache(databaseModule, db);
  configurarCache(configPath, {
    validateConfig: () => ({ valid: true, config: {} }),
    saveConfigComValidacaoPdv: async () => configSalva,
    getRecursos: () => ({ recursos: [] })
  });
  delete require.cache[routePath];

  try {
    const router = require(routePath);
    const camada = router.stack.find((item) => item.route
      && item.route.path === '/'
      && item.route.methods.post);
    assert.ok(camada, 'rota de salvamento de configurações encontrada');
    const executarRota = camada.route.stack[camada.route.stack.length - 1].handle;
    const resposta = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await executarRota({ body: {} }, resposta);
    assert.equal(resposta.statusCode, 200);
    return resposta.body;
  } finally {
    for (const [modulePath, anterior] of anteriores) {
      if (anterior) require.cache[modulePath] = anterior;
      else delete require.cache[modulePath];
    }
  }
}

test('1. boot de banco temporário cria o schema sem canais', (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-canais-p12-novo-'));
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));
  const resultado = inicializarBancoTemporario(dbDir);
  assertBootCount(resultado, 0);
  assert.match(resultado.stdout, /BANCO DE TESTE EM USO/);
});

test('2. boots repetidos continuam sem criar canais', (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-canais-p12-reboot-'));
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));
  assertBootCount(inicializarBancoTemporario(dbDir), 0);
  assertBootCount(inicializarBancoTemporario(dbDir), 0);
});

test('3. salvar configurações não cria o canal PDV', async () => {
  const db = await abrirDb();
  try {
    await prepararSchema(db);
    const body = await salvarConfiguracoesPelaRota(db, {
      pdv_modelo_empresa: 'MULTIPLAS',
      pdv_empresa_id: null
    });
    assert.equal(body.success, true);
    assert.equal((await obter(db, 'SELECT COUNT(*) AS total FROM canais_venda')).total, 0);
  } finally {
    await fecharDb(db);
  }
});

test('4. cadastro manual de canal continua funcionando', async () => {
  const db = await abrirDb();
  try {
    await prepararSchema(db);
    await executar(db, `INSERT INTO empresas (id, cnpj, razao_social, ativo)
      VALUES (1, '111', 'Empresa 1', 1)`);
    const canal = await canais.cadastrarCanal(db, {
      nome: 'Loja física',
      codigo: 'LOJA',
      tipo_origem: 'Presencial',
      empresa_id: 1
    });
    assert.equal(canal.codigo, 'LOJA');
    assert.equal(canal.empresa_id, 1);
  } finally {
    await fecharDb(db);
  }
});

test('5. vínculo manual de canal continua funcionando', async () => {
  const db = await abrirDb();
  try {
    await prepararSchema(db);
    await executar(db, `INSERT INTO empresas (id, cnpj, razao_social, ativo)
      VALUES (1, '111', 'Empresa 1', 1)`);
    const canal = await canais.cadastrarCanal(db, {
      nome: 'Canal pendente',
      codigo: 'PENDENTE',
      tipo_origem: 'Outro',
      empresa_id: null,
      ativo: false
    });
    const atualizado = await canais.atualizarVinculo(db, canal.id, {
      empresa_id: 1,
      ativo: true
    });
    assert.equal(atualizado.empresa_id, 1);
    assert.equal(Number(atualizado.ativo), 1);
  } finally {
    await fecharDb(db);
  }
});

test('6. boot e salvamento preservam integralmente um PDV preexistente', async (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-canais-p12-legado-'));
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));
  await semearCanalPdv(dbDir);
  assertBootCount(inicializarBancoTemporario(dbDir), 1);
  const db = await new Promise((resolve, reject) => {
    const conexao = new sqlite3.Database(path.join(dbDir, 'mercadao.db'), (err) => (
      err ? reject(err) : resolve(conexao)
    ));
  });
  try {
    const antes = await obter(db, "SELECT * FROM canais_venda WHERE codigo = 'PDV'");
    await salvarConfiguracoesPelaRota(db, {
      pdv_modelo_empresa: 'UNICA',
      pdv_empresa_id: 9
    });
    assert.deepEqual(await obter(db, "SELECT * FROM canais_venda WHERE codigo = 'PDV'"), antes);
  } finally {
    await fecharDb(db);
  }
});

test('7. MULTIPLAS funciona sem registro comercial PDV', async () => {
  const db = await abrirDb();
  try {
    const resolvido = await canais.resolverEmpresaDoCanal(
      db,
      { codigo: 'PDV' },
      { cfg: { pdv_modelo_empresa: 'MULTIPLAS', pdv_empresa_id: null } }
    );
    assert.equal(resolvido.aplicada, false);
    assert.equal(resolvido.motivo, 'PDV_MULTIPLAS');
    assert.equal((await obter(db, 'SELECT COUNT(*) AS total FROM canais_venda')).total, 0);
  } finally {
    await fecharDb(db);
  }
});

test('8. UNICA resolve pdv_empresa_id sem registro comercial PDV', async () => {
  const db = await abrirDb();
  try {
    await prepararSchema(db);
    await executar(db, `INSERT INTO empresas (id, cnpj, razao_social, ativo)
      VALUES (9, '999', 'Empresa 9', 1)`);
    const resolvido = await canais.resolverEmpresaDoCanal(
      db,
      { codigo: 'PDV', usuario: { id: 1, role: 'SUPER_ADMIN' } },
      {
        cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: 9 },
        validarEmpresaPdv: async (id) => ({ empresa_id: id })
      }
    );
    assert.equal(resolvido.aplicada, true);
    assert.equal(resolvido.empresa_id, 9);
    assert.equal((await obter(db, 'SELECT COUNT(*) AS total FROM canais_venda')).total, 0);
  } finally {
    await fecharDb(db);
  }
});

test('9. resolução de canais personalizados continua funcionando', async () => {
  const db = await abrirDb();
  try {
    await prepararSchema(db);
    await executar(db, `INSERT INTO empresas (id, cnpj, razao_social, ativo)
      VALUES (2, '222', 'Empresa 2', 1)`);
    await canais.cadastrarCanal(db, {
      nome: 'Marketplace',
      codigo: 'APP',
      tipo_origem: 'Marketplace',
      empresa_id: 2
    });
    const resolvido = await canais.resolverEmpresaDoCanal(
      db,
      { codigo: 'APP', usuario: { id: 2, empresas: [2] } }
    );
    assert.equal(resolvido.aplicada, true);
    assert.equal(resolvido.empresa_id, 2);
  } finally {
    await fecharDb(db);
  }
});

test('10. auditoria continua registrando alterações manuais', async () => {
  const db = await abrirDb();
  try {
    await prepararSchema(db);
    await executar(db, `INSERT INTO empresas (id, cnpj, razao_social, ativo)
      VALUES (3, '333', 'Empresa 3', 1)`);
    const canal = await canais.cadastrarCanal(db, {
      nome: 'Antes',
      codigo: 'MANUAL',
      tipo_origem: 'Outro',
      empresa_id: 3
    });
    await canais.atualizarVinculo(db, canal.id, { nome: 'Depois' }, {
      usuario: { id: 17 }
    });
    const evento = await obter(db, `
      SELECT nome_anterior, nome_novo, usuario_id
      FROM canais_venda_auditoria
      WHERE canal_id = ?
      ORDER BY id DESC
      LIMIT 1
    `, [canal.id]);
    assert.deepEqual(evento, {
      nome_anterior: 'Antes',
      nome_novo: 'Depois',
      usuario_id: 17
    });
  } finally {
    await fecharDb(db);
  }
});
