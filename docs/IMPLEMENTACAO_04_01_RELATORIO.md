# SPRINT 04.01

STATUS:  
CONCLUÍDA

TIPO:  
AUDITORIA + FUNDAÇÃO

BLOCO:  
04 — MIS

INDICADORES ENCONTRADOS:  
18+ (dashboard ERP, relatórios de venda, financeiro, ranking legado, monitoring, Central)

DASHBOARDS ENCONTRADOS:  
5 (ERP, Command Center, Financeiro, Monitoring Engine, Central — esta última NÃO-MIS)

RELATÓRIOS ENCONTRADOS:  
8+ (fechamento caixa, produtos mais vendidos, período, estoque, uso/consumo compras, relatórios financeiro receber/pagar/fluxo/inadimplência)

APIS AUDITADAS:  
12+ (`/api/dashboard/resumo`, `/api/vendas/relatorio/*`, `/api/produtos/ranking-vendas`, `/api/produtos/:id/ultimas-compras`, `/api/financeiro/dashboard`, monitoring, Central)

QUERIES AUDITADAS:  
15+ no dashboard; helper `sqlRankingProdutos`; ranking HTTP de vendas (já isolado)

INDICADORES JÁ ISOLADOS:  
Relatórios `/api/vendas/relatorio/*`; financeiro dashboard; após 04.01: dashboard ERP operacional e ranking-vendas

INDICADORES COM RISCO:  
`sqlRankingProdutos` legado (não usar); `ultimas-compras`; Monitoring FinanceiroProvider; dual-write se ler `produtos` como estoque

RANKING:  
Rota vendas já filtrava `v.empresa_id`. Helper LEFT JOIN somava itens de outras empresas. Fundação: `sqlRankingProdutosDaEmpresa` com INNER JOIN `vendas`.

VENDAS:  
Faturamento/ticket/qtd com `data_venda` + empresa. F/NF preservados.

ESTOQUE:  
Dashboard passou a `estoque_empresa`. Dual-write não corrigido na escrita.

COMPRAS:  
Indicador MIS por `compras.empresa_id` + `data_compra`. Leitor D `ultimas-compras` permanece.

FINANCEIRO:  
Dashboard ERP e `/api/financeiro/dashboard` por empresa. Saldo a receber ≠ faturamento.

FISCAL:  
NFC-e no MIS via JOIN venda. Não virou módulo fiscal.

EMPRESA_SIMPLES:  
MIS usa `empresa_operacional_id` + autorização `usuario_empresas`.

MULTIEMPRESA:  
MIS usa contexto (`X-Empresa-Id` / `req.empresaId`). Sem “todas as empresas”.

AUTORIZAÇÃO:  
`exigirEmpresaAutorizada` no resolver do MIS.

P0:  
(nenhum no dashboard oficial após a fundação)

P1:  
- Monitoring Engine ainda global em vários providers  
- `GET /produtos/:id/ultimas-compras` sem `empresa_id`  
- Dual-write se o MIS voltar a usar saldo de `produtos`

P2:  
- Lucro estimado com `preco_compra` do catálogo  
- Helper `sqlRankingProdutos` legado  
- Cards globais (backup/auditoria) no mesmo dashboard

DEPENDÊNCIAS:  
Contrato operacional; `usuario_empresas`; Bloco 3 estável

MUC:  
Nenhuma conversão nova. Ranking usa quantidade já gravada em `vendas_itens`. Estoque crítico em unidade de ficha = dependência futura, não nesta sprint.

GESTÃO CONSOLIDADA:  
Não implementada. Funções do `MisIndicadoresService` poderão ser reaproveitadas no Bloco 6 com agregação **explícita**.

TESTES:  
17/17 (`tests/mis/auditoria-multiempresa-mis-04-01.test.js` — T00 código + T01–T16)

REGRESSÕES:  
03.01 20/20 · 03.02 28/28 · 03.03 25/25 · 03.04 35/35 · 03.07 20/20 · 03.08 25/25 · 03.09 14/14 · 05.40 13/13 · 05.53 10/10 · 05.54 12/12 · 05.55 16/16 · 05.56 10/10 · 05.59 10/10 · 05.64 T01–T08 OK · 05.70 T01–T12 OK · 05.72 10/10 · 05.74 12/12 · 05.75 PDV 12/12 · 05.75 saúde 13/13 · 05.76 18/18 · 05.77 fail 0 · 05.80 fail 0.  
05.81: inexistente no repositório.

CONCLUSÃO:  
Fundação MIS isolada. Dashboard oficial deixa de misturar A+B. Próximo passo é produto (UI/mínimo P1), não consolidação.

PRÓXIMA SPRINT:  
04.02 — MIS mínimo de produto (compras do período, receber, NFC-e na mesma camada; opcional isolar Monitoring). Sem Bloco 6. Sem MUC.
