# Implementação 02.2 — Recálculo de Saldos → Porta Pública

**Status:** concluída · **Data:** 2026-08-12  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## 1. Regra anterior

`recalcularSaldosProduto` lia histórico (compras / vendas / devoluções de compra) e gravava:

```sql
UPDATE produtos
SET saldo_fiscal = ?,
    saldo_nao_fiscal = ?,
    estoque_atual = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?
```

sem `empresaId` e fora de `estoqueSaldosPublico`.

---

## 2. Regra encontrada no código (fonte de verdade)

Fórmula **preservada** (extraída para `calcularSaldosAlvoRecalculo`):

```
saldo_fiscal     = max(0, Σ compras_fiscais − Σ vendas_fiscais − Σ devoluções_compra_fiscais)
saldo_nao_fiscal = max(0, Σ compras_nao_fiscais − Σ vendas_nao_fiscais − Σ devoluções_compra_nao_fiscais)
estoque_atual    = saldo_fiscal + saldo_nao_fiscal
```

Detalhes:

| Fonte | Filtro |
|---|---|
| `compras_itens` ∩ `compras` | `status = 'concluida'` (default) |
| `vendas_itens` ∩ `vendas` | `status != 'cancelada'` |
| `compras_devolucoes` ∩ `compras_itens` | proporção fiscal = `qtd_fiscal_item / quantidade` do row resolvido |

**Não entram no recálculo** (comportamento legado preservado):

- ajustes de estoque (`produtos_ajustes_estoque`);
- transferências MTS;
- devoluções de venda;
- reservas (`reservado_*` — **não** são alteradas).

Quantidades F/NF usam `resolverQuantidadesCompraItemPersistido` / `resolverQuantidadesVendaItem` (legado `item_fiscal` / DEFAULT 0).

Nota: o SELECT de devolução ainda traz `ci.quantidade AS qtd_comprada`, mas o loop legado usa `dev.quantidade` (`cd.quantidade`) via o resolver — **mesma** matemática do HEAD; não “corrigida” nesta Sprint.

---

## 3. Mutador antigo

- Arquivo: `backend/services/estoqueFiscalService.js`
- Método: `recalcularSaldosProduto` (+ `recalcularSaldosTodosProdutos`)
- Escrita: `UPDATE produtos` direto

---

## 4. Nova porta utilizada

```
recalcularSaldosProduto
        ↓
calcularSaldosAlvoRecalculo   (somente leitura / memória)
        ↓
aplicarSaldosAlvoViaPorta     (deltas)
        ↓
estoqueSaldosPublico.consultarSaldo / creditarSaldo / debitarSaldo
        ↓
produtos  (storage transitório — SEM estoque_empresa)
```

Estratégia **A**: calcular saldo-alvo e aplicar **delta** pela porta (não há API de “substituir absoluto” necessária).

---

## 5. empresaId

| Fonte | Uso |
|---|---|
| `opcoes.empresaId` / `empresa_id` / contexto | Preferencial |
| Rotas `POST /recalcular-saldos` e `/:id/recalcular-saldos` | body / `req.user` |
| Ausência (ERP / bootstrap `database.js`) | COMPAT explícito |
| `exigirEmpresa: true` | `EMPRESA_OBRIGATORIA` |

**Não** usa empresa 1, CNPJ de `configuracoes` nem fallback silencioso.

---

## 6. Compatibilidade

`MOTIVO_COMPAT_RECALCULO = 'COMPAT_RECALCULO_PRE_MULTIEMPRESA'`

| Consumidor | Classificação | empresaId |
|---|---|---|
| `POST /api/produtos/recalcular-saldos` | E — administrativo | body/user ou COMPAT |
| `POST /api/produtos/:id/recalcular-saldos` | E — administrativo | body/user ou COMPAT |
| `migrarRecalcularSaldosEstoque` (`database.js`) | D — reparação/bootstrap one-shot | callback legado → COMPAT |

Assinaturas mantidas:

- `(db, produtoId, callback)`
- `(db, produtoId, opcoes, callback)`

Retorno inclui `legado` / `motivo_compat` quando aplicável.

---

## 7. Transação

Sem `BEGIN` próprio. Propaga o mesmo `db` do caller para a porta.  
Rollback externo reverte os deltas (testado).

---

## 8. Invariantes

- `estoque_atual = saldo_fiscal + saldo_nao_fiscal` (porta)
- SF e SNF **não** se misturam
- MTS permanece autoridade exclusiva F↔NF
- Reservas não são tocadas pelo recálculo

---

## 9. Idempotência

Segundo `recalcularSaldosProduto` com o mesmo histórico → deltas zero → saldos iguais.

---

## 10. Testes

`tests/estoque/recalculo-saldos-porta-publica.test.js` — 01–13 + COMPAT + fórmula alvo.

---

## 11. Limitações

1. Storage ainda em `produtos` — sem isolamento físico por CNPJ.
2. COMPAT necessário até JWT/empresas.
3. Fórmula **não** reconcilia ajustes/MTS/devolução de venda (legado).
4. Outros mutadores (compra, venda, …) **não** migrados nesta Sprint.

---

## 12. Próxima etapa

**02.3** — Crédito de compra → `estoqueSaldosPublico` + `empresaId`.
