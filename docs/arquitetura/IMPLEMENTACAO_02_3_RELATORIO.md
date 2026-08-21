# Relatório — Implementação 02.3
## Migração do Crédito de Estoque de Compra para a Porta Pública

**Data:** 2026-08-12 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Arquivos alterados

- `backend/rotas/compras.js` — crédito via porta; UPDATE só metadados; `empresaId` nas opções

## 2. Arquivos criados

- `backend/services/compras/creditoEstoqueCompraViaPorta.js`
- `tests/estoque/credito-compra-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_3_CREDITO_COMPRA_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_3_RELATORIO.md` (este)

---

## 3. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `creditarEstoqueItemCompra` | **Novo** — deltas via `creditarSaldo` |
| `montarOptsPortaCreditoCompra` | **Novo** — empresa ou COMPAT |
| `processarItensCompra` / `continuarItem` | Remove UPDATE de saldo; chama porta |
| `POST /compras` (gravação normal) | Propaga `empresaId` / `usuarioId` |

---

## 4. SQL removido (crédito)

Do fluxo `processarItensCompra`:

```sql
saldo_fiscal = COALESCE(saldo_fiscal, 0) + ?
saldo_nao_fiscal = COALESCE(saldo_nao_fiscal, 0) + ?
estoque_atual = (COALESCE(saldo_fiscal, 0) + ?) + (COALESCE(saldo_nao_fiscal, 0) + ?)
```

**Mantido** no mesmo fluxo: `UPDATE produtos` de preço/NCM/unidade/etc. (sem saldos).

**Ainda existentes (fora do escopo 02.3):**

- Débito em devolução de compra (`UPDATE` saldo −)
- Débito em cancelamento de compra (`UPDATE` saldo −)

---

## 5. Porta utilizada

`estoqueSaldosPublico.creditarSaldo` (`TipoSaldo.FISCAL` | `NAO_FISCAL`)  
+ `consultarSaldo` para retorno.

---

## 6. Como empresaId foi obtido

1. `req.body` / `req.user` → `processarItensCompra` → porta  
2. Senão → `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA`  
3. `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`

CNPJ destinatário **não** convertido (estrutura `empresas` ainda inexistente) — documentado para o futuro.

---

## 7. Compatibilidade

`MOTIVO_COMPAT_CREDITO_COMPRA = 'COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA'`  
Explícita no retorno (`legado`, `motivo_compat`). Sem fallback silencioso.

---

## 8–10. Testes

Criados: `credito-compra-porta-publica.test.js` → **11/11 OK**

| Suite | Resultado |
|---|---|
| `credito-compra-porta-publica` | **11/11 OK** |
| `recalculo-saldos-porta-publica` | **15/15 OK** |
| `ajuste-estoque-porta-publica` | **15/15 OK** |
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| `rc80y-controla-estoque` | **4/4 OK** |

Regressões: nenhuma nestas suites.

---

## 11. Limitações

- Storage ainda em `produtos` (sem isolamento físico).
- COMPAT necessário no ERP atual.
- Cancelamento/devolução de compra ainda com SQL direto.
- Sem cadastro oficial de empresas / conversão CNPJ→empresaId.

---

## 12. Critérios de sucesso

| Critério | Status |
|---|---|
| Crédito pela porta | OK |
| Sem crédito duplicado | OK |
| Sem UPDATE de saldo no crédito | OK |
| F ≠ NF preservado | OK |
| Quantidades iguais à regra atual | OK |
| empresaId / COMPAT explícito | OK |
| Transação / rollback | OK |
| EA = SF + SNF | OK |
| Testes novos/existentes | OK |
| Motores / MTS / MUC / MIIP / Central / TEF intactos | OK |
| Sem estoque_empresa / migration / outros mutadores | OK |

---

## 13. Próxima etapa

**02.4 — Cancelamento / Devolução de Compra** → débito correspondente via `estoqueSaldosPublico`.

Não implementada nesta Sprint.
