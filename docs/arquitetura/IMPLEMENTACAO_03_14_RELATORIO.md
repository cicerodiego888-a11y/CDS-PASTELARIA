# Relatório — Implementação 03.14
## Backfill controlado de estoque_empresa

**Data:** 2026-08-21 · **Status:** concluída

---

## 1. Auditoria

`produtos` e `estoque_empresa` compartilham: SF, SNF, EA, RF, RNF.  
Relação: `UNIQUE(produto_id, empresa_id)`.  
Saldo em `produtos` é global/legado — não distribuir entre empresas.  
Bootstrap 03.11 só cria tabela; dual-write 03.13 só no CREATE com `empresaId`.

---

## 2. Comportamento

`executarBackfillEmpresa({ empresaId }, { db })` percorre produtos e cria registros **ausentes** com snapshot.  
Uma empresa por vez. Manual. Não altera `produtos`. Não sobrescreve existente.

---

## 3. Arquivos

| Arquivo | Ação |
|---|---|
| `backend/services/estoque/EstoqueEmpresaBackfillService.js` | criado |
| `tests/estoque/backfill-estoque-empresa-03-14.test.js` | criado |
| docs 03.14 | criados |

Não alterados: porta, dual-write 03.13, `database.js`, CREATE, compra, venda, PDV, motores.

---

## 4. empresaId

Obrigatório. Empresa deve existir. Sem COMPAT / empresa 1 / CNPJ / padrão.

---

## 5. Idempotência

Criar se ausente. Não sobrescrever. Não somar na 2ª execução.

---

## 6. Transação

`db` injetável. Sem BEGIN próprio. Rollback externo limpa o parcial.

---

## 7. Testes

01–12 em `backfill-estoque-empresa-03-14.test.js`.

---

## 8. Regressão

| Suite | Resultado |
|---|---|
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

## 9. Limitações

- Não popula todas as empresas.
- Pode duplicar o **mesmo** saldo legado se o operador rodar para A e depois para B (cópia explícita, não distribuição automática).
- `produtos` continua storage oficial.
- Leitura operacional inalterada.

---

## 10. Próximo passo recomendado

Não iniciar nesta entrega. Quando autorizado: próximo dual-write pequeno, ainda sem desligar `produtos` nem ler `estoque_empresa` na porta.
