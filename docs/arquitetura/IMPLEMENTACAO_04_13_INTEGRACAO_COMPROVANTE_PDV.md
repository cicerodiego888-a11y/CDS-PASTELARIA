# Implementação 04.13 — Integração do comprovante unificado ao PDV

**Status:** concluída · **Sem impressora física** · **Sem `window.print()` automático**

## Regra

O frontend **não monta** comprovante. Consome exclusivamente:

- `GET /api/atendimentos/:id/comprovante` (JSON / `?formato=HTML` / `?formato=TEXT`)
- `POST /api/atendimentos/:id/imprimir` `{ destino: "BROWSER", formato: "HTML", largura: 40 }`

```
ATENDIMENTO
    ↓
ComprovanteUnificadoAtendimentoService
    ↓
DTO OFICIAL
    ↓
ComprovanteRenderer
    ↓
TEXT / HTML
    ↓
ComprovantePrintService
    ↓
PDV / PREVIEW / BROWSER / THERMAL (futuro)
```

## UI

`ComprovanteAtendimentoModal` (`frontend/shared/js/muv-comprovante-modal.js`):

- carrega JSON + HTML oficiais;
- loading / erro / preview em iframe (`srcdoc` do HTML do backend);
- FECHAR / PREVIEW / PREPARAR IMPRESSÃO;
- barra **VER COMPROVANTE** só quando existe `atendimento_id` real.

Estados visuais: CARREGANDO, COMPROVANTE_DISPONIVEL, SEM_DOCUMENTO_FISCAL, FISCAL_PARCIAL, FISCAL_ERRO, ATENDIMENTO_CANCELADO, ERRO_CARREGAMENTO.

Estado fiscal **não** esconde o comprovante nem documentos autorizados.

## MULTIEMPRESA (A/B/C)

Um cliente, um atendimento, um pagamento, um comprovante. Itens contínuos. Empresas só na seção fiscal do HTML oficial.

## EMPRESA_UNICA

Não cria atendimento oculto. `notificarAtendimentoMuvSePresente(resposta)` só exibe a ação se a resposta trouxer `atendimento_id`. O fluxo NFC-e por `vendaId` do PDV permanece.

## Atalhos

Nenhum atalho novo (evita conflito com F7/F11 e demais teclas do PDV).

## Segurança

Cliente rejeita DTO com CSC, senha de certificado, PFX, path interno ou rateio.
