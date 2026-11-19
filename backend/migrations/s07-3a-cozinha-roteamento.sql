-- S07-3A — Configuração de roteamento de cozinhas (por empresa)
-- Compatível com SQLite e FKs compostas de cozinha_unidades(id, empresa_id).
-- NÃO executar automaticamente no banco oficial.
-- Aplicar somente com autorização PO/TL (migration controlada).
-- As APIs GET/PUT de roteamento NÃO executam este DDL; exigem schema já presente.
-- Em testes: garantirSchemaCozinhaRoteamento (CREATE IF NOT EXISTS) em DB temporário.

CREATE TABLE IF NOT EXISTS cozinha_roteamento_config (
  empresa_id INTEGER PRIMARY KEY,
  modo TEXT NOT NULL
    CHECK (modo IN ('COZINHA_PADRAO', 'COZINHA_POR_SEGMENTO')),
  unidade_padrao_id INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER,
  FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  FOREIGN KEY (unidade_padrao_id, empresa_id)
    REFERENCES cozinha_unidades(id, empresa_id)
);

CREATE TABLE IF NOT EXISTS cozinha_roteamento_segmentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  segmento TEXT NOT NULL,
  unidade_id INTEGER NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (empresa_id, segmento),
  FOREIGN KEY (empresa_id) REFERENCES empresas(id),
  FOREIGN KEY (unidade_id, empresa_id)
    REFERENCES cozinha_unidades(id, empresa_id)
);

CREATE INDEX IF NOT EXISTS idx_cozinha_roteamento_seg_empresa
ON cozinha_roteamento_segmentos(empresa_id);
