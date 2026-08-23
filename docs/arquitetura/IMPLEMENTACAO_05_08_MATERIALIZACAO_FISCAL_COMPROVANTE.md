# Sprint 05.08 — Materialização + fiscalização + comprovante

## Fluxo

PAGO → `POST .../materializar` → CONCLUÍDO → `POST .../fiscalizar` → FISCALIZADO | FISCAL_PARCIAL | FISCAL_ERRO → `GET .../comprovante`.

Operações HTTP separadas. Sem transação única nova.

## Reutilizado

`materializarAtendimento`, `FiscalizarAtendimentoService`, `ComprovanteUnificadoAtendimentoService`, `ComprovanteRenderer`.

## Fora de escopo

Impressão física, ESC/POS, TEF, sprint 05.09, EMPRESA_UNICA, PDV legado.
