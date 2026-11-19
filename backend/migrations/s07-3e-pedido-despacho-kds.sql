-- S07-3E — Controle de despacho do pedido comercial ao KDS
-- Dependência: pedidos (S07-3D destino), cozinha_rodadas / cozinha_itens (schema v3).
-- NÃO executar automaticamente no banco oficial.
-- Idempotência: UNIQUE(empresa_id, pedido_id) — no máximo um registro de despacho por pedido.

CREATE TABLE IF NOT EXISTS cozinha_pedido_despachos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  pedido_id INTEGER NOT NULL,
  unidade_id INTEGER,
  rodada_id INTEGER,
  status TEXT NOT NULL
    CHECK (status IN ('EM_ANDAMENTO', 'CONCLUIDO', 'FALHA', 'BLOQUEADO')),
  idempotency_key TEXT NOT NULL,
  claim_token TEXT,
  codigo_falha TEXT,
  mensagem_falha TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (empresa_id, pedido_id),
  UNIQUE (idempotency_key),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id)
);

-- Bancos que já receberam a tabela sem claim_token:
-- ALTER TABLE cozinha_pedido_despachos ADD COLUMN claim_token TEXT;

CREATE INDEX IF NOT EXISTS idx_cozinha_pedido_despachos_status
  ON cozinha_pedido_despachos(empresa_id, status);

-- Snapshot opcional no pedido (leitura rápida; a fonte de verdade da unicidade é a tabela acima).
ALTER TABLE pedidos ADD COLUMN cozinha_despacho_status TEXT;
ALTER TABLE pedidos ADD COLUMN cozinha_despacho_rodada_id INTEGER;
ALTER TABLE pedidos ADD COLUMN cozinha_despacho_codigo TEXT;
