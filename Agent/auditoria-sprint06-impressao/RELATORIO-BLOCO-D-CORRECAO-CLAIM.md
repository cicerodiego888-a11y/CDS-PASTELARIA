# RELATÓRIO — Sprint 06 · Correção Bloco D (Claim inequívoco)

**Data:** 2026-11-17  
**Status:** CORREÇÃO BLOCO D ENTREGUE — aguardando auditoria do Tech Lead  
**Bloco E:** NÃO INICIADO  
**Schema:** **v3** (sem alteração)  
**Banco oficial:** intocado (`CDS_BLOQUEAR_BANCO_OFICIAL=1`)

---

## Problema

Após o `UPDATE` de claim, a leitura usava `worker_id + processando_em + MAX(id)`.  
Duas chamadas do mesmo worker podiam reivindicar jobs distintos e ambas recuperar o mesmo registro.

## Solução de concorrência

Em `reivindicarProximoJob`:

1. `BEGIN IMMEDIATE` (ou participa da TX já aberta do chamador).
2. `SELECT id` do candidato `PENDENTE` (empresa/unidade, ordenado).
3. `UPDATE … WHERE id = ? AND estado = 'PENDENTE'` — `changes` deve ser 1.
4. `SELECT * WHERE id = ?` — **o mesmo id** da chamada.
5. `COMMIT`.

Cada chamada devolve exatamente o job que ela própria reivindicou.  
Não há recuperação por `worker_id`/timestamp/`ORDER BY id DESC`.

## Arquivos alterados

| Arquivo | Ação |
|---|---|
| `backend/services/cozinha/CozinhaImpressaoWorkerService.js` | Claim transacional por ID exato |
| `tests/cozinha/sprint06-bloco-d-worker-falhas.test.js` | Testes 17–20 (concorrência) |

Driver FAKE, Electron e Bloco E: **intocados**.

---

## Testes

| Suite | Resultado |
|---|---|
| Bloco D | **20/20** |
| Bloco C | **34/34** |
| B1 | **10/10** |
| B2 | **14/14** |
| Bloco A | **14/14** |
| S01+S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

Novos: 17 (mesmo worker, 2 jobs), 18 (2 workers, 1 job), 19 (driver sem duplicidade), 20 (resultado por id).

Artefatos:  
- `DIFF-BLOCO-D-CORRECAO-CLAIM.patch`  
- `LOG-BLOCO-D-CORRECAO-CLAIM.txt`

---

**CORREÇÃO BLOCO D ENTREGUE — AGUARDANDO AUDITORIA. NÃO INICIAR BLOCO E.**
