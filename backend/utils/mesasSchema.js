/**
 * Schema de mesas (cadastro por empresa), atendimento e histórico de transferência.
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

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS mesa_atendimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      estado TEXT NOT NULL CHECK (estado IN ('OCUPADA', 'FECHAMENTO', 'ENCERRADO')),
      cliente_id INTEGER,
      operador_abertura_id INTEGER NOT NULL,
      aberto_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      operador_encerramento_id INTEGER,
      encerrado_em TEXT,
      idempotency_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_mesa_atendimentos_ativo
    ON mesa_atendimentos(empresa_id, mesa_id)
    WHERE estado IN ('OCUPADA', 'FECHAMENTO')
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_mesa_atendimentos_idempotency
    ON mesa_atendimentos(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS mesa_atendimento_transferencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      atendimento_id INTEGER NOT NULL,
      mesa_origem_id INTEGER NOT NULL,
      mesa_destino_id INTEGER NOT NULL,
      operador_id INTEGER NOT NULL,
      transferido_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      idempotency_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK (mesa_origem_id <> mesa_destino_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_mesa_transferencias_idempotency
    ON mesa_atendimento_transferencias(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS pedido_preparacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      atendimento_id INTEGER,
      estado TEXT NOT NULL CHECK (estado IN ('NAO_ENVIADO', 'EM_PREPARACAO', 'CONCLUIDO')),
      enviado_em TEXT,
      concluido_em TEXT,
      operador_envio_id INTEGER,
      operador_conclusao_id INTEGER,
      idempotency_key_envio TEXT,
      idempotency_key_conclusao TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (
        (estado = 'NAO_ENVIADO' AND enviado_em IS NULL AND concluido_em IS NULL)
        OR (estado = 'EM_PREPARACAO' AND enviado_em IS NOT NULL AND concluido_em IS NULL)
        OR (estado = 'CONCLUIDO' AND enviado_em IS NOT NULL AND concluido_em IS NOT NULL)
      )
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pedido_preparacoes_pedido
    ON pedido_preparacoes(pedido_id)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pedido_preparacoes_envio
    ON pedido_preparacoes(idempotency_key_envio)
    WHERE idempotency_key_envio IS NOT NULL
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pedido_preparacoes_conclusao
    ON pedido_preparacoes(idempotency_key_conclusao)
    WHERE idempotency_key_conclusao IS NOT NULL
  `);

  let colunaAdicionada = false;
  let colunaAtendimentoAdicionada = false;
  const tabelaPedidos = await dbAll(db, `PRAGMA table_info(pedidos)`);
  if (tabelaPedidos.length) {
    const temMesa = tabelaPedidos.some((c) => String(c.name).toLowerCase() === 'mesa_id');
    if (!temMesa) {
      await dbRun(db, `ALTER TABLE pedidos ADD COLUMN mesa_id INTEGER`);
      colunaAdicionada = true;
    }
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pedidos_mesa_id ON pedidos(mesa_id)`);
    const temAtendimento = tabelaPedidos.some((c) => String(c.name).toLowerCase() === 'mesa_atendimento_id');
    if (!temAtendimento) {
      await dbRun(db, `ALTER TABLE pedidos ADD COLUMN mesa_atendimento_id INTEGER`);
      colunaAtendimentoAdicionada = true;
    }
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pedidos_mesa_atendimento_id ON pedidos(mesa_atendimento_id)`);
  }
  return { skipped: false, colunaAdicionada, colunaAtendimentoAdicionada };
}

module.exports = { garantirSchemaMesas };
