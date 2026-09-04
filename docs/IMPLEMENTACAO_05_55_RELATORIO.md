# SPRINT 05.55

## OBJETIVO

Blindar operações por ID da Central: contexto autoriza, documento determina, compra herda.

## INVENTÁRIO ROTAS POR ID

Ver `docs/arquitetura/OWNERSHIP_DOCUMENTO_CENTRAL_05_55.md`. Todas as rotas de **documento** usam `comDocumentoAutorizado`. Exceção: `PATCH /notificacoes/:id/lida` (não é documento).

## HELPER

`exigirDocumentoDaEmpresa` + `autorizarDocumentoCentralHttp` em `CentralEntradasEmpresaContextoService.js` (único).

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/central-entradas/CentralEntradasEmpresaContextoService.js` | helper + 404 sem vazamento |
| `backend/rotas/central-entradas.js` | guard em todas as rotas de documento; listagem pelo contexto |
| `backend/motores/central-entradas/services/CentralProcessamentoService.js` | ownership antes do pipeline |
| `backend/motores/central-entradas/services/CentralComprasBridgeService.js` | payload/revisão/vínculo |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | status manual + payload opcoes |
| `backend/motores/central-entradas/CentralEntradasService.js` | `obterPayloadCompra(id, opcoes)` |
| `backend/motores/central-entradas/contracts/CentralFiltroDTO.js` | `empresaId` no filtro |
| `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js` | `empresa_id` na listagem |
| `tests/central-entradas-multiempresa-05-38-e.test.js` | código oficial `OPERACAO_EMPRESA_DIVERGENTE` |

## ARQUIVOS CRIADOS

| Arquivo | Papel |
|---------|--------|
| `tests/central-entradas/ownership-documento-05-55.test.js` | T01–T16 |
| `docs/arquitetura/OWNERSHIP_DOCUMENTO_CENTRAL_05_55.md` | contrato |
| este relatório | |

## TESTES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| `ownership-documento-05-55` | 16/16 OK |
| `modo-multiempresa-05-54` | 12/12 OK |
| `central-entradas-multiempresa-05-38-e` | 19/19 OK |
| `compras-multiempresa-05-38-f-b` | 16/16 OK |
| `compras-multiempresa-contexto` | 09/10 OK; T10 grep `empresaIdDoReqCompra(req)` **pré-existente** (compras.js usa outro call site; não alterado nesta sprint) |

## INVARIANTE

```
contexto.empresa_id = documento.empresa_id   (senão 404)
documento.empresa_id = compra.empresa_id     (senão OPERACAO_EMPRESA_DIVERGENTE)
documento.empresa_id NULL                    → EMPRESA_DOCUMENTO_NAO_RESOLVIDA
```
