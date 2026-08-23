# Implementação 04.04 — Reserva do atendimento multiempresa

**Status:** concluída · **Pré-requisito:** 04.03 (atendimento VALIDADO) · **Não inclui:** pagamento, venda, NFC-e, comprovante, consumo definitivo

## Arquitetura oficial (inalterada)

```
ATENDIMENTO
    ├── OPERAÇÃO EMPRESARIAL A
    ├── OPERAÇÃO EMPRESARIAL B
    └── OPERAÇÃO EMPRESARIAL C
```

Um atendimento = uma experiência comercial. Cada operação reserva apenas o estoque da sua `empresa_id`.

## Fluxo antes (04.03)

```
itens → agrupar → validar estoque_empresa → TX → VALIDADO
```

Dois atendimentos `VALIDADO` podiam enxergar o mesmo saldo. Sem reserva física. Sem vínculo de origem.

## Fluxo depois (04.04)

```
VALIDADO
    → BEGIN IMMEDIATE
    → consultarDisponibilidade (empresa da operação)
    → reservasPublico.reservarQuantidade (fiscal / não fiscal)
    → persistir atendimento_operacao_reservas (ATIVA)
    → COMMIT
    → RESERVADO + pagamento_pendente + venda_concluida=false

RESERVADO
    → BEGIN IMMEDIATE
    → liberarQuantidadeReservada por empresa
    → reservas ATIVA → CANCELADA
    → CANCELADO
```

`AGUARDANDO_PAGAMENTO` permanece no contrato de estados; esta sprint não promove automaticamente (pagamento = 04.05+).

## Métodos auditados (porta pública)

Arquivo: `backend/services/fiscalNaoFiscal/reservasPublico.js`

| Método | Uso 04.04 |
|---|---|
| `consultarDisponibilidade(produtoId, { db, empresaId })` | Rechecagem **dentro** da TX |
| `reservarQuantidade(produtoId, tipo, qtd, { db, empresaId })` | Incremento + dual-write 03.20 |
| `liberarQuantidadeReservada(...)` | Liberação + dual-write |
| `ajustarReservado` | Usado indiretamente pelas duas acima |

**Não usados:** `criarReservaFiscal` / `liberarReservasPedido` (pedido, sem dual-write) e `EstoqueReservaService` (exige `venda_id`).

`empresaId` chega **somente** de `atendimento_operacoes.empresa_id`. Body, CNPJ, query, user, ctx e empresa 1 não substituem.

## Porta reutilizada

`AtendimentoMultiempresaService` é o orquestrador. **Não** foi criado `ReservaAtendimentoService`.

```
AtendimentoMultiempresaService.reservarAtendimento / cancelarAtendimento
        → reservasPublico.reservarQuantidade / liberarQuantidadeReservada
        → produtos + estoque_empresa (03.20)
```

## Schema

Nova tabela `atendimento_operacao_reservas` (rastreio: “qual atendimento reservou?”). **Não** substitui `reservado_fiscal` / `reservado_nao_fiscal`.

Campos: `id`, `atendimento_id`, `atendimento_operacao_id`, `empresa_id`, `produto_id`, `item_id`, `quantidade_fiscal`, `quantidade_nao_fiscal`, `status` (`ATIVA`|`CANCELADA`), `created_at`, `updated_at`.

Constraints: CHECKs de quantidade e status; índice único parcial `(atendimento_operacao_id, produto_id) WHERE status = 'ATIVA'`.

## Estados

Atendimento: `VALIDADO` → `RESERVADO` → (`AGUARDANDO_PAGAMENTO` futuro) · cancelamento: `RESERVADO` → `CANCELADO`.

Operação: `VALIDADA` → `RESERVADA` · cancelamento → `CANCELADA`.

Nomes 04.03 (`VALIDADO`, `VALIDADA`) não foram renomeados.

## Atomicidade e rollback

Uma única `BEGIN IMMEDIATE` cobre todas as operações empresariais. Falha em qualquer empresa → `ROLLBACK` total: nenhum `reservado_*` persistido, nenhum órfão em `atendimento_operacao_reservas`, atendimento permanece `VALIDADO`.

## Idempotência

- **Reserva:** segundo `reservarAtendimento` em `RESERVADO` devolve o mesmo contrato com `idempotente: true` e **não** incrementa de novo.
- **Liberação:** segundo `cancelarAtendimento` em `CANCELADO` sem ATIVA devolve `liberacao: 'RESERVA_JA_LIBERADA'` sem debitar reservado (não gera negativo).
- **Cancelado:** `reservarAtendimento` lança `ATENDIMENTO_CANCELADO` (não reativa em silêncio).

## Isolamento A/B/C

Disponibilidade e reserva usam `estoque_empresa` da `empresa_id` da operação. Saldo de A ou C nunca autoriza B. Ausência de linha em `estoque_empresa` = zero. Saldo alto em `produtos` não autoriza.

Item `TOTAL`: reserva fiscal até o disponível fiscal; o restante vai para não fiscal. `FISCAL` / `NAO_FISCAL` reservam só o bucket correspondente.

## COMPAT / EMPRESA_UNICA

Inalterado: `VendaApplicationService` → `VendaPagamentoService`. Sem atendimento oculto. Sem reserva MUV no legado.

## Limitações

Sem pagamento, TEF, PIX, cartão, caixa, `vendas`, NFC-e, XML, comprovante, UI, consumo definitivo da reserva.
