# Relatório — Implementação 05.38.D

**Sprint:** Financeiro por Empresa  
**Classificação:** ESTADO B (código + migration + testes automatizados)  
**Data:** 2026-08-24

---

## 1. Resultado da auditoria inicial

### Tabelas/entidades financeiras encontradas

| Entidade | Papel | empresa_id antes | Deve possuir? | Resolução |
|----------|-------|------------------|---------------|-----------|
| `financeiro` | Lançamentos genéricos + contas a pagar (`tipo=despesa`) + receitas | Não | **Sim** | Contexto / origem venda-compra-caixa |
| `contas_receber` | Parcelas a receber de vendas | Não | **Sim** | Contexto / herança venda→caixa |
| `contas_receber_pagamentos` | Baixas parciais de CR | Não | Não (filho) | Via `conta_receber_id` |
| `venda_recebimentos` | Recebimentos da venda (não ledger) | Não | Fora do escopo ledger | Venda |
| `vendas` | Origem | **Não** (GAP) | Futuro | Contexto operacional na criação do financeiro |
| `compras` | Origem | **Não** (GAP) | Futuro | `req.empresaId` na fronteira Compra→Financeiro |
| `caixa_sessoes` | Origem (05.38.C) | Sim | Já possui | Sessão → financeiro |

**Não existe tabela `contas_pagar` separada** — contas a pagar vivem em `financeiro` (`tipo='despesa'`).

### Pontos de criação auditados

- `backend/rotas/financeiro.js` → `inserirMovimentacao` (manual)
- `backend/rotas/compras.js` → `criarFinanceiroCompra` + devolução
- `backend/rotas/contas_receber.js` → baixa gera receita
- `backend/services/vendas/VendaPagamentoService.js` → CR + financeiro
- `backend/services/vendas/VendaFinanceiroService.js` → estorno devolução

### Uso de `configuracoes.cnpj`

- Extrato agrupado em `financeiro.js` lia `configuracoes` (nome/cnpj) → migrado para `empresas` via `empresa_id`.

---

## 2. Matriz de propagação

```
REQUEST / EVENTO
  → ContratoOperacionalService (+ empresaContexto)
  → empresa_id
  → serviço financeiro existente
  → financeiro / contas_receber
  → consultas filtradas por empresa_id
```

Prioridade na resolução (`FinanceiroEmpresaContextoService`):

1. Origem de domínio (`empresaIdOrigem` — ex.: sessão de caixa)
2. EMPRESA_SIMPLES → empresa operacional do contrato
3. MULTIEMPRESA → `X-Empresa-Id` / `req.empresaId`

---

## 3. Arquivos alterados / criados

### Criados

| Arquivo | Função |
|---------|--------|
| `backend/services/financeiro/FinanceiroEmpresaContextoService.js` | Adaptador de contexto (não motor novo) |
| `backend/utils/financeiroEmpresaHelpers.js` | Migration/backfill + filtro SQL |
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | 20 cenários |
| `docs/IMPLEMENTACAO_05_38_D_RELATORIO.md` | Este relatório |

### Alterados

| Arquivo | Alteração |
|---------|-----------|
| `backend/database.js` | DDL + ALTER `empresa_id` em `financeiro` e `contas_receber`; chama migration |
| `backend/rotas/financeiro.js` | Middleware; inserts; filtros; baixas/delete; extrato sem CNPJ global |
| `backend/rotas/contas_receber.js` | Isolamento + empresa_id em baixa |
| `backend/rotas/compras.js` | `criarFinanceiroCompra` com empresa_id; resolução na fronteira |
| `backend/services/vendas/VendaPagamentoService.js` | Resolve empresa; grava `empresa_id` em CR/financeiro |
| `backend/services/vendas/VendaFinanceiroService.js` | Estorno com `empresa_id` |

---

## 4. Migrations

Idempotentes:

1. `ALTER TABLE financeiro ADD COLUMN empresa_id`
2. `ALTER TABLE contas_receber ADD COLUMN empresa_id`
3. Backfill:
   - origem: `venda → caixa_sessoes.empresa_id`
   - herança: `contas_receber ← financeiro.venda_id`
   - fallback: empresa operacional / única ativa
4. Índices `(empresa_id, status)`

Não apaga dados; não recria tabelas.

---

## 5. Comportamento EMPRESA_SIMPLES

- Empresa resolvida automaticamente pelo contrato
- Frontend sem seletor novo (usa `cds_empresa_id` / ajaxSetup já existente)
- Novos lançamentos nascem com `empresa_id`

## 6. Comportamento MULTIEMPRESA

- Exige contexto válido
- Listagens/baixas/exclusões filtradas por empresa
- Cruzamento entre empresas bloqueado (`FINANCEIRO_EMPRESA_DIVERGENTE`)
- Coerência Caixa↔Financeiro: sessão de outra empresa bloqueia baixa

---

## 7. Origens de empresa

| Origem | Como |
|--------|------|
| Manual | Middleware financeiro |
| Venda | `resolverEmpresaIdParaFinanceiro` no início de `criarVenda` |
| Compra | `garantirEmpresaIdParaFinanceiroCompra` antes de `criarFinanceiroCompra` |
| Caixa | Sessão `empresa_id` validada na baixa com caixa aberto |

---

## 8. Contratos HTTP preservados

- `/api/financeiro/*` (rotas existentes)
- `/api/contas-receber/*`
- Sem `/api/financeiro/empresa/:id/...`

---

## 9. Testes

| Suite | Resultado |
|-------|-----------|
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | **20/20 OK** |
| `tests/caixa/caixa-multiempresa-05-38-c.test.js` | (regressão) |
| `tests/modo-operacional-global-05-38-b.test.js` | (regressão) |
| Caixa fechamento + PDV caixa/contexto | (regressão) |

---

## 10. GAPs reais

1. **`vendas` e `compras` ainda sem coluna `empresa_id`** — documentado; fronteira financeira recebe empresa do contexto/sessão sem alterar schema amplo de vendas/compras nesta sprint.
2. Relatórios financeiros secundários em `financeiro.js` podem ainda precisar revisão pontual adicional em ambiente real (dashboard/listagens centrais já filtrados).
3. **ESTADO B** — sem validação manual completa de operação financeira multiempresa.

---

## 11. Explicitamente NÃO alterado

MUV, checkout, pagamento misto, TEF, PIX, Motor Fiscal, Central de Entradas, estoque, catálogo, promoção, atacado, Dashboard geral, Relatórios gerais, PDV legado — e **não** antecipada 05.38.E.

---

## Critérios

| Critério | Status |
|----------|--------|
| Auditoria + matriz | ✅ |
| `empresa_id` em financeiro e contas_receber | ✅ |
| Sem motor financeiro novo | ✅ |
| Migration idempotente + histórico | ✅ |
| EMPRESA_SIMPLES transparente | ✅ |
| Isolamento MULTIEMPRESA | ✅ |
| Baixas/pagamentos/cancelamentos cruzados bloqueados | ✅ |
| Integrações caixa/compra/venda | ✅ (ponto necessário) |
| Contratos HTTP | ✅ |
| Testes + docs | ✅ |

**Classificação: ESTADO B**
