# SPRINT 05.64

## OBJETIVO

Isolar financeiro em `GET /api/compras` e `GET /api/compras/:id`.

## ALTERAÇÃO

`backend/rotas/compras.js` — só esses dois leitores.

- Lista: `AND f.empresa_id = c.empresa_id`
- Detalhe: `AND empresa_id = ?` com `compra.empresa_id`

Relatório 05.62 não mexido.

## TESTES

`tests/compras/isolamento-financeiro-leituras-compras-05-64.test.js` T01–T08.

05.63 atualizado para o comportamento isolado. 05.62 T07 deixa de exigir lista sem filtro (escopo 05.62 era só o relatório).

## REGRESSÕES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| isolamento-financeiro-leituras-compras-05-64 | T01–T08 OK |
| leitura-financeiro-compras-05-63 | 10/10 |
| isolamento-subqueries-financeiro-auditoria-05-62 | 8/8 |
| ownership-leitura-mutacao-05-59 | 10/10 |

## RISCOS RESTANTES

Writers financeiro (INSERT/DELETE) fora destes GET. Subqueries NF-e/itens no GET `/` — FORA DO ESCOPO.

## PRODUÇÃO

SIM — somente as duas queries de leitura de compras.

OUTROS DOMÍNIOS: NÃO.
