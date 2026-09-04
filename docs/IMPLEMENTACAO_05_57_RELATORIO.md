# SPRINT 05.57

## OBJETIVO

Auditar criação de compra **sem** `central_documento_id`. Produção não alterada.

## 1. QUANTOS WRITERS?

**Produção: 1 INSERT** em `compras`.

## 2. QUAIS SÃO?

| Writer | Origem | empresa_id | Classe | Risco |
|--------|--------|------------|--------|-------|
| `POST /api/compras` `continuarGravacao` **sem** Central | tela Compras, XML parse+save, avulsa, uso/consumo, cliente HTTP | HTTP / body (se iguais) / EMPRESA_SIMPLES | **C** | body-only via `daRequisicao` pode ser rotulado `CONTEXTO_HTTP`; frontend manual não manda body |
| mesmo POST **com** `central_documento_id` | Central 05.56 | `documento.empresa_id` | **A** | nenhum neste contrato |
| `GET /` | listagem | filtro contexto | **B** | legado NULL invisível |
| `GET /:id`, cancelar, devolver | load id + `exigirCompraDaEmpresa` | persistido vs contexto | **B** | 403 (não 404); vaza que o id existe |
| `PUT /:id/chave-nfe-fornecedor` | UPDATE chave | **não define** `empresa_id`; não valida dono | **D** | caller B altera compra A |
| `creditoEstoqueCompraViaPorta` COMPAT | estoque pós-item | flag COMPAT se empresa ausente | **E** | POST seta `req.empresaId` antes do crédito |
| INSERTs em `tests/**` | fixture | N/A | **E** | não são writers de produção |

Não há importador, motor ou integração com INSERT próprio.

## 3–4. CENTRAL vs NÃO

O mesmo INSERT. O ramo `resolverEmpresaDaCompra` muda a **fonte**. Com id Central: 1 caminho A. Sem: caminho C.

## 5. COMO CADA UM DEFINE EMPRESA?

Ver `docs/arquitetura/AUDITORIA_COMPRAS_SEM_CENTRAL_05_57.md`.

## 6. FALLBACK?

Não: primeira empresa, última, COMPAT, `empresa_operacional_id` no ramo MULTI.  
**Sim (explícito):** EMPRESA_SIMPLES → empresa operacional do contrato.

## 7. COMPAT?

Não na criação. Existe `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA` no crédito de estoque (E), não como dono da linha `compras`.

## 8. CROSS-COMPANY?

Criação: HTTP≠body bloqueado. Central cruzada: 404.  
Leitura GET/cancelar: 403.  
**PUT chave: atravessa.**

## 9. LEITURA ISOLADA?

Lista: sim (`WHERE empresa_id`). Por id: validação posterior, não 404 opaco.

## 10. PRÓXIMA MICRO-SPRINT

Ownership da **compra genérica** + `PUT /:id/chave-nfe-fornecedor`. Não copiar o contrato do documento Central.

## TESTES

`tests/auditoria/ownership-compras-sem-central-05-57.test.js` — T01–T10 **10/10**.

Regressão 05.56: **10/10** (produção intocada).

## PRODUÇÃO ALTERADA

Nenhuma.
