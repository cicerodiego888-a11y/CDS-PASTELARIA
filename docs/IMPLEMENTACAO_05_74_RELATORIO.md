# SPRINT 05.74

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — fila `listarPendentesProcessamento`, `processarDocumentosPendentes`, `processar`, chamadores (sync, buscar-chave, ciclo-dfe, diagnóstico, upload, legado, HealthMonitor)

listarPendentesProcessamento: exige empresaId; `WHERE status = ? AND empresa_id = ?` (+ parse vazio)

CHAMADORES: 9 de produção (orquestrador 4 caminhos + rota diagnóstico + health + upload + legado + HTTP processar)

AUTO-PROCESSAMENTO: por alvo de sync; buscar-chave usa empresa do lookup; health por id + empresa persistida

RETRY: mesma fila empresarial; sem fallback

PROCESSAR: exigirDocumentoDaEmpresa obrigatório; ownership não é mascarado como erro de parser

SQL GLOBAL: removido do caminho de mutação da fila

NULL: fora da fila; processar → EMPRESA_DOCUMENTO_NAO_RESOLVIDA

CROSS-COMPANY: DOCUMENTO_NAO_ENCONTRADO; ZERO MUTATION

TESTES: 12/12 (`tests/central-entradas/isolamento-fila-processamento-05-74.test.js`)

REGRESSÕES (2026-08-29): ALL_OK — 05.74 12/12 · 05.73 10/10 · 05.72–05.54 (05.55 16/16 · 05.54 12/12)

RISCOS RESTANTES:
- GET /saude e ultimaEntradaFiscal globais
- XML DistDFe/disco por chave
- dashboards/listagens internas sem empresa_id (não mutam via esta fila)
