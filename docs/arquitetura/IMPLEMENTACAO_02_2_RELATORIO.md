# Relatório — Implementação 02.2
## Migração do Recálculo de Saldos para a Porta Pública

**Data:** 2026-08-12 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Resumo

`recalcularSaldosProduto` deixou de fazer `UPDATE produtos` de saldo e passou a calcular o alvo (fórmula histórica intacta) e aplicar **deltas** via `estoqueSaldosPublico`. Storage permanece em `produtos`. Nenhum outro mutador migrado.

---

## 2. Arquivos alterados

- `backend/services/estoqueFiscalService.js`
- `backend/rotas/produtos.js` (propaga `empresaId` nas rotas de recálculo)

## 3. Arquivos criados

- `tests/estoque/recalculo-saldos-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_2_RECALCULO_SALDOS_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_2_RELATORIO.md` (este)

---

## 4. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `calcularSaldosAlvoRecalculo` | **Novo** — fórmula extraída (somente cálculo) |
| `aplicarSaldosAlvoViaPorta` | **Novo** — deltas via porta |
| `montarOptsPortaRecalculo` | **Novo** — empresa ou COMPAT |
| `recalcularSaldosProduto` | Assinatura `(db,id,cb)` e `(db,id,opcoes,cb)`; sem UPDATE |
| `recalcularSaldosTodosProdutos` | Propaga `opcoes` |
| Rotas `POST .../recalcular-saldos` | Passam `empresaId` / `usuarioId` |

---

## 5. SQL removido

Em `estoqueFiscalService.js`:

```sql
UPDATE produtos
SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?, updated_at = ...
```

**Removido.** Scan pós-impl: **nenhum** `UPDATE produtos` no arquivo.

---

## 6. SQL de leitura mantido

- `SELECT id FROM produtos`
- `SELECT ... FROM compras_itens JOIN compras` (concluídas)
- `SELECT ... FROM vendas_itens JOIN vendas` (não canceladas)
- `SELECT ... FROM compras_devolucoes JOIN compras_itens`

---

## 7. Porta utilizada

`backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`  
(`consultarSaldo`, `creditarSaldo`, `debitarSaldo`)

---

## 8. Como empresaId foi obtido

1. `opcoes.empresaId` / body / `req.user` nas rotas  
2. Senão → COMPAT `COMPAT_RECALCULO_PRE_MULTIEMPRESA`  
3. Com `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`  
4. Bootstrap `migrarRecalcularSaldosEstoque` continua `(db, cb)` → COMPAT

---

## 9. Compatibilidade utilizada

| Ponto | Motivo |
|---|---|
| Rotas ERP sem JWT empresa | Pré-multiempresa |
| Migração one-shot em `database.js` | Bootstrap sem contexto empresa |

Constante: `MOTIVO_COMPAT_RECALCULO`. Retorno com `legado` / `motivo_compat`.

---

## 10. Transação

Sem BEGIN próprio. Mesmo `db` do caller → porta.  
**TESTE 08**: BEGIN → recalc → ROLLBACK restaura saldo pré-recalc.

---

## 11. Idempotência

**TESTE 09**: dois recálculos consecutivos → mesmos SF/SNF/EA.

---

## 12–14. Testes

Criados: `tests/estoque/recalculo-saldos-porta-publica.test.js` (01–13 + COMPAT + fórmula).

| Suite | Resultado |
|---|---|
| `recalculo-saldos-porta-publica` | **15/15 OK** |
| `ajuste-estoque-porta-publica` | **15/15 OK** |
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| `rc80y-controla-estoque` | **4/4 OK** |

Regressões: nenhuma nestas suites.

---

## 15. Diff (escopo)

**Desta Sprint:**

- `estoqueFiscalService.js` — migração completa do recálculo
- `produtos.js` — trechos das rotas `recalcular-saldos` (`empresaId` + opcoes)
- testes + docs 02.2

**Nota:** o working tree de `produtos.js` já continha outras mudanças pré-existentes (diff agregado vs HEAD grande, inclusive da 02.1). Fora do arquivo de serviço, apenas os trechos de recálculo são da 02.2.

Não há `estoque_empresa`, migration de tabela, nem migração de mutadores de compra/venda.

---

## 16. Limitações

- Sem isolamento físico por CNPJ.
- COMPAT ainda necessário no ERP/bootstrap.
- Fórmula legado não inclui ajustes/MTS/devolução de venda.
- `qtd_comprada` no SELECT de devolução continua não usada (igual HEAD).

---

## 17. Critérios de sucesso

| Critério | Status |
|---|---|
| Regra atual identificada e preservada | OK |
| Recálculo pela porta pública | OK |
| Sem UPDATE direto de saldo no recálculo | OK |
| empresaId propagado quando disponível | OK |
| Sem fallback silencioso | OK |
| COMPAT explícito | OK |
| SF separado de SNF | OK |
| EA = SF + SNF | OK |
| Reservas intocadas | OK |
| Transação / rollback | OK |
| Idempotência | OK |
| Testes novos / existentes | OK |
| Motores / MTS / MUC / MIIP / Central / TEF intactos | OK (não alterados) |
| Sem estoque_empresa / migration / outros mutadores | OK |

---

## 18. Próxima Sprint

**02.3 — Crédito de compra**

```
NF-e → Compra → Produto → Crédito → estoqueSaldosPublico → empresaId → storage
```

Não implementada nesta Sprint.
