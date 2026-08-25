# Relatório — Auditoria 05.38.G.A

**STATUS:** AUDITORIA CONCLUÍDA — SEM ALTERAÇÃO DE CÓDIGO  
**Data:** 2026-08-24  
**Classificação:** SOMENTE LEITURA

---

## 1. Status da auditoria

| Item | Resultado |
|------|-----------|
| Objetivo | Mapear estrutura atual de Vendas × empresa operacional |
| Código alterado | **Nenhum** |
| Schema alterado | **Nenhum** |
| Migrations | **Nenhuma** |
| Resposta central | **`vendas.empresa_id` → AUSENTE** |

---

## 2. Módulos e arquivos auditados

| Área | Arquivos |
|------|----------|
| Schema | `backend/database.js` (vendas, itens, pagamentos, devoluções, financeiro, caixa, estoque, nfce) |
| API vendas | `backend/rotas/vendas.js` |
| API PDV Universal | `backend/rotas/pdv-universal.js` |
| Writers | `VendaPagamentoService.js`, `MaterializarOperacoesAtendimento.js`, `CriarVendaEntregaService.js` |
| Orquestração | `VendaApplicationService.js`, `PDVUniversalApplicationService.js` |
| Cancel/devolução | `VendaCancelamentoService.js`, `VendaDevolucaoService.js`, `VendaFinanceiroService.js` |
| Estoque | `debitoEstoqueVendaViaPorta.js`, `creditoEstoqueVendaViaPorta.js` |
| Fiscal | `VendaFiscalService.js`, `emissor.js`, `FiscalizarAtendimentoService.js` |
| Caixa | `validarCaixaAberto.js`, `CaixaEmpresaContextoService.js` |
| Contexto | `empresaContexto.js`, `ContratoOperacionalService`, `FinanceiroEmpresaContextoService.js` |
| MUV | `atendimentoSchema.js`, `MaterializarOperacoesAtendimento.js` |
| Frontend | `cds-empresa-contexto.js`, PDV Universal (header) |

**Módulos analisados:** ~22  
**Tabelas analisadas:** 15+

---

## 3. Todas as origens de venda encontradas

| # | Origem | Endpoint | Writer | Empresa persistida na venda? |
|---|--------|----------|--------|------------------------------|
| O1 | PDV Universal | `POST /api/pdv-universal/checkout` | W1 (via adapter) | **Não** |
| O2 | PDV legado / ERP PDV | `POST /api/vendas` | W1 | **Não** |
| O3 | ERP manual | `POST /api/vendas` | W1 | **Não** |
| O4 | Entrega | `POST /api/vendas` (`tipo_venda=ENTREGA`) | W3 | **Não** |
| O5 | MUV materializar | `POST .../materializar` | W2 | **Não** (sim em `atendimento_operacoes`) |
| O6 | MUV preview MULTI | `POST /api/vendas` | — (atendimento only) | **Não** |
| O7 | Faturamento | `POST /api/vendas` (origem FATURAMENTO) | W1 | **Não** |
| O8 | Pedido → venda | `pedido_id` no body | W1 | **Não** |
| O9 | PDV Express | Não encontrado módulo separado | W1 (alias) | **Não** |

---

## 4. Todos os writers de `vendas`

| ID | Arquivo | Linhas ~ | Observação |
|----|---------|----------|------------|
| W1 | `VendaPagamentoService.js` | 1069, 1391 | **Principal** — prazo + normal |
| W2 | `MaterializarOperacoesAtendimento.js` | 177 | MUV MULTI |
| W3 | `CriarVendaEntregaService.js` | 261 | ENTREGA |

**Classificação:** múltiplos writers (3), **W1 canônico** para ERP/PDV. Wrappers não duplicam INSERT.

---

## 5. Schema: PRESENTE / AUSENTE / PARCIAL

| Tabela | `empresa_id` |
|--------|--------------|
| `vendas` | **AUSENTE** |
| `vendas_itens` | AUSENTE |
| `venda_pagamentos` | AUSENTE |
| `vendas_devolucoes` | AUSENTE |
| `financeiro` | **PRESENTE** |
| `contas_receber` | **PRESENTE** |
| `caixa_sessoes` | **PRESENTE** |
| `estoque_empresa` | **PRESENTE** |
| `nfce_notas` | **PRESENTE** (coluna) |
| `atendimento_operacoes` | **PRESENTE** |

---

## 6. Mapa completo de propagação

Ver `docs/arquitetura/MAPA_PROPAGACAO_VENDAS_05_38_G_A.md`.

Resumo:

```
Origem → req.empresaId (contexto) → INSERT vendas (SEM empresa_id)
  → itens (sem empresa)
  → estoque (req.empresaId | COMPAT)
  → pagamentos (sem empresa)
  → financeiro/contas_receber (empresa_id = req.empresaId)
  → caixa (sessão com empresa_id; venda só caixa_sessao_id)
  → fiscal W1 (sem empresaId → global) | MUV (com empresaId)
  → cancel/devolver (id only + req.empresaId estorno)
```

---

## 7. EMPRESA_SIMPLES

- `FinanceiroEmpresaContextoService` resolve empresa operacional antes do INSERT financeiro.
- Venda **não** persiste empresa.
- Estoque usa mesma `req.empresaId` após resolução financeira (normalmente alinhado).
- Fiscal W1 **não** usa resolução — risco de config global ≠ operacional.

**Possibilidade A/B/C cruzada:** sim, em consulta/cancel/fiscal; estoque/financeiro na criação tendem a alinhar se header/contrato consistentes.

---

## 8. MULTIEMPRESA

- Middleware **não** obriga empresa no router vendas.
- POST MULTI cria atendimento, não venda direta.
- Materialização W2 grava operação com `empresa_id`, venda sem.
- Estoque na reserva MUV exige empresa.
- GET/cancel **sem filtro** — cruzamento P0.

---

## 9. VENDA × CAIXA

- `caixa_sessoes.empresa_id` presente (05.38.C).
- `vendas.caixa_sessao_id` presente; **`vendas.empresa_id` ausente**.
- Sistema compara sessão×contexto HTTP, **não** venda×sessão×empresa.
- Venda A com sessão de caixa B: mitigado parcialmente se sessão validada no cancel; criação depende de `validarCaixaSeOrigemPdv`.

---

## 10. VENDA × ESTOQUE

- Porta: `debitoEstoqueVendaViaPorta` / crédito devolução/cancel.
- Empresa: `req.empresaId`; COMPAT se null.
- **Classificação:** PARCIAL (INSEGURO sem header em MULTI).

---

## 11. VENDA × FINANCEIRO

- `financeiro.empresa_id` e `contas_receber.empresa_id` na criação.
- Fonte: `req.empresaId` resolvido uma vez — **não** da venda.
- Cancelamento: por `venda_id`; estorno INSERT **sem** `empresa_id`.
- **Classificação:** PARCIAL.

---

## 12. VENDA × FISCAL

- W1: `emitirPorVendaId(vendaId)` — **sem** `empresaId` → config global possível.
- MUV: `FiscalizarAtendimentoService` — **com** `empresaId` da operação.
- **Pergunta obrigatória:** venda A pode emitir como B? **Sim**, no fluxo W1.

---

## 13. PAGAMENTOS

- `venda_pagamentos` sem `empresa_id`.
- Pagamento misto/PIX/cartão/dinheiro/TEF: herdam vínculo `venda_id` + caixa/contexto HTTP.
- Sem coluna empresa nos pagamentos.

---

## 14. CANCELAMENTO / DEVOLUÇÃO

| Operação | Filtro empresa |
|----------|----------------|
| GET /:id | **Não** |
| Cancelar | **Não** (id only) |
| Devolver | **Não** |
| Delete | **Não** |
| Reimpressão | Depende rota — sem ownership venda |

**GAP:** entidade venda sem `empresa_id`.

---

## 15. LISTAGENS / RELATÓRIOS

| Item | Filtro empresa | Classificação |
|------|----------------|---------------|
| GET /api/vendas | Não | **P0** |
| Relatórios fechamento | Não na venda | **P2** |
| Histórico cliente | Não verificado em profundidade | **P2** |
| Dashboard CIA/MIB | Global | **P2** |

---

## 16. DUPLICAÇÕES E GAPS

Ver `docs/arquitetura/DUPLICACOES_E_GAPS_VENDAS_05_38_G_A.md`.

Principais: 3 writers conectáveis; fiscal duplicado W1 vs MUV; ownership ausente; COMPAT estoque.

---

## 17. RISCOS P0 / P1 / P2 / P3

Ver `docs/arquitetura/RISCOS_05_38_G_A_VENDAS.md`.

| Nível | Qtd | Exemplos |
|-------|-----|----------|
| P0 | 5 | Sem `empresa_id`; listagem; cancel cruzado; fiscal global; estoque COMPAT |
| P1 | 7 | Divergência fronteiras; estorno; MUV join; pagamentos |
| P2 | 4 | Relatórios; filhos; fechamento |
| P3 | 2 | Cadastros globais |

---

## 18. Componentes reutilizáveis

ContratoOperacional, empresaContexto, FinanceiroEmpresaContexto, CaixaEmpresaContexto, validarCaixaAberto, portas estoque, FiscalizarAtendimentoService (padrão fiscal), PDVUniversalContextService, CdsEmpresaContexto, W1 como writer canônico.

**VendaEmpresaContextoService:** **não existe**; **provavelmente necessário** em G.B (adaptador fino, padrão Compras/Financeiro).

---

## 19. Recomendação para 05.38.G.B

1. Adicionar `vendas.empresa_id` + índice + backfill seguro (caixa_sessao → atendimento_operacoes → financeiro → nfce; MULTI ambíguo = NULL).  
2. Resolução única pré-BEGIN nos três writers.  
3. Guards GET/cancel/devolver/listagens.  
4. Fiscal: sempre passar `empresaId` (alinhar W1 ao MUV).  
5. Estoque MULTI: `exigirEmpresa: true`.  
6. Estorno cancelamento com `empresa_id`.  
7. Avaliar `VendaEmpresaContextoService` (adaptador, não motor).  
8. Testes de isolamento A≠B.

Detalhe: `docs/arquitetura/PLANO_REAPROVEITAMENTO_VENDAS_05_38_G_A.md`.

---

## 20. Documentos produzidos

| Documento |
|-----------|
| `docs/arquitetura/AUDITORIA_05_38_G_A_SCHEMA_VENDAS.md` |
| `docs/arquitetura/MAPA_PROPAGACAO_VENDAS_05_38_G_A.md` |
| `docs/arquitetura/DUPLICACOES_E_GAPS_VENDAS_05_38_G_A.md` |
| `docs/arquitetura/PLANO_REAPROVEITAMENTO_VENDAS_05_38_G_A.md` |
| `docs/arquitetura/RISCOS_05_38_G_A_VENDAS.md` |
| `docs/IMPLEMENTACAO_05_38_G_A_RELATORIO.md` (este arquivo) |

---

## 21. Declaração explícita

**Nenhum arquivo de código de produção ou teste foi alterado nesta auditoria.**

---

## 22. Metodologia

Alinhada à **05.38.F.A — Compras por Empresa**: leitura estrutural, grep de INSERTs, matriz de tabelas, mapa de propagação, matriz de risco com evidência, plano de reaproveitamento sem implementação.
