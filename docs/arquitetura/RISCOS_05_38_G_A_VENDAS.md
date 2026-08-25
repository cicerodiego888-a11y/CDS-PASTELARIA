# RISCOS 05.38.G.A — Vendas por Empresa

**Classificação:** SOMENTE LEITURA  
**Regra:** apenas riscos comprovados no código auditado

---

## P0 — BLOQUEADORES

### R-P0-01 — Venda sem `empresa_id` persistido
**Evidência:** DDL `vendas` em `database.js`; INSERTs em `VendaPagamentoService.js`, `MaterializarOperacoesAtendimento.js`, `CriarVendaEntregaService.js` sem coluna/valor.  
**Efeito:** impossível filtrar, auditar ou proteger ownership pela entidade venda.

### R-P0-02 — Listagem global de vendas
**Evidência:** `GET /api/vendas` em `rotas/vendas.js` — filtros por data/busca/status, **sem** `empresa_id`.  
**Efeito:** MULTIEMPRESA visualiza vendas cruzadas.

### R-P0-03 — Operações por `id` sem ownership
**Evidência:** `GET /:id`, cancelar, devolver, delete — `WHERE id = ?` / `SELECT * FROM vendas WHERE id = ?`.  
**Efeito:** venda lançada sob contexto A pode ser consultada/cancelada em contexto B.

### R-P0-04 — NFC-e com config global (fluxo W1)
**Evidência:** `VendaFiscalService.emitirFiscalSeSolicitado` → `emitirPorVendaId(vendaId)`; `emissor.js` usa `getFiscalConfig({})` se `empresaId` omitido.  
**Efeito:** venda operacional A pode emitir documento com certificado/CSC/ambiente de config B ou global.

### R-P0-05 — Estoque COMPAT em venda sem empresa
**Evidência:** `debitoEstoqueVendaViaPorta` — se `empresaId` null e `exigirEmpresa !== true`, debita `produtos` (legado).  
**Efeito:** MULTI sem header move estoque global, não `estoque_empresa`.

---

## P1 — ALTO RISCO

### R-P1-01 — Divergência estoque × financeiro
**Evidência:** financeiro resolve via `FinanceiroEmpresaContextoService` antes do INSERT; estoque usa `req.empresaId` sem segunda validação cruzada com venda (inexistente).  
**Efeito:** edge cases com header parcial podem divergir.

### R-P1-02 — Middleware `obrigatorio: false`
**Evidência:** `rotas/vendas.js` — `criarMiddlewareContextoEmpresa(db)` sem `{ obrigatorio: true }`.  
**Efeito:** MULTI não forçado no router; venda pode nascer com `req.empresaId` null.

### R-P1-03 — Cancelamento estoque no contexto errado
**Evidência:** `VendaCancelamentoService` — crédito estoque via `req.empresaId` atual, não empresa histórica da venda.  
**Efeito:** cancelar venda A com header B credita estoque B.

### R-P1-04 — Estorno financeiro sem `empresa_id`
**Evidência:** `VendaCancelamentoService` ~INSERT despesa estorno sem `empresa_id`.  
**Efeito:** lançamento órfão ou global em MULTI.

### R-P1-05 — Caixa valida sessão×contexto, não venda×sessão
**Evidência:** `validarCaixaAberto.js` — compara empresa do request com `caixa_sessoes.empresa_id`; venda não tem empresa para comparar.  
**Efeito:** sessão legado sem empresa enfraquece fronteira.

### R-P1-06 — MUV: empresa na operação, não na venda
**Evidência:** `atendimento_operacoes.empresa_id` + `venda_id`; INSERT venda sem empresa.  
**Efeito:** consultas/cancelamentos fora do join MUV perdem ownership.

### R-P1-07 — Pagamentos sem `empresa_id`
**Evidência:** `venda_pagamentos` — só `venda_id`.  
**Efeito:** conciliação/fechamento depende de caixa/contexto HTTP.

---

## P2 — MÉDIO

### R-P2-01 — Relatórios vendas sem filtro empresa
**Evidência:** rotas `GET /api/vendas/relatorio/*` — filtro temporal.

### R-P2-02 — Filhos sem empresa
`vendas_itens`, `vendas_devolucoes`, `vendas_canceladas` — aceitável **se** venda tiver coluna (hoje não tem).

### R-P2-03 — Fechamento caixa agrega por sessão
Vendas ligadas a `caixa_sessao_id`; sem `vendas.empresa_id`, relatório de fechamento depende da sessão estar correta.

### R-P2-04 — Dashboard / MIB / CIA
Agregações em `vendas` sem filtro empresa — exposição consolidada.

---

## P3 — BAIXO

### R-P3-01 — Produtos e clientes globais
Cadastro compartilhado — comportamento esperado.

### R-P3-02 — PDV Express como alias
Mesmo endpoint — não duplica risco estrutural adicional.

---

## Matriz rápida

| ID | Risco | Fronteira | Classificação |
|----|-------|-----------|---------------|
| R-P0-01 | Sem persistência | ORIGEM→VENDA | **AUSENTE** |
| R-P0-02 | Listagem cruzada | CONSULTA | **AUSENTE** |
| R-P0-03 | Cancel cruzado | CANCELAMENTO | **INSEGURO** |
| R-P0-04 | Fiscal global | VENDA→FISCAL | **INSEGURO** |
| R-P0-05 | Estoque legado | VENDA→ESTOQUE | **PARCIAL** |
| R-P1-01 | Fontes diferentes | ESTOQUE×FINANCEIRO | **PARCIAL** |
| R-P1-03 | Estorno contexto B | CANCEL→ESTOQUE | **INSEGURO** |
| R-P1-06 | Join MUV obrigatório | MUV→VENDA | **PARCIAL** |

---

## Fronteiras — classificação SEGURO / PARCIAL / INSEGURO / AUSENTE

| Fronteira | Classificação |
|-----------|---------------|
| ORIGEM → INSERT venda | **AUSENTE** |
| VENDA → estoque (W1) | **PARCIAL** / **INSEGURO** se null |
| VENDA → estoque (MUV reserva) | **SEGURO** |
| VENDA → financeiro (criação) | **PARCIAL** (contexto OK, venda sem ownership) |
| VENDA → caixa | **PARCIAL** |
| VENDA → fiscal (W1) | **INSEGURO** |
| VENDA → fiscal (MUV) | **SEGURO** |
| CONSULTA / cancel / devolver | **AUSENTE** |

---

## O que NÃO foi classificado como risco (sem evidência)

- Quarto writer de produção além W1/W2/W3.  
- Backfill automático existente.  
- Coluna `vendas.empresa_id` em migration não aplicada (não encontrada).  
- Heurística `empresas.length` no router de vendas.

---

## Declaração

Riscos listados são comprovados por leitura de código; nenhuma correção aplicada nesta sprint.
