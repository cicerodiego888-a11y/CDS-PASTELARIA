# AUDITORIA — Integridade SQLite

## Controles aplicados na migração

| Controle | Quando |
|---|---|
| `PRAGMA foreign_keys` OFF/ON | Fora da TX (restaura no `finally`) |
| `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` | Toda a rebuild |
| Contagem pré/pós cópia | Antes do DROP do bak |
| Snapshot JSON pré/pós | Antes do DROP do bak |
| Recriação de índices UNIQUE/INDEX | Após nova tabela |
| `sqlite_sequence` | Preserva AUTOINCREMENT |
| Smoke CHECK novos tipos | Antes da meta |
| `PRAGMA integrity_check` | Antes do COMMIT |
| `PRAGMA foreign_key_check` | Antes do COMMIT |

## Evidência pós-migração (teste B)

- `integrity_check = ok`
- `foreign_key_check` vazio
- `PRAGMA foreign_keys = 1` após conclusão
- UNIQUE `idempotency_key` funcional (índice recriado)
- INSERT dos três novos `tipo_operacao` aceitos

## Referências compostas empresa

Não tocadas — nenhuma outra tabela é recriada no caminho v2→v3.
