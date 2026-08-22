# Relatório — Implementação 03.18
## Consulta administrativa de estoque por empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## Auditoria

Não havia `backend/rotas/estoque.js`. Middleware reutilizado: `criarMiddlewareContextoEmpresa(..., { obrigatorio: true })` (já em `empresas.js` / `auth.js`). Assinatura 03.16 confirmada.

---

## Rota / origem do empresaId

`GET /api/estoque/empresa/produtos/:produtoId`  
`req.empresaId` do middleware. Handler não lê body/query.

---

## Sem registro

404 `ESTOQUE_EMPRESA_NAO_ENCONTRADO`. Sem fallback para `produtos`.

---

## Arquivos

| Arquivo | Ação |
|---|---|
| `backend/rotas/estoque.js` | criado |
| `backend/server.js` | `app.use('/api/estoque', ...)` |
| teste + docs 03.18 | criados |

Não alterados: porta, writers, PDV, vendas, compras, `EstoqueEmpresaService`.

---

## Testes

01–08.

---

## Regressão

| Suite | Resultado |
|---|---|
| `consulta-administrativa-estoque-empresa.test.js` | 8/8 OK |
| `primeiro-consumidor-leitura-empresa.test.js` (03.17) | 6/6 OK |
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

Não iniciar 03.19. Porta oficial permanece em `produtos`.
