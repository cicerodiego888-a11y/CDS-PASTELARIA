/**
 * Schema MBC — instituições, contas, transações, conciliação, config e consentimento.
 * Secrets não ficam nas tabelas funcionais. Sem tokens na tabela de consentimento.

 * @module motores/bancario/schema/bancarioSchema
 */
'use strict';

const DDL_INSTITUICAO = `
  CREATE TABLE IF NOT EXISTS instituicao_financeira (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    nome TEXT NOT NULL,
    nome_reduzido TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const DDL_CONTA = `
  CREATE TABLE IF NOT EXISTS conta_bancaria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    instituicao_financeira_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    tipo TEXT NOT NULL,
    agencia TEXT,
    numero TEXT NOT NULL,
    digito TEXT,
    titular TEXT,
    documento_titular TEXT,
    ativa INTEGER NOT NULL DEFAULT 1,
    principal INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (instituicao_financeira_id) REFERENCES instituicao_financeira(id)
  )
`;

const DDL_TRANSACAO = `
  CREATE TABLE IF NOT EXISTS transacao_bancaria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    conta_bancaria_id INTEGER NOT NULL,
    external_source TEXT,
    external_id TEXT,
    data_transacao TEXT NOT NULL,
    data_processamento TEXT,
    valor REAL NOT NULL,
    direcao TEXT NOT NULL,
    descricao TEXT,
    tipo TEXT,
    saldo_apos_transacao REAL,
    referencia_externa TEXT,
    observacao TEXT,
    raw_reference TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (conta_bancaria_id) REFERENCES conta_bancaria(id)
  )
`;

const DDL_CONCILIACAO = `
  CREATE TABLE IF NOT EXISTS conciliacao_bancaria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    transacao_bancaria_id INTEGER NOT NULL,
    origem_financeira TEXT,
    registro_financeiro_id INTEGER,
    status TEXT NOT NULL,
    valor_conciliado REAL,
    observacao TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    conciliado_em TEXT,
    desconciliado_em TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (transacao_bancaria_id) REFERENCES transacao_bancaria(id)
  )
`;

const DDL_CONFIG = `
  CREATE TABLE IF NOT EXISTS config_integracao_bancaria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    conta_bancaria_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    ambiente TEXT NOT NULL,
    aplicacao_ref TEXT,
    config_ref TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (conta_bancaria_id) REFERENCES conta_bancaria(id)
  )
`;

const DDL_CONSENTIMENTO = `
  CREATE TABLE IF NOT EXISTS consentimento_open_finance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    conta_bancaria_id INTEGER NOT NULL,
    instituicao_financeira_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    consentimento_externo_id TEXT,
    estado_integracao TEXT,
    escopos TEXT NOT NULL,
    iniciado_em TEXT,
    autorizado_em TEXT,
    expira_em TEXT,
    revogado_em TEXT,
    ultimo_erro TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (conta_bancaria_id) REFERENCES conta_bancaria(id),
    FOREIGN KEY (instituicao_financeira_id) REFERENCES instituicao_financeira(id)
  )
`;

const DDL_CONSENTIMENTO_STATE = `
  CREATE TABLE IF NOT EXISTS consentimento_of_state (
    state TEXT PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    conta_bancaria_id INTEGER NOT NULL,
    config_id INTEGER,
    consentimento_id INTEGER NOT NULL,
    usuario_id INTEGER,
    expira_em TEXT NOT NULL,
    consumido INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const DDL_SINCRONIZACAO = `
  CREATE TABLE IF NOT EXISTS sincronizacao_bancaria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    conta_bancaria_id INTEGER NOT NULL,
    consentimento_open_finance_id INTEGER,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    cursor_atual TEXT,
    saldo_bancario REAL,
    saldo_data TEXT,
    ultima_sincronizacao_em TEXT,
    ultimo_sucesso_em TEXT,
    ultimo_erro TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (conta_bancaria_id) REFERENCES conta_bancaria(id),
    FOREIGN KEY (consentimento_open_finance_id) REFERENCES consentimento_open_finance(id)
  )
`;

const DDL_SUGESTAO = `
  CREATE TABLE IF NOT EXISTS sugestao_conciliacao_bancaria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    transacao_bancaria_id INTEGER NOT NULL,
    tipo_registro TEXT NOT NULL,
    registro_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    nivel_confianca TEXT NOT NULL,
    motivos TEXT,
    status TEXT NOT NULL,
    valor_candidato REAL,
    data_candidato TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (transacao_bancaria_id) REFERENCES transacao_bancaria(id)
  )
`;

const DDL_SECRET_STORE = `
  CREATE TABLE IF NOT EXISTS mbc_secret_store (
    chave TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const INDICES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_instituicao_financeira_codigo
     ON instituicao_financeira(codigo) WHERE codigo IS NOT NULL AND TRIM(codigo) != ''`,
  `CREATE INDEX IF NOT EXISTS idx_conta_bancaria_empresa
     ON conta_bancaria(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conta_bancaria_instituicao
     ON conta_bancaria(instituicao_financeira_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conta_bancaria_empresa_ativa
     ON conta_bancaria(empresa_id, ativa)`,
  `CREATE INDEX IF NOT EXISTS idx_conta_bancaria_empresa_principal
     ON conta_bancaria(empresa_id, principal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_bancaria_uma_principal
     ON conta_bancaria(empresa_id) WHERE principal = 1`,
  `CREATE INDEX IF NOT EXISTS idx_transacao_bancaria_empresa
     ON transacao_bancaria(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transacao_bancaria_conta
     ON transacao_bancaria(conta_bancaria_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transacao_bancaria_empresa_conta_data
     ON transacao_bancaria(empresa_id, conta_bancaria_id, data_transacao)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_transacao_bancaria_idempotencia
     ON transacao_bancaria(empresa_id, conta_bancaria_id, external_source, external_id)
     WHERE external_id IS NOT NULL AND TRIM(external_id) != ''`,
  `CREATE INDEX IF NOT EXISTS idx_conciliacao_bancaria_empresa
     ON conciliacao_bancaria(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conciliacao_bancaria_transacao
     ON conciliacao_bancaria(transacao_bancaria_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conciliacao_bancaria_status
     ON conciliacao_bancaria(empresa_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_conciliacao_bancaria_ativa_por_transacao
     ON conciliacao_bancaria(transacao_bancaria_id) WHERE ativo = 1`,
  `CREATE INDEX IF NOT EXISTS idx_config_integracao_empresa
     ON config_integracao_bancaria(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_config_integracao_conta
     ON config_integracao_bancaria(conta_bancaria_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_config_integracao_uma_ativa
     ON config_integracao_bancaria(conta_bancaria_id) WHERE ativo = 1`,
  `CREATE INDEX IF NOT EXISTS idx_consentimento_of_empresa
     ON consentimento_open_finance(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_consentimento_of_conta
     ON consentimento_open_finance(conta_bancaria_id)`,
  `CREATE INDEX IF NOT EXISTS idx_consentimento_of_status
     ON consentimento_open_finance(empresa_id, status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_consentimento_of_operacional
     ON consentimento_open_finance(conta_bancaria_id, provider)
     WHERE status IN ('INICIADO','AGUARDANDO_AUTORIZACAO','AUTORIZADO')`,
  `CREATE INDEX IF NOT EXISTS idx_consentimento_of_state_consent
     ON consentimento_of_state(consentimento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sincronizacao_bancaria_empresa
     ON sincronizacao_bancaria(empresa_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sincronizacao_bancaria_conta_provider
     ON sincronizacao_bancaria(empresa_id, conta_bancaria_id, provider)`,
  `CREATE INDEX IF NOT EXISTS idx_sugestao_conciliacao_empresa
     ON sugestao_conciliacao_bancaria(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sugestao_conciliacao_transacao
     ON sugestao_conciliacao_bancaria(transacao_bancaria_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sugestao_conciliacao_operacional
     ON sugestao_conciliacao_bancaria(empresa_id, transacao_bancaria_id, tipo_registro, registro_id)
     WHERE status = 'PENDENTE'`
];

function runSeq(db, statements, cb) {
  let i = 0;
  function next(err) {
    if (err) return cb(err);
    if (i >= statements.length) return cb(null);
    const sql = statements[i];
    i += 1;
    db.run(sql, next);
  }
  next();
}

function garantirColunasConfig(db, cb) {
  db.all('PRAGMA table_info(config_integracao_bancaria)', (err, cols) => {
    if (err) return cb(err);
    const names = (cols || []).map((c) => c.name);
    const adds = [];
    if (!names.includes('aplicacao_ref')) {
      adds.push('ALTER TABLE config_integracao_bancaria ADD COLUMN aplicacao_ref TEXT');
    }
    if (!names.includes('config_ref')) {
      adds.push('ALTER TABLE config_integracao_bancaria ADD COLUMN config_ref TEXT');
    }
    if (!adds.length) return cb(null);
    runSeq(db, adds, cb);
  });
}

function garantirSchemaBancario(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema bancário'));
  runSeq(db, [
    DDL_INSTITUICAO,
    DDL_CONTA,
    DDL_TRANSACAO,
    DDL_CONCILIACAO,
    DDL_CONFIG,
    DDL_CONSENTIMENTO,
    DDL_CONSENTIMENTO_STATE,
    DDL_SINCRONIZACAO,
    DDL_SUGESTAO,
    DDL_SECRET_STORE,
    ...INDICES
  ], (err) => {
    if (err) {
      console.error('Erro ao garantir schema MBC:', err.message);
      return done(err);
    }
    garantirColunasConfig(db, (err2) => {
      if (err2) {
        console.error('Erro ao garantir schema MBC:', err2.message);
        return done(err2);
      }
      done(null);
    });
  });
}

function garantirSchemaBancarioAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaBancario(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  garantirSchemaBancario,
  garantirSchemaBancarioAsync
};
