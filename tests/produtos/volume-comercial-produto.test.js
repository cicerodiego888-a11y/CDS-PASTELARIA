'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const {
  MIGRACOES_SCHEMA,
  normalizarVolumeComercial,
  normalizarVolumeComercialResposta
} = require('../../backend/services/produtos/VolumeComercialProdutoService');

function openDb(file = ':memory:') {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
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

function closeDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function aplicarMigracoesVolume(db) {
  for (const sql of MIGRACOES_SCHEMA) {
    try {
      await run(db, sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err.message || ''))) throw err;
    }
  }
}

function falhaComCodigo(fn, code) {
  assert.throws(fn, (err) => err.code === code && err.statusCode === 400);
}

async function salvarVolume(db, produtoId, tipo, body) {
  if (tipo !== 'COMERCIAL') {
    await run(db, 'UPDATE produtos SET tipo_operacional = ? WHERE id = ?', [tipo, produtoId]);
    return;
  }
  const volume = normalizarVolumeComercial(body);
  if (!volume.informado) return;
  if (volume.utiliza_volume) {
    await run(
      db,
      `UPDATE produtos SET utiliza_volume = 1, volume_valor = ?, volume_unidade = ? WHERE id = ?`,
      [volume.volume_valor, volume.volume_unidade, produtoId]
    );
  } else {
    await run(db, 'UPDATE produtos SET utiliza_volume = 0 WHERE id = ?', [produtoId]);
  }
}

async function main() {
  const db = await openDb();
  try {
    await run(db, `
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL'
      )
    `);
    await run(db, `INSERT INTO produtos (nome) VALUES ('Produto legado')`);
    await aplicarMigracoesVolume(db);
    await aplicarMigracoesVolume(db);

    const legado = await get(db, 'SELECT * FROM produtos WHERE id = 1');
    assert.equal(legado.utiliza_volume, 0);
    assert.equal(legado.volume_valor, null);
    assert.equal(legado.volume_unidade, null);

    const semVolume = normalizarVolumeComercial({});
    assert.equal(semVolume.informado, false);
    const novo = await run(
      db,
      `INSERT INTO produtos (nome, utiliza_volume, volume_valor, volume_unidade) VALUES (?, ?, ?, ?)`,
      ['Produto sem volume', semVolume.utiliza_volume, null, null]
    );
    const semVolumeSalvo = await get(db, 'SELECT * FROM produtos WHERE id = ?', [novo.lastID]);
    assert.equal(semVolumeSalvo.utiliza_volume, 0);

    const ml = normalizarVolumeComercial({
      utiliza_volume: 1,
      volume_valor: 200,
      volume_unidade: 'ml'
    });
    await run(
      db,
      `INSERT INTO produtos (nome, utiliza_volume, volume_valor, volume_unidade) VALUES (?, ?, ?, ?)`,
      ['Refrigerante Copo', ml.utiliza_volume, ml.volume_valor, ml.volume_unidade]
    );
    const produtoId = 3;
    assert.equal(ml.volume_unidade, 'ML');
    assert.equal((await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId])).volume_valor, 200);

    await salvarVolume(db, produtoId, 'COMERCIAL', {
      utiliza_volume: 1,
      volume_valor: '350',
      volume_unidade: 'ML'
    });
    const editado = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
    assert.equal(editado.volume_valor, 350, 'edição persiste novo volume e mantém unidade');
    assert.equal(normalizarVolumeComercialResposta(editado).volume_unidade, 'ML');
    await salvarVolume(db, produtoId, 'COMERCIAL', {});
    assert.equal((await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId])).volume_valor, 350, 'payload legado não apaga a configuração');

    const litro = normalizarVolumeComercial({
      utiliza_volume: true,
      volume_valor: '1,5',
      volume_unidade: 'L'
    });
    assert.deepEqual(
      { utiliza_volume: litro.utiliza_volume, volume_valor: litro.volume_valor, volume_unidade: litro.volume_unidade },
      { utiliza_volume: 1, volume_valor: 1.5, volume_unidade: 'L' }
    );

    falhaComCodigo(() => normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: 0, volume_unidade: 'ML' }), 'VOLUME_VALOR_INVALIDO');
    falhaComCodigo(() => normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: -1, volume_unidade: 'ML' }), 'VOLUME_VALOR_INVALIDO');
    falhaComCodigo(() => normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: Number.NaN, volume_unidade: 'ML' }), 'VOLUME_VALOR_INVALIDO');
    falhaComCodigo(() => normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: Infinity, volume_unidade: 'ML' }), 'VOLUME_VALOR_INVALIDO');
    assert.equal(normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: '1e3', volume_unidade: 'ML' }).volume_valor, 1000);
    falhaComCodigo(() => normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: 200, volume_unidade: 'KG' }), 'VOLUME_UNIDADE_INVALIDA');
    falhaComCodigo(() => normalizarVolumeComercial({ utiliza_volume: 1, volume_valor: 200, volume_unidade: 'unidade inventada' }), 'VOLUME_UNIDADE_INVALIDA');
    falhaComCodigo(() => normalizarVolumeComercial({ volume_valor: 200, volume_unidade: 'ML' }), 'UTILIZA_VOLUME_OBRIGATORIO');

    await salvarVolume(db, produtoId, 'COMERCIAL', { utiliza_volume: 0 });
    const desativado = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
    assert.equal(desativado.utiliza_volume, 0);
    assert.equal(desativado.volume_valor, 350, 'desativar mantém os valores persistidos, mas não ativos');
    assert.equal(desativado.volume_unidade, 'ML');
    assert.deepEqual(normalizarVolumeComercialResposta(desativado), {
      utiliza_volume: 0,
      volume_valor: null,
      volume_unidade: null,
      volume_unidade_id: null,
      volume_unidade_nome: null
    });

    const insumo = await run(
      db,
      `INSERT INTO produtos (nome, tipo_operacional, utiliza_volume, volume_valor, volume_unidade)
       VALUES (?, 'INSUMO', 1, 999, 'ML')`,
      ['Insumo de teste']
    );
    const insumoLido = await get(db, 'SELECT * FROM produtos WHERE id = ?', [insumo.lastID]);
    assert.deepEqual(normalizarVolumeComercialResposta(insumoLido), {
      utiliza_volume: 0,
      volume_valor: null,
      volume_unidade: null,
      volume_unidade_id: null,
      volume_unidade_nome: null
    });

    console.log('volume-comercial-produto: todos os testes passaram');
  } finally {
    await closeDb(db);
  }

  const file = path.join(os.tmpdir(), `volume-comercial-${process.pid}-${Date.now()}.sqlite`);
  let reopened;
  try {
    reopened = await openDb(file);
    await run(reopened, `
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL'
      )
    `);
    await aplicarMigracoesVolume(reopened);
    const volume = normalizarVolumeComercial({
      utiliza_volume: 1,
      volume_valor: 500,
      volume_unidade: 'ML'
    });
    const created = await run(
      reopened,
      `INSERT INTO produtos (nome, utiliza_volume, volume_valor, volume_unidade) VALUES (?, ?, ?, ?)`,
      ['Produto persistido', volume.utiliza_volume, volume.volume_valor, volume.volume_unidade]
    );
    await closeDb(reopened);
    reopened = await openDb(file);
    const persisted = await get(reopened, 'SELECT * FROM produtos WHERE id = ?', [created.lastID]);
    assert.deepEqual(normalizarVolumeComercialResposta(persisted), {
      utiliza_volume: 1,
      volume_valor: 500,
      volume_unidade: 'ML',
      volume_unidade_id: null,
      volume_unidade_nome: null
    });
    console.log('volume-comercial-produto: persistência após reabertura passou');
  } finally {
    if (reopened) await closeDb(reopened);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
