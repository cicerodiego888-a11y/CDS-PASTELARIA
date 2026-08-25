/**
 * Helpers SQL + migration empresa_id do domínio Compras (05.38.F.B).
 *
 * @module utils/comprasEmpresaHelpers
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

async function garantirColunaEmpresaIdCompras(db) {
  const cols = await dbAll(db, 'PRAGMA table_info(compras)');
  if (colunaExiste(cols, 'empresa_id')) {
    return { added: false };
  }
  await dbRun(
    db,
    'ALTER TABLE compras ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)'
  );
  return { added: true };
}

async function garantirIndiceEmpresaIdCompras(db) {
  await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_compras_empresa_id ON compras(empresa_id)');
}

/**
 * Empresa operacional segura (somente EMPRESA_SIMPLES / única ativa).
 * Em MULTIEMPRESA retorna null — não inventa.
 */
async function resolverEmpresaIdBackfillCompras(db, deps = {}) {
  if (typeof deps.resolverEmpresaIdBackfill === 'function') {
    return deps.resolverEmpresaIdBackfill(db);
  }

  try {
    const { resolverModoOperacionalGlobalAtivo, ModoOperacionalGlobal } =
      require('../core/modo-operacional');
    const modo = resolverModoOperacionalGlobalAtivo(deps);
    if (modo === ModoOperacionalGlobal.MULTIEMPRESA) {
      return null;
    }
  } catch (_e) { /* segue */ }

  try {
    const configService = deps.configService || require('../services/configuracaoService');
    const cfg = deps.cfg || configService.readConfig();
    const cfgId = cfg && cfg.empresa_operacional_id != null
      ? Number(cfg.empresa_operacional_id)
      : null;
    if (Number.isInteger(cfgId) && cfgId > 0) {
      const row = await dbGet(
        db,
        'SELECT id FROM empresas WHERE id = ? AND COALESCE(ativo, 1) = 1 LIMIT 1',
        [cfgId]
      );
      if (row) return Number(row.id);
    }
  } catch (_e2) { /* ignore */ }

  try {
    const rows = await dbAll(
      db,
      'SELECT id FROM empresas WHERE COALESCE(ativo, 1) = 1 ORDER BY id ASC'
    );
    if (rows.length === 1) return Number(rows[0].id);
  } catch (_e3) { /* ignore */ }

  return null;
}

/**
 * Backfill idempotente (não sobrescreve empresa_id existente).
 * 1) Central documento
 * 2) Financeiro inequívoco
 * 3) EMPRESA_SIMPLES operacional (se seguro)
 * Ambíguos MULTI permanecem NULL.
 */
async function backfillComprasEmpresaId(db, empresaOperacionalId) {
  let fromCentral = 0;
  let fromFinanceiro = 0;
  let fromOperacional = 0;
  let ambiguos = 0;

  // 1) Central
  try {
    const r1 = await dbRun(
      db,
      `UPDATE compras
       SET empresa_id = (
         SELECT d.empresa_id
         FROM central_entradas_documentos d
         WHERE d.compra_id = compras.id
           AND d.empresa_id IS NOT NULL
         ORDER BY d.id DESC
         LIMIT 1
       )
       WHERE compras.empresa_id IS NULL
         AND EXISTS (
           SELECT 1 FROM central_entradas_documentos d2
           WHERE d2.compra_id = compras.id AND d2.empresa_id IS NOT NULL
         )`
    );
    fromCentral = r1.changes || 0;
  } catch (_ce) { /* tabela central ausente */ }

  // 2) Financeiro inequívoco (todos os lançamentos com mesma empresa_id)
  const semEmp = await dbAll(
    db,
    'SELECT id FROM compras WHERE empresa_id IS NULL'
  );
  for (const row of semEmp) {
    try {
      const fins = await dbAll(
        db,
        `SELECT DISTINCT empresa_id AS eid
         FROM financeiro
         WHERE compra_id = ?
           AND empresa_id IS NOT NULL`,
        [row.id]
      );
      if (fins.length === 1 && fins[0].eid != null) {
        await dbRun(
          db,
          'UPDATE compras SET empresa_id = ? WHERE id = ? AND empresa_id IS NULL',
          [Number(fins[0].eid), row.id]
        );
        fromFinanceiro += 1;
      } else if (fins.length > 1) {
        ambiguos += 1;
      }
    } catch (_f) { /* ignore */ }
  }

  // 3) EMPRESA_SIMPLES seguro
  if (Number.isInteger(empresaOperacionalId) && empresaOperacionalId > 0) {
    const r3 = await dbRun(
      db,
      `UPDATE compras SET empresa_id = ? WHERE empresa_id IS NULL`,
      [empresaOperacionalId]
    );
    fromOperacional = r3.changes || 0;
  }

  const restantes = await dbGet(
    db,
    'SELECT COUNT(*) AS n FROM compras WHERE empresa_id IS NULL'
  );
  ambiguos = Math.max(ambiguos, Number(restantes && restantes.n) || 0);

  return { fromCentral, fromFinanceiro, fromOperacional, ambiguos };
}

async function migrarEmpresaIdCompras(db, deps = {}) {
  if (!db) {
    return { skipped: true };
  }

  const col = await garantirColunaEmpresaIdCompras(db);
  await garantirIndiceEmpresaIdCompras(db);
  const empresaId = await resolverEmpresaIdBackfillCompras(db, deps);
  const fill = await backfillComprasEmpresaId(db, empresaId);

  return {
    added: col.added,
    empresaId,
    ...fill
  };
}

function sqlFiltroComprasEmpresa(alias, empresaId) {
  const col = alias ? `${alias}.empresa_id` : 'empresa_id';
  return {
    sql: ` AND ${col} = ? `,
    params: [Number(empresaId)]
  };
}

module.exports = {
  garantirColunaEmpresaIdCompras,
  garantirIndiceEmpresaIdCompras,
  resolverEmpresaIdBackfillCompras,
  backfillComprasEmpresaId,
  migrarEmpresaIdCompras,
  sqlFiltroComprasEmpresa
};
