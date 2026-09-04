# Correção do contexto multiempresa da Nova Central (05.78)

## 1. Problema observado

Após a 05.77, selecionar a empresa alterava **pendentes** (GET `/dashboard`, já isolado) mas **Valor do mês / ano e NF-e do mês / ano** continuavam globais (A+B+C).

## 2. Evidência

- `GET /dashboard` → `resolverEmpresaParaCentral` + `contarPorStatus({ empresaId })` — isolado.
- `GET /indicadores-fiscais` e `GET /inteligencia` **não** resolviam empresa.
- `IndicadoresFiscaisService.obterAgregadoEntradasPorEmissao` fazia `SUM(valor_total)` em `central_entradas_documentos` **sem** `empresa_id`.
- `obterMetricasOperacionais` repetia SELECT global (tempo médio / MIIP) e alimentava a inteligência.
- Frontend: troca A→B só recarregava se `selecionar` mudasse o id; sem invalidação nem proteção a resposta atrasada. KPI snapshot em `localStorage` podia misturar tendências.

05.73 já classificava métricas globais como residual. 05.74/05.75/05.76 **não** reabertos.

## 3. Indicadores afetados

Valor mês/ano, NF-e mês/ano, tempo médio, compras concluídas hoje (métricas operacionais), filas dentro de `/operacional` e `/inteligencia`. Fila da UI principal já vinha do dashboard.

## 4–6. Endpoints / services / queries

| Endpoint | Antes | Depois |
|----------|--------|--------|
| `/indicadores-fiscais` | sem empresa | `resolverEmpresaParaCentral` + `empresaId` |
| `/inteligencia` | sem empresa | idem |
| `/operacional` | sem empresa | idem |
| `/dashboard` | isolado | intacto |

`obterAgregadoEntradasPorEmissao`: `AND empresa_id = ?` quando há empresa. Sem `COALESCE(empresa_id, …)`. NULL não entra.

`obterMetricasOperacionais`: mesmos filtros + `db` do repositório.

## 7. empresaId

Contexto HTTP (`X-Empresa-Id` / `req.empresaId`) via `resolverEmpresaParaCentral`. Sem empresa 1 / primeira / operacional.

## 8–9. Troca e concorrência

`bumpContextoSeqCentral` + `invalidarEstadoDadosCentral` + recarga dashboard/lista. Após fetch, se `contextoSeq` mudou, o resultado é descartado.

## 10–13. A / B / NULL / Todas

A e B: agregados só da empresa. NULL ignorado. “Todas as empresas”: contrato 05.77 (não consolida; não dispara N GETs).

## 14–16. Testes e regressões

`tests/central-entradas/correcao-contexto-multiempresa-05-78.test.js`. Regressões 05.77–05.54 e 03.01–03.05.

## Riscos restantes

Alertas/pendências/atenção (`listarFornecedoresNovos` etc.) ainda globais (05.73 residual). NSU/SEFAZ telemetria não é por documento. Monitoramento ERP (`obterResumo` sem empresa) permanece agregado fora da Central UI.
