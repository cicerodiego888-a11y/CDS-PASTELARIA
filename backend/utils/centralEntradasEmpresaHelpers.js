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

module.exports = {
  garantirColunaEmpresaIdDocumentos,
  garantirIndiceEmpresaIdDocumentos,
  resolverEmpresaIdBackfillSeguro,
  extrairCnpjDestinatarioXml,
  backfillDocumentosCentral,
  migrarEmpresaIdCentralDocumentos
};
