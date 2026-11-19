# DIAGNÓSTICO — Schema Cozinha v2 vs v3

## Fontes inspecionadas

- `backend/utils/cozinhaSchema.js`
- `backend/database.js` (cadeia de init + catch Cozinha)
- `cozinha_schema_meta`
- `cozinha_idempotencia` (colunas, índices, CHECK)
- Testes S01 de falha de upgrade bloqueado

## Meta de versão

Tabela `cozinha_schema_meta`:

| chave | valor |
|---|---|
| `schema_version` | `2` ou `3` |

Alvo do código: `COZINHA_SCHEMA_VERSION = 3`.

## Diferença efetiva v2 → v3

**Única alteração estrutural:** cláusula CHECK em `cozinha_idempotencia.tipo_operacao`.

| Versão | Valores aceitos |
|---|---|
| v2 | `AUTORIZAR_QTY`, `REDUZIR_TETO`, `DESPACHO_LOTE` |
| v3 | + `PREPARACAO_INICIADA`, `ITEM_PRONTO`, `BEBIDA_ENTREGUE` |

## O que NÃO muda

- Colunas de `cozinha_idempotencia` (mesmas 12 colunas).
- PK `id`, UNIQUE `idempotency_key`.
- Índices: `ux_cozinha_idempotencia_key`, `idx_cozinha_idempotencia_tipo_recurso`, `idx_cozinha_idempotencia_situacao_criado`.
- Demais tabelas `cozinha_*` (rodadas, itens, FKs compostas, etc.).
- Sem FKs de/para `cozinha_idempotencia` — tabela isolada (contexto em JSON).

## Problema pré-04A

`recriarSchemaSeNecessario` exigia DROP de **todas** as tabelas se `versao < alvo` e houvesse linhas → `COZINHA_SCHEMA_UPGRADE_BLOQUEADO` em bancos v2 populados.  
SQLite não permite `ALTER CHECK` in-place → necessário rebuild controlado da tabela.

## Dependências avaliadas

| Dependência | Impacto na migração |
|---|---|
| FKs compostas em outras tabelas | Nenhuma — idempotência não é referenciada |
| `CREATE TABLE IF NOT EXISTS` | Não altera CHECK existente — migração explícita obrigatória |
| `database.js` catch | Falha Cozinha não impede ERP (`isReady`) |

## Conclusão do diagnóstico

Migração segura = rebuild transacional de `cozinha_idempotencia` + cópia byte-a-byte lógica das linhas + atualização de meta **somente após** validações. Demais tabelas intocadas.
