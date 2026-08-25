/**
 * Migration 05.40 — empresa_id em vendas (ownership explícito).
 * Não inventa empresa. Não preenche NULL restante com operacional.
 *
 * @module utils/vendasEmpresaHelpers
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

async function garantirColunaEmpresaIdVendas(db) {
  const cols = await dbAll(db, `PRAGMA table_info(vendas)`);
  if (colunaExiste(cols, 'empresa_id')) {
    return { added: false };
  }
  await dbRun(db, `ALTER TABLE vendas ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`);
  return { added: true };
}

async function contarVendas(db, sql, params = []) {
  const row = await dbGet(db, sql, params);
  return row && row.n != null ? Number(row.n) : 0;
}

/**
 * Backfill auditável.
 * P1: caixa_sessoes.empresa_id via vendas.caixa_sessao_id
 * P2: atendimento_operacoes.empresa_id via venda_id (MUV)
 * Restante: NULL (legado não classificado)
 */
async function backfillVendasEmpresaId(db) {
  let fromCaixa = 0;
  let fromMuv = 0;

  try {
    const r1 = await dbRun(db, `
      UPDATE vendas
      SET empresa_id = (
        SELECT cs.empresa_id
        FROM caixa_sessoes cs
        WHERE cs.id = vendas.caixa_sessao_id
          AND cs.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND caixa_sessao_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM caixa_sessoes cs
          WHERE cs.id = vendas.caixa_sessao_id
            AND cs.empresa_id IS NOT NULL
        )
    `);
    fromCaixa = r1 && r1.changes != null ? Number(r1.changes) : 0;
  } catch (_e) { /* schema parcial em testes */ }

  try {
    if (await tabelaExiste(db, 'atendimento_operacoes')) {
      const r2 = await dbRun(db, `
        UPDATE vendas
        SET empresa_id = (
          SELECT ao.empresa_id
          FROM atendimento_operacoes ao
          WHERE ao.venda_id = vendas.id
            AND ao.empresa_id IS NOT NULL
          LIMIT 1
        )
        WHERE empresa_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM atendimento_operacoes ao
            WHERE ao.venda_id = vendas.id
              AND ao.empresa_id IS NOT NULL
          )
      `);
      fromMuv = r2 && r2.changes != null ? Number(r2.changes) : 0;
    }
  } catch (_e2) { /* MUV ausente */ }

  return { fromCaixa, fromMuv };
}

/**
 * Migration 05.40 — idempotente. Não apaga vendas. Não recria tabela.
 */
async function migrarEmpresaIdVendas(db) {
  if (!db) {
    return {
      added: false,
      total: 0,
      fromCaixa: 0,
      fromMuv: 0,
      naoClassificadas: 0,
      skipped: true
    };
  }

  if (!(await tabelaExiste(db, 'vendas'))) {
    return {
      added: false,
      total: 0,
      fromCaixa: 0,
      fromMuv: 0,
      naoClassificadas: 0,
      skipped: true
    };
  }

  const col = await garantirColunaEmpresaIdVendas(db);
  const total = await contarVendas(db, `SELECT COUNT(*) AS n FROM vendas`);
  const bf = await backfillVendasEmpresaId(db);
  const naoClassificadas = await contarVendas(
    db,
    `SELECT COUNT(*) AS n FROM vendas WHERE empresa_id IS NULL`
  );

  try {
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id ON vendas(empresa_id)`);
  } catch (_idx) { /* ignore */ }

  return {
    added: col.added,
    total,
    fromCaixa: bf.fromCaixa,
    fromMuv: bf.fromMuv,
    naoClassificadas,
    skipped: false
  };
}

function formatarLogMigracaoVendas(info) {
  if (!info || info.skipped) return '';
  return (
    `MIGRATION_VENDAS_EMPRESA_05_40\n` +
    `TOTAL: ${info.total}\n` +
    `CLASSIFICADAS_VIA_CAIXA: ${info.fromCaixa}\n` +
    `CLASSIFICADAS_VIA_MUV: ${info.fromMuv}\n` +
    `NÃO_CLASSIFICADAS: ${info.naoClassificadas}`
  );
}

/**
 * Filtro operacional: apenas vendas da empresa do contexto.
 * Exclui legado NULL.
 */
function sqlFiltroEmpresaVenda(alias, empresaId, params = []) {
  const col = alias ? `${alias}.empresa_id` : 'empresa_id';
  params.push(Number(empresaId));
  return `${col} = ?`;
}

module.exports = {
  migrarEmpresaIdVendas,
  backfillVendasEmpresaId,
  garantirColunaEmpresaIdVendas,
  formatarLogMigracaoVendas,
  sqlFiltroEmpresaVenda
};
