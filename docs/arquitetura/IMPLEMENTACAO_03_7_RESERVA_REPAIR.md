# Implementação 03.7 — ReservaRepairService → Porta Pública

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Auditoria (somente ReservaRepairService)

Arquivo: `backend/motores/comercial/ReservaRepairService.js`

Nenhum outro serviço foi aberto para mutação.

### Escritores encontrados

| Método | Campo | Sinal | Classificação |
|---|---|---|---|
| `handlerLiberarReserva` | `reservado_fiscal` | `reservado − quantidade_fiscal` | **liberar** |
| `handlerRemoverReserva` | `reservado_fiscal` | `reservado − quantidade_fiscal` | **liberar** |
| `handlerCriarReserva` | `reservado_fiscal` | `reservado + quantidade` | **reservar** |
| `handlerAjustarReserva` | `reservado_fiscal` | `+diferenca` se pedido > reserva; `−redução` se pedido < reserva | **reservar** ou **liberar** conforme o sinal |

`reservado_nao_fiscal` **não** é escrito por nenhum método. Não existe repair NF.

Não há SET absoluto de um alvo arbitrário: o valor gravado era sempre `reservadoAntes ± delta`. Migrável pela porta.

### Dados por escrita

| Método | produtoId | Tipo | Quantidade | db | empresaId (HEAD) |
|---|---|---|---|---|---|
| LIBERAR | `reserva.produto_id` | FISCAL | `reserva.quantidade_fiscal` | `opts.db` | ausente |
| REMOVER | `reserva.produto_id` | FISCAL | `reserva.quantidade_fiscal` | `opts.db` | ausente |
| CRIAR | `ctx.produto_id` | FISCAL | `pedido_quantidade` ou `SUM(pedidos_itens)` | `opts.db` | ausente |
| AJUSTAR | `reserva.produto_id` | FISCAL | `abs(pedidoQtd − reservaQtd)` | `opts.db` | ausente |

Tracking (`pedido_estoque_reservas`) permanece no Repair: CANCELADA / INSERT / `quantidade_fiscal`. Não é saldo.

---

## SQL direto removido

Quatro UPDATEs equivalentes a:

```sql
UPDATE produtos SET reservado_fiscal = ? WHERE id = ?
```

Parâmetro: `reservadoAntes ± quantidade` (já validado).

Não tocavam `reservado_nao_fiscal`, `saldo_*` nem `estoque_atual`.

---

## Porta utilizada

`reservasPublico` — métodos da Implementação 02.7:

| Sinal no HEAD | Porta |
|---|---|
| `reservado + qtd` (CRIAR; AJUSTAR aumento) | `reservarQuantidade(..., TipoSaldo.FISCAL, ...)` |
| `reservado − qtd` (LIBERAR; REMOVER; AJUSTAR redução) | `liberarQuantidadeReservada(..., TipoSaldo.FISCAL, ...)` |

Não criada porta paralela (`ReservaRepairServiceV2` / `reservasRepairPublico` / `repairReservaPorta`).

Não usa `criarReservaFiscal` / `liberarReservasPedido` (eles também mutam tracking).

Não usa `debitarSaldo` / `creditarSaldo`. Saldo físico intacto.

---

## Fiscal / não fiscal

Preservado o comportamento encontrado: **somente fiscal**.

Não inventada distribuição F/NF. `reservado_nao_fiscal` não é escrito.

---

## empresaId

Prioridade:

1. `opts.empresaId` / `empresa_id`
2. `contexto` / `ctx` / `req`
3. Ausência → `COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA`
4. `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`

Sem `empresaId = 1` / `configuracoes.cnpj` / fallback silencioso.

Callers atuais (`executarPlano` / RC5.3) entram em COMPAT quando não enviam empresa.

---

## Transação

Mesmo `db` do caller. Sem `BEGIN` / `COMMIT` / `ROLLBACK` no Repair.

A porta (`reservarQuantidade` / `liberarQuantidadeReservada`) também não abre TX própria.

```
BEGIN
  repair (porta)
ROLLBACK
→ reservado_fiscal anterior
```

---

## Fora de escopo (intacto)

`consumirReservasPedidoNaVenda` (03.6), reservas PDV (02.7), baixa 02.6, vendas, pedidos, Faturamento, Motor Fiscal/Não Fiscal, MTS, MUC, MIIP, Central, TEF, Motor Comercial, CREATE produto, lotes, `estoque_empresa`.

---

## Testes

`tests/estoque/reserva-repair-porta-publica.test.js` — 01–10.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT até o caller do repair enviar empresa.
3. Repair continua só fiscal.
4. Porta não atualiza `produtos.updated_at` (o SET anterior também não gravava `updated_at`).
5. `estoque_empresa` **não** criada.

---

## Próxima etapa

**03.8** — fora desta Sprint. Não avançada.
