# SPRINT 05.75 — GET /saude da Central (isolado)

O relatório original desta numeração (isolamento empresarial do painel de saúde da Central) foi preservado aqui porque a sprint seguinte reutilizou o número 05.75 para o PDV Universal.

Ver também: `docs/arquitetura/ISOLAMENTO_SAUDE_CENTRAL_EMPRESA_05_75.md`

STATUS: CONCLUÍDA

PRODUÇÃO ALTERADA: SIM — GET `/saude` (contexto + scan por `empresa_id`); HealthRepository/Analyzer/Monitor; GET `/saude/alertas` e POST `/saude/analisar` no mesmo contrato

ROTA: GET `/saude`

CHAMADORES: 1 HTTP de produção para `obterSaudeCentral`; wrappers Service/Orchestrator; UI usa alertas/analisar (isolados); scheduler e dashboard permanecem globais (fora do GET)

QUERIES AUDITADAS: 3 no caminho HTTP (`listarDocumentosParaAnalise`, `obterEstatisticasFluxo` COUNT/agregados, `obterUltimaEntrada` LIMIT 1). Scheduler ainda tem 2 SQLs globais (listar + COUNT).

MÉTRICAS: analisados, contadores, alertas (chave/fornecedor/status), documentos do scan, tempos médios, recuperados, totalDocumentos, ultimaEntrada, documentosEmAlerta; taxaSucessoMirx omitida no painel empresarial

COUNT: isolado (`WHERE empresa_id = ?`)

LIMIT 1: isolado (`WHERE empresa_id = ?` antes do LIMIT)

FORNECEDOR: isolado

CNPJ: isolado

NULL: fora da saúde empresarial; sem backfill; sem COALESCE de ownership

CROSS-COMPANY: A só A; B só B; mesma chave não cruza

EMPRESA AUSENTE: `EMPRESA_CENTRAL_AUSENTE` sem SELECT global

TESTES: 12/12 (`tests/central-entradas/isolamento-saude-empresa-05-75.test.js`)

REGRESSÕES: ALL_OK 05.75 12/12 · 05.74 12/12 · 05.73 10/10 · 05.72 10/10 · 05.71 T01–T10 · 05.70 T01–T12 · 05.69 T01–T08 · 05.68–05.54 (05.55 16/16 · 05.54 12/12). Extra `rc346-health-monitor` falhou em `SEM_PARSER` (HealthRules; fora desta sprint; teardown de schema do 05.54 não relacionado).

RISCOS RESTANTES:
- FiscalProvider.ultimaEntradaFiscal LIMIT 1 global (05.73)
- XML DistDFe/disco por chave
- HealthScheduler e CentralDashboardService globais
- analisarDocumento (lista global; detalhe HTTP já autorizado por id)
