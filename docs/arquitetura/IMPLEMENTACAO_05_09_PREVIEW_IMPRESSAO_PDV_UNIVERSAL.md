# Sprint 05.09 — Preview e impressão do PDV Universal

## MULTIEMPRESA

Preview: `GET /api/pdv-universal/atendimentos/:id/comprovante?formato=HTML`

Impressão: `POST /api/atendimentos/:id/imprimir` com `{ destino: BROWSER, formato: HTML, largura: 40 }` (contrato 04.12/04.13).

FISCAL_PARCIAL e FISCAL_ERRO não bloqueiam o preview.

`window.print()` não é chamado automaticamente. Impressão física (ESC/POS/USB) fica fora desta sprint.

## EMPRESA_UNICA

Permanece no fluxo oficial (VendaApplicationService + DANFE existente). Sem atendimento inventado.

## Novo atendimento

Limpa somente o estado visual (carrinho, sessão, locks, modais). Não apaga atendimento/vendas/documentos persistidos.
