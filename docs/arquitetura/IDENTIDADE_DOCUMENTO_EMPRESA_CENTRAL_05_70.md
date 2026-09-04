# Identidade empresarial do documento Central (Sprint 05.70)

**Status:** implementação  
**Data:** 2026-08-29

## 1. Schema anterior

`chave TEXT NOT NULL UNIQUE` + `empresa_id INTEGER` nullable.

## 2. Problema

`UNIQUE(chave)` global: A+X e B+X não coexistiam. `buscarPorChave(chave)` encontrava o documento de qualquer empresa e podia atualizar XML cruzado.

## 3. Schema novo

`chave TEXT NOT NULL` + `UNIQUE(chave, empresa_id)`.

## 4–5. Constraints

Anterior: UNIQUE na coluna `chave`.  
Nova: `UNIQUE(chave, empresa_id)` (índice único gerado pelo SQLite).

## 6. Migration

Oficial em `database.js` (`inicializarBanco` após 05.38.E):

`migrarIdentidadeUnicaChaveEmpresaDocumentos` (`centralEntradasEmpresaHelpers.js`).

- `PRAGMA table_info` / `index_list` / `index_info`
- Se UNIQUE só em `chave`: rebuild transacional (`PRAGMA foreign_keys=OFF`, tabela temporária, `INSERT…SELECT` de **todas** as colunas, DROP/RENAME, recria índices não únicos)
- Não altera `chave` nem `empresa_id`
- Sem backfill de NULL
- Bancos novos: `CREATE TABLE IF NOT EXISTS` já com o UNIQUE composto

## 7. Writer

`CentralDocumentosRepository.inserir` — `empresa_id` do alvo (`dados.empresaId` / ctor da persistência 05.54). Inalterado na origem.

## 8. Lookup

`buscarPorChave(chave, empresaId)`  
`WHERE chave = ? AND empresa_id = ?`  
Sem empresa válida → `null` (não consulta global).

## 9. Fonte do empresaId

Alvo da sync / DistDFe `empresaIdPersistencia` / upload `resolverEmpresaParaCentral`. Repository não resolve HTTP.

## 10. NULL

Permanece NULL. Lookup da empresa A não encontra. SQLite ainda permite vários NULL no UNIQUE composto — não é ownership.

## 11. EMPRESA_SIMPLES

INSERT e lookup usam a empresa operacional já injetada no alvo único.

## 12. MULTIEMPRESA

Cada alvo: `buscarPorChave(X, alvo.empresaId)` + INSERT daquele `empresaId`. A+X, B+X, C+X coexistentes.

## 13. Cross-company

Lookup B não devolve A; persistência B não faz UPDATE em A.

## 14. GET `/buscar-chave`

Usa `contexto.empresaId` **somente** se `obterContextoOperacional` já o tiver (em geral o GET não passa alvo). Sem empresa → `documento: null` (não vaza). **RISCO 05.70.2:** MULTIEMPRESA/GET sem alvo não anexa o inbox.

## 15. XML devolução

`carregarXmlNfeCompraOrigem` ainda `WHERE REPLACE(chave…) LIMIT 1` sem `empresa_id`. Fora da persistência DistDFe. **Não corrigido. RISCO 05.70.1.**

## 16. Riscos não corrigidos

- 05.70.1 XML devolução por chave global
- 05.70.2 GET buscar-chave sem `empresaId` no contexto
- 05.70.3 vários `empresa_id` NULL + mesma chave (SQLite)
- testes/certificação que limpavam por chave global sem empresa
