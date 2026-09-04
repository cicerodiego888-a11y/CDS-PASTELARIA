/**
 * Migration 05.49 — empresa_id em pedidos (ownership explícito).
 * Backfill somente com fonte 1:1 auditável. Não inventa empresa.
 *
 * @module utils/pedidosEmpresaHelpers
 */
'use strict';

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function colunaExiste(cols, nome) {
  return (cols || []).some((c) => c.name === nome);
}

async function tabelaExiste(db, nome) {
  const row = await dbGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [nome]
  );
  return !!row;
}

async function garantirColunaEmpresaIdPedidos(db) {
  const cols = await dbAll(db, `PRAGMA table_info(pedidos)`);
  if (colunaExiste(cols, 'empresa_id')) {
    return { added: false };
  }
  await dbRun(db, `ALTER TABLE pedidos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`);
  return { added: true };
}

async function contar(db, sql, params = []) {
  const row = await dbGet(db, sql, params);
  return row && row.n != null ? Number(row.n) : 0;
}

function idsUnicos(rows, campo) {
  const set = new Set();
  for (const r of rows || []) {
    const id = Number(r[campo]);
    if (Number.isInteger(id) && id > 0) set.add(id);
  }
  return [...set];
}

/**
 * Fontes confiáveis:
 * 1) exatamente uma empresa em pedido_estoque_reservas.empresa_id
 * 2) vendas.empresa_id via pedidos.venda_id (1:1)
 * Conflito reserva×venda ou >1 empresa em reservas → ambíguo (NULL).
 */
async function backfillPedidosEmpresaId(db) {
  let fromReserva = 0;
  let fromVenda = 0;
  let ambiguos = 0;

  const ambiguosSet = new Set();

  try {
    if (await tabelaExiste(db, 'pedido_estoque_reservas')) {
      const multi = await dbAll(db, `
        SELECT pedido_id
        FROM pedido_estoque_reservas
        WHERE empresa_id IS NOT NULL
        GROUP BY pedido_id
        HAVING COUNT(DISTINCT empresa_id) > 1
      `);
      idsUnicos(multi, 'pedido_id').forEach((id) => ambiguosSet.add(id));
    }
  } catch (_e) { /* schema parcial */ }

  try {
    if (await tabelaExiste(db, 'vendas')) {
      const conflito = await dbAll(db, `
        SELECT p.id AS pedido_id
        FROM pedidos p
        INNER JOIN vendas v ON v.id = p.venda_id
        WHERE p.empresa_id IS NULL
          AND v.empresa_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM pedido_estoque_reservas r
            WHERE r.pedido_id = p.id
              AND r.empresa_id IS NOT NULL
              AND r.empresa_id <> v.empresa_id
          )
      `);
      idsUnicos(conflito, 'pedido_id').forEach((id) => ambiguosSet.add(id));
    }
  } catch (_e2) { /* vendas/reservas ausentes */ }

  ambiguos = ambiguosSet.size;
  const hold = [...ambiguosSet];
  const holdSql = hold.length
    ? `AND id NOT IN (${hold.map(() => '?').join(',')})`
    : '';

  try {
    if (await tabelaExiste(db, 'pedido_estoque_reservas')) {
      const r1 = await dbRun(db, `
        UPDATE pedidos
        SET empresa_id = (
          SELECT MIN(r.empresa_id)
          FROM pedido_estoque_reservas r
          WHERE r.pedido_id = pedidos.id
            AND r.empresa_id IS NOT NULL
        )
        WHERE empresa_id IS NULL
          ${holdSql}
          AND (
            SELECT COUNT(DISTINCT r.empresa_id)
            FROM pedido_estoque_reservas r
            WHERE r.pedido_id = pedidos.id
              AND r.empresa_id IS NOT NULL
          ) = 1
      `, hold);
      fromReserva = r1 && r1.changes != null ? Number(r1.changes) : 0;
    }
  } catch (_e3) { /* ignore */ }

  try {
    if (await tabelaExiste(db, 'vendas')) {
      const r2 = await dbRun(db, `
        UPDATE pedidos
        SET empresa_id = (
          SELECT v.empresa_id
          FROM vendas v
          WHERE v.id = pedidos.venda_id
            AND v.empresa_id IS NOT NULL
        )
        WHERE empresa_id IS NULL
          ${holdSql}
          AND venda_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM vendas v
            WHERE v.id = pedidos.venda_id
              AND v.empresa_id IS NOT NULL
          )
      `, hold);
      fromVenda = r2 && r2.changes != null ? Number(r2.changes) : 0;
    }
  } catch (_e4) { /* ignore */ }

  return { fromReserva, fromVenda, ambiguos };
}

async function migrarEmpresaIdPedidos(db) {
  if (!db) {
    return {
      added: false,
      total: 0,
      classificados: 0,
      fromReserva: 0,
      fromVenda: 0,
      ambiguos: 0,
      semClassificacao: 0,
      skipped: true
    };
  }

  if (!(await tabelaExiste(db, 'pedidos'))) {
    return {
      added: false,
      total: 0,
      classificados: 0,
      fromReserva: 0,
      fromVenda: 0,
      ambiguos: 0,
      semClassificacao: 0,
      skipped: true
    };
  }

  const col = await garantirColunaEmpresaIdPedidos(db);
  const total = await contar(db, `SELECT COUNT(*) AS n FROM pedidos`);
  const bf = await backfillPedidosEmpresaId(db);
  const semClassificacao = await contar(
    db,
    `SELECT COUNT(*) AS n FROM pedidos WHERE empresa_id IS NULL`
  );
  const classificados = Math.max(0, total - semClassificacao);

  try {
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pedidos_empresa_id ON pedidos(empresa_id)`);
  } catch (_idx) { /* ignore */ }

  return {
    added: col.added,
    total,
    classificados,
    fromReserva: bf.fromReserva,
    fromVenda: bf.fromVenda,
    ambiguos: bf.ambiguos,
    semClassificacao,
    skipped: false
  };
}

function formatarLogMigracaoPedidos(info) {
  if (!info || info.skipped) return '';
  return (
    `MIGRATION_PEDIDOS_EMPRESA_05_49\n` +
    `TOTAL: ${info.total}\n` +
    `CLASSIFICADOS: ${info.classificados}\n` +
    `VIA_RESERVA: ${info.fromReserva}\n` +
    `VIA_VENDA: ${info.fromVenda}\n` +
    `AMBIGUOS: ${info.ambiguos}\n` +
    `SEM_CLASSIFICACAO: ${info.semClassificacao}`
  );
}

function sqlFiltroEmpresaPedido(alias, empresaId, params = []) {
  const col = alias ? `${alias}.empresa_id` : 'empresa_id';
  params.push(Number(empresaId));
  return `${col} = ?`;
}

module.exports = {
  migrarEmpresaIdPedidos,
  backfillPedidosEmpresaId,
  garantirColunaEmpresaIdPedidos,
  formatarLogMigracaoPedidos,
  sqlFiltroEmpresaPedido
};
