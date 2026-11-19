# RELATÓRIO — Sprint 06 · E-03 · C10 COMMIT ↔ logout

**Data:** 2026-11-17  
**Escopo:** eliminar janela entre validação final da geração e confirmação do COMMIT do claim  
**Impressão física / spooler:** DESABILITADOS  

---

## 1. Coordenação COMMIT ↔ invalidação do logout

Módulo `cozinhaImpressaoClaimLogoutGate.js` — mutex em cadeia (`comGateClaimLogout`):

| Dono | Operação sob o gate |
|------|---------------------|
| `claim-commit` | Validação síncrona da geração **e** `COMMIT` (sem await externo intercalável entre os dois) |
| `logout-invalidacao` | Incremento/invalidação de `_geracaoOperacional` no Worker |

Fluxo C9 preservado dentro de `BEGIN IMMEDIATE`: SELECT por ID → `__antesUpdateClaim` → validação → UPDATE condicional → (C10) `__antesCommitClaim` → **gate** (revalidar + COMMIT) → ROLLBACK se inválido.

`invalidarGeracaoOperacional` passou a ser **async** e só muta a geração **dentro** do mesmo gate.  
`aoLogoutOperacional` faz `await` dessa invalidação — logout não conclui a invalidação operacional no meio da confirmação do COMMIT.

C8 (bloqueio pré-driver) permanece. Jobs já confirmados em `PROCESSANDO` **não** voltam automaticamente a `PENDENTE`.

Não basta validar antes de outra operação assíncrona: a validação final e o COMMIT compartilham o mesmo dono do gate; logout aguarda.

## 2. Testes

| ID | Resultado |
|----|-----------|
| C10-A | Após UPDATE, invalidação na confirmação → ROLLBACK; job `PENDENTE`; driver=0; sem físico |
| C10-B | Logout concorrente com COMMIT → ordem inequívoca (`claim-apos-update` antes de `logout-invalidou`); sem driver após logout |
| C10-C | Claim com geração válida → driver FAKE; `commit_coordenado_logout` |
| C1–C10 | 15/15 |
| Bloco E + A–D + S01–S05 | TOTAL_FAIL: 0 (E16 + D21 + C34 + B1:10 + B2:14 + A14 + S138) |

## 3. Artefatos

1. `RELATORIO-BLOCO-E-E03-C10-COMMIT-LOGOUT.md`  
2. `DIFF-BLOCO-E-E03-C10-COMMIT-LOGOUT.patch`  
3. `LOG-BLOCO-E-E03-C10-COMMIT-LOGOUT.txt`  

---

**VEREDITO: ENTREGUE PARA AUDITORIA DO TECH LEAD — NÃO AUTOAPROVADO**  
**IMPRESSÃO FÍSICA: NÃO EXECUTADA**  
**HOMOLOGAÇÃO FÍSICA: NÃO AVANÇAR — AGUARDAR TL**
