# Implementação 03.11 — estoque_empresa: fundação de schema

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Schema anterior

Saldos e reservas operacionais em `produtos`:

- `saldo_fiscal` / `saldo_nao_fiscal` (ALTER REAL DEFAULT 0)
- `estoque_atual` (CREATE DECIMAL DEFAULT 0)
- `reservado_fiscal` / `reservado_nao_fiscal` (ALTER REAL DEFAULT 0)

Tabela `empresas` (03.1): `id`, CNPJ, razão, `ativo`, timestamps.

Não existia `estoque_empresa`.

---

## Tabela criada

`estoque_empresa`

| Campo | Tipo |
|---|---|
| id | INTEGER PK AUTOINCREMENT |
| produto_id | INTEGER NOT NULL |
| empresa_id | INTEGER NOT NULL |
| saldo_fiscal | REAL NOT NULL DEFAULT 0 |
| saldo_nao_fiscal | REAL NOT NULL DEFAULT 0 |
| estoque_atual | REAL NOT NULL DEFAULT 0 |
| reservado_fiscal | REAL NOT NULL DEFAULT 0 |
| reservado_nao_fiscal | REAL NOT NULL DEFAULT 0 |
| created_at | DATETIME DEFAULT CURRENT_TIMESTAMP |
| updated_at | DATETIME DEFAULT CURRENT_TIMESTAMP |

`UNIQUE(produto_id, empresa_id)`  
FK `produto_id` → `produtos(id)`  
FK `empresa_id` → `empresas(id)`  

Índice: `idx_estoque_empresa_produto_empresa` (IF NOT EXISTS).

Invariante suportada (`estoque_atual = SF + SNF`): colunas presentes. **Sem trigger. Sem backfill.**

---

## Bootstrap

`backend/services/estoque/estoqueEmpresaSchema.js`  
`garantirSchemaEstoqueEmpresa(db)` — `CREATE TABLE IF NOT EXISTS` + índice único.

Chamado em `database.js` após `produtos` (mesmo padrão 03.1 / 03.3).

Reabrir o banco não apaga dados nem duplica tabela/índice.

---

## O que NÃO foi feito

- Porta continua em `produtos`
- Sem cópia de saldo
- Sem `produto_empresa`
- Sem API / repository / service operacional
- COMPAT intacto
- Campos de `produtos` intactos

---

## Testes

`tests/estoque/estoque-empresa-schema.test.js` — 01–08.

---

## Limitações

Tabela vazia até uma Sprint futura de escrita. Dual-write **não** existe. Storage oficial ainda é `produtos`.
