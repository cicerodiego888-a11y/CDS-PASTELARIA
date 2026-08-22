# Implementação 03.33 — Validação de cancelamento e devolução de compra

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Leitor encontrado

Validação prévia de `estoque_atual` em:

- `POST /api/compras/:id/cancelar` — `validarEstoque`
- `POST /api/compras/:id/devolver` — `processarProximo`

Router: `backend/rotas/compras.js`  
Middleware confirmado: `router.use(criarMiddlewareContextoEmpresa(db))`  
`req.empresaId` via `empresaIdDoReqCompra(req)` (somente o contexto validado).

A baixa física **não** mudou: `debitarEstoqueItemCompra` → `estoqueSaldosPublico.debitarSaldo`.

---

## Comportamento

| Contexto | Origem de `estoque_atual` |
|---|---|
| Sem `req.empresaId` | `produtos` (legado) |
| Com empresa + registro | `estoque_empresa.estoque_atual` |
| Com empresa + sem registro | **0** — não copia `produtos` |

Regra preservada: `estoqueAtual < quantidade` bloqueia. Sem SF/SNF, sem reservas nesta validação.

Body/query/user não substituem `req.empresaId`. Sem empresa 1. Sem CNPJ.

---

## Isolamento

Legado `produtos.estoque_atual = 999`. Empresa A (15) permite qty 8. Empresa B (5) bloqueia. O 999 não libera B.

Sprint **03.34 não iniciada**.
