# Relatório — Sprint 04.12

## Status

Concluída. THERMAL é contrato/preparação. Nenhuma impressora física foi integrada.

## Arquitetura

DTO oficial → renderer oficial → `ComprovantePrintService` → adapter. Sem nova fonte de dados.

## Arquivos criados

`backend/motores/muv/impressao/` (`PrintAdapter`, `ComprovantePrintService`, `PreviewPrintAdapter`, `BrowserPrintAdapter`, `ThermalPrintAdapter`, `printContracts`), teste 04.12, docs.

## Arquivos alterados

`rotas/atendimentos.js`, `muv/index.js`, `ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md`.

## Testes novos

`impressao-comprovante-04-12` — **28/28**

## Regressão

04.01–04.11, MUC, VendaApplication, orquestrador, TEF, dual-write 03.19, reservas 03.20, portas, MTS, pedido, compras, baixa, cancel/devolução — **OK**.

## Limitações

Sem ESC/POS, USB/serial/TCP, `window.print()` no backend, UI.

## Próxima sprint (não iniciada)

Implementação real do ThermalPrintAdapter (ESC/POS) ou preview no PDV via BROWSER.
