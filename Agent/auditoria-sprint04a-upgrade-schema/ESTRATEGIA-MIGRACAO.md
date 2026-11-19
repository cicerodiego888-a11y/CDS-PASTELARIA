# ESTRATÉGIA DE MIGRAÇÃO v2 → v3

## Função principal

`migrarCozinhaV2paraV3(db, opts?)` em `backend/utils/cozinhaSchema.js`.

Orquestração em `garantirSchemaCozinha(db, opts?)`:

| Versão lida | Ação |
|---|---|
| `> 3` | Erro `COZINHA_SCHEMA_INCOMPATIVEL` (não corrige) |
| `= 3` | `CREATE IF NOT EXISTS`; valida CHECK; operacional |
| `= 2` | `migrarCozinhaV2paraV3` + garantir demais tabelas |
| `< 2` e vazio | Recria schema vazio → v3 |
| `< 2` e populado | `COZINHA_SCHEMA_UPGRADE_BLOQUEADO` (inalterado S01) |

## Passos da migração v2→v3

1. Confirmar existência de `cozinha_idempotencia`.
2. Validar colunas esperadas (`IDEMPOTENCIA_COLUNAS`).
3. Se CHECK já aceita preparação → só grava meta=3 (idempotente).
4. Snapshot contagem + conteúdo ORDER BY id.
5. `PRAGMA foreign_keys = OFF` (**fora** da TX — requisito SQLite).
6. `BEGIN IMMEDIATE`.
7. `RENAME` → `cozinha_idempotencia__v2_bak`.
8. `CREATE TABLE` com CHECK v3.
9. `INSERT … SELECT` colunas explícitas.
10. Comparar contagem e JSON do snapshot.
11. `DROP` bak; recriar índices; ajustar `sqlite_sequence`.
12. Smoke INSERT/DELETE `PREPARACAO_INICIADA`.
13. `integrity_check` + `foreign_key_check`.
14. Gravar `schema_version=3`.
15. `COMMIT`.
16. Restaurar `foreign_keys` no `finally`.

## Falha

- `ROLLBACK` → schema v2 e dados intactos.
- Meta permanece 2.
- `marcarCozinhaOperacional(false, err)`.
- ERP: catch em `database.js` não propaga a falha para `isReady()`.

## Gancho de teste

`opts.simularFalha = 'apos_copia' | 'antes_meta'` — somente para testes; provoca rollback controlado.

## DROP TABLE

Usado **apenas** dentro da TX: (a) limpar bak residual; (b) dropar bak após cópia validada. Nunca DROP das demais tabelas cozinha no caminho v2→v3.
