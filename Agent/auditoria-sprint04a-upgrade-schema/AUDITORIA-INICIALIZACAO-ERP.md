# AUDITORIA — Inicialização ERP vs Cozinha

## Contrato Sprint 01 (preservado)

Em `backend/database.js`, após `garantirSchemaCozinha(db)`:

- Sucesso → log `[COZINHA] schema V1.2.3 vN operacional`
- Falha → `catch` local: log `FALHA_SCHEMA`, `marcarCozinhaOperacional(false, err)`, **não** rejeita a cadeia do ERP

`db.isReady()` continua refletindo o ERP.  
`db.isCozinhaOperacional()` / `getCozinhaSchemaStatus()` refletem a Cozinha.

## Evidência Sprint 04A

Cenário C:

- Falha simulada → `isCozinhaOperacional() === false`
- `erro.codigo = COZINHA_MIGRACAO_SIMULADA`
- Schema v2 e dados intactos
- Endpoints Cozinha (já existentes) respondem 503 quando não operacional (`isCozinhaOperacional`)

Cenário E (v1 populado):

- Continua `COZINHA_SCHEMA_UPGRADE_BLOQUEADO` (sem apagar dados)

Nenhuma operação parcial de Cozinha após falha de schema.
