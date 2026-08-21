# Implementação 02.7 — Reservas PDV → Porta Pública

**Status:** concluída · **Data:** 2026-08-14  
**Projeto:** Pastelaria · Fase 1 Fundação Multiempresa

---

## Mutadores encontrados

| Arquivo | Método | Origem | Tipo | Ação 02.7 |
|---|---|---|---|---|
| `EstoqueReservaService` | `reservarItem` | PDV / venda entrega | criação `reservado_*` | Porta |
| `EstoqueReservaService` | `liberarReservasDaVenda` | cancelamento entrega | liberação | Porta |
| `EstoqueConsumoReserva` | `consumirReservasDaVenda` | prestação / faturamento | libera `reservado_*` | Porta (só reserva) |
| `EstoqueConsumoReserva` | `reduzirEstoqueDistribuido` | mesma função | **baixa de saldo** | **Não migrado** (02.6) |
| `reservasPublico` | `criarReservaFiscal` / `NF` / `liberarReservasPedido` | Pedido / Motor Comercial | já era porta | SQL interno unificado |
| `pedidoReservaPonteNucleo` | `consumirReservasPedidoNaVenda` | pedido → núcleo | `reservado_fiscal` | **Fora do escopo** (não PDV) |
| `ReservaRepairService` | repair/reconcile | Motor Comercial | `reservado_fiscal` | **Não migrado** |

SELECT de `reservado_*` (disponibilidade / distribuição) permanece.

---

## Fluxo anterior

```
Reserva PDV (entrega)
  → UPDATE produtos SET reservado_fiscal +=, reservado_nao_fiscal +=
  → INSERT venda_estoque_reservas

Liberação / consumo
  → UPDATE produtos SET reservado_* -=
  → status CANCELADA / CONSUMIDA
```

---

## Lacuna da porta (documentada)

`reservasPublico` da Implementação 01 é de **pedido**:

- exige `pedidoId`
- grava `pedido_estoque_reservas`
- `liberarReservasPedido` só mexe em `reservado_fiscal`

PDV usa `venda_estoque_reservas` e reserva F+NF sem pedido.

**Extensão mínima** (sem autoridade paralela):

- `_aplicarDeltaReservado`
- `reservarQuantidade`
- `liberarQuantidadeReservada`
- `ajustarReservado`

Não exigem `pedidoId`. Não alteram saldo físico. Não criam `reservasPdvService2`.

---

## Fluxo novo

```
Reserva PDV
        ↓
reservasPublico.reservarQuantidade / liberarQuantidadeReservada
        ↓
reservado_fiscal / reservado_nao_fiscal
        ↓
INSERT/UPDATE venda_estoque_reservas  (tracking)
```

Disponibilidade continua em `EstoqueDisponivelService`:

```
disponivel_fiscal = saldo_fiscal - reservado_fiscal
disponivel_nao_fiscal = saldo_nao_fiscal - reservado_nao_fiscal
```

---

## empresaId

body / `req.user` / `req` via `montarOptsPortaReservaPdv`.  
Ausência → `COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA`. Sem empresa 1 / CNPJ inventado.

---

## Transação

Callers (`BEGIN IMMEDIATE`) preservados. A porta **não** abre TX própria em `reservarQuantidade` / `liberarQuantidadeReservada`. Rollback do caller reverte o reservado (testado).

---

## Testes

`tests/estoque/reservas-pdv-porta-publica.test.js` — 01–11.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT até JWT/empresas.
3. Consumo de reserva de **pedido** (`pedidoReservaPonteNucleo`) e repair comercial permanecem com SQL direto.
4. Tracking `venda_estoque_reservas` permanece nos serviços PDV.

---

## Próxima fase

Auditoria final dos mutadores de estoque. **Não** criar `estoque_empresa` agora. Depois: cadastro de empresas → `empresaId` → estoque físico.
