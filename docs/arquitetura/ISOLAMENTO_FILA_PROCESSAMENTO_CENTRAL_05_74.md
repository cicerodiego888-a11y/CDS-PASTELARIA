# Isolamento da fila de processamento da Central (Sprint 05.74)

**Status:** implementação  
**Data:** 2026-08-29

## 1. Função `listarPendentesProcessamento`

`CentralDocumentosRepository.listarPendentesProcessamento(limite, empresaId)`  
Aceita também `{ limite, empresaId }`.

Sem `empresaId` inteiro > 0: `EMPRESA_CENTRAL_AUSENTE`, sem SELECT global.

## 2. Chamadores

| Arquivo | Função | Tipo | Origem empresaId |
|---------|--------|------|-------------------|
| `CentralEntradasOrchestrator.processarDocumentosPendentes` | fila | PRODUÇÃO | `opcoes.empresaId` |
| `executarSincronizacao` | pós-DistDFe | PRODUÇÃO | cada `alvo.empresaId` de `listarAlvosSincronizacaoCentral` |
| `buscarPorChave` (`novo`) | auto | PRODUÇÃO | `opcoes.empresaId` (05.72) |
| `processarCicloDfeDocumento` | auto XML completo | PRODUÇÃO | `empresaIdContexto` / documento |
| `rotas` diagnóstico `reprocessar-pendencias` | HTTP | PRODUÇÃO | `resolverEmpresaParaCentral` |
| `HealthMonitor` auto-recuperação | auto | PRODUÇÃO | `documento.empresa_id` persistido por id (não usa mais a fila global) |
| `CentralUploadService` | `processar(id)` | PRODUÇÃO | `empresaResolvida.empresaId` |
| `CentralImportacaoXmlLegadoService` | `processar(id)` | PRODUÇÃO | `empresaIdLookup` |
| `POST /:id/processar` | HTTP | PRODUÇÃO | `opcoesEmpresaDocumento` (já 05.55) |
| `rc1` / mocks rc6.x / 05.73 | testes | TESTE | atualizado 05.73 |

## 3. Origem do empresaId

Alvo de sync, contexto HTTP, documento persistido (health por id). Sem primeira/última empresa, `empresa_operacional_id` em MULTIEMPRESA, COMPAT ou COALESCE.

## 4. SQL anterior

```sql
WHERE status = ?
  AND (parse_json IS NULL OR parse_json = '')
ORDER BY created_at ASC
LIMIT ?
```

## 5. SQL novo

```sql
WHERE status = ?
  AND empresa_id = ?
  AND (parse_json IS NULL OR parse_json = '')
ORDER BY created_at ASC
LIMIT ?
```

## 6–8. A / B / NULL

Fila 11 → só A. Fila 22 → só B. `empresa_id IS NULL` não casa `empresa_id = ?`.

## 9–10. Retry / auto-processamento

Sync processa pendências **por alvo**. GET `/buscar-chave` + `novo` usa a empresa do lookup. Health processa ids do alerta com a empresa persistida do documento, sem varrer a fila global.

## 11. `processar(id)`

Sempre `exigirDocumentoDaEmpresa` após localizar. Sem empresa: `EMPRESA_CENTRAL_AUSENTE`. Cruzado: `DOCUMENTO_NAO_ENCONTRADO` (padrão 05.55). NULL: `EMPRESA_DOCUMENTO_NAO_RESOLVIDA`. Códigos de ownership **não** entram no catch de parser (não viram ERRO nem DTO `sucesso: false`).

## 12. Defesa dupla

SELECT da fila com `empresa_id` + `exigirDocumentoDaEmpresa` antes de transicionar.

## 13–14. Cross-company / mutação

B + `processar(A)` bloqueia antes de `transicionar`. Snapshot de A inalterado.

## 15. Testes

`tests/central-entradas/isolamento-fila-processamento-05-74.test.js` (T01–T12).

## 16. Regressões

05.54–05.73 (05.73 T10 atualizado: fila isolada).

## 17. Riscos restantes

GET `/saude` e `FiscalProvider.ultimaEntradaFiscal` globais (05.73 D, fora desta sprint). XML DistDFe/disco por chave. Dashboards `listarFornecedoresNovos` etc. sem `empresa_id` (não são fila de mutação).
