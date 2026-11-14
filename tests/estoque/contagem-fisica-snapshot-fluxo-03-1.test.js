/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03.1
 * Integração preview → snapshot → confirmação oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-snapshot-fluxo-03-1.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-snap-03-1-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const {
  exigirSnapshotItensOficiais,
  montarItemConfirmacaoApartirDoPreview
} = require('../../backend/services/estoque/contagemFisicaSnapshotOficial');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

require('../../frontend/erp/js/contagem-estoque.js');
const ui = globalThis.__cdsContagemEstoqueTest;

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
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
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, saldoF = 0, saldoNf = 0) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, 'UN', ?, ?, ?)`,
    [nome, saldoF, saldoNf, saldoF + saldoNf]
  );
  return ins.lastID;
}

async function espelhar(db, produtoId, empresaId, saldoF, saldoNf) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoF,
    saldo_nao_fiscal: saldoNf,
    estoque_atual: saldoF + saldoNf
  }, { db });
}

function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

/** Simula a fronteira oficial da API (exigir snapshot + registrar). */
async function confirmarOficial(db, empresaId, itens, chave) {
  const itensOk = exigirSnapshotItensOficiais(itens);
  return EstoqueContagemFisicaService.registrarContagemFisica({
    db,
    empresaId,
    itens: itensOk,
    chaveIdempotencia: chave || null,
    usuarioId: 1,
    usuarioNome: 'op'
  });
}

describe('CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03.1', { concurrency: false }, () => {
  it('01 preview devolve os dois saldos esperados', async () => {
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'P1', 24, 6);
    await espelhar(db, pid, empresaA.id, 24, 6);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 20,
      quantidade_nao_fiscal_contada: 5
    });
    assert.equal(preview.empresa_id, empresaA.id);
    assert.equal(preview.produto_id, pid);
    assert.equal(preview.saldo_fiscal_esperado, 24);
    assert.equal(preview.saldo_nao_fiscal_esperado, 6);
    assert.equal(preview.saldo_fiscal_anterior, 24);
    assert.equal(preview.saldo_nao_fiscal_anterior, 6);
    await closeDb(db);
  });

  it('02 UI/API preserva o snapshot recebido do preview', async () => {
    assert.ok(ui && typeof ui.snapshotDaLinha === 'function');
    const preview = {
      produto_id: 9,
      empresa_id: 3,
      saldo_fiscal_esperado: 100,
      saldo_nao_fiscal_esperado: 0,
      saldo_fiscal_anterior: 100,
      saldo_nao_fiscal_anterior: 0,
      quantidade_fiscal_contada: 80,
      quantidade_nao_fiscal_contada: 0,
      diferenca_fiscal: -20,
      diferenca_nao_fiscal: 0
    };
    const linha = ui.snapshotDaLinha(preview);
    assert.equal(linha.saldo_fiscal_esperado, 100);
    assert.equal(linha.saldo_nao_fiscal_esperado, 0);
    assert.equal(linha.quantidade_fiscal_contada, 80);
    // Não troca snapshot pela quantidade física.
    assert.notEqual(linha.saldo_fiscal_esperado, linha.quantidade_fiscal_contada);
  });

  it('03 confirmação envia os valores originais do preview', async () => {
    const preview = {
      produto_id: 4,
      empresa_id: 1,
      saldo_fiscal_esperado: 50,
      saldo_nao_fiscal_esperado: 10,
      saldo_fiscal_anterior: 50,
      saldo_nao_fiscal_anterior: 10,
      quantidade_fiscal_contada: 40,
      quantidade_nao_fiscal_contada: 8,
      diferenca_fiscal: -10,
      diferenca_nao_fiscal: -2
    };
    const linha = ui.snapshotDaLinha(preview);
    const item = ui.itemConfirmacao(linha);
    assert.deepEqual(item, {
      produto_id: 4,
      quantidade_fiscal_contada: 40,
      quantidade_nao_fiscal_contada: 8,
      saldo_fiscal_esperado: 50,
      saldo_nao_fiscal_esperado: 10
    });
    const viaHelper = montarItemConfirmacaoApartirDoPreview(preview);
    assert.equal(viaHelper.saldo_fiscal_esperado, 50);
    assert.equal(viaHelper.saldo_nao_fiscal_esperado, 10);
  });

  it('04 confirmação oficial sem snapshot → SNAPSHOT_OBRIGATORIO', () => {
    assert.throws(
      () => exigirSnapshotItensOficiais([{
        produto_id: 1,
        quantidade_fiscal_contada: 5,
        quantidade_nao_fiscal_contada: 0
      }]),
      (err) => err && err.code === 'SNAPSHOT_OBRIGATORIO' && err.status === 400
    );
  });

  it('05 snapshot fiscal ausente é rejeitado', () => {
    assert.throws(
      () => exigirSnapshotItensOficiais([{
        produto_id: 1,
        quantidade_fiscal_contada: 1,
        quantidade_nao_fiscal_contada: 0,
        saldo_nao_fiscal_esperado: 0
      }]),
      (err) => err && err.code === 'SNAPSHOT_OBRIGATORIO'
    );
  });

  it('06 snapshot não fiscal ausente é rejeitado', () => {
    assert.throws(
      () => exigirSnapshotItensOficiais([{
        produto_id: 1,
        quantidade_fiscal_contada: 1,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: 10
      }]),
      (err) => err && err.code === 'SNAPSHOT_OBRIGATORIO'
    );
  });

  it('07 snapshot com valor zero é aceito', async () => {
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'Zero', 0, 0);
    await espelhar(db, pid, empresaA.id, 0, 0);
    const out = await confirmarOficial(db, empresaA.id, [{
      produto_id: pid,
      quantidade_fiscal_contada: 0,
      quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 0,
      saldo_nao_fiscal_esperado: 0
    }], 'zero-7');
    assert.ok(out.id > 0);
    assert.equal(out.itens[0].diferenca_fiscal, 0);
    await closeDb(db);
  });

  it('08 snapshot inválido é rejeitado', () => {
    assert.throws(
      () => exigirSnapshotItensOficiais([{
        produto_id: 1,
        quantidade_fiscal_contada: 1,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: -1,
        saldo_nao_fiscal_esperado: 0
      }]),
      (err) => err && err.code === 'SNAPSHOT_INVALIDO'
    );
    assert.throws(
      () => exigirSnapshotItensOficiais([{
        produto_id: 1,
        quantidade_fiscal_contada: 1,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: 'abc',
        saldo_nao_fiscal_esperado: 0
      }]),
      (err) => err && err.code === 'SNAPSHOT_INVALIDO'
    );
  });

  it('09 snapshot de outro produto é rejeitado (desatualizado)', async () => {
    const { db, empresaA } = await setup();
    const pa = await criarProduto(db, 'A', 100, 0);
    const pb = await criarProduto(db, 'B', 50, 0);
    await espelhar(db, pa, empresaA.id, 100, 0);
    await espelhar(db, pb, empresaA.id, 50, 0);
    const previewA = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pa,
      quantidade_fiscal_contada: 90,
      quantidade_nao_fiscal_contada: 0
    });
    await assert.rejects(
      () => confirmarOficial(db, empresaA.id, [{
        produto_id: pb,
        quantidade_fiscal_contada: 40,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: previewA.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: previewA.saldo_nao_fiscal_esperado
      }], 'outro-prod-9'),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal(Number((await ee(db, pb, empresaA.id)).saldo_fiscal), 50);
    await closeDb(db);
  });

  it('10 snapshot de outra empresa é rejeitado', async () => {
    const { db, empresaA, empresaB } = await setup();
    const pid = await criarProduto(db, 'Shared', 100, 0);
    await espelhar(db, pid, empresaA.id, 100, 0);
    await espelhar(db, pid, empresaB.id, 70, 0);
    const previewA = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 90,
      quantidade_nao_fiscal_contada: 0
    });
    await assert.rejects(
      () => confirmarOficial(db, empresaB.id, [{
        produto_id: pid,
        quantidade_fiscal_contada: 60,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: previewA.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: previewA.saldo_nao_fiscal_esperado
      }], 'outra-emp-10'),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal(Number((await ee(db, pid, empresaB.id)).saldo_fiscal), 70);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 100);
    await closeDb(db);
  });

  it('11 alteração após preview → CONTAGEM_DESATUALIZADA', async () => {
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'Conc', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 10000,
      quantidade_nao_fiscal_contada: 0
    });
    await confirmarOficial(db, empresaA.id, [montarItemConfirmacaoApartirDoPreview(preview)], 'p1');
    await assert.rejects(
      () => confirmarOficial(db, empresaA.id, [{
        produto_id: pid,
        quantidade_fiscal_contada: 12000,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: preview.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: preview.saldo_nao_fiscal_esperado
      }], 'p2'),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA' && err.status === 409
    );
    await closeDb(db);
  });

  it('12 conflito não gera ajuste nem confirmação', async () => {
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'NoAdj', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    await confirmarOficial(db, empresaA.id, [{
      produto_id: pid,
      quantidade_fiscal_contada: 10000,
      quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0
    }], 'c1');
    try {
      await confirmarOficial(db, empresaA.id, [{
        produto_id: pid,
        quantidade_fiscal_contada: 12000,
        quantidade_nao_fiscal_contada: 0,
        saldo_fiscal_esperado: 24000,
        saldo_nao_fiscal_esperado: 0
      }], 'c2');
      assert.fail('deveria falhar');
    } catch (err) {
      assert.equal(err.code, 'CONTAGEM_DESATUALIZADA');
    }
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 10000);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque')).n), 1);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas')).n), 1);
    await closeDb(db);
  });

  it('13 interface não repete automaticamente confirmação desatualizada', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/erp/js/contagem-estoque.js'),
      'utf8'
    );
    assert.match(src, /CONTAGEM_DESATUALIZADA/);
    assert.match(src, /marcarDesatualizada/);
    assert.match(src, /Atualizar pré-visualização|atualizarPreviewsDaLista/);
    // Não deve haver loop de reenvio automático após 409.
    assert.equal(/CONTAGEM_DESATUALIZADA[\s\S]{0,400}confirmar\s*\(/.test(src), false);
    assert.match(src, /Não gera nova chave nem reenvia automaticamente/);
  });

  it('14 novo preview permite nova confirmação', async () => {
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'Retry', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    await confirmarOficial(db, empresaA.id, [{
      produto_id: pid,
      quantidade_fiscal_contada: 10000,
      quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 24000,
      saldo_nao_fiscal_esperado: 0
    }], 'np-1');
    const novoPreview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 12000,
      quantidade_nao_fiscal_contada: 0
    });
    assert.equal(novoPreview.saldo_fiscal_esperado, 10000);
    const out = await confirmarOficial(
      db,
      empresaA.id,
      [montarItemConfirmacaoApartirDoPreview(novoPreview)],
      'np-2'
    );
    assert.equal(out.itens[0].diferenca_fiscal, 2000);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 12000);
    await closeDb(db);
  });

  it('15 reenvio com mesma chave não duplica ajustes', async () => {
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'Idem', 10, 0);
    await espelhar(db, pid, empresaA.id, 10, 0);
    const itens = [{
      produto_id: pid,
      quantidade_fiscal_contada: 8,
      quantidade_nao_fiscal_contada: 0,
      saldo_fiscal_esperado: 10,
      saldo_nao_fiscal_esperado: 0
    }];
    const a = await confirmarOficial(db, empresaA.id, itens, 'idem-15');
    const b = await confirmarOficial(db, empresaA.id, itens, 'idem-15');
    assert.equal(a.id, b.id);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque')).n), 1);
    await closeDb(db);
  });

  it('16 fluxo interno/legado sem snapshot continua no serviço', async () => {
    // Compatibilidade do serviço (testes CDS-ESTOQUE-MANUAL-01) — sem fronteira oficial.
    const { db, empresaA } = await setup();
    const pid = await criarProduto(db, 'Legado', 10, 5);
    await espelhar(db, pid, empresaA.id, 10, 5);
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      itens: [{
        produto_id: pid,
        quantidade_fiscal_contada: 9,
        quantidade_nao_fiscal_contada: 5
      }]
    });
    assert.ok(out.id > 0);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 9);
    // Fronteira oficial continua bloqueando o mesmo payload.
    assert.throws(
      () => exigirSnapshotItensOficiais([{
        produto_id: pid,
        quantidade_fiscal_contada: 9,
        quantidade_nao_fiscal_contada: 5
      }]),
      (err) => err && err.code === 'SNAPSHOT_OBRIGATORIO'
    );
    await closeDb(db);
  });

  it('17 rollback preserva saldos e histórico', async () => {
    const { db, empresaA } = await setup();
    const p1 = await criarProduto(db, 'Ok', 20, 0);
    const p2 = await criarProduto(db, 'Outro', 30, 0);
    await espelhar(db, p1, empresaA.id, 20, 0);
    await espelhar(db, p2, empresaA.id, 30, 0);
    await assert.rejects(
      () => confirmarOficial(db, empresaA.id, [
        {
          produto_id: p1,
          quantidade_fiscal_contada: 15,
          quantidade_nao_fiscal_contada: 0,
          saldo_fiscal_esperado: 20,
          saldo_nao_fiscal_esperado: 0
        },
        {
          produto_id: p2,
          quantidade_fiscal_contada: 25,
          quantidade_nao_fiscal_contada: 0,
          saldo_fiscal_esperado: 999,
          saldo_nao_fiscal_esperado: 0
        }
      ], 'roll-17'),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal(Number((await ee(db, p1, empresaA.id)).saldo_fiscal), 20);
    assert.equal(Number((await ee(db, p2, empresaA.id)).saldo_fiscal), 30);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas')).n), 0);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque')).n), 0);
    await closeDb(db);
  });

  it('fonte: rota oficial exige snapshot', () => {
    const rotas = fs.readFileSync(
      path.resolve(__dirname, '../../backend/rotas/estoque.js'),
      'utf8'
    );
    assert.match(rotas, /exigirSnapshotItensOficiais/);
    assert.match(rotas, /SNAPSHOT_OBRIGATORIO|CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03\.1/);
  });
});
