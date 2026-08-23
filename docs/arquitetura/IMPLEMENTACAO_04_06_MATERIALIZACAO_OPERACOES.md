# Implementação 04.06 — Materialização das operações empresariais

**Status:** concluída · **Pré-requisito:** atendimento `PAGO` (04.05) · **Não inclui:** NFC-e, XML, comprovante, TEF, UI

## Fluxo encontrado (auditoria)

`VendaPagamentoService.criarVenda` é o núcleo HTTP da venda única: Orquestrador + TEF + `BEGIN` próprio + baixa + `venda_pagamentos` + financeiro.

Chamá-lo por operação no MUV quebraria:

- atomicidade (TX aninhada);
- a regra “não cobrar de novo”;
- o isolamento (reserva MUV não é `venda_estoque_reservas`).

## Fluxo reutilizado

| Peça | Uso |
|---|---|
| `debitarEstoqueItemVenda` → `estoqueSaldosPublico.debitarSaldo` | Baixa oficial 03.19 (`empresaId` da operação) |
| `reservasPublico.liberarQuantidadeReservada` | Decrementa `reservado_*` **depois** da baixa (03.20) |
| Tabelas `vendas` / `vendas_itens` / `venda_pagamentos` / `financeiro` | Mesmo schema operacional |
| Rateios 04.05 | Imutáveis; não recalcula |

Ordem por operação (igual `EstoqueConsumoReserva`):

1. persistir venda + itens + pagamentos empresariais  
2. debitar saldo  
3. liberar reservado  
4. marcar reserva `CONSUMIDA`  
5. vincular `venda_id`

## Código novo

- `MaterializarOperacoesAtendimento.js` — orquestrador
- `AtendimentoMultiempresaService.materializarAtendimento`
- `VendaApplicationService.materializarAtendimento` — só `MULTIEMPRESA`

## Origem do pagamento

`atendimento_pagamento_rateios` + forma do `atendimento_pagamentos`.  
Σ rateio da operação = subtotal; senão `RATEIO_OPERACAO_INCONSISTENTE`.  
Pagamento misto: uma linha `venda_pagamentos` por forma daquela empresa.

## Consumo de reservas

`ATIVA` → baixa → libera reservado → `CONSUMIDA`.  
Não é cancelamento. Segunda materialização não reconsume.

## Atomicidade / rollback

Uma `BEGIN IMMEDIATE` para A+B+C. Falha → `ROLLBACK` → status volta a `PAGO` (nunca fica `MATERIALIZANDO`). Sem venda órfã, sem baixa parcial.

## Idempotência

`CONCLUIDO` + mesma ou outra chave → devolve o resultado existente, sem novas vendas.  
Mesma chave + hash incompatível → `IDEMPOTENCY_KEY_CONFLICT`.

## Autoridade

`atendimento_operacoes.empresa_id` apenas.

## Limitações

Sem NFC-e, XML, comprovante, TEF, UI. `vendas.empresa_id` continua fora do schema legado (vínculo em `atendimento_operacoes.venda_id`).
