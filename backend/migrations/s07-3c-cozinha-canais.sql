-- S07-3C — Canais dinâmicos de pedidos → destinos de cozinha (por empresa)
-- Dependência: cozinha_unidades (S07-2). Independente da aplicação da S07-3A.
-- Ordem sugerida de aplicação controlada: S07-2 (já em schema v3) → S07-3A (roteamento) → S07-3C (canais).
-- S07-3A e S07-3C podem coexistir: segmentos antigos NÃO são removidos nem convertidos aqui.
-- NÃO executar automaticamente no banco oficial. Sem DDL em runtime nas APIs.

CREATE TABLE IF NOT EXISTS cozinha_canais (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  origem_tipo TEXT NOT NULL
    CHECK (origem_tipo IN ('SISTEMA', 'MANUAL', 'INTEGRACAO')),
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER,
  updated_by INTEGER,
  UNIQUE (empresa_id, codigo),
  UNIQUE (id, empresa_id),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id)
);

CREATE INDEX IF NOT EXISTS idx_cozinha_canais_empresa
  ON cozinha_canais(empresa_id);

CREATE TABLE IF NOT EXISTS cozinha_canal_destinos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  canal_id INTEGER NOT NULL,
  unidade_cozinha_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER,
  UNIQUE (empresa_id, canal_id),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  FOREIGN KEY (canal_id, empresa_id)
    REFERENCES cozinha_canais(id, empresa_id),
  FOREIGN KEY (unidade_cozinha_id, empresa_id)
    REFERENCES cozinha_unidades(id, empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_cozinha_canal_destinos_empresa
  ON cozinha_canal_destinos(empresa_id);
