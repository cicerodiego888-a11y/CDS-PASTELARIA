# Sprint FIN-P1.2 — Segurança e consistência financeira

**Status:** implementação técnica concluída para os pontos cobertos; revisão e aprovação do Tech Lead pendentes.  
**Data da execução:** 25/10/2026.  
**Ambiente de testes:** SQLite em memória e diretório temporário isolado.  
**Restrições:** nenhum banco original ou oficial foi aberto para consulta operacional, alterado ou migrado; nenhum backfill ou operação financeira real foi executado; MBC, matching, Open Finance, PDV e Motor Fiscal não foram modificados.

## 1. Diagnóstico antes da implementação

O código e o relatório FIN-P1.1 já registravam estas divergências:

1. `financeiro-historico.js` construía filtros, linhas, campos textuais e mensagens de erro com `innerHTML` e interpolação de valores da API. O status também era aplicado diretamente em uma classe CSS. O botão de filtro usava handler inline.
2. `GET /api/financeiro` e partes do Dashboard Financeiro excluíam projeções MCF, mas não aplicavam consistentemente a exclusão de linhas relacionadas a vendas canceladas. Resumo, fluxo, inadimplência e vencimentos também tinham omissões.
3. `FILTRO_VENDA_VALIDA`, usado pelo Dashboard geral/MIS, verificava apenas `status`; não excluía vendas marcadas por `cancelada = 1`.
4. O Dashboard geral somava saldos em `contas_receber` e lançamentos em `financeiro` sem excluir os lançamentos que espelham a mesma venda/parcela.
5. `contas_receber_pagamentos` não era usado de forma consistente como fonte de liquidações no Dashboard Financeiro. Os campos de recebíveis eram calculados a partir do valor inteiro do lançamento em `financeiro`, inclusive quando a parcela já tinha baixa parcial.
6. A consulta compartilhada de recebimentos de venda nos relatórios filtrava cancelamentos, mas não limitava `v.empresa_id` à empresa do contexto.
7. A inadimplência consultava o ledger legado e não somava os saldos vencidos canônicos de CR e AP MCF.

Essas constatações foram verificadas nas rotas, helpers e chamadas efetivas, sem inferir equivalência apenas pelos nomes das tabelas.

## 2. Alterações e causas-raiz corrigidas

| Arquivo | Alteração |
|---|---|
| `frontend/erp/js/financeiro-historico.js` | Reconstrução do Histórico com elementos DOM e `textContent`; mensagem de erro também é texto; classe do status aceita apenas caracteres permitidos; botão de filtro sem handler inline; requisição usa o helper central de cabeçalhos do Financeiro. |
| `frontend/erp/js/financeiro.js` | Escape contextual dos valores usados na tabela de lançamentos; handlers dinâmicos substituídos por delegação de eventos com IDs numéricos seguros; referências são abertas apenas para IDs positivos seguros e tipos `compra`/`venda`. |
| `backend/services/reportFiscalHelpers.js` | `FILTRO_VENDA_VALIDA` agora exclui status cancelado (case-insensitive) e a flag `cancelada`. |
| `backend/services/vendas/VendaFinanceiroService.js` | Novo predicado para excluir da soma de recebíveis do ledger o lançamento que representa a mesma empresa, venda e parcela já presente em `contas_receber`. Mantidos os helpers de cancelamento existentes. |
| `backend/rotas/dashboard.js` | O recebível legado só é somado quando não corresponde a título canônico de CR. As vendas, recebíveis e despesas continuam sob filtro empresarial. |
| `backend/rotas/financeiro.js` | Filtros de venda cancelada e projeção MCF aplicados às consultas de Histórico, dashboard, relatórios e vencimentos; filtros para o status financeiro cancelado nas consultas operacionais; recebimentos de venda limitados à empresa do contexto; Dashboard e Resumo passam a incluir saldo e liquidações CR canônicos e saldo/pagamentos AP MCF; inadimplência combina ledger independente com saldos CR/AP canônicos, sem incluir as projeções. |
| `tests/financeiro/fin-p1-2-consistencia.test.js` | Fixture SQLite em memória com duas empresas, vendas canceladas por status/flag, recebível parcial, títulos/pagamentos MCF e projeções; testes dos renderizadores reais, das rotas e dos predicados SQL. |
| `tests/mis/mis-04-02-produto.test.js` | Fixture de venda ajustada para refletir o schema de produção, que possui `vendas.cancelada`. |

### Causa-raiz

As regras de cancelamento e projeção estavam espalhadas por consultas específicas, sem reaplicação uniforme. Além disso, o ledger `financeiro` contém lançamentos de venda que espelham uma parcela de `contas_receber`; somar ambos como saldos independentes inflava o valor a receber. A correção mantém o ledger histórico e exclui somente a linha ligada ao título/parcela canônico nas agregações operacionais correspondentes.

## 3. Contrato efetivamente usado nos indicadores corrigidos

- **Venda válida:** fonte `vendas`; exclui `cancelada = 1` ou `status = cancelada`.
- **Recebível em aberto:** saldo `contas_receber.valor_restante` de títulos em `aberto`/`parcial`, no contexto da empresa e excluindo vendas canceladas.
- **Recebimento de CR:** `contas_receber_pagamentos.valor_pago`, vinculado ao título e filtrado pela empresa do título; período pela data de liquidação.
- **Recebível legado independente:** linha `financeiro` não cancelada, não MCF e sem correspondência por empresa/venda/parcela com `contas_receber`.
- **AP em aberto:** `contas_pagar.valor_restante` para títulos MCF em `aberto`/`parcial`.
- **Pagamento de AP:** `contas_pagar_pagamentos.valor_pago`; período pela data de pagamento.
- **Projeção MCF:** linha `financeiro` marcada por origem/referência MCF; excluída dos cálculos do ledger sempre que o título MCF correspondente é a fonte operacional.
- **Histórico:** continua exibindo registros históricos do ledger conforme os filtros de consulta; não apaga nem reescreve lançamentos cancelados.
- **Relatório de inadimplência:** agrega lançamentos legados independentes, saldo CR canônico e saldo AP MCF. O filtro de período do ledger legado continua baseado em `data_movimento`; para CR/AP canônicos, é aplicado sobre vencimento.
- **Relatório de resumo/fluxo:** continuam sendo superfícies de ledger e recebimentos de venda, com filtros de empresa/cancelamento/projeção. Seus totais não são sinônimos de saldo em aberto nem de liquidações CR/AP e não devem ser comparados diretamente com eles.
- **Precisão:** as consultas agregam os valores decimais persistidos; não foi introduzida conversão para ponto flutuante nem uma nova regra de arredondamento. A fixture valida valores exatos em centavos.

## 4. Evidências da fixture — esperado versus obtido

Fixture somente em SQLite em memória:

- Empresa A: venda válida de R$ 200; vendas canceladas de R$ 100 por status e R$ 75 por flag.
- Empresa A: recebível de R$ 300, pagamento de R$ 100 e saldo restante de R$ 200; lançamento de R$ 300 no ledger é sua projeção e não vira outro saldo.
- Empresa A: título MCF de R$ 500, pagamento MCF de R$ 150 e saldo de R$ 350; segundo título MCF aberto de R$ 250.
- Empresa A: recebível legado independente vencido de R$ 25.
- Empresa B: recebimento de venda de R$ 900, recebível de R$ 999, título MCF de R$ 900 e lançamento financeiro de R$ 900.

| Indicador / consulta | Esperado | Obtido |
|---|---:|---:|
| Vendas válidas da Empresa A | R$ 200 | R$ 200 |
| Saldo do recebível parcial canônico | R$ 200 | R$ 200 |
| Recebimento CR registrado | R$ 100 | R$ 100 |
| Recebíveis no Dashboard Financeiro e em `/api/financeiro/resumo` (CR restante + legado independente) | R$ 225 | R$ 225 |
| Saldo restante do título MCF parcial | R$ 350 | R$ 350 |
| AP MCF aberto da Empresa A, sem contar projeções | R$ 600 | R$ 600 |
| Pagamentos AP MCF da Empresa A | R$ 150 | R$ 150 |
| Inadimplência: CR R$ 200 + AP MCF R$ 350 + legado independente R$ 25 | R$ 575 | R$ 575 |
| Recebimentos de venda atribuídos à Empresa A no Resumo/Fluxo | R$ 200 | R$ 200 |
| Acesso da Empresa A aos títulos/lançamentos da Empresa B | nenhum | nenhum |

O Resumo de Relatórios apresentou `receitas.total = R$ 325` e `recebimentos_venda.total = R$ 200`. Esses campos medem o ledger e os recebimentos de venda em blocos separados; não são o saldo CR de R$ 225 e não foram somados entre si. O teste mantém essa distinção explícita.

## 5. Testes executados

### Suíte nova FIN-P1.2

`node --test tests/financeiro/fin-p1-2-consistencia.test.js`

- 4 testes aprovados, 0 falhas.
- Testou o renderer do Histórico e a mensagem de erro com valores sintéticos maliciosos por meio de DOM instrumentado; confirmou uso de `textContent`, ausência de escrita em `innerHTML` na tela de Histórico e ausência de classe de status controlada por payload.
- Testou a tabela de lançamentos, escape de atributos/texto e ausência de handlers inline dinâmicos.
- Testou validação de IDs/tipos de referência.
- Executou rotas financeiras reais contra SQLite em memória, incluindo História, dashboard, resumo, fluxo e inadimplência; verificou cancelamentos, projeções, saldos CR/AP e empresa.

### Regressões financeiras e multiempresa

`node --test tests/financeiro/fin-p1-2-consistencia.test.js tests/financeiro/mcf-01.test.js tests/financeiro/mcf-02-compras.test.js tests/financeiro/sprint-2-3-1-recebimentos-integrados.test.js tests/financeiro/contexto-empresarial-financeiro-p0.test.js tests/financeiro/financeiro-multiempresa-05-38-d.test.js`

- 31 testes aprovados, 0 falhas.
- Inclui MCF-01/02, baixa parcial e concorrência/idempotência MCF, recebimentos parciais, autorização/contexto e isolamento empresarial.
- O teste de recebimento parcial registra no log o conflito esperado ao testar saldo obsoleto; a suíte termina aprovada.

### Regressão do MIS/Dashboard geral

Executado com `DB_DIR` apontado para diretório temporário exclusivo e removido ao final:

`node --test tests/mis/mis-04-02-produto.test.js`

- 13 testes aprovados, 0 falhas.
- A primeira execução isolada revelou que a fixture MIS não declarava `vendas.cancelada`, coluna existente no schema de produção e agora consultada pelo helper. A fixture foi atualizada para refletir o contrato real e a execução isolada subsequente passou.

### Escopo não executado

- Não foi executada a suíte completa do repositório.
- Não houve teste em navegador real/headless; não foi adicionada dependência DOM. O teste instrumenta e executa o renderer de produção e verifica os pontos de inserção concretos.
- Não foi realizado batimento contra banco persistente ou dados reais.

## 6. Limitações e itens ainda não resolvidos

1. A listagem operacional e o relatório detalhado de Contas a Receber ainda têm consumidores que leem `financeiro`; não houve reconciliação histórica nem migração de leitores nesta Sprint.
2. O `Resumo de Relatórios` e o `Fluxo` preservam seus contratos de ledger/recebimentos de venda. Não devem ser comparados como se fossem saldo CR/AP ou liquidações. O fluxo não foi convertido em uma nova demonstração de caixa canônica para todos os recebimentos.
3. O filtro de período da inadimplência conserva duas bases temporais já distintas: `data_movimento` para lançamentos do ledger e vencimento para CR/AP canônicos. A interface ainda não separa esses critérios.
4. A fixture comprova as consultas e rotas financeiras alteradas e testa o predicado aplicado pelo Dashboard geral para não duplicar CR com ledger. A resposta completa de `/api/dashboard/resumo` não foi executada com essa mesma fixture; os testes MIS existentes passaram em base isolada separada.
5. Não foram adicionados cenários de browser para carregamento real do ERP; testes de segurança focam nos renderizadores e nas APIs sob controle.
6. A aprovação da Sprint e a eventual expansão para outros relatórios dependem da revisão do Tech Lead.

## 7. Preservação e escopo

- Banco original `mercadao.db`: **não acessado nem modificado**.
- Migração/backfill histórico: **não executado**.
- MBC, matching e Open Finance: **sem alterações**.
- PDV, Motor Fiscal, emissão fiscal, XML e tributos: **sem alterações**.
- Projeções e registros históricos: **preservados**; os indicadores filtram as projeções/cancelamentos sem apagar linhas.
- Nenhuma operação financeira real foi realizada.
