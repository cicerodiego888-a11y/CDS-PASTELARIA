# Auditoria — uso e consumo de compras (Sprint 05.60)

**Status:** auditoria (produção não alterada)  
**Data:** 2026-08-29  

**Pergunta:** alguma leitura de uso/consumo de compras pode apresentar dados de uma empresa para outra?

## Resposta

Não há tabelas `uso` / `consumo` / `utilizacao`. Uso e consumo é o tipo persistido `compras.tipo_entrada = 'USO_CONSUMO'`.

O dono da linha é **`compras.empresa_id`**. Não existe coluna `uso_consumo.empresa_id`.

O relatório dedicado filtra `AND c.empresa_id = ?` com o contexto (`resolverEmpresaContextoCompra`). Empresa B **não lista** compras USO_CONSUMO da empresa A.

Há um residual: o `LEFT JOIN central_entradas_documentos d ON d.compra_id = c.id` **não** restringe `d.empresa_id`. Se um documento de B estiver vinculado ao `compra_id` de A, o relatório de A pode mostrar `central_chave` / `central_documento_id` da Central de B. Isso não lista a compra de B, mas pode vazar metadado de documento. Classe **D** residual (vínculo), não listagem cruzada de compras.

## Writers vs readers

| Tipo | Quantidade | O quê |
|------|------------|--------|
| Writers de tabela uso/consumo | **0** | Tabelas inexistentes |
| Writers que persistem `tipo_entrada` USO_CONSUMO | **1** | `POST /api/compras` (`continuarGravacao` + auditoria `criar_uso_consumo`) |
| UPDATE/DELETE só de uso/consumo | **0** | Cancelar/devolver são writers genéricos de `compras` (fora desta sprint) |
| Reader dedicado do relatório | **1** | `GET /api/compras/relatorio/uso-consumo` |
| Readers relacionados (mesma origem `compras`) | **2** | `GET /api/compras`, `GET /api/compras/:id` |

O handler do relatório **não** faz INSERT/UPDATE/DELETE.

## Inventário

| Ponto | Arquivo | Tipo | Fonte empresa | Filtro | Classe | Risco |
|-------|---------|------|---------------|--------|--------|-------|
| Relatório uso/consumo | `backend/rotas/compras.js` `GET /relatorio/uso-consumo` | READ | `compras.empresa_id` vs contexto HTTP/contrato | `AND c.empresa_id = ?` + tipo USO_CONSUMO | **A** | lista isolada |
| Datas `inicio`/`fim` | mesmo handler | READ (query) | não é dono | filtro de data, não empresa | **A** | não troca empresa |
| Total `total` | mesmo handler | READ | derivado das linhas filtradas | `rows.length` | **A** | não há COUNT global |
| JOIN Central | mesmo handler | READ | documento por `compra_id` | **sem** `d.empresa_id` | **D** | chave/id de documento alheio se vínculo cruzado |
| Subquery `financeiro` | mesmo handler | READ | `f.compra_id = c.id` | sem `financeiro.empresa_id` | **C** | parcelas da mesma compra; sem filtro empresarial próprio |
| Subquery `auditoria` | mesmo handler | READ | `referencia_id = c.id` + `ORDER BY a.id DESC LIMIT 1` | sem empresa | **C** | `usuario_nome`; ids de compra são globais |
| Listagem compras | `GET /api/compras` | READ | `c.empresa_id` | `WHERE c.empresa_id = ?` | **A** | inclui USO_CONSUMO na lista geral |
| Detalhe por id | `GET /api/compras/:id` | READ | persistido vs contexto | load `WHERE id = ?` + `exigirCompraParaMutacaoOpaca` | **B** | cruzado 404, sem leak (05.59) |
| UI modal | `frontend/erp/js/compras.js` `abrirRelatorioUsoConsumo` | READ UI | header `X-Empresa-Id` via `$.ajaxSetup` / `anexarHeaderXhr` | mesmo GET | **C** | ajax local não seta header; depende do interceptor |
| POST criar USO_CONSUMO | `POST /api/compras` | WRITE | criação (05.56/05.57) | — | **E** | fora do escopo de correção desta sprint |
| Classificar entrada | `POST /classificar-entrada` | READ estático | n/a | não lista compras | **E** | sugestão de tipo |
| Políticas | `GET /politicas-entrada` | READ estático | n/a | — | **E** | catálogo |
| Badge Central | mapper / UI Central | READ | documento/compra | FORA DO ESCOPO | **E** | não alterado |
| Cancelar/devolver | rotas genéricas | WRITE | 05.59 | — | **E** | não é relatório |

Não existem `GET /uso/:id` nem `GET /consumo/:id`.

## Fonte de ownership

```
uso/consumo (tipo na compra)
      ↓
compras.id / compras.tipo_entrada
      ↓
compras.empresa_id   ← dono persistido
```

O contexto (`req.empresaId` / `X-Empresa-Id` / EMPRESA_SIMPLES operacional) **autoriza a leitura**. Não é o dono do registro.

## Consultas globais

| Query | Empresa? | Nota |
|-------|----------|------|
| Relatório `FROM compras c ... AND c.empresa_id = ?` | sim | principal |
| `GET /:id` `SELECT * FROM compras WHERE id = ?` | não no SQL; ownership depois | **B** |
| `LEFT JOIN central_entradas_documentos d ON d.compra_id = c.id` | não em `d` | residual **D** |
| `financeiro` por `compra_id` | não | **C** |
| `auditoria` `ORDER BY a.id DESC LIMIT 1` | não | **C** |
| `SELECT ... FROM uso` / `FROM consumo` | — | **inexistente** |
| Relatório não usa `compras_itens` | — | itens não entram no dataset do relatório |

Não há `ORDER BY ... LIMIT 1` na seleção da **compra** do relatório (só na subquery de auditoria).

## Cross-company (Compra A USO_CONSUMO, contexto B)

| Ação | B consegue? | Classe |
|------|-------------|--------|
| Listar no relatório | **Não** | A |
| Consultar relatório por query `empresa` | N/A (query não aceita empresa) | A |
| Exportar CSV/Excel/PDF | **Não existe** export | — |
| Alterar / excluir via relatório | **Não** (GET only) | A |
| Visualizar fornecedor/valores no relatório | **Não** (linha A não retorna) | A |
| GET `/api/compras/:id` da compra A | **Não** (404 opaco) | B |
| Ver chave de documento Central ligado por `compra_id` errado | **Sim, se vínculo cruzado** | D residual |

## LEGADO_NULL

`AND c.empresa_id = ?` exclui `empresa_id IS NULL`.

Compras USO_CONSUMO sem empresa: **não listadas**, **não associadas** por fallback no relatório, **sem backfill**. Classificação: **LEGADO_NULL**.

`tipo_entrada` NULL usa `COALESCE(..., REVENDA)` e também **não** entra no relatório.

## Fallbacks (somente documentados)

| Ocorrência | Onde | Papel |
|------------|------|--------|
| EMPRESA_SIMPLES → `contrato.empresa_operacional.empresa_id` | `resolverEmpresaContextoCompra` | contexto de leitura, não dono da linha | **C** |
| MULTIEMPRESA sem header | mesmo | 400 `EMPRESA_COMPRA_AUSENTE` | **A** |
| COMPAT / primeira / última / empresa 1 / CNPJ global no relatório | handler | **ausente** | — |
| Header no `$.ajax` do modal | frontend | não envia `X-Empresa-Id` localmente; `core.js` `ajaxSetup` anexa | **C** |

## Relatório (checklist)

1. Filtro empresa: sim (`c.empresa_id`).
2. Paginação: **não** (dataset inteiro da empresa + datas).
3. Totalizador: `total = rows.length` após o mesmo SELECT — alinhado à lista.
4. Subtotais: não.
5. Exportação: não (modal HTML).
6. Detalhes: não há drill-down de API; colunas incluem fornecedor, CNPJ, NF, valor, chave, financeiro, usuário.
7. Ordenação: data DESC, `c.id` DESC.
8. Joins: Central sem `empresa_id` do documento (residual).

## Exportações

Não há CSV, Excel, PDF ou JSON de download dedicado. O GET devolve JSON usado só no modal.

## Próxima micro-sprint recomendada

**05.61** — restringir o JOIN de `central_entradas_documentos` no relatório de uso/consumo (ex.: `AND d.empresa_id = c.empresa_id` ou não projetar chave Central se divergir), **sem** alterar criação, Central, estoque ou listagem geral. Não fazer backfill de NULL.
