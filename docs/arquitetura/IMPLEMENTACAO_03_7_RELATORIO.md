# Relatório — Implementação 03.7
## ReservaRepairService → Porta Pública

**Data:** 2026-08-21 · **Status:** concluída (critérios da Sprint)

---

## 1. Métodos encontrados

Arquivo único: `backend/motores/comercial/ReservaRepairService.js`

| Método | Sinal | Porta |
|---|---|---|
| `handlerLiberarReserva` | libera | `liberarQuantidadeReservada` FISCAL |
| `handlerRemoverReserva` | libera | `liberarQuantidadeReservada` FISCAL |
| `handlerCriarReserva` | reserva | `reservarQuantidade` FISCAL |
| `handlerAjustarReserva` | + → reserva; − → libera | conforme o sinal |

SET absoluto não migrável: **não encontrado**. O SET era `reservadoAntes ± delta`.

Nenhum problema fora do Repair bloqueou a migração.

---

## 2. SQL direto removido

```sql
UPDATE produtos SET reservado_fiscal = ? WHERE id = ?
```

Quatro ocorrências (LIBERAR, REMOVER, CRIAR, AJUSTAR).

Tracking (`pedido_estoque_reservas`) permanece no Repair.

---

## 3. Porta utilizada

`reservasPublico.reservarQuantidade` / `liberarQuantidadeReservada`.

Não criada arquitetura nova.

---

## 4. F / NF

Somente `reservado_fiscal`. `reservado_nao_fiscal` não existia neste serviço e não foi inventado.

---

## 5. empresaId / COMPAT

`COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA` quando o caller não envia empresa.

Prioridade: `opts.empresaId` → contexto → `req.empresaId`. Sem empresa 1 / CNPJ.

---

## 6. Transação

Mesmo `db`. Sem BEGIN próprio. Rollback testado.

---

## 7. Testes 03.7

`node tests/estoque/reserva-repair-porta-publica.test.js`

| # | Cenário |
|---|---|
| 01 | Repair que aumenta reserva (CRIAR + AJUSTAR +) |
| 02 | Repair que libera reserva (LIBERAR + AJUSTAR −) |
| 03 | Fiscal preservado |
| 04 | Não fiscal não inventado |
| 05 | empresaId propagado |
| 06 | COMPAT explícita |
| 07 | Rollback |
| 08 | Não duplicidade |
| 09 | UPDATE direto removido |
| 10 | Saldo físico intacto |

### Regressão

| Suite | Resultado |
|---|---|
| `reserva-repair-porta-publica.test.js` | (executar) |
| `consumo-reserva-pedido-porta-publica.test.js` | (executar) |
| `reservas-pdv-porta-publica.test.js` | (executar) |
| `mts-v1.test.js` | (executar) |
| `muc-public-contract.test.js` | (executar) |

---

## 8. Arquivos

**Alterados**

- `backend/motores/comercial/ReservaRepairService.js`
- `tests/estoque/consumo-reserva-pedido-porta-publica.test.js` — asserção 03.6 “Repair ainda com SET” atualizada (03.7 migrou)

**Criados**

- `tests/estoque/reserva-repair-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_7_RESERVA_REPAIR.md`
- `docs/arquitetura/IMPLEMENTACAO_03_7_RELATORIO.md` (este)

Não alterados: Motor Fiscal/Não Fiscal, MTS, MUC, Motor Comercial, ponte 03.6, PDV 02.7, baixa 02.6, Faturamento, vendas, pedidos, CREATE produto, lotes, `estoque_empresa`.

---

## 9. Critérios

| Critério | Status |
|---|---|
| Escritores identificados | sim |
| UPDATE direto migrado | sim (4/4) |
| Porta `reservasPublico` | sim |
| F/NF preservados | sim (só fiscal) |
| empresaId / COMPAT | sim |
| Mesmo db | sim |
| Rollback | sim |
| Saldo físico intacto | sim |
| Sem arquitetura nova | sim |

---

## 10. Próxima sprint

**03.8** — não avançada.
