# Relatório — Implementação 03.11
## estoque_empresa: fundação de schema

**Data:** 2026-08-21 · **Status:** concluída (somente schema)

---

## 1. Schema anterior

Saldos/reservas em `produtos`. `empresas` sem estoque. Sem `estoque_empresa`.

---

## 2. Tabela criada

`estoque_empresa` — produto + empresa + os mesmos 5 campos de saldo/reserva + timestamps.

---

## 3. Campos / unicidade

Campos mínimos da Sprint. `UNIQUE(produto_id, empresa_id)`. FKs no padrão `usuario_empresas`.

---

## 4. Bootstrap

`garantirSchemaEstoqueEmpresa` em `estoqueEmpresaSchema.js`, disparado por `database.js`. Idempotente.

---

## 5. O que NÃO foi migrado

Porta, motores, compras, vendas, CREATE, lotes, Repair, COMPAT, dados de `produtos`. Sem backfill.

---

## 6. Testes executados

`node tests/estoque/estoque-empresa-schema.test.js`

| # | Cenário |
|---|---|
| 01 | Tabela criada |
| 02 | Campos |
| 03 | UNIQUE |
| 04 | Mesmo produto, duas empresas |
| 05 | Bootstrap idempotente |
| 06 | Saldo de produtos não migrado |
| 07 | Fluxos operacionais intactos |
| 08 | Schema produtos compatível |

### Regressão

| Suite | Resultado |
|---|---|
| `estoque-empresa-schema.test.js` | 8/8 OK |
| `create-produto-saldo-inicial-porta-publica.test.js` | 10/10 OK |
| `reserva-repair-porta-publica.test.js` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica.test.js` | 10/10 OK |
| `revert-devolucao-venda-porta-publica.test.js` | 10/10 OK |
| `mts-v1.test.js` | OK |
| `muc-public-contract.test.js` | 20/20 OK |

---

## 7. Arquivos

- `backend/services/estoque/estoqueEmpresaSchema.js` (novo)
- `backend/database.js` — bootstrap
- teste + docs 03.11

Não alterados: portas, motores, fluxos 02.x / 03.5–03.8.

---

## 8. Limitações

Tabela vazia. Porta ainda lê/grava `produtos`. **Não** avançar para migrar `estoqueSaldosPublico` nesta Sprint.
