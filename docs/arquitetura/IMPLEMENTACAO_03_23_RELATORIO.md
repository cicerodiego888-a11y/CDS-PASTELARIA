# Relatório — Implementação 03.23
## PDV — leitura de estoque por empresa na identificação

**Data:** 2026-08-21 · **Status:** concluída

---

## Fluxo real encontrado

`POST /api/produtos/identificar` (e `GET` equivalente).

PDV: `identificarProdutoViaMip` → MIP. Não é `consulta-pdv/buscar` (busca por nome). Não é GET `/:id`.

---

## Endpoint / serviço alterado

| Arquivo | Papel |
|---|---|
| `leituraEstoqueEmpresaProduto.js` | `aplicarSaldosIdentificacaoPdv` → `consultarSaldoParaEmpresa` |
| `rotas/produtos.js` | Overlay após identificar, com `req.empresaId` |
| `frontend/pdv/js/pdv.js` | Header `X-Empresa-Id` + merge dos 5 saldos no produto do carrinho |
| `frontend/shared/js/pdvBuscaProduto.js` | Header `X-Empresa-Id` na mesma rota |

MIP / `PdvProdutoIdentificacaoService` / catálogo: identificação comercial intacta.

---

## `req.empresaId`

Middleware 03.19 no router de produtos + header `X-Empresa-Id` no fetch do PDV. Sem empresaId de body/query como substituto.

---

## Com / sem empresa / sem registro

Sem empresa: legado MIP.  
Com empresa: saldos isolados.  
Sem registro: zeros. **Sem fallback silencioso** para `produtos`.

---

## Testes

`pdv-identificacao-estoque-empresa.test.js`: 10/10 OK.

---

## Regressão

| Suite | Resultado |
|---|---|
| `pdv-identificacao-estoque-empresa.test.js` | 10/10 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `leitura-operacional-empresa.test.js` (03.21) | 10/10 OK |
| `listagem-produtos-empresa.test.js` (03.22) | 15/15 OK |
| `reservas-pdv-porta-publica.test.js` (02.7) | 11/11 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar 03.24.
