# RELATÓRIO — Correções finais de auditoria Sprint 04A

**Data:** 2026-11-16  
**Status:** CORREÇÕES IMPLEMENTADAS E TESTADAS — aguardando nova auditoria  
**Sprint 05:** NÃO INICIADA

## Correção 01 — Restauração das Foreign Keys

**Problema:** `BEGIN IMMEDIATE` ocorria fora do `try` protegido após `PRAGMA foreign_keys = OFF`, podendo deixar FKs desabilitadas se o BEGIN falhasse.

**Correção em `migrarCozinhaV2paraV3`:**
- Registra estado original (`fkWasOn`).
- Marca `fkAlteradas` só após desligar FKs.
- BEGIN em bloco próprio com código `COZINHA_MIGRACAO_BEGIN_FALHOU`.
- `finally` restaura sempre o estado original quando FKs foram alteradas — inclusive falha no BEGIN.
- Gancho de teste: `simularFalha: 'falha_begin'`.

**Teste:** falha no BEGIN → `PRAGMA foreign_keys` permanece `ON`; versão permanece 2.

## Correção 02 — Backup residual

**Problema:** `DROP TABLE IF EXISTS cozinha_idempotencia__v2_bak` podia apagar backup residual com dados.

**Correção:**
- Antes de qualquer rebuild, verifica existência de `cozinha_idempotencia__v2_bak`.
- Se existir → erro `COZINHA_MIGRACAO_BACKUP_RESIDUAL`.
- Não executa DROP, não renomeia a original, não sobrescreve.
- Preserva tabela original e backup integralmente.

**Teste:** bak com 2 registros → migração aborta; original e bak intactos; FKs ON; meta=2.

## Arquivos

| Arquivo | Ação |
|---|---|
| `backend/utils/cozinhaSchema.js` | alterado |
| `tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js` | alterado |
| `DIFF-CORRECOES-AUDITORIA-S04A.patch` | diff integral |
| `LOG-CORRECOES-AUDITORIA-S04A.txt` | logs |

## Testes

| Suite | Resultado |
|---|---|
| Correção BEGIN/FK | PASS |
| Correção backup residual | PASS |
| Sprint 04A original (A–E) | PASS |
| Regressão S01–S03 + 04A | **101/101 PASS** |

## Declaração

- Banco oficial não acessado.
- Nenhuma migration em produção.
- Pedido/PDV/estoque/fiscal intactos.
- Sprint 05 não iniciada.

Aguardando nova auditoria independente antes de declarar Sprint 04A aprovada.
