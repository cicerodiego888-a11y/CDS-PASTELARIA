# Sprint 05.07 — Pagamento unificado do PDV Universal

## Fluxo

ATENDIMENTO VALIDADO → `POST /api/pdv-universal/atendimentos/:id/reservar` → RESERVADO → tela de pagamento → `POST .../pagamento` → PAGO.

Cancelamento: `POST .../cancelar` → `cancelarAtendimento()` (libera reservas oficiais).

## Autoridade

O PDV Universal envia apenas `pagamentos[]` e `estrategia_rateio` (`POR_ITEM` padrão). Rateio, centavos e estoque permanecem no MUV (`confirmarPagamentoAtendimento` / `reservarAtendimento`).

## Fora de escopo

Materialização, NFC-e, comprovante, TEF real, sprint 05.08, EMPRESA_UNICA e PDV legado.
