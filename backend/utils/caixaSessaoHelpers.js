function obterCaixaTurnoId(sessao) {
  if (!sessao) return null;
  if (sessao.caixa_turno_id) return sessao.caixa_turno_id;
  return sessao.caixa_id || null;
}

/**
 * SQL helpers — sessão aberta isolada por empresa (05.38.C).
 * Preserva o escopo existente (terminal_id) e acrescenta empresa_id.
 */
function montarSqlSessaoAberta({ terminalId, empresaId, sessaoId } = {}) {
  if (sessaoId) {
    return {
      sql: `SELECT * FROM caixa_sessoes WHERE id = ? AND status = 'aberto'`,
      params: [sessaoId]
    };
  }
  const temEmpresa = empresaId != null && Number.isInteger(Number(empresaId)) && Number(empresaId) > 0;
  if (terminalId) {
    if (temEmpresa) {
      return {
        sql: `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND terminal_id = ? AND empresa_id = ? ORDER BY id DESC LIMIT 1`,
        params: [terminalId, Number(empresaId)]
      };
    }
    return {
      sql: `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND terminal_id = ? ORDER BY id DESC LIMIT 1`,
      params: [terminalId]
    };
  }
  if (temEmpresa) {
    return {
      sql: `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND empresa_id = ? ORDER BY id DESC LIMIT 1`,
      params: [Number(empresaId)]
    };
  }
  return {
    sql: `SELECT * FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1`,
    params: []
  };
}

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

/**
 * Resolve empresa operacional para backfill (sem inventar empresa 1).
 * Ordem: config empresa_operacional_id → única empresa ativa → null.
 */
async function resolverEmpresaIdBackfill(db, deps = {}) {
  if (typeof deps.resolverEmpresaIdBackfill === 'function') {
    return deps.resolverEmpresaIdBackfill(db);
  }
  try {
    const configService = deps.configService || require('../services/configuracaoService');
    const cfg = deps.cfg || configService.readConfig();
    const cfgId = cfg && cfg.empresa_operacional_id != null ? Number(cfg.empresa_operacional_id) : null;
    if (Number.isInteger(cfgId) && cfgId > 0) {
      const row = await dbGet(db, `SELECT id FROM empresas WHERE id = ? AND COALESCE(ativo, 1) = 1 LIMIT 1`, [cfgId]);
      if (row) return Number(row.id);
    }
  } catch (_e) { /* config ausente em testes */ }

  try {
    const rows = await dbAll(
      db,
      `SELECT id FROM empresas WHERE COALESCE(ativo, 1) = 1 ORDER BY id ASC`
    );
    if (rows.length === 1) return Number(rows[0].id);
  } catch (_e2) { /* tabela empresas ausente */ }

  return null;
}

/**
 * Migration 05.38.C — adiciona empresa_id e faz backfill idempotente.
 * Não apaga sessões. Não recria tabela.
 */
async function migrarEmpresaIdCaixaSessoes(db, deps = {}) {
  if (!db) return { added: false, backfilled: 0, empresaId: null };

  const cols = await dbAll(db, `PRAGMA table_info(caixa_sessoes)`);
  const nomes = (cols || []).map((c) => c.name);
  let added = false;

  if (!nomes.includes('empresa_id')) {
    await dbRun(db, `ALTER TABLE caixa_sessoes ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`);
    added = true;
  }

  const empresaId = await resolverEmpresaIdBackfill(db, deps);
  let backfilled = 0;

  if (empresaId != null) {
    const result = await dbRun(
      db,
      `UPDATE caixa_sessoes SET empresa_id = ? WHERE empresa_id IS NULL`,
      [empresaId]
    );
    backfilled = result && result.changes != null ? Number(result.changes) : 0;
  }

  try {
    await dbRun(
      db,
      `CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_empresa_status
       ON caixa_sessoes(empresa_id, status)`
    );
  } catch (_idxErr) { /* ignore */ }

  return { added, backfilled, empresaId };
}

function migrarDadosCaixaSessoes(db, callback) {
  db.run(
    `UPDATE caixa_sessoes
     SET caixa_turno_id = caixa_id
     WHERE caixa_turno_id IS NULL AND caixa_id IS NOT NULL`,
    [],
    (err1) => {
      if (err1) {
        console.error('Erro ao migrar caixa_turno_id em caixa_sessoes:', err1.message);
        return callback ? callback(err1) : null;
      }

      db.run(
        `UPDATE caixa_sessoes
         SET caixa_id = (
           SELECT t.caixa_id FROM terminais t WHERE t.id = caixa_sessoes.terminal_id
         )
         WHERE terminal_id IS NOT NULL
           AND caixa_turno_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM terminais t
             WHERE t.id = caixa_sessoes.terminal_id AND t.caixa_id IS NOT NULL
           )`,
        [],
        (err2) => {
          if (err2) {
            console.error('Erro ao vincular caixa_id admin em caixa_sessoes:', err2.message);
          }

          migrarEmpresaIdCaixaSessoes(db)
            .then((info) => {
              if (info && (info.added || info.backfilled > 0)) {
                console.log(
                  `[05.38.C] caixa_sessoes.empresa_id: added=${info.added} backfilled=${info.backfilled} empresaId=${info.empresaId}`
                );
              }
              if (callback) callback(err2 || null);
            })
            .catch((migErr) => {
              console.error('Erro ao migrar empresa_id em caixa_sessoes:', migErr.message);
              if (callback) callback(migErr);
            });
        }
      );
    }
  );
}

module.exports = {
  obterCaixaTurnoId,
  montarSqlSessaoAberta,
  migrarDadosCaixaSessoes,
  migrarEmpresaIdCaixaSessoes,
  resolverEmpresaIdBackfill
};
