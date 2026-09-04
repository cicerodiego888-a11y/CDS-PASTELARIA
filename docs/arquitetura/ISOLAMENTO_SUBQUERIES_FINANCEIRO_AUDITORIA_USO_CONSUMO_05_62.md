# Isolamento financeiro/auditoria no relatório de uso/consumo (Sprint 05.62)

**Status:** implementação (somente leitura do relatório)  
**Data:** 2026-08-29  
**Origem:** residual 05.60/05.61

## Inventário (antes)

No `GET /api/compras/relatorio/uso-consumo`:

| # | Origem | Filtro antigo |
|---|--------|----------------|
| 1 | `COUNT(*)` financeiro | `f.compra_id = c.id` |
| 2 | `COUNT(*)` pendentes | `f.compra_id = c.id AND f.status = 'pendente'` |
| 3 | `GROUP_CONCAT` resumo | `f.compra_id = c.id` |
| 4 | `usuario_nome` auditoria | `referencia_id = c.id` + ações + `ORDER BY a.id DESC LIMIT 1` |
| 5 | JOIN Central | já isolado na 05.61 |

Não há outras subqueries financeiro/auditoria nesse handler.

## Ownership

`compras.empresa_id` define o universo. Contexto só autoriza. Sem COALESCE.

## Financeiro

`financeiro.empresa_id` existe (05.38.D).

```
f.compra_id = c.id AND f.empresa_id = c.empresa_id
```

nas três subqueries. Lançamento B no `compra_id` de A não entra. `empresa_id` NULL não resgata.

## Auditoria

Tabela `auditoria` **não** tem coluna `empresa_id` (schema não alterado; writer não alterado).

Isolamento possível sem schema:

```
json_extract(a.detalhes, '$.empresa_id') IS NULL
OR CAST(... AS INTEGER) = c.empresa_id
```

- `criar_uso_consumo` hoje **não** grava `empresa_id` em `detalhes` → continua aparecendo.
- Linha com `detalhes.empresa_id` de outra empresa é ignorada (não vence o `LIMIT 1`).

**Residual:** auditoria sem `empresa_id` em coluna nem em JSON ainda pode aparecer se `referencia_id` for a compra A. Sem schema/writer, não há dono determinístico.

## Fora do escopo

`GET /api/compras` ainda conta `financeiro` só por `compra_id`. GET `/:id` lista financeiro por `compra_id`. Não alterados.

## Sem mutação

Nenhum UPDATE/INSERT/backfill.
