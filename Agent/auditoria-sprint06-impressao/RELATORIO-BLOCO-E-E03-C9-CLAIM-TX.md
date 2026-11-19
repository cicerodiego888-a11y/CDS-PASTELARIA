# RELATÓRIO — Sprint 06 · E-03 · C9 Claim TX / geração

**Data:** 2026-11-17  
**Escopo:** fechar janela entre validação de geração e COMMIT do claim  
**Impressão física / spooler:** DESABILITADOS  

---

## 1. Implementação

Em `reivindicarProximoJob` (dentro de `BEGIN IMMEDIATE`):

1. SELECT do candidato  
2. Hook `__antesUpdateClaim` (teste)  
3. Validar geração operacional → se inválida, **throw** → **ROLLBACK**  
4. UPDATE PENDENTE → PROCESSANDO  
5. Revalidar geração antes do COMMIT → inválida → **ROLLBACK**  
6. COMMIT somente se a geração permanecer válida  

`processarProximo` propaga `verificarGeracaoValida` / `__antesUpdateClaim` e mapeia `IMPRESSAO_TICK_INVALIDADO` para `claim_rollback: true` (sem driver).

Verificação pré-driver (C8) permanece.

Regra preservada: job já confirmado como `PROCESSANDO` **não** volta automaticamente a `PENDENTE`.

## 2. Testes

| ID | Resultado |
|----|-----------|
| C9 | logout na TX → ROLLBACK; job `PENDENTE`; `tentativas=0`; `worker_id=null`; driver=0; 1 Worker |
| C9-R | claim normal → processa (FAKE); sem físico |
| C1–C9 (+C9-R) | 12/12 |
| Bloco E + A–D + S01–S05 | TOTAL_FAIL: 0 |

## 3. Artefatos

1. `RELATORIO-BLOCO-E-E03-C9-CLAIM-TX.md`  
2. `DIFF-BLOCO-E-E03-C9-CLAIM-TX.patch`  
3. `LOG-BLOCO-E-E03-C9-CLAIM-TX.txt`  

---

**VEREDITO: ENTREGUE PARA AUDITORIA DO TECH LEAD — NÃO AUTOAPROVADO**  
**IMPRESSÃO FÍSICA: NÃO EXECUTADA**
