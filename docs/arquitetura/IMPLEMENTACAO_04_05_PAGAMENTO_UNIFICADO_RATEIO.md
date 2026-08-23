# Implementação 04.05 — Pagamento unificado e rateio

**Status:** concluída · **Pré-requisito:** 04.04 (RESERVADO) · **Não inclui:** vendas A/B/C, TEF real, NFC-e, comprovante, consumo de reserva

## Auditoria dos motores existentes

| Componente | Papel | Reuso 04.05 |
|---|---|---|
| `OrquestradorPagamento` | Fluxo F×NF + TEF da venda única | **Não chamado** (TEF/venda futuros) |
| `VendaPagamentoService` | PDV `EMPRESA_UNICA` | **Intocado** |
| `VendaFinanceiroService.validarSomaPagamentosVenda` | Soma vs total, tolerância **0,01** | **Reutilizado** |
| `validarDistribuicaoPagamento` | Soma das partes = total | **Reutilizado** |
| `EstrategiaDistribuicaoPagamento` | `POR_ITEM` / `PROPORCIONAL` / `MANUAL` | **Contrato oficial** |
| TEF (`TefManager`, `tefFluxoPagamento`) | Autorização de terminal | **Não chamado** |

O MUV é orquestrador financeiro do **atendimento**. Não é um segundo motor de pagamento comercial/TEF.

## Fluxo

```
RESERVADO
    → BEGIN IMMEDIATE
    → PAGAMENTO_PROCESSANDO (somente dentro da TX)
    → total oficial = Σ itens persistidos (não body.total)
    → validarSomaPagamentosVenda
    → rateio POR_ITEM | PROPORCIONAL | MANUAL
    → invariantes
    → persistir pagamentos + rateios
    → PAGO
    → COMMIT
```

Falha antes do COMMIT: `ROLLBACK` → permanece `RESERVADO`, reservas ATIVAS.

## Contrato financeiro

- Total oficial: `Σ valorTotalItemAtendimento(quantidade, valor_unitario)` em centavos.
- Cliente: 1..N formas (`pix`, `dinheiro`, `cartao_credito`, …).
- `empresa_id` do rateio = `atendimento_operacoes.empresa_id`.
- Sem HTTP nesta sprint: `confirmarPagamentoAtendimento(id, entrada, deps)`.

## Estratégias

- **POR_ITEM** (padrão): cascata. Alvos = subtotais. Pagamentos na ordem de entrada preenchem empresas em `empresa_id ASC`.
- **PROPORCIONAL:** Hamilton (maior resto) **por pagamento**. Empate: `empresa_id ASC`.
- **MANUAL:** contratado; exige `rateios[]` com `empresaId` já existente no atendimento.

## Regra de centavos

Trabalho em **inteiros (centavos)**. Sem comparação financeira em float.

1. Quotas inteiras (`Math.floor`).
2. Resto distribuído pelo maior resto fracionário.
3. Empate por `empresa_id ASC` (nunca por ordem de `Object.keys`).

Tolerância comercial oficial: **1 centavo** (`validarSomaPagamentosVenda`). Se `|Σ pagos − total| = 1` centavo, o ajuste vai para o **último** pagamento da lista, para os invariantes fecharem no total oficial.

## Idempotência

`idempotency_key` + `payload_hash`. Mesma chave + mesmo payload → `{ idempotente: true }`. Mesma chave + payload distinto → `IDEMPOTENCY_KEY_CONFLICT`. Já `PAGO` com outra chave → `ATENDIMENTO_JA_PAGO`.

## Relação futura com TEF

Estados `PAGAMENTO_PROCESSANDO` → sucesso `PAGO` / falha permanece `RESERVADO` estão prontos. Integração real fica para sprint posterior, reutilizando `OrquestradorPagamento` / `POST /api/tef/pagar`.

## Limitações

Sem vendas, baixa, caixa, contas a receber, TEF, NFC-e, XML, impressão, comprovante, UI.
