# FIN-INT-12 — Isolamento empresarial nas leituras de Contas a Receber

## Resumo executivo

Foram corrigidas as cinco leituras de Contas a Receber autorizadas pela sprint. A venda associada agora só fornece código, data, total ou itens quando pertence à mesma empresa do recebível. O cancelamento de venda estrangeira não exclui recebíveis nem altera o total de dívida da empresa consultada.

O histórico de pagamentos teve corrigida a referência inválida `cr.conta_receber_id`: o identificador correto é `cr.id`, ligado a `contas_receber_pagamentos.conta_receber_id`. A junção com a venda também passou a exigir correspondência empresarial.

As consultas de detalhes e extrato continuam usando junção interna com venda, preservando o comportamento anterior para títulos sem venda: eles não são listados como vendas nesses endpoints. Foi adicionada uma verificação de escopo para impedir que os dados pessoais de um cliente sem qualquer recebível da empresa ativa sejam retornados por acesso direto ao ID.

## Arquivos alterados

- `backend/rotas/financeiro.js`
- `tests/financeiro/fin-int-12-leituras-receber.test.js`
- `docs/financeiro/SPRINT-FIN-INT-12-RELATORIO.md`

## Comportamento anterior e corrigido

### Listagem — `GET /api/financeiro/receber`

- **Anterior:** o `LEFT JOIN` associava `vendas` apenas por `v.id = cr.venda_id`; o código da venda podia aparecer mesmo quando o recebível pertencia a outra empresa. A descrição também usava o `venda_id` do CR como fallback quando não havia código associado. O filtro de cancelamento consultava o status global da venda e podia excluir um CR da empresa A por causa de uma venda B cancelada.
- **Corrigido:** a junção requer `v.empresa_id = cr.empresa_id`. O código e o rótulo da venda usam apenas os dados da venda validada. O filtro de cancelamento usa a venda correspondente à empresa do CR. Um recebível A com referência a venda B permanece na listagem geral, sem usar o código B ou o ID B como rótulo.
- O campo `venda_id` continua no JSON por ser parte do contrato existente e representar o valor persistido no recebível. Ele não é usado como dado ou rótulo da venda sem correspondência empresarial.
- A regra de união FIN-INT-04 permanece: o espelho legado da mesma obrigação não é duplicado e lançamentos manuais legados continuam listados.

### Agrupamento — `GET /api/financeiro/receber/agrupado`

- **Anterior:** o total de CR da empresa já era filtrado por `cr.empresa_id`, mas `sqlExcluirContaVendaCancelada` podia excluir o título com base no cancelamento de uma venda estrangeira. `quantidade_vendas` contava todo `cr.venda_id`, inclusive uma referência cruzada.
- **Corrigido:** o status de cancelamento é considerado apenas para venda da mesma empresa. Os valores de recebíveis da empresa consultada continuam compondo seus totais mesmo se apontarem para uma venda estrangeira. `quantidade_vendas` conta somente IDs de vendas cuja correspondência empresarial foi validada.

### Detalhes — `GET /api/financeiro/receber/agrupado/:clienteId`

- A junção interna com `vendas` requer empresa coincidente e o filtro de venda cancelada é aplicado à venda validada.
- A consulta subsequente de `vendas_itens` também junta a tabela `vendas` com `v.empresa_id = req.empresaId`; itens fiscais/não fiscais de venda B não podem aparecer nos detalhes A.
- A junção interna foi mantida. Assim, títulos sem venda ou com vínculo empresarial inconsistente continuam sem aparecer como venda neste endpoint, como ocorria para CR sem venda. A listagem canônica e o agrupamento de valores continuam preservando os respectivos recebíveis.

### Extrato — `GET /api/financeiro/receber/agrupado/:clienteId/extrato`

- A junção com `vendas` e a consulta secundária de itens agora exigem a empresa do contexto.
- A identificação da empresa no extrato continua vindo do contexto A; venda/itens de B não são anexados ao documento A.
- O comportamento anterior de não excluir vendas canceladas da própria empresa foi preservado.
- A junção interna foi mantida para preservar o contrato de títulos sem venda.

### Histórico — `GET /api/financeiro/receber/agrupado/:clienteId/pagamentos`

- **Anterior:** o `SELECT` usava `cr.conta_receber_id`, coluna inexistente na tabela `contas_receber`, causando HTTP 500. A junção da venda também não verificava empresa.
- **Corrigido:** seleciona `cr.id AS conta_receber_id`, mantém a relação `crp.conta_receber_id = cr.id` e associa a venda somente com empresa coincidente.
- A junção interna foi preservada: pagamentos sem venda associada continuam sem resultado neste endpoint, como antes. Pagamentos válidos da empresa consultada retornam normalmente; linhas ligadas a venda estrangeira não recebem o código dessa venda.

### Acesso direto a cliente

O esquema de `clientes` não tem `empresa_id`; portanto, a propriedade empresarial é demonstrada pelos recebíveis. Detalhes e extrato agora só carregam o cliente quando existe ao menos um registro de `contas_receber` daquele cliente na empresa do contexto. Sem esse vínculo, retornam o mesmo erro 404 “Cliente não encontrado”, sem dados pessoais. Cliente com recebível da empresa ativa, inclusive título sem venda, continua autorizado.

## Testes e resultados

Comando executado:

```text
node --test tests\financeiro\fin-int-12-leituras-receber.test.js tests\financeiro\fin-int-05-relatorio-receber.test.js
```

Resultado: **7 testes passaram; 0 falhas**.

O novo teste usa SQLite `:memory:` com `PRAGMA foreign_keys = ON`, empresas A/B e FKs independentes para venda e empresa. Cobriu:

- venda A válida, recebível A ligado a venda B ativa e a venda B cancelada;
- venda B com itens de produtos e atributos fiscais distintos;
- CR sem venda e cliente sem venda;
- pagamento válido, pagamento ligado a CR cruzado, pagamento de B e cliente sem pagamentos;
- filtros por empresa e cliente, inclusive tentativa de abrir cliente existente apenas em B usando o contexto A;
- persistência de totais do CR, contagem de vendas validadas e exclusão de espelho legado duplicado;
- manutenção da exclusão de venda cancelada da própria empresa na listagem, sem aplicar cancelamento estrangeiro ao CR A;
- ausência de produtos/códigos estrangeiros em detalhes, extrato e histórico.

A regressão FIN-INT-05 passou com **2 testes**. Os checks de sintaxe também passaram:

```text
node --check backend\rotas\financeiro.js
node --check tests\financeiro\fin-int-12-leituras-receber.test.js
```

## Contratos e integridade

- Não foram alterados os formatos dos objetos de resposta nem os parâmetros dos endpoints.
- O histórico de pagamentos deixa de falhar com erro SQL e passa a retornar `conta_receber_id` conforme o vínculo persistido.
- Os totais de valor continuam baseados nos registros da empresa consultada; referências cruzadas não introduzem valor ou atributos da venda estrangeira.
- Não foram adicionadas ou executadas migrações. Nenhum dado oficial ou de cliente foi acessado ou alterado.
- Nenhum pagamento, baixa, cancelamento, reconciliação, backfill ou evento fiscal foi executado.

## Limitações

- Detalhes e extrato ainda omitem recebíveis sem venda ou com relação empresarial inconsistente por manterem o `JOIN` interno existente. Alterar para exibir esses títulos sem dados de venda exigiria decidir a forma de agrupamento e apresentação; nenhuma regra foi presumida nesta sprint.
- `venda_id` permanece no objeto da listagem por compatibilidade, como referência gravada no CR. O código e o rótulo descritivo deixam de usar esse ID quando não há venda validada da mesma empresa.
- A integridade do esquema continua baseada em FKs independentes; esta sprint protege as cinco leituras no SQL, mas não adiciona integridade composta nem altera os caminhos de escrita.
- Cancelamento financeiro, devolução parcial e pagamento parcial não foram alterados, conforme as restrições da sprint.

## Encerramento

FIN-INT-12 concluída. Aguardando homologação do Tech Lead; nenhuma outra sprint foi iniciada.
