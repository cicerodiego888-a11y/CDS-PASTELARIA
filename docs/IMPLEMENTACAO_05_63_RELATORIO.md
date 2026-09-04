# SPRINT 05.63

## OBJETIVO

Auditar leitores de `financeiro` em `GET /api/compras` e `GET /api/compras/:id`. Produção não alterada.

## INVENTÁRIO

**2 leitores** no escopo:

1. `GET /` — subquery `COUNT(*)` `parcelas_pendentes` (`compra_id` + `status`, sem empresa).
2. `GET /:id` — `SELECT * FROM financeiro WHERE compra_id = ?`.

Sem JOIN, sem helper, sem repository. Relatório 05.62 **não** auditado como correção (confirmado intacto).

## OWNERSHIP

Compra: `compras.empresa_id`. Financeiro nestes GET: só `compra_id`.

## CROSS-COMPANY

B não vê a compra A. A pode ver **agregado e linhas** financeiras de B se `compra_id` apontar para A.

## NULL

Financeiro NULL **visível** na lista e no detalhe.

## CLASSIFICAÇÃO

Lista/detalhe da **compra**: A/B. Leitura **financeira** anexada: **D**.

## TESTES

`tests/auditoria/leitura-financeiro-compras-05-63.test.js` T01–T10.

## PRÓXIMA SPRINT

05.64 — isolamento das duas queries de leitura (espelhar 05.62). Não implementar agora.

## PRODUÇÃO ALTERADA

Nenhuma.
