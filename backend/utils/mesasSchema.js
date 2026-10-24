/**
 * Schema de mesas (cadastro por empresa) e vínculo persistente pedidos.mesa_id.
 * Migração aditiva e idempotente: nunca apaga nem recria tabelas existentes.
 */
'use strict';

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function garantirSchemaMesas(db) {
  if (!db) return { skipped: true };
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      numero INTEGER NOT NULL CHECK (numero > 0),
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await dbRun(db, `CREATE UNIQUE INDEX IF NOT EXISTS ux_mesas_empresa_numero ON mesas(empresa_id, numero)`);

  let colunaAdicionada = false;
  const tabelaPedidos = await dbAll(db, `PRAGMA table_info(pedidos)`);
  if (tabelaPedidos.length) {
    const temMesa = tabelaPedidos.some((c) => String(c.name).toLowerCase() === 'mesa_id');
    if (!temMesa) {
      await dbRun(db, `ALTER TABLE pedidos ADD COLUMN mesa_id INTEGER`);
      colunaAdicionada = true;
    }
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pedidos_mesa_id ON pedidos(mesa_id)`);
  }
  return { skipped: false, colunaAdicionada };
}

module.exports = { garantirSchemaMesas };
