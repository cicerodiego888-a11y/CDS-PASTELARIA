# RELATÓRIO — Sprint 06 · E-03 · Contexto operacional

**Data:** 2026-11-17  
**Escopo:** troca segura de contexto + identidade operacional (E-01/E-02/A–D não reabertos)  
**Impressão física / spooler:** DESABILITADOS  

---

## 1. Troca de contexto

- `notificarContextoOperacional` detecta mudança empresa/unidade.
- Se há tick em curso → **aguarda** o fim antes de aplicar o novo contexto.
- Atualiza o **mesmo** Worker; **não** cria outro timer.
- Próximo `tick()` usa exclusivamente o novo contexto (snapshot explícito).
- Geração de contexto impede que ciclo obsoleto seja tratado como do novo contexto.

## 2. Segurança IPC / sessão

- Sessão no main: `cozinhaImpressaoSessaoElectron.js` (JWT verificado + `empresa_id` da unidade no DB).
- IPC `sessao-autenticada` estabelece sessão a partir do token.
- IPC `contexto-operacional` rejeita IDs divergentes (`IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO`).
- Renderer não escolhe livremente outra empresa/unidade.

## 3. Teste 16

Troca A→B com tick em andamento; 1 Worker / 1 agendador; próximo tick em B/B; rejeição IPC divergente; contexto válido aceito; encerramento; `prints=0`.

## Resultados

Bloco E **16/16** + regressões A–D / S01–S05 — ver log (`TOTAL_FAIL: 0`).

## Artefatos

1. `RELATORIO-BLOCO-E-E03-CONTEXTO-OPERACIONAL.md`  
2. `DIFF-BLOCO-E-E03-CONTEXTO-OPERACIONAL.patch`  
3. `LOG-BLOCO-E-E03-CONTEXTO-OPERACIONAL.txt`  

---

**VEREDITO: E-03 APROVADO — troca segura de contexto + identidade operacional**  
**BLOCO E — PRONTO PARA HOMOLOGAÇÃO CONTROLADA**

Homologação física exige autorização do Product Owner.
