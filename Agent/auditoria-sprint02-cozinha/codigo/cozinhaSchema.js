/**
 * Schema aditivo da Cozinha V1.2.3 — fundação + correção P0 isolamento por empresa.
 * Versão 2: FKs compostas (id, empresa_id) entre entidades da Cozinha.
 * Migração idempotente. Sem endpoints operacionais.
 */
'use strict';

const COZINHA_SCHEMA_VERSION = 2;

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

let statusCozinha = {
  operacional: false,
  versao: null,
  erro: null,
  atualizadoEm: null
};

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

async function contarLinhas(db, tabela) {
  const existe = await dbGet(db, `
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `, [tabela]);
  if (!existe) return 0;
  const row = await dbGet(db, `SELECT COUNT(*) AS n FROM ${tabela}`);
  return Number(row && row.n) || 0;
}

async function recriarSchemaSeNecessario(db, versaoAtual) {
  if (versaoAtual >= COZINHA_SCHEMA_VERSION) return { recriado: false };

  let total = 0;
  for (const t of TABELAS_COZINHA) {
    total += await contarLinhas(db, t);
  }
  if (total > 0) {
    const err = new Error(
      `[COZINHA] FALHA_SCHEMA: upgrade para v${COZINHA_SCHEMA_VERSION} exige recriação, ` +
      `mas existem ${total} linha(s) em tabelas cozinha_*. Interrompido sem apagar dados.`
    );
    err.codigo = 'COZINHA_SCHEMA_UPGRADE_BLOQUEADO';
    throw err;
  }

  console.warn(
    `[COZINHA] Recriando schema v${versaoAtual || 0} → v${COZINHA_SCHEMA_VERSION} ` +
    '(tabelas vazias; FKs compostas empresa_id)'
  );

  await dbRun(db, 'PRAGMA foreign_keys = OFF');
  try {
    for (const t of TABELAS_COZINHA) {
      await dbRun(db, `DROP TABLE IF EXISTS ${t}`);
    }
  } finally {
    await dbRun(db, 'PRAGMA foreign_keys = ON');
  }
  return { recriado: true };
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
  await dbRun(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_estacoes_empresa_codigo
    ON cozinha_estacoes_impressao(empresa_id, codigo_estacao)
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
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_idempotencia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      tipo_operacao TEXT NOT NULL
        CHECK (tipo_operacao IN ('AUTORIZAR_QTY', 'REDUZIR_TETO', 'DESPACHO_LOTE')),
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
  `);
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
}

async function garantirSchemaCozinha(db) {
  if (!db) {
    marcarCozinhaOperacional(false, new Error('Conexão de banco ausente para schema Cozinha.'));
    return { skipped: true, operacional: false };
  }

  try {
    await dbRun(db, 'PRAGMA foreign_keys = ON');
    const versaoAtual = await lerVersaoSchema(db);
    const upgrade = await recriarSchemaSeNecessario(db, versaoAtual);
    await criarTabelasCozinha(db);

    try {
      await garantirConfigNotificacaoCozinha(db);
    } catch (err) {
      if (!/no such table:\s*configuracoes/i.test(String(err && err.message))) {
        throw err;
      }
    }

    await gravarVersaoSchema(db, COZINHA_SCHEMA_VERSION);
    marcarCozinhaOperacional(true);
    return {
      skipped: false,
      operacional: true,
      versao: COZINHA_SCHEMA_VERSION,
      recriado: !!upgrade.recriado
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
  garantirSchemaCozinha,
  garantirConfigNotificacaoCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus
};
