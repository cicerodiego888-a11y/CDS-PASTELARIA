# Relatório — Implementação 03.22
## Listagem de produtos por empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## Rota

`GET /api/produtos` via `fragmentoEstoqueEmpresaListagem(req.empresaId)`.

---

## Com / sem empresa / sem registro

Com `req.empresaId`: JOIN isolado.  
Sem: legado.  
Sem registro: zeros. Sem fallback.

---

## Isolamento / filtros

A/B isoladas. `modo_fiscal` e `ORDER BY p.id DESC` preservados. Sem paginação nova (a listagem original não pagina).

---

## Arquivos

| Arquivo | Ação |
|---|---|
| `leituraEstoqueEmpresaProduto.js` | fragmento SQL |
| `rotas/produtos.js` | GET `/` usa o fragmento |
| teste + docs 03.22 | criados |

Não alterados: GET `/:id`, PDV, porta, dual-write, writers, motores.

---

## Testes

01–15.

---

## Regressão

| Suite | Resultado |
|---|---|
| `listagem-produtos-empresa.test.js` | 15/15 OK |
| `leitura-operacional-empresa.test.js` (03.21) | 10/10 OK |
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

Não iniciar 03.23. Não migrar PDV.
