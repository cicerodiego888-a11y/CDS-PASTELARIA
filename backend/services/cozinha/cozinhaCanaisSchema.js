/**
 * S07-3C — Schema de canais dinâmicos de pedidos (por empresa).
 * DDL só via migration controlada ou garantirSchema* em testes.
 * APIs NÃO criam tabelas sob demanda.
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

const TABELAS_CANAIS = Object.freeze([
  'cozinha_canais',
  'cozinha_canal_destinos'
]);

async function verificarSchemaCozinhaCanais(db) {
  if (!db) throw new Error('db obrigatório para verificar schema cozinha_canais');
  const faltando = [];
  for (const nome of TABELAS_CANAIS) {
    const row = await dbGet(db, `
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `, [nome]);
    if (!row || !row.name) faltando.push(nome);
  }
  return { disponivel: faltando.length === 0, faltando };
}

async function exigirSchemaCozinhaCanais(db) {
  const st = await verificarSchemaCozinhaCanais(db);
  if (st.disponivel) return st;
  const err = new Error(
    'Schema de canais de cozinha indisponível. Aplique a migration S07-3C antes de usar esta API.'
  );
  err.statusCode = 503;
  err.codigo = 'SCHEMA_CANAIS_INDISPONIVEL';
  err.faltando = st.faltando.slice();
  throw err;
}

/** CREATE IF NOT EXISTS — somente testes / aplicação controlada. */
async function garantirSchemaCozinhaCanais(db) {
  if (!db) throw new Error('db obrigatório para schema cozinha_canais');

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_canais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      codigo TEXT NOT NULL,
      nome TEXT NOT NULL,
      origem_tipo TEXT NOT NULL
        CHECK (origem_tipo IN ('SISTEMA', 'MANUAL', 'INTEGRACAO')),
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER,
      updated_by INTEGER,
      UNIQUE (empresa_id, codigo),
      UNIQUE (id, empresa_id),
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    )
  `);

  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_canais_empresa
      ON cozinha_canais(empresa_id)
  `);

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_canal_destinos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      canal_id INTEGER NOT NULL,
      unidade_cozinha_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER,
      UNIQUE (empresa_id, canal_id),
      FOREIGN KEY (empresa_id) REFERENCES empresas(id),
      FOREIGN KEY (canal_id, empresa_id)
        REFERENCES cozinha_canais(id, empresa_id),
      FOREIGN KEY (unidade_cozinha_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);

  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_canal_destinos_empresa
      ON cozinha_canal_destinos(empresa_id)
  `);

  return verificarSchemaCozinhaCanais(db);
}

module.exports = {
  TABELAS_CANAIS,
  verificarSchemaCozinhaCanais,
  exigirSchemaCozinhaCanais,
  garantirSchemaCozinhaCanais
};
