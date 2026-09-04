/**
 * Schema — produtos_lotes.empresa_id (Sprint 05.47).
 * Sem backfill. NULL = legado sem ownership. Não inventa empresa.
 *
 * @module services/estoque/lotesEmpresaSchema
 */
'use strict';

const DDL_PRODUTOS_LOTES = `
  CREATE TABLE IF NOT EXISTS produtos_lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL,
    lote TEXT NOT NULL,
    quantidade_inicial DECIMAL(10,2) NOT NULL,
    quantidade_atual DECIMAL(10,2) NOT NULL,
    data_fabricacao DATE,
    data_validade DATE NOT NULL,
    data_entrada DATE NOT NULL,
    origem TEXT NOT NULL DEFAULT 'COMPRA',
    compra_id INTEGER,
    empresa_id INTEGER,
    ativo INTEGER DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

async function alterarIgnorandoDuplicata(db, sql) {
  try {
    await dbRun(db, sql);
  } catch (err) {
    const msg = String(err && err.message || '');
    if (msg.includes('duplicate column name') || msg.includes('already exists')) {
      return;
    }
    throw err;
  }
}

/**
 * Garante coluna empresa_id e índice empresarial. Não preenche legado.
 * @param {object} db
 * @param {Function} [callback]
 */
function garantirSchemaLotesEmpresa(db, callback) {
  const done = typeof callback === 'function' ? callback : null;
  if (!db) {
    const err = new Error('db obrigatório para schema produtos_lotes');
    if (done) return done(err);
    return Promise.reject(err);
  }

  const work = (async () => {
    await dbRun(db, DDL_PRODUTOS_LOTES);
    await alterarIgnorandoDuplicata(
      db,
      'ALTER TABLE produtos_lotes ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)'
    );
    await dbRun(
      db,
      `CREATE INDEX IF NOT EXISTS idx_produtos_lotes_empresa_produto
       ON produtos_lotes(empresa_id, produto_id, ativo)`
    );
  })();

  if (done) {
    work.then(() => done(null), done);
    return undefined;
  }
  return work;
}

function garantirSchemaLotesEmpresaAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaLotesEmpresa(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_PRODUTOS_LOTES,
  garantirSchemaLotesEmpresa,
  garantirSchemaLotesEmpresaAsync
};
