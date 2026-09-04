/**
 * Helpers SQL + migration empresa_id da Central de Entradas (05.38.E).
 *
 * @module utils/centralEntradasEmpresaHelpers
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

async function garantirColunaEmpresaIdDocumentos(db) {
  const cols = await dbAll(db, 'PRAGMA table_info(central_entradas_documentos)');
  if (colunaExiste(cols, 'empresa_id')) {
    return { added: false };
  }
  await dbRun(
    db,
    'ALTER TABLE central_entradas_documentos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)'
  );
  return { added: true };
}

async function garantirIndiceEmpresaIdDocumentos(db) {
  await dbRun(
    db,
    'CREATE INDEX IF NOT EXISTS idx_central_entradas_documentos_empresa ON central_entradas_documentos(empresa_id)'
  );
}

/**
 * Empresa operacional segura para backfill EMPRESA_SIMPLES:
 * - empresa_operacional_id configurada e ativa; OU
 * - exatamente uma empresa ativa.
 * Em MULTIEMPRESA (0 ou >1 ativas sem config) retorna null — não inventa empresa.
 */
async function resolverEmpresaIdBackfillSeguro(db, deps = {}) {
  if (typeof deps.resolverEmpresaIdBackfill === 'function') {
    return deps.resolverEmpresaIdBackfill(db);
  }

  let modo = null;
  try {
    const { resolverModoOperacionalGlobalAtivo, ModoOperacionalGlobal } =
      require('../core/modo-operacional');
    modo = resolverModoOperacionalGlobalAtivo(deps);
    if (modo === ModoOperacionalGlobal.MULTIEMPRESA) {
      // Nunca atribuir arbitrariamente em MULTIEMPRESA via fallback operacional.
      return null;
    }
  } catch (_e) { /* modo indisponível — segue heurística segura */ }

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
  } catch (_e2) { /* config ausente */ }

  try {
    const rows = await dbAll(
      db,
      'SELECT id FROM empresas WHERE COALESCE(ativo, 1) = 1 ORDER BY id ASC'
    );
    if (rows.length === 1) return Number(rows[0].id);
  } catch (_e3) { /* tabela ausente */ }

  return null;
}

/**
 * Extrai CNPJ do destinatário do XML (dest/CNPJ) quando possível.
 */
function extrairCnpjDestinatarioXml(xml) {
  const texto = String(xml || '');
  const dest = texto.match(/<dest[\s>][\s\S]*?<\/dest>/i);
  const bloco = dest ? dest[0] : '';
  const cnpj = (bloco.match(/<CNPJ>(\d{14})<\/CNPJ>/i) || [])[1]
    || (texto.match(/<dest[\s\S]*?<CNPJ>(\d{14})<\/CNPJ>/i) || [])[1]
    || '';
  return String(cnpj).replace(/\D/g, '');
}

/**
 * Backfill:
 * 1) MULTIEMPRESA / sempre: match inequívoco CNPJ destinatário → empresas.cnpj
 * 2) EMPRESA_SIMPLES seguro: restante NULL → empresa operacional única
 * Registros ambíguos permanecem NULL (nunca inventados em MULTIEMPRESA).
 */
async function backfillDocumentosCentral(db, empresaOperacionalId) {
  let fromCnpj = 0;
  let fromOperacional = 0;
  let ambiguos = 0;

  const semEmpresa = await dbAll(
    db,
    `SELECT id, xml FROM central_entradas_documentos
     WHERE empresa_id IS NULL`
  );

  for (const row of semEmpresa) {
    const cnpj = extrairCnpjDestinatarioXml(row.xml);
    if (cnpj.length === 14) {
      const emp = await dbGet(
        db,
        'SELECT id FROM empresas WHERE cnpj = ? AND COALESCE(ativo, 1) = 1 LIMIT 1',
        [cnpj]
      );
      if (emp) {
        await dbRun(
          db,
          'UPDATE central_entradas_documentos SET empresa_id = ? WHERE id = ? AND empresa_id IS NULL',
          [Number(emp.id), row.id]
        );
        fromCnpj += 1;
        continue;
      }
    }
    ambiguos += 1;
  }

  if (Number.isInteger(empresaOperacionalId) && empresaOperacionalId > 0) {
    const r = await dbRun(
      db,
      `UPDATE central_entradas_documentos
       SET empresa_id = ?
       WHERE empresa_id IS NULL`,
      [empresaOperacionalId]
    );
    fromOperacional = r.changes || 0;
    ambiguos = Math.max(0, ambiguos - fromOperacional);
  }

  return { fromCnpj, fromOperacional, ambiguos };
}

/**
 * Migration idempotente: coluna + índice + backfill seguro.
 */
async function migrarEmpresaIdCentralDocumentos(db, deps = {}) {
  if (!db) {
    return { skipped: true };
  }

  const col = await garantirColunaEmpresaIdDocumentos(db);
  await garantirIndiceEmpresaIdDocumentos(db);

  const empresaId = await resolverEmpresaIdBackfillSeguro(db, deps);
  const fill = await backfillDocumentosCentral(db, empresaId);

  return {
    added: col.added,
    empresaId,
    fromCnpj: fill.fromCnpj,
    fromOperacional: fill.fromOperacional,
    ambiguos: fill.ambiguos
  };
}

function sqlColunaFromPragma(c) {
  if (c.name === 'id' && Number(c.pk) === 1) {
    return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  }
  const tipo = c.type && String(c.type).trim() ? c.type : 'TEXT';
  let def = `${c.name} ${tipo}`;
  if (Number(c.notnull) === 1) def += ' NOT NULL';
  if (c.dflt_value != null && String(c.dflt_value).length) {
    def += ` DEFAULT ${c.dflt_value}`;
  }
  return def;
}

/**
 * Índices únicos atuais de central_entradas_documentos (PRAGMA).
 */
async function inspecionarIndicesUnicosDocumentos(db) {
  const lista = await dbAll(db, 'PRAGMA index_list(central_entradas_documentos)');
  const unicos = [];
  for (const idx of lista || []) {
    if (!idx.unique) continue;
    const info = await dbAll(db, `PRAGMA index_info("${String(idx.name).replace(/"/g, '""')}")`);
    unicos.push({
      name: idx.name,
      origin: idx.origin,
      colunas: (info || []).sort((a, b) => a.seqno - b.seqno).map((c) => c.name)
    });
  }
  return unicos;
}

function temUniqueCompostoChaveEmpresa(unicos) {
  return unicos.some((u) => (
    u.colunas.length === 2
    && u.colunas[0] === 'chave'
    && u.colunas[1] === 'empresa_id'
  ));
}

function temUniqueGlobalChave(sqlTabela, unicos) {
  if (temUniqueCompostoChaveEmpresa(unicos)) return false;
  if (unicos.some((u) => u.colunas.length === 1 && u.colunas[0] === 'chave')) return true;
  const sql = String(sqlTabela || '');
  if (/UNIQUE\s*\(\s*chave\s*,\s*empresa_id\s*\)/i.test(sql)) return false;
  return /chave TEXT NOT NULL UNIQUE/i.test(sql) || /chave TEXT UNIQUE/i.test(sql);
}

/**
 * Sprint 05.70 — troca UNIQUE(chave) por UNIQUE(chave, empresa_id).
 * Preserva linhas e colunas. Não preenche empresa_id NULL.
 */
async function migrarIdentidadeUnicaChaveEmpresaDocumentos(db) {
  if (!db) return { skipped: true, reason: 'no_db' };

  const existe = await dbGet(
    db,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'central_entradas_documentos'`
  );
  if (!existe) return { skipped: true, reason: 'no_table' };

  const cols = await dbAll(db, 'PRAGMA table_info(central_entradas_documentos)');
  const nomes = (cols || []).map((c) => c.name);
  if (!nomes.includes('chave') || !nomes.includes('empresa_id')) {
    return { skipped: true, reason: 'missing_columns' };
  }

  const unicos = await inspecionarIndicesUnicosDocumentos(db);
  if (temUniqueCompostoChaveEmpresa(unicos)) {
    return { skipped: true, reason: 'already_composite', indices: unicos };
  }

  if (!temUniqueGlobalChave(existe.sql, unicos)) {
    await dbRun(
      db,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_central_entradas_documentos_chave_empresa
       ON central_entradas_documentos(chave, empresa_id)`
    );
    return { skipped: false, migrated: true, modo: 'create_index', indices: unicos };
  }

  const colList = nomes.join(', ');
  const ddlCols = cols.map(sqlColunaFromPragma).join(',\n      ');
  const tmp = 'central_entradas_documentos__0570';

  await dbRun(db, 'PRAGMA foreign_keys = OFF');
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    await dbRun(db, `DROP TABLE IF EXISTS ${tmp}`);
    const fks = [];
    if (nomes.includes('compra_id')) fks.push('FOREIGN KEY (compra_id) REFERENCES compras(id)');
    if (nomes.includes('empresa_id')) fks.push('FOREIGN KEY (empresa_id) REFERENCES empresas(id)');
    fks.push('UNIQUE(chave, empresa_id)');
    await dbRun(db, `
      CREATE TABLE ${tmp} (
        ${ddlCols},
        ${fks.join(',\n        ')}
      )
    `);
    const countRow = await dbGet(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos');
    await dbRun(
      db,
      `INSERT INTO ${tmp} (${colList}) SELECT ${colList} FROM central_entradas_documentos`
    );
    await dbRun(db, 'DROP TABLE central_entradas_documentos');
    await dbRun(db, `ALTER TABLE ${tmp} RENAME TO central_entradas_documentos`);
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_central_entradas_documentos_status ON central_entradas_documentos(status)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_central_entradas_documentos_cnpj ON central_entradas_documentos(cnpj_fornecedor)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_central_entradas_documentos_empresa ON central_entradas_documentos(empresa_id)');
    await dbRun(db, 'CREATE INDEX IF NOT EXISTS idx_central_entradas_documentos_emissao ON central_entradas_documentos(data_emissao)');
    await dbRun(db, 'COMMIT');
    return {
      skipped: false,
      migrated: true,
      modo: 'rebuild',
      linhas: Number(countRow && countRow.n) || 0
    };
  } catch (err) {
    try {
      await dbRun(db, 'ROLLBACK');
    } catch { /* ignore */ }
    throw err;
  } finally {
    try {
      await dbRun(db, 'PRAGMA foreign_keys = ON');
    } catch { /* ignore */ }
  }
}

module.exports = {
  garantirColunaEmpresaIdDocumentos,
  garantirIndiceEmpresaIdDocumentos,
  resolverEmpresaIdBackfillSeguro,
  extrairCnpjDestinatarioXml,
  backfillDocumentosCentral,
  migrarEmpresaIdCentralDocumentos,
  migrarIdentidadeUnicaChaveEmpresaDocumentos,
  inspecionarIndicesUnicosDocumentos
};
