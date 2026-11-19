# RELATÓRIO — Última validação Tech Lead (rejeições reais de db.run)

**Data:** 2026-11-16  
**Status:** TESTES ADICIONADOS — aguardando aprovação final do Tech Lead  
**Sprint 05:** NÃO INICIADA

## Pendência atendida

Além dos ganchos de simulação (mantidos), foram adicionados testes que provocam **rejeição real via callback de `db.run()`** para:

- `PRAGMA foreign_keys = OFF`
- restauração `PRAGMA foreign_keys = ON`

Isolamento: monkey-patch local da conexão temporária; a Promise de `dbRun` rejeita pelo mesmo caminho de erro do sqlite3.

## Novos testes

| # | Caso | Resultado |
|---|---|---|
| 8 | Rejeição real OFF → `COZINHA_FK_DESABILITAR_FALHOU`, v2 e dados intactos | PASS |
| 9 | Rejeição real na restauração → `COZINHA_FK_RESTAURACAO_FALHOU`, sem sucesso | PASS |
| 10 | Restauração real + erro migração → ambos diagnósticos | PASS |

Testes 1–7 (incluindo ganchos) **mantidos**.

## Resultados

- Sprint 04A: **15/15 PASS**
- Regressão S01–S03 + 04A: ver `LOG-VALIDACAO-FINAL-DBRUN-S04A.txt`

## Diff

`DIFF-VALIDACAO-FINAL-DBRUN-S04A.patch`  
Arquivo alterado: `tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js`  
Código de produção: **sem alteração** nesta validação.

## Declaração

Banco oficial não acessado · sem migration em produção · S01–S03 intactas · Sprint 05 não iniciada.

Aguardando aprovação final do Tech Lead.
