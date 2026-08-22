# Relatório — Implementação 03.33
## Validação de cancelamento e devolução de compra multiempresa

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Leitor encontrado

`produtos.estoque_atual` nas validações de cancelar e devolver compra.

## 2. Arquivo e função

| Fluxo | Rota | Função | Origem anterior |
|---|---|---|---|
| Cancelamento | `POST /api/compras/:id/cancelar` | `validarEstoque` | `SELECT nome, estoque_atual FROM produtos` |
| Devolução | `POST /api/compras/:id/devolver` | `processarProximo` | `LEFT JOIN produtos` `estoque_atual` |

Helper: `estoqueAtualParaValidacaoCompra` (`backend/services/compras/estoqueAtualValidacaoCompra.js`).

## 3. Comportamento anterior

Ambas comparavam `estoque_atual` legado com a quantidade. Com estoque global alto, empresa B podia cancelar/devolver o que não tinha isolado.

## 4. Com empresa

`consultarSaldoParaEmpresa`. Usa `estoqueAtual` isolado. A fórmula `estoqueAtual < quantidade` permanece.

## 5. Sem empresa

`produtos.estoque_atual`. Sem empresa artificial.

## 6. Sem registro isolado

Zero. Sem copiar 999 de `produtos`.

## 7. Sem fallback silencioso

Teste 06/07: legado 999 não entra quando há `req.empresaId`.

## 8. Regras de cancelamento preservadas

Quantidade da compra, distribuição F/NF, ordem dos débitos, transação `BEGIN IMMEDIATE`, `debitarEstoqueItemCompra` (02.4). Só a origem da validação mudou.

## 9. Regras de devolução preservadas

Limite já devolvido, `calcularDevolucaoCompraFiscalPrimeiro`, débito pela porta. Só a origem de `estoque_atual` da checagem mudou.

## 10. Testes

`tests/estoque/cancelamento-devolucao-compra-multiempresa.test.js` (01–12).

## 11. Regressão

- credito-compra-porta-publica
- debito-cancel-dev-compra-porta-publica
- compras-multiempresa-contexto
- dual-write 03.19 / 03.20
- porta pública
- MTS / MUC
