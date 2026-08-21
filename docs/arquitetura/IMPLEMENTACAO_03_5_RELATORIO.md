# Relatório — Implementação 03.5
## Revert de estoque da NF-e de devolução de venda → Porta Pública

**Data:** 2026-08-15 · **Status:** concluída (critérios da Sprint)

---

## 1. Verificação prévia

A Sprint **não** havia sido feita. Evidências:

- Sem `docs/arquitetura/IMPLEMENTACAO_03_5_*`
- Sem `tests/estoque/revert-devolucao-venda-porta-publica.test.js`
- `reverterEstoqueNfeDevolucaoVenda` ainda com `UPDATE produtos` de `saldo_fiscal` / `estoque_atual`

---

## 2. Arquivos alterados

- `backend/services/fiscal/estoqueNfeDevolucaoVenda.js` — revert pela porta; helper F/NF compartilhado com o retorno
- `backend/services/fiscal/controleSaldoDevolucaoVenda.js` — propaga `empresaId` / `db` / `usuarioId` ao revert

## 3. Arquivos criados

- `tests/estoque/revert-devolucao-venda-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_5_REVERT_DEVOLUCAO_VENDA.md`
- `docs/arquitetura/IMPLEMENTACAO_03_5_RELATORIO.md` (este)

Não alterados: Motor Fiscal de emissão, Motor Não Fiscal, MTS, MUC, MIIP, Central, TEF, Motor Comercial, reservas, CREATE produto, lotes, `estoque_empresa`.

---

## 4. Mutador / SQL anterior

`reverterEstoqueNfeDevolucaoVenda` em `estoqueNfeDevolucaoVenda.js`.

```sql
UPDATE produtos SET
  saldo_fiscal = CASE WHEN SF - q < 0 THEN 0 ELSE SF - q END,
  estoque_atual = CASE WHEN EA - q < 0 THEN 0 ELSE EA - q END
WHERE id = ?
```

Quantidade: `item.quantidade` (tudo no fiscal). Sem `empresaId`. Sem transação no caller.

---

## 5. Porta utilizada

`estoqueSaldosPublico.debitarSaldo` (`FISCAL` / `NAO_FISCAL`) + `consultarSaldo`.

O texto da Sprint mencionava `creditarSaldo()` (template da 02.5). O mutador
**remove** o que a autorização creditou. `creditarSaldo` neste ponto seria
crédito duplicado. A porta continua única; o sinal é débito.

---

## 6. Classificação F/NF

Mesma fórmula de `retornarEstoqueNfeDevolucaoVenda`:
`resolverQuantidadesVendaItem` + fator da quantidade da NF-e.
Não recalcula distribuição.

---

## 7. empresaId / COMPAT

1. opções explícitas  
2. `contexto` / `ctx`  
3. `COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA`  
4. `exigirEmpresa` → `EMPRESA_OBRIGATORIA`

Sem empresa 1 / CNPJ / fallback silencioso.

---

## 8. Transação

Mesmo `db` injetado. Sem `BEGIN` próprio. Rollback externo testado.

---

## 9. Testes 03.5

`node tests/estoque/revert-devolucao-venda-porta-publica.test.js` → **10/10 OK**

| # | Cenário |
|---|---|
| 01 | Devolução fiscal credita SF; revert debita SF |
| 02 | Devolução não fiscal credita SNF; revert debita SNF |
| 03 | Mista mantém separação |
| 04 | `estoque_atual = SF + SNF`; reservas intactas |
| 05 | Sem crédito/débito duplicado |
| 06 | `empresaId` propagado |
| 07 | COMPAT explícita; sem fallback |
| 08 | Rollback restaura saldo |
| 09 | SQL direto de saldo removido do fluxo |
| 10 | Motores / MTS / MUC intactos; sem porta nova |

### Regressão

| Suíte | Resultado |
|---|---|
| 03.5 revert NF-e devolução venda | 10/10 |
| 03.1 cadastro | 17/17 |
| 03.2 contexto | 11/11 |
| 03.3 vínculo | 16/16 |
| 03.4 obrigatório | 10/10 |
| 02.1 ajuste | 15/15 |
| 02.2 recálculo | 15/15 |
| 02.3 crédito compra | 11/11 |
| 02.4 débito compra | 12/12 |
| 02.5 crédito venda | 12/12 |
| 02.6 débito venda | 12/12 |
| 02.7 reservas PDV | 11/11 |
| Porta pública | 17/17 |
| MTS | homologado |
| MUC contrato | 20/20 |
| Motor Comercial RC3.16.1 | homologado |

---

## 10. Critérios

| Critério | Status |
|---|---|
| `reverterEstoqueNfeDevolucaoVenda` identificado | sim |
| UPDATE direto de saldo removido desse fluxo | sim |
| Crédito da autorização / débito do revert pela porta | sim |
| Fiscal / Não Fiscal / mista preservados | sim |
| `empresaId` quando disponível | sim |
| COMPAT explícita | sim |
| Sem fallback silencioso | sim |
| Transação / rollback | sim |
| Sem crédito duplicado | sim |
| `estoque_atual = SF + SNF` | sim |
| Reservas não alteradas | sim |
| Motores não alterados | sim |
| `estoque_empresa` não criada | sim |

---

## 11. Limitações

- Sem isolamento físico (`estoque_empresa`).
- COMPAT até o cancelamento NF-e receber contexto.
- Porta não faz floor em 0 (recusa saldo negativo).
- Escritores seguintes fora do escopo: `consumirReservasPedidoNaVenda`, `ReservaRepairService`, CREATE produto, lotes.

---

## 12. Próxima sprint

**03.6** — migrar `consumirReservasPedidoNaVenda`.
