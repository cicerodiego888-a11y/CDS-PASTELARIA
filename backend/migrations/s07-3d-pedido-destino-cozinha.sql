-- S07-3D — Snapshot de resolução de destino de cozinha no pedido
-- Dependência: pedidos (existente), cozinha_canais / cozinha_canal_destinos (S07-3C).
-- Origem do canal de entrada continua em pedidos.origem_canal (já existente).
-- Adaptador EQUIPE (EntradaPedido) resolve para o canal de cozinha LOJA via serviço.
-- NÃO executar automaticamente no banco oficial.
-- SQLite: ADD COLUMN é idempotente apenas se a coluna ainda não existir — aplicar com checagem.

-- Canal de cozinha efetivamente usado na resolução (ex.: LOJA, IFOOD).
ALTER TABLE pedidos ADD COLUMN cozinha_canal_codigo TEXT;

-- Unidade de destino congelada no momento da resolução (não segue alteração futura do roteamento).
ALTER TABLE pedidos ADD COLUMN unidade_cozinha_destino_id INTEGER;

-- Status estruturado da resolução (RESOLVIDO, DESTINO_NAO_CONFIGURADO, CANAL_INEXISTENTE, ...).
ALTER TABLE pedidos ADD COLUMN cozinha_resolucao_status TEXT;

CREATE INDEX IF NOT EXISTS idx_pedidos_cozinha_destino
  ON pedidos(empresa_id, unidade_cozinha_destino_id);

CREATE INDEX IF NOT EXISTS idx_pedidos_cozinha_resolucao
  ON pedidos(empresa_id, cozinha_resolucao_status);
