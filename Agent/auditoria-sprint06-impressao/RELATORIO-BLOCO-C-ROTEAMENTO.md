# RELATÓRIO — Sprint 06 · Bloco C (Roteamento e estações)

**Data:** 2026-11-16  
**Status:** BLOCO C ENTREGUE — aguardando auditoria do Tech Lead  
**Bloco D:** NÃO INICIADO  
**Schema:** **v3**  
**Banco oficial:** intocado (`CDS_BLOQUEAR_BANCO_OFICIAL=1`)

---

## Arquivos alterados

| Arquivo | Ação |
|---|---|
| `backend/services/cozinha/CozinhaImpressaoFilaService.js` | Roteamento C: INDIVIDUAL/AGRUPADO, vias, `IMPRESSAO_SEM_MODELO_ELEGIVEL` |
| `tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js` | Suite C (24 testes) — **criado** |
| `tests/cozinha/sprint06-bloco-b2-idempotencia-despacho.test.js` | Estações B2 explícitas `modelo_individual:0` / `modelo_agrupado:1` |

**Não alterados:** schema, S01–S05 produção, despacho (gancho B2 preservado), B1 HTTP, PDV/estoque/fiscal, worker/Electron.

## Comportamento

- Roteamento D3: `tipo_item` → `codigo_estacao` na mesma empresa/unidade.
- **AGRUPADO** habilitado → 1 job/estação/rodada; chave `...:AGRUPADO:all`.
- **INDIVIDUAL** habilitado → 1 job/comanda; chave `...:INDIVIDUAL:comanda:{id}`.
- Ambos habilitados → **corrigido** em `RELATORIO-BLOCO-C-CORRECAO-AMBIGUIDADE.md` (0 jobs + AMBIGUO).
- Nenhum habilitado → `IMPRESSAO_SEM_MODELO_ELEGIVEL`; expedição segue.
- Sem estação → `IMPRESSAO_SEM_ESTACAO`; expedição segue.
- `vias` copiadas da estação (não multiplica jobs).
- Snapshot canônico Bloco A; `mesa_numero` = `mesas.numero`.

## Resultados

| Suite | Resultado |
|---|---|
| Bloco C | **24/24** |
| B1 | **10/10** |
| B2 | **14/14** |
| S01+S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

Artefatos: `DIFF-BLOCO-C-ROTEAMENTO.patch` · `LOG-BLOCO-C-ROTEAMENTO.txt`

---

**BLOCO C ENTREGUE — AGUARDANDO AUDITORIA. NÃO INICIAR BLOCO D.**
