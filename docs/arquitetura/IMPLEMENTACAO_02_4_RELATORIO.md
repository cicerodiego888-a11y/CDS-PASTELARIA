# Relatório — Implementação 02.4
## Cancelamento / Devolução de Compra → Porta Pública

**Data:** 2026-08-12 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Arquivos alterados

- `backend/rotas/compras.js` — cancelamento e devolução usam `debitarEstoqueItemCompra`
- `backend/services/compras/creditoEstoqueCompraViaPorta.js` — comentário (ponte 02.4)

## 2. Arquivos criados

- `backend/services/compras/debitoEstoqueCompraViaPorta.js`
- `tests/estoque/debito-cancel-dev-compra-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_4_CANCEL_DEV_COMPRA_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_4_RELATORIO.md` (este)

---

## 3. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `debitarEstoqueItemCompra` | **Novo** — `debitarSaldo` F/NF |
| `montarOptsPortaDebitoCompra` | **Novo** — empresa / COMPAT |
| `baixarEstoque` (cancelar) | Porta; sem UPDATE saldo |
| Devolução pós-`compras_devolucoes` | Porta; sem UPDATE saldo |

Classificação preservada:

- Cancel: `resolverQuantidadesCompraItemPersistido`
- Devolução: `calcularDevolucaoCompraFiscalPrimeiro`

---

## 4. SQL de saldo removido

Dos fluxos cancelar e devolver:

```sql
UPDATE produtos SET
  saldo_fiscal = saldo_fiscal - ?,
  saldo_nao_fiscal = saldo_nao_fiscal - ?,
  estoque_atual = (saldo_fiscal - ?) + (saldo_nao_fiscal - ?)
```

Scan pós-impl nas seções migradas: **nenhuma** escrita direta de saldo.

`UPDATE produtos` de metadados no crédito (02.3) permanece (sem saldos).

---

## 5. Porta utilizada

`estoqueSaldosPublico.debitarSaldo` (`FISCAL` / `NAO_FISCAL`) + `consultarSaldo`.

---

## 6. empresaId

body / `req.user` → adaptador.  
Ausência → COMPAT. Sem inventar empresa.

---

## 7. Compatibilidade

`COMPAT_DEBITO_COMPRA_PRE_MULTIEMPRESA` (`MOTIVO_COMPAT_DEBITO_COMPRA`).

---

## 8–9. Testes / Resultado

| Suite | Resultado |
|---|---|
| `debito-cancel-dev-compra-porta-publica` | **12/12 OK** |
| `credito-compra-porta-publica` | **11/11 OK** |
| `recalculo-saldos-porta-publica` | **15/15 OK** |
| `ajuste-estoque-porta-publica` | **15/15 OK** |
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| `rc80y-controla-estoque` | **4/4 OK** |

Regressões: nenhuma.

---

## 10. Limitações

- Sem isolamento físico (`estoque_empresa`).
- COMPAT até JWT/empresas.
- Fluxos de **venda** (baixa / cancel / devolução) ainda com SQL direto — 02.5.

---

## 11. Próxima etapa

**02.5 — Cancelamento / Devolução de Venda** → retorno de estoque via `estoqueSaldosPublico`.

Não implementada nesta Sprint.
