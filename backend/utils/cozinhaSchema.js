/**
 * Schema aditivo da Cozinha V1.2.3 — fundação, isolamento e idempotência operacional.
 * Versão 2: FKs compostas (id, empresa_id) entre entidades da Cozinha.
 * Versão 3: amplia CHECK de cozinha_idempotencia.tipo_operacao (preparação S03).
 * Versão 4: inclui confirmação idempotente de retirada no CHECK.
 * Versão 5: adiciona cancelamento estruturado (motivo, justificativa, operador, etc).
 * Versão 6: registra idempotência do retorno de preparo para aguardando.
 * Versão 7: registra idempotência do cancelamento individual de itens.
 */
'use strict';

const COZINHA_SCHEMA_VERSION = 7;

const IDEMPOTENCIA_COLUNAS = Object.freeze([
  'id',
  'idempotency_key',
  'tipo_operacao',
  'contexto',
  'payload_hash',
  'situacao',
  'resultado_http_status',
  'resultado_json',
  'recurso_tipo',
  'recurso_id',
  'created_at',
  'concluded_at'
]);

const SQL_CREATE_COZINHA_IDEMPOTENCIA_V3 = `
  CREATE TABLE cozinha_idempotencia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL,
    tipo_operacao TEXT NOT NULL
      CHECK (tipo_operacao IN (
        'AUTORIZAR_QTY',
        'REDUZIR_TETO',
        'DESPACHO_LOTE',
        'PREPARACAO_INICIADA',
        'ITEM_PRONTO',
        'BEBIDA_ENTREGUE'
      )),
    contexto TEXT,
    payload_hash TEXT NOT NULL,
    situacao TEXT NOT NULL DEFAULT 'EM_ANDAMENTO'
      CHECK (situacao IN ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHA_VALIDACAO')),
    resultado_http_status INTEGER,
    resultado_json TEXT,
    recurso_tipo TEXT,
    recurso_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    concluded_at TEXT
  )
`;

const SQL_CREATE_COZINHA_IDEMPOTENCIA_V4 = `
  CREATE TABLE IF NOT EXISTS cozinha_idempotencia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL,
    tipo_operacao TEXT NOT NULL
      CHECK (tipo_operacao IN (
        'AUTORIZAR_QTY',
        'REDUZIR_TETO',
        'DESPACHO_LOTE',
        'PREPARACAO_INICIADA',
        'ITEM_PRONTO',
        'BEBIDA_ENTREGUE',
        'RETIRADA_CONFIRMADA'
      )),
    contexto TEXT,
    payload_hash TEXT NOT NULL,
    situacao TEXT NOT NULL DEFAULT 'EM_ANDAMENTO'
      CHECK (situacao IN ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHA_VALIDACAO')),
    resultado_http_status INTEGER,
    resultado_json TEXT,
    recurso_tipo TEXT,
    recurso_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    concluded_at TEXT
  )
`;

const SQL_CREATE_COZINHA_IDEMPOTENCIA_V5 = `
  CREATE TABLE IF NOT EXISTS cozinha_idempotencia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL,
    tipo_operacao TEXT NOT NULL
      CHECK (tipo_operacao IN (
        'AUTORIZAR_QTY',
        'REDUZIR_TETO',
        'DESPACHO_LOTE',
        'PREPARACAO_INICIADA',
        'ITEM_PRONTO',
        'BEBIDA_ENTREGUE',
        'RETIRADA_CONFIRMADA',
        'CANCELAMENTO_RODADA'
      )),
    contexto TEXT,
    payload_hash TEXT NOT NULL,
    situacao TEXT NOT NULL DEFAULT 'EM_ANDAMENTO'
      CHECK (situacao IN ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHA_VALIDACAO')),
    resultado_http_status INTEGER,
    resultado_json TEXT,
    recurso_tipo TEXT,
    recurso_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    concluded_at TEXT
  )
`;

const SQL_CREATE_COZINHA_IDEMPOTENCIA_V6 = SQL_CREATE_COZINHA_IDEMPOTENCIA_V5.replace(
  "'CANCELAMENTO_RODADA'",
  "'CANCELAMENTO_RODADA',\n        'PREPARACAO_REVERTIDA'"
);
const SQL_CREATE_COZINHA_IDEMPOTENCIA_V7 = SQL_CREATE_COZINHA_IDEMPOTENCIA_V6.replace(
  "'PREPARACAO_REVERTIDA'",
  "'PREPARACAO_REVERTIDA',\n        'CANCELAMENTO_ITEM'"
);

const TABELAS_COZINHA = Object.freeze([
  'cozinha_item_ingredientes',
  'cozinha_bebida_entregas',
  'cozinha_impressao_fila',
  'cozinha_notificacoes',
  'cozinha_eventos_outbox',
  'cozinha_itens',
  'cozinha_rodadas',
  'cozinha_estacoes_impressao',
  'cozinha_comandas',
  'cozinha_autorizacoes_qty',
  'cozinha_reducoes_teto',
  'cozinha_pedido_item_controle',
  'cozinha_idempotencia',
  'cozinha_unidades'
]);

/**
 * FK-02 — Lista interna controlada para `PRAGMA foreign_key_check(tabela)`.
 * Cobre o domínio Cozinha (relações internas e FKs declaradas para o ERP).
 * Nunca aceitar nomes vindos de parâmetro externo.
 */
const TABELAS_COZINHA_FK_CHECK = TABELAS_COZINHA;

const RE_IDENTIFICADOR_SQL_COZINHA = /^[a-z][a-z0-9_]*$/i;

let statusCozinha = {
  operacional: false,
  versao: null,
  erro: null,
  atualizadoEm: null
};
let filaGarantiaSchemaCozinha = Promise.resolve();

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function marcarCozinhaOperacional(ok, err = null) {
  statusCozinha = {
    operacional: !!ok,
    versao: ok ? COZINHA_SCHEMA_VERSION : statusCozinha.versao,
    erro: err
      ? { mensagem: String(err.message || err), codigo: err.codigo || 'COZINHA_SCHEMA_FALHA' }
      : null,
    atualizadoEm: new Date().toISOString()
  };
  return statusCozinha;
}

function isCozinhaOperacional() {
  return statusCozinha.operacional === true;
}

function getCozinhaSchemaStatus() {
  return { ...statusCozinha, versaoAlvo: COZINHA_SCHEMA_VERSION };
}

async function garantirConfigNotificacaoCozinha(db) {
  await dbRun(db, `
    INSERT OR IGNORE INTO configuracoes (chave, valor, tipo, descricao)
    VALUES (
      'cozinha_notificacao_modo',
      'INDIVIDUAL',
      'text',
      'Modo de notificação da cozinha (global): INDIVIDUAL ou SIMULTANEA'
    )
  `);
}

async function lerVersaoSchema(db) {
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_schema_meta (
      chave TEXT PRIMARY KEY NOT NULL,
      valor TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const row = await dbGet(db, `
    SELECT valor FROM cozinha_schema_meta WHERE chave = 'schema_version'
  `);
  return row ? Number(row.valor) : 0;
}

async function gravarVersaoSchema(db, versao) {
  await dbRun(db, `
    INSERT INTO cozinha_schema_meta (chave, valor, updated_at)
    VALUES ('schema_version', ?, datetime('now'))
    ON CONFLICT(chave) DO UPDATE SET
      valor = excluded.valor,
      updated_at = datetime('now')
  `, [String(versao)]);
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function contarLinhas(db, tabela) {
  const existe = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `, [tabela]);
  if (!existe) return 0;
  const row = await dbGet(db, `SELECT COUNT(*) AS n FROM ${tabela}`);
  return Number(row && row.n) || 0;
}

async function obterSqlTabela(db, nome) {
  const row = await dbGet(db, `
    SELECT sql FROM sqlite_master WHERE type='table' AND name=?
  `, [nome]);
  return row && row.sql ? String(row.sql) : null;
}

function checkIdempotenciaAceitaPreparacao(sqlCreate) {
  if (!sqlCreate) return false;
  const s = String(sqlCreate).toUpperCase();
  return s.includes('PREPARACAO_INICIADA')
    && s.includes('ITEM_PRONTO')
    && s.includes('BEBIDA_ENTREGUE');
}

function checkIdempotenciaAceitaRetirada(sqlCreate) {
  return checkIdempotenciaAceitaPreparacao(sqlCreate)
    && String(sqlCreate || '').toUpperCase().includes('RETIRADA_CONFIRMADA');
}

function checkIdempotenciaAceitaCancelamento(sqlCreate) {
  return checkIdempotenciaAceitaRetirada(sqlCreate)
    && String(sqlCreate || '').toUpperCase().includes('CANCELAMENTO_RODADA');
}

function checkIdempotenciaAceitaRetorno(sqlCreate) {
  return checkIdempotenciaAceitaCancelamento(sqlCreate)
    && String(sqlCreate || '').toUpperCase().includes('PREPARACAO_REVERTIDA');
}

async function validarColunasIdempotencia(db, tabela = 'cozinha_idempotencia') {
  const cols = await dbAll(db, `PRAGMA table_info(${tabela})`);
  const nomes = new Set((cols || []).map((c) => String(c.name)));
  for (const col of IDEMPOTENCIA_COLUNAS) {
    if (!nomes.has(col)) {
      const err = new Error(
        `[COZINHA] Estrutura inesperada em ${tabela}: coluna ausente '${col}'.`
      );
      err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
      throw err;
    }
  }
  return cols;
}

async function pragmaIntegrityOk(db) {
  const row = await dbGet(db, `PRAGMA integrity_check`);
  const ok = row && String(row.integrity_check || Object.values(row)[0] || '').toLowerCase() === 'ok';
  if (!ok) {
    const err = new Error(
      `[COZINHA] integrity_check falhou: ${JSON.stringify(row)}`
    );
    err.codigo = 'COZINHA_INTEGRITY_CHECK_FALHOU';
    throw err;
  }
}

/**
 * Valida se o nome está na lista controlada do domínio (anti-injeção).
 */
function exigirTabelaCozinhaFkCheck(nome) {
  const t = String(nome || '');
  if (!RE_IDENTIFICADOR_SQL_COZINHA.test(t) || !TABELAS_COZINHA_FK_CHECK.includes(t)) {
    const err = new Error(`[COZINHA] Identificador de tabela não autorizado para FK check: ${t}`);
    err.codigo = 'COZINHA_FK_CHECK_TABELA_INVALIDA';
    throw err;
  }
  return t;
}

/**
 * FK-02 — Integridade referencial limitada ao domínio Cozinha.
 * Usa `PRAGMA foreign_key_check(tabela)` por tabela da lista controlada.
 * Não varre órfãos legados do ERP fora do domínio.
 * Continua validando FKs declaradas nas tabelas Cozinha (internas e para o ERP).
 */
async function verificarForeignKeysDominioCozinha(db) {
  const violacoes = [];
  for (const tabelaBruta of TABELAS_COZINHA_FK_CHECK) {
    const tabela = exigirTabelaCozinhaFkCheck(tabelaBruta);
    const existe = await dbGet(db, `
      SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?
    `, [tabela]);
    if (!existe) continue;
    // Identificador já validado contra whitelist interna — interpolação segura.
    const rows = await dbAll(db, `PRAGMA foreign_key_check(${tabela})`);
    if (rows && rows.length) {
      for (const row of rows) {
        violacoes.push({
          table: row.table || tabela,
          rowid: row.rowid,
          parent: row.parent,
          fkid: row.fkid
        });
      }
    }
  }
  return violacoes;
}

async function pragmaForeignKeyCheckOk(db) {
  const rows = await verificarForeignKeysDominioCozinha(db);
  if (rows && rows.length > 0) {
    const err = new Error(
      `[COZINHA] foreign_key_check (domínio Cozinha) encontrou ${rows.length} violação(ões).`
    );
    err.codigo = 'COZINHA_FK_CHECK_FALHOU';
    err.detalhes = rows.slice(0, 20);
    throw err;
  }
}

/**
 * Recria schema completo somente quando não há dados (v0/v1 → versão atual).
 * Populado com versão < 2 continua bloqueado (sem perda silenciosa).
 */
async function recriarSchemaVazioSeNecessario(db, versaoAtual) {
  if (versaoAtual >= 2) return { recriado: false };

  let total = 0;
  for (const t of TABELAS_COZINHA) {
    total += await contarLinhas(db, t);
  }
  if (total > 0) {
    const err = new Error(
      `[COZINHA] FALHA_SCHEMA: upgrade de v${versaoAtual || 0} para v${COZINHA_SCHEMA_VERSION} ` +
      `exige recriação completa, mas existem ${total} linha(s) em tabelas cozinha_*. ` +
      `Interrompido sem apagar dados.`
    );
    err.codigo = 'COZINHA_SCHEMA_UPGRADE_BLOQUEADO';
    throw err;
  }

  console.warn(
    `[COZINHA] Recriando schema vazio v${versaoAtual || 0} → v${COZINHA_SCHEMA_VERSION} ` +
    '(tabelas vazias; FKs compostas empresa_id)'
  );

  await dbRun(db, 'PRAGMA foreign_keys = OFF');
  try {
    // Auxiliar de autorização (fora de TABELAS_COZINHA / sem bump de versão)
    await dbRun(db, 'DROP TABLE IF EXISTS cozinha_operador_unidades');
    for (const t of TABELAS_COZINHA) {
      await dbRun(db, `DROP TABLE IF EXISTS ${t}`);
    }
  } finally {
    await dbRun(db, 'PRAGMA foreign_keys = ON');
  }
  return { recriado: true };
}

function lerEstadoForeignKeys(pragmaRow) {
  if (!pragmaRow) return false;
  const v = pragmaRow.foreign_keys != null
    ? pragmaRow.foreign_keys
    : Object.values(pragmaRow)[0];
  return Number(v) === 1;
}

async function restaurarForeignKeys(db, fkWasOn) {
  await dbRun(db, fkWasOn ? 'PRAGMA foreign_keys = ON' : 'PRAGMA foreign_keys = OFF');
}

async function preservarSequencia(db, tabela, sequencia) {
  if (!sequencia) return;
  const resultado = await dbRun(db, `
    UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?
  `, [sequencia.seq, tabela]);
  if (!resultado.changes) {
    await dbRun(db, `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, [tabela, sequencia.seq]);
  }
}

/**
 * Migração segura v2 → v3: reconstrói cozinha_idempotencia ampliando o CHECK,
 * com cópia integral dos registros. Demais tabelas permanecem intactas.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.simularFalha]
 *   'falha_fk_off' | 'falha_begin' | 'apos_copia' | 'antes_meta' | 'falha_fk_restaurar'
 */
async function migrarCozinhaV2paraV3(db, opts = {}) {
  const existe = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_idempotencia'
  `);
  if (!existe) {
    const err = new Error(
      '[COZINHA] Migração v2→v3: tabela cozinha_idempotencia ausente.'
    );
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }

  const sqlAntes = await obterSqlTabela(db, 'cozinha_idempotencia');
  await validarColunasIdempotencia(db, 'cozinha_idempotencia');

  if (checkIdempotenciaAceitaPreparacao(sqlAntes)) {
    await gravarVersaoSchema(db, 3);
    return {
      migrado: true,
      jaCompativel: true,
      registros: await contarLinhas(db, 'cozinha_idempotencia')
    };
  }

  // CORREÇÃO 02: backup residual — não DROP, não sobrescrever, não renomear.
  const bakResidual = await dbGet(db, `
    SELECT name FROM sqlite_master
    WHERE type='table' AND name='cozinha_idempotencia__v2_bak'
  `);
  if (bakResidual) {
    const nBak = await contarLinhas(db, 'cozinha_idempotencia__v2_bak');
    const err = new Error(
      '[COZINHA] Migração v2→v3 interrompida: existe backup residual ' +
      `cozinha_idempotencia__v2_bak (${nBak} registro(s)). ` +
      'Tabela original e backup preservados — intervenção manual necessária.'
    );
    err.codigo = 'COZINHA_MIGRACAO_BACKUP_RESIDUAL';
    err.detalhes = { tabela: 'cozinha_idempotencia__v2_bak', registros: nBak };
    throw err;
  }

  const contagemAntes = await contarLinhas(db, 'cozinha_idempotencia');
  const snapshotAntes = await dbAll(db, `
    SELECT ${IDEMPOTENCIA_COLUNAS.join(', ')}
    FROM cozinha_idempotencia
    ORDER BY id
  `);

  const fkAntes = await dbGet(db, `PRAGMA foreign_keys`);
  const fkWasOn = lerEstadoForeignKeys(fkAntes);
  let fkAlteradas = false;
  let transacaoAberta = false;
  let erroPrincipal = null;

  try {
    // SQLite: PRAGMA foreign_keys só muda fora de transação.
    if (opts.simularFalha === 'falha_fk_off') {
      const err = new Error(
        '[COZINHA] Falha ao desabilitar PRAGMA foreign_keys antes da migração v2→v3.'
      );
      err.codigo = 'COZINHA_FK_DESABILITAR_FALHOU';
      throw err;
    }
    try {
      await dbRun(db, 'PRAGMA foreign_keys = OFF');
    } catch (fkOffErr) {
      const err = new Error(
        '[COZINHA] Falha ao desabilitar PRAGMA foreign_keys antes da migração v2→v3.'
      );
      err.codigo = 'COZINHA_FK_DESABILITAR_FALHOU';
      err.causa = fkOffErr;
      err.detalhes = { mensagem_original: fkOffErr && fkOffErr.message };
      throw err;
    }
    fkAlteradas = true;

    if (opts.simularFalha === 'falha_begin') {
      const err = new Error('[COZINHA] Falha simulada ao iniciar BEGIN IMMEDIATE (teste).');
      err.codigo = 'COZINHA_MIGRACAO_BEGIN_FALHOU';
      throw err;
    }

    try {
      await dbRun(db, 'BEGIN IMMEDIATE');
      transacaoAberta = true;
    } catch (beginErr) {
      const err = new Error(
        '[COZINHA] BEGIN IMMEDIATE falhou na migração v2→v3.'
      );
      err.codigo = 'COZINHA_MIGRACAO_BEGIN_FALHOU';
      err.causa = beginErr;
      err.detalhes = { mensagem_original: beginErr && beginErr.message };
      throw err;
    }

    try {
      await dbRun(db, `
        ALTER TABLE cozinha_idempotencia RENAME TO cozinha_idempotencia__v2_bak
      `);

      await dbRun(db, SQL_CREATE_COZINHA_IDEMPOTENCIA_V3);

      const cols = IDEMPOTENCIA_COLUNAS.join(', ');
      await dbRun(db, `
        INSERT INTO cozinha_idempotencia (${cols})
        SELECT ${cols} FROM cozinha_idempotencia__v2_bak
      `);

      const contagemDepoisCopia = await contarLinhas(db, 'cozinha_idempotencia');
      if (contagemDepoisCopia !== contagemAntes) {
        const err = new Error(
          `[COZINHA] Migração v2→v3: contagem divergente ` +
          `(antes=${contagemAntes}, depois=${contagemDepoisCopia}).`
        );
        err.codigo = 'COZINHA_MIGRACAO_CONTAGEM';
        throw err;
      }

      const snapshotDepois = await dbAll(db, `
        SELECT ${cols} FROM cozinha_idempotencia ORDER BY id
      `);
      if (JSON.stringify(snapshotAntes) !== JSON.stringify(snapshotDepois)) {
        const err = new Error(
          '[COZINHA] Migração v2→v3: conteúdo de cozinha_idempotencia divergiu após cópia.'
        );
        err.codigo = 'COZINHA_MIGRACAO_CONTEUDO';
        throw err;
      }

      if (opts.simularFalha === 'apos_copia') {
        const err = new Error('[COZINHA] Falha simulada após cópia (teste Sprint 04A).');
        err.codigo = 'COZINHA_MIGRACAO_SIMULADA';
        throw err;
      }

      await dbRun(db, `DROP TABLE cozinha_idempotencia__v2_bak`);

      await dbRun(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_idempotencia_key
        ON cozinha_idempotencia(idempotency_key)
      `);
      await dbRun(db, `
        CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_tipo_recurso
        ON cozinha_idempotencia(tipo_operacao, recurso_id)
      `);
      await dbRun(db, `
        CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_situacao_criado
        ON cozinha_idempotencia(situacao, created_at)
      `);

      const maxId = await dbGet(db, `
        SELECT COALESCE(MAX(id), 0) AS m FROM cozinha_idempotencia
      `);
      const seqExiste = await dbGet(db, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'
      `);
      if (seqExiste && Number(maxId.m) > 0) {
        const seqRow = await dbGet(db, `
          SELECT seq FROM sqlite_sequence WHERE name = 'cozinha_idempotencia'
        `);
        if (seqRow) {
          await dbRun(db, `
            UPDATE sqlite_sequence SET seq = ? WHERE name = 'cozinha_idempotencia'
          `, [Number(maxId.m)]);
        } else {
          await dbRun(db, `
            INSERT INTO sqlite_sequence(name, seq) VALUES ('cozinha_idempotencia', ?)
          `, [Number(maxId.m)]);
        }
      }

      const sqlNovo = await obterSqlTabela(db, 'cozinha_idempotencia');
      if (!checkIdempotenciaAceitaPreparacao(sqlNovo)) {
        const err = new Error(
          '[COZINHA] Migração v2→v3: CHECK de tipo_operacao não aceita preparação após rebuild.'
        );
        err.codigo = 'COZINHA_MIGRACAO_CHECK';
        throw err;
      }

      await dbRun(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, payload_hash, situacao
        ) VALUES (
          '__cozinha_v3_smoke_prep__', 'PREPARACAO_INICIADA', 'smoke', 'FALHA_VALIDACAO'
        )
      `);
      await dbRun(db, `
        DELETE FROM cozinha_idempotencia WHERE idempotency_key = '__cozinha_v3_smoke_prep__'
      `);

      if (opts.simularFalha === 'antes_meta') {
        const err = new Error('[COZINHA] Falha simulada antes de gravar meta (teste Sprint 04A).');
        err.codigo = 'COZINHA_MIGRACAO_SIMULADA';
        throw err;
      }

      await pragmaIntegrityOk(db);
      await pragmaForeignKeyCheckOk(db);

      await gravarVersaoSchema(db, 3);
      await dbRun(db, 'COMMIT');
      transacaoAberta = false;

      console.warn(
        `[COZINHA] Migração schema v2 → v3 concluída ` +
        `(cozinha_idempotencia: ${contagemAntes} registro(s) preservado(s)).`
      );

      return {
        migrado: true,
        jaCompativel: false,
        registros: contagemAntes,
        de: 2,
        para: 3
      };
    } catch (errTx) {
      if (transacaoAberta) {
        try {
          await dbRun(db, 'ROLLBACK');
        } catch (_e) { /* já desfeita */ }
        transacaoAberta = false;
      }
      if (!errTx.codigo) errTx.codigo = 'COZINHA_MIGRACAO_V2_V3_FALHOU';
      throw errTx;
    }
  } catch (errMig) {
    erroPrincipal = errMig;
    throw errMig;
  } finally {
    // Restaura FKs em todos os caminhos. Falha NÃO é silenciosa.
    if (fkAlteradas) {
      let erroRestauracao = null;
      try {
        if (
          opts.simularFalha === 'falha_fk_restaurar'
          || opts.forcarFalhaRestauracao === true
        ) {
          const err = new Error(
            '[COZINHA] Falha simulada ao restaurar PRAGMA foreign_keys (teste).'
          );
          err.codigo = 'COZINHA_FK_RESTAURACAO_FALHOU';
          throw err;
        }
        await restaurarForeignKeys(db, fkWasOn);
      } catch (fkErr) {
        erroRestauracao = new Error(
          '[COZINHA] Falha ao restaurar PRAGMA foreign_keys após migração v2→v3. ' +
          'A conexão pode estar com configuração de FKs inesperada.'
        );
        erroRestauracao.codigo = 'COZINHA_FK_RESTAURACAO_FALHOU';
        erroRestauracao.detalhes = {
          foreign_keys_esperado: fkWasOn ? 'ON' : 'OFF',
          mensagem_restauracao: fkErr && fkErr.message,
          aviso: 'Não tratar a operação como integralmente concluída.'
        };
        if (erroPrincipal) {
          erroRestauracao.erro_migracao = {
            codigo: erroPrincipal.codigo || null,
            mensagem: erroPrincipal.message || String(erroPrincipal)
          };
          erroRestauracao.causa = erroPrincipal;
        }
        if (fkErr && fkErr.codigo === 'COZINHA_FK_RESTAURACAO_FALHOU' && !erroPrincipal) {
          // preserva código do gancho de teste
          erroRestauracao.codigo = 'COZINHA_FK_RESTAURACAO_FALHOU';
        }
        console.error(
          '[COZINHA] Falha ao restaurar PRAGMA foreign_keys após migração:',
          fkErr && fkErr.message,
          erroPrincipal
            ? `| erro_migracao=${erroPrincipal.codigo || erroPrincipal.message}`
            : ''
        );
      }
      if (erroRestauracao) {
        // Propaga sempre: sobrescreve sucesso aparente e preserva diagnóstico duplo.
        throw erroRestauracao;
      }
    }
  }
}

/**
 * Migração segura v3 → v4: amplia o CHECK de idempotência para retirada,
 * preservando integralmente os registros existentes.
 */
async function migrarCozinhaV3paraV4(db, opts = {}) {
  const existe = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_idempotencia'
  `);
  if (!existe) {
    const err = new Error(
      '[COZINHA] Migração v3→v4: tabela cozinha_idempotencia ausente.'
    );
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }

  const sqlAntes = await obterSqlTabela(db, 'cozinha_idempotencia');
  await validarColunasIdempotencia(db, 'cozinha_idempotencia');
  if (checkIdempotenciaAceitaRetirada(sqlAntes)) {
    await gravarVersaoSchema(db, 4);
    return {
      migrado: true,
      jaCompativel: true,
      registros: await contarLinhas(db, 'cozinha_idempotencia')
    };
  }
  if (!checkIdempotenciaAceitaPreparacao(sqlAntes)) {
    const err = new Error(
      '[COZINHA] Meta=v3 mas CHECK de cozinha_idempotencia não aceita o contrato v3.'
    );
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }

  const backup = 'cozinha_idempotencia__v3_bak';
  const bakResidual = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `, [backup]);
  if (bakResidual) {
    const err = new Error(
      `[COZINHA] Migração v3→v4 interrompida: existe backup residual ${backup}.`
    );
    err.codigo = 'COZINHA_MIGRACAO_BACKUP_RESIDUAL';
    err.detalhes = { tabela: backup, registros: await contarLinhas(db, backup) };
    throw err;
  }

  const contagemAntes = await contarLinhas(db, 'cozinha_idempotencia');
  const colunas = IDEMPOTENCIA_COLUNAS.join(', ');
  const snapshotAntes = await dbAll(db, `
    SELECT ${colunas} FROM cozinha_idempotencia ORDER BY id
  `);
  const fkAntes = await dbGet(db, 'PRAGMA foreign_keys');
  const fkWasOn = lerEstadoForeignKeys(fkAntes);
  let fkAlteradas = false;
  let transacaoAberta = false;
  let erroPrincipal = null;

  try {
    if (opts.simularFalha === 'falha_fk_off') {
      const err = new Error('[COZINHA] Falha simulada ao desabilitar FKs na migração v3→v4.');
      err.codigo = 'COZINHA_FK_DESABILITAR_FALHOU';
      throw err;
    }
    await dbRun(db, 'PRAGMA foreign_keys = OFF');
    fkAlteradas = true;

    if (opts.simularFalha === 'falha_begin') {
      const err = new Error('[COZINHA] Falha simulada ao iniciar a migração v3→v4.');
      err.codigo = 'COZINHA_MIGRACAO_BEGIN_FALHOU';
      throw err;
    }
    await dbRun(db, 'BEGIN IMMEDIATE');
    transacaoAberta = true;

    try {
      await dbRun(db, `ALTER TABLE cozinha_idempotencia RENAME TO ${backup}`);
      await dbRun(db, SQL_CREATE_COZINHA_IDEMPOTENCIA_V4);
      await dbRun(db, `
        INSERT INTO cozinha_idempotencia (${colunas})
        SELECT ${colunas} FROM ${backup}
      `);

      const contagemDepois = await contarLinhas(db, 'cozinha_idempotencia');
      if (contagemDepois !== contagemAntes) {
        const err = new Error(
          `[COZINHA] Migração v3→v4: contagem divergente ` +
          `(antes=${contagemAntes}, depois=${contagemDepois}).`
        );
        err.codigo = 'COZINHA_MIGRACAO_CONTAGEM';
        throw err;
      }
      const snapshotDepois = await dbAll(db, `
        SELECT ${colunas} FROM cozinha_idempotencia ORDER BY id
      `);
      if (JSON.stringify(snapshotAntes) !== JSON.stringify(snapshotDepois)) {
        const err = new Error(
          '[COZINHA] Migração v3→v4: registros divergentes após a cópia.'
        );
        err.codigo = 'COZINHA_MIGRACAO_CONTEUDO';
        throw err;
      }
      if (opts.simularFalha === 'apos_copia') {
        const err = new Error('[COZINHA] Falha simulada após cópia na migração v3→v4.');
        err.codigo = 'COZINHA_MIGRACAO_SIMULADA';
        throw err;
      }

      await dbRun(db, `DROP TABLE ${backup}`);
      await dbRun(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_idempotencia_key
        ON cozinha_idempotencia(idempotency_key)
      `);
      await dbRun(db, `
        CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_tipo_recurso
        ON cozinha_idempotencia(tipo_operacao, recurso_id)
      `);
      await dbRun(db, `
        CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_situacao_criado
        ON cozinha_idempotencia(situacao, created_at)
      `);

      const maxId = await dbGet(db, `
        SELECT COALESCE(MAX(id), 0) AS m FROM cozinha_idempotencia
      `);
      if (Number(maxId.m) > 0) {
        const seqRow = await dbGet(db, `
          SELECT seq FROM sqlite_sequence WHERE name='cozinha_idempotencia'
        `);
        if (seqRow) {
          await dbRun(db, `
            UPDATE sqlite_sequence SET seq=? WHERE name='cozinha_idempotencia'
          `, [Number(maxId.m)]);
        } else {
          await dbRun(db, `
            INSERT INTO sqlite_sequence(name, seq) VALUES ('cozinha_idempotencia', ?)
          `, [Number(maxId.m)]);
        }
      }

      const sqlNovo = await obterSqlTabela(db, 'cozinha_idempotencia');
      if (!checkIdempotenciaAceitaRetirada(sqlNovo)) {
        const err = new Error(
          '[COZINHA] Migração v3→v4: CHECK não aceita RETIRADA_CONFIRMADA.'
        );
        err.codigo = 'COZINHA_MIGRACAO_CHECK';
        throw err;
      }
      await dbRun(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, payload_hash, situacao
        ) VALUES (
          '__cozinha_v4_smoke_retirada__', 'RETIRADA_CONFIRMADA', 'smoke', 'FALHA_VALIDACAO'
        )
      `);
      await dbRun(db, `
        DELETE FROM cozinha_idempotencia
        WHERE idempotency_key='__cozinha_v4_smoke_retirada__'
      `);
      if (opts.simularFalha === 'antes_meta') {
        const err = new Error('[COZINHA] Falha simulada antes da meta na migração v3→v4.');
        err.codigo = 'COZINHA_MIGRACAO_SIMULADA';
        throw err;
      }

      await pragmaIntegrityOk(db);
      await pragmaForeignKeyCheckOk(db);
      await gravarVersaoSchema(db, 4);
      await dbRun(db, 'COMMIT');
      transacaoAberta = false;
      return {
        migrado: true,
        jaCompativel: false,
        registros: contagemAntes,
        de: 3,
        para: 4
      };
    } catch (errTx) {
      if (transacaoAberta) {
        try {
          await dbRun(db, 'ROLLBACK');
        } catch (_e) { /* já desfeita */ }
        transacaoAberta = false;
      }
      if (!errTx.codigo) errTx.codigo = 'COZINHA_MIGRACAO_V3_V4_FALHOU';
      throw errTx;
    }
  } catch (errMig) {
    erroPrincipal = errMig;
    throw errMig;
  } finally {
    if (fkAlteradas) {
      try {
        await restaurarForeignKeys(db, fkWasOn);
      } catch (fkErr) {
        const err = new Error(
          '[COZINHA] Falha ao restaurar foreign_keys após migração v3→v4.'
        );
        err.codigo = 'COZINHA_FK_RESTAURACAO_FALHOU';
        err.detalhes = {
          foreign_keys_esperado: fkWasOn ? 'ON' : 'OFF',
          mensagem_restauracao: fkErr && fkErr.message,
          erro_migracao: erroPrincipal
            ? { codigo: erroPrincipal.codigo || null, mensagem: erroPrincipal.message }
            : null
        };
        err.causa = erroPrincipal || fkErr;
        throw err;
      }
    }
  }
}

async function migrarCozinhaV4paraV5(db, opts = {}) {
  const existe = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_idempotencia'
  `);
  if (!existe) {
    const err = new Error(
      '[COZINHA] Migração v4→v5: tabela cozinha_idempotencia ausente.'
    );
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }

  const sqlAntes = await obterSqlTabela(db, 'cozinha_rodadas');
  if (!sqlAntes) {
    const err = new Error('[COZINHA] Migração v4→v5: tabela cozinha_rodadas ausente.');
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }

  await validarColunasIdempotencia(db);
  const sqlIdempotencia = await obterSqlTabela(db, 'cozinha_idempotencia');
  if (!checkIdempotenciaAceitaRetirada(sqlIdempotencia)) {
    const err = new Error('[COZINHA] Meta=v4 mas CHECK de idempotência não aceita retirada.');
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }

  const fkAntes = await dbGet(db, 'PRAGMA foreign_keys');
  const fkWasOn = lerEstadoForeignKeys(fkAntes);
  let fkAlteradas = false;
  let transacaoAberta = false;
  let erroPrincipal = null;

  try {
    if (opts.simularFalha === 'falha_fk_off') {
      const err = new Error('[COZINHA] Falha simulada ao desabilitar FKs na migração v4→v5.');
      err.codigo = 'COZINHA_FK_DESABILITAR_FALHOU';
      throw err;
    }
    await dbRun(db, 'PRAGMA foreign_keys = OFF');
    fkAlteradas = true;

    if (opts.simularFalha === 'falha_begin') {
      const err = new Error('[COZINHA] Falha simulada ao iniciar BEGIN IMMEDIATE na migração v4→v5.');
      err.codigo = 'COZINHA_MIGRACAO_BEGIN_FALHOU';
      throw err;
    }
    await dbRun(db, 'BEGIN IMMEDIATE');
    transacaoAberta = true;

    try {
      for (const tabela of [
        'cozinha_rodadas__v4_bak',
        'cozinha_rodadas__v5_nova',
        'cozinha_idempotencia__v5_nova'
      ]) {
        const residual = await dbGet(db, `
          SELECT name FROM sqlite_master WHERE type='table' AND name=?
        `, [tabela]);
        if (residual) {
          const err = new Error(
            `[COZINHA] Migração v4→v5 interrompida: existe tabela residual ${tabela}.`
          );
          err.codigo = 'COZINHA_MIGRACAO_BACKUP_RESIDUAL';
          throw err;
        }
      }

      const contagemAntes = await contarLinhas(db, 'cozinha_rodadas');
      const sqlColunasAntes = await dbAll(db, 'PRAGMA table_info(cozinha_rodadas)');
      const colunasAntes = sqlColunasAntes.map(c => c.name);
      const colunasCancelamento = [
        'cancelamento_motivo',
        'cancelamento_justificativa',
        'cancelamento_por',
        'cancelamento_em',
        'cancelamento_etapa'
      ];

      const cancelamentoExistente = colunasCancelamento.filter(c => colunasAntes.includes(c));
      if (cancelamentoExistente.length !== 0 && cancelamentoExistente.length !== colunasCancelamento.length) {
        const err = new Error('[COZINHA] Migração v4→v5: colunas de cancelamento incompletas.');
        err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
        throw err;
      }

      const jaPossuiCancelamento = cancelamentoExistente.length === colunasCancelamento.length;
      const jaPossuiIdempotencia = checkIdempotenciaAceitaCancelamento(sqlIdempotencia);
      if (!jaPossuiCancelamento) {
        const objetosRodadas = await dbAll(db, `
          SELECT sql FROM sqlite_master
          WHERE tbl_name='cozinha_rodadas' AND type IN ('index', 'trigger') AND sql IS NOT NULL
        `);
        const sequenciaRodadas = await dbGet(db, `
          SELECT seq FROM sqlite_sequence WHERE name='cozinha_rodadas'
        `);
        const colunasComumStr = colunasAntes.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');

        await dbRun(db, `
          CREATE TABLE cozinha_rodadas__v5_nova (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            empresa_id INTEGER NOT NULL,
            unidade_id INTEGER NOT NULL,
            mesa_id INTEGER NOT NULL,
            atendimento_id INTEGER NOT NULL,
            numero_rodada INTEGER NOT NULL,
            sequencia_global INTEGER NOT NULL,
            enviada_em TEXT,
            operador_envio_id INTEGER,
            estado_preparacao TEXT NOT NULL DEFAULT 'AGUARDANDO'
              CHECK (estado_preparacao IN ('AGUARDANDO', 'EM_PREPARACAO', 'PRONTA', 'CANCELADA')),
            retirada_estado TEXT NOT NULL DEFAULT 'PENDENTE'
              CHECK (retirada_estado IN ('PENDENTE', 'ASSUMIDA_RETIRADA', 'RETIRADA')),
            retirada_em TEXT,
            retirada_por INTEGER,
            entrega_estado TEXT NOT NULL DEFAULT 'PENDENTE'
              CHECK (entrega_estado IN ('PENDENTE', 'ENTREGUE')),
            entrega_em TEXT,
            entrega_por INTEGER,
            cancelamento_motivo TEXT
              CHECK (cancelamento_motivo IS NULL OR cancelamento_motivo IN (
                'PRAZO_EXCEDIDO',
                'CLIENTE_DESISTIU',
                'CANCELAMENTO_IFOOD',
                'PEDIDO_DUPLICADO',
                'ERRO_LANCAMENTO',
                'FALTA_PRODUTO',
                'OUTRO'
              )),
            cancelamento_justificativa TEXT,
            cancelamento_por INTEGER,
            cancelamento_em TEXT,
            cancelamento_etapa TEXT,
            idempotency_key_despacho TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT,
            CHECK (numero_rodada > 0),
            CHECK (sequencia_global > 0),
            UNIQUE (id, empresa_id),
            FOREIGN KEY (unidade_id, empresa_id)
              REFERENCES cozinha_unidades(id, empresa_id)
          )
        `);

        await dbRun(db, `
          INSERT INTO cozinha_rodadas__v5_nova (${colunasComumStr})
          SELECT ${colunasComumStr} FROM cozinha_rodadas
        `);

        const contagemDepois = await contarLinhas(db, 'cozinha_rodadas__v5_nova');
        if (contagemDepois !== contagemAntes) {
          const err = new Error(
            `[COZINHA] Migração v4→v5: contagem divergente ` +
            `(antes=${contagemAntes}, depois=${contagemDepois}).`
          );
          err.codigo = 'COZINHA_MIGRACAO_CONTAGEM';
          throw err;
        }

        await dbRun(db, 'DROP TABLE cozinha_rodadas');
        await dbRun(db, 'ALTER TABLE cozinha_rodadas__v5_nova RENAME TO cozinha_rodadas');
        for (const objeto of objetosRodadas) await dbRun(db, objeto.sql);
        await preservarSequencia(db, 'cozinha_rodadas', sequenciaRodadas);
      }

      if (!jaPossuiIdempotencia) {
        const colunas = await dbAll(db, 'PRAGMA table_info(cozinha_idempotencia)');
        if (colunas.length !== IDEMPOTENCIA_COLUNAS.length) {
          const err = new Error('[COZINHA] Migração v4→v5: colunas extras em cozinha_idempotencia.');
          err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
          throw err;
        }
        const objetosIdempotencia = await dbAll(db, `
          SELECT sql FROM sqlite_master
          WHERE tbl_name='cozinha_idempotencia' AND type IN ('index', 'trigger') AND sql IS NOT NULL
        `);
        const sequenciaIdempotencia = await dbGet(db, `
          SELECT seq FROM sqlite_sequence WHERE name='cozinha_idempotencia'
        `);
        const cols = IDEMPOTENCIA_COLUNAS.join(', ');
        const contagemIdempotencia = await contarLinhas(db, 'cozinha_idempotencia');
        await dbRun(db, SQL_CREATE_COZINHA_IDEMPOTENCIA_V5.replace(
          'IF NOT EXISTS cozinha_idempotencia',
          'IF NOT EXISTS cozinha_idempotencia__v5_nova'
        ));
        await dbRun(db, `
          INSERT INTO cozinha_idempotencia__v5_nova (${cols})
          SELECT ${cols} FROM cozinha_idempotencia
        `);
        if (await contarLinhas(db, 'cozinha_idempotencia__v5_nova') !== contagemIdempotencia) {
          const err = new Error('[COZINHA] Migração v4→v5: contagem de idempotência divergente.');
          err.codigo = 'COZINHA_MIGRACAO_CONTAGEM';
          throw err;
        }
        await dbRun(db, 'DROP TABLE cozinha_idempotencia');
        await dbRun(db, 'ALTER TABLE cozinha_idempotencia__v5_nova RENAME TO cozinha_idempotencia');
        for (const objeto of objetosIdempotencia) await dbRun(db, objeto.sql);
        await preservarSequencia(db, 'cozinha_idempotencia', sequenciaIdempotencia);
      }

      if (opts.simularFalha === 'apos_copia') {
        const err = new Error('[COZINHA] Falha simulada após cópia na migração v4→v5.');
        err.codigo = 'COZINHA_MIGRACAO_SIMULADA';
        throw err;
      }

      await pragmaIntegrityOk(db);
      await pragmaForeignKeyCheckOk(db);

      await dbRun(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, payload_hash, situacao
        ) VALUES (
          '__cozinha_v5_smoke_cancelamento__', 'CANCELAMENTO_RODADA', 'smoke', 'FALHA_VALIDACAO'
        )
      `);
      await dbRun(db, `
        DELETE FROM cozinha_idempotencia
        WHERE idempotency_key='__cozinha_v5_smoke_cancelamento__'
      `);

      await gravarVersaoSchema(db, 5);
      await dbRun(db, 'COMMIT');
      transacaoAberta = false;
      return {
        migrado: true,
        jaCompativel: jaPossuiCancelamento && jaPossuiIdempotencia,
        registros: contagemAntes,
        de: 4,
        para: 5
      };
    } catch (errTx) {
      if (transacaoAberta) {
        try {
          await dbRun(db, 'ROLLBACK');
        } catch (_e) { /* já desfeita */ }
        transacaoAberta = false;
      }
      if (!errTx.codigo) errTx.codigo = 'COZINHA_MIGRACAO_V4_V5_FALHOU';
      throw errTx;
    }
  } catch (errMig) {
    erroPrincipal = errMig;
    throw errMig;
  } finally {
    if (fkAlteradas) {
      try {
        await restaurarForeignKeys(db, fkWasOn);
      } catch (fkErr) {
        const err = new Error(
          '[COZINHA] Falha ao restaurar foreign_keys após migração v4→v5.'
        );
        err.codigo = 'COZINHA_FK_RESTAURACAO_FALHOU';
        err.detalhes = {
          foreign_keys_esperado: fkWasOn ? 'ON' : 'OFF',
          mensagem_restauracao: fkErr && fkErr.message,
          erro_migracao: erroPrincipal
            ? { codigo: erroPrincipal.codigo || null, mensagem: erroPrincipal.message }
            : null
        };
        err.causa = erroPrincipal || fkErr;
        throw err;
      }
    }
  }
}

async function migrarCozinhaV5paraV6(db, opts = {}) {
  return migrarIdempotencia(db, opts, 5, 6, SQL_CREATE_COZINHA_IDEMPOTENCIA_V6,
    checkIdempotenciaAceitaCancelamento, checkIdempotenciaAceitaRetorno);
}

async function migrarIdempotencia(db, opts, de, para, sqlCriacao, checkAnterior, checkNovo) {
  const sqlAntes = await obterSqlTabela(db, 'cozinha_idempotencia');
  if (!checkAnterior(sqlAntes)) {
    const err = new Error(`[COZINHA] Meta=v${de} mas CHECK de idempotência é incompatível.`);
    err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
    throw err;
  }
  await validarColunasIdempotencia(db);
  const fkAntes = await dbGet(db, 'PRAGMA foreign_keys');
  const fkWasOn = lerEstadoForeignKeys(fkAntes);
  let fkAlteradas = false;
  let transacaoAberta = false;
  let erroPrincipal = null;
  try {
    await dbRun(db, 'PRAGMA foreign_keys = OFF');
    fkAlteradas = true;
    await dbRun(db, 'BEGIN IMMEDIATE');
    transacaoAberta = true;
    const jaCompativel = checkNovo(sqlAntes);
    if (!jaCompativel) {
      const tabelaNova = `cozinha_idempotencia__v${para}_nova`;
      const residual = await dbGet(db, `
        SELECT name FROM sqlite_master WHERE type='table' AND name=?
      `, [tabelaNova]);
      if (residual) {
        const err = new Error(`[COZINHA] Migração v${de}→v${para} interrompida: tabela temporária residual.`);
        err.codigo = 'COZINHA_MIGRACAO_BACKUP_RESIDUAL';
        throw err;
      }
      const colunas = await dbAll(db, 'PRAGMA table_info(cozinha_idempotencia)');
      if (colunas.length !== IDEMPOTENCIA_COLUNAS.length) {
        const err = new Error(`[COZINHA] Migração v${de}→v${para}: colunas extras em cozinha_idempotencia.`);
        err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
        throw err;
      }
      const objetos = await dbAll(db, `
        SELECT sql FROM sqlite_master
        WHERE tbl_name='cozinha_idempotencia' AND type IN ('index', 'trigger') AND sql IS NOT NULL
      `);
      const sequencia = await dbGet(db, `
        SELECT seq FROM sqlite_sequence WHERE name='cozinha_idempotencia'
      `);
      const cols = IDEMPOTENCIA_COLUNAS.join(', ');
      const contagem = await contarLinhas(db, 'cozinha_idempotencia');
      await dbRun(db, sqlCriacao.replace(
        'IF NOT EXISTS cozinha_idempotencia',
        `IF NOT EXISTS ${tabelaNova}`
      ));
      await dbRun(db, `
        INSERT INTO ${tabelaNova} (${cols})
        SELECT ${cols} FROM cozinha_idempotencia
      `);
      if (await contarLinhas(db, tabelaNova) !== contagem) {
        const err = new Error(`[COZINHA] Migração v${de}→v${para}: contagem de idempotência divergente.`);
        err.codigo = 'COZINHA_MIGRACAO_CONTAGEM';
        throw err;
      }
      await dbRun(db, 'DROP TABLE cozinha_idempotencia');
      await dbRun(db, `ALTER TABLE ${tabelaNova} RENAME TO cozinha_idempotencia`);
      for (const objeto of objetos) await dbRun(db, objeto.sql);
      await preservarSequencia(db, 'cozinha_idempotencia', sequencia);
    }
    if (opts.simularFalha === `v${para}_apos_copia`) {
      const err = new Error(`[COZINHA] Falha simulada na migração v${de}→v${para}.`);
      err.codigo = 'COZINHA_MIGRACAO_SIMULADA';
      throw err;
    }
    await pragmaIntegrityOk(db);
    await pragmaForeignKeyCheckOk(db);
    await gravarVersaoSchema(db, para);
    await dbRun(db, 'COMMIT');
    transacaoAberta = false;
    return { migrado: true, jaCompativel, de, para };
  } catch (err) {
    erroPrincipal = err;
    if (transacaoAberta) {
      try {
        await dbRun(db, 'ROLLBACK');
      } catch (rollbackErr) {
        err.erro_rollback = rollbackErr;
      }
    }
    if (!err.codigo) err.codigo = `COZINHA_MIGRACAO_V${de}_V${para}_FALHOU`;
    throw err;
  } finally {
    if (fkAlteradas) {
      try {
        await restaurarForeignKeys(db, fkWasOn);
      } catch (fkErr) {
        const err = new Error(`[COZINHA] Falha ao restaurar foreign_keys após migração v${de}→v${para}.`);
        err.codigo = 'COZINHA_FK_RESTAURACAO_FALHOU';
        err.detalhes = {
          mensagem_restauracao: fkErr.message,
          erro_migracao: erroPrincipal ? erroPrincipal.message : null
        };
        throw err;
      }
    }
  }
}

async function criarTabelasCozinha(db) {
  // —— Unidades ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_unidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      codigo TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      sequencia_atual INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (sequencia_atual >= 0),
      UNIQUE (id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_unidades_empresa_codigo
    ON cozinha_unidades(empresa_id, codigo)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_unidades_id_empresa
    ON cozinha_unidades(id, empresa_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_unidades_empresa_ativo
    ON cozinha_unidades(empresa_id, ativo)
  `);

  // —— Comandas ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_comandas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      atendimento_id INTEGER NOT NULL,
      numero_comanda INTEGER NOT NULL,
      rotulo TEXT,
      pedido_id INTEGER,
      operador_lancamento_id INTEGER,
      registrado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (numero_comanda > 0),
      UNIQUE (id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_comandas_atendimento_numero
    ON cozinha_comandas(atendimento_id, numero_comanda)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_comandas_id_empresa
    ON cozinha_comandas(id, empresa_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_comandas_empresa_atendimento
    ON cozinha_comandas(empresa_id, atendimento_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_comandas_pedido
    ON cozinha_comandas(pedido_id)
  `);

  // —— Rodadas ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_rodadas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      atendimento_id INTEGER NOT NULL,
      numero_rodada INTEGER NOT NULL,
      sequencia_global INTEGER NOT NULL,
      enviada_em TEXT,
      operador_envio_id INTEGER,
      estado_preparacao TEXT NOT NULL DEFAULT 'AGUARDANDO'
        CHECK (estado_preparacao IN ('AGUARDANDO', 'EM_PREPARACAO', 'PRONTA', 'CANCELADA')),
      retirada_estado TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (retirada_estado IN ('PENDENTE', 'ASSUMIDA_RETIRADA', 'RETIRADA')),
      retirada_em TEXT,
      retirada_por INTEGER,
      entrega_estado TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (entrega_estado IN ('PENDENTE', 'ENTREGUE')),
      entrega_em TEXT,
      entrega_por INTEGER,
      cancelamento_motivo TEXT
        CHECK (cancelamento_motivo IS NULL OR cancelamento_motivo IN (
          'PRAZO_EXCEDIDO',
          'CLIENTE_DESISTIU',
          'CANCELAMENTO_IFOOD',
          'PEDIDO_DUPLICADO',
          'ERRO_LANCAMENTO',
          'FALTA_PRODUTO',
          'OUTRO'
        )),
      cancelamento_justificativa TEXT,
      cancelamento_por INTEGER,
      cancelamento_em TEXT,
      cancelamento_etapa TEXT,
      idempotency_key_despacho TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (numero_rodada > 0),
      CHECK (sequencia_global > 0),
      UNIQUE (id, empresa_id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_rodadas_atendimento_numero
    ON cozinha_rodadas(atendimento_id, numero_rodada)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_rodadas_unidade_sequencia
    ON cozinha_rodadas(unidade_id, sequencia_global)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_rodadas_idempotency
    ON cozinha_rodadas(idempotency_key_despacho)
    WHERE idempotency_key_despacho IS NOT NULL
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_rodadas_id_empresa
    ON cozinha_rodadas(id, empresa_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_rodadas_empresa_unidade_estado
    ON cozinha_rodadas(empresa_id, unidade_id, estado_preparacao, enviada_em)
  `);

  // —— Itens ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      comanda_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      sequencia_global INTEGER NOT NULL,
      tipo_item TEXT NOT NULL
        CHECK (tipo_item IN ('PASTEL', 'BEBIDA', 'OUTRO')),
      tipo_lancamento TEXT NOT NULL DEFAULT 'ORIGINAL'
        CHECK (tipo_lancamento IN ('ORIGINAL', 'COMPLEMENTO')),
      item_origem_id INTEGER,
      qty_solicitada_millis INTEGER NOT NULL,
      qty_preparada_millis INTEGER NOT NULL DEFAULT 0,
      qty_cancelada_millis INTEGER NOT NULL DEFAULT 0,
      estado_preparacao TEXT NOT NULL DEFAULT 'AGUARDANDO'
        CHECK (estado_preparacao IN ('AGUARDANDO', 'EM_PREPARACAO', 'PRONTO', 'CANCELADO')),
      produto_id INTEGER,
      produto_nome_snapshot TEXT,
      observacoes_snapshot TEXT,
      motivo_complemento TEXT,
      operador_complemento_id INTEGER,
      motivo_cancelamento TEXT,
      operador_cancelamento_id INTEGER,
      cancelado_em TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (qty_solicitada_millis > 0),
      CHECK (qty_preparada_millis >= 0),
      CHECK (qty_cancelada_millis >= 0),
      CHECK (qty_preparada_millis + qty_cancelada_millis <= qty_solicitada_millis),
      UNIQUE (id, empresa_id),
      FOREIGN KEY (rodada_id, empresa_id)
        REFERENCES cozinha_rodadas(id, empresa_id),
      FOREIGN KEY (comanda_id, empresa_id)
        REFERENCES cozinha_comandas(id, empresa_id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id),
      FOREIGN KEY (item_origem_id, empresa_id)
        REFERENCES cozinha_itens(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_itens_id_empresa
    ON cozinha_itens(id, empresa_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_itens_rodada_estado
    ON cozinha_itens(rodada_id, estado_preparacao)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_itens_unidade_sequencia
    ON cozinha_itens(unidade_id, sequencia_global)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_itens_pedido_item_estado
    ON cozinha_itens(pedido_item_id, estado_preparacao)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_itens_empresa
    ON cozinha_itens(empresa_id, rodada_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_itens_item_origem
    ON cozinha_itens(item_origem_id)
  `);

  // —— Ingredientes (sem empresa_id — isolamento via item) ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cozinha_item_id INTEGER NOT NULL,
      insumo_id INTEGER,
      insumo_nome_snapshot TEXT NOT NULL,
      quantidade_snapshot_millis INTEGER,
      unidade_snapshot TEXT,
      classificacao_comercial_snapshot TEXT,
      selecionado INTEGER NOT NULL DEFAULT 0,
      preco_adicional_snapshot_millis INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cozinha_item_id) REFERENCES cozinha_itens(id)
    )
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_item_ingredientes_item
    ON cozinha_item_ingredientes(cozinha_item_id)
  `);

  // —— Bebidas ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_bebida_entregas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      cozinha_item_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      qty_entregue_millis INTEGER NOT NULL,
      qty_restante_millis INTEGER NOT NULL,
      operador_id INTEGER NOT NULL,
      entregue_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      idempotency_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK (qty_entregue_millis > 0),
      CHECK (qty_restante_millis >= 0),
      FOREIGN KEY (cozinha_item_id, empresa_id)
        REFERENCES cozinha_itens(id, empresa_id),
      FOREIGN KEY (rodada_id, empresa_id)
        REFERENCES cozinha_rodadas(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_bebida_entregas_idempotency
    ON cozinha_bebida_entregas(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_bebida_entregas_item
    ON cozinha_bebida_entregas(cozinha_item_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_bebida_entregas_rodada
    ON cozinha_bebida_entregas(rodada_id)
  `);

  // —— Estações ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_estacoes_impressao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      codigo_estacao TEXT NOT NULL,
      device_name TEXT,
      largura_mm INTEGER NOT NULL DEFAULT 80
        CHECK (largura_mm IN (58, 80)),
      vias INTEGER NOT NULL DEFAULT 1 CHECK (vias > 0),
      modelo_individual INTEGER NOT NULL DEFAULT 1,
      modelo_agrupado INTEGER NOT NULL DEFAULT 1,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      UNIQUE (id, empresa_id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);
  // UNIQUE por (empresa, unidade, codigo) — permite PASTEL/BEBIDA/OUTRO em cada unidade.
  // Índice legado ux_cozinha_estacoes_empresa_codigo (só empresa+codigo) é removido em
  // garantirIndiceEstacoesCodigoPorUnidade (sem bump de versão / sem V4).
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_estacoes_empresa_unidade_codigo
    ON cozinha_estacoes_impressao(empresa_id, unidade_id, codigo_estacao)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_estacoes_id_empresa
    ON cozinha_estacoes_impressao(id, empresa_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_estacoes_unidade
    ON cozinha_estacoes_impressao(unidade_id)
  `);

  // —— Fila impressão ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_impressao_fila (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      estacao_impressao_id INTEGER,
      rodada_id INTEGER NOT NULL,
      payload_snapshot TEXT,
      modelo TEXT NOT NULL DEFAULT 'AGRUPADO'
        CHECK (modelo IN ('INDIVIDUAL', 'AGRUPADO')),
      vias INTEGER NOT NULL DEFAULT 1,
      estado TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (estado IN (
          'PENDENTE', 'PROCESSANDO', 'RESULTADO_INCERTO',
          'ACEITA_PELO_SPOOLER', 'FALHA', 'CANCELADA'
        )),
      tentativas INTEGER NOT NULL DEFAULT 0,
      max_tentativas INTEGER NOT NULL DEFAULT 5,
      ultimo_erro TEXT,
      job_origem_id INTEGER,
      spooler_job_token TEXT,
      processando_em TEXT,
      worker_id TEXT,
      idempotency_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      UNIQUE (id, empresa_id),
      FOREIGN KEY (rodada_id, empresa_id)
        REFERENCES cozinha_rodadas(id, empresa_id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id),
      FOREIGN KEY (estacao_impressao_id, empresa_id)
        REFERENCES cozinha_estacoes_impressao(id, empresa_id),
      FOREIGN KEY (job_origem_id, empresa_id)
        REFERENCES cozinha_impressao_fila(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_impressao_idempotency
    ON cozinha_impressao_fila(idempotency_key)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_impressao_id_empresa
    ON cozinha_impressao_fila(id, empresa_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_impressao_estado_criado
    ON cozinha_impressao_fila(estado, created_at)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_impressao_rodada
    ON cozinha_impressao_fila(rodada_id)
  `);

  // —— Notificações ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_notificacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      rodada_id INTEGER NOT NULL,
      evento_chave TEXT NOT NULL,
      modo TEXT NOT NULL
        CHECK (modo IN ('INDIVIDUAL', 'SIMULTANEA')),
      destinatario_usuario_id INTEGER,
      broadcast INTEGER NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'GERADA'
        CHECK (estado IN (
          'GERADA', 'DISPONIBILIZADA', 'RECEBIDA', 'ASSUMIDA', 'RETIRADA', 'ENTREGUE'
        )),
      assumida_por INTEGER,
      assumida_em TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (rodada_id, empresa_id)
        REFERENCES cozinha_rodadas(id, empresa_id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_notificacoes_evento
    ON cozinha_notificacoes(evento_chave)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_notificacoes_empresa_estado
    ON cozinha_notificacoes(empresa_id, estado)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_notificacoes_rodada
    ON cozinha_notificacoes(rodada_id)
  `);

  // —— Outbox (unidade opcional; FK composta só quando unidade_id NOT NULL via SQLite NULL=skip) ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_eventos_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      unidade_id INTEGER,
      tipo TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      publicado_em TEXT,
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_outbox_idempotency
    ON cozinha_eventos_outbox(idempotency_key)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_outbox_publicado_criado
    ON cozinha_eventos_outbox(publicado_em, created_at)
  `);

  // —— Controle teto ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_pedido_item_controle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      qty_referencia_despacho_millis INTEGER NOT NULL,
      qty_referencia_inicial_millis INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (qty_referencia_despacho_millis >= 0),
      CHECK (qty_referencia_inicial_millis >= 0)
    )
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_pedido_item_controle_item
    ON cozinha_pedido_item_controle(pedido_item_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_pedido_item_controle_empresa
    ON cozinha_pedido_item_controle(empresa_id, pedido_id)
  `);

  // —— Autorizações ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_autorizacoes_qty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      qty_autorizada_millis INTEGER NOT NULL,
      motivo TEXT NOT NULL,
      responsavel_operador_id INTEGER NOT NULL,
      autorizada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      idempotency_key TEXT,
      situacao TEXT NOT NULL DEFAULT 'ATIVA'
        CHECK (situacao IN ('ATIVA', 'ESTORNADA')),
      resposta_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      CHECK (qty_autorizada_millis > 0)
    )
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_autorizacoes_item_situacao
    ON cozinha_autorizacoes_qty(empresa_id, pedido_item_id, situacao)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_autorizacoes_pedido
    ON cozinha_autorizacoes_qty(pedido_id)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_autorizacoes_idempotency
    ON cozinha_autorizacoes_qty(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  // —— Reduções ——
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_reducoes_teto (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      qty_anterior_millis INTEGER NOT NULL,
      qty_nova_millis INTEGER NOT NULL,
      qty_referencia_inicial_millis INTEGER,
      motivo TEXT NOT NULL,
      responsavel_operador_id INTEGER NOT NULL,
      reduzida_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      idempotency_key TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      CHECK (qty_anterior_millis >= 0),
      CHECK (qty_nova_millis >= 0),
      CHECK (qty_nova_millis < qty_anterior_millis)
    )
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_reducoes_item
    ON cozinha_reducoes_teto(empresa_id, pedido_item_id, reduzida_em)
  `);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_reducoes_idempotency
    ON cozinha_reducoes_teto(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  // —— Idempotência central (sem empresa_id — contexto JSON; UNIQUE global da key) ——
  await dbRun(db, SQL_CREATE_COZINHA_IDEMPOTENCIA_V7);
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_idempotencia_key
    ON cozinha_idempotencia(idempotency_key)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_tipo_recurso
    ON cozinha_idempotencia(tipo_operacao, recurso_id)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_situacao_criado
    ON cozinha_idempotencia(situacao, created_at)
  `);

  await garantirIndiceEstacoesCodigoPorUnidade(db);
}

/**
 * Sprint 06 Bloco A — corrige UNIQUE de codigo_estacao.
 * Antes: UNIQUE(empresa_id, codigo_estacao) impedia a mesma chave (ex.: PASTEL)
 * em duas unidades da mesma empresa (conflito com D3).
 * Agora: UNIQUE(empresa_id, unidade_id, codigo_estacao).
 * A alteração não exige bump adicional ao schema vigente.
 */
async function garantirIndiceEstacoesCodigoPorUnidade(db) {
  await dbRun(db, 'DROP INDEX IF EXISTS ux_cozinha_estacoes_empresa_codigo');
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_estacoes_empresa_unidade_codigo
    ON cozinha_estacoes_impressao(empresa_id, unidade_id, codigo_estacao)
  `);
}

function garantirSchemaCozinha(db, opts = {}) {
  const tarefa = filaGarantiaSchemaCozinha.then(
    () => garantirSchemaCozinhaSemConcorrencia(db, opts)
  );
  filaGarantiaSchemaCozinha = tarefa.then(() => undefined, () => undefined);
  return tarefa;
}

async function garantirSchemaCozinhaSemConcorrencia(db, opts = {}) {
  if (!db) {
    marcarCozinhaOperacional(false, new Error('Conexão de banco ausente para schema Cozinha.'));
    return { skipped: true, operacional: false };
  }

  try {
    await dbRun(db, 'PRAGMA foreign_keys = ON');
    const versaoAtual = await lerVersaoSchema(db);

    if (versaoAtual > COZINHA_SCHEMA_VERSION) {
      const err = new Error(
        `[COZINHA] Schema incompatível: versão persistida ${versaoAtual} ` +
        `é maior que a suportada ${COZINHA_SCHEMA_VERSION}.`
      );
      err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
      throw err;
    }

    let recriado = false;
    let migradoV2V3 = false;
    let migradoV3V4 = false;
    let migradoV4V5 = false;
    let migradoV5V6 = false;
    let detalheMigracaoV6V7 = null;
    let detalheMigracaoV2V3 = null;
    let detalheMigracaoV3V4 = null;
    let detalheMigracaoV4V5 = null;
    let detalheMigracaoV5V6 = null;

    if (versaoAtual === 2) {
      detalheMigracaoV2V3 = await migrarCozinhaV2paraV3(db, opts);
      migradoV2V3 = !!detalheMigracaoV2V3.migrado;
      await criarTabelasCozinha(db);
      detalheMigracaoV3V4 = await migrarCozinhaV3paraV4(db, opts);
      migradoV3V4 = !!detalheMigracaoV3V4.migrado;
      await criarTabelasCozinha(db);
      detalheMigracaoV4V5 = await migrarCozinhaV4paraV5(db, opts);
      migradoV4V5 = !!detalheMigracaoV4V5.migrado;
      await criarTabelasCozinha(db);
    } else if (versaoAtual === 3) {
      detalheMigracaoV3V4 = await migrarCozinhaV3paraV4(db, opts);
      migradoV3V4 = !!detalheMigracaoV3V4.migrado;
      await criarTabelasCozinha(db);
      detalheMigracaoV4V5 = await migrarCozinhaV4paraV5(db, opts);
      migradoV4V5 = !!detalheMigracaoV4V5.migrado;
      await criarTabelasCozinha(db);
    } else if (versaoAtual === 4) {
      detalheMigracaoV4V5 = await migrarCozinhaV4paraV5(db, opts);
      migradoV4V5 = !!detalheMigracaoV4V5.migrado;
      await criarTabelasCozinha(db);
    } else if (versaoAtual < 2) {
      const upgrade = await recriarSchemaVazioSeNecessario(db, versaoAtual);
      recriado = !!upgrade.recriado;
      await criarTabelasCozinha(db);
      await gravarVersaoSchema(db, COZINHA_SCHEMA_VERSION);
    } else {
      // v5 ou versão atual
      await criarTabelasCozinha(db);
      const sqlIdem = await obterSqlTabela(db, 'cozinha_idempotencia');
      if (sqlIdem && !checkIdempotenciaAceitaCancelamento(sqlIdem)) {
        const err = new Error(
          '[COZINHA] Meta=v5 mas CHECK de cozinha_idempotencia não aceita cancelamento. ' +
          'Estrutura inconsistente — não corrige silenciosamente.'
        );
        err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
        throw err;
      }
    }

    if (versaoAtual >= 2 && versaoAtual < 6) {
      detalheMigracaoV5V6 = await migrarCozinhaV5paraV6(db, opts);
      migradoV5V6 = !!detalheMigracaoV5V6.migrado;
    } else if (versaoAtual === 6
      && !checkIdempotenciaAceitaRetorno(await obterSqlTabela(db, 'cozinha_idempotencia'))) {
      const err = new Error('[COZINHA] Meta=v6 mas CHECK de idempotência não aceita retorno.');
      err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
      throw err;
    }

    const aceitaCancelamentoItem = (sql) => checkIdempotenciaAceitaRetorno(sql)
      && String(sql || '').toUpperCase().includes('CANCELAMENTO_ITEM');
    if (versaoAtual >= 2 && versaoAtual < 7) {
      detalheMigracaoV6V7 = await migrarIdempotencia(db, opts, 6, 7,
        SQL_CREATE_COZINHA_IDEMPOTENCIA_V7, checkIdempotenciaAceitaRetorno, aceitaCancelamentoItem);
    } else if (versaoAtual === 7
      && !aceitaCancelamentoItem(await obterSqlTabela(db, 'cozinha_idempotencia'))) {
      const err = new Error('[COZINHA] Meta=v7 mas CHECK de idempotência não aceita cancelamento de item.');
      err.codigo = 'COZINHA_SCHEMA_INCOMPATIVEL';
      throw err;
    }

    try {
      await garantirConfigNotificacaoCozinha(db);
    } catch (err) {
      if (!/no such table:\s*configuracoes/i.test(String(err && err.message))) {
        throw err;
      }
    }

    const versaoFinal = await lerVersaoSchema(db);
    if (versaoFinal !== COZINHA_SCHEMA_VERSION) {
      const err = new Error(
        `[COZINHA] Versão final inesperada após garantir schema: ${versaoFinal}.`
      );
      err.codigo = 'COZINHA_SCHEMA_FALHA';
      throw err;
    }

    marcarCozinhaOperacional(true);
    return {
      skipped: false,
      operacional: true,
      versao: COZINHA_SCHEMA_VERSION,
      recriado,
      migrado_v2_v3: migradoV2V3,
      migrado_v3_v4: migradoV3V4,
      migrado_v4_v5: migradoV4V5,
      migrado_v5_v6: migradoV5V6,
      migrado_v6_v7: !!detalheMigracaoV6V7,
      migracao_v2_v3: detalheMigracaoV2V3,
      migracao_v3_v4: detalheMigracaoV3V4,
      migracao_v4_v5: detalheMigracaoV4V5,
      migracao_v5_v6: detalheMigracaoV5V6,
      migracao_v6_v7: detalheMigracaoV6V7
    };
  } catch (err) {
    marcarCozinhaOperacional(false, err);
    if (!err.codigo) err.codigo = 'COZINHA_SCHEMA_FALHA';
    throw err;
  }
}

module.exports = {
  COZINHA_SCHEMA_VERSION,
  TABELAS_COZINHA,
  TABELAS_COZINHA_FK_CHECK,
  IDEMPOTENCIA_COLUNAS,
  garantirSchemaCozinha,
  garantirConfigNotificacaoCozinha,
  garantirIndiceEstacoesCodigoPorUnidade,
  migrarCozinhaV3paraV4,
  migrarCozinhaV4paraV5,
  checkIdempotenciaAceitaRetirada,
  checkIdempotenciaAceitaCancelamento,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus,
  lerVersaoSchema,
  migrarCozinhaV2paraV3,
  checkIdempotenciaAceitaPreparacao,
  obterSqlTabela,
  verificarForeignKeysDominioCozinha,
  pragmaForeignKeyCheckOk
};
