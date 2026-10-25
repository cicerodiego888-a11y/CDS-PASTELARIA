/**
 * Schema MCF — Contas a Pagar canônica + pagamentos.
 * Não altera MBC.
 * @module motores/mcf/schema/mcfSchema
 */
'use strict';

const DDL_CONTAS_PAGAR = `
  CREATE TABLE IF NOT EXISTS contas_pagar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    fornecedor_id INTEGER,
    descricao TEXT,
    valor_original DECIMAL(10,2) NOT NULL,
    valor_restante DECIMAL(10,2) NOT NULL,
    data_emissao DATE,
    data_vencimento DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'aberto',
    forma_pagamento TEXT,
    documento TEXT,
    origem TEXT DEFAULT 'manual',
    categoria TEXT,
    pessoa_nome TEXT,
    idempotency_key TEXT,
    referencia_tipo VARCHAR(50),
    referencia_id INTEGER,
    numero_parcela INTEGER,
    total_parcelas INTEGER,
    observacao TEXT,
    criado_por INTEGER,
    saldo_cancelado DECIMAL(10,2) NOT NULL DEFAULT 0,
    cancelamento_motivo TEXT,
    cancelado_em DATETIME,
    cancelado_por INTEGER,
    cancelamento_idempotency_key TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (fornecedor_id) REFERENCES fornecedores(id),
    CHECK (valor_original > 0),
    CHECK (valor_restante >= 0),
    CHECK (valor_restante <= valor_original)
  )
`;

const DDL_CONTAS_PAGAR_PAGAMENTOS = `
  CREATE TABLE IF NOT EXISTS contas_pagar_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_pagar_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    fornecedor_id INTEGER,
    valor_pago DECIMAL(10,2) NOT NULL,
    data_pagamento DATE NOT NULL,
    forma_pagamento VARCHAR(50),
    observacao TEXT,
    idempotency_key TEXT,
    usuario_id INTEGER,
    origem_operacao TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conta_pagar_id) REFERENCES contas_pagar(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    CHECK (valor_pago > 0)
  )
`;

const DDL_CONTAS_PAGAR_FINANCEIRO_COMPAT = `
  CREATE TABLE IF NOT EXISTS contas_pagar_financeiro_compat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    conta_pagar_id INTEGER NOT NULL,
    financeiro_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (empresa_id, conta_pagar_id),
    UNIQUE (empresa_id, financeiro_id)
  )
`;

const INDICES = [
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa
     ON contas_pagar(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa_status
     ON contas_pagar(empresa_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento
     ON contas_pagar(empresa_id, data_vencimento)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_fornecedor
     ON contas_pagar(fornecedor_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_pagar_origem_parcela
     ON contas_pagar(empresa_id, referencia_tipo, referencia_id, numero_parcela)
     WHERE referencia_tipo = 'compra'
       AND referencia_id IS NOT NULL
       AND numero_parcela IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_pagar_idempotency
     ON contas_pagar(empresa_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_pagar_cancelamento_idempotency
     ON contas_pagar(empresa_id, cancelamento_idempotency_key)
     WHERE cancelamento_idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_pagamentos_titulo
     ON contas_pagar_pagamentos(conta_pagar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_pagamentos_empresa
     ON contas_pagar_pagamentos(empresa_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_pagar_pagamento_idempotency
     ON contas_pagar_pagamentos(empresa_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_financeiro_compat_titulo
     ON contas_pagar_financeiro_compat(empresa_id, conta_pagar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_financeiro_compat_financeiro
     ON contas_pagar_financeiro_compat(empresa_id, financeiro_id)`
];

function runSeq(db, statements, cb) {
  let i = 0;
  function next(err) {
    if (err) return cb(err);
    if (i >= statements.length) return cb(null);
    const sql = statements[i++];
    db.run(sql, next);
  }
  next();
}

function garantirSchemaMcf(db, callback) {
  const cb = typeof callback === 'function' ? callback : () => {};
  if (!db) return cb(new Error('db obrigatório'));
  const criarTabelas = [
    DDL_CONTAS_PAGAR,
    DDL_CONTAS_PAGAR_PAGAMENTOS,
    DDL_CONTAS_PAGAR_FINANCEIRO_COMPAT
  ];
  runSeq(db, criarTabelas, (err) => {
    if (err) {
      console.error('Erro ao garantir schema MCF:', err.message);
      return cb(err);
    }

    const garantirColunas = (tabela, definicoes, proximo) => {
      db.all(`PRAGMA table_info(${tabela})`, (pragmaErr, colunas) => {
        if (pragmaErr) return proximo(pragmaErr);
        const existentes = new Set((colunas || []).map((coluna) => coluna.name));
        const alteracoes = definicoes
          .filter((coluna) => !existentes.has(coluna.nome))
          .map((coluna) => `ALTER TABLE ${tabela} ADD COLUMN ${coluna.ddl}`);
        runSeq(db, alteracoes, proximo);
      });
    };

    garantirColunas('contas_pagar', [
      { nome: 'numero_parcela', ddl: 'numero_parcela INTEGER' },
      { nome: 'total_parcelas', ddl: 'total_parcelas INTEGER' },
      { nome: 'categoria', ddl: 'categoria TEXT' },
      { nome: 'pessoa_nome', ddl: 'pessoa_nome TEXT' },
      { nome: 'forma_pagamento', ddl: 'forma_pagamento TEXT' },
      { nome: 'idempotency_key', ddl: 'idempotency_key TEXT' },
      { nome: 'criado_por', ddl: 'criado_por INTEGER' },
      { nome: 'saldo_cancelado', ddl: 'saldo_cancelado DECIMAL(10,2) NOT NULL DEFAULT 0' },
      { nome: 'cancelamento_motivo', ddl: 'cancelamento_motivo TEXT' },
      { nome: 'cancelado_em', ddl: 'cancelado_em DATETIME' },
      { nome: 'cancelado_por', ddl: 'cancelado_por INTEGER' },
      { nome: 'cancelamento_idempotency_key', ddl: 'cancelamento_idempotency_key TEXT' }
    ], (colunasErr) => {
      if (colunasErr) {
        console.error('Erro ao atualizar colunas do schema MCF:', colunasErr.message);
        return cb(colunasErr);
      }

      garantirColunas('contas_pagar_pagamentos', [
        { nome: 'idempotency_key', ddl: 'idempotency_key TEXT' },
        { nome: 'usuario_id', ddl: 'usuario_id INTEGER' },
        { nome: 'origem_operacao', ddl: 'origem_operacao TEXT' }
      ], (pagamentoErr) => {
        if (pagamentoErr) {
          console.error('Erro ao atualizar colunas dos pagamentos MCF:', pagamentoErr.message);
          return cb(pagamentoErr);
        }

        runSeq(db, INDICES, (indicesErr) => {
          if (indicesErr) {
            console.error('Erro ao garantir índices do schema MCF:', indicesErr.message);
            return cb(indicesErr);
          }
          console.log('Schema MCF (contas_pagar) criado/verificado');
          cb(null);
        });
      });
    });
  });
}

function garantirSchemaMcfAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaMcf(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  garantirSchemaMcf,
  garantirSchemaMcfAsync,
  DDL_CONTAS_PAGAR,
  DDL_CONTAS_PAGAR_PAGAMENTOS,
  DDL_CONTAS_PAGAR_FINANCEIRO_COMPAT
};
