# SPRINT 05.65

## OBJETIVO

Auditoria final do domínio compras após 05.56–05.64. Produção não alterada.

## WRITERS

**1** `INSERT INTO compras` de produção: `POST /api/compras`.

Satélites no mesmo arquivo: `compras_itens`, `compras_devolucoes`, `financeiro`. PUT chave no service. Backfill/MUC/schema = **E**.

## LEITURAS / MUTAÇÕES ISOLADAS

Lista, detalhe, financeiro anexado, relatório uso/consumo, cancelar, devolver (guard), PUT chave.

## RISCOS D AINDA ABERTOS

1. Rotas NF-e devolução em `compras.js` sem guard (visualizar/emitir sobre compra alheia).
2. `SELECT … chave_acesso = ? LIMIT 1` global no POST `/` (e espelho na Central).

## RISCOS C

UPDATE devolução só por `id`; classificador histórico CNPJ; agregados NF-e no GET `/`; auditoria do relatório.

## TESTES

`tests/auditoria/ownership-modulo-compras-05-65.test.js` T01–T10 **10/10**.

## PRÓXIMA SPRINT

05.66 — NF-e devolução de compra (prioridade: A opera compra B).

## PRODUÇÃO ALTERADA

Nenhuma.
