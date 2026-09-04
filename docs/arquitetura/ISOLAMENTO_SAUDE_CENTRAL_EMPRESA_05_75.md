# Isolamento da saúde da Central por empresa (Sprint 05.75)

**Status:** implementação  
**Data:** 2026-08-29

## 1. Rota

`GET /api/central-entradas/saude`

Cadeia: `resolverEmpresaParaCentral` → `obterSaudeCentral` → `HealthMonitor.obterPainel({ exigirEmpresa, empresaId })` → `HealthAnalyzer.analisarTodos` → `HealthRepository`.

Rotas irmãs isoladas no mesmo contrato (mesmo SQL familiar): `GET /saude/alertas`, `POST /saude/analisar`.

Não isolados nesta sprint: `GET /saude/documento/:id` (já `comDocumentoAutorizado`); scheduler; dashboard interno.

## 2. Chamadores

| Origem | Função | Tipo | Observação |
|--------|--------|------|------------|
| `rotas/central-entradas.js` | `GET /saude` | PRODUÇÃO | contexto oficial + scan empresarial |
| `CentralEntradasService.obterSaudeCentral` | wrapper | PRODUÇÃO | |
| `CentralEntradasOrchestrator.obterSaudeCentral` | wrapper | PRODUÇÃO | |
| `frontend/.../central-entradas.js` | `/saude/alertas`, `/saude/analisar` | PRODUÇÃO | UI; painel do dashboard usa `dashboard.saude` (outro reader) |
| `HealthScheduler._tick` | `executarScan` sem empresa | PRODUÇÃO | varredura global periódica (não é GET `/saude`) |
| `CentralDashboardService` | `obterPainel({ forcar: false })` | PRODUÇÃO | cache/scan global (fora do escopo) |
| `rc346-health-monitor.test.js` | mock | TESTE | |
| Mocks de HealthRepository em testes RC | MOCK | TESTE | |

## 3. Funções

- `HealthRepository.listarDocumentosParaAnalise({ limite, empresaId })`
- `HealthRepository.obterEstatisticasFluxo(empresaId)`
- `HealthRepository.obterUltimaEntrada(empresaId)` — só com empresa válida
- `HealthAnalyzer.analisarTodos`
- `HealthMonitor.obterPainel` / `executarScan`

## 4–8. SQL encontrado (antes) e novo (HTTP)

**Antes (global, GET `/saude` via cache ou scan):**

```sql
SELECT ... FROM central_entradas_documentos
WHERE (status NOT IN (...) OR status = ?)
ORDER BY updated_at DESC
LIMIT ?

SELECT COUNT(*) ... FROM central_entradas_documentos
-- sem empresa_id
```

Não havia `obterUltimaEntrada`; o cache `_ultimoScan` / `central_health_state` podia devolver chave/fornecedor/CNPJ de qualquer empresa.

**Novo (GET `/saude` / painel com `empresaId`):**

```sql
-- listar
WHERE (status NOT IN (...) OR status = ?)
  AND empresa_id = ?
ORDER BY updated_at DESC
LIMIT ?

-- COUNT / médias
FROM central_entradas_documentos
WHERE empresa_id = ?

-- LIMIT 1
SELECT ... FROM central_entradas_documentos
WHERE empresa_id = ?
ORDER BY datetime(COALESCE(updated_at, created_at, data_emissao)) DESC, id DESC
LIMIT 1
```

`COALESCE` apenas em timestamps/XML length — nunca em `documento.empresa_id`.

Sem `empresaId` (scheduler): o SQL global permanece de propósito.

## 5. Fonte `empresa_id`

`resolverEmpresaParaCentral`: EMPRESA_SIMPLES → empresa operacional do contrato; MULTIEMPRESA → `X-Empresa-Id` / `req.empresaId` obrigatório. Sem primeira/última empresa, `empresa_operacional_id` em MULTI, COMPAT ou COALESCE de ownership.

## 6. Métricas

Auditadas no caminho HTTP (todas com `empresa_id = ?` na origem documental):

| Métrica | Tabela | Filtro empresa | Risco residual |
|---------|--------|----------------|----------------|
| Scan / `analisados` / `documentos` / `alertas` / `contadores` | `central_entradas_documentos` | `AND empresa_id = ?` | nenhum no GET |
| `totalDocumentos`, tempos médios, recuperados | mesma | `WHERE empresa_id = ?` | nenhum no GET |
| `ultimaEntrada` (chave, fornecedor, CNPJ) | mesma | `WHERE empresa_id = ?` antes do LIMIT 1 | nenhum no GET |
| `taxaSucessoMirx` | telemetria MIRX | omitida no painel empresarial | scheduler ainda usa taxa global |

## 9–12. LIMIT 1, COUNT, fornecedor, CNPJ

LIMIT 1 e COUNT só após `empresa_id`. Fornecedor e CNPJ no painel HTTP vêm só das linhas filtradas.

## 13. NULL

`empresa_id IS NULL` não casa `empresa_id = ?`. Sem `COALESCE(empresa_id, operacional)` e sem `IS NULL OR empresa_id = ?`. Não é métrica global neste endpoint.

## 14–17. Cross-company, empresa ausente, modos

A (11) e B (22) com a mesma chave: saúde 11 só A; saúde 22 só B.

MULTIEMPRESA sem empresa: `EMPRESA_CENTRAL_AUSENTE` **antes** de qualquer SELECT de documentos.

EMPRESA_SIMPLES: contrato operacional; `modo_operacional_global` não alterado.

HTTP não persiste o painel empresarial em `central_health_state` (não sobrescreve o snapshot do scheduler).

## 18. Testes

`tests/central-entradas/isolamento-saude-empresa-05-75.test.js` (T01–T12).

## 19. Regressões

05.54–05.74 + 05.75.

## 20. Riscos restantes (não 05.75)

- `FiscalProvider.ultimaEntradaFiscal` (LIMIT 1 global)
- XML DistDFe/disco por chave
- `HealthScheduler` / `CentralDashboardService` scan global
- `analisarDocumento` lista até 400 documentos sem empresa (GET por id já tem ownership)
- dashboards/listagens internas da Central sem `empresa_id`
