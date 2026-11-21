'use strict';

function executar(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function consultar(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function consultarTodos(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function verificarAmbienteIsolado() {
  if (
    process.env.CDS_BLOQUEAR_BANCO_OFICIAL !== '1'
    || process.env.CDS_TEST_ISOLATION !== '1'
    || process.env.CDS_FORCAR_LOCAL !== '1'
    || !process.env.DB_DIR
    || process.env.CDS_ALLOW_OFFICIAL_DB
  ) {
    const err = new Error('Migration bloqueada: banco temporário isolado obrigatório.');
    err.codigo = 'LEDGER_MIGRACAO_ISOLAMENTO_INVALIDO';
    err.statusCode = 400;
    throw err;
  }
}

async function obterColunas(db, tabela) {
  return consultarTodos(db, `PRAGMA table_info("${tabela.replace(/"/g, '""')}")`);
}

async function exigirPrecondicoes(db) {
  for (const tabela of [
    'empresas',
    'usuarios',
    'pedidos',
    'pedidos_itens',
    'cozinha_unidades',
    'cozinha_rodadas',
    'cozinha_itens',
    'cozinha_idempotencia'
  ]) {
    const existe = await consultar(
      db,
      "SELECT 1 AS existe FROM sqlite_master WHERE type='table' AND name=?",
      [tabela]
    );
    if (!existe) {
      const err = new Error(`Precondição ausente: tabela ${tabela}.`);
      err.codigo = 'LEDGER_PRECONDICAO_AUSENTE';
      err.statusCode = 409;
      throw err;
    }
  }

  const colunasPedidosItens = await obterColunas(db, 'pedidos_itens');
  if (!colunasPedidosItens.some((coluna) => coluna.name === 'empresa_id')) {
    const err = new Error('Sprint 1 incompleta: pedidos_itens.empresa_id ausente.');
    err.codigo = 'LEDGER_PRECONDICAO_SPRINT1';
    err.statusCode = 409;
    throw err;
  }

  const pedidOsIndex = await consultarTodos(
    db,
    "PRAGMA index_list('pedidos')"
  );
  const pedidoItemIndex = await consultarTodos(
    db,
    "PRAGMA index_list('pedidos_itens')"
  );
  const idempotenciaIndex = await consultarTodos(
    db,
    "PRAGMA index_list('cozinha_idempotencia')"
  );

  async function indiceCompostoUnico(tableName, columns, indexes) {
    for (const entrada of indexes) {
      if (entrada.unique !== 1) continue;
      const info = await consultarTodos(
        db,
        `PRAGMA index_info("${String(entrada.name).replace(/"/g, '""')}")`
      );
      const nomes = info.map((coluna) => coluna.name);
      if (columns.every((coluna, indice) => nomes[indice] === coluna)
        && nomes.length === columns.length) return true;
    }
    return false;
  }

  if (!await indiceCompostoUnico('pedidos', ['id', 'empresa_id'], pedidOsIndex)) {
    const err = new Error('Sprint 1 incompleta: falta índice UNIQUE pedidos(id, empresa_id).');
    err.codigo = 'LEDGER_PRECONDICAO_PEDIDOS_INDEX';
    err.statusCode = 409;
    throw err;
  }
  if (!await indiceCompostoUnico(
    'pedidos_itens',
    ['id', 'pedido_id', 'empresa_id'],
    pedidoItemIndex
  )) {
    const err = new Error(
      'Sprint 1 incompleta: falta índice UNIQUE pedidos_itens(id, pedido_id, empresa_id).'
    );
    err.codigo = 'LEDGER_PRECONDICAO_PEDIDO_ITEM_INDEX';
    err.statusCode = 409;
    throw err;
  }

  let idempotenciaUnica = false;
  for (const entrada of idempotenciaIndex) {
    if (entrada.unique !== 1) continue;
    const info = await consultarTodos(
      db,
      `PRAGMA index_info("${String(entrada.name).replace(/"/g, '""')}")`
    );
    if (info.length === 1 && info[0].name === 'idempotency_key') {
      idempotenciaUnica = true;
      break;
    }
  }
  if (!idempotenciaUnica) {
    const err = new Error(
      'Idempotência central inválida: falta UNIQUE(idempotency_key) em cozinha_idempotencia.'
    );
    err.codigo = 'LEDGER_IDEMPOTENCIA_UNICA_AUSENTE';
    err.statusCode = 409;
    throw err;
  }
}

const DDL_RETIRADA = `
CREATE TABLE IF NOT EXISTS cozinha_retirada_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  unidade_id INTEGER NOT NULL,
  pedido_id INTEGER NOT NULL,
  pedido_item_id INTEGER NOT NULL,
  cozinha_item_id INTEGER NOT NULL,
  rodada_id INTEGER NOT NULL,
  tipo_evento TEXT NOT NULL,
  qty_millis INTEGER NOT NULL,
  operador_id INTEGER NOT NULL,
  autorizado_por_operador_id INTEGER,
  operacao_id TEXT NOT NULL,
  evento_origem_id INTEGER,
  justificativa TEXT,
  registrado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (qty_millis > 0),
  CHECK (tipo_evento IN (
    'RETIRADA_CONFIRMADA',
    'RETIRADA_ESTORNADA',
    'AJUSTE_CREDITO',
    'AJUSTE_DEBITO'
  )),
  CHECK (
    tipo_evento = 'RETIRADA_CONFIRMADA'
    AND evento_origem_id IS NULL
    OR tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_CREDITO','AJUSTE_DEBITO')
      AND evento_origem_id IS NOT NULL
      AND autorizado_por_operador_id IS NOT NULL
      AND length(trim(COALESCE(justificativa, ''))) > 0
  ),
  UNIQUE (id, empresa_id),
  UNIQUE (empresa_id, operacao_id),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  FOREIGN KEY (unidade_id, empresa_id)
    REFERENCES cozinha_unidades(id, empresa_id),
  FOREIGN KEY (pedido_id, empresa_id)
    REFERENCES pedidos(id, empresa_id),
  FOREIGN KEY (pedido_item_id, pedido_id, empresa_id)
    REFERENCES pedidos_itens(id, pedido_id, empresa_id),
  FOREIGN KEY (
    cozinha_item_id,
    empresa_id,
    unidade_id,
    rodada_id,
    pedido_id,
    pedido_item_id
  ) REFERENCES cozinha_itens(
    id,
    empresa_id,
    unidade_id,
    rodada_id,
    pedido_id,
    pedido_item_id
  ),
  FOREIGN KEY (rodada_id, unidade_id, empresa_id)
    REFERENCES cozinha_rodadas(id, unidade_id, empresa_id),
  FOREIGN KEY (operador_id) REFERENCES usuarios(id),
  FOREIGN KEY (autorizado_por_operador_id) REFERENCES usuarios(id),
  FOREIGN KEY (evento_origem_id, empresa_id)
    REFERENCES cozinha_retirada_itens(id, empresa_id)
)`;

const DDL_CANCELAMENTO = `
CREATE TABLE IF NOT EXISTS cozinha_cancelamento_itens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  unidade_id INTEGER NOT NULL,
  pedido_id INTEGER NOT NULL,
  pedido_item_id INTEGER NOT NULL,
  cozinha_item_id INTEGER NOT NULL,
  rodada_id INTEGER NOT NULL,
  tipo_evento TEXT NOT NULL,
  qty_millis INTEGER NOT NULL,
  operador_id INTEGER NOT NULL,
  autorizado_por_operador_id INTEGER,
  operacao_id TEXT NOT NULL,
  evento_origem_id INTEGER,
  justificativa TEXT,
  registrado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (qty_millis > 0),
  CHECK (tipo_evento IN (
    'CANCELAMENTO_CONFIRMADO',
    'CANCELAMENTO_ESTORNADO'
  )),
  CHECK (
    tipo_evento = 'CANCELAMENTO_CONFIRMADO'
    AND evento_origem_id IS NULL
    OR tipo_evento = 'CANCELAMENTO_ESTORNADO'
      AND evento_origem_id IS NOT NULL
      AND autorizado_por_operador_id IS NOT NULL
      AND length(trim(COALESCE(justificativa, ''))) > 0
  ),
  UNIQUE (id, empresa_id),
  UNIQUE (empresa_id, operacao_id),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  FOREIGN KEY (unidade_id, empresa_id)
    REFERENCES cozinha_unidades(id, empresa_id),
  FOREIGN KEY (pedido_id, empresa_id)
    REFERENCES pedidos(id, empresa_id),
  FOREIGN KEY (pedido_item_id, pedido_id, empresa_id)
    REFERENCES pedidos_itens(id, pedido_id, empresa_id),
  FOREIGN KEY (
    cozinha_item_id,
    empresa_id,
    unidade_id,
    rodada_id,
    pedido_id,
    pedido_item_id
  ) REFERENCES cozinha_itens(
    id,
    empresa_id,
    unidade_id,
    rodada_id,
    pedido_id,
    pedido_item_id
  ),
  FOREIGN KEY (rodada_id, unidade_id, empresa_id)
    REFERENCES cozinha_rodadas(id, unidade_id, empresa_id),
  FOREIGN KEY (operador_id) REFERENCES usuarios(id),
  FOREIGN KEY (autorizado_por_operador_id) REFERENCES usuarios(id),
  FOREIGN KEY (evento_origem_id, empresa_id)
    REFERENCES cozinha_cancelamento_itens(id, empresa_id)
)`;

async function criarTriggers(db) {
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_retirada_confirmada_limite
    BEFORE INSERT ON cozinha_retirada_itens
    WHEN NEW.tipo_evento = 'RETIRADA_CONFIRMADA'
    BEGIN
      SELECT CASE
        WHEN NEW.evento_origem_id IS NOT NULL
          THEN RAISE(ABORT, 'retirada confirmada nao pode apontar origem')
      END;
      SELECT CASE
        WHEN NEW.qty_millis + COALESCE((
          SELECT SUM(
            CASE WHEN tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO')
              THEN qty_millis ELSE 0 END
            - CASE WHEN tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO')
              THEN qty_millis ELSE 0 END
          )
          FROM cozinha_retirada_itens
          WHERE empresa_id = NEW.empresa_id
            AND cozinha_item_id = NEW.cozinha_item_id
        ), 0)
        >
        (
          SELECT COALESCE(qty_solicitada_millis - qty_cancelada_millis, 0)
          FROM cozinha_itens
          WHERE id = NEW.cozinha_item_id
            AND empresa_id = NEW.empresa_id
            AND unidade_id = NEW.unidade_id
            AND rodada_id = NEW.rodada_id
            AND pedido_id = NEW.pedido_id
            AND pedido_item_id = NEW.pedido_item_id
        )
        THEN RAISE(ABORT, 'retirada excede exigivel individual')
      END;
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_retirada_ajuste_limite
    BEFORE INSERT ON cozinha_retirada_itens
    WHEN NEW.tipo_evento IN ('AJUSTE_CREDITO','AJUSTE_DEBITO')
    BEGIN
      SELECT CASE
        WHEN NEW.tipo_evento = 'AJUSTE_CREDITO'
          AND NEW.qty_millis + COALESCE((
            SELECT SUM(
              CASE WHEN tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO')
                THEN qty_millis ELSE 0 END
              - CASE WHEN tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO')
                THEN qty_millis ELSE 0 END
            )
            FROM cozinha_retirada_itens
            WHERE empresa_id = NEW.empresa_id
              AND cozinha_item_id = NEW.cozinha_item_id
          ), 0)
          >
          (
            SELECT COALESCE(qty_solicitada_millis - qty_cancelada_millis, 0)
            FROM cozinha_itens
            WHERE id = NEW.cozinha_item_id
              AND empresa_id = NEW.empresa_id
              AND unidade_id = NEW.unidade_id
              AND rodada_id = NEW.rodada_id
              AND pedido_id = NEW.pedido_id
              AND pedido_item_id = NEW.pedido_item_id
          )
        THEN RAISE(ABORT, 'ajuste credito excede exigivel')
      END;
      SELECT CASE
        WHEN NEW.tipo_evento = 'AJUSTE_DEBITO'
          AND NEW.qty_millis > COALESCE((
            SELECT SUM(
              CASE WHEN tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO')
                THEN qty_millis ELSE 0 END
              - CASE WHEN tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO')
                THEN qty_millis ELSE 0 END
            )
            FROM cozinha_retirada_itens
            WHERE empresa_id = NEW.empresa_id
              AND cozinha_item_id = NEW.cozinha_item_id
          ), 0)
        THEN RAISE(ABORT, 'ajuste debito produziria saldo negativo')
      END;
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_cancelamento_confirmado_limite
    BEFORE INSERT ON cozinha_cancelamento_itens
    WHEN NEW.tipo_evento = 'CANCELAMENTO_CONFIRMADO'
    BEGIN
      SELECT CASE
        WHEN NEW.evento_origem_id IS NOT NULL
          THEN RAISE(ABORT, 'cancelamento confirmado nao pode apontar origem')
      END;
      SELECT CASE
        WHEN NEW.qty_millis + COALESCE((
          SELECT SUM(
            CASE WHEN tipo_evento='CANCELAMENTO_CONFIRMADO'
              THEN qty_millis ELSE 0 END
            - CASE WHEN tipo_evento='CANCELAMENTO_ESTORNADO'
              THEN qty_millis ELSE 0 END
          )
          FROM cozinha_cancelamento_itens
          WHERE empresa_id = NEW.empresa_id
            AND cozinha_item_id = NEW.cozinha_item_id
        ), 0)
        >
        (
          SELECT COALESCE(qty_solicitada_millis - (
            SELECT COALESCE(SUM(
              CASE WHEN r.tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO')
                THEN r.qty_millis ELSE 0 END
              - CASE WHEN r.tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO')
                THEN r.qty_millis ELSE 0 END
            ),0)
            FROM cozinha_retirada_itens r
            WHERE r.empresa_id = NEW.empresa_id
              AND r.cozinha_item_id = NEW.cozinha_item_id
          ),0)
          FROM cozinha_itens
          WHERE id = NEW.cozinha_item_id
            AND empresa_id = NEW.empresa_id
            AND unidade_id = NEW.unidade_id
            AND rodada_id = NEW.rodada_id
            AND pedido_id = NEW.pedido_id
            AND pedido_item_id = NEW.pedido_item_id
        )
        THEN RAISE(ABORT, 'cancelamento excede quantidade disponivel')
      END;
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_retirada_itens_no_update
    BEFORE UPDATE ON cozinha_retirada_itens
    BEGIN
      SELECT RAISE(ABORT, 'cozinha_retirada_itens append-only');
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_retirada_itens_no_delete
    BEFORE DELETE ON cozinha_retirada_itens
    BEGIN
      SELECT RAISE(ABORT, 'cozinha_retirada_itens append-only');
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_retirada_estorno_valido
    BEFORE INSERT ON cozinha_retirada_itens
    WHEN NEW.tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_CREDITO','AJUSTE_DEBITO')
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM cozinha_retirada_itens origem
          WHERE origem.id = NEW.evento_origem_id
            AND origem.empresa_id = NEW.empresa_id
            AND origem.tipo_evento IN (
              'RETIRADA_CONFIRMADA',
              'AJUSTE_CREDITO',
              'AJUSTE_DEBITO'
            )
            AND origem.unidade_id = NEW.unidade_id
            AND origem.pedido_id = NEW.pedido_id
            AND origem.pedido_item_id = NEW.pedido_item_id
            AND origem.cozinha_item_id = NEW.cozinha_item_id
            AND origem.rodada_id = NEW.rodada_id
        ) THEN RAISE(ABORT, 'referencia de retirada invalida')
      END;
      SELECT CASE
        WHEN NEW.tipo_evento = 'RETIRADA_ESTORNADA'
          AND NEW.qty_millis > (
            SELECT origem.qty_millis
              - COALESCE((
                SELECT SUM(est.qty_millis)
                FROM cozinha_retirada_itens est
                WHERE est.evento_origem_id = NEW.evento_origem_id
                  AND est.empresa_id = NEW.empresa_id
                  AND est.tipo_evento = 'RETIRADA_ESTORNADA'
              ), 0)
            FROM cozinha_retirada_itens origem
            WHERE origem.id = NEW.evento_origem_id
              AND origem.empresa_id = NEW.empresa_id
          )
        THEN RAISE(ABORT, 'estorno superior ao evento original')
      END;
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_cancelamento_itens_no_update
    BEFORE UPDATE ON cozinha_cancelamento_itens
    BEGIN
      SELECT RAISE(ABORT, 'cozinha_cancelamento_itens append-only');
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_cancelamento_itens_no_delete
    BEFORE DELETE ON cozinha_cancelamento_itens
    BEGIN
      SELECT RAISE(ABORT, 'cozinha_cancelamento_itens append-only');
    END
  `);
  await executar(db, `
    CREATE TRIGGER IF NOT EXISTS trg_cozinha_cancelamento_estorno_valido
    BEFORE INSERT ON cozinha_cancelamento_itens
    WHEN NEW.tipo_evento = 'CANCELAMENTO_ESTORNADO'
    BEGIN
      SELECT CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM cozinha_cancelamento_itens origem
          WHERE origem.id = NEW.evento_origem_id
            AND origem.empresa_id = NEW.empresa_id
            AND origem.tipo_evento = 'CANCELAMENTO_CONFIRMADO'
            AND origem.unidade_id = NEW.unidade_id
            AND origem.pedido_id = NEW.pedido_id
            AND origem.pedido_item_id = NEW.pedido_item_id
            AND origem.cozinha_item_id = NEW.cozinha_item_id
            AND origem.rodada_id = NEW.rodada_id
        ) THEN RAISE(ABORT, 'referencia de cancelamento invalida')
      END;
      SELECT CASE
        WHEN NEW.qty_millis > (
          SELECT origem.qty_millis
            - COALESCE((
              SELECT SUM(est.qty_millis)
              FROM cozinha_cancelamento_itens est
              WHERE est.evento_origem_id = NEW.evento_origem_id
                AND est.empresa_id = NEW.empresa_id
                AND est.tipo_evento = 'CANCELAMENTO_ESTORNADO'
            ), 0)
          FROM cozinha_cancelamento_itens origem
          WHERE origem.id = NEW.evento_origem_id
            AND origem.empresa_id = NEW.empresa_id
        )
        THEN RAISE(ABORT, 'estorno de cancelamento superior ao original')
      END;
    END
  `);
}

async function criarIndices(db) {
  await executar(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_rodadas_id_unidade_empresa
    ON cozinha_rodadas(id, unidade_id, empresa_id)
  `);
  await executar(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_itens_vinculo_retirada
    ON cozinha_itens(
      id,
      empresa_id,
      unidade_id,
      rodada_id,
      pedido_id,
      pedido_item_id
    )
  `);
  await executar(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_retirada_itens_saldo
    ON cozinha_retirada_itens(
      empresa_id,
      unidade_id,
      pedido_id,
      pedido_item_id,
      cozinha_item_id,
      rodada_id,
      tipo_evento
    )
  `);
  await executar(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_retirada_itens_operacao
    ON cozinha_retirada_itens(empresa_id, operacao_id)
  `);
  await executar(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_retirada_itens_origem
    ON cozinha_retirada_itens(empresa_id, evento_origem_id)
  `);
  await executar(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_cancelamento_itens_saldo
    ON cozinha_cancelamento_itens(
      empresa_id,
      unidade_id,
      pedido_id,
      pedido_item_id,
      cozinha_item_id,
      rodada_id,
      tipo_evento
    )
  `);
  await executar(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_cancelamento_itens_operacao
    ON cozinha_cancelamento_itens(empresa_id, operacao_id)
  `);
  await executar(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_cancelamento_itens_origem
    ON cozinha_cancelamento_itens(empresa_id, evento_origem_id)
  `);
}

async function executarMigracaoSprint2(db, opts = {}) {
  if (!opts.isolamentoExplicito) verificarAmbienteIsolado();

  await executar(db, 'PRAGMA foreign_keys = ON');
  await exigirPrecondicoes(db);

  for (const tabela of ['cozinha_retirada_itens', 'cozinha_cancelamento_itens']) {
    const existente = await consultar(
      db,
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
      [tabela]
    );
    if (existente?.sql) {
      const sql = String(existente.sql).toUpperCase();
      if (!sql.includes('EMPRESA_ID') || !sql.includes('OPERACAO_ID') || !sql.includes('EVENTO_ORIGEM_ID')) {
        const err = new Error(`Ledger existente incompatível: ${tabela}.`);
        err.codigo = 'LEDGER_SCHEMA_INCOMPATIVEL';
        throw err;
      }
      const cols = await consultarTodos(db, `PRAGMA table_info("${tabela}")`);
      const names = new Set(cols.map((col) => col.name));
      for (const nome of [
        'id','empresa_id','unidade_id','pedido_id','pedido_item_id','cozinha_item_id',
        'rodada_id','tipo_evento','qty_millis','operador_id','operacao_id','evento_origem_id'
      ]) {
        if (!names.has(nome)) {
          const err = new Error(`Ledger existente incompleto: ${tabela}.${nome}.`);
          err.codigo = 'LEDGER_SCHEMA_INCOMPATIVEL';
          throw err;
        }
      }
    }
  }

  let iniciouTransacao = false;
  try {
    await executar(db, 'BEGIN IMMEDIATE');
    iniciouTransacao = true;

    await executar(db, DDL_RETIRADA);
    await executar(db, DDL_CANCELAMENTO);
    await criarIndices(db);
    await criarTriggers(db);

    const foreignKeyCheckAntesCommit = [
      ...(await consultarTodos(
        db,
        'PRAGMA foreign_key_check("cozinha_retirada_itens")'
      )),
      ...(await consultarTodos(
        db,
        'PRAGMA foreign_key_check("cozinha_cancelamento_itens")'
      ))
    ];
    if (foreignKeyCheckAntesCommit.length) {
      const err = new Error('Migration Sprint 2 abortada: violação de foreign key antes do COMMIT.');
      err.codigo = 'LEDGER_FOREIGN_KEY_CHECK_PRECOMMIT';
      err.detalhes = foreignKeyCheckAntesCommit;
      throw err;
    }

    await executar(db, 'COMMIT');
    iniciouTransacao = false;
  } catch (erroPrincipal) {
    if (iniciouTransacao) {
      try {
        await executar(db, 'ROLLBACK');
      } catch (_rollbackError) {
      }
    }
    throw erroPrincipal;
  }

  const foreignKeys = await consultar(db, 'PRAGMA foreign_keys');
  const foreignKeyCheck = [
    ...(await consultarTodos(
      db,
      'PRAGMA foreign_key_check("cozinha_retirada_itens")'
    )),
    ...(await consultarTodos(
      db,
      'PRAGMA foreign_key_check("cozinha_cancelamento_itens")'
    ))
  ];

  return {
    success: true,
    foreignKeysEnabled:
      Number(
        foreignKeys?.foreign_keys != null
          ? foreignKeys.foreign_keys
          : Object.values(foreignKeys || {})[0]
      ) === 1,
    foreignKeyCheck
  };
}

module.exports = {
  DDL_RETIRADA,
  DDL_CANCELAMENTO,
  executarMigracaoSprint2,
  verificarAmbienteIsolado
};
