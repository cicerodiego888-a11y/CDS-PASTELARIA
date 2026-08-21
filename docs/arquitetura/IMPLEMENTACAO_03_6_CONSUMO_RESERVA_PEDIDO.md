# Implementação 03.6 — Consumo de reserva de pedido → Porta Pública

**Status:** concluída · **Data:** 2026-08-16  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Auditoria prévia (obrigatória)

A Sprint **não** estava no HEAD. `consumirReservasPedidoNaVenda` ainda fazia
`UPDATE produtos SET reservado_fiscal`.

### Mutador encontrado

| Campo | Descoberta |
|---|---|
| Arquivo | `backend/services/estoque/pedidoReservaPonteNucleo.js` |
| Método | `consumirReservasPedidoNaVenda(pedidoId, vendaId, opts)` |
| Wrapper | `consumirReservasPedidoNaVendaCb` (VendaPagamentoService) |
| Tabela de tracking | `pedido_estoque_reservas` (status `ATIVA` → `CONSUMIDA`) |
| Tabela de reservado | `produtos.reservado_fiscal` |
| Quantidade | `row.quantidade_fiscal` (única coluna do tracking) |
| Classificação | **somente fiscal** — não existe `quantidade_nao_fiscal` no pedido |
| Relação pedido | `pedido_id` das linhas ATIVAS |
| Relação venda | `vendaId` só é gravado no retorno; não altera venda |
| `db` | `opts.db` ou `require('../../database')` |
| Transação | caller da venda pode já estar em `BEGIN`; a ponte **não** abria TX |
| `empresaId` | **ausente** no HEAD |

### Callers

| Caller | Como chama | empresaId | COMPAT após 03.6 |
|---|---|---|---|
| `VendaPagamentoService.criarVenda` | `consumirReservasPedidoNaVendaCb(..., db)` **após** a baixa 02.6 | propaga `opcoesBaixaEstoque.empresaId` + `contexto: req` | se o request não tiver empresa |
| `FaturamentoService` (pós-núcleo) | `consumirReservasPedidoNaVenda(id, vendaId)` | propaga `db` + `reqHttp.empresaId` + `contexto` | se o request não tiver empresa |
| `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js` | `{ db }` | não | **sim** (explícita) |

Não depende de `ReservaRepairService`. A regra de parada **não** se aplica.

### SQL anterior (HEAD)

```sql
UPDATE produtos
SET reservado_fiscal = CASE
  WHEN COALESCE(reservado_fiscal, 0) - ? < 0 THEN 0
  ELSE COALESCE(reservado_fiscal, 0) - ?
END,
updated_at = CURRENT_TIMESTAMP
WHERE id = ?
```

Parâmetros: `[q, q, row.produto_id]` com `q = round3(row.quantidade_fiscal)`.

Não tocava `reservado_nao_fiscal`, `saldo_*` nem `estoque_atual`.

O UPDATE de tracking permanece (não é saldo):

```sql
UPDATE pedido_estoque_reservas
SET status = 'CONSUMIDA',
    atualizado_em = CURRENT_TIMESTAMP
WHERE id = ? AND status = 'ATIVA'
```

---

## Fluxo novo

```
pedido
  ↓
pedido_estoque_reservas (ATIVA)
  ↓
quantidade_fiscal persistida
  ↓
reservasPublico.liberarQuantidadeReservada (TipoSaldo.FISCAL)
  ↓
reservado_fiscal
  ↓
status CONSUMIDA
```

Em seguida (inalterado, 02.6):

```
baixa física da venda → debitarEstoqueItemVenda → debitarSaldo
```

No PDV (`VendaPagamentoService`) a ordem real do caller é:

```
baixa física 02.6
  ↓
consumirReservasPedidoNaVenda
```

A ponte **não** chama a baixa. As responsabilidades continuam separadas.

---

## Porta utilizada

`reservasPublico.liberarQuantidadeReservada` — operação da Implementação 02.7.

Não foi criada porta paralela (`reservaPedidoPublico2` / `pedidoReservaPublico2` / `ReservaService2`).

Não usa `debitarSaldo` / `creditarSaldo`. Saldo físico intacto nesta etapa.

A porta **não** abre `BEGIN` próprio em `liberarQuantidadeReservada`.

Diferença aceita da porta (igual 02.7): não grava `produtos.updated_at`.
O SQL interno da porta aplica piso 0 em `reservado_fiscal`, equivalente ao CASE anterior.

Quantidade `<= 0` não chama a porta (`QUANTIDADE_INVALIDA`); o tracking ainda
pode ser marcado `CONSUMIDA`. O HEAD aplicava `UPDATE` com `q = 0` (no-op).

---

## Pedido ≠ PDV

| Modelo | Tabela | Sprint |
|---|---|---|
| Pedido | `pedido_estoque_reservas` | **03.6** (este) |
| PDV | `venda_estoque_reservas` | 02.7 (intacto) |

---

## Quantidade / F×NF

Preservado o comportamento real encontrado: só `quantidade_fiscal` → `reservado_fiscal`.

Não transformado em F+NF. `reservado_nao_fiscal` não é escrito por este fluxo.

Motor Fiscal / Não Fiscal / MTS / MUC / Motor Comercial intactos.

---

## empresaId

Prioridade:

1. `opcoes.empresaId` / `empresa_id`
2. `contexto` / `ctx` / `req`
3. Ausência → `COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA`
4. `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA`

Sem `empresaId = 1` / `configuracoes.cnpj` / fallback silencioso.

---

## COMPAT

Não removida globalmente.

| Caller | Entra em COMPAT quando |
|---|---|
| `VendaPagamentoService` | request da venda sem empresa |
| `FaturamentoService` | `reqHttp` sem empresa |
| RC4.1.2 | `{ db }` apenas |

---

## Transação

Mesmo `db` do caller. Sem `BEGIN` próprio na ponte nem na porta de liberação.

```
BEGIN
  consumir reserva (porta)
ROLLBACK
→ reservado_fiscal / reservado_nao_fiscal anteriores
```

---

## Duplicidade

Idempotente: só linhas `ATIVA`. Segunda chamada → `consumidas: 0`, reservado inalterado.

`FaturamentoService` também chama `consumirReservasDaVenda` (PDV / 02.7) no mesmo
pós-núcleo. São modelos distintos (`venda_estoque_reservas` vs
`pedido_estoque_reservas`). Não é uma segunda forma de consumo do pedido.

---

## Separação reserva × baixa

`consumirReservasPedidoNaVenda` **não** chama `debitarSaldo`, `creditarSaldo`,
`reduzirEstoqueDistribuido` nem `debitarEstoqueItemVenda`.

---

## Scan SQL (pós-implementação)

| Arquivo | `UPDATE produtos` de `reservado_*` |
|---|---|
| `pedidoReservaPonteNucleo.js` / `consumirReservasPedidoNaVenda` | **removido** |
| `reservasPublico.js` (`_aplicarDeltaReservado`) | interno da porta (único escritor deste fluxo) |
| `EstoqueReservaService.js` / `EstoqueConsumoReserva.js` | ausente (02.7) |
| `ReservaRepairService.js` | **permanece** (03.7 — fora do escopo) |

SELECTs de `reservado_*` e UPDATE de status de tracking permanecem.

---

## Testes

`tests/estoque/consumo-reserva-pedido-porta-publica.test.js` — 01–10.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT nos callers sem empresa no request.
3. Pedido continua só fiscal no tracking (`quantidade_fiscal`).
4. Porta não atualiza `produtos.updated_at`.
5. `ReservaRepairService` **não** migrado (03.7).
6. `estoque_empresa` **não** criada.

---

## Próxima etapa

**03.7** — `ReservaRepairService`.
