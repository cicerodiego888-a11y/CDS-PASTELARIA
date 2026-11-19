# RELATÓRIO — Correções de Auditoria Sprint 02 Cozinha

**Data:** 2026-11-16  
**Escopo:** exclusivamente as 6 pendências da auditoria independente.  
**Sprint 03:** não iniciada.

---

## 1. Resumo de cada correção

| ID | Problema | Ação |
|---|---|---|
| 01 | Mesa inativa aceita | Rejeita `ativo≠1` com `409 MESA_INATIVA` |
| 02 | Item cancelado | Diagnóstico: ERP **DELETE** a linha; sem soft-cancel. Validação existente `ITEM_PEDIDO_INCOMPATIVEL`. Sem coluna inventada |
| 03 | `COMERCIAL`→`PASTEL` | Removida inferência por nome/COMERCIAL; só PASTEL\|BEBIDA\|OUTRO explícitos; default `OUTRO` |
| 04 | `/status` vazava schema | Resposta sanitizada; diagnóstico só em `console.error` |
| 05 | Sem testes HTTP | Suite `sprint02-http-seguranca.test.js` (401/400/403/200) |
| 06 | `PRAGMA foreign_keys` após BEGIN | `PRAGMA` **antes** de `BEGIN IMMEDIATE` |

---

## 2. Diagnóstico por problema

### CORREÇÃO 01
`SELECT` já lia `mesas.ativo`, mas não validava. Agora: `Number(mesa.ativo) !== 1` → `MESA_INATIVA`. Teste comprova zero rodada/FIFO/idempotência.

### CORREÇÃO 02
Inspeção de `pedidos_itens` (schema + `PedidoRepository`): remoção de item = `DELETE FROM pedidos_itens`. Colunas `cancelado`/`status`/`situacao` **não existem**. Cancelamento de pedido inteiro = `pedidos.status='CANCELADO'` (já bloqueado).  
**Limitação documentada:** não há cancelamento soft por linha; não foi inventada coluna.

### CORREÇÃO 03
Campos reais: `produtos.tipo_operacional` / snapshot = `COMERCIAL|INSUMO` apenas. Domínio Cozinha `PASTEL|BEBIDA|OUTRO` **não** tem coluna oficial.  
Regra: se snapshot/campo já for PASTEL|BEBIDA|OUTRO → usar; senão → `OUTRO`.  
**Risco remanescente:** classificação fina de preparação exige campo/regra de domínio futura.

### CORREÇÃO 04
`GET /status` retorna só `{ success, operacional, versao_schema }`. Erros de migração vão para log. `503` de despacho não inclui `detalhes: schema`.

### CORREÇÃO 05
Rota real montada como no `server.js` (`verificarToken` + `exigirRecurso('pedidos')` + router). Middlewares não foram alterados.

### CORREÇÃO 06
`database.js` já liga FK no open. Serviço agora garante `PRAGMA foreign_keys=ON` **antes** do `BEGIN IMMEDIATE` (SQLite não aplica mudança de FK no meio da TX).

---

## 3. Arquivos

**Alterados**
- `backend/services/cozinha/CozinhaDespachoService.js`
- `backend/rotas/cozinha.js`

**Criados**
- `tests/cozinha/sprint02-correcoes-auditoria.test.js`
- `tests/cozinha/sprint02-http-seguranca.test.js`
- `Agent/auditoria-sprint02-cozinha/DIFF-CORRECOES-AUDITORIA-S02.patch`
- `Agent/auditoria-sprint02-cozinha/RELATORIO-CORRECOES-AUDITORIA-S02.md`
- `Agent/auditoria-sprint02-cozinha/logs-correcoes/*`

**Excluídos:** nenhum.

---

## 4. Diff integral

Ver `Agent/auditoria-sprint02-cozinha/DIFF-CORRECOES-AUDITORIA-S02.patch`  
(comparação contra cópias pré-correção em `codigo/` + arquivos de teste novos).

---

## 5. Regras de negócio implementadas

1. Mesa da empresa deve estar **ativa**.
2. Item inexistente (removido/cancelado via DELETE) não despacha.
3. `tipo_item` só assume PASTEL/BEBIDA se explícito; caso contrário OUTRO.
4. Respostas de status/cliente sem detalhes internos de schema/SQL.
5. FK ON antes de qualquer transação de despacho.

---

## 6. Isolamento por empresa

Mantido: consultas com `empresa_id` do contexto; HTTP 403 sem vínculo (`EMPRESA_NAO_AUTORIZADA`); regressão Sprint 01 FK composta 6/6 PASS.

---

## 7. Integridade das FKs

- Teste CORREÇÃO 06: `PRAGMA foreign_keys=1` + INSERT cruzado empresa/unidade rejeitado.
- Fonte: `PRAGMA` aparece antes de `beginImmediate`.
- Regressão S01 isolamento FK: PASS.

---

## 8. Testes e resultados

| Suite | Resultado |
|---|---|
| Correções + HTTP | **12/12 PASS** |
| Sprint 02 original | **21/21 PASS** |
| Sprint 01 | **22/22 PASS** |

Comandos (sequenciais):

```bat
node --test --test-concurrency=1 tests/cozinha/sprint02-correcoes-auditoria.test.js tests/cozinha/sprint02-http-seguranca.test.js
node --test --test-concurrency=1 tests/cozinha/sprint02-despacho-fifo.test.js
node --test --test-concurrency=1 tests/cozinha/sprint01-fundacao-persistencia.test.js tests/cozinha/sprint01-correcao-isolamento-empresa.test.js
```

Logs: `Agent/auditoria-sprint02-cozinha/logs-correcoes/`.

### Individuais — correções (7)

1. mesa ativa permite despacho — PASS  
2. mesa inativa rejeitada sem parciais — PASS  
3. diagnóstico sem coluna cancelamento — PASS  
4. item deletado rejeitado; válido despacha — PASS  
5. classificarTipoItem determinístico — PASS  
6. persistência OUTRO para COMERCIAL — PASS  
7. PRAGMA FK + referência inválida — PASS  

### Individuais — HTTP (5)

1. sem auth → 401 — PASS  
2. sem empresa → 400 EMPRESA_CONTEXT_REQUIRED — PASS  
3. sem vínculo → 403 — PASS  
4. autorizado → 200 status sanitizado — PASS  
5. status sem vazamento de erro interno — PASS  

---

## 9–11. Confirmações

- PDV / estoque / FichaTecnica / fiscal / TEF / PIX: **intactos** (não constam no escopo alterado).
- Banco oficial: **não acessado** (`DB_DIR` temp + bloqueio oficial).
- Sprint 01 preservada (22/22).
- Sprint 03: **não iniciada**.

---

## 12. Limitações e riscos remanescentes

1. Sem campo oficial PASTEL/BEBIDA no ERP → itens COMERCIAL ficam `OUTRO` até regra de domínio futura.
2. Cancelamento individual = DELETE; histórico soft de linha cancelada não existe.
3. Hash ainda calculado antes do `BEGIN` (desvio menor já documentado na auditoria original; fora do escopo destas 6 correções).
4. Suite HTTP habilita `recursoHabilitado('pedidos')` só no teste (não altera middleware).
