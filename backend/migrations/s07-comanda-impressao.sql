-- Aplicar de forma controlada depois de S07-3E; nao executa no banco oficial.
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS cozinha_comanda_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL,
  unidade_id INTEGER NOT NULL,
  pedido_id INTEGER NOT NULL,
  rodada_id INTEGER NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  conteudo_json TEXT NOT NULL,
  disponibilidade TEXT NOT NULL DEFAULT 'AGUARDANDO_DESPACHO'
    CHECK (disponibilidade IN ('AGUARDANDO_DESPACHO', 'DISPONIVEL')),
  UNIQUE (id, empresa_id, unidade_id),
  FOREIGN KEY (rodada_id, empresa_id) REFERENCES cozinha_rodadas(id, empresa_id),
  FOREIGN KEY (unidade_id, empresa_id) REFERENCES cozinha_unidades(id, empresa_id)
);

CREATE TRIGGER IF NOT EXISTS cozinha_comanda_snapshot_vinculo
BEFORE INSERT ON cozinha_comanda_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM cozinha_rodadas r
  JOIN cozinha_itens i ON i.rodada_id = r.id AND i.empresa_id = r.empresa_id
    AND i.unidade_id = r.unidade_id
  WHERE r.id = NEW.rodada_id AND r.empresa_id = NEW.empresa_id
    AND r.unidade_id = NEW.unidade_id AND r.idempotency_key_despacho = NEW.idempotency_key
    AND i.pedido_id = NEW.pedido_id
)
BEGIN
  SELECT RAISE(ABORT, 'vinculo de snapshot invalido');
END;

CREATE TRIGGER IF NOT EXISTS cozinha_comanda_snapshot_imutavel
BEFORE UPDATE OF empresa_id, unidade_id, pedido_id, rodada_id, idempotency_key, conteudo_json
ON cozinha_comanda_snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshot de comanda imutavel');
END;

CREATE TRIGGER IF NOT EXISTS cozinha_comanda_snapshot_nao_excluir
BEFORE DELETE ON cozinha_comanda_snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshot de comanda imutavel');
END;

CREATE TRIGGER IF NOT EXISTS cozinha_comanda_snapshot_liberar
AFTER UPDATE OF status, rodada_id, unidade_id ON cozinha_pedido_despachos
WHEN NEW.status = 'CONCLUIDO'
BEGIN
  UPDATE cozinha_comanda_snapshots
  SET disponibilidade = 'DISPONIVEL'
  WHERE empresa_id = NEW.empresa_id AND unidade_id = NEW.unidade_id
    AND pedido_id = NEW.pedido_id AND rodada_id = NEW.rodada_id
    AND idempotency_key = NEW.idempotency_key;
END;

CREATE TABLE IF NOT EXISTS cozinha_comanda_tentativas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL,
  empresa_id INTEGER NOT NULL,
  unidade_id INTEGER NOT NULL,
  operador_id INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'EM_ANDAMENTO'
    CHECK (estado IN ('EM_ANDAMENTO', 'ACEITA_PELO_SPOOLER', 'FALHA')),
  detalhe TEXT,
  criada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  concluida_em TEXT,
  FOREIGN KEY (snapshot_id, empresa_id, unidade_id)
    REFERENCES cozinha_comanda_snapshots(id, empresa_id, unidade_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_comanda_tentativa_em_andamento
ON cozinha_comanda_tentativas(snapshot_id)
WHERE estado = 'EM_ANDAMENTO';

COMMIT;
