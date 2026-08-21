# Relatório — Implementação 03.6
## Consumo de reserva de pedido → Porta Pública

**Data:** 2026-08-16 · **Status:** concluída (critérios da Sprint)

---

## 1. Verificação prévia

A Sprint **não** estava no HEAD. `consumirReservasPedidoNaVenda` ainda fazia:

```sql
UPDATE produtos SET reservado_fiscal = CASE WHEN RF - q < 0 THEN 0 ELSE RF - q END,
updated_at = CURRENT_TIMESTAMP
```

`ReservaRepairService` também escreve `reservado_fiscal`, mas o consumo da
ponte **não** depende dele. Regra de parada: **não aplicável**. Repair = 03.7.

---

## 2. Arquivos alterados

- `backend/services/estoque/pedidoReservaPonteNucleo.js` — consumo pela porta
- `backend/services/vendas/VendaPagamentoService.js` — propaga `empresaId` / `usuarioId` / `req`
- `backend/services/faturamento/FaturamentoService.js` — propaga `db` / `empresaId` / `req`

No Faturamento, o pós-núcleo já chamava `consumirReservasDaVenda` (PDV 02.7)
sem opts; passou a enviar `montarOptsPortaReservaPdv(reqHttp, db)`. Não altera
o modelo PDV — só propaga o contexto que a 02.7 já espera.

## 3. Arquivos criados

- `tests/estoque/consumo-reserva-pedido-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_6_CONSUMO_RESERVA_PEDIDO.md`
- `docs/arquitetura/IMPLEMENTACAO_03_6_RELATORIO.md` (este)

Não alterados: Motor Fiscal/Não Fiscal, MTS, MUC, MIIP, Central, TEF, Motor Comercial,
`ReservaRepairService`, CREATE produto, lotes, baixa 02.6, reservas PDV 02.7,
`estoque_empresa`.

---

## 4. Mutador / SQL anterior

`consumirReservasPedidoNaVenda` em `pedidoReservaPonteNucleo.js`.

Quantidade: `pedido_estoque_reservas.quantidade_fiscal`. Só fiscal.

---

## 5. Porta utilizada

`reservasPublico.liberarQuantidadeReservada` (`TipoSaldo.FISCAL`).

Não usa `debitarSaldo` / `creditarSaldo`. Saldo físico intacto nesta etapa.

---

## 6. empresaId / COMPAT

`COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA` quando o caller não envia empresa.

Callers que ainda podem entrar em COMPAT:

- `VendaPagamentoService` se o request da venda não tiver empresa
- `FaturamentoService` se `reqHttp` não tiver empresa
- testes RC4.1.2 (`{ db }` apenas)

---

## 7. Transação

Mesmo `db`. Sem `BEGIN` próprio. Rollback testado.

---

## 8. Testes 03.6

`node tests/estoque/consumo-reserva-pedido-porta-publica.test.js`

| # | Cenário |
|---|---|
| 01 | Consumo de reserva fiscal |
| 02 | `reservado_fiscal` diminui |
| 03 | Saldo físico não muda |
| 04 | `empresaId` propagado |
| 05 | COMPAT explícita |
| 06 | Rollback restaura reservado |
| 07 | Consumo não duplica |
| 08 | SQL direto de reservado removido |
| 09 | Baixa física permanece 02.6 |
| 10 | Motores / PDV / Repair 03.7 intactos |

### Regressão

| Suite | Resultado |
|---|---|
| `consumo-reserva-pedido-porta-publica.test.js` | **10/10 OK** |
| `reservas-pdv-porta-publica.test.js` | **11/11 OK** |
| `debito-baixa-venda-porta-publica.test.js` | **12/12 OK** |
| `mts-v1.test.js` | **9/9 OK** (homologado) |
| `muc-public-contract.test.js` | **20/20 OK** |

---

## 9. Critérios

| Critério | Status |
|---|---|
| Mutador identificado | sim |
| UPDATE direto de reservado removido | sim |
| Porta `reservasPublico` | sim |
| Saldo físico não alterado pelo consumo | sim |
| `reservado_fiscal` preservado | sim |
| `reservado_nao_fiscal` não inventado | sim |
| Quantidade original | sim |
| `empresaId` / COMPAT / sem fallback | sim |
| Transação / rollback | sim |
| Sem consumo duplicado | sim |
| Baixa 02.6 e PDV 02.7 intactos | sim |
| `ReservaRepairService` não migrado | sim |
| `estoque_empresa` não criada | sim |

---

## 10. Limitações

- Sem isolamento físico.
- COMPAT até o faturamento/venda enviarem empresa sempre.
- Tracking do pedido continua só fiscal.
- Porta não atualiza `produtos.updated_at`.
- **03.7** — `ReservaRepairService` ainda com SQL de `reservado_fiscal`.

---

## 11. Próxima sprint

**03.7** — migrar `ReservaRepairService`.
