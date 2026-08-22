# Relatório — Implementação 03.10
## Auditoria final dos escritores de estoque e reserva

**Data:** 2026-08-21 · **Status:** concluída (auditoria — sem migração)

---

## 1. Existe escritor operacional pendente?

**NÃO.**

Não há Sprint 03.11 de escritor. Auditoria da fundação atual **encerrada**.

**Não** iniciar `estoque_empresa`.

---

## 2. Tabela

| Escritor | Arquivo | Operação | Status |
|---|---|---|---|
| Ajuste 02.1 | `ajusteEstoqueService.js` | ± SF/SNF porta | MIGRADO |
| Recálculo 02.2 | `estoqueFiscalService.js` | deltas porta | MIGRADO |
| Crédito compra 02.3 | `creditoEstoqueCompraViaPorta.js` | + SF/SNF | MIGRADO |
| Débito compra 02.4 | `debitoEstoqueCompraViaPorta.js` | − SF/SNF | MIGRADO |
| Crédito venda cancel/dev 02.5 | `creditoEstoqueVendaViaPorta.js` | + SF/SNF | MIGRADO |
| Baixa venda 02.6 | `debitoEstoqueVendaViaPorta.js` | − SF/SNF | MIGRADO |
| Reservas PDV 02.7 | `EstoqueReservaService.js` | ± reservado | MIGRADO |
| Revert NF-e 03.5 | `estoqueNfeDevolucaoVenda.js` | − SF/SNF | MIGRADO |
| Consumo pedido 03.6 | `pedidoReservaPonteNucleo.js` | − RF | MIGRADO |
| Repair 03.7 | `ReservaRepairService.js` | ± RF | MIGRADO |
| CREATE produto 03.8 | `rotas/produtos.js` POST | crédito inicial | MIGRADO |
| MTS / Motor Comercial | motores | porta | MIGRADO |
| Portas oficiais | `estoqueSaldosPublico` / `reservasPublico` | SQL interno | MIGRADO |
| COMPAT pré-multiempresa | vários callers | contexto ausente | COMPAT |
| Certificação etapa estoque | `ReleaseCertificationService.js` | prova + DELETE | COMPAT |
| SELECT / disponibilidade / PUT ignore | vários | sem escrita | LEITURA/CÁLCULO |
| INSERT cadastro 0,0,0 | compras / importer | cadastro | LEITURA/CÁLCULO |
| Lotes vivos 03.9 | `lotesService.js` | rastreio | LEITURA/CÁLCULO |
| `atualizarEstoqueConsolidado` | `lotesService.js` | SET EA sem caller | CÓDIGO MORTO |
| Backfill SF | `scripts/backfill-saldos-fiscais.js` | one-shot sem caller | CÓDIGO MORTO |
| — | — | — | **PENDENTE: nenhum** |

Lotes: **AUDITADO — NÃO É ESCRITOR OPERACIONAL DE SALDO/RESERVA**.

Script histórico `backend/scripts/backfill-saldos-fiscais.js` (`SET saldo_fiscal = estoque_atual`) **não tem caller** no runtime — CÓDIGO MORTO / one-shot. Não é 03.11.

---

## 3. Testes executados

`node tests/estoque/auditoria-final-escritores.test.js`

| # | Cenário |
|---|---|
| 01 | 02.x pela porta |
| 02 | 03.5 sem UPDATE direto |
| 03 | 03.6 sem UPDATE reservado |
| 04 | 03.7 Repair sem UPDATE reservado |
| 05 | 03.8 CREATE pela porta |
| 06 | 03.9 lotes não operacional |
| 07 | nenhum pendente |

### Regressão

| Suite | Resultado |
|---|---|
| `auditoria-final-escritores.test.js` | **7/7 OK — PENDENTE=NÃO** |
| `create-produto-saldo-inicial-porta-publica.test.js` | **10/10 OK** |
| `reserva-repair-porta-publica.test.js` | **10/10 OK** |
| `consumo-reserva-pedido-porta-publica.test.js` | **10/10 OK** |
| `revert-devolucao-venda-porta-publica.test.js` | **10/10 OK** |
| `mts-v1.test.js` | **9/9 OK** (homologado) |
| `muc-public-contract.test.js` | **20/20 OK** |

---

## 4. Arquivos

**Produção:** nenhum alterado.

**Criados:** teste 03.10 + estes docs.

---

## 5. Limitações (fora desta Sprint)

Storage ainda em `produtos`. COMPAT permanece até JWT/empresa sempre presentes. `estoque_empresa` **não** criada.
