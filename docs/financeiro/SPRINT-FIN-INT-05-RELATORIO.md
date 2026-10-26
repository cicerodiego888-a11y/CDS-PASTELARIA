# Sprint FIN-INT-05 — Relatório de entrega

**Tipo:** unificação controlada do relatório de Contas a Receber  
**Data:** 2026-10-26  
**Homologação:** aguardando Tech Lead

## Diagnóstico e contrato

O endpoint `GET /api/financeiro/relatorios/receber` era consumido diretamente por `frontend/erp/js/financeiro-relatorios.js`. A interface lê `contas[]`, os campos `cliente`, `descricao`, `documento`, `dataVencimento`, `valor_fiscal`, `valor_nao_fiscal`, `valor_total`, `valor`, `status` e `origem`, além de `totais.fiscal`, `totais.nao_fiscal` e `totais.total`. Os totais fiscais são deduplicados por venda; o total geral soma os valores originais das linhas filtradas.

Antes da Sprint, a consulta retornava somente linhas de `financeiro` do tipo receita. `valor`/`valor_total` representavam o valor original do lançamento; o relatório não expunha montante recebido nem saldo restante. A liquidação era identificada pelo status `recebido`/`pago`; o status de exibição podia ser derivado como `vencido`.

O contrato anterior foi preservado. A resposta continua contendo `success`, `modo_fiscal_ativo`, `contas`, `totais` e `periodo`, e as colunas já consumidas pela interface mantêm seus nomes e significados. Foram adicionados campos sem remover ou renomear os existentes:

- `fonte` e `chave` identificam a origem e evitam ambiguidade entre IDs.
- `status_persistido` mantém o estado armazenado quando `status` é apresentado como `vencido`.
- `valor_original` explicita o valor usado no relatório e em `valor_total`.
- `valor_recebido` e `valor_restante` apresentam valores separados para registros canônicos e legado com estado mensurável.

Para `contas_receber`, `valor_original` é `valor_parcela`, `valor_restante` é o saldo persistido e `valor_recebido` é a diferença entre ambos. Para legado liquidado, o recebido é o valor do lançamento e o restante é zero; para legado aberto, o recebido é zero e o restante é o valor original. Registros legados parciais ou com status não reconhecido retornam `null` nesses dois campos, pois a fonte `financeiro` não guarda o detalhe suficiente para calcular esses montantes sem inferência. A interface continua mostrando os valores originais, não confunde saldo com movimentação recebida e mantém os totais anteriores.

## Arquivos alterados

- `backend/rotas/financeiro.js` — adiciona a fonte canônica à consulta do relatório, filtros, exclusão de sobreposição/cancelamentos, mapeamento dos valores e status e campos aditivos.
- `tests/financeiro/fin-int-05-relatorio-receber.test.js` — testes do endpoint com SQLite `:memory:`.
- `docs/financeiro/SPRINT-FIN-INT-05-RELATORIO.md` — este relatório.

Não foram alterados a lista unificada da FIN-INT-04, o frontend do relatório, Dashboard, Histórico, Dívidas por Cliente, Contas a Pagar, MCF, MBC, Open Finance, PDV ou Motor Fiscal.

## Regras de unificação, status e filtros

- A regra oficial `sqlExcluirFinanceiroReceberComContaCanonica('f')` exclui do legado o espelho da mesma obrigação por `empresa_id`, venda resolvida por `venda_id`/`referencia_id` e `numero_parcela`, incluindo parcela nula. Não se usa igualdade de cliente, descrição ou valor.
- Títulos de `contas_receber` são retornados por registro/componente. Componentes diferentes da mesma parcela são mantidos e somam pelo valor original; o espelho legado é excluído uma vez que qualquer registro canônico corresponda à mesma parcela.
- O predicado existente `sqlExcluirFinanceiroVendaCancelada` continua excluindo lançamentos legados relacionados a vendas canceladas; `sqlExcluirContaVendaCancelada` faz o mesmo para a fonte canônica.
- Empresa, cliente, período, status e modo fiscal são aplicados separadamente a cada fonte. O período continua sendo aplicado somente quando `dataInicio` e `dataFim` são fornecidos. O filtro de cliente preserva a busca por nome disponível em cada fonte.
- `pendente` do relatório corresponde também a `aberto` na fonte canônica. Os demais status persistidos são filtrados pelo valor solicitado; `vencido` seleciona somente títulos vencidos não liquidados/cancelados. Valores originais permanecem na coluna e nos totais existentes, independentemente do saldo restante.
- A composição fiscal continua usando os valores persistidos da venda e a deduplicação por venda do helper existente. Nenhuma projeção de MCF/Contas a Pagar participa da consulta.

## Testes e resultados

Executados:

- `node --check backend\rotas\financeiro.js` — aprovado.
- `node --check tests\financeiro\fin-int-05-relatorio-receber.test.js` — aprovado.
- `node --test tests\financeiro\fin-int-05-relatorio-receber.test.js tests\financeiro\fin-int-04-uniao-receber.test.js tests\financeiro\fin-p1-2-consistencia.test.js tests\financeiro\contexto-empresarial-financeiro-p0.test.js` — aprovado, **13/13 testes**.

O teste novo cobre: venda a prazo com espelho sem dupla contagem; múltiplos componentes; manual somente legado; título somente canônico; pagamento parcial com original/recebido/restante separados; título liquidado; venda cancelada; empresas A/B; filtros de período, cliente e status; e totais no modo fiscal. Os testes P1.2, P0 e FIN-INT-04 também passaram.

## Evidências e integridade dos dados

- A fixture contém espelho legado de 500 e dois componentes canônicos de 300 e 200 para a mesma venda/parcela. A resposta contém apenas os dois componentes, e o total original é 500 para essa obrigação; o espelho não gera uma terceira linha.
- O registro canônico parcial de 80, com restante persistido de 55, retorna `valor_original=80`, `valor_recebido=25` e `valor_restante=55`. O liquidado de 60 retorna saldo zero e status persistido `pago`.
- Uma consulta da empresa A não retorna o título de 999 da empresa B; consultando a empresa B, o relatório retorna somente esse título. O teste também confirma que registros da venda cancelada são excluídos em ambas as fontes.
- O teste usa exclusivamente SQLite `:memory:` com dados sintéticos. Os testes de regressão selecionados também usam fixtures isoladas; não foi iniciado o banco original, não foram escritos dados em banco original ou de cliente e não foram realizados pagamentos.
- Não houve migração, backfill, reprocessamento nem instalação/atualização de dependências.

## Limitações e itens não verificados

- O modelo legado `financeiro` não permite recuperar o montante pago ou o saldo exato para registros parciais e estados desconhecidos; os campos aditivos correspondentes ficam `null`, sem estimativa.
- A validação foi feita com testes isolados, não com uma sessão autenticada integrada à aplicação ou banco de cliente.
- Não foi executada a suíte completa do repositório.

**Status:** implementação e testes focados concluídos; aguardando homologação do Tech Lead. Nenhuma outra Sprint foi iniciada.
