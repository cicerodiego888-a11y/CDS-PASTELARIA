# Relatório — Implementação 03.27
## Compras multiempresa (propagação de req.empresaId)

**Data:** 2026-08-21 · **Status:** concluída

---

## Fluxos auditados / alterados / descartados

**Alterados (ciclo de estoque da compra):** entrada `POST /`, cancelamento `POST /:id/cancelar`, devolução `POST /:id/devolver`.

**Já corretos:** porta 03.19, middleware no router, header no ajax ERP.

**Descartados:** parse-xml (410), Central, classificação, MUC, uso/consumo, NF avulsa, NF-e devolução.

---

## Origem do empresaId

`req.empresaId` via `empresaIdDoReqCompra`. Não lê mais `empresaIdDoReqOperacional` (body/user).

---

## Ponto perdido

Body/user preenchiam a porta quando o header não vinha. `contexto`/`ctx` podiam entrar no montador da porta.

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `creditoEstoqueCompraViaPorta.js` | `empresaIdDoReqCompra`; opts só `opcoes.empresaId` |
| `debitoEstoqueCompraViaPorta.js` | opts só `opcoes.empresaId` |
| `rotas/compras.js` | três callers usam `empresaIdDoReqCompra(req)` |

Não alterados: porta, dual-write 03.19, Central, MUC, MTS, regras F/NF.

---

## Com / sem empresa / body

Sem empresa: COMPAT (crédito 02.3 / débito 02.4).  
Com empresa: dual-write 03.19 na empresa do contexto.  
Header A + body B: estoque em A.

---

## Testes / regressão

`compras-multiempresa-contexto.test.js`: 12/12 OK.

| Suite | Resultado |
|---|---|
| `compras-multiempresa-contexto.test.js` | 12/12 OK |
| `credito-compra-porta-publica.test.js` (02.3) | 11/11 OK |
| `debito-cancel-dev-compra-porta-publica.test.js` (02.4) | 12/12 OK |
| `dual-write-porta-publica-empresa-03-19.test.js` | 15/15 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `venda-baixa-empresa-contexto.test.js` (03.25) | 12/12 OK |
| `reservas-pdv-multiempresa-contexto.test.js` (03.26) | 10/10 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Próximo candidato (outro domínio): inventário / ajuste administrativo. Não iniciar nesta sprint.
