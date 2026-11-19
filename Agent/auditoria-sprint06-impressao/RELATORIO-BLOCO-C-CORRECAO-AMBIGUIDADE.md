# RELATÓRIO — Sprint 06 · Correção Bloco C (modelo ambíguo / anti-duplicidade)

**Data:** 2026-11-16  
**Status:** CORREÇÃO BLOCO C ENTREGUE — aguardando auditoria do Tech Lead  
**Bloco D:** NÃO INICIADO  
**Schema:** **v3** (sem migração)  
**Banco oficial:** intocado (`CDS_BLOQUEAR_BANCO_OFICIAL=1`)

---

## Arquivos alterados

| Arquivo | Ação |
|---|---|
| `backend/services/cozinha/CozinhaImpressaoFilaService.js` | Ambos modelos → 0 jobs + `IMPRESSAO_CONFIG_MODELO_AMBIGUO`; XOR exclusivo; header C |
| `tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js` | Testes 25–34 (anti-duplicidade / ambiguidade) |

**Não alterados:** schema, PDV, estoque, fiscal, financeiro, despacho (gancho B2), B1 HTTP, A/B1/B2 contratos de idempotência, worker/Electron/impressão física.

---

## Regra de modelos (corrigida)

| Configuração | Comportamento |
|---|---|
| Somente INDIVIDUAL | Jobs individuais (1/comanda) |
| Somente AGRUPADO | Job agrupado (1/estação/rodada) |
| Ambos habilitados | **0 jobs** + outbox `IMPRESSAO_CONFIG_MODELO_AMBIGUO` |
| Nenhum habilitado | `IMPRESSAO_SEM_MODELO_ELEGIVEL` |
| Sem estação | `IMPRESSAO_SEM_ESTACAO` |

- Não escolhe automaticamente um modelo.
- Não gera os dois conjuntos.
- Despacho **nunca** é bloqueado por falha/config de impressão.

## Idempotência (preservada A/B + C)

- Chave: `imp:{emp}:{uni}:{rod}:{est}:{modelo}:{escopo}` (`all` | `comanda:{id}`).
- Persistência: SELECT pré-INSERT + UNIQUE + reavaliação A/B em corrida.
- Replay idêntico → job existente (`repetida: true`).
- Conteúdo divergente → `IMPRESSAO_IDEMPOTENCY_DIVERGENTE` (não sobrescreve).

---

## Testes executados

| Suite | Resultado |
|---|---|
| Bloco C (correção) | **34/34** |
| Regressão B1 | **10/10** |
| Regressão B2 | **14/14** |
| Regressão Bloco A | **14/14** |
| Regressão S01+S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

Cobertura obrigatória 1–10: testes C 25–34 (INDIVIDUAL, AGRUPADO, AMBIGUO, SEM_MODELO, replay despacho, replay comanda, reprocessamento, preservação, despacho com ambiguidade, isolamento unidade).

---

## Confirmações

| Item | Status |
|---|---|
| Ausência de duplicidade (pedido/comanda/rodada/replay) | **OK** |
| Blocos A, B1, B2 preservados | **OK** (regressão verde) |
| Bloco D intocado | **OK** (sem worker / print físico / Electron) |
| Schema v3 | **OK** |
| Banco oficial | **OK** (somente temp + `CDS_BLOQUEAR_BANCO_OFICIAL=1`) |

Artefatos:  
- `DIFF-BLOCO-C-CORRECAO-AMBIGUIDADE.patch`  
- `LOG-BLOCO-C-CORRECAO-AMBIGUIDADE.txt`

---

**CORREÇÃO BLOCO C ENTREGUE — AGUARDANDO AUDITORIA. NÃO INICIAR BLOCO D.**
