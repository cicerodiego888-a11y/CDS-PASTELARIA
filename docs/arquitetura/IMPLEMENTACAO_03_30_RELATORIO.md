# Relatório — Implementação 03.30
## Pedido / Expedição → Motor Comercial (propagação de empresaId)

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Fluxo real

HTTP → middleware → `empresaIdDoReqPedido(req)` → Pedido / Expedição → Motor Comercial → MTS → porta.

## 2. Onde se perdia

Sem middleware nos routers. Services não enviavam `empresaId` a `confirmarPedidoFiscal`.

## 3. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `empresaIdDoReqPedido.js` | só `req.empresaId` |
| `PedidoOperacionalService.js` | propaga `empresaId` em confirmar / analisar / liberar |
| `PedidoService.js` | idem na criação da fila |
| `rotas/pedidos.js` | middleware + helper |
| `rotas/faturamento.js` | middleware + helper no POST pedidos |

## 4. Descartados

Faturar venda, NF-e, GETs, orçamento sem confirmação. MTS e Motor Comercial **não** alterados.

## 5. Autoridade

`req.empresaId`. Body/query/user não substituem.

## 6. COMPAT

Sem contexto: COMPAT certificado (somente `produtos`).

## 7. Isolamento / rollback

A + transferência não altera B. Rollback externo restaura `produtos` + `estoque_empresa`.

## 8. Testes / regressão

`pedido-expedicao-multiempresa-contexto.test.js`: 12/12 OK.

| Suite | Resultado |
|---|---|
| `pedido-expedicao-multiempresa-contexto.test.js` | 12/12 OK |
| `mts-multiempresa-contexto.test.js` | 10/10 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `reservas-dual-write-empresa.test.js` | 12/12 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |
| `rc3161-pedido-motor-comercial-mts.test.js` | homologada |
| `sprint314-orcamento-pedidos.test.js` | 7/7 OK |

`sprint35-pedidos-ui` tem falha pré-existente em `core.js` (`page === 'pedidos'`), sem relação com esta sprint.

## 9. Não alterado

MTS, Motor Comercial, porta, dual-write 03.19/03.20, regras F↔NF, compras, PDV, vendas.

Não iniciar a Sprint 03.31.
