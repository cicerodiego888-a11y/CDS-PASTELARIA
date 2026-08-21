# Relatório — Implementação 02.6
## Baixa Normal de Venda → Porta Pública

**Data:** 2026-08-14 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Arquivos alterados

- `backend/services/vendas/VendaPagamentoService.js` — baixa usa a porta; `empresaId` + `db` no prazo e à vista
- `backend/services/vendas/creditoEstoqueVendaViaPorta.js` — comentário (ponte 02.6)
- `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js` — removeu a guarda “baixa ainda com SQL” (agora 02.6)

## 2. Arquivos criados

- `backend/services/vendas/debitoEstoqueVendaViaPorta.js`
- `tests/estoque/debito-baixa-venda-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_6_BAIXA_VENDA_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_6_RELATORIO.md` (este)

---

## 3. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `debitarEstoqueItemVenda` | **Novo** — `debitarSaldo` F/NF |
| `montarOptsPortaDebitoVenda` | **Novo** — empresa / COMPAT |
| `montarOpcoesBaixaEstoqueVenda` | **Novo** — body / `req.user` / `req` |
| `atualizarSaldoProdutoAposBaixa` | Porta; sem UPDATE saldo |
| `reduzirEstoqueComFEFO` | Propaga `opcoes` |
| `reduzirEstoqueDistribuido` | Propaga `opcoes`; mesmo `db` |
| `criarVenda` | Injeta empresa + `db` (prazo e à vista) |

Distribuição preservada: `item.quantidade_fiscal` / `item.quantidade_nao_fiscal`.

Não alterados: `distribuidorEstoqueVenda`, MIDP, MPFC, Motor Fiscal/Não Fiscal, MTS, MUC, MIIP, Central, TEF, financeiro, cancelamento, devolução, reservas (`reservado_*`).

---

## 4. SQL de saldo removido

De `atualizarSaldoProdutoAposBaixa`:

```sql
UPDATE produtos SET
  saldo_fiscal = saldo_fiscal - ?,
  estoque_atual = (saldo_fiscal - ?) + saldo_nao_fiscal

UPDATE produtos SET
  saldo_nao_fiscal = saldo_nao_fiscal - ?,
  estoque_atual = saldo_fiscal + (saldo_nao_fiscal - ?)
```

Scan na seção de baixa: **nenhuma** escrita direta de saldo.

SELECT de saldo para distribuição permanece (leitura).

---

## 5. Porta utilizada

`estoqueSaldosPublico.debitarSaldo` (`FISCAL` / `NAO_FISCAL`) + `consultarSaldo`.

---

## 6. empresaId

body / `req.user` / `req` → adaptador.  
Ausência → COMPAT. Sem inventar empresa.

---

## 7. Compatibilidade

`COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA` (`MOTIVO_COMPAT_DEBITO_VENDA`).

Reutiliza `extrairEmpresaIdDeReq` da 02.5. Não reutiliza a constante de crédito (fluxo distinto).

---

## 8. Testes

| Suite | Resultado |
|---|---|
| `debito-baixa-venda-porta-publica` | **12/12 OK** |
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
| hotfix consumo exclusivo motor (estoque) | **OK** (`reduzirEstoqueDistribuido` + `quantidade_fiscal`) |

---

## 9. Resultado

Critérios da Sprint atendidos:

- Baixa normal usa `debitarSaldo`
- Venda fiscal / não fiscal / mista
- Distribuição não recalculada
- Sem débito duplicado e sem UPDATE de saldo na baixa
- Fiscal separado de Não Fiscal
- `empresaId` / COMPAT explícita / sem fallback silencioso
- Transação e rollback preservados
- `estoque_atual = SF + SNF`
- Cancelamento/devolução intactos (02.5)
- Nenhuma migration / `estoque_empresa` não criada

---

## 10. Regressões

Nenhuma causada pela 02.6.

Observação pré-existente (fora do escopo): `tests/fiscal/hotfix-consumo-exclusivo-motor.test.js` espera `separarItensDistribuidos(distribuicaoItens)` literal. O working tree já tinha HOTFIX FISCAL-4.0.2 com `separarItensDistribuidos(distribuicaoItens || [])` via helper. **Não** foi alterado nesta Sprint; o teste de estoque da mesma suíte passou.

---

## 11. Limitações

- Sem isolamento físico (`estoque_empresa`).
- COMPAT até JWT/empresas.
- Reservas PDV (`reservado_*`) ainda com SQL direto.
- Porta recusa saldo negativo; distribuição continua sendo o validador pré-baixa.

---

## 12. Próxima etapa

**Reservas PDV** → mutadores restantes de reserva para a porta pública, antes da estrutura física multiempresa.

Não implementada nesta Sprint.
