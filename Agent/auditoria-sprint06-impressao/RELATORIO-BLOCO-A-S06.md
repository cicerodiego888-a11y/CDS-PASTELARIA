# RELATÓRIO — Sprint 06 Bloco A  
## Fundação e contratos de impressão de cozinha

**Data:** 2026-11-16  
**Status:** BLOCO A ENTREGUE — aguardando auditoria do Tech Lead  
**Blocos B–E:** NÃO INICIADOS  
**Schema:** permanece **v3** (sem migration V4)  
**Banco oficial:** intocado  

---

## 1. Decisões D1–D8 incorporadas (formalizadas)

| Decisão | Resolução aplicada no Bloco A |
|---|---|
| **D1** | Idempotência de impressão na fila (`UNIQUE idempotency_key`) — **sem** tipos novos em `cozinha_idempotencia` / sem V4 |
| **D2** | Enfileiramento na mesma TX do despacho — **adiado ao Bloco B** (não implementado) |
| **D3** | Roteamento por `codigo_estacao` = `tipo_item` (PASTEL/BEBIDA/OUTRO) — convenção documentada; roteamento operacional no Bloco C |
| **D4** | INDIVIDUAL por comanda — contrato no snapshot; uso no Bloco B/C |
| **D5** | Impressão não bloqueia despacho — Bloco B |
| **D6** | Teste de estação = preview direto **sem fila** e **sem print físico** |
| **D7** | Worker IPC Electron — Bloco D/E |
| **D8** | Reenvio de `ACEITA_PELO_SPOOLER` negado por padrão — Bloco D |

---

## 2. UNIQUE `codigo_estacao` (pré-requisito resolvido)

**Problema:** índice legado `ux_cozinha_estacoes_empresa_codigo` em `(empresa_id, codigo_estacao)` impedia a mesma chave (ex.: `PASTEL`) em duas unidades da mesma empresa — incompatível com D3.

**Correção (sem V4):**
- `DROP INDEX IF EXISTS ux_cozinha_estacoes_empresa_codigo`
- `CREATE UNIQUE INDEX ... ux_cozinha_estacoes_empresa_unidade_codigo ON (empresa_id, unidade_id, codigo_estacao)`
- Função `garantirIndiceEstacoesCodigoPorUnidade` chamada ao garantir schema
- Schema version permanece **3**

---

## 3. O que foi implementado (somente Bloco A)

| Arquivo | Papel |
|---|---|
| `backend/utils/cozinhaSchema.js` | Índice único por unidade |
| `backend/services/cozinha/cozinhaImpressaoContratos.js` | Contratos, normalização, snapshot canônico |
| `backend/services/cozinha/CozinhaImpressaoRenderer.js` | Render TEXT 58/80; `impressao_fisica: false` |
| `backend/services/cozinha/CozinhaImpressaoEstacaoService.js` | CRUD + teste preview |
| `backend/rotas/cozinha.js` | Rotas `/impressao/estacoes*` e `/impressao/snapshot/preview` |
| `tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js` | 11 testes |

### Rotas

| Método | Rota |
|---|---|
| GET | `/api/cozinha/impressao/estacoes` |
| GET | `/api/cozinha/impressao/estacoes/:id` |
| POST | `/api/cozinha/impressao/estacoes` |
| PUT | `/api/cozinha/impressao/estacoes/:id` |
| POST | `/api/cozinha/impressao/estacoes/:id/teste` |
| POST | `/api/cozinha/impressao/snapshot/preview` |

Isolamento: `empresa_id` do contexto + `unidade_id` do JWT (S05).  
Snapshot preview força empresa/unidade da sessão.

### Explicitamente NÃO feito

- Enfileiramento no despacho (Bloco B)
- Direcionamento operacional (Bloco C)
- Worker / claim / print físico (Blocos D–E)
- Alterações em preparação, PDV, estoque, fiscal, TEF, PIX
- Leitura/escrita de `impressora_cupom` ou `/api/impressao`

---

## 4. Testes

| Suite | Resultado |
|---|---|
| `sprint06-bloco-a-fundacao-contratos.test.js` | **11/11** |
| Regressão `sprint01-correcao-isolamento-empresa` + `sprint05-operacoes-itens` | **31/31** · `TOTAL_FAIL=0` |

Cobertura Bloco A: UNIQUE por unidade · CRUD · isolamento empresa/unidade · largura 58/80 · snapshot sem preço/fiscal · renderer · teste D6 sem fila · zero acoplamento comercial.

Logs: `LOG-BLOCO-A-S06.txt`  
Diff: `DIFF-BLOCO-A-S06.patch`

---

## 5. Condição de encerramento

**SPRINT 06 BLOCO A ENTREGUE — AGUARDANDO AUDITORIA DO TECH LEAD.**

Execução interrompida. **Não avançar para o Bloco B** sem nova autorização.
