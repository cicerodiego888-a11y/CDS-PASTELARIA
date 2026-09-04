# SPRINT 05.60

## OBJETIVO

Auditar leituras de uso/consumo ligadas a compras. Produção não alterada.

## 1. QUANTOS WRITERS?

**0** writers de tabela `uso`/`consumo` (não existem).

**1** writer de produção que persiste o tipo `USO_CONSUMO`: `POST /api/compras`.

O relatório `GET /relatorio/uso-consumo` **não** grava.

## 2. QUANTOS READERS?

**1** reader dedicado: `GET /api/compras/relatorio/uso-consumo`.

**2** readers relacionados na mesma origem `compras`: `GET /api/compras`, `GET /api/compras/:id`.

UI: `abrirRelatorioUsoConsumo()` consome o GET dedicado (não é query extra).

## 3–4. ROTAS E SERVICES

| Rota | Service / helper |
|------|------------------|
| `GET /api/compras/relatorio/uso-consumo` | `resolverEmpresaContextoCompra` (inline SQL em `backend/rotas/compras.js`) |
| `GET /api/compras` | mesmo contexto + `WHERE c.empresa_id` |
| `GET /api/compras/:id` | `exigirCompraParaMutacaoOpaca` (05.59) |
| `POST /api/compras` | `classificarFluxoCompra` / `PoliticaEntradaCompra` — **E** (criação) |
| `GET /politicas-entrada`, `POST /classificar-entrada` | política/classificador — **E** |

Não há repository dedicado de uso/consumo.

## 5. TABELAS

`compras` (principal), `financeiro` (subquery), `auditoria` (subquery), `central_entradas_documentos` (JOIN). Relatório **não** consulta `compras_itens`.

## 6. FONTE DE OWNERSHIP

`compras.empresa_id`. Contexto HTTP/contrato só autoriza. Sem coluna própria de uso/consumo.

## 7. QUERIES GLOBAIS

Relatório: filtrado por `c.empresa_id`.  
`GET /:id`: `WHERE id = ?` + ownership.  
JOIN Central e subqueries financeiro/auditoria **sem** empresa no filho.

## 8. CROSS-COMPANY

B não lista nem vê valores/fornecedor de A no relatório. B não altera via relatório. GET por id cruzado: 404. Residual: chave Central se `compra_id` apontar documento de outra empresa.

## 9. NULL

LEGADO_NULL: invisível no relatório (`empresa_id = ?`). Sem fallback no SELECT.

## 10. FALLBACKS

No relatório: nenhum COMPAT/primeira/última/empresa 1. Contexto EMPRESA_SIMPLES via `resolverEmpresaContextoCompra` (já existente). Frontend: header via `ajaxSetup`, não no ajax do modal.

## 11. CLASSIFICAÇÃO

- **A** — filtro do relatório e da listagem `GET /`
- **B** — `GET /:id`
- **C** — subqueries por `compra_id`; interceptor de header; contrato simples como contexto
- **D** — JOIN Central sem `d.empresa_id` (vazamento de chave/id se vínculo cruzado)
- **E** — criação, classificar, políticas, Central UI, cancelar/devolver, estoque/fiscal

## 12. TESTES

`tests/auditoria/ownership-uso-consumo-compras-05-60.test.js` — T01–T10 **10/10**.

## 13. RISCOS

1. Residual **D**: documento Central de outra empresa no JOIN por `compra_id`.
2. LEGADO_NULL invisível (esperado; sem backfill).
3. Paginação ausente (volume por empresa, não isolamento).

## 14. PRÓXIMA MICRO-SPRINT

**05.61** — isolamento do JOIN Central no relatório de uso/consumo. Não corrigir nesta sprint.

## PRODUÇÃO ALTERADA

Nenhuma.
