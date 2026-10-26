# Sprint FIN-INT-06 — Auditoria de compatibilidade do relatório

**Tipo:** auditoria focada de frontend e contrato  
**Data:** 2026-10-26  
**Homologação:** aguardando Tech Lead

## Escopo e arquivos

Auditoria somente leitura do contrato e do renderer de Contas a Receber. Não houve alteração no frontend, backend, SQL, endpoint, cálculos financeiros ou filtros.

- Inspecionado: `frontend/erp/js/financeiro-relatorios.js`.
- Teste isolado adicionado: `tests/financeiro/fin-int-06-frontend-contrato.test.js`.
- Relatório: `docs/financeiro/SPRINT-FIN-INT-06-RELATORIO.md`.

## Compatibilidade do contrato

O renderer continua compatível com o contrato anterior: verifica que `contas` é uma lista e mantém as colunas anteriores. No modo fiscal/não fiscal, respectivamente:

- modo fiscal: `cliente`, `descricao`, `documento`, `dataVencimento`, `valor_fiscal`, `status` e `origem`;
- modo fiscal e não fiscal: os mesmos dados, mais `valor_fiscal`, `valor_nao_fiscal` e `valor_total`.

`valor_total` continua sendo o valor original usado na coluna “Total”, com fallback para `valor` quando ausente ou `null`. `valor` não é apresentado como saldo; no modo fiscal só é fallback de `valor_fiscal`. O renderer não recalcula `totais`: usa `totais.fiscal`, `totais.nao_fiscal` e `totais.total` fornecidos pelo endpoint. Logo, os significados anteriores dos valores e dos totais permanecem preservados.

Os campos aditivos `fonte`, `chave`, `status_persistido`, `valor_original`, `valor_recebido` e `valor_restante` não são lidos pelo renderer atual. Como cada item de `contas` gera sua própria linha e não há mapa, índice por `id` ou deduplicação no frontend, IDs coincidentes de `financeiro` e `contas_receber` não colidem.

O backend devolve `periodo`, mas o renderer apresenta o período passado pelo fluxo da tela (`filtros`) — o mesmo enviado na URL como `dataInicio`/`dataFim`. Cliente, status e modo fiscal também são enviados na requisição; a empresa é enviada por `__headersFin()`/`headersFinanceiro`.

## Apresentação de valores ausentes e `null`

- `cliente`, `descricao`, `documento`, `status` e `origem` ausentes ou falsy aparecem como `-`; data ausente ou `null` também aparece como `-`.
- `valor_fiscal` e `valor_nao_fiscal` ausentes, `null` ou zero são formatados como zero por causa do fallback `|| 0`.
- `valor_total` ausente ou `null` recorre a `valor`, e só vira zero se ambos estiverem ausentes/`null`.
- Totais ausentes ou `null` são formatados como zero pelo fallback atual.
- `valor_recebido` e `valor_restante` são ignorados. Portanto, `null` nesses campos não aparece falsamente como zero, mas os campos numéricos também não aparecem.

## Incompatibilidade encontrada e proposta para homologação

**Incompatibilidade funcional:** a compatibilidade estrutural é preservada, mas a tela não cumpre o objetivo informativo ampliado de distinguir valor original, recebido e saldo restante. No exemplo canônico original 80, recebido 25 e saldo 55, o renderer mostra o total original e o status, mas não mostra 25 nem 55. Para legado parcial, o endpoint pode retornar `null` por falta de detalhe na fonte; o frontend não informa que esse valor é indisponível.

**Proposta, não implementada nesta auditoria:** após homologação, avaliar a adição de campos explícitos de recebido e saldo na apresentação não fiscal, mantendo a coluna “Total” com valor original. Valores numéricos devem ser formatados mesmo quando zero; `null`/ausente deve aparecer como “Não disponível”, nunca como zero. A visão fiscal exige decisão separada: o endpoint fornece recebido/saldo totais da obrigação, sem composição fiscal desses montantes. Não se recomenda mostrá-los como se fossem valores fiscais sem uma regra de domínio aprovada.

Essa proposta é uma alteração de interface; não requer mudar cálculos ou o contrato backend para os dados já disponíveis, mas a decisão de apresentação e a semântica da visão fiscal ficam pendentes do Tech Lead.

## Filtros, segurança e estados

- Período: envia as datas selecionadas e apresenta esse intervalo no cabeçalho do relatório.
- Cliente e status: enviados como parâmetros existentes (`cliente`, `status`).
- Modo fiscal: enviado em `modo_fiscal`; a resposta fiscal usa a coluna e o total fiscal, sem coluna não fiscal.
- Empresa: a chamada usa `__headersFin()` e o mecanismo empresarial compartilhado.
- Dados dinâmicos da tabela são escapados por `escaparHtmlRelatorio`; valores de células, status e cabeçalhos não são inseridos como HTML não confiável.
- A lista vazia usa o estado vazio. Respostas HTTP com erro e payloads inválidos seguem o tratamento de erro existente; não são convertidos em sucesso vazio.

## Testes e resultados

Teste isolado com mocks/fixtures em memória:

- `node --check tests\financeiro\fin-int-06-frontend-contrato.test.js` — aprovado.
- `node --test tests\financeiro\fin-int-06-frontend-contrato.test.js` — aprovado, **6/6**.

Casos cobertos: linhas legadas e canônicas com IDs coincidentes; totais antigos e modo fiscal; contrato anterior sem campos adicionais; valores recebidos/restantes numéricos versus `null` (evidenciando que ambos são ignorados); escaping de conteúdo dinâmico; resposta vazia; erro HTTP; filtros enviados e cabeçalho de contexto empresarial.

Regressões focadas executadas:

- `node --test tests\financeiro\fin-int-05-relatorio-receber.test.js tests\financeiro\fin-int-04-uniao-receber.test.js tests\financeiro\fin-p1-2-consistencia.test.js tests\financeiro\contexto-empresarial-financeiro-p0.test.js` — aprovado, **13/13**.

## Limitações e integridade

- A validação do frontend foi feita com VM e mocks isolados; não foi aberta uma sessão autenticada do Electron.
- A auditoria não executou a suíte completa do repositório.
- Nenhum banco original ou de cliente foi acessado; não houve escrita, migração, backfill ou operação financeira.
- Nenhuma incompatibilidade foi corrigida nesta Sprint; a proposta acima aguarda homologação.

**Status:** auditoria e testes concluídos; aguardando homologação do Tech Lead. Nenhuma outra Sprint iniciada.
