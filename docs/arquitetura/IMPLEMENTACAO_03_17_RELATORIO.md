# Relatório — Implementação 03.17
## Primeiro consumidor real de leitura por empresa

**Data:** 2026-08-21 · **Status:** encerrada sem alteração de produção  
**Código:** `NENHUM_CONSUMIDOR_SEGURO_ENCONTRADO`

---

## 1. Auditoria

Procurados leitores de saldo fora de PDV, baixa, venda, compra, reserva, F/NF, MTS/MUC.

Todos os `consultarSaldo` da porta são writers ou motores.  
Listagens ERP/dashboard/alertas/CIP não têm `empresaId` confiável.  
GET produto por ID é tela operacional e o contexto de empresa é opcional.

---

## 2. Consumidor escolhido

Nenhum.

Não foi criado consumidor artificial nem rota HTTP.

---

## 3. Arquivos

| Arquivo | Ação |
|---|---|
| docs 03.17 | criados |
| `tests/estoque/primeiro-consumidor-leitura-empresa.test.js` | auditoria (sem migração) |

Produção inalterada: porta, dual-write, backfill, schema, CREATE, PDV, vendas, compras, reservas, motores.

---

## 4. empresaId

Nenhum ponto auditado reunia leitura isolada **e** `empresaId` explícito confiável.

---

## 5. Quando `estoque_empresa` não tem registro

Não há consumidor novo. `consultarSaldoParaEmpresa` → `null` permanece sem fallback (03.16).

---

## 6. Testes

Auditoria: nenhum fluxo operacional usa `consultarSaldoParaEmpresa`; porta continua em `produtos`.

Não foram inventados os 8 cenários de um consumidor inexistente.

---

## 7. Regressão

| Suite | Resultado |
|---|---|
| `primeiro-consumidor-leitura-empresa.test.js` | 6/6 OK |
| `leitura-controlada-estoque-empresa.test.js` (03.16) | 8/8 OK |
| `leitura-estoque-empresa-03-15.test.js` | 10/10 OK |
| `backfill-estoque-empresa-03-14.test.js` | 12/12 OK |
| `dual-write-estoque-empresa-03-13.test.js` | 10/10 OK |
| `estoque-empresa-service-03-12.test.js` | 8/8 OK |
| `estoque-empresa-schema.test.js` (03.11) | 8/8 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `create-produto-saldo-inicial-porta-publica.test.js` | 10/10 OK |
| `reserva-repair-porta-publica.test.js` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica.test.js` | 10/10 OK |
| `revert-devolucao-venda-porta-publica.test.js` | 10/10 OK |
| `muc-public-contract.test.js` | 20/20 OK |

---

## 8. Próximo passo recomendado

Não iniciar 03.18 nesta entrega.  
Quando houver um ecrã/admin com `empresaId` obrigatório e só leitura, reavaliar. Até lá a porta oficial permanece em `produtos`.
