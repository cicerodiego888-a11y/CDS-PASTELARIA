# Relatório — Implementação 03.32
## Leitores operacionais restantes → estoque multiempresa

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Leitores auditados

| # | Arquivo / função | Classe | empresaId | Ação |
|---|---|---|---|---|
| 1 | `GET /api/produtos/:id` + `resolverSaldosProdutoParaResposta` | A (já 03.21) | `req.empresaId` | não alterar |
| 2 | Listagem `fragmentoEstoqueEmpresaListagem` | A/B (já 03.22) | `req.empresaId` | não alterar |
| 3 | `POST/GET /produtos/identificar` | A (já 03.23) | `req.empresaId` | não alterar |
| 4 | `VendaPagamentoService` pre-cálculo e `criarVenda` | A (já 03.24) | `req.empresaId` | não alterar |
| 5 | `CriarVendaEntregaService.criarVendaEntrega` | A | `req.empresaId` | **migrado** |
| 6 | Motor Comercial `consultarSaldo` via porta | A | `params.empresaId` | porta lê `produtos` (oficial); **não alterar porta** |
| 7 | `compras.js` validação cancel/devolução (`estoque_atual`) | A | `req.empresaId` disponível | **não alterar** (compras 03.27) |
| 8 | `EstoqueReservaService.obterProdutoComReserva` | D | n/a | sem callers |
| 9 | `dashboard.js` | B | sem autoridade operacional | descartado |
| 10 | Relatório / vencimentos / promoções em `produtos.js` | B | cadastro | descartado |
| 11 | `GET /produtos/codigo/:codigo` | B | cadastro | descartado |
| 12 | CIP `MotorAdapters.coletarEstoque` | B | inteligência | descartado |
| 13 | MIB `QueryOptimizer` | B | busca | descartado |
| 14 | `MonitoringAlertService` | B | alerta global | descartado |
| 15 | ReservaRepair / Reconcile | C | sem HTTP | COMPAT; não alterar Motor Comercial |
| 16 | Importação / certificação / backfill | D | n/a | não migrar |
| 17 | `lotesService.atualizarEstoqueConsolidado` | D | n/a | código morto |

Produção / ficha técnica: inexistente.

---

## 2. Migrados

Somente a disponibilidade da **venda de entrega**. Overlay `aplicarSaldosDisponibilidadeVenda` (helper 03.24). Sem porta nova. Sem writer.

---

## 3. Descartados

Dashboard, relatórios, CIP, MIB, GET por código, compras (proibido alterar 03.27), leitura da porta pública, motores.

---

## 4. Origem do empresaId

`req.empresaId` do middleware em `/api/vendas`. Body/query/user não substituem.

---

## 5. Registro inexistente

Cinco campos = 0. Não copia `produtos`.

---

## 6. Sem empresa

Legado `produtos`. Sem empresa 1. Sem CNPJ. Sem COMPAT novo.

---

## 7. Sem fallback silencioso

Teste 05: legado 999/888 não aparece quando a empresa não tem registro.

---

## 8. Testes

`tests/estoque/leitores-operacionais-multiempresa.test.js` (01–10).

---

## 9. Regressão

Executada a suíte mínima 03.19–03.31, porta pública, MTS (03.29), MUC.

---

## 10. Writers / porta

Nenhum writer alterado. `estoqueSaldosPublico`, `reservasPublico`, dual-write 03.19/03.20, MTS, MUC, Motor Comercial, schema e backfill intactos.
