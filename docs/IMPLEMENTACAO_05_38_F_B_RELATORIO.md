# Relatório — Implementação 05.38.F.B

**STATUS:** ESTADO B  
**Data:** 2026-08-24

---

## 1. Arquivos criados / alterados

### Criados
- `backend/services/compras/ComprasEmpresaContextoService.js`
- `backend/utils/comprasEmpresaHelpers.js`
- `tests/compras-multiempresa-05-38-f-b.test.js`
- `docs/arquitetura/COMPRAS_POR_EMPRESA_V1.md`
- `docs/IMPLEMENTACAO_05_38_F_B_RELATORIO.md`

### Alterados
- `backend/database.js` — DDL/ALTER/migration `compras.empresa_id`
- `backend/rotas/compras.js` — resolução única, INSERT, listagem, GET, cancel, devolver, relatório
- `backend/motores/central-entradas/services/CentralComprasBridgeService.js` — vínculo real
- `frontend/erp/js/compras.js` — preserva `empresa_id` da Central
- `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` — C13 alinhado a `empresaCompraId`

---

## 2. Migration / backfill

Coluna + índice `idx_compras_empresa_id`.  
Ordem: Central → financeiro inequívoco → SIMPLES operacional; MULTI ambíguo = NULL; não sobrescreve.

---

## 3. Resolução

`resolverEmpresaDaCompra` — prioridade Central > HTTP > body > Contrato SIMPLES.

---

## 4. Central / Estoque / Financeiro

Uma `empresaCompraId` no POST; portas estoque com `exigirEmpresa` em MULTI; `criarFinanceiroCompra` com a mesma id; vínculo Central sem fallback mascarador.

---

## 5. Guards / listagens

Filtro `empresa_id` em listagem e relatório; ownership em GET/cancel/devolver.

---

## 6. Testes

`tests/compras-multiempresa-05-38-f-b.test.js` → **16/16 PASS**

Regressões: 05.38.B 17/17 · C 17/17 · D (após ajuste C13) · E 19/19

---

## 7. Gaps remanescentes

- `compras` legadas NULL em MULTI não operáveis até resolução manual
- `compras_itens` / devoluções sem coluna própria (herança — deliberado)
- Fornecedores ainda globais
- Sem validação manual completa SEFAZ/UX

---

## 8. Declaração

ESTADO B: código + migration + testes + docs. Sem homologação manual completa.
