# SPRINT 05.62

## OBJETIVO

Isolar subqueries `financeiro` e `auditoria` no `GET /api/compras/relatorio/uso-consumo`. Sem writers, schema ou backfill.

O texto da sprint chegou truncado após `compras.empresa_id`; a implementação segue o objetivo e o invariante da 05.61.

## INVENTÁRIO

3 subqueries `financeiro` + 1 `auditoria` + JOIN Central (05.61, não reaberto).

## ALTERAÇÃO

`backend/rotas/compras.js` — somente o SELECT do relatório.

- `f.compra_id = c.id AND f.empresa_id = c.empresa_id` (3×)
- auditoria: `referencia_id = c.id` + rejeitar `json_extract(detalhes.empresa_id)` divergente

JOIN Central inalterado. Filtro `c.empresa_id = ?` inalterado.

## OWNERSHIP

`compras.empresa_id`. Sem COALESCE com financeiro/auditoria/contexto.

## CROSS-COMPANY

Financeiro B no `compra_id` A → COUNT/resumo ignoram. Auditoria com `detalhes.empresa_id` B → não vence LIMIT 1.

## NULL

Financeiro `empresa_id` NULL não entra. Compra NULL continua fora da lista.

## TESTES

`tests/compras/isolamento-subqueries-financeiro-auditoria-05-62.test.js` T01–T08 **8/8**.

SQL espelhado em 05.60/05.61 para o relatório continuar reproduzível.

## REGRESSÕES

| Suite | Resultado |
|-------|-----------|
| 05.62 | 8/8 |
| 05.61 | 8/8 |
| 05.60 | 10/10 |
| 05.59 | 10/10 |
| 05.58 | 10/10 |

## RISCOS RESTANTES

- `auditoria` sem coluna `empresa_id`; linhas sem `detalhes.empresa_id` ainda entram se `referencia_id` = compra.
- `GET /api/compras` e `GET /:id` ainda leem financeiro só por `compra_id` — **FORA DO ESCOPO**.

## PRODUÇÃO

SIM — somente subqueries do relatório de uso/consumo.

OUTROS DOMÍNIOS: NÃO.
