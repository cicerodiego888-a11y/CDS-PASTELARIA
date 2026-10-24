-- CE-ENCERRAMENTO-01 — Preparado para revisão (NÃO executar automaticamente em produção nesta sprint).
-- Adiciona empresa_id e correlation_id opcionais em central_entradas_eventos.
-- Até a migração ser aplicada, o runtime grava empresaId/correlationId em detalhe_json.

ALTER TABLE central_entradas_eventos ADD COLUMN empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE central_entradas_eventos ADD COLUMN correlation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_central_entradas_eventos_empresa
  ON central_entradas_eventos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_central_entradas_eventos_correlation
  ON central_entradas_eventos(correlation_id);
