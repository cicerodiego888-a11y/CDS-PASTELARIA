/**
 * Registro do canal de origem do pedido: coluna aditiva pedidos.origem_canal.
 * Migração idempotente; pedidos existentes permanecem com NULL (origem anterior à camada de entrada).
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

async function garantirSchemaOrigemPedidos(db) {
  if (!db) return { skipped: true };
  const colunas = await dbAll(db, 'PRAGMA table_info(pedidos)');
  if (!colunas.length) return { skipped: true };
  let colunaAdicionada = false;
  if (!colunas.some((c) => String(c.name).toLowerCase() === 'origem_canal')) {
    await dbRun(db, 'ALTER TABLE pedidos ADD COLUMN origem_canal TEXT');
    colunaAdicionada = true;
  }
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_pedidos_origem_canal ON pedidos(empresa_id, origem_canal)');
  return { skipped: false, colunaAdicionada };
}

module.exports = { garantirSchemaOrigemPedidos };
