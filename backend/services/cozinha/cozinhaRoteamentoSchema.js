/**
 * S07-3A — Schema de configuração de roteamento de cozinhas (por empresa).
 * DDL somente via migration controlada ou garantirSchema* em ambiente de teste.
 * Serviços administrativos NÃO devem criar tabelas sob demanda.
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

const TABELAS_ROTEAMENTO = Object.freeze([
  'cozinha_roteamento_config',
  'cozinha_roteamento_segmentos'
]);

/**
 * Verifica se as tabelas de roteamento existem (sem DDL).
 * @returns {{ disponivel: boolean, faltando: string[] }}
 */
async function verificarSchemaCozinhaRoteamento(db) {
  if (!db) throw new Error('db obrigatório para verificar schema cozinha_roteamento');
  const faltando = [];
  for (const nome of TABELAS_ROTEAMENTO) {
    const row = await dbGet(db, `
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
    `, [nome]);
    if (!row || !row.name) faltando.push(nome);
  }
  return { disponivel: faltando.length === 0, faltando };
}

/**
 * Exige schema disponível. Sem CREATE — erro operacional se ausente.
 */
async function exigirSchemaCozinhaRoteamento(db) {
  const st = await verificarSchemaCozinhaRoteamento(db);
  if (st.disponivel) return st;
  const err = new Error(
    'Schema de roteamento de cozinhas indisponível. Aplique a migration S07-3A antes de usar esta API.'
  );
  err.statusCode = 503;
  err.codigo = 'SCHEMA_ROTEAMENTO_INDISPONIVEL';
  err.faltando = st.faltando.slice();
  throw err;
}

/**
 * CREATE IF NOT EXISTS — uso exclusivo em testes / aplicação controlada.
 * NÃO chamar a partir das APIs GET/PUT de roteamento.
 */
async function garantirSchemaCozinhaRoteamento(db) {
  if (!db) throw new Error('db obrigatório para schema cozinha_roteamento');

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_roteamento_config (
      empresa_id INTEGER PRIMARY KEY,
      modo TEXT NOT NULL
        CHECK (modo IN ('COZINHA_PADRAO', 'COZINHA_POR_SEGMENTO')),
      unidade_padrao_id INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER,
      FOREIGN KEY (empresa_id) REFERENCES empresas(id),
      FOREIGN KEY (unidade_padrao_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_roteamento_segmentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      segmento TEXT NOT NULL,
      unidade_id INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (empresa_id, segmento),
      FOREIGN KEY (empresa_id) REFERENCES empresas(id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);

  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_roteamento_seg_empresa
    ON cozinha_roteamento_segmentos(empresa_id)
  `);

  return verificarSchemaCozinhaRoteamento(db);
}

module.exports = {
  TABELAS_ROTEAMENTO,
  verificarSchemaCozinhaRoteamento,
  exigirSchemaCozinhaRoteamento,
  garantirSchemaCozinhaRoteamento
};
