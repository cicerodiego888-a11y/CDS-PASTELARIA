'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const UnidadeVolume = require('../../backend/services/produtos/VolumeUnidadeComercialService');
const VolumeProduto = require('../../backend/services/produtos/VolumeComercialProdutoService');
const { normalizarUnidade } = require('../../backend/motores/muc/core/unidadesSi');

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

function garantirSchema(db) {
  return new Promise((resolve, reject) => {
    UnidadeVolume.garantirSchema(db, (err) => (err ? reject(err) : resolve()));
  });
}

async function criarProdutosLegados(db) {
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      utiliza_volume INTEGER NOT NULL DEFAULT 0,
      volume_valor REAL,
      volume_unidade TEXT
    )
  `);
  await run(
    db,
    `INSERT INTO produtos (nome, utiliza_volume, volume_valor, volume_unidade)
     VALUES ('Produto ML', 1, 250, 'ML'), ('Produto L', 1, 1, 'L')`
  );
}

async function main() {
  const db = await openDb();
  try {
    await criarProdutosLegados(db);
    await garantirSchema(db);
    await garantirSchema(db);

    const padroes = await UnidadeVolume.listarAtivas(db);
    assert.deepEqual(padroes.map((unidade) => unidade.sigla).sort(), ['L', 'ML']);
    const ml = await get(db, "SELECT id FROM unidades_volume_comercial WHERE sigla = 'ML'");
    const litro = await get(db, "SELECT id FROM unidades_volume_comercial WHERE sigla = 'L'");
    assert.equal((await get(db, 'SELECT volume_unidade_id FROM produtos WHERE id = 1')).volume_unidade_id, ml.id);
    assert.equal((await get(db, 'SELECT volume_unidade_id FROM produtos WHERE id = 2')).volume_unidade_id, litro.id);

    const unidade = await UnidadeVolume.criar(db, { nome: 'Garrafa', sigla: ' g f ' });
    assert.equal(unidade.sigla, 'GF');
    assert.equal(unidade.ativo, 1);
    assert.equal(normalizarUnidade(unidade.sigla), null, 'sigla personalizada não é unidade MUC nem ganha conversão');

    await assert.rejects(
      UnidadeVolume.criar(db, { nome: 'Outra garrafa', sigla: 'G F' }),
      (err) => err.code === 'UNIDADE_VOLUME_DUPLICADA' && err.statusCode === 409
    );
    await assert.rejects(
      UnidadeVolume.criar(db, { nome: ' ', sigla: 'AB' }),
      (err) => err.code === 'NOME_UNIDADE_OBRIGATORIO'
    );
    await assert.rejects(
      UnidadeVolume.criar(db, { nome: 'Unidade inválida', sigla: 'A-1' }),
      (err) => err.code === 'SIGLA_UNIDADE_INVALIDA'
    );
    await assert.rejects(
      UnidadeVolume.criar(db, { nome: 'Sem sigla', sigla: ' ' }),
      (err) => err.code === 'SIGLA_UNIDADE_OBRIGATORIA'
    );
    await assert.rejects(
      UnidadeVolume.resolverAssociacaoProduto(db, { unidadeId: 99999, sigla: 'GF' }),
      (err) => err.code === 'UNIDADE_VOLUME_NAO_ENCONTRADA'
    );
    await assert.rejects(
      UnidadeVolume.resolverAssociacaoProduto(db, { unidadeId: unidade.id, sigla: 'CP' }),
      (err) => err.code === 'UNIDADE_VOLUME_DIVERGENTE'
    );

    const associacao = await UnidadeVolume.resolverAssociacaoProduto(db, {
      unidadeId: unidade.id,
      sigla: 'GF'
    });
    const volumeCustomizado = VolumeProduto.normalizarVolumeComercial({
      utiliza_volume: 1,
      volume_valor: 1,
      volume_unidade: 'GF',
      volume_unidade_id: unidade.id
    });
    assert.equal(volumeCustomizado.volume_unidade_id, unidade.id);
    assert.equal(volumeCustomizado.volume_unidade, 'GF');
    const produtoCriado = await run(
      db,
      `INSERT INTO produtos
        (nome, utiliza_volume, volume_valor, volume_unidade, volume_unidade_id)
       VALUES ('Produto Garrafa', 1, 1, ?, ?)`,
      [associacao.sigla, associacao.id]
    );
    const produtoLido = await get(
      db,
      `SELECT p.*, u.nome AS volume_unidade_nome
       FROM produtos p LEFT JOIN unidades_volume_comercial u ON u.id = p.volume_unidade_id
       WHERE p.id = ?`,
      [produtoCriado.lastID]
    );
    assert.equal(produtoLido.volume_unidade_id, unidade.id);
    assert.deepEqual(VolumeProduto.normalizarVolumeComercialResposta(produtoLido), {
      utiliza_volume: 1,
      volume_valor: 1,
      volume_unidade: 'GF',
      volume_unidade_id: unidade.id,
      volume_unidade_nome: 'Garrafa'
    });
    assert.equal(
      VolumeProduto.normalizarVolumeComercial({}).informado,
      false,
      'payload sem os campos de volume não ativa uma atualização de volume'
    );

    await run(db, 'UPDATE unidades_volume_comercial SET ativo = 0 WHERE id = ?', [unidade.id]);
    assert.equal((await UnidadeVolume.listarAtivas(db)).some((item) => item.id === unidade.id), false);
    await run(db, 'UPDATE produtos SET nome = ? WHERE id = ?', ['Produto Garrafa editado', produtoCriado.lastID]);
    const produtoInativoEditado = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoCriado.lastID]);
    assert.equal(produtoInativoEditado.volume_unidade, 'GF');
    assert.equal(produtoInativoEditado.volume_unidade_id, unidade.id);
    await assert.rejects(
      UnidadeVolume.resolverAssociacaoProduto(db, { unidadeId: unidade.id, sigla: 'GF' }),
      (err) => err.code === 'UNIDADE_VOLUME_INATIVA'
    );
    const historica = await UnidadeVolume.resolverAssociacaoProduto(db, {
      unidadeId: unidade.id,
      sigla: 'GF',
      produtoId: produtoCriado.lastID
    });
    assert.equal(historica.id, unidade.id, 'produto existente mantém unidade inativa histórica');
    const ativa = await UnidadeVolume.criar(db, { nome: 'Copo', sigla: 'CP' });
    const associacaoAtiva = await UnidadeVolume.resolverAssociacaoProduto(db, {
      unidadeId: ativa.id,
      sigla: ativa.sigla,
      produtoId: produtoCriado.lastID
    });
    await run(
      db,
      `UPDATE produtos SET volume_unidade = ?, volume_unidade_id = ? WHERE id = ?`,
      [associacaoAtiva.sigla, associacaoAtiva.id, produtoCriado.lastID]
    );
    const produtoComNovaUnidade = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoCriado.lastID]);
    assert.equal(produtoComNovaUnidade.volume_unidade, 'CP');
    assert.equal(produtoComNovaUnidade.volume_unidade_id, ativa.id);
    console.log('unidades-volume-comercial: migração, validação, vínculo e inativação passaram');
  } finally {
    await closeDb(db);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-volume-unidades-'));
  const file = path.join(dir, 'isolado.sqlite');
  let reopened;
  try {
    reopened = await openDb(file);
    await criarProdutosLegados(reopened);
    await garantirSchema(reopened);
    const created = await UnidadeVolume.criar(reopened, { nome: 'Copo', sigla: 'CP' });
    await closeDb(reopened);
    reopened = await openDb(file);
    const reloaded = await UnidadeVolume.listarAtivas(reopened);
    assert.ok(reloaded.some((item) => item.id === created.id && item.sigla === 'CP'));
    console.log('unidades-volume-comercial: persistência após reabertura passou');
  } finally {
    if (reopened) await closeDb(reopened);
    for (const suffix of ['', '-shm', '-wal']) {
      const target = `${file}${suffix}`;
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(dir);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
