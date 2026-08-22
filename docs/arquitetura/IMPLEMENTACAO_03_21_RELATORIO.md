# Relatório — Implementação 03.21
## Primeira leitura operacional por empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## Consumidor

`GET /api/produtos/:id` — cadastro, somente leitura de saldo.

`req.empresaId` validado pelo middleware opcional da 03.19.

---

## Recusados

Porta pública, listagens, dashboard, PDV, writers, motores, endpoint 03.18 (já administrativo).

---

## Com / sem empresa / sem registro

Com empresa: `consultarSaldoParaEmpresa`.  
Sem empresa: legado `produtos`.  
Sem registro isolado: zeros, sem copiar legado.

---

## Arquivos

| Arquivo | Ação |
|---|---|
| `leituraEstoqueEmpresaProduto.js` | criado |
| `rotas/produtos.js` | GET `/:id` consome o helper |
| teste + docs 03.21 | criados |

Não alterados: porta, reservas, dual-write, PDV, compra, venda, motores, schema.

---

## Testes

01–10.

---

## Regressão

| Suite | Resultado |
|---|---|
| `leitura-operacional-empresa.test.js` | 10/10 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `dual-write-estoque-empresa-03-13.test.js` | 10/10 OK |
| `backfill-estoque-empresa-03-14.test.js` | 12/12 OK |
| `leitura-estoque-empresa-03-15.test.js` | 10/10 OK |
| `leitura-controlada-estoque-empresa.test.js` (03.16) | 8/8 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `reservas-pdv-porta-publica.test.js` (02.7) | 11/11 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar próxima Sprint. Não migrar outros consumidores. `produtos` continua storage oficial legado.
