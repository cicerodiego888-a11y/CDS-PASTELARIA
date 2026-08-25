# Relatório — Auditoria 05.38.F.A

**STATUS:** AUDITORIA CONCLUÍDA — SEM ALTERAÇÃO DE CÓDIGO  
**Data:** 2026-08-24  
**Classificação:** SOMENTE LEITURA

---

## 1. Arquivos auditados (principais)

| Área | Arquivos |
|------|----------|
| Schema | `backend/database.js` (compras, itens, devoluções, fornecedores, financeiro, central, estoque) |
| API | `backend/rotas/compras.js` (~2140 linhas) |
| Estoque compra | `creditoEstoqueCompraViaPorta.js`, `debitoEstoqueCompraViaPorta.js`, `estoqueAtualValidacaoCompra.js` |
| Estoque porta | `estoqueSaldosPublico.js`, `empresaContexto.js` |
| Financeiro | `FinanceiroEmpresaContextoService.js` (via compras) |
| Central | `CentralComprasBridgeService.js`, `CentralEntradasOrchestrator.js`, `rotas/central-entradas.js` |
| Frontend | `frontend/erp/js/compras.js`, `central-entradas.js`, `cds-empresa-contexto.js`, `core.js` (ajaxSetup) |
| Modo | `ContratoOperacionalService` (referência) |
| Histórico | `IMPLEMENTACAO_03_27_*`, `IMPLEMENTACAO_03_33_*` |

**Módulos analisados:** ~18  
**Tabelas analisadas:** 10+ (`compras`, `compras_itens`, `compras_devolucoes`, `fornecedores`, `financeiro`, `central_entradas_documentos`, `estoque_empresa`, `produtos`, `auditoria`, nfe devolução compra)

---

## 2. Origens de compra encontradas

1. **Manual ERP** → `POST /api/compras`  
2. **Central de Entradas** → abrir-compra → mesma `POST /api/compras` + `central_documento_id`  
3. **Uso/consumo / NF avulsa** → mesma rota, ramo simplificado  
4. **Parse XML em Compras** → **descontinuado (410)**  
5. **MIIP / Review** → não inserem compra; alimentam documento  

**Único INSERT:** `backend/rotas/compras.js`.

---

## 3. Mapa de propagação (resumo)

```
UI / Central
  → POST /api/compras (+ X-Empresa-Id opcional)
  → middleware empresa (não obrigatório)
  → INSERT compras (SEM empresa_id)
  → estoque via req.empresaId | COMPAT legado
  → financeiro via req | ContratoOperacional
  → vincular Central (sem empresa da compra)
```

Detalhe: `docs/arquitetura/MAPA_PROPAGACAO_COMPRAS_05_38_F_A.md`

---

## 4. Contexto empresarial encontrado

| Fonte | Uso em Compras |
|-------|----------------|
| `X-Empresa-Id` / `req.empresaId` | Sim (middleware + estoque) |
| Body `empresa_id` | Possível via middleware; frontend **não envia** |
| `ContratoOperacionalService` | Indireto via financeiro se header ausente |
| Documento Central `empresa_id` | No payload abrir-compra; **não** no POST final |
| `configuracoes.cnpj` | Não como autoridade da compra atual |
| Persistido em `compras` | **Não** |

Classificação por fronteira: ver mapa (SEGURO / PARCIAL / INSEGURO / AUSENTE).

---

## 5. Reutilizações disponíveis

ContratoOperacional, empresaContexto, portas estoque, estoque_empresa, FinanceiroEmpresaContexto, CentralEntradasEmpresaContexto, CentralComprasBridge, CdsEmpresaContexto, INSERT único.

---

## 6. Duplicações e GAPs

Ver `DUPLICACOES_E_GAPS_COMPRAS_05_38_F_A.md`.  
Principais: persistência ausente; listagem/cancel sem ownership; validação Central no-op; COMPAT estoque.

---

## 7. Riscos P0 / P1 / P2 / P3

| Nível | IDs |
|-------|-----|
| P0 | R-P0-01…04 (schema, listagem, ownership, Central) |
| P1 | R-P1-01…04 (COMPAT, divergência fin/estoque, middleware, cancel fin) |
| P2 | Relatórios, filhos, validação dependente de header |
| P3 | Fornecedores globais, parse 410 |

---

## 8. Recomendação arquitetural

Não criar segundo motor de compras. Evoluir o `POST /api/compras` existente:

1. Persistir `compras.empresa_id`.  
2. Resolver empresa uma vez (Central doc > contexto HTTP > Contrato SIMPLES).  
3. Propagar o **mesmo** id para estoque e financeiro.  
4. Guardas em listagem/detalhe/cancel/devolver.  
5. Validação real documento Central × empresa da operação.  
6. Em MULTIEMPRESA: eliminar COMPAT silencioso na entrada de estoque.

---

## 9. Ordem sugerida para 05.38.F.B

1. Migration idempotente + backfill seguro  
2. INSERT + resolução única  
3. Guards GET/cancel/devolver  
4. Central vincular + frontend/contexto  
5. Listagens filtradas  
6. `exigirEmpresa` estoque em MULTI  
7. Suite testes + relatório ESTADO B  

---

## 10. Declaração

Nenhum arquivo de código de produção/teste foi alterado nesta sprint. Apenas documentação de auditoria foi criada.
