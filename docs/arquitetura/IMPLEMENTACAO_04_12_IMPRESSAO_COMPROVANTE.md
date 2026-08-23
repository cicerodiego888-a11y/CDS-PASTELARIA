# Implementação 04.12 — Adaptador de impressão do comprovante

**Status:** concluída · **Sem impressão física real**

## Fluxo

```
ATENDIMENTO
    ↓
ComprovanteUnificadoAtendimentoService (DTO 04.10)
    ↓
ComprovanteRenderer (TEXT/HTML 04.11)
    ↓
ComprovantePrintService
    ↓
PrintAdapter
    ├── PREVIEW
    ├── BROWSER
    └── THERMAL (preparado, impressao_fisica: false)
```

O MUV não conhece USB, IP, driver ou ESC/POS.

## Destinos

| Destino | Formato | Efeito |
|---|---|---|
| PREVIEW | TEXT ou HTML | Conteúdo, `impresso: false` |
| BROWSER | HTML (padrão) | `pronto_para_impressao: true` — frontend chama print |
| THERMAL | TEXT apenas | `preparado: true`, `impressao_fisica: false` |

THERMAL + HTML → `FORMATO_NAO_SUPORTADO_PARA_DESTINO`. Destino inválido → sem fallback.

## HTTP

`POST /api/atendimentos/:id/imprimir`  
Body: `{ destino, formato, largura }` (32/40/48).  
Não altera status do atendimento.

## Segurança

Payload do adapter: conteúdo renderizado + metadata `{ tipo, codigo, status }`. Sem CSC/senha/rateio.
