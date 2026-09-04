# Auditoria e fundação multiempresa do MIS (Sprint 04.01)

**Tipo:** auditoria + fundação. **Bloco 6 (Gestão consolidada):** não implementado. **MUC:** não implementado. **Central / PDV Universal / operação de venda:** não reabertos.

**Distinção obrigatória**

| | MIS (Bloco 4) | Gestão consolidada (Bloco 6) |
|--|---------------|------------------------------|
| Escopo | Empresa do contexto / operacional | Grupo, comparação, soma A+B+C |
| “Todas as empresas” | Proibido como extensão do MIS | Única sede futura dessa visão |

---

## 1. Arquitetura atual

Não havia módulo `services/mis` antes desta sprint. Indicadores viviam em:

- `GET /api/dashboard/resumo` — painel ERP (`frontend/erp/js/dashboard.js` + command center)
- Relatórios de venda em `backend/rotas/vendas.js`
- Financeiro em `backend/rotas/financeiro.js` (já com `anexarEmpresaFinanceiro`)
- Monitoring Engine (`backend/monitoring/`) — COP / Central de Monitoramento
- Central de Entradas dashboard (fechada, **não-MIS**)
- Plugins CIA / smart-dashboard (fora do MIS operacional)

**Fundação 04.01**

```
contexto (ContratoOperacional + X-Empresa-Id)
  → usuario_empresas (autorização)
  → MisIndicadoresService / dashboard SQL
  → entidade.empresa_id
  → resultado daquela empresa
```

Arquivos: `backend/services/mis/MisEmpresaContextoService.js`, `MisIndicadoresService.js`.  
Reutiliza `resolverEmpresaIdParaVenda` (sem novo contexto HTTP). Autorização **sempre** no MIS, inclusive EMPRESA_SIMPLES.

---

## 2. Indicadores existentes (matriz)

| Indicador | Tela | API | Service/SQL | Origem | empresa_id? | Período (data oficial) | Status | Classe |
|-----------|------|-----|-------------|--------|-------------|------------------------|--------|--------|
| Faturamento período | Dashboard | `/api/dashboard/resumo` | `vendas` + `getExprValorVenda` | vendas | **SIM** (04.01) | `data_venda` | PRODUÇÃO | MIS |
| Faturamento hoje | Dashboard | idem | idem | vendas | SIM | `data_venda` (hoje local) | PRODUÇÃO | MIS |
| Nº vendas / ticket | Dashboard | idem | COUNT/AVG vendas | vendas | SIM | `data_venda` | PRODUÇÃO | MIS |
| Lucro estimado | Dashboard | idem | itens × `preco_compra` | vendas_itens + produtos | SIM na venda | `data_venda` | PRODUÇÃO | MIS (custo catálogo global — P2) |
| Qtd produtos vendidos | Dashboard | idem | qtd itens | vendas_itens | SIM | `data_venda` | PRODUÇÃO | MIS |
| Ranking mais/menos | Dashboard + `/api/produtos/ranking-vendas` | `sqlRankingProdutosDaEmpresa` | vendas INNER JOIN | **SIM** (INNER; LEFT JOIN filtrado somava itens de outras empresas) | `data_venda` | PRODUÇÃO | MIS |
| Ranking HTTP vendas | — | `/api/vendas/relatorio/produtos-mais-vendidos` | SQL na rota | vendas | **já tinha** `v.empresa_id` | `data_venda` | PRODUÇÃO | MIS |
| Vendas por forma | Dashboard | resumo | GROUP BY forma | vendas | SIM | `data_venda` | PRODUÇÃO | MIS |
| Fechamento caixa (rel.) | — | `/api/vendas/relatorio/fechamento-caixa` | rota vendas | vendas | SIM | `data_venda` | PRODUÇÃO | MIS / caixa |
| Vendas por dia | — | `/api/vendas/relatorio/periodo` | rota vendas | vendas | SIM | `data_venda` | PRODUÇÃO | MIS |
| Estoque baixo | Dashboard | resumo | `estoque_empresa` JOIN produtos | estoque_empresa | **SIM** (04.01; antes `produtos` global) | saldo atual | PRODUÇÃO | MIS |
| Validade / vencidos | Dashboard | resumo | produtos + ee | dual | SIM (04.01 via ee) | `data_validade` | PRODUÇÃO | MIS |
| Contas a receber | Dashboard | resumo | contas_receber + financeiro | fin | SIM (04.01) | saldo aberto (não é competência de venda) | PRODUÇÃO | MIS |
| Contas a pagar | Dashboard | resumo | financeiro despesa | fin | SIM | saldo aberto | PRODUÇÃO | MIS |
| Recebimentos venda | Dashboard | resumo | venda_recebimentos | vendas | SIM | `data_venda` | PRODUÇÃO | MIS |
| Dashboard financeiro | Financeiro | `/api/financeiro/dashboard` | `filtroEmpresaSql` | financeiro | SIM (pré-04.01) | vencimento / movimento | PRODUÇÃO | MIS |
| Relatórios fin. | Financeiro | `/relatorios/*` | rotas | financeiro | SIM | varia | PRODUÇÃO | MIS |
| Ranking helper legado | — | `sqlRankingProdutos` | LEFT JOIN sem empresa | vendas | **NÃO** | período no JOIN | LEGADO | não usar no MIS |
| ultimas-compras | Produto | `/api/produtos/:id/ultimas-compras` | JOIN compras | compras | **NÃO** | data compra | PRODUÇÃO | RISCO consulta |
| Monitoring financeiro | Monitoramento | engine | FinanceiroProvider | contas_receber | **NÃO** | vários | PRODUÇÃO | RISCO / NÃO-MIS até isolar |
| Central dashboard | Central | `/api/central-entradas/dashboard` | Central* | documentos | SIM (05.xx) | — | PRODUÇÃO | NÃO-MIS (fechada) |
| Equipamentos / backup / auditoria no dashboard | Dashboard | resumo | vários | instalação | N/A | — | PRODUÇÃO | GLOBAL INTENCIONAL |
| Smart-dashboard plugin | plugin | `/api/plugins/dashboard` | CIA | — | — | — | PLUGIN | NÃO-MIS |

---

## 3. Dashboards

| Nome | Status 04.01 |
|------|----------------|
| ERP Dashboard (`data-page=dashboard`) | SEGURO nos cards de venda/estoque/fin (fundação) |
| Command Center (UX sobre o mesmo payload) | COMPARTILHADO |
| Financeiro dashboard | SEGURO (já isolado) |
| Monitoring Engine | RISCO (providers comerciais/financeiros globais) |
| Central / Faturamento NF-e / Equipamentos | NÃO-MIS |

---

## 4–8. Relatórios, APIs, services, repositories, SQLs

Ver matriz §2. Repositório MIS: nenhum repository dedicado; SQL no service + rotas. Preferência: contexto validado → `MisIndicadoresService` → SQL.

**Ranking (item 7 da sprint):**  
`GET /api/vendas/relatorio/produtos-mais-vendidos` já filtrava `FROM vendas v ... AND v.empresa_id = ?`.  
O risco do Bloco 3 era `sqlRankingProdutos` (LEFT JOIN `produtos` ← `vendas_itens` ← `vendas` com filtro só no JOIN de `v`): itens de outra empresa continuavam no `SUM(vi.*)` com `v` nulo. Correção: `sqlRankingProdutosDaEmpresa` com **INNER JOIN vendas** e `WHERE v.empresa_id = ?`. Helper legado intacto.

---

## 9–11. empresa_id, contexto, autorização

- EMPRESA_SIMPLES: `empresa_operacional_id` (nunca primeira/1/COMPAT).
- MULTIEMPRESA: `req.empresaId` / `X-Empresa-Id`.
- Autorização: `UsuarioEmpresaService.exigirEmpresaAutorizada` no MIS.

---

## 12–17. Ranking, vendas, estoque, compras, financeiro, fiscal

Vendas MIS: `data_venda` + `FILTRO_VENDA_VALIDA`. F/NF via `valor_fiscal` / `valor_nao_fiscal`.  
Estoque MIS: `estoque_empresa` (não `produtos.estoque_atual=999` de exemplo). Dual-write permanece risco de **escrita**, não deste leitor.  
Compras MIS: `compras.empresa_id` + `data_compra`. `ultimas-compras` ainda global.  
Financeiro MIS service: `contas_receber.empresa_id`. Dashboard financeiro já isolado.  
Fiscal MIS: NFC-e via `nfce_notas` JOIN `vendas.empresa_id`; data `COALESCE(created_at, data_venda)` (coluna `data_emissao` pode não existir no schema atual).

---

## 18. Período

Não misturar faturamento (`data_venda`) com receber em aberto (saldo) nem com `data_compra`.

---

## 19–22. Problemas e classificação

**P0:** nenhum restante no dashboard oficial após a fundação.

**P1:** Monitoring Engine (FinanceiroProvider sem empresa); `ultimas-compras`; dual-write se o MIS voltar a ler `produtos` para saldo.

**P2:** lucro com `preco_compra` global; ranking legado `sqlRankingProdutos`; NF-e 55 no menu; cards globais (backup/auditoria) no mesmo HTML.

**Globais legítimos:** quantidade de empresas da instalação; backups; auditoria de sistema; equipamentos (até haver ownership).

---

## 23–24. Dependências

Operação (venda/estoque/ficha) estável (Bloco 3). `usuario_empresas`. Contrato operacional.

**MUC:** nenhum indicador do MIS mínimo converte unidade nesta sprint. Quantidades do ranking usam `vendas_itens` já persistidas. Dependência futura: estoque crítico em unidade de ficha / conversão — **não implementar MUC agora**.

---

## 25. MIS mínimo proposto (próxima implementação de produto)

**P0 (já lidos com isolamento):** faturamento, nº vendas, ticket, ranking, estoque da empresa.  
**P1 próxima sprint de UI:** compras do período, contas a receber, NFC-e emitidas.  
**Não agora:** DRE, consolidado, “todas as empresas”, Monitoring Engine completo.

---

## 26. Bloco 6 (futuro)

Reaproveitar as mesmas funções com **lista explícita** de empresas e agregação declarada como consolidada — nunca esconder soma no frontend do MIS.
