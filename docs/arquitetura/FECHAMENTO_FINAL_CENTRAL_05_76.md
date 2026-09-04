# Fechamento final da Central de Entradas (Sprint 05.76)

**Tipo:** fechamento do núcleo antes do Bloco 3. Sem schema, DistDFe, MIIP, compras, estoque, financeiro, PDV.

## 1. Situação antes

05.70–05.74: identidade `chave+empresa_id`, XML devolução, GET `/buscar-chave`, fila de processamento isoladas.

GET `/saude` já isolado na micro-sprint de saúde (HealthRepository + `resolverEmpresaParaCentral`). Residual 05.73: `FiscalProvider.ultimaEntradaFiscal` com `LIMIT 1` global (chave/fornecedor de qualquer empresa no monitoring).

## 2. Leitores encontrados (classificação)

| Origem | Classe | Ação 05.76 |
|--------|--------|------------|
| GET `/saude` + Health scan com `empresaId` | A | Confirmado isolado |
| HealthScheduler sem empresa | B | Fora do GET HTTP; não muta via `/saude` (`autoRecuperar: false`) |
| `FiscalProvider.ultimaEntradaFiscal` | D → A | Corrigido |
| `listarFornecedoresNovos` / métricas dashboard | B | Fora: leitura interna, sem mutação, sem contexto HTTP empresarial deste fechamento |
| `IndicadoresFiscaisService` agregados | B | Fora: totais de competência, sem chave |
| GET `/diagnostico` contadores/MIIP | B | Fora: painel admin agregado; **reprocessar** já 05.74 |
| DistDFe/disco XML por chave | D residual | Fora (05.70/05.71); não reaberto |
| `buscarPorChave` / fila | A | Não reaberto |

## 3. GET `/saude`

Rota → `resolverEmpresaParaCentral` → `obterSaudeCentral({ exigirEmpresa, empresaId, autoRecuperar: false })` → scan com `empresa_id = ?`. Sem cache global. Sem fila.

## 4. FiscalProvider.ultimaEntradaFiscal

Antes: `ORDER BY … LIMIT 1` sem empresa.  
Depois: `ultimaEntradaFiscal(empresaId)` com `WHERE empresa_id = ?` antes do LIMIT 1. Sem empresa: retorno vazio, **sem SELECT**. Chamador: `FiscalProvider.collect(context)` passa `context.empresaId` (MonitoringContext; sem HTTP no provider).

## 5. Chamadores

- GET `/saude` (já isolado)
- `MonitoringEngine.summary` → `FiscalProvider.collect` → `ultimaEntradaFiscal(context.empresaId)`
- Testes monitoring/rc832 (não exigem última NF)

## 6. Fonte de empresa

Saúde: `resolverEmpresaParaCentral`.  
Monitoring: `criarMonitoringContext` (`req.empresaId` / header). Sem primeiro/último/empresa 1 / COALESCE.

## 7–8. SQL

Anterior (fiscal):

```sql
SELECT ... FROM central_entradas_documentos
ORDER BY datetime(COALESCE(data_entrada, data_emissao, created_at)) DESC, id DESC
LIMIT 1
```

Novo:

```sql
SELECT ... FROM central_entradas_documentos
WHERE empresa_id = ?
ORDER BY datetime(COALESCE(data_entrada, data_emissao, created_at)) DESC, id DESC
LIMIT 1
```

`COALESCE` só em datas, não em `empresa_id`.

## 9–12. MULTIEMPRESA / SIMPLES / NULL / cross-company

A/B/C isolados nos testes. EMPRESA_SIMPLES: saúde via contrato operacional (inalterado). NULL fora. Sem dados de outra empresa em saúde ou última NF.

## 13. Fila 05.74

GET `/saude` não chama `listarPendentesProcessamento`. `autoRecuperar: false`. Reprocessar diagnóstico continua com `empresaId: ctx.empresaId`.

## 14. Leitores mantidos fora

`listarFornecedoresNovos`, dashboards operacionais, Indicadores agregados, GET `/diagnostico` (contagens), XML DistDFe/disco, `ultimaEntradaNaoFiscal` (compras, não documentos Central nesta correção).

## 15. Riscos restantes

- Dashboards `listarFornecedoresNovos` / revisão parada / métricas globais
- GET `/diagnostico` agregados mistos (sem chave)
- DistDFe/disco por chave
- HealthScheduler scan global (não é GET `/saude`)
- `ultimaEntradaNaoFiscal` em compras (LIMIT 1 sem empresa)

## 16. Testes

`tests/central-entradas/fechamento-final-central-05-76.test.js` T01–T18.

## 17. Conclusão

Núcleo de **saúde HTTP** e **última entrada fiscal do monitoring** isolados por `documento.empresa_id`. Identidade `chave+empresa_id` intacta. Central fechada para novas micro-sprints sem falha concreta de homologação. Próximo: Bloco 3 — Operação Pastelaria.
