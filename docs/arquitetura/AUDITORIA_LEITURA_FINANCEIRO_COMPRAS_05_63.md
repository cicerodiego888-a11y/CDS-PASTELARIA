# Auditoria — leitura financeira das compras (Sprint 05.63)

**Status:** auditoria (produção não alterada)  
**Data:** 2026-08-29  
**Pergunta:** `GET /api/compras` e `GET /api/compras/:id` podem mostrar dados financeiros da empresa B numa compra da empresa A?

## Resposta

**Sim, se existir vínculo inconsistente** (`financeiro.compra_id` = compra A e `financeiro.empresa_id` = B).

A **compra** está isolada (`compras.empresa_id` / 05.59). O **financeiro anexado** não.

O relatório de uso/consumo (05.62) **não** faz parte deste escopo e permanece filtrado.

## Inventário

| # | Rota | Arquivo | Função | Query | Tabela | Relacionamento | `financeiro.empresa_id`? | Filtro empresa no financeiro? | Ownership da compra | Cross-company |
|---|------|---------|--------|-------|--------|----------------|--------------------------|-------------------------------|---------------------|---------------|
| 1 | `GET /api/compras` | `backend/rotas/compras.js` | handler `router.get('/')` | subquery `COUNT(*)` `parcelas_pendentes` | `financeiro` | `f.compra_id = c.id` + `status = 'pendente'` | coluna existe (05.38.D); **não usada** | **Não** | `WHERE c.empresa_id = ?` via `resolverEmpresaContextoCompra` | **D** — COUNT inflado por lançamentos B/NULL |
| 2 | `GET /api/compras/:id` | mesmo | handler `router.get('/:id')` | `SELECT * FROM financeiro WHERE compra_id = ? ORDER BY numero_parcela, vencimento` | `financeiro` | `compra_id` | existe; **não filtrada** | **Não** | load `compras WHERE id = ?` + `exigirCompraParaMutacaoOpaca` | **D** — payload completo (valor, vencimento, pessoa, `empresa_id`) |
| 3 | `GET /relatorio/uso-consumo` | mesmo | — | 3 subqueries com `f.empresa_id = c.empresa_id` | `financeiro` | compra + empresa | sim | **Sim (05.62)** | `c.empresa_id = ?` | **A** — **fora desta sprint** |

Não há JOIN `financeiro`. Não há helper/repository nesses dois GET. `FinanceiroEmpresaContextoService` é importado no arquivo para **gravação**, não para estes leitores.

## Fonte de ownership

Compra: `compras.empresa_id`. Contexto autoriza a listagem / o detalhe.

Financeiro nestes GET: só `compra_id`. **Não** se usa `financeiro.empresa_id` como dono nem como filtro.

Não se usa financeiro para definir a empresa da compra.

## Cross-company

| Cenário | GET `/` | GET `/:id` |
|---------|---------|------------|
| Compra A, contexto B | B **não lista** A | **404** opaco |
| Compra A, financeiro B no mesmo `compra_id`, contexto A | A lista A; `parcelas_pendentes` **inclui** B | A vê **linhas** de B |
| Compra B, contexto A | A não lista B | 404 se pedir id B |

B **não** consulta a compra A. O risco é **A ver financeiro de B** colado no `compra_id` de A (não listagem cruzada de compras).

## LEGADO_NULL

`financeiro.empresa_id IS NULL` com `compra_id` da compra A: **entra** no COUNT e no `SELECT *`. Sem fallback de ownership. Classificação: **LEGADO_NULL visível**.

## Fallbacks

Nenhum nestes leitores (COMPAT / primeira empresa / COALESCE de empresa no financeiro).

## Fora do escopo (não alterado)

- Relatório uso/consumo (05.62)
- Subqueries `nfe_devolucoes_compra` / `compras_itens` no GET `/`
- INSERT/DELETE/UPDATE financeiro no POST/cancelar
- Central, estoque, fiscal, Motor Comercial

## Classificação

| Ponto | Classe | Risco |
|-------|--------|--------|
| Filtro da lista de compras | **A** | isolamento da linha `compras` |
| GET `/:id` da compra | **B** | 404 cruzado |
| Subquery `parcelas_pendentes` | **D** | agregação sem `f.empresa_id` |
| `SELECT *` financeiro do detalhe | **D** | vazamento de valores/fornecedor/parcelas |
| Relatório 05.62 | **A** | fora do escopo desta auditoria |
| Writers financeiro | **E** | não são leitores |

## Próxima micro-sprint recomendada

**05.64** — isolar leitura: subquery do GET `/` e `SELECT` do GET `/:id` com `financeiro.empresa_id = compras.empresa_id` (LEFT/WHERE, sem INNER forçado, sem backfill, sem alterar 05.62). NULL financeiro não resgata.
