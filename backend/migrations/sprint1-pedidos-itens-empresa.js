'use strict';

function executarSql(db, sql, params = []) {
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

function escutarNome(nome) {
  return '"' + String(nome).replace(/"/g, '""') + '"';
}

function verificarAmbienteIsolado() {
  if (process.env.CDS_BLOQUEAR_BANCO_OFICIAL !== '1'
    || process.env.CDS_TEST_ISOLATION !== '1'
    || process.env.CDS_FORCAR_LOCAL !== '1'
    || !process.env.DB_DIR
    || process.env.CDS_ALLOW_OFFICIAL_DB) {
    const err = new Error(
      'Migração bloqueada: execução exigível somente com banco temporário isolado.'
    );
    err.codigo = 'MIGRACAO_ISOLAMENTO_INVALIDO';
    err.statusCode = 400;
    throw err;
  }
}

async function obterColunas(db, tabela) {
  return consultarTodos(db, `PRAGMA table_info(${escutarNome(tabela)})`);
}

async function obterIndices(db, tabela) {
  return consultarTodos(db, `PRAGMA index_list(${escutarNome(tabela)})`);
}

async function obterIndicesCriados(db, tabela) {
  const lista = await obterIndices(db, tabela);
  const criados = [];
  for (const entrada of lista) {
    if (String(entrada.name || '').startsWith('sqlite_')) continue;
    const objeto = await consultar(
      db,
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name=?",
      [entrada.name]
    );
    if (objeto?.sql) criados.push(objeto);
  }
  return criados;
}

async function obterForeignKeys(db, tabela) {
  return consultarTodos(db, `PRAGMA foreign_key_list(${escutarNome(tabela)})`);
}

async function obterTriggers(db, tabela) {
  return consultarTodos(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name",
    [tabela]
  );
}

function tipoSqlColuna(coluna) {
  let sql = escutarNome(coluna.name);
  sql += coluna.type ? ' ' + coluna.type : '';
  if (Number(coluna.pk) === 1 && String(coluna.type || '').toUpperCase() === 'INTEGER') {
    sql = escutarNome(coluna.name) + ' INTEGER PRIMARY KEY';
  }
  if (Number(coluna.notnull) === 1 && Number(coluna.pk) !== 1) sql += ' NOT NULL';
  if (coluna.dflt_value != null) sql += ' DEFAULT ' + coluna.dflt_value;
  return sql;
}

async function validarPendencias(db) {
  const pedidoAusente = await consultar(db, `
    SELECT pi.id AS pedido_item_id
    FROM pedidos_itens pi
    LEFT JOIN pedidos p ON p.id = pi.pedido_id
    WHERE p.id IS NULL
    LIMIT 1
  `);
  if (pedidoAusente) {
    const err = new Error(
      `Migração abortada: pedidos_itens órfão (id=${pedidoAusente.pedido_item_id}).`
    );
    err.codigo = 'PEDIDOS_ITENS_ORFAO';
    err.statusCode = 409;
    throw err;
  }

  const pedidoSemEmpresa = await consultar(db, `
    SELECT p.id AS pedido_id
    FROM pedidos_itens pi
    JOIN pedidos p ON p.id = pi.pedido_id
    WHERE p.empresa_id IS NULL
    LIMIT 1
  `);
  if (pedidoSemEmpresa) {
    const err = new Error(
      `Migração abortada: pedido ${pedidoSemEmpresa.pedido_id} não possui empresa_id.`
    );
    err.codigo = 'PEDIDO_EMPRESA_AUSENTE';
    err.statusCode = 409;
    throw err;
  }

  const divergencia = await consultar(db, `
    SELECT pi.id AS pedido_item_id, pi.empresa_id AS item_empresa,
           p.empresa_id AS pedido_empresa
    FROM pedidos_itens pi
    JOIN pedidos p ON p.id = pi.pedido_id
    WHERE pi.empresa_id IS NOT NULL
      AND pi.empresa_id != p.empresa_id
    LIMIT 1
  `);
  if (divergencia) {
    const err = new Error(
      `Migração abortada: empresa divergente no pedido_item ${divergencia.pedido_item_id}.`
    );
    err.codigo = 'PEDIDO_ITEM_EMPRESA_DIVERGENTE';
    err.statusCode = 409;
    throw err;
  }
}

async function executarMigracaoSprint1(db, opts = {}) {
  if (!opts.isolamentoExplicito) verificarAmbienteIsolado();

  const estadoFkAntes = await consultar(db, 'PRAGMA foreign_keys');
  const fkAntes = Number(
    estadoFkAntes?.foreign_keys != null
      ? estadoFkAntes.foreign_keys
      : Object.values(estadoFkAntes || {})[0]
  ) === 1;

  const antes = await consultar(db, 'SELECT COUNT(*) AS total FROM pedidos_itens');
  const countAntes = Number(antes?.total || 0);

  const schemaAntes = await consultar(
    db,
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='pedidos_itens'"
  );
  const colunasAntes = await obterColunas(db, 'pedidos_itens');
  const indicesAntes = await obterIndicesCriados(db, 'pedidos_itens');
  const triggersAntes = await obterTriggers(db, 'pedidos_itens');

  await executarSql(db, 'PRAGMA foreign_keys = OFF');
  let iniciouTransacao = false;

  try {
    await executarSql(db, 'BEGIN IMMEDIATE');
    iniciouTransacao = true;

    const temEmpresa = colunasAntes.some((coluna) => coluna.name === 'empresa_id');
    if (!temEmpresa) {
      await executarSql(
        db,
        'ALTER TABLE pedidos_itens ADD COLUMN empresa_id INTEGER'
      );
    }

    await validarPendencias(db);

    await executarSql(db, `
      UPDATE pedidos_itens
      SET empresa_id = (
        SELECT p.empresa_id
        FROM pedidos p
        WHERE p.id = pedidos_itens.pedido_id
      )
      WHERE empresa_id IS NULL
    `);

    await validarPendencias(db);

    await executarSql(
      db,
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_id_empresa ON pedidos(id, empresa_id)'
    );
    await executarSql(
      db,
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_itens_id_pedido_empresa ON pedidos_itens(id, pedido_id, empresa_id)'
    );

    const colunasDepoisAdd = await obterColunas(db, 'pedidos_itens');
    const foreignKeys = await obterForeignKeys(db, 'pedidos_itens');
    const fkPedidoComposta = (() => {
      const refs = foreignKeys.filter((fk) => String(fk.table) === 'pedidos');
      const porId = refs.find((fk) => fk.from === 'pedido_id' && fk.to === 'id');
      const porEmpresa = refs.find((fk) => fk.from === 'empresa_id' && fk.to === 'empresa_id');
      return !!porId && !!porEmpresa;
    })();
    const precisaReconstruir = !fkPedidoComposta;

    if (precisaReconstruir) {
      const indicesOriginais = await obterIndicesCriados(db, 'pedidos_itens');
      const triggersOriginais = await obterTriggers(db, 'pedidos_itens');

      await executarSql(
        db,
        'DROP TABLE IF EXISTS pedidos_itens__sprint1'
      );

      const sqlTabelaOriginal = await consultar(
        db,
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='pedidos_itens'"
      );
      let sqlTabelaTemp;
      if (sqlTabelaOriginal?.sql) {
        sqlTabelaTemp = sqlTabelaOriginal.sql
          .replace(/CREATE\s+TABLE\s+["`]?[A-Za-z0-9_]+["`]?/i, 'CREATE TABLE pedidos_itens__sprint1');
        if (!/empresa_id/i.test(sqlTabelaTemp)) {
          const ultimoFechamento = sqlTabelaTemp.lastIndexOf(')');
          if (ultimoFechamento < 0) {
            throw new Error('DDL de pedidos_itens não pôde ser reconstruído com segurança.');
          }
          sqlTabelaTemp =
            sqlTabelaTemp.slice(0, ultimoFechamento)
            + ',\n  empresa_id INTEGER NOT NULL'
            + sqlTabelaTemp.slice(ultimoFechamento);
        }
        const ultimoFechamento = sqlTabelaTemp.lastIndexOf(')');
        sqlTabelaTemp =
          sqlTabelaTemp.slice(0, ultimoFechamento)
          + ',\n  UNIQUE (id, pedido_id, empresa_id)'
          + ',\n  FOREIGN KEY (pedido_id, empresa_id) REFERENCES pedidos(id, empresa_id)'
          + sqlTabelaTemp.slice(ultimoFechamento);
      } else {
        const colunasNova = colunasDepoisAdd.map(tipoSqlColuna).join(',\n');
        sqlTabelaTemp = `
          CREATE TABLE pedidos_itens__sprint1 (
            ${colunasNova},
            UNIQUE (id, pedido_id, empresa_id),
            FOREIGN KEY (pedido_id, empresa_id) REFERENCES pedidos(id, empresa_id)
          )
        `;
      }
      await executarSql(db, sqlTabelaTemp);

      const nomesColunas = colunasDepoisAdd.map((coluna) => escutarNome(coluna.name));
      await executarSql(db, `
        INSERT INTO pedidos_itens__sprint1 (${nomesColunas.join(', ')})
        SELECT ${nomesColunas.join(', ')}
        FROM pedidos_itens
      `);

      await executarSql(db, 'DROP TABLE pedidos_itens');
      await executarSql(
        db,
        'ALTER TABLE pedidos_itens__sprint1 RENAME TO pedidos_itens'
      );

      for (const indice of indicesOriginais) {
        if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(String(indice.sql))) {
          await executarSql(db, indice.sql);
        }
      }
      for (const trigger of triggersOriginais) {
        if (trigger.sql) await executarSql(db, trigger.sql);
      }
    }

    const foreignKeyCheckAntesCommit = await consultarTodos(
      db,
      'PRAGMA foreign_key_check("pedidos_itens")'
    );
    if (foreignKeyCheckAntesCommit.length) {
      const err = new Error(
        'Migração abortada: violação de foreign key antes do COMMIT.'
      );
      err.codigo = 'PEDIDOS_ITENS_FOREIGN_KEY_CHECK_PRECOMMIT';
      err.detalhes = foreignKeyCheckAntesCommit;
      throw err;
    }

    await executarSql(db, 'COMMIT');
    iniciouTransacao = false;
  } catch (erroPrincipal) {
    if (iniciouTransacao) {
      try {
        await executarSql(db, 'ROLLBACK');
      } catch (_rollbackError) {
      }
    }
    throw erroPrincipal;
  } finally {
    await executarSql(db, fkAntes ? 'PRAGMA foreign_keys = ON' : 'PRAGMA foreign_keys = OFF');
  }

  const depois = await consultar(db, 'SELECT COUNT(*) AS total FROM pedidos_itens');
  const countDepois = Number(depois?.total || 0);
  if (countAntes !== countDepois) {
    const err = new Error(
      `Migração abortada: quantidade de pedidos_itens mudou (${countAntes} -> ${countDepois}).`
    );
    err.codigo = 'PEDIDOS_ITENS_CONTAGEM_DIVERGENTE';
    throw err;
  }

  await validarPendencias(db);

  const foreignKeysEnabled = await consultar(db, 'PRAGMA foreign_keys');
  const foreignKeyCheck = await consultarTodos(
    db,
    'PRAGMA foreign_key_check("pedidos_itens")'
  );
  if (foreignKeyCheck.length) {
    const err = new Error('Migração concluiu com violação de foreign key.');
    err.codigo = 'PEDIDOS_ITENS_FOREIGN_KEY_CHECK';
    err.detalhes = foreignKeyCheck;
    throw err;
  }

  const colunasDepois = await obterColunas(db, 'pedidos_itens');
  const indicesDepois = await obterIndicesCriados(db, 'pedidos_itens');
  const triggersDepois = await obterTriggers(db, 'pedidos_itens');

  return {
    success: true,
    reexecutada: false,
    countAntes,
    countDepois,
    schemaAntes: schemaAntes?.sql || null,
    colunasAntes,
    colunasDepois,
    indicesAntes,
    indicesDepois,
    triggersAntes,
    triggersDepois,
    foreignKeysEnabled: Number(
      foreignKeysEnabled?.foreign_keys != null
        ? foreignKeysEnabled.foreign_keys
        : Object.values(foreignKeysEnabled || {})[0]
    ) === 1,
    foreignKeyCheck
  };
}

module.exports = {
  executarMigracaoSprint1,
  validarPendencias,
  verificarAmbienteIsolado
};
