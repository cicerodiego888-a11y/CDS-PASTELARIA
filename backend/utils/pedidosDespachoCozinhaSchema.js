/**
 * S07-3E — Schema de controle de despacho pedido → KDS.
 * DDL via migration controlada ou garantir* em testes. Sem execução no oficial.
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

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

const COLUNAS_PEDIDO = Object.freeze([
  'cozinha_despacho_status',
  'cozinha_despacho_rodada_id',
  'cozinha_despacho_codigo'
]);

async function verificarSchemaDespachoPedidoCozinha(db) {
  if (!db) {
    return { disponivel: false, faltando: ['cozinha_pedido_despachos', ...COLUNAS_PEDIDO], skipped: true };
  }
  const faltando = [];
  const tabela = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cozinha_pedido_despachos'
  `);
  if (!tabela) {
    faltando.push('cozinha_pedido_despachos');
  } else {
    const colunasDespacho = await dbAll(db, 'PRAGMA table_info(cozinha_pedido_despachos)');
    const nomesDespacho = new Set((colunasDespacho || []).map((c) => String(c.name).toLowerCase()));
    if (!nomesDespacho.has('claim_token')) {
      faltando.push('cozinha_pedido_despachos.claim_token');
    }
  }

  const colunas = await dbAll(db, 'PRAGMA table_info(pedidos)');
  const nomes = new Set((colunas || []).map((c) => String(c.name).toLowerCase()));
  for (const col of COLUNAS_PEDIDO) {
    if (!nomes.has(col)) faltando.push(`pedidos.${col}`);
  }
  return { disponivel: faltando.length === 0, faltando, skipped: false };
}

async function exigirSchemaDespachoPedidoCozinha(db) {
  const st = await verificarSchemaDespachoPedidoCozinha(db);
  if (st.disponivel) return st;
  const err = new Error(
    'Schema de despacho pedido→KDS indisponível. Aplique a migration S07-3E.'
  );
  err.statusCode = 503;
  err.codigo = 'SCHEMA_DESPACHO_PEDIDO_INDISPONIVEL';
  err.faltando = (st.faltando || []).slice();
  throw err;
}

/** Somente testes / aplicação controlada. */
async function garantirSchemaDespachoPedidoCozinha(db) {
  if (!db) return { skipped: true };

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_pedido_despachos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      unidade_id INTEGER,
      rodada_id INTEGER,
      status TEXT NOT NULL
        CHECK (status IN ('EM_ANDAMENTO', 'CONCLUIDO', 'FALHA', 'BLOQUEADO')),
      idempotency_key TEXT NOT NULL,
      claim_token TEXT,
      codigo_falha TEXT,
      mensagem_falha TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (empresa_id, pedido_id),
      UNIQUE (idempotency_key),
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    )
  `);
  const colsDesp = await dbAll(db, 'PRAGMA table_info(cozinha_pedido_despachos)');
  const nomesDesp = new Set((colsDesp || []).map((c) => String(c.name).toLowerCase()));
  if (nomesDesp.size && !nomesDesp.has('claim_token')) {
    await dbRun(db, 'ALTER TABLE cozinha_pedido_despachos ADD COLUMN claim_token TEXT');
  }
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_pedido_despachos_status
      ON cozinha_pedido_despachos(empresa_id, status)
  `);

  const colunas = await dbAll(db, 'PRAGMA table_info(pedidos)');
  const nomes = new Set((colunas || []).map((c) => String(c.name).toLowerCase()));
  const adicionadas = [];
  if (nomes.size) {
    for (const col of COLUNAS_PEDIDO) {
      if (!nomes.has(col)) {
        const tipo = col === 'cozinha_despacho_rodada_id' ? 'INTEGER' : 'TEXT';
        await dbRun(db, `ALTER TABLE pedidos ADD COLUMN ${col} ${tipo}`);
        adicionadas.push(col);
      }
    }
  }

  return { skipped: false, colunasAdicionadas: adicionadas };
}

module.exports = {
  COLUNAS_PEDIDO,
  verificarSchemaDespachoPedidoCozinha,
  exigirSchemaDespachoPedidoCozinha,
  garantirSchemaDespachoPedidoCozinha
};
