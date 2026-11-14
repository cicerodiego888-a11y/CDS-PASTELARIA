/**
 * SPRINT CDS-ESTOQUE-CONTAGEM-CONCORRENCIA-03
 * Integridade transacional e snapshot da observação na contagem física.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/estoque/contagem-fisica-concorrencia-03.test.js
 *
 * Isolamento: DB_DIR + arquivo temporário (concorrência com 2 conexões).
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-contagem-conc-03-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const EstoqueContagemFisicaService = require('../../backend/services/estoque/EstoqueContagemFisicaService');
const { garantirSchemaEstoqueContagemFisicaAsync } = require('../../backend/services/estoque/estoqueContagemFisicaSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function openDb(filename) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, (err) => (err ? reject(err) : resolve(db)));
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

async function schemaBase(db) {
  await run(db, 'PRAGMA foreign_keys = ON');
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueContagemFisicaAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
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
    CREATE TABLE IF NOT EXISTS produtos_ajustes_estoque (
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
}

async function setupFile() {
  const file = path.join(dbDir, `contagem-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const db = await openDb(file);
  await schemaBase(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, file, empresaA, empresaB };
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

function itemComSnapshot(produtoId, qF, qNf, snapF, snapNf) {
  return {
    produto_id: produtoId,
    quantidade_fiscal_contada: qF,
    quantidade_nao_fiscal_contada: qNf,
    saldo_fiscal_esperado: snapF,
    saldo_nao_fiscal_esperado: snapNf
  };
}

describe('CDS-ESTOQUE-CONTAGEM-CONCORRENCIA-03', { concurrency: false }, () => {
  it('01 contagem normal com diferença negativa', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Coca', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      usuarioId: 1,
      usuarioNome: 'op',
      itens: [itemComSnapshot(pid, 10000, 0, 24000, 0)]
    });
    assert.equal(out.itens[0].diferenca_fiscal, -14000);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 10000);
    await closeDb(db);
  });

  it('02 contagem normal com diferença positiva', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Farinha', 10, 0);
    await espelhar(db, pid, empresaA.id, 10, 0);
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      usuarioId: 1,
      usuarioNome: 'op',
      itens: [itemComSnapshot(pid, 15, 0, 10, 0)]
    });
    assert.equal(out.itens[0].diferenca_fiscal, 5);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 15);
    await closeDb(db);
  });

  it('03 contagem sem diferença não gera ajuste', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Açúcar', 7, 3);
    await espelhar(db, pid, empresaA.id, 7, 3);
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      usuarioId: 1,
      usuarioNome: 'op',
      itens: [itemComSnapshot(pid, 7, 3, 7, 3)]
    });
    assert.equal(out.itens[0].diferenca_fiscal, 0);
    assert.equal(out.itens[0].diferenca_nao_fiscal, 0);
    assert.equal(out.itens[0].ajuste_id, null);
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque WHERE produto_id = ?', [pid]);
    assert.equal(Number(ajustes.n), 0);
    await closeDb(db);
  });

  it('04 reenvio da mesma chave de idempotência', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Item', 10, 0);
    await espelhar(db, pid, empresaA.id, 10, 0);
    const payload = {
      db,
      empresaId: empresaA.id,
      usuarioId: 1,
      usuarioNome: 'op',
      chaveIdempotencia: 'idem-04',
      itens: [itemComSnapshot(pid, 9, 0, 10, 0)]
    };
    const a = await EstoqueContagemFisicaService.registrarContagemFisica(payload);
    const b = await EstoqueContagemFisicaService.registrarContagemFisica(payload);
    assert.equal(a.id, b.id);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 9);
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque WHERE produto_id = ?', [pid]);
    assert.equal(Number(ajustes.n), 1);
    const contagens = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas WHERE empresa_id = ?', [empresaA.id]);
    assert.equal(Number(contagens.n), 1);
    await closeDb(db);
  });

  it('05 duas contagens simultâneas mesmo produto/empresa — uma rejeitada', async () => {
    const { db, file, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'CocaConc', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 10000,
      quantidade_nao_fiscal_contada: 0
    });
    assert.equal(preview.saldo_fiscal_esperado, 24000);

    const db2 = await openDb(file);
    const p1 = EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      usuarioId: 1,
      usuarioNome: 'op1',
      chaveIdempotencia: 'conc-5-a',
      itens: [itemComSnapshot(pid, 10000, 0, preview.saldo_fiscal_esperado, preview.saldo_nao_fiscal_esperado)]
    });
    const p2 = EstoqueContagemFisicaService.registrarContagemFisica({
      db: db2,
      empresaId: empresaA.id,
      usuarioId: 2,
      usuarioNome: 'op2',
      chaveIdempotencia: 'conc-5-b',
      itens: [itemComSnapshot(pid, 12000, 0, preview.saldo_fiscal_esperado, preview.saldo_nao_fiscal_esperado)]
    });

    const settled = await Promise.allSettled([p1, p2]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const fail = settled.filter((s) => s.status === 'rejected');
    assert.equal(ok.length, 1, 'exatamente uma contagem deve confirmar');
    assert.equal(fail.length, 1, 'exatamente uma contagem deve falhar');
    assert.equal(fail[0].reason.code, 'CONTAGEM_DESATUALIZADA');

    const saldo = Number((await ee(db, pid, empresaA.id)).saldo_fiscal);
    assert.ok(saldo === 10000 || saldo === 12000);
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque WHERE produto_id = ?', [pid]);
    assert.equal(Number(ajustes.n), 1);
    const contagens = await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas WHERE empresa_id = ?', [empresaA.id]);
    assert.equal(Number(contagens.n), 1);
    await closeDb(db2);
    await closeDb(db);
  });

  it('06 segunda contagem com saldo antigo é rejeitada', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'CocaSeq', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'seq-6-a',
      itens: [itemComSnapshot(pid, 10000, 0, 24000, 0)]
    });
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'seq-6-b',
        itens: [itemComSnapshot(pid, 12000, 0, 24000, 0)]
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 10000);
    const ajustes = await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque WHERE produto_id = ?', [pid]);
    assert.equal(Number(ajustes.n), 1);
    await closeDb(db);
  });

  it('07 nova contagem após confirmação (snapshot atual) é aceita', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'CocaNova', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'nova-7-a',
      itens: [itemComSnapshot(pid, 10000, 0, 24000, 0)]
    });
    const preview = await EstoqueContagemFisicaService.previsualizarContagem({
      db,
      empresaId: empresaA.id,
      produtoId: pid,
      quantidade_fiscal_contada: 12000,
      quantidade_nao_fiscal_contada: 0
    });
    assert.equal(preview.saldo_fiscal_esperado, 10000);
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'nova-7-b',
      itens: [itemComSnapshot(
        pid,
        12000,
        0,
        preview.saldo_fiscal_esperado,
        preview.saldo_nao_fiscal_esperado
      )]
    });
    assert.equal(out.itens[0].diferenca_fiscal, 2000);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 12000);
    await closeDb(db);
  });

  it('08 produtos diferentes na mesma empresa — independentes', async () => {
    const { db, file, empresaA } = await setupFile();
    const p1 = await criarProduto(db, 'Prod1', 50, 0);
    const p2 = await criarProduto(db, 'Prod2', 80, 0);
    await espelhar(db, p1, empresaA.id, 50, 0);
    await espelhar(db, p2, empresaA.id, 80, 0);
    const db2 = await openDb(file);
    const settled = await Promise.allSettled([
      EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'prod-8-a',
        itens: [itemComSnapshot(p1, 40, 0, 50, 0)]
      }),
      EstoqueContagemFisicaService.registrarContagemFisica({
        db: db2,
        empresaId: empresaA.id,
        chaveIdempotencia: 'prod-8-b',
        itens: [itemComSnapshot(p2, 70, 0, 80, 0)]
      })
    ]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 2);
    assert.equal(Number((await ee(db, p1, empresaA.id)).saldo_fiscal), 40);
    assert.equal(Number((await ee(db, p2, empresaA.id)).saldo_fiscal), 70);
    await closeDb(db2);
    await closeDb(db);
  });

  it('09 mesmo produto em empresas diferentes — independentes', async () => {
    const { db, file, empresaA, empresaB } = await setupFile();
    const pid = await criarProduto(db, 'Shared', 100, 0);
    await espelhar(db, pid, empresaA.id, 100, 0);
    await espelhar(db, pid, empresaB.id, 100, 0);
    const db2 = await openDb(file);
    const settled = await Promise.allSettled([
      EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'emp-9-a',
        itens: [itemComSnapshot(pid, 90, 0, 100, 0)]
      }),
      EstoqueContagemFisicaService.registrarContagemFisica({
        db: db2,
        empresaId: empresaB.id,
        chaveIdempotencia: 'emp-9-b',
        itens: [itemComSnapshot(pid, 85, 0, 100, 0)]
      })
    ]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 2);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 90);
    assert.equal(Number((await ee(db, pid, empresaB.id)).saldo_fiscal), 85);
    await closeDb(db2);
    await closeDb(db);
  });

  it('10 separação fiscal e não fiscal', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Misto', 50, 30);
    await espelhar(db, pid, empresaA.id, 50, 30);
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      itens: [itemComSnapshot(pid, 45, 25, 50, 30)]
    });
    assert.equal(out.itens[0].diferenca_fiscal, -5);
    assert.equal(out.itens[0].diferenca_nao_fiscal, -5);
    const row = await ee(db, pid, empresaA.id);
    assert.equal(Number(row.saldo_fiscal), 45);
    assert.equal(Number(row.saldo_nao_fiscal), 25);
    assert.equal(Number(row.estoque_atual), 70);
    await closeDb(db);
  });

  it('11 falha no lote provoca rollback integral', async () => {
    const { db, empresaA } = await setupFile();
    const p1 = await criarProduto(db, 'Ok', 20, 0);
    const p2 = await criarProduto(db, 'Outro', 30, 0);
    await espelhar(db, p1, empresaA.id, 20, 0);
    await espelhar(db, p2, empresaA.id, 30, 0);
    // 1º item ajustaria; 2º falha por snapshot desatualizado → rollback do lote.
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'fail-11',
        itens: [
          itemComSnapshot(p1, 15, 0, 20, 0),
          itemComSnapshot(p2, 25, 0, 999, 0)
        ]
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    assert.equal(Number((await ee(db, p1, empresaA.id)).saldo_fiscal), 20);
    assert.equal(Number((await ee(db, p2, empresaA.id)).saldo_fiscal), 30);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM estoque_contagens_fisicas')).n), 0);
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM produtos_ajustes_estoque')).n), 0);
    await closeDb(db);
  });

  it('12 conflito não duplica ajustes', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'NoDup', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'nodup-a',
      itens: [itemComSnapshot(pid, 10000, 0, 24000, 0)]
    });
    try {
      await EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'nodup-b',
        itens: [itemComSnapshot(pid, 12000, 0, 24000, 0)]
      });
      assert.fail('deveria rejeitar');
    } catch (err) {
      assert.equal(err.code, 'CONTAGEM_DESATUALIZADA');
    }
    const ajustes = await all(db, 'SELECT * FROM produtos_ajustes_estoque WHERE produto_id = ?', [pid]);
    assert.equal(ajustes.length, 1);
    assert.equal(Number(ajustes[0].ajuste_fiscal), -14000);
    await closeDb(db);
  });

  it('13 histórico permanece consistente após conflito', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Hist', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    const ok = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      usuarioId: 7,
      usuarioNome: 'cicero',
      chaveIdempotencia: 'hist-a',
      itens: [itemComSnapshot(pid, 10000, 0, 24000, 0)]
    });
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'hist-b',
        itens: [itemComSnapshot(pid, 12000, 0, 24000, 0)]
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    const hist = await EstoqueContagemFisicaService.obterContagemPorId(db, ok.id, empresaA.id);
    assert.equal(hist.usuario_id, 7);
    assert.equal(hist.itens[0].saldo_fiscal_anterior, 24000);
    assert.equal(hist.itens[0].quantidade_fiscal_contada, 10000);
    assert.equal(hist.itens[0].diferenca_fiscal, -14000);
    const contagens = await all(db, 'SELECT id FROM estoque_contagens_fisicas WHERE empresa_id = ?', [empresaA.id]);
    assert.equal(contagens.length, 1);
    await closeDb(db);
  });

  it('14 repetição após falha sem duplicar movimentações', async () => {
    const { db, empresaA } = await setupFile();
    const pid = await criarProduto(db, 'Retry', 24000, 0);
    await espelhar(db, pid, empresaA.id, 24000, 0);
    await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'retry-win',
      itens: [itemComSnapshot(pid, 10000, 0, 24000, 0)]
    });
    await assert.rejects(
      () => EstoqueContagemFisicaService.registrarContagemFisica({
        db,
        empresaId: empresaA.id,
        chaveIdempotencia: 'retry-stale',
        itens: [itemComSnapshot(pid, 12000, 0, 24000, 0)]
      }),
      (err) => err && err.code === 'CONTAGEM_DESATUALIZADA'
    );
    // Nova observação atualizada após falha.
    const out = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'retry-fresh',
      itens: [itemComSnapshot(pid, 12000, 0, 10000, 0)]
    });
    assert.equal(out.itens[0].diferenca_fiscal, 2000);
    assert.equal(Number((await ee(db, pid, empresaA.id)).saldo_fiscal), 12000);
    const ajustes = await all(db, 'SELECT ajuste_fiscal FROM produtos_ajustes_estoque WHERE produto_id = ? ORDER BY id', [pid]);
    assert.equal(ajustes.length, 2);
    assert.equal(Number(ajustes[0].ajuste_fiscal), -14000);
    assert.equal(Number(ajustes[1].ajuste_fiscal), 2000);
    // Reenvio da chave fresca não duplica.
    const again = await EstoqueContagemFisicaService.registrarContagemFisica({
      db,
      empresaId: empresaA.id,
      chaveIdempotencia: 'retry-fresh',
      itens: [itemComSnapshot(pid, 12000, 0, 10000, 0)]
    });
    assert.equal(again.id, out.id);
    assert.equal((await all(db, 'SELECT id FROM produtos_ajustes_estoque WHERE produto_id = ?', [pid])).length, 2);
    await closeDb(db);
  });
});
