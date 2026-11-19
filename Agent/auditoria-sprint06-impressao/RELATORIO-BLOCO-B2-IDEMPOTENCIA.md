# RELATÓRIO — Sprint 06 · Bloco B2 (Idempotência + TX despacho)

**Data:** 2026-11-16  
**Status:** B2 ENTREGUE — aguardando auditoria do Tech Lead  
**Bloco C:** NÃO INICIADO  
**Schema:** **v3** (sem V4)  
**Banco oficial:** intocado (`CDS_BLOQUEAR_BANCO_OFICIAL=1`)

---

## 1. Arquivos alterados / criados

| Arquivo | Ação |
|---|---|
| `backend/services/cozinha/CozinhaImpressaoFilaService.js` | `enfileirarDaRodada` + idempotência A/B em `enfileirarJob` |
| `backend/services/cozinha/cozinhaImpressaoContratos.js` | `montarIdempotencyKeyFila` |
| `backend/services/cozinha/CozinhaDespachoService.js` | Gancho na TX do `despacharLote` |
| `tests/cozinha/sprint06-bloco-b2-idempotencia-despacho.test.js` | Suite B2 (13 testes) |
| `tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js` | Ajuste do assert comercial (permite `enfileirarDaRodada` no B2) |

## 2. Ponto de integração com a expedição

`CozinhaDespachoService.despacharLote` — **após** INSERT de rodada/itens e **antes** de marcar idempotência `CONCLUIDA` / `COMMIT`, na mesma conexão SQLite da TX `BEGIN IMMEDIATE`.

Não abre TX própria. Não executa print físico.

## 3. `enfileirarDaRodada`

- Valida empresa/unidade/rodada.
- Agrupa itens da rodada por `tipo_item` (D3: `codigo_estacao = tipo_item`).
- Busca estação **ativa** da mesma empresa+unidade.
- Sem estação → outbox/log `IMPRESSAO_SEM_ESTACAO`; despacho segue (D5).
- Modelo B2: `AGRUPADO` + escopo `all` (INDIVIDUAL/vias avançadas = Bloco C).
- Snapshot canônico via contratos do Bloco A.

## 4. Chave idempotente

```
imp:{empresa}:{unidade}:{rodada}:{estacao}:{modelo}:{escopo}
```

Ex.: `imp:1:1:10:3:AGRUPADO:all`  
Sem timestamp / UUID / aleatório.

| Cenário | Comportamento |
|---|---|
| A — mesma chave + mesmo snapshot | Não duplica; retorna job existente (`repetida: true`) |
| B — mesma chave + snapshot diferente | `409 IMPRESSAO_IDEMPOTENCY_DIVERGENTE`; não sobrescreve |
| C — despacho repetido (mesma Idempotency-Key) | Replay S02; sem nova rodada/jobs |

## 5. Testes individuais B2

| # | Resultado |
|---|---|
| 1–13 | **todos OK** |

## 6–8. Evidências

- Replay sem duplicação: teste **4** e **6**
- Conflito de conteúdo: teste **5**
- Rollback integral: testes **7** e **8**

## 9. Regressão

| Suite | Resultado |
|---|---|
| B2 | **13/13** |
| B1 | **10/10** |
| Bloco A | **14/14** |
| S02 despacho | **21/21** |
| S01 + S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

## 10–12. Confirmações

- Schema **v3**
- Banco temporário + `CDS_BLOQUEAR_BANCO_OFICIAL=1`
- **Bloco C não iniciado**

Artefatos: `DIFF-BLOCO-B2-IDEMPOTENCIA.patch` · `LOG-BLOCO-B2-IDEMPOTENCIA.txt`

---

**BLOCO B2 ENTREGUE — AGUARDANDO AUDITORIA DO TECH LEAD. NÃO INICIAR BLOCO C.**
