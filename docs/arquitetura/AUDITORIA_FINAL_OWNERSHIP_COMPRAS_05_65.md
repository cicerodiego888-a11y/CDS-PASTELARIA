# Auditoria final — ownership do módulo compras (Sprint 05.65)

**Status:** auditoria (produção não alterada)  
**Data:** 2026-08-29  
**Base:** sprints 05.56–05.64

## Pergunta

Ainda existe caminho em que a empresa A opera/visualiza a **compra** da empresa B, ou a **compra A** puxa dados relacionados da empresa B?

## Resposta objetiva

A **compra** (linha `compras`, lista, detalhe, cancelar, devolver, PUT chave, financeiro anexado, relatório uso/consumo + JOIN Central) está isolada no contrato 05.56–05.64.

Ainda há caminhos **no domínio compras** (rotas em `backend/rotas/compras.js` ou services chamados por elas) sem o mesmo guard:

| # | Caminho | A opera/vê compra B? | Compra A puxa dados B? | Classe |
|---|---------|----------------------|------------------------|--------|
| 1 | `GET/POST …/nfe-devolucao*` e `emitir-nfe-devolucao` | **Sim** — load `compras`/`itens`/`nfe_devolucoes_compra` só por id | possível | **D** |
| 2 | Duplicidade `chave_acesso` no POST `/` (`LIMIT 1` global) | vaza `#id` e bloqueia lançamento cruzado | — | **D** |
| 3 | `existeCompraComChave` (Central) | mesmo padrão de chave global | — | **E** (Central; relacionado) |
| 4 | `UPDATE compras` na devolução só `WHERE id = ?` | não, se o guard 05.59 rodou | — | **C** |
| 5 | `historicoFornecedor` no classificador | não vê a compra; agrega tipos por CNPJ **global** | estatística de B | **C** |
| 6 | GET `/` subqueries `nfe_devolucoes_compra` | não lista compra B | totais fiscais se vínculo cruzado | **C** |
| 7 | Auditoria do relatório (sem coluna `empresa_id`) | não | usuário se JSON sem empresa | **C** (05.62) |

Estoque no cancelar/devolver usa `empresaCompraId` persistido após o guard — **A**, não reauditado como mutação de estoque (fora de correção).

## Writers de produção (`compras` / satélites do fluxo)

| Writer | Onde | Empresa | Classe |
|--------|------|---------|--------|
| `INSERT INTO compras` | `POST /api/compras` `continuarGravacao` | `resolverEmpresaDaCompra` (HTTP/body/Central/SIMPLES) | **A**/ **C** (05.56/05.57) |
| `INSERT compras_itens` | mesmo POST | herda a compra | **A** |
| `INSERT`/`DELETE` financeiro | POST / regravação | `empresa_id` da compra | **A** (writer; não esta auditoria de leitura) |
| `INSERT compras_devolucoes` | `POST /:id/devolver` | após 05.59 | **B** |
| `UPDATE compras` devolução | `WHERE id = ?` | guard prévio | **C** |
| `UPDATE compras` cancelar | `WHERE id = ? AND empresa_id = ?` | persistido | **A** |
| `UPDATE financeiro` cancelar | `compra_id` + `empresa_id OR NULL` | NULL ainda cancelado | **C** |
| `UPDATE compras.chave_acesso` | PUT chave | `id AND empresa_id` (05.58) | **A** |
| `backfillComprasEmpresaId` | helper | admin/migração | **E** |
| `database.js` / MUC `UPDATE compras_itens` | schema/migração | **E** | |

Um INSERT de linha `compras` em produção.

## Leitores principais (já corrigidos)

| Rota | Ownership | Classe |
|------|-----------|--------|
| `GET /` | `c.empresa_id` + financeiro 05.64 | **A** |
| `GET /:id` | 05.59 + financeiro `compra.empresa_id` | **B**+**A** |
| Relatório uso/consumo | 05.61 JOIN + 05.62 financeiro | **A** |
| PUT chave | 05.58 | **A** |
| cancelar / devolver | 05.59 404 | **B** |

Itens: `compras_itens.compra_id` após a compra autorizada — **A** (sem coluna empresa no item).

## Cross-company (matriz resumida)

| Ação | Contexto B, compra A |
|------|----------------------|
| Listar | não |
| GET `/:id` / cancelar / devolver / PUT chave | 404 |
| Relatório uso/consumo | não lista; Central/financeiro B não anexam |
| POST criar mesma chave de A | **400 com id da compra A** |
| `GET /:id/nfe-devolucao/preparar` (e emitir/histórico) | **carga da compra A** (fornecedor, NF, itens, saldos) |

## NULL

Compra `empresa_id` NULL: fora da lista; GET/mutação `EMPRESA_OWNERSHIP_REQUIRED` / 409. Sem backfill nesta sprint.

## Fora do escopo (não alterado; registro)

- `rotas/produtos.js` última compra por produto sem `compras.empresa_id`
- `rotas/financeiro.js` `SELECT * FROM compras WHERE id = ?`
- Motor Comercial, PDV, lotes, FEFO
- DistDFe / MIIP além do `existeCompraComChave` citado

## Próxima micro-sprint recomendada

**05.66** — ownership opaco nas rotas de **NF-e de devolução de compra** (`preparar`, `historico`, `emitir`, e por `notaId` se vazar XML/DANFE), reutilizando `exigirCompraParaMutacaoOpaca` / empresa da nota. Não misturar com DistDFe.

Alternativa: escopo de **chave duplicada** por `empresa_id` no POST `/` (não revelar id cruzado).
