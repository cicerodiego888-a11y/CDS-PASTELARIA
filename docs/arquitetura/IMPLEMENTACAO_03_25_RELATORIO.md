# Relatório — Implementação 03.25
## Propagação de empresaId até a baixa física da venda

**Data:** 2026-08-21 · **Status:** concluída

---

## Fluxo real / callers

| Caller | Baixa 02.6? |
|---|---|
| `POST /api/vendas` → `criarVenda` (prazo e à vista) | sim, via `reduzirEstoqueDistribuido` |
| `preCalcularDistribuicao` | não (só leitura) |
| `CriarVendaEntregaService` | não usa `debitarEstoqueItemVenda` |
| `debitoEstoqueVendaViaPorta.debitarEstoqueItemVenda` | porta 02.6 |

---

## Origem do empresaId

`req.empresaId` (middleware 03.19).  
`montarOpcoesBaixaEstoqueVenda` não lê mais body/query/`extrairEmpresaIdDeReq`.

---

## Ponto perdido

Body/user podiam preencher opções da baixa quando `req.empresaId` estava ausente. `contexto`/`ctx` ainda iam para `debitarEstoqueItemVenda`.

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `debitoEstoqueVendaViaPorta.js` | `empresaId` só de `req.empresaId` |
| `VendaPagamentoService.js` | baixa sem encaminhar `contexto`/`ctx` |
| teste 02.6 (`test07`) | body sozinho não inventa empresaId |

Não alterados: porta, dual-write 03.19, 03.23, 03.24, motores.

---

## Com / sem empresa / body

Sem empresa: COMPAT.  
Com empresa: dual-write na empresa do contexto.  
Header A + body B: baixa em A.

---

## Testes / regressão

`venda-baixa-empresa-contexto.test.js`: 12/12 OK.

| Suite | Resultado |
|---|---|
| `venda-baixa-empresa-contexto.test.js` | 12/12 OK |
| `debito-baixa-venda-porta-publica.test.js` (02.6) | 12/12 OK |
| `reservas-pdv-porta-publica.test.js` (02.7) | 11/11 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `leitura-operacional-empresa.test.js` (03.21) | 10/10 OK |
| `listagem-produtos-empresa.test.js` (03.22) | 15/15 OK |
| `pdv-identificacao-estoque-empresa.test.js` (03.23) | 10/10 OK |
| `pdv-disponibilidade-estoque-empresa.test.js` (03.24) | 12/12 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar 03.26.
