# SPRINT 05.56

## OBJETIVO

Consolidar o fluxo Central `documento` → abrir compra → `compra.empresa_id = documento.empresa_id`. Contexto HTTP só autoriza.

## AUDITORIA DE CHAMADORES

| Chamador | Fonte anterior de empresa | Classe | Fonte nova |
|----------|---------------------------|--------|------------|
| `obterPayloadCompra` → `montarPayloadAbrirCompra` | `documento.empresaId` (NULL podia ir `null` no payload) | A / gap NULL | `exigirEmpresaIdDoDocumento` |
| `abrirCompra` → `registrarAberturaCompra` | auth 05.55; transição podia ocorrer com documento NULL de empresa | A / D | NULL bloqueado; compra já vinculada valida empresas |
| `vincularCompra` | `compras.empresa_id` persistido (05.55) | A | igual + bloqueio se já ligado a outro `compra_id` |
| `POST /api/compras` `resolverEmpresaDaCompra` + `centralDocumentoId` | documento, depois HTTP/body, fallback EMPRESA_SIMPLES se doc NULL | C/D | só documento após guard; cruzado = 404 |
| `vincularDocumentoCentralAposCompra` | passava `empresaId` (ignorado no vínculo, residual) | B | `empresaIdContexto` (autorização) |
| Frontend save com Central | `centralEmpresaIdAtual` **ou** `CdsEmpresaContexto.lerEmpresaId()` | C | só payload da Central; backend permanece autoridade |
| Compra **sem** `central_documento_id` | HTTP / body / EMPRESA_SIMPLES | B/C | **não alterado** (fora do fluxo documento → compra) |

Não corrigidas outras áreas (DistDFe, MIIP, estoque, financeiro, NF-e, PDV, `CentralProcessamentoService`).

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/central-entradas/CentralEntradasEmpresaContextoService.js` | `exigirEmpresaIdDoDocumento` |
| `backend/motores/central-entradas/services/CentralComprasBridgeService.js` | payload, abertura, vínculo |
| `backend/services/compras/ComprasEmpresaContextoService.js` | `resolverEmpresaDaCompraDesdeDocumentoCentral` |
| `backend/rotas/compras.js` | vínculo pós-gravação com `empresaIdContexto` |
| `frontend/erp/js/compras.js` | não usar contexto ERP como dono se veio da Central |
| `tests/compras-multiempresa-05-38-f-b.test.js` | contrato cruzado = `DOCUMENTO_NAO_ENCONTRADO` |

## ARQUIVOS CRIADOS

| Arquivo | Papel |
|---------|--------|
| `tests/central-entradas/ownership-documento-compra-05-56.test.js` | T01–T10 |
| `docs/arquitetura/OWNERSHIP_DOCUMENTO_COMPRA_05_56.md` | contrato |
| este relatório | |

## TESTES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| `ownership-documento-compra-05-56` | 10/10 OK |
| `ownership-documento-05-55` | 16/16 OK |
| `modo-multiempresa-05-54` | 12/12 OK |
| `central-entradas-multiempresa-05-38-e` | 19/19 OK |
| `compras-multiempresa-05-38-f-b` | 16/16 OK |
| `rc43116-distribuicao-fiscal-central` | 10/10 OK |
| `compras-multiempresa-contexto` | **09/10**; T10 grep `empresaIdDoReqCompra(req)` **pré-existente** — não mascarado |

## INVARIANTE

```
documento.empresa_id = compra.empresa_id
contexto.empresa_id  só autoriza
documento.empresa_id NULL → EMPRESA_DOCUMENTO_NAO_RESOLVIDA
cruzado → 404 DOCUMENTO_NAO_ENCONTRADO
divergência persistida → OPERACAO_EMPRESA_DIVERGENTE (sem correção automática)
```
