# Implementação 02.4 — Cancelamento / Devolução de Compra → Porta Pública

**Status:** concluída · **Data:** 2026-08-12  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## Fluxo anterior

### Cancelamento (`POST /compras/:id/cancelar`)

```
BEGIN
  → itens da compra
  → resolverQuantidadesCompraItemPersistido
  → UPDATE produtos SET saldo_fiscal -=, saldo_nao_fiscal -=, estoque_atual = ...
  → cancela financeiro / compra
COMMIT
```

### Devolução (`POST /compras/:id/devolver`)

```
BEGIN
  → INSERT compras_devolucoes
  → calcularDevolucaoCompraFiscalPrimeiro
  → UPDATE produtos SET saldo_fiscal -=, saldo_nao_fiscal -=, estoque_atual = ...
  → financeiro crédito + status compra
COMMIT
```

Mutadores: `backend/rotas/compras.js` — `baixarEstoque` (cancel) e callback pós-insert (devolução).

---

## Fluxo novo

```
Cancelamento / Devolução
        ↓
classificação F/NF (regras existentes — intactas)
        ↓
debitarEstoqueItemCompra
        ↓
estoqueSaldosPublico.debitarSaldo
        ↓
produtos  (storage transitório)
```

- Cancelamento: quantidades de `resolverQuantidadesCompraItemPersistido`
- Devolução: split de `calcularDevolucaoCompraFiscalPrimeiro`
- `estoque_atual` mantido pela porta (`SF + SNF`)
- Sem `UPDATE` de saldo nos dois fluxos

---

## empresaId

| Fonte | Uso |
|---|---|
| body / `req.user` | Preferencial |
| Ausência | `COMPAT_DEBITO_COMPRA_PRE_MULTIEMPRESA` |
| `exigirEmpresa: true` | `EMPRESA_OBRIGATORIA` |

Sem fallback silencioso / empresa 1 / CNPJ inventado.

---

## Compatibilidade

`MOTIVO_COMPAT_DEBITO_COMPRA = 'COMPAT_DEBITO_COMPRA_PRE_MULTIEMPRESA'`

Usada em cancelamento e devolução quando o ERP ainda não envia empresa no JWT.

---

## Transação

`BEGIN IMMEDIATE` das rotas preservado. Débito usa o mesmo `db`. Rollback externo reverte o débito (testado).

---

## Sem débito duplicado

Exatamente **duas** chamadas a `debitarEstoqueItemCompra` em `compras.js` (cancel + devolução).  
Nenhum `UPDATE ... saldo_*` nessas seções.

---

## Testes

`tests/estoque/debito-cancel-dev-compra-porta-publica.test.js` — 01–12.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT necessário até JWT/empresas.
3. Venda / cancel / devolução de venda **não** migrados (02.5).
4. Financeiro de cancel/devolução permanece como estava (fora do escopo de saldo).

---

## Próxima etapa

**02.5** — Cancelamento / Devolução de **Venda** → retorno de estoque via porta.
