# Relatório — Implementação 03.20
## Dual-write centralizado de reservas

**Data:** 2026-08-21 · **Status:** concluída

---

## Porta alterada

`reservasPublico.ajustarReservado` — único ponto. Sem segunda porta.

---

## Com empresaId / COMPAT

Espelho em `estoque_empresa` via `aplicarEfeitoReservado`.  
Sem empresa: só `produtos`. Sem tabela `empresas`: não tenta o espelho.

---

## Isolamento / criação / transação

A/B isoladas. Zerado + delta. Sem BEGIN próprio; rollback externo restaura ambos.

---

## Leitura

Produtos permanece oficial. `estoque_empresa` ainda não é leitura operacional.

---

## Arquivos

| Arquivo | Ação |
|---|---|
| `reservasPublico.js` | dual-write de reservado |
| `EstoqueEmpresaService.js` | `aplicarEfeitoReservado` |
| teste + docs 03.20 | criados |

Não alterados: ponte, Repair, PDV, compras, vendas, motores, schema, backfill, leitura.

---

## Testes

01–12.

---

## Regressão

| Suite | Resultado |
|---|---|
| `reservas-dual-write-empresa.test.js` | 12/12 OK |
| `consumo-reserva-pedido-porta-publica.test.js` (03.6) | 10/10 OK |
| `reserva-repair-porta-publica.test.js` (03.7) | 10/10 OK |
| `reservas-pdv-porta-publica.test.js` (02.7) | 11/11 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar próxima Sprint. Não migrar leitura operacional.
