# Implementação 03.10 — Auditoria final dos escritores de estoque e reserva

**Status:** concluída · **Data:** 2026-08-21  
**Tipo:** auditoria somente leitura  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Resposta objetiva

1. Existe escritor operacional pendente? **NÃO**
2. Próximo escritor (03.11): **não há**
3. Auditoria dos escritores da fundação atual: **encerrada**

**Não** iniciar `estoque_empresa` nesta Sprint.

---

## Mapa

### Já migrados (A)

| Escritor | Arquivo | Operação | Status |
|---|---|---|---|
| Ajuste de estoque 02.1 | `ajusteEstoqueService.js` | ± SF/SNF via porta | MIGRADO |
| Saldos iniciais PUT 02.1 | `ajusteEstoqueService.js` / PUT produtos | absoluto → delta porta | MIGRADO |
| Recálculo 02.2 | `estoqueFiscalService.js` | deltas via porta | MIGRADO |
| Crédito compra 02.3 | `creditoEstoqueCompraViaPorta.js` | + SF/SNF | MIGRADO |
| Débito cancel/dev compra 02.4 | `debitoEstoqueCompraViaPorta.js` | − SF/SNF | MIGRADO |
| Crédito cancel/dev venda 02.5 | `creditoEstoqueVendaViaPorta.js` | + SF/SNF | MIGRADO |
| Baixa venda 02.6 | `debitoEstoqueVendaViaPorta.js` | − SF/SNF | MIGRADO |
| Reservas PDV 02.7 | `EstoqueReservaService.js` / `EstoqueConsumoReserva.js` | ± reservado | MIGRADO |
| Revert NF-e devolução 03.5 | `estoqueNfeDevolucaoVenda.js` | − SF/SNF | MIGRADO |
| Consumo reserva pedido 03.6 | `pedidoReservaPonteNucleo.js` | − reservado_fiscal | MIGRADO |
| Repair 03.7 | `ReservaRepairService.js` | ± reservado_fiscal | MIGRADO |
| CREATE saldo inicial 03.8 | `rotas/produtos.js` POST + helper | crédito se qty > 0 | MIGRADO |
| MTS | `MtsService.js` | débito/crédito via porta | MIGRADO |
| Motor Comercial (reserva pedido) | `MotorComercialService.js` | `reservasPublico` | MIGRADO |
| Porta saldos | `estoqueSaldosPublico.js` | `_ajustarSaldo` | MIGRADO (interno) |
| Porta reservas | `reservasPublico.js` | `_aplicarDeltaReservado` | MIGRADO (interno) |
| Importação qtd | `quantidadeUpdater.js` / importer | ajuste 02.1 | MIGRADO |

### COMPAT (B)

COMPAT existentes (não removidas): ajuste, recálculo, compra, venda, PDV, revert, consumo pedido, repair, CREATE. Certificação/homologação grava SQL de prova em produto temporário e apaga — **não é loja**.

### Leitura / cálculo (C)

`EstoqueDisponivelService`, SELECTs, PUT `CAMPOS_PRODUTO_IGNORADOS` (bloqueia SF/SNF/EA), schema `DEFAULT 0`, UPDATE de cadastro (preço, unidade, imagem, validade) **sem** esses campos.

INSERT cadastro com **0,0,0**: compras `ensureProductForItemLegado`, importer, homologação.

### Código morto (D)

| Escritor | Arquivo | Operação | Status |
|---|---|---|---|
| `atualizarEstoqueConsolidado` | `lotesService.js` | SET `estoque_atual = somaLotes` | CÓDIGO MORTO |
| Backfill saldos | `scripts/backfill-saldos-fiscais.js` | `saldo_fiscal = estoque_atual` | CÓDIGO MORTO |

### Lotes 03.9

**AUDITADO — NÃO É ESCRITOR OPERACIONAL DE SALDO/RESERVA**

Métodos vivos só rastreiam `produtos_lotes` / `venda_lotes`.

### Pendentes (E)

**Nenhum.**

---

## SQL direto restante (não operacional)

1. Porta — único escritor autorizado.
2. Lotes consolidado — sem caller.
3. `ReleaseCertificationService.etapaEstoque` — prova, DELETE em seguida.
4. `scripts/backfill-saldos-fiscais.js` — one-shot histórico, sem caller no app.

PUT produtos: `UPDATE produtos SET ${fields}` **não** inclui saldo/reserva (`CAMPOS_PRODUTO_IGNORADOS`).

---

## Teste

`tests/estoque/auditoria-final-escritores.test.js` — 01–07.

---

## Parada

Sem código de produção. Sem COMPAT novo. Sem `estoque_empresa`.
