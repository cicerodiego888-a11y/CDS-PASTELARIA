# RELATÓRIO — Sprint 06 · Bloco D (Worker e controle de falhas)

**Data:** 2026-11-16  
**Status:** BLOCO D ENTREGUE — aguardando auditoria do Tech Lead  
**Bloco E:** NÃO INICIADO  
**Schema:** **v3** (sem migração)  
**Banco oficial:** intocado (`CDS_BLOQUEAR_BANCO_OFICIAL=1`)  
**Driver:** **FAKE** apenas — sem impressão física / Electron

---

## Arquivos alterados / criados

| Arquivo | Ação |
|---|---|
| `backend/services/cozinha/cozinhaImpressaoDriver.js` | **Novo** — contrato + `FakeImpressaoDriver` |
| `backend/services/cozinha/CozinhaImpressaoWorkerService.js` | **Novo** — claim atômico, processar, abandono→INCERTO |
| `backend/services/cozinha/cozinhaImpressaoContratos.js` | `montarIdempotencyKeyReenvio` |
| `backend/services/cozinha/CozinhaImpressaoFilaService.js` | `reenviarJob` (filho + políticas) |
| `backend/rotas/cozinha.js` | `POST /impressao/fila/:id/reenviar` |
| `tests/cozinha/sprint06-bloco-d-worker-falhas.test.js` | **Novo** — 16 testes obrigatórios |

**Não alterados:** PDV, estoque, fiscal, financeiro, schema v3, Electron, impressão física, Bloco E.

---

## Máquina de estados

```
PENDENTE
  └─(claim atômico)→ PROCESSANDO
                        ├─(driver ACEITA)→ ACEITA_PELO_SPOOLER   [terminal; reenvio bloqueado]
                        ├─(falha conhecida)→ FALHA              [reenvio cria filho]
                        ├─(timeout/exceção)→ RESULTADO_INCERTO  [sem auto-reenvio]
                        └─(abandono/reinício)→ RESULTADO_INCERTO [NÃO volta a PENDENTE]

RESULTADO_INCERTO → reenvio só com confirmacao_humana=true → filho PENDENTE
CANCELADA → reenvio bloqueado
```

`ACEITA_PELO_SPOOLER` = spooler aceitou o trabalho (FAKE confirma). **≠** papel impresso.

---

## Evidências-chave

| Requisito | Evidência |
|---|---|
| Claim atômico | `UPDATE ... WHERE id=(SELECT...) AND estado='PENDENTE'`; teste 2 (2º worker + guarda condicional) |
| Incerto sem auto-reenvio | testes 5–7; `aoIniciarWorker.reenvio_automatico=false` |
| PROCESSANDO abandonado → INCERTO | teste 7; nunca `PENDENTE` |
| Reenvio FALHA → filho | teste 8; `job_origem_id` + `imp:reenvio:{id}:{n}` |
| INCERTO exige humano | teste 9; `IMPRESSAO_REENVIO_EXIGE_CONFIRMACAO_HUMANA` |
| ACEITA bloqueada | teste 10 |
| Sem print físico | teste 16; `impressao_fisica: false`; driver FAKE |
| Preparação intacta | teste 14 |

---

## Testes

| Suite | Resultado |
|---|---|
| Bloco D | **16/16** |
| Bloco C | **34/34** |
| B1 | **10/10** |
| B2 | **14/14** |
| Bloco A | **14/14** |
| S01+S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

Artefatos:  
- `DIFF-BLOCO-D-WORKER-FALHAS.patch`  
- `LOG-BLOCO-D-WORKER-FALHAS.txt`

---

## Confirmações

- Política conservadora: dúvida → `RESULTADO_INCERTO`; sem reenvio automático.  
- Worker não imprime fisicamente (FAKE).  
- Bloco E **não** iniciado.  
- Schema v3 preservado; banco oficial bloqueado.

**BLOCO D ENTREGUE — AGUARDANDO AUDITORIA. NÃO INICIAR BLOCO E.**
