/**
 * CDS-RELEASE-CANAIS-RC01 — homologação final em banco temporário.
 * Não abre o banco oficial.
 *
 * node --test --test-concurrency=1 tests/vendas/canais-release-rc01.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();

const root = path.resolve(__dirname, '../..');
const dbDirPadrao = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rc01-padrao-'));
process.env.DB_DIR = dbDirPadrao;
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const databaseModule = require.resolve('../../backend/database');
const canais = require('../../backend/services/vendas/CanalVendaEmpresaService');
const schema = require('../../backend/services/vendas/canaisVendaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EntradaPedido = require('../../backend/services/pedido/EntradaPedidoService');
const { lerConfigPdvModelo } = require('../../backend/services/pdv/PdvModeloEmpresaService');

const admin = { id: 1, role: 'admin', perfil: 'SUPER_ADMIN' };

function abrir() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
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

function fechar(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function prepararBase() {
  const db = await abrir();
  await garantirSchemaEmpresasAsync(db);
  await schema.garantirSchemaCanaisVendaAsync(db);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER,
    origem_canal TEXT,
    total REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER,
    pedido_id INTEGER,
    total REAL DEFAULT 0
  )`);
  return db;
}

function bootTemporario(dbDir) {
  const script = `
    const db = require(${JSON.stringify(databaseModule)});
    db.whenReady((err) => {
      if (err) { console.error(err.stack || err); process.exitCode = 1; return db.close(() => {}); }
      const checks = [];
      const q = (sql, label) => new Promise((resolve, reject) => {
        db.get(sql, (e, row) => (e ? reject(e) : resolve({ label, row })));
      });
      Promise.all([
        q("SELECT name FROM sqlite_master WHERE type='table' AND name='canais_venda'", 'tabela'),
        q("SELECT name FROM sqlite_master WHERE type='table' AND name='canais_venda_auditoria'", 'auditoria'),
        q("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_canais_venda_codigo'", 'indice'),
        q('SELECT COUNT(*) AS n FROM canais_venda', 'canais'),
        q("SELECT COUNT(*) AS n FROM empresas", 'empresas')
      ]).then((rows) => {
        rows.forEach((item) => {
          if (item.label === 'tabela' || item.label === 'auditoria' || item.label === 'indice') {
            console.log('OK_' + item.label.toUpperCase() + ':' + (item.row && item.row.name ? 1 : 0));
          } else {
            console.log('COUNT_' + item.label.toUpperCase() + ':' + item.row.n);
          }
        });
      }).catch((e) => {
        console.error(e.stack || e);
        process.exitCode = 1;
      }).finally(() => db.close(() => {}));
    });
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      DB_DIR: dbDir,
      CDS_BLOQUEAR_BANCO_OFICIAL: '1',
      CDS_ALLOW_OFFICIAL_DB: ''
    }
  });
}

test('RC01-1 banco novo: schema sem seeds comerciais', (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rc01-novo-'));
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));
  const r = bootTemporario(dbDir);
  assert.equal(r.error, undefined, r.error && r.error.message);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /BANCO DE TESTE EM USO/);
  assert.match(r.stdout, /OK_TABELA:1/);
  assert.match(r.stdout, /OK_AUDITORIA:1/);
  assert.match(r.stdout, /OK_INDICE:1/);
  assert.match(r.stdout, /COUNT_CANAIS:0/);
  assert.match(r.stdout, /COUNT_EMPRESAS:0/);
  assert.equal(fs.existsSync(path.join(dbDir, 'mercadao.db')), true);
});

test('RC01-2 banco existente: migração preserva dados e não cria PDV', async (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-rc01-legado-'));
  t.after(() => fs.rmSync(dbDir, { recursive: true, force: true }));
  const arquivo = path.join(dbDir, 'mercadao.db');
  const db0 = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(arquivo, (err) => (err ? reject(err) : resolve(c)));
  });
  await run(db0, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY, cnpj TEXT, razao_social TEXT, nome_fantasia TEXT, ativo INTEGER DEFAULT 1
  )`);
  await run(db0, `INSERT INTO empresas VALUES (11,'11222333000181','Razão A','Loja A',1)`);
  await run(db0, `CREATE TABLE canais_venda (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT NOT NULL UNIQUE,
    empresa_id INTEGER
  )`);
  await run(db0, `INSERT INTO canais_venda (id, nome, codigo, empresa_id) VALUES (7,'iFood','IFOOD',11)`);
  await fechar(db0);

  const boot = bootTemporario(dbDir);
  assert.equal(boot.status, 0, `${boot.stdout}\n${boot.stderr}`);
  assert.match(boot.stdout, /COUNT_CANAIS:1/);
  assert.match(boot.stdout, /COUNT_EMPRESAS:1/);

  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(arquivo, (err) => (err ? reject(err) : resolve(c)));
  });
  const colunas = (await all(db, 'PRAGMA table_info(canais_venda)')).map((c) => c.name);
  ['descricao', 'tipo_origem', 'ativo', 'criado_em', 'atualizado_em'].forEach((nome) => {
    assert.equal(colunas.includes(nome), true, nome);
  });
  const canal = await get(db, "SELECT * FROM canais_venda WHERE codigo='IFOOD'");
  assert.equal(canal.id, 7);
  assert.equal(canal.empresa_id, 11);
  assert.equal(await get(db, "SELECT id FROM canais_venda WHERE codigo='PDV'"), null);
  assert.equal((await get(db, 'SELECT cnpj FROM empresas WHERE id=11')).cnpj, '11222333000181');
  await canais.atualizarVinculo(db, 7, { empresa_id: 11, nome: 'iFood Atual' }, { usuario: admin });
  assert.equal((await get(db, "SELECT nome, empresa_id FROM canais_venda WHERE codigo='IFOOD'")).nome, 'iFood Atual');
  assert.equal((await get(db, "SELECT empresa_id FROM canais_venda WHERE codigo='IFOOD'")).empresa_id, 11);
  assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM canais_venda')).n, 1);
  assert.equal(await get(db, "SELECT id FROM canais_venda WHERE codigo='PDV'"), null);
  await fechar(db);
});

test('RC01-3 homologação do módulo: empresa, canal, vínculo, histórico e permissões', async () => {
  const db = await prepararBase();
  const empresa = await EmpresaService.criarEmpresa({
    cnpj: '11222333000181',
    razao_social: 'Matriz RC01',
    nome_fantasia: 'Matriz'
  }, { db });
  const editada = await EmpresaService.atualizarEmpresa(empresa.id, {
    nome_fantasia: 'Matriz Atualizada'
  }, { db });
  assert.equal(editada.nome_fantasia, 'Matriz Atualizada');

  await assert.rejects(
    () => canais.cadastrarCanal(db, {
      nome: 'Solto', codigo: 'SOLTO', tipo_origem: 'Outro', ativo: true
    }, { usuario: admin }),
    (err) => err.code === 'CANAL_SEM_EMPRESA' && err.statusCode === 409
  );

  const inativa = await EmpresaService.criarEmpresa({
    cnpj: '04252011000110',
    razao_social: 'Inativa',
    nome_fantasia: 'Inativa'
  }, { db });
  await run(db, 'UPDATE empresas SET ativo = 0 WHERE id = ?', [inativa.id]);
  await assert.rejects(
    () => canais.cadastrarCanal(db, {
      nome: 'Parado', codigo: 'PARADO', tipo_origem: 'Outro', empresa_id: inativa.id
    }, { usuario: admin }),
    (err) => err.code === 'EMPRESA_INATIVA' && err.statusCode === 409
  );

  const canal = await canais.cadastrarCanal(db, {
    nome: 'WhatsApp',
    codigo: 'whatsapp',
    tipo_origem: 'Mensagem',
    descricao: 'Inicial',
    empresa_id: empresa.id
  }, { usuario: admin });
  assert.equal(canal.codigo, 'WHATSAPP');

  const editado = await canais.atualizarVinculo(db, canal.id, {
    nome: 'WhatsApp Business',
    descricao: 'Canal oficial',
    tipo_origem: 'Mensagem'
  }, { usuario: admin });
  assert.equal(editado.nome, 'WhatsApp Business');

  const outra = await EmpresaService.criarEmpresa({
    cnpj: '27865757000102',
    razao_social: 'Filial',
    nome_fantasia: 'Filial'
  }, { db });
  const vinculado = await canais.atualizarVinculo(db, canal.id, { empresa_id: outra.id }, { usuario: admin });
  assert.equal(vinculado.empresa_id, outra.id);

  const inativado = await canais.atualizarVinculo(db, canal.id, { ativo: false }, { usuario: admin });
  assert.equal(Number(inativado.ativo), 0);
  const reativado = await canais.atualizarVinculo(db, canal.id, { ativo: true }, { usuario: admin });
  assert.equal(Number(reativado.ativo), 1);

  const historico = await canais.consultarHistoricoCanal(db, canal.id);
  assert.ok(historico.length >= 3);

  await assert.rejects(
    () => canais.resolverEmpresaDoCanal(db, {
      canalId: canal.id,
      usuario: { id: 9, empresas: [empresa.id] }
    }, {}),
    (err) => err.code === 'CANAL_USUARIO_SEM_AUTORIZACAO' && err.statusCode === 403
  );

  const { exigirSuperAdmin } = (() => {
    const databasePath = require.resolve('../../backend/database');
    const authPath = require.resolve('../../backend/middleware/auth');
    const prev = require.cache[databasePath];
    require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: {} };
    delete require.cache[authPath];
    try {
      return require('../../backend/middleware/auth');
    } finally {
      delete require.cache[authPath];
      if (prev) require.cache[databasePath] = prev;
      else delete require.cache[databasePath];
    }
  })();
  const negado = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    exigirSuperAdmin({ user: { perfil: 'OPERADOR' } }, res, () => resolve({ status: 200 }));
  });
  assert.equal(negado.status, 403);

  await fechar(db);
});

test('RC01-4 pedidos e vendas: resolução do canal sem emissão fiscal', async () => {
  const db = await prepararBase();
  await run(db, `CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY, username TEXT, role TEXT, perfil TEXT
  )`);
  const empresa = await EmpresaService.criarEmpresa({
    cnpj: '11222333000181',
    razao_social: 'Comercial',
    nome_fantasia: 'Comercial'
  }, { db });
  const outra = await EmpresaService.criarEmpresa({
    cnpj: '04252011000110',
    razao_social: 'Outra',
    nome_fantasia: 'Outra'
  }, { db });
  const canal = await canais.cadastrarCanal(db, {
    nome: 'App', codigo: 'APP', tipo_origem: 'Aplicativo', empresa_id: empresa.id
  }, { usuario: admin });

  const ok = await canais.resolverEmpresaDoCanal(db, {
    codigo: 'APP', usuario: admin
  }, {});
  assert.equal(ok.empresa_id, empresa.id);

  await assert.rejects(
    () => EntradaPedido.receber({
      canal: EntradaPedido.CanalOrigem.EQUIPE,
      canalVendaCodigo: 'APP',
      empresaId: outra.id,
      usuario: admin,
      chaveIdempotencia: 'rc01-div',
      body: { itens: [] },
      db
    }),
    (err) => err.codigo === 'CANAL_EMPRESA_DIVERGENTE' && err.statusCode === 409
  );

  await canais.atualizarVinculo(db, canal.id, { ativo: false }, { usuario: admin });
  await assert.rejects(
    () => canais.resolverEmpresaDoCanal(db, { codigo: 'APP', usuario: admin }, {}),
    (err) => err.code === 'CANAL_INATIVO' && err.statusCode === 409
  );
  await assert.rejects(
    () => canais.resolverEmpresaDoCanal(db, { codigo: 'INEXISTENTE', usuario: admin }, {}),
    (err) => err.code === 'CANAL_INEXISTENTE'
  );

  await canais.atualizarVinculo(db, canal.id, { ativo: true, empresa_id: empresa.id }, { usuario: admin });
  await run(db, 'UPDATE empresas SET ativo = 0 WHERE id = ?', [empresa.id]);
  await assert.rejects(
    () => canais.resolverEmpresaDoCanal(db, { codigo: 'APP', usuario: admin }, {}),
    (err) => err.code === 'EMPRESA_INATIVA' && err.statusCode === 409
  );

  await run(db, 'INSERT INTO pedidos (id, empresa_id, origem_canal) VALUES (90, ?, ?)', [empresa.id, 'APP']);
  await run(db, 'INSERT INTO vendas (id, empresa_id, pedido_id, total) VALUES (90, ?, 90, 41.5)', [empresa.id]);
  await canais.atualizarVinculo(db, canal.id, { empresa_id: outra.id }, { usuario: admin });
  assert.equal((await get(db, 'SELECT empresa_id FROM pedidos WHERE id=90')).empresa_id, empresa.id);
  assert.equal((await get(db, 'SELECT empresa_id, total FROM vendas WHERE id=90')).empresa_id, empresa.id);

  await fechar(db);
});

test('RC01-5 regressão PDV MULTIPLAS e UNICA sem registro comercial', async () => {
  const db = await prepararBase();
  const empresa = await EmpresaService.criarEmpresa({
    cnpj: '11222333000181',
    razao_social: 'PDV RC',
    nome_fantasia: 'PDV RC'
  }, { db });

  const multiplas = await canais.resolverEmpresaDoCanal(db, { codigo: 'PDV', usuario: admin }, {
    cfg: { pdv_modelo_empresa: 'MULTIPLAS', pdv_empresa_id: empresa.id }
  });
  assert.equal(multiplas.aplicada, false);
  assert.equal(multiplas.motivo, 'PDV_MULTIPLAS');
  assert.equal(multiplas.pdv_empresa_id, empresa.id);

  const unica = await canais.resolverEmpresaDoCanal(db, { codigo: 'PDV', usuario: admin }, {
    cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: empresa.id },
    validarEmpresaPdv: async (id) => ({ empresa_id: id })
  });
  assert.equal(unica.aplicada, true);
  assert.equal(unica.empresa_id, empresa.id);
  assert.equal(unica.pdv_empresa_id, empresa.id);
  assert.equal((await get(db, 'SELECT COUNT(*) AS n FROM canais_venda')).n, 0);

  const cfg = lerConfigPdvModelo({
    cfg: { pdv_modelo_empresa: 'UNICA', pdv_empresa_id: empresa.id }
  });
  assert.equal(cfg.pdv_modelo_empresa, 'UNICA');
  assert.equal(cfg.pdv_empresa_id, empresa.id);

  await fechar(db);
});

test('RC01-6 auditoria do instalador e da UI', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.3');
  assert.match(pkg.scripts['build:erp'], /build-erp-oficial/);
  assert.match(pkg.scripts.release, /run-release/);

  const erp = JSON.parse(fs.readFileSync(path.join(root, 'electron-builder-erp.json'), 'utf8'));
  assert.equal(erp.directories.output, 'dist/erp');
  assert.ok(erp.files.includes('!tests/**'));
  assert.ok(erp.files.includes('!dados/**'));
  assert.ok(erp.files.includes('!scripts/**'));
  assert.match(erp.nsis.artifactName, /CDS-ERP-Setup-\$\{version\}/);

  const common = fs.readFileSync(path.join(root, 'electron-common.js'), 'utf8');
  assert.match(common, /ProgramData/);
  assert.match(common, /MercantilFiscal/);
  assert.match(common, /dados/);
  assert.doesNotMatch(common, /c:\\\\projetos\\\\CDS-SISTEMAS PASTELARIA\\\\dados/i);

  const front = fs.readFileSync(path.join(root, 'frontend/erp/js/cds-centro-configuracoes.js'), 'utf8');
  assert.match(front, /empresasCanalVenda/);
  assert.match(front, /btnRecarregarCanaisVenda/);
  assert.match(front, /data-canal-historico/);
  assert.match(front, /A listagem não foi carregada/);
  assert.match(front, /canaisVendaAlerta/);

  const dist = path.join(root, 'dist', 'erp');
  const setup = fs.existsSync(dist)
    ? fs.readdirSync(dist).filter((nome) => /^CDS-ERP-Setup-.*\.exe$/i.test(nome))
    : [];
  assert.ok(Array.isArray(setup));
});
