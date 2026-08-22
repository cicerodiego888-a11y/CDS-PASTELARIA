# Relatório — Implementação 03.13
## Primeiro dual-write controlado (CREATE produto)

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Auditoria

Candidato prioritário: CREATE 03.8 — `aplicarSaldoInicialCreateProduto`.

Compra/venda/PDV/reserva descartados pelo escopo.

Porta pública permanece em `produtos`. Camada 03.12 já existia (`consultar` / `criar`); esta Sprint adicionou `aplicarEfeitoSaldo` nela (único UPDATE autorizado).

---

## 2. Fluxo escolhido

CREATE produto / saldo inicial.

Motivo: pequeno, explícito, db injetável, empresaId já propagado, COMPAT já definido, fora dos motores de movimento.

---

## 3. Arquivos

| Arquivo | Ação |
|---|---|
| `backend/services/estoque/EstoqueEmpresaService.js` | `aplicarEfeitoSaldo` (zero + efeito) |
| `backend/services/ajusteEstoqueService.js` | dual-write só no CREATE 03.8 |
| `tests/estoque/dual-write-estoque-empresa-03-13.test.js` | criado |
| docs 03.13 | criados |

Não alterados: porta, compras, vendas, PDV, reservas, motores, `produtos.js` (já chamava o helper).

---

## 4. Antes / depois

Operação continua: porta → `produtos`.  
Espelho: `estoque_empresa` somente neste fluxo, com `empresaId`.

---

## 5. empresaId / COMPAT

1. empresaId da operação / contexto  
2. senão COMPAT `COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA` — porta em `produtos`, **sem** espelho  
3. sem empresa 1 / CNPJ

---

## 6. Transação

Mesmo `db`. Sem BEGIN próprio. Rollback externo desfaz as duas escritas.

---

## 7. Testes

01–10 em `dual-write-estoque-empresa-03-13.test.js`.

---

## 8. Regressão

| Suite | Resultado |
|---|---|
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

## 9. Limitações

- Dual-write só no CREATE com saldo inicial e `empresaId`.
- Tabela pode continuar vazia no COMPAT e nos demais fluxos.
- Leitura oficial ainda é `produtos`.
- Sem backfill.

---

## 10. Próximo passo recomendado

Não iniciar nesta entrega. Quando autorizado: próximo escritor pequeno (não compra/venda/PDV) ou backfill explícito — ainda sem desligar `produtos`.
