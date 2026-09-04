function obterCaixaTurnoId(sessao) {
  if (!sessao) return null;
  if (sessao.caixa_turno_id) return sessao.caixa_turno_id;
  return sessao.caixa_id || null;
}

function empresaIdOperacionalCaixa(empresaId) {
  const n = Number(empresaId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function erroEmpresaObrigatoriaCaixa(mensagem) {
  const err = new Error(mensagem || 'Empresa é obrigatória para localizar sessão de caixa.');
  err.code = 'CAIXA_EMPRESA_OBRIGATORIA';
  return err;
}

/**
 * SQL — sessão aberta DA EMPRESA (05.38.C / 05.44).
 * Sempre filtra `empresa_id` na consulta. Não há LIMIT 1 global.
 */
function montarSqlSessaoAberta({ terminalId, empresaId, sessaoId } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa();
  }

  if (sessaoId) {
    return {
      sql: `SELECT * FROM caixa_sessoes WHERE id = ? AND status = 'aberto' AND empresa_id = ?`,
      params: [sessaoId, emp]
    };
  }

  if (terminalId) {
    return {
      sql: `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND terminal_id = ? AND empresa_id = ? ORDER BY id DESC LIMIT 1`,
      params: [terminalId, emp]
    };
  }

  return {
    sql: `SELECT * FROM caixa_sessoes WHERE status = 'aberto' AND empresa_id = ? ORDER BY id DESC LIMIT 1`,
    params: [emp]
  };
}

/**
 * Caminho público: sessão ativa da empresa. O filtro de empresa está no SQL.
 */
function obterSessaoAtivaDaEmpresa(db, { empresaId, terminalId, sessaoId } = {}, callback) {
  let query;
  try {
    query = montarSqlSessaoAberta({ empresaId, terminalId, sessaoId });
  } catch (err) {
    if (typeof callback === 'function') return callback(err);
    return Promise.reject(err);
  }
  if (!db || typeof db.get !== 'function') {
    const err = new Error('Conexão de banco indisponível para sessão de caixa.');
    if (typeof callback === 'function') return callback(err);
    return Promise.reject(err);
  }
  if (typeof callback === 'function') {
    return db.get(query.sql, query.params, callback);
  }
  return dbGet(db, query.sql, query.params);
}

function montarSqlHistoricoTurnosDaEmpresa(empresaId, { limite = 100, data = null } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa('Empresa é obrigatória para listar turnos de caixa.');
  }
  const params = [emp];
  let filtroData = '';
  if (data) {
    filtroData = ' AND c.data = ?';
    params.push(data);
  }
  params.push(limite);
  return {
    sql: `SELECT c.*, ua.nome AS aberto_por_nome, uf.nome AS fechado_por_nome
     FROM caixa c
     LEFT JOIN usuarios ua ON ua.id = c.aberto_por
     LEFT JOIN usuarios uf ON uf.id = c.fechado_por
     WHERE EXISTS (
       SELECT 1 FROM caixa_sessoes s
       WHERE s.empresa_id = ?
         AND (s.caixa_turno_id = c.id OR (s.caixa_turno_id IS NULL AND s.caixa_id = c.id))
     )${filtroData}
     ORDER BY c.id DESC
     LIMIT ?`,
    params
  };
}

function montarSqlUltimaSessaoDoTurnoDaEmpresa({ caixaTurnoId, empresaId } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa();
  }
  return {
    sql: `SELECT id FROM caixa_sessoes
     WHERE empresa_id = ?
       AND (caixa_turno_id = ? OR (caixa_turno_id IS NULL AND caixa_id = ?))
     ORDER BY id DESC LIMIT 1`,
    params: [emp, caixaTurnoId, caixaTurnoId]
  };
}

function erroCaixaLeituraNaoEncontrada(code, mensagem) {
  const err = new Error(mensagem);
  err.code = code;
  err.statusCode = 404;
  return err;
}

function montarSqlSessaoPorIdDaEmpresa({ sessaoId, empresaId } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa();
  }
  return {
    sql: `SELECT * FROM caixa_sessoes WHERE id = ? AND empresa_id = ?`,
    params: [sessaoId, emp]
  };
}

function montarSqlMovimentacoesDaSessaoDaEmpresa({ sessaoId, empresaId } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa();
  }
  return {
    sql: `SELECT cm.*, u.nome AS usuario_nome
     FROM caixa_movimentacoes cm
     INNER JOIN caixa_sessoes cs ON cs.id = cm.sessao_id
     LEFT JOIN usuarios u ON u.id = cm.usuario_id
     WHERE cm.sessao_id = ? AND cs.empresa_id = ?
     ORDER BY cm.id DESC`,
    params: [sessaoId, emp]
  };
}

function montarSqlMovimentacaoPorIdDaEmpresa({ movimentacaoId, empresaId } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa();
  }
  return {
    sql: `SELECT cm.*
     FROM caixa_movimentacoes cm
     INNER JOIN caixa_sessoes cs ON cs.id = cm.sessao_id
     WHERE cm.id = ? AND cs.empresa_id = ?`,
    params: [movimentacaoId, emp]
  };
}

function montarSqlSomaMovimentacaoDaSessaoDaEmpresa({ sessaoId, empresaId, tipo } = {}) {
  const emp = empresaIdOperacionalCaixa(empresaId);
  if (emp == null) {
    throw erroEmpresaObrigatoriaCaixa();
  }
  return {
    sql: `SELECT COALESCE(SUM(cm.valor), 0) AS total
     FROM caixa_movimentacoes cm
     INNER JOIN caixa_sessoes cs ON cs.id = cm.sessao_id
     WHERE cs.empresa_id = ? AND cm.sessao_id = ? AND cm.tipo = ?`,
    params: [emp, sessaoId, tipo]
  };
}

async function obterSessaoDaEmpresaPorId(db, { sessaoId, empresaId } = {}) {
  const q = montarSqlSessaoPorIdDaEmpresa({ sessaoId, empresaId });
  const row = await dbGet(db, q.sql, q.params);
  if (!row) {
    throw erroCaixaLeituraNaoEncontrada(
      'CAIXA_SESSAO_NAO_ENCONTRADA',
      'Sessão de caixa não encontrada.'
    );
  }
  return row;
}

async function obterMovimentacaoDaEmpresaPorId(db, { movimentacaoId, empresaId } = {}) {
  const q = montarSqlMovimentacaoPorIdDaEmpresa({ movimentacaoId, empresaId });
  const row = await dbGet(db, q.sql, q.params);
  if (!row) {
    throw erroCaixaLeituraNaoEncontrada(
      'CAIXA_MOVIMENTACAO_NAO_ENCONTRADA',
      'Movimentação de caixa não encontrada.'
    );
  }
  return row;
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
  empresaIdOperacionalCaixa,
  montarSqlSessaoAberta,
  obterSessaoAtivaDaEmpresa,
  montarSqlHistoricoTurnosDaEmpresa,
  montarSqlUltimaSessaoDoTurnoDaEmpresa,
  montarSqlSessaoPorIdDaEmpresa,
  montarSqlMovimentacoesDaSessaoDaEmpresa,
  montarSqlMovimentacaoPorIdDaEmpresa,
  montarSqlSomaMovimentacaoDaSessaoDaEmpresa,
  obterSessaoDaEmpresaPorId,
  obterMovimentacaoDaEmpresaPorId,
  migrarDadosCaixaSessoes,
  migrarEmpresaIdCaixaSessoes,
  resolverEmpresaIdBackfill
};
