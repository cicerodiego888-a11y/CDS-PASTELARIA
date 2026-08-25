# DUPLICAÇÕES E GAPS — Vendas 05.38.G.A

**Classificação:** SOMENTE LEITURA  
**Data:** 2026-08-24

---

## 1. Duplicações / paralelos

| Item | Evidência | Classificação |
|------|-----------|---------------|
| Writer principal W1 | `VendaPagamentoService.criarVenda` — ~95% tráfego ERP/PDV | **REUTILIZAR** |
| Writer MUV W2 | `MaterializarOperacoesAtendimento.persistirVendaOperacao` | **CONECTAR** — mesma tabela, sem `empresa_id` |
| Writer entrega W3 | `CriarVendaEntregaService` | **CONECTAR** — ramo isolado |
| `VendaApplicationService` | Wrapper — não duplica INSERT | **REUTILIZAR** |
| PDV Universal → `POST /api/vendas` | EmpresaUnicaAdapter delega W1 | **REUTILIZAR** |
| Resolução empresa financeiro | `FinanceiroEmpresaContextoService.resolverEmpresaIdParaFinanceiro` | **REUTILIZAR** (05.38.D) |
| Resolução empresa fiscal W1 | `emitirPorVendaId(vendaId)` sem `empresaId` | **DUPLICADO** vs MUV (`FiscalizarAtendimentoService`) |
| Resolução empresa estoque | `montarOpcoesBaixaEstoqueVenda(req)` — só `req.empresaId` | **P1** — pode divergir de financeiro se resolução parcial |
| COMPAT legado estoque | `debitoEstoqueVendaViaPorta` — `MOTIVO_COMPAT_DEBITO_VENDA` | **P1** em MULTI sem header |
| Segundo motor de vendas | Não encontrado router/service paralelo de persistência além W1/W2/W3 | — |
| PDV Express nomeado | Não encontrado módulo separado; usa `POST /api/vendas` | **REUTILIZAR** (alias legado) |
| Histórico 03.x / 04.x | MUV, PDV Universal, financeiro multi — contexto HTTP sem coluna venda | **REUTILIZÁVEL** como base |

---

## 2. GAPs reais (comprovados)

| GAP | Prioridade | Descrição |
|-----|------------|-----------|
| G1 | **P0** | Tabela `vendas` sem `empresa_id` |
| G2 | **P0** | `GET /api/vendas` e relatórios sem filtro por empresa |
| G3 | **P0** | `GET /:id`, cancelar, devolver, delete por `id` sem ownership |
| G4 | **P0** | Emissão NFC-e (fluxo W1) sem `empresaId` → config global |
| G5 | **P1** | Estoque COMPAT (`produtos`) quando `req.empresaId` null |
| G6 | **P1** | Estorno financeiro cancelamento INSERT sem `empresa_id` |
| G7 | **P1** | `venda_pagamentos` / `venda_recebimentos` sem `empresa_id` |
| G8 | **P1** | Middleware `obrigatorio: false` — venda pode nascer sem contexto explícito |
| G9 | **P1** | Cancelamento estoque usa `req.empresaId` do contexto atual, não da venda |
| G10 | **P1** | MUV: `atendimento_operacoes.empresa_id` existe mas **não** em `vendas` — join obrigatório |
| G11 | **P2** | `vendas_itens`, `vendas_devolucoes`, `vendas_canceladas` sem empresa |
| G12 | **P2** | Fechamento caixa / conciliação agrega vendas por sessão sem filtro empresa na venda |
| G13 | **P2** | Dashboard CIA/MIB agrega `vendas` globalmente |
| G14 | **P3** | Produtos/clientes globais — esperado |

---

## 3. Writers — classificação

| Writer | Arquivo | INSERT | Classificação |
|--------|---------|--------|---------------|
| W1 | `VendaPagamentoService.js` | `vendas` ×2 paths | **REUTILIZAR** (evoluir coluna) |
| W2 | `MaterializarOperacoesAtendimento.js` | `vendas` MUV | **CONECTAR** ao mesmo contrato |
| W3 | `CriarVendaEntregaService.js` | `vendas` ENTREGA | **CONECTAR** |
| — | `tests/**` | fixtures | Fora produção |

**Não é duplicação:** wrappers (`VendaApplicationService`, `PDVUniversalApplicationService`) — delegam.

**Código legado morto:** nenhum segundo INSERT de produção encontrado além W1/W2/W3.

---

## 4. Inferências / heurísticas — encontradas?

| Padrão | Em Vendas hoje? |
|--------|-----------------|
| `configuracoes.cnpj` como empresa da venda | **Não** no INSERT |
| Empresa inventada = 1 | **Não** no writer |
| `getFiscalConfig()` global sem `empresaId` | **Sim** — emissor W1 |
| Backfill automático | **Não** (coluna inexistente) |
| Empresa via `caixa_sessao_id` inferida na venda | **Não** persistida |

---

## 5. Classificação consolidada

| Código | Significado | Itens |
|--------|-------------|-------|
| **P0 BLOQUEADOR** | Isolamento multiempresa impossível na entidade | G1–G4 |
| **P1 ALTO** | Divergência estoque/financeiro/fiscal/cancel | G5–G10 |
| **P2 MÉDIO** | Filhos/relatórios/UX | G11–G13 |
| **P3 BAIXO** | Aceitável | G14 |
| **REUTILIZÁVEL** | Manter e evoluir | W1, middleware, FinanceiroEmpresaContexto, portas estoque, ContratoOperacional, validarCaixaAberto, FiscalizarAtendimentoService (MUV) |
| **CONECTAR** | Mesmo INSERT, falta coluna/guard | W2, W3 |
| **CENTRALIZAR** | Resolução única pré-BEGIN | empresa venda = estoque = financeiro = fiscal |
| **DUPLICADO** | Dois caminhos fiscais | W1 global vs MUV com `empresaId` |

---

## 6. Declaração

Nenhum código alterado nesta auditoria.
