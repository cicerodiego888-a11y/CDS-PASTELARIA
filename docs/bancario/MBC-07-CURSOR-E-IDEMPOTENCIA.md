# MBC-07 — Cursor e idempotência

## Cursor

Pertence a empresa + conta + provider (`sincronizacao_bancaria.cursor_atual`).

Não é compartilhado entre contas. Não volta a `null` a cada sincronização.

Fluxo seguro:

1. buscar página (com cursor atual);
2. persistir transações via MBC-03;
3. só então gravar `next_cursor`.

Se a página 2 falhar, o cursor permanece no da página 1. A retomada continua dali. Transações já gravadas não são desfeitas.

## Paginação

Contrato do provider:

```json
{ "transacoes": [], "has_more": true, "next_cursor": "CURSOR-002" }
```

O motor percorre páginas enquanto `has_more` for verdadeiro (teto de segurança de 50 páginas).

O MOCK genérico (MBC-05) ainda pode devolver array; o adaptador de configuração trata os dois formatos.

## Idempotência

Somente a chave oficial MBC-03:

`empresa_id + conta_bancaria_id + external_source + external_id`

Resultados: `CRIADA` / `JA_EXISTENTE`. Sem hash paralelo. Sem `external_id` inventado.

Sincronização incremental (cursor no fim do catálogo) devolve 0 novas. Reprocessar o catálogo (`reprocessarCatalogo`, uso interno/teste) reenvia as mesmas chaves e obtém `JA_EXISTENTE`.
