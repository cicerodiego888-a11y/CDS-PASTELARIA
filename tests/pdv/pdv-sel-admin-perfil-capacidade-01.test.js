/**
 * Regressão: ADMIN/SUPER_ADMIN não podem ser tratados como operador restrito
 * só porque a capacidade recebeu usuarioId numérico (sem objeto req.user).
 *
 *   node --test tests/pdv/pdv-sel-admin-perfil-capacidade-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pdv-sel-admin-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const {
  avaliarSelecaoEmpresaPdv
} = require('../../backend/services/vendas/SelecaoEmpresaVendaPdvService');
const { CODIGOS_BLOQUEIO } = require('../../backend/motores/muv/capacidade/selecionarEmpresaCapacidade');

const CNPJ_MATRIZ = '11222333000181';
const CNPJ_FILIAL_B = '11222333000262';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      ativo INTEGER DEFAULT 1,
      unidade TEXT DEFAULT 'UN',
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      utiliza_ficha_tecnica INTEGER DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  await run(db, `
    CREATE TABLE usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      role TEXT,
      perfil TEXT,
      ativo INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE usuario_empresas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1
    )
  `);

  const matriz = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_MATRIZ, razao_social: 'Matriz' },
    { db }
  );
  const filialB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_FILIAL_B, razao_social: 'Filial B' },
    { db }
  );

  const admin = await run(db, `
    INSERT INTO usuarios (username, role, perfil, ativo)
    VALUES ('diego2', 'operador', 'ADMIN', 1)
  `);

  // Vínculo só na filial SEM estoque — antes do fix isso bloqueava o ADMIN.
  await run(db, `
    INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo)
    VALUES (?, ?, 1)
  `, [admin.lastID, filialB.id]);

  const prod = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, controla_estoque, utiliza_ficha_tecnica)
    VALUES ('Pastel', 'INSUMO', 1, 0)
  `);
  // Estoque só na matriz (empresa que o vínculo do Admin NÃO inclui).
  await EstoqueEmpresaService.criarRegistro({
    produtoId: prod.lastID,
    empresaId: matriz.id,
    saldo_fiscal: 20,
    saldo_nao_fiscal: 20,
    estoque_atual: 40
  }, { db });

  return { db, matriz, filialB, usuarioId: admin.lastID, produtoId: prod.lastID };
}

describe('PDV-SEL admin perfil capacidade', () => {
  it('ADMIN com objeto usuario enxerga todas as empresas (como SUPER_ADMIN)', async () => {
    const { db, matriz, usuarioId, produtoId } = await setup();
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId, quantidade: 2 }],
      body: { emitir_fiscal: false },
      usuarioId,
      usuario: { id: usuarioId, role: 'operador', perfil: 'ADMIN' }
    }, { db, verificarFiscalValido: async () => true });

    assert.equal(out.bloqueio, null);
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('ADMIN só com usuarioId numérico hidrata perfil no banco e não fica preso ao vínculo', async () => {
    const { db, matriz, usuarioId, produtoId } = await setup();
    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId, quantidade: 2 }],
      body: { emitir_fiscal: false },
      usuarioId
    }, { db, verificarFiscalValido: async () => true });

    assert.equal(out.bloqueio, null);
    assert.equal(out.selecionada.empresaId, matriz.id);
    await closeDb(db);
  });

  it('operador comum continua restrito aos vínculos', async () => {
    const { db, filialB, produtoId } = await setup();
    const op = await run(db, `
      INSERT INTO usuarios (username, role, perfil, ativo)
      VALUES ('op1', 'operador', 'USUARIO', 1)
    `);
    await run(db, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo)
      VALUES (?, ?, 1)
    `, [op.lastID, filialB.id]);

    const out = await avaliarSelecaoEmpresaPdv({
      itens: [{ produtoId, quantidade: 2 }],
      body: { emitir_fiscal: false },
      usuarioId: op.lastID,
      usuario: { id: op.lastID, role: 'operador', perfil: 'USUARIO' }
    }, { db, verificarFiscalValido: async () => true });

    assert.ok(out.bloqueio);
    assert.equal(out.bloqueio.codigo, CODIGOS_BLOQUEIO.NENHUMA_EMPRESA_ATENDE);
    await closeDb(db);
  });

  it('listarEmpresasPermitidas com ID de ADMIN retorna empresas ativas', async () => {
    const { db, matriz, filialB, usuarioId } = await setup();
    const lista = await UsuarioEmpresaService.listarEmpresasPermitidas(usuarioId, { db });
    const ids = lista.map((e) => Number(e.id)).sort((a, b) => a - b);
    assert.deepEqual(ids, [matriz.id, filialB.id].sort((a, b) => a - b));
    await closeDb(db);
  });
});
