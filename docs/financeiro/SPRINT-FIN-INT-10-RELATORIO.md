# FIN-INT-10 — Isolamento empresarial entre recebíveis e vendas

## Resumo executivo

Foi confirmada uma inconsistência possível entre `contas_receber.empresa_id` e a empresa da venda apontada por `contas_receber.venda_id`. O esquema valida separadamente a existência da empresa e da venda, mas não exige que ambas pertençam à mesma empresa. No relatório `GET /api/financeiro/relatorios/receber`, a junção anterior por `v.id = cr.venda_id` permitia que um recebível da empresa A usasse código e valores fiscais da venda da empresa B.

A consulta canônica do relatório agora associa a venda somente quando `v.empresa_id = cr.empresa_id`. O `LEFT JOIN` foi preservado: o recebível continua no relatório geral, mas não recebe atributos da venda estrangeira. A exclusão de venda cancelada também foi restrita à venda associada da mesma empresa, para que o status de uma venda de outra empresa não elimine um recebível válido do relatório geral.

O contrato JSON não foi alterado. Os testes SQLite isolados comprovam o comportamento para relação cruzada, relação válida, recebível sem venda e venda cancelada pertencente a outra empresa.

## Diagnóstico e decisão técnica

- O relatório filtra recebíveis canônicos por `cr.empresa_id = req.empresaId`.
- A consulta retorna código, total e valores fiscais/não fiscais da venda associada.
- `vendas.empresa_id` e `contas_receber.empresa_id` possuem referências individuais a `empresas`; `contas_receber.venda_id` referencia `vendas`. Não há chave estrangeira composta ou outra garantia de correspondência entre as empresas.
- A fixture SQLite reproduz essa possibilidade com empresa A, empresa B, recebível de A e venda referenciada de B. A inserção é aceita pelas FKs independentes.
- Antes da correção, o teste de regressão falhou porque o recebível de A recebeu valor fiscal `999` da venda de B, em vez de `0`, e a descrição podia conter o código `V-20`.
- A menor correção compatível foi aplicar a correspondência empresarial no `ON` da junção do relatório e avaliar o cancelamento somente sobre uma venda que tenha correspondência empresarial. Nenhum dado do recebível é descartado do relatório geral por causa de atributos de uma venda de outra empresa.

## Contrato anterior e contrato após a correção

- **Contrato anterior:** o formato da resposta, os campos, os filtros e os totais permaneciam os mesmos, mas os atributos da venda eram associados apenas pelo ID da venda.
- **Contrato após a correção:** formato, campos e filtros permanecem inalterados. Para o relatório, código e atributos da venda são considerados somente quando o ID e a empresa coincidem. Recebíveis sem venda associada continuam suportados.
- **Valores gerais:** o total continua baseado nos valores originais dos recebíveis; não incorpora o total da venda.
- **Valores fiscais:** uma relação cruzada não fornece valor fiscal ou não fiscal. No modo fiscal, o recebível com relação empresarial inválida não satisfaz o filtro de valor fiscal da venda e não é incluído como fiscal. Relações válidas e recebíveis sem venda mantêm o comportamento anterior.
- **Cancelamentos:** vendas canceladas da mesma empresa continuam excluídas conforme a regra existente. O estado de cancelamento de uma venda de outra empresa não exclui o recebível do relatório geral.

## Arquivos alterados

- `backend/rotas/financeiro.js` — junção e avaliação de cancelamento da venda na consulta canônica do relatório de recebimentos.
- `tests/financeiro/fin-int-05-relatorio-receber.test.js` — fixture isolada com duas empresas, relação cruzada, venda estrangeira cancelada e recebível sem venda; valida também totais.
- `docs/financeiro/SPRINT-FIN-INT-10-RELATORIO.md` — este relatório.

## Regras verificadas

- **Isolamento:** a consulta já restringe as linhas canônicas por empresa do contexto; a venda agora também precisa pertencer a essa empresa para fornecer código ou atributos.
- **Relação válida:** venda e recebível da mesma empresa continuam exibindo o código e os valores fiscais esperados.
- **Relação cruzada:** o recebível permanece na visão geral pelo valor original; dados fiscais e código da venda estrangeira não são usados.
- **Sem venda:** recebível com `venda_id` nulo continua no relatório e mantém o valor fiscal derivado do valor original conforme o contrato existente.
- **Venda cancelada estrangeira:** não altera a inclusão do recebível da empresa proprietária no relatório geral.
- **Filtros e agregações:** a mudança não altera os filtros de empresa, período, cliente ou status, nem os campos ou o formato da resposta.

## Testes executados

Comandos executados:

```text
node --test tests\financeiro\fin-int-05-relatorio-receber.test.js tests\financeiro\fin-int-06-frontend-contrato.test.js tests\financeiro\fin-int-09-relatorios-ux.test.js
node --check backend\rotas\financeiro.js
node --check tests\financeiro\fin-int-05-relatorio-receber.test.js
```

Resultados:

- FIN-INT-05: 2 testes passaram, incluindo isolamento A/B, ausência de dupla contagem legado/canônico, saldo, venda cancelada válida, vínculo cruzado, venda estrangeira cancelada e recebível sem venda.
- FIN-INT-06: 6 testes passaram; nenhuma alteração de frontend ou de contrato foi feita.
- FIN-INT-09: 5 testes passaram; nenhuma alteração de UX foi feita.
- Total: **13 testes passaram; 0 falhas**.
- Os dois checks de sintaxe terminaram sem erros.
- A execução pré-correção reproduziu o defeito: o teste recebeu `999` de valor fiscal da venda estrangeira, quando esperava `0`.
- A fixture usa exclusivamente SQLite `:memory:`.

## Evidências de isolamento e ausência de dupla contagem

- O teste executa a consulta da empresa A com uma venda válida de A, uma venda de B ativa e uma venda de B cancelada.
- O recebível cruzado com a venda ativa permanece com original `70`, fiscal `0`, não fiscal `0` e sem o código `V-20`.
- O recebível ligado à venda cancelada de B permanece na visão geral da empresa A; o cancelamento estrangeiro não o remove.
- A venda válida `V-10` continua associada ao recebível e mantém valor fiscal `400`.
- O recebível sem venda permanece com original e fiscal `55`.
- O total geral de A no fixture é `920`, calculado sobre os recebíveis da empresa A, sem utilizar o total `999` da venda B. No modo fiscal, o total é `600`, composto pelos recebíveis com relação fiscal válida ou sem venda.
- A regressão preexistente de união legado/canônico passou, confirmando ausência de dupla contagem no cenário coberto.

O banco oficial e bancos de clientes não foram acessados ou modificados. Não foram executados pagamentos, baixas, reconciliações, migrações, backfills ou eventos fiscais.

## Limitações e riscos restantes

- Foram observadas outras junções entre `contas_receber` e `vendas` apenas por ID em `backend/rotas/financeiro.js`, incluindo a consulta canônica da lista e fluxos de agrupamento/detalhe e pagamento parcial. Elas não foram alteradas nesta sprint, cujo teste e correção foram direcionados ao relatório `GET /relatorios/receber`. Devem ser avaliadas em escopo próprio antes de concluir que todos os fluxos de recebíveis estão protegidos contra referências cruzadas.
- A validação não cobre outros relatórios nem serviços fora da consulta priorizada, e não modifica nem garante integridade histórica dos registros já existentes.
- O modo fiscal não atribui classificação fiscal ao recebível ligado a uma venda de outra empresa; determinar uma classificação alternativa exigiria regra de domínio adicional e não foi inferida.

## Encerramento

FIN-INT-10 concluída para o endpoint de relatório priorizado. Aguardando homologação do Tech Lead; nenhuma outra sprint foi iniciada.
