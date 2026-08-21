# Relatório — Implementação 02.5
## Cancelamento / Devolução de Venda → Porta Pública

**Data:** 2026-08-14 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Arquivos alterados

- `backend/services/vendas/VendaDevolucaoService.js` — `devolverSaldosDistribuidos` usa a porta; `opcoes` (db / empresaId) propagadas
- `backend/services/vendas/VendaCancelamentoService.js` — PUT e POST passam contexto de empresa ao retorno de estoque

## 2. Arquivos criados

- `backend/services/vendas/creditoEstoqueVendaViaPorta.js`
- `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_5_CANCEL_DEV_VENDA_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_5_RELATORIO.md` (este)

---

## 3. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `creditarEstoqueItemVenda` | **Novo** — `creditarSaldo` F/NF |
| `montarOptsPortaCreditoVenda` | **Novo** — empresa / COMPAT |
| `montarOpcoesRetornoEstoqueVenda` | **Novo** — body / `req.user` / `req` |
| `devolverSaldosDistribuidos` | Porta; sem UPDATE saldo |
| `devolverEstoqueItemVenda` | Propaga `opcoes` |
| `devolverEstoqueItensVenda` | Propaga `opcoes` |
| `devolverEstoqueParcialItem` | Propaga `opcoes` |
| `cancelarVendaPut` / `cancelarVendaPost` | Injeta empresa + `db` |
| `devolverParcial` | Injeta empresa + `db` |

Classificação preservada:

- Cancel: `resolverQuantidadesVendaItem`
- Devolução: `calcularDevolucaoVendaFiscalPrimeiro`

Não alterados: `distribuidorEstoqueVenda`, MIDP, MPFC, Motor Fiscal/Não Fiscal, MTS, MUC, MIIP, Central, TEF, baixa normal.

---

## 4. SQL de saldo removido

De `devolverSaldosDistribuidos`:

```sql
UPDATE produtos SET
  saldo_fiscal = saldo_fiscal + ?,
  saldo_nao_fiscal = saldo_nao_fiscal + ?,
  estoque_atual = (saldo_fiscal + ?) + (saldo_nao_fiscal + ?)
```

Scan pós-impl nos fluxos migrados: **nenhuma** escrita direta de saldo.

`UPDATE produtos_lotes` permanece (restauração de lote, fora do saldo F/NF).

Baixa normal em `VendaPagamentoService` permanece (02.6).

---

## 5. Porta utilizada

`estoqueSaldosPublico.creditarSaldo` (`FISCAL` / `NAO_FISCAL`) + `consultarSaldo`.

---

## 6. empresaId

body / `req.user` / `req` → adaptador.  
Ausência → COMPAT. Sem inventar empresa.

---

## 7. Compatibilidade

`COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA` (`MOTIVO_COMPAT_CREDITO_VENDA`).

---

## 8. Testes

| Suite | Resultado |
|---|---|
| `credito-cancel-dev-venda-porta-publica` | **12/12 OK** |
| `debito-cancel-dev-compra-porta-publica` | **12/12 OK** |
| `credito-compra-porta-publica` | **11/11 OK** |
| `recalculo-saldos-porta-publica` | **15/15 OK** |
| `ajuste-estoque-porta-publica` | **15/15 OK** |
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `rc80y-controla-estoque` | **4/4 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| `muc-public-contract` | **20/20 OK** |

---

## 9. Resultado

Critérios da Sprint atendidos:

- Cancelamento e devolução retornam estoque pela porta
- Sem retorno duplicado
- Sem UPDATE direto de saldo nos fluxos migrados
- Fiscal separado de Não Fiscal
- `empresaId` propagado; COMPAT explícita; sem fallback silencioso
- Transação / rollback preservados
- `estoque_atual = SF + SNF`
- Distribuição da venda intacta
- Baixa normal **não** migrada
- Nenhuma migration / `estoque_empresa` não criada

---

## 10. Regressões

Nenhuma. Motores Fiscal/Não Fiscal, MTS, MUC, MIIP, Central e TEF não foram alterados.

Efeito colateral esperado (sem editar Motor Fiscal): `retornarEstoqueNfeDevolucaoVenda` já chamava `devolverSaldosDistribuidos` e passa a usar a porta com COMPAT.

---

## 11. Limitações

- Sem isolamento físico (`estoque_empresa`).
- COMPAT até JWT/empresas.
- Baixa normal da venda ainda com SQL direto — **02.6**.
- `reverterEstoqueNfeDevolucaoVenda` (débito ao cancelar NF-e de devolução) permanece no Motor Fiscal.

---

## 12. Próxima etapa

**02.6 — Baixa normal de venda** → débito via `estoqueSaldosPublico` + `empresaId`.

Fluxo previsto:

```
Venda
  → Distribuição Fiscal / Não Fiscal
  → Baixa estoque
  → estoqueSaldosPublico
  → empresaId
```

Não implementada nesta Sprint.
