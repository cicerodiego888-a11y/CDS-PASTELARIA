# Implementação 04.11 — Renderização do comprovante unificado

**Status:** concluída · **Sem ESC/POS** · **Sem impressora** · **04.12 não iniciada**

## Arquitetura

```
ComprovanteUnificadoAtendimentoService (DTO 04.10)
        ↓
ComprovanteRenderer.renderizar(dto, { format, largura })
        ↓
TEXT | HTML
```

O renderer **não** acessa banco, fiscal, estoque nem pagamento.

## TEXT

Largura default 40 (testado 32/40/48). Helpers em `comprovanteLayout.js`. Itens contínuos. Pagamento unificado. Empresa só na seção fiscal. CANCELADO com faixa. Sem documentos: mensagem informativa.

## HTML

Preview/impressão futura via navegador. Todo texto escapado.

## HTTP

`GET /api/atendimentos/:id/comprovante` sem query = JSON 04.10.  
`?formato=TEXT` → `text/plain`.  
`?formato=HTML` → `text/html`.  
Formato inválido → `COMPROVANTE_FORMATO_INVALIDO`.
