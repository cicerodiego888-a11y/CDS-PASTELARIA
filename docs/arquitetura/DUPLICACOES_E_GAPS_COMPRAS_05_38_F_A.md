# DUPLICAÇÕES E GAPS — Compras 05.38.F.A

**Classificação:** SOMENTE LEITURA  
**Data:** 2026-08-24

---

## 1. Duplicações / paralelos

| Item | Evidência | Classificação |
|------|-----------|---------------|
| Único INSERT `compras` | Só `rotas/compras.js` | **REUTILIZÁVEL** — não há segundo writer |
| Parse XML Compras vs Central | `POST /parse-xml` → 410; Central é entrada oficial | **REUTILIZÁVEL** (Central) + legado morto |
| Resolução empresa estoque vs financeiro | `empresaIdDoReqCompra` vs `garantirEmpresaIdParaFinanceiroCompra` / `FinanceiroEmpresaContextoService` | **P1** — duas fontes podem divergir |
| Validação Central `exigirDocumentoCompraMesmaEmpresa` | Compara compraEmpresaId **ou** cai no próprio doc | **P0** — no-op sem empresa na compra |
| COMPAT legado estoque | `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA` | **P1** em MULTI sem header |
| Docs 03.27 / 03.33 | Já descreveram contexto HTTP; não persistiram `empresa_id` em compras | Histórico — **REUTILIZÁVEL** como base |

Não há segundo router de compras nem `ComprasService` paralelo de persistência.

---

## 2. GAPs reais (comprovados)

| GAP | Prioridade | Descrição |
|-----|------------|-----------|
| G1 | **P0** | Tabela `compras` sem `empresa_id` |
| G2 | **P0** | Listagens `GET /` e relatórios sem filtro por empresa |
| G3 | **P0** | Cancelamento/devolver/detalhe por `id` sem checagem de empresa da compra |
| G4 | **P0** | Vincular Central→compra sem comparar documento × contexto da operação efetiva |
| G5 | **P1** | Frontend Compras não envia/usa `empresa_id` do payload Central |
| G6 | **P1** | Estoque permite COMPAT legado quando `req.empresaId` null |
| G7 | **P1** | Financeiro pode resolver empresa operacional enquanto estoque usa legado |
| G8 | **P2** | `compras_itens` / `compras_devolucoes` sem empresa (aceitável se compra tiver) |
| G9 | **P2** | Dashboard/consulta consolidada sem identificação por empresa |
| G10 | **P3** | Fornecedores globais (compartilhados) — esperado |

---

## 3. Inferências por CNPJ / config — encontradas?

| Padrão | Em Compras hoje? |
|--------|------------------|
| `configuracoes.cnpj` como empresa da compra | **Não** no fluxo de insert/estoque (03.27 removeu) |
| Heurística `empresas.length` | **Não** no router de compras |
| Empresa inventada = 1 | **Não** (middleware/porta) |

---

## 4. Classificação consolidada

| Código | Significado | Itens |
|--------|-------------|-------|
| **P0 BLOQUEADOR** | Impede isolamento multiempresa confiável | G1–G4 |
| **P1 ALTO** | Divergência estoque/financeiro/Central | G5–G7 |
| **P2 MÉDIO** | Filhos/UX | G8–G9 |
| **P3 BAIXO** | Aceitável | G10 |
| **REUTILIZÁVEL** | Manter | INSERT único, middleware, portas estoque, Financeiro 05.38.D, Central bridge, CdsEmpresaContexto |
