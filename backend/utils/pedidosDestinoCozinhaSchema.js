/**
 * S07-3D — Snapshot de resolução de destino de cozinha no pedido.
 * Colunas aditivas (nullable). DDL via migration controlada ou garantir* em testes.
 * Não executar no banco oficial automaticamente.
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

const COLUNAS_DESTINO_COZINHA = Object.freeze([
  'cozinha_canal_codigo',
  'unidade_cozinha_destino_id',
  'cozinha_resolucao_status'
]);

async function verificarSchemaDestinoCozinhaPedidos(db) {
  if (!db) return { disponivel: false, faltando: COLUNAS_DESTINO_COZINHA.slice(), skipped: true };
  const colunas = await dbAll(db, 'PRAGMA table_info(pedidos)');
  if (!colunas.length) {
    return { disponivel: false, faltando: COLUNAS_DESTINO_COZINHA.slice(), skipped: true };
  }
  const nomes = new Set(colunas.map((c) => String(c.name).toLowerCase()));
  const faltando = COLUNAS_DESTINO_COZINHA.filter((c) => !nomes.has(c));
  return { disponivel: faltando.length === 0, faltando, skipped: false };
}

async function exigirSchemaDestinoCozinhaPedidos(db) {
  const st = await verificarSchemaDestinoCozinhaPedidos(db);
  if (st.disponivel) return st;
  const err = new Error(
    'Schema de destino de cozinha no pedido indisponível. Aplique a migration S07-3D.'
  );
  err.statusCode = 503;
  err.codigo = 'SCHEMA_DESTINO_COZINHA_PEDIDO_INDISPONIVEL';
  err.faltando = (st.faltando || []).slice();
  throw err;
}

/** CREATE/ALTER IF NOT EXISTS — somente testes / aplicação controlada. */
async function garantirSchemaDestinoCozinhaPedidos(db) {
  if (!db) return { skipped: true, colunasAdicionadas: [] };
  const colunas = await dbAll(db, 'PRAGMA table_info(pedidos)');
  if (!colunas.length) return { skipped: true, colunasAdicionadas: [] };
  const nomes = new Set(colunas.map((c) => String(c.name).toLowerCase()));
  const colunasAdicionadas = [];

  if (!nomes.has('cozinha_canal_codigo')) {
    await dbRun(db, 'ALTER TABLE pedidos ADD COLUMN cozinha_canal_codigo TEXT');
    colunasAdicionadas.push('cozinha_canal_codigo');
  }
  if (!nomes.has('unidade_cozinha_destino_id')) {
    await dbRun(db, 'ALTER TABLE pedidos ADD COLUMN unidade_cozinha_destino_id INTEGER');
    colunasAdicionadas.push('unidade_cozinha_destino_id');
  }
  if (!nomes.has('cozinha_resolucao_status')) {
    await dbRun(db, 'ALTER TABLE pedidos ADD COLUMN cozinha_resolucao_status TEXT');
    colunasAdicionadas.push('cozinha_resolucao_status');
  }

  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_pedidos_cozinha_destino
      ON pedidos(empresa_id, unidade_cozinha_destino_id)`
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_pedidos_cozinha_resolucao
      ON pedidos(empresa_id, cozinha_resolucao_status)`
  );

  return { skipped: false, colunasAdicionadas };
}

module.exports = {
  COLUNAS_DESTINO_COZINHA,
  verificarSchemaDestinoCozinhaPedidos,
  exigirSchemaDestinoCozinhaPedidos,
  garantirSchemaDestinoCozinhaPedidos
};
