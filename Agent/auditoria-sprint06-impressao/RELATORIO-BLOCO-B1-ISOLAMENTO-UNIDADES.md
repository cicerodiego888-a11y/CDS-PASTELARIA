# RELATÓRIO — Correção final B1 · Isolamento entre unidades (mesma empresa)

**Data:** 2026-11-16  
**Status:** ENTREGUE — aguardando nova auditoria do Tech Lead  
**Bloco B2:** NÃO INICIADO  
**Produção:** não alterada  

---

## 1. Arquivo alterado

`tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js`

## 2. O que foi adicionado

- Fixture: **Unidade 2** na **mesma** `empresaAuth`, com estação + rodada + job.
- Teste **10**: JWT da Unidade 1 →
  - `GET /impressao/fila` mostra job U1 e **não** mostra job U2
  - `GET /impressao/fila/:id` do job U2 → **404** `IMPRESSAO_JOB_NAO_ENCONTRADO`

## 3. Resultados individuais (B1)

| # | Teste | Resultado |
|---|---|---|
| 1–6 | Serviço (persistência/listagem/isolamento) | OK |
| 7 | HTTP sem auth → 401 | OK |
| 8 | Lista isolada (sessão) | OK |
| 9 | Detalhe / outra empresa → 404 | OK |
| 10 | Isolamento U1×U2 **mesma empresa** | OK |

## 4. Suíte B1 total

**10/10** · `fail 0`

## 5. Regressão S01–S05

**52/52** · `fail 0` · `TOTAL_FAIL=0`

## 6. Banco

- Temporário (`DB_DIR` em `%TEMP%`)
- `CDS_BLOQUEAR_BANCO_OFICIAL=1`
- Sem `BANCO OFICIAL EM USO`

## 7. B2

**Não iniciado.**

Artefatos: `DIFF-BLOCO-B1-ISOLAMENTO-UNIDADES.patch` · `LOG-BLOCO-B1-ISOLAMENTO-UNIDADES.txt`
