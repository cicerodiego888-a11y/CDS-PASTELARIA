# Relatório — Implementação 02.7
## Reservas PDV → Porta Pública

**Data:** 2026-08-14 · **Status:** APROVADA (critérios da Sprint)

---

## 1. Arquivos alterados

- `backend/services/fiscalNaoFiscal/reservasPublico.js` — extensão mínima + SQL interno unificado
- `backend/services/fiscalNaoFiscal/index.js` — exporta novos métodos
- `backend/services/estoque/EstoqueReservaService.js` — criação/liberação via porta
- `backend/services/estoque/EstoqueConsumoReserva.js` — libera `reservado_*` via porta (baixa intacta)
- `backend/services/entrega/CriarVendaEntregaService.js` — propaga `empresaId`
- `backend/services/entrega/MotorFinalizacaoVenda.js` — propaga opts da porta
- `backend/services/faturamento/FaturamentoService.js` — propaga opts da porta

## 2. Arquivos criados

- `tests/estoque/reservas-pdv-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_02_7_RESERVAS_PDV_PORTA_PUBLICA.md`
- `docs/arquitetura/IMPLEMENTACAO_02_7_RELATORIO.md` (este)

---

## 3. Métodos alterados / novos

| Método | Mudança |
|---|---|
| `_aplicarDeltaReservado` | **Novo** — único UPDATE de `reservado_*` na porta |
| `reservarQuantidade` | **Novo** — incremento sem `pedidoId` |
| `liberarQuantidadeReservada` | **Novo** — decremento (piso 0) |
| `ajustarReservado` | **Novo** — fachada com contexto de empresa |
| `criarReservaFiscal` / `NF` | Reusa `_aplicarDeltaReservado` |
| `liberarReservasPedido` | Reusa `_aplicarDeltaReservado` |
| `reservarItem` | Porta + INSERT `venda_estoque_reservas` |
| `liberarReservasDaVenda` | Porta + status CANCELADA |
| `consumirReservasDaVenda` | Porta no reservado; baixa 02.6 intacta |

---

## 4. SQL de reserva removido (fluxos PDV)

De `EstoqueReservaService` / `EstoqueConsumoReserva`:

```sql
UPDATE produtos SET
  reservado_fiscal = COALESCE(reservado_fiscal, 0) + ?,
  reservado_nao_fiscal = COALESCE(reservado_nao_fiscal, 0) + ?

UPDATE produtos SET
  reservado_fiscal = CASE WHEN ... - ? < 0 THEN 0 ELSE ... END,
  reservado_nao_fiscal = CASE WHEN ... END
```

Scan nos fluxos migrados: **nenhuma** escrita direta de `reservado_*`.

A porta permanece a única escritora. SELECT continua permitido.

---

## 5. Porta utilizada

`reservasPublico.reservarQuantidade` / `liberarQuantidadeReservada`  
(`FISCAL` / `NAO_FISCAL`). **Não** usa `debitarSaldo`.

---

## 6. empresaId

body / `req.user` / `req` → `montarOptsPortaReservaPdv`. Sem inventar empresa.

---

## 7. Compatibilidade

`COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA` (`MOTIVO_COMPAT_RESERVA_PDV`).

---

## 8. Testes

| Suite | Resultado |
|---|---|
| `reservas-pdv-porta-publica` | **11/11 OK** |
| `porta-publica-saldos-multiempresa` | **17/17 OK** |
| `sprint02-reserva-entrega` | **12/12 OK** |
| `sprint03-prestacao` | **12/12 OK** |
| `debito-baixa-venda-porta-publica` | **12/12 OK** |
| `credito-cancel-dev-venda-porta-publica` | **12/12 OK** |
| `debito-cancel-dev-compra-porta-publica` | **12/12 OK** |
| `credito-compra-porta-publica` | **11/11 OK** |
| `recalculo-saldos-porta-publica` | **15/15 OK** |
| `ajuste-estoque-porta-publica` | **15/15 OK** |
| `mts-v1` | **OK** |
| `rc3161-pedido-motor-comercial-mts` | **OK** |
| `muc-public-contract` | **20/20 OK** |

---

## 9. Resultado

- Criação e liberação PDV pela porta
- Reserva não altera saldo físico
- Disponibilidade `SF − reservado` preservada
- Fiscal separado de Não Fiscal
- `empresaId` / COMPAT explícita / sem fallback silencioso
- Transação e rollback preservados
- Sem UPDATE direto nos fluxos migrados
- 02.1–02.6 continuam passando
- Nenhuma migration / `estoque_empresa` não criada

---

## 10. Regressões

Nenhuma causada pela 02.7.

---

## 11. Limitações

- Sem isolamento físico (`estoque_empresa`).
- COMPAT até JWT/empresas.
- `pedidoReservaPonteNucleo` e `ReservaRepairService` ainda com SQL de `reservado_fiscal` (pedido / Motor Comercial — fora do PDV).

---

## 12. Próxima etapa

**Auditoria final** dos mutadores (saldo, reservado, crédito, débito, compra, venda, cancel, devolução, ajuste, recálculo).

Depois: **Fase Empresas** (cadastro → `empresaId` → CNPJ).  
Só então: **estoque_empresa**.

Não implementada nesta Sprint.
