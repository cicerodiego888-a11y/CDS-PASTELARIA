/**
 * Operador sem usuario_empresas não obtém X-Empresa-Id no PDV/Caixa.
 * Cadastro deve assegurar vínculos com empresas ativas.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/empresas/operador-vinculo-empresas-auto.test.js
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-op-vinculo-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(dbDir, 'test.db'), (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

describe('Operador — auto vínculo empresas', { concurrency: false }, () => {
  let db;

  before(async () => {
    db = await openDb();
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY,
        username TEXT,
        password_hash TEXT,
        role TEXT,
        nome TEXT,
        perfil TEXT,
        ativo INTEGER DEFAULT 1
      )`
    );
    await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Matriz Teste', nome_fantasia: 'Matriz' },
      { db }
    );
    await EmpresaService.criarEmpresa(
      { cnpj: '11222333000262', razao_social: 'Filial Teste', nome_fantasia: 'Filial' },
      { db }
    );
    await run(
      db,
      `INSERT INTO usuarios (id, username, password_hash, role, nome, perfil, ativo)
       VALUES (50, 'operadora', 'x', 'operador', 'Operadora', 'USUARIO', 1)`
    );
  });

  after(async () => {
    await new Promise((resolve) => db.close(() => resolve()));
  });

  it('assegurarVinculosEmpresasAtivas cria vínculos para todas as empresas ativas', async () => {
    const antes = await all(db, 'SELECT * FROM usuario_empresas WHERE usuario_id = 50');
    assert.equal(antes.length, 0);

    const vinculados = await UsuarioEmpresaService.assegurarVinculosEmpresasAtivas(50, { db });
    assert.equal(vinculados.length, 2);

    const permitidas = await UsuarioEmpresaService.listarEmpresasPermitidas(
      { id: 50, role: 'operador', perfil: 'USUARIO' },
      { db }
    );
    assert.equal(permitidas.length, 2);

    // idempotente
    const novamente = await UsuarioEmpresaService.assegurarVinculosEmpresasAtivas(50, { db });
    assert.equal(novamente.length, 2);
    const total = await all(db, 'SELECT * FROM usuario_empresas WHERE usuario_id = 50');
    assert.equal(total.length, 2);
  });

  it('auth.js garante vínculo em cadastro, atualização, reativação e login', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/auth.js'),
      'utf8'
    );
    assert.match(src, /assegurarVinculosEmpresasAtivas/);
    assert.match(src, /garantirAcessoEmpresarialMinimo/);
    assert.match(src, /finalizarLoginComUsuario/);
    assert.match(src, /usuarios\/:id\/ativar[\s\S]*assegurarVinculosEmpresasAtivas/);
  });

  it('garantirAcessoEmpresarialMinimo cura usuário sem vínculo e respeita quem já tem', async () => {
    await run(
      db,
      `INSERT INTO usuarios (id, username, password_hash, role, nome, perfil, ativo)
       VALUES (51, 'semvinculo', 'x', 'operador', 'Sem Vínculo', 'USUARIO', 1)`
    );
    const cura = await UsuarioEmpresaService.garantirAcessoEmpresarialMinimo(
      { id: 51, role: 'operador', perfil: 'USUARIO' },
      { db }
    );
    assert.equal(cura.healed, true);
    assert.equal(cura.empresas.length, 2);

    const deNovo = await UsuarioEmpresaService.garantirAcessoEmpresarialMinimo(
      { id: 51, role: 'operador', perfil: 'USUARIO' },
      { db }
    );
    assert.equal(deNovo.healed, false);
    assert.equal(deNovo.empresas.length, 2);
  });

  it('listarEmpresasDisponiveis auto-cura operador sem vínculo', async () => {
    await run(
      db,
      `INSERT INTO usuarios (id, username, password_hash, role, nome, perfil, ativo)
       VALUES (52, 'legado', 'x', 'operador', 'Legado', 'USUARIO', 1)`
    );
    const lista = await EmpresaService.listarEmpresasDisponiveis({
      db,
      user: { id: 52, role: 'operador', perfil: 'USUARIO' }
    });
    assert.equal(lista.length, 2);
    const vinculos = await all(db, 'SELECT * FROM usuario_empresas WHERE usuario_id = 52');
    assert.equal(vinculos.length, 2);
  });
});
