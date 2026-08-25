/**
 * Helpers SQL + migration empresa_id do domínio Financeiro (05.38.D).
 *
 * @module utils/financeiroEmpresaHelpers
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

async function garantirColunaEmpresaId(db, tabela) {
  const cols = await dbAll(db, `PRAGMA table_info(${tabela})`);
  if (colunaExiste(cols, 'empresa_id')) {
    return { added: false };
  }
  await dbRun(db, `ALTER TABLE ${tabela} ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`);
  return { added: true };
}

async function resolverEmpresaIdBackfill(db, deps = {}) {
  if (typeof deps.resolverEmpresaIdBackfill === 'function') {
    return deps.resolverEmpresaIdBackfill(db);
  }
  try {
    const configService = deps.configService || require('../services/configuracaoService');
    const cfg = deps.cfg || configService.readConfig();
    const cfgId = cfg && cfg.empresa_operacional_id != null ? Number(cfg.empresa_operacional_id) : null;
    if (Number.isInteger(cfgId) && cfgId > 0) {
      const row = await dbGet(
        db,
        `SELECT id FROM empresas WHERE id = ? AND COALESCE(ativo, 1) = 1 LIMIT 1`,
        [cfgId]
      );
      if (row) return Number(row.id);
    }
  } catch (_e) { /* config ausente */ }

  try {
    const rows = await dbAll(
      db,
      `SELECT id FROM empresas WHERE COALESCE(ativo, 1) = 1 ORDER BY id ASC`
    );
    if (rows.length === 1) return Number(rows[0].id);
  } catch (_e2) { /* tabela ausente */ }

  return null;
}

/**
 * Backfill financeiro:
 * 1) origem caixa_sessoes via vendas.caixa_sessao_id (quando existir)
 * 2) empresa operacional configurada / única ativa
 */
async function backfillFinanceiro(db, empresaOperacionalId) {
  let fromCaixa = 0;
  let fromOperacional = 0;

  // Origem: venda → caixa_sessao.empresa_id
  try {
    const r1 = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT cs.empresa_id
        FROM vendas v
        INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
        WHERE v.id = financeiro.venda_id
          AND cs.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND venda_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM vendas v
          INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
          WHERE v.id = financeiro.venda_id
            AND cs.empresa_id IS NOT NULL
        )
    `);
    fromCaixa += r1 && r1.changes != null ? Number(r1.changes) : 0;
  } catch (_e) { /* colunas/tabelas podem não existir em DB parcial */ }

  // Origem: referencia_tipo venda
  try {
    const r2 = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT cs.empresa_id
        FROM vendas v
        INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
        WHERE v.id = financeiro.referencia_id
          AND cs.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND referencia_tipo = 'venda'
        AND referencia_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM vendas v
          INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
          WHERE v.id = financeiro.referencia_id
            AND cs.empresa_id IS NOT NULL
        )
    `);
    fromCaixa += r2 && r2.changes != null ? Number(r2.changes) : 0;
  } catch (_e2) { /* ignore */ }

  if (empresaOperacionalId != null) {
    const r3 = await dbRun(
      db,
      `UPDATE financeiro SET empresa_id = ? WHERE empresa_id IS NULL`,
      [empresaOperacionalId]
    );
    fromOperacional = r3 && r3.changes != null ? Number(r3.changes) : 0;
  }

  return { fromCaixa, fromOperacional };
}

async function backfillContasReceber(db, empresaOperacionalId) {
  let fromOrigem = 0;
  let fromOperacional = 0;

  // Herdar do lançamento financeiro da mesma venda
  try {
    const r1 = await dbRun(db, `
      UPDATE contas_receber
      SET empresa_id = (
        SELECT f.empresa_id
        FROM financeiro f
        WHERE f.venda_id = contas_receber.venda_id
          AND f.empresa_id IS NOT NULL
        ORDER BY f.id ASC
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND venda_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM financeiro f
          WHERE f.venda_id = contas_receber.venda_id
            AND f.empresa_id IS NOT NULL
        )
    `);
    fromOrigem += r1 && r1.changes != null ? Number(r1.changes) : 0;
  } catch (_e) { /* ignore */ }

  // Origem: venda → caixa_sessao
  try {
    const r2 = await dbRun(db, `
      UPDATE contas_receber
      SET empresa_id = (
        SELECT cs.empresa_id
        FROM vendas v
        INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
        WHERE v.id = contas_receber.venda_id
          AND cs.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND venda_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM vendas v
          INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
          WHERE v.id = contas_receber.venda_id
            AND cs.empresa_id IS NOT NULL
        )
    `);
    fromOrigem += r2 && r2.changes != null ? Number(r2.changes) : 0;
  } catch (_e2) { /* ignore */ }

  if (empresaOperacionalId != null) {
    const r3 = await dbRun(
      db,
      `UPDATE contas_receber SET empresa_id = ? WHERE empresa_id IS NULL`,
      [empresaOperacionalId]
    );
    fromOperacional = r3 && r3.changes != null ? Number(r3.changes) : 0;
  }

  return { fromOrigem, fromOperacional };
}

/**
 * Migration 05.38.D — idempotente.
 */
async function migrarEmpresaIdFinanceiro(db, deps = {}) {
  if (!db) {
    return {
      financeiro: { added: false, fromCaixa: 0, fromOperacional: 0 },
      contas_receber: { added: false, fromOrigem: 0, fromOperacional: 0 },
      empresaId: null
    };
  }

  const finCol = await garantirColunaEmpresaId(db, 'financeiro');
  const crCol = await garantirColunaEmpresaId(db, 'contas_receber');
  const empresaId = await resolverEmpresaIdBackfill(db, deps);

  const finBf = await backfillFinanceiro(db, empresaId);
  const crBf = await backfillContasReceber(db, empresaId);

  try {
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_financeiro_empresa_status ON financeiro(empresa_id, status)`);
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_contas_receber_empresa_status ON contas_receber(empresa_id, status)`);
  } catch (_idx) { /* ignore */ }

  return {
    financeiro: { added: finCol.added, ...finBf },
    contas_receber: { added: crCol.added, ...crBf },
    empresaId
  };
}

function sqlFiltroEmpresa(alias, empresaId, params = []) {
  const col = alias ? `${alias}.empresa_id` : 'empresa_id';
  return {
    sql: ` AND ${col} = ? `,
    params: [...params, Number(empresaId)]
  };
}

async function contarFinanceiro(db, sql, params = []) {
  const row = await dbGet(db, sql, params);
  return row && row.n != null ? Number(row.n) : 0;
}

/**
 * Backfill 05.41 — somente fontes confiáveis.
 * P1 vendas.empresa_id → P2 MUV → P3 caixa_sessoes → P4 compras.
 * Restante permanece NULL. Não usa empresa operacional/padrão.
 */
async function backfillFinanceiroOwnershipConfiavel(db) {
  let fromVenda = 0;
  let fromMuv = 0;
  let fromCaixa = 0;
  let fromOutra = 0;

  try {
    const r1 = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT v.empresa_id
        FROM vendas v
        WHERE v.id = financeiro.venda_id
          AND v.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND venda_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM vendas v
          WHERE v.id = financeiro.venda_id
            AND v.empresa_id IS NOT NULL
        )
    `);
    fromVenda += r1 && r1.changes != null ? Number(r1.changes) : 0;
  } catch (_e) { /* tabela/coluna ausente em DB parcial */ }

  try {
    const r1b = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT v.empresa_id
        FROM vendas v
        WHERE v.id = financeiro.referencia_id
          AND v.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND referencia_tipo = 'venda'
        AND referencia_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM vendas v
          WHERE v.id = financeiro.referencia_id
            AND v.empresa_id IS NOT NULL
        )
    `);
    fromVenda += r1b && r1b.changes != null ? Number(r1b.changes) : 0;
  } catch (_e) { /* ignore */ }

  try {
    const r2 = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT ao.empresa_id
        FROM atendimento_operacoes ao
        WHERE ao.venda_id = financeiro.venda_id
          AND ao.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND venda_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM atendimento_operacoes ao
          WHERE ao.venda_id = financeiro.venda_id
            AND ao.empresa_id IS NOT NULL
        )
    `);
    fromMuv += r2 && r2.changes != null ? Number(r2.changes) : 0;
  } catch (_e2) { /* ignore */ }

  try {
    const r3 = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT cs.empresa_id
        FROM vendas v
        INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
        WHERE v.id = financeiro.venda_id
          AND cs.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND venda_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM vendas v
          INNER JOIN caixa_sessoes cs ON cs.id = v.caixa_sessao_id
          WHERE v.id = financeiro.venda_id
            AND cs.empresa_id IS NOT NULL
        )
    `);
    fromCaixa += r3 && r3.changes != null ? Number(r3.changes) : 0;
  } catch (_e3) { /* ignore */ }

  try {
    const r4 = await dbRun(db, `
      UPDATE financeiro
      SET empresa_id = (
        SELECT c.empresa_id
        FROM compras c
        WHERE c.id = financeiro.compra_id
          AND c.empresa_id IS NOT NULL
        LIMIT 1
      )
      WHERE empresa_id IS NULL
        AND compra_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM compras c
          WHERE c.id = financeiro.compra_id
            AND c.empresa_id IS NOT NULL
        )
    `);
    fromOutra += r4 && r4.changes != null ? Number(r4.changes) : 0;
  } catch (_e4) { /* ignore */ }

  return { fromVenda, fromMuv, fromCaixa, fromOutra };
}

/**
 * Migration 05.41 — coluna já existente (05.38.D); índice + backfill confiável.
 * Não duplica coluna. Não inventa ownership.
 */
async function migrarOwnershipFinanceiro0541(db) {
  if (!db) {
    return {
      skipped: true,
      added: false,
      total: 0,
      fromVenda: 0,
      fromMuv: 0,
      fromCaixa: 0,
      fromOutra: 0,
      naoClassificadas: 0
    };
  }

  const existe = await dbGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'financeiro'`
  );
  if (!existe) {
    return {
      skipped: true,
      added: false,
      total: 0,
      fromVenda: 0,
      fromMuv: 0,
      fromCaixa: 0,
      fromOutra: 0,
      naoClassificadas: 0
    };
  }

  const col = await garantirColunaEmpresaId(db, 'financeiro');
  const total = await contarFinanceiro(db, `SELECT COUNT(*) AS n FROM financeiro`);
  const bf = await backfillFinanceiroOwnershipConfiavel(db);
  const naoClassificadas = await contarFinanceiro(
    db,
    `SELECT COUNT(*) AS n FROM financeiro WHERE empresa_id IS NULL`
  );

  try {
    await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_financeiro_empresa_id ON financeiro(empresa_id)`);
  } catch (_idx) { /* ignore */ }

  return {
    skipped: false,
    added: col.added,
    total,
    fromVenda: bf.fromVenda,
    fromMuv: bf.fromMuv,
    fromCaixa: bf.fromCaixa,
    fromOutra: bf.fromOutra,
    naoClassificadas
  };
}

function formatarLogMigracaoFinanceiro0541(info) {
  if (!info || info.skipped) return '';
  return (
    `MIGRATION_FINANCEIRO_EMPRESA_05_41\n` +
    `TOTAL_FINANCEIRO: ${info.total}\n` +
    `CLASSIFICADO_VIA_VENDA: ${info.fromVenda}\n` +
    `CLASSIFICADO_VIA_MUV: ${info.fromMuv}\n` +
    `CLASSIFICADO_VIA_CAIXA: ${info.fromCaixa}\n` +
    `CLASSIFICADO_OUTRA_ORIGEM: ${info.fromOutra}\n` +
    `LEGADO_SEM_OWNERSHIP: ${info.naoClassificadas}`
  );
}

module.exports = {
  migrarEmpresaIdFinanceiro,
  migrarOwnershipFinanceiro0541,
  resolverEmpresaIdBackfill,
  backfillFinanceiro,
  backfillFinanceiroOwnershipConfiavel,
  backfillContasReceber,
  sqlFiltroEmpresa,
  garantirColunaEmpresaId,
  formatarLogMigracaoFinanceiro0541
};
