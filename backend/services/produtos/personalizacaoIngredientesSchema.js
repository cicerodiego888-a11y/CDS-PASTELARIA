'use strict';

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbRun(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function adicionarColuna(db, tabela, coluna, definicao) {
  const colunas = await dbAll(db, `PRAGMA table_info(${tabela})`);
  if (!colunas.some((item) => String(item.name).toLowerCase() === coluna.toLowerCase())) {
    await dbRun(db, `ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }
}

async function garantirSchemaFichaPersonalizacaoAsync(db) {
  await adicionarColuna(db, 'produtos', 'permite_personalizacao_ingredientes', 'INTEGER NOT NULL DEFAULT 0');
  await adicionarColuna(db, 'ficha_tecnica_itens', 'classificacao_comercial', "TEXT NOT NULL DEFAULT 'OBRIGATORIO_OCULTO'");
  await adicionarColuna(db, 'ficha_tecnica_itens', 'preco_adicional', 'REAL NOT NULL DEFAULT 0');
}

async function garantirSchemaPedidoPersonalizacaoAsync(db) {
  await adicionarColuna(db, 'pedidos_itens', 'personalizacao_ingredientes_snapshot', 'INTEGER NOT NULL DEFAULT 0');
  await adicionarColuna(db, 'pedidos_itens', 'preco_base_unitario_snapshot', 'REAL');
  await adicionarColuna(db, 'pedidos_itens', 'preco_adicionais_unitario_snapshot', 'REAL');
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      insumo_nome_snapshot TEXT NOT NULL,
      quantidade_snapshot REAL NOT NULL,
      unidade_snapshot TEXT NOT NULL,
      classificacao_comercial_snapshot TEXT NOT NULL,
      selecionado INTEGER NOT NULL,
      preco_adicional_snapshot REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (pedido_item_id, insumo_id),
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
      FOREIGN KEY (pedido_item_id) REFERENCES pedidos_itens(id) ON DELETE CASCADE,
      FOREIGN KEY (insumo_id) REFERENCES produtos(id)
    )
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_pedido_item_ingredientes_pedido
      ON pedido_item_ingredientes(pedido_id, pedido_item_id)
  `);
}

module.exports = {
  garantirSchemaFichaPersonalizacaoAsync,
  garantirSchemaPedidoPersonalizacaoAsync
};
