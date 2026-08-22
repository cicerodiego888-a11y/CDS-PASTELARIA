# Relatório — Implementação 03.15
## Leitura controlada de estoque_empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Auditoria

Pontos de consulta operacional (PDV, disponibilidade, baixa, reserva, porta pública) descartados.  
`EstoqueEmpresaService.consultarSaldo` já lia `estoque_empresa` sem fallback. Não havia helper técnico nomeado nem endpoint interno seguro.

---

## 2. Ponto de leitura

`consultarSaldoTecnico` em `backend/services/estoque/EstoqueEmpresaService.js`.  
Somente `consultarSaldo`. Sem endpoint público.

---

## 3. Arquivos

| Arquivo | Ação |
|---|---|
| `backend/services/estoque/EstoqueEmpresaService.js` | `consultarSaldoTecnico` |
| `tests/estoque/leitura-estoque-empresa-03-15.test.js` | criado |
| docs 03.15 | criados |

Não alterados: porta, dual-write, backfill, CREATE, compra, venda, PDV, motores.

---

## 4. Comportamento

`{ produtoId, empresaId, db }` → registro ou `null`. Sem criar, sem fallback, sem COMPAT. `empresaId` obrigatório.

---

## 5. Testes

01–10 em `leitura-estoque-empresa-03-15.test.js`.

---

## 6. Regressão

| Suite | Resultado |
|---|---|
| `leitura-estoque-empresa-03-15.test.js` | 10/10 OK |
| `backfill-estoque-empresa-03-14.test.js` | 12/12 OK |
| `dual-write-estoque-empresa-03-13.test.js` | 10/10 OK |
| `estoque-empresa-service-03-12.test.js` | 8/8 OK |
| `estoque-empresa-schema.test.js` (03.11) | 8/8 OK |
| `create-produto-saldo-inicial-porta-publica.test.js` (03.8) | 10/10 OK |
| `reserva-repair-porta-publica.test.js` (03.7) | 10/10 OK |
| `consumo-reserva-pedido-porta-publica.test.js` (03.6) | 10/10 OK |
| `revert-devolucao-venda-porta-publica.test.js` (03.5) | 10/10 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `muc-public-contract.test.js` | 20/20 OK |

---

## 7. Limitações

Leitura só técnica. Porta oficial ainda é `produtos`. Nenhum fluxo operacional usa este helper.

---

## 8. Próximo passo recomendado

Não iniciar nesta entrega. Quando autorizado: próximo dual-write pequeno — ainda sem migrar a porta pública.
