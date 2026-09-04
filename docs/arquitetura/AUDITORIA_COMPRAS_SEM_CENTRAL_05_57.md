# Auditoria — compras sem Central (Sprint 05.57)

**Status:** auditoria (produção não alterada)  
**Data:** 2026-08-29  
**Pergunta:** como uma compra que **não** veio da Central define `empresa_id`?

## Resposta

Sem `central_documento_id`, a empresa da compra **não** vem do documento.

Ordem em `resolverEmpresaDaCompra`:

1. `req.empresaId` (já anexado) **ou** `resolverEmpresaIdDaRequisicao` (header `X-Empresa-Id`, depois body, depois query).
2. `body.empresa_id` / `body.empresaId` via `empresaIdBody`.
3. Se HTTP e body existem e divergem → `EMPRESA_COMPRA_INCOMPATIVEL` (403), **não grava**.
4. Se um dos dois resolve → `validarEmpresaId` (empresa existe e ativa) → INSERT.
5. Se nenhum resolve e modo **EMPRESA_SIMPLES** → `contrato.empresa_operacional.empresa_id`.
6. Se nenhum resolve e modo **MULTIEMPRESA** → `EMPRESA_COMPRA_AUSENTE` (400). **Não há INSERT com empresa NULL.**

Não há fallback para primeira/última empresa. Não se usa COMPAT na criação.

Tela Compras (manual): o body **não** envia `empresa_id` (só se veio payload Central). A empresa gravada é a do **contexto HTTP**.

Julgamento do fluxo manual: **PARCIAL** — criação é contrato explícito (C); GET lista isolada; GET/cancelar/devolver validam depois do load por ID (403 cruzado, não 404); `PUT /:id/chave-nfe-fornecedor` **não** valida empresa (**RISCO**).

## Compra Central (05.56 — não refatorada)

Com `central_documento_id`: `origem: DOCUMENTO_CENTRAL`, `empresa_id = documento.empresa_id`. Caller de outra empresa → 404. Body B é ignorado como dono.

## Writers

Ver relatório 05.57. Um INSERT de produção: `POST /api/compras` → `continuarGravacao`.

Importação XML / nota avulsa / uso e consumo / integração HTTP usam o **mesmo** POST.

## Leitura

| Rota | Isolamento |
|------|------------|
| `GET /api/compras` | `WHERE c.empresa_id = ?` (contexto). Legado `NULL` **não aparece**. |
| `GET /api/compras/:id` | load por id + `exigirCompraDaEmpresa` → 403 `COMPRA_EMPRESA_INCOMPATIVEL` (existência do id vaza). JSON de erro: `error` + `code`. |
| cancelar / devolver | igual GET por id |
| `PUT /:id/chave-nfe-fornecedor` | UPDATE só por id — **sem** ownership |

## Cenários

| # | Situação | Comportamento atual |
|---|----------|---------------------|
| A | Manual, contexto A | Grava empresa A (`CONTEXTO_HTTP`) |
| B | Manual, caller A, body B | 403, nenhuma compra |
| C | Central A, caller A | Grava empresa A (`DOCUMENTO_CENTRAL`) |
| D | Central A, caller B | 404, nenhuma compra |
| E | Sem empresa (MULTI, sem HTTP/body) | 400 `EMPRESA_COMPRA_AUSENTE` |
| E' | Sem HTTP, EMPRESA_SIMPLES | Grava empresa operacional |
| F | Compra A, caller B GET/cancelar | 403, sem payload da compra |
| F' | Compra A, caller B PUT chave | **UPDATE permitido** (risco) |

## Próxima micro-sprint sugerida

Blindar **compra genérica** (sem Central): tratar `PUT chave-nfe` e alinhar cruzado GET/mutação ao contrato desejado (404 vs 403), **sem** aplicar `documento.empresa_id` a compras manuais.
