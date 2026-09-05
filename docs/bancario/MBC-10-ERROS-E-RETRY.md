# MBC-10 — Erros e retry

## Categorias

Mapeadas no cliente (`categorizarHttp`) e em `classificarErroProvider`:

AUTENTICACAO · AUTORIZACAO · CONSENTIMENTO · TIMEOUT · RATE_LIMIT · INDISPONIBILIDADE · DADOS_INVALIDOS · PAGINACAO · CURSOR_INVALIDO · ERRO_INTERNO

O núcleo não depende de códigos proprietários.

## Timeout

15s (`TIMEOUT_MS`). AbortController. Categoria TIMEOUT. Sem stack/token no frontend.

## Rate limit

HTTP 429 → RATE_LIMIT. Sem loop agressivo.

## Retry

`retrySeguro`: no máximo 2 retentativas para TIMEOUT, INDISPONIBILIDADE e RATE_LIMIT.

Não retenta: credencial inválida, consentimento revogado, autorização negada, DTO inválido.

Cursor do MBC-07 continua avançando só após persistir a página.

## Transação sem external_id

O mapper **interrompe** o item. Não inventa chave. Categoria DADOS_INVALIDOS.
