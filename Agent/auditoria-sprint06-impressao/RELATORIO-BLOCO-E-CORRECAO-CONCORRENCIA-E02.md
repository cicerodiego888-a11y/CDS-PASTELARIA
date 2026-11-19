# RELATÓRIO — Sprint 06 · Bloco E · Correção concorrência E-02

**Data:** 2026-11-17  
**Status:** CORREÇÃO E-02 CONCORRÊNCIA ENTREGUE — aguardando auditoria  
**E-01:** já aprovado (inalterado nesta rodada)  
**Schema:** v3 inalterado  
**Impressão física / spooler real:** NÃO

---

## Problema

Entre o `SELECT` de abandonados e o `UPDATE` que só filtrava `estado = PROCESSANDO`, o worker podia renovar `processando_em` e iniciar impressão; a recuperação ainda invalidava o job com a leitura antiga.

## Correção

`recuperarJobsAbandonados` agora faz:

```sql
UPDATE ... SET estado = RESULTADO_INCERTO ...
WHERE id = ?
  AND empresa_id = ? AND unidade_id = ?
  AND estado = 'PROCESSANDO'
  AND processando_em IS ?   -- valor lido no SELECT
  AND worker_id IS ?        -- valor lido no SELECT
```

- Se o worker renovou a propriedade → `changes = 0` → job **não** entra em `job_ids` / `recuperados`.
- IDs com versão divergente listados em `ignorados_versao`.
- Set `_jobsImpressaoAtivos` permanece como proteção **complementar**.
- `confirmarPropriedadeAntesDeImprimir` mantido imediatamente antes do driver.

## Teste 13 (obrigatório)

| Ordem | Resultado |
|---|---|
| A SELECT → B renovação → C UPDATE stale | `recuperados=0`, job `PROCESSANDO` + worker correto, driver conclui ACEITA |
| Recuperação vence primeiro | job `RESULTADO_INCERTO`; worker não confirma propriedade; `imprimir=0` |

No cenário A→B→C o Set é **liberado** após a renovação para provar que o UPDATE condicional (não só a memória) bloqueia a invalidação.

## Resultados

| Suite | Pass | Fail |
|---|---:|---:|
| Bloco E | 13 | 0 |
| Bloco D | 21 | 0 |
| Bloco C | 34 | 0 |
| B1 / B2 / A | 10 / 14 / 14 | 0 |
| S01–S05 | 138 | 0 |
| **TOTAL_FAIL** | | **0** |

## Artefatos

1. `RELATORIO-BLOCO-E-CORRECAO-CONCORRENCIA-E02.md`
2. `DIFF-BLOCO-E-CORRECAO-CONCORRENCIA-E02.patch`
3. `LOG-BLOCO-E-CORRECAO-CONCORRENCIA-E02.txt`

**Aguardando auditoria do Tech Lead.**
