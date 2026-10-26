# FIN-INT-13 — Isolamento empresarial nas escritas de Contas a Receber

## Resultado

Implementada a validação de propriedade empresarial nos fluxos de cancelamento financeiro, recálculo de devolução parcial e pagamento parcial. As seleções e atualizações relevantes agora ficam limitadas à empresa validada, e divergências impedem a escrita.

## Arquivos alterados

- `backend/services/vendas/VendaFinanceiroService.js`
- `backend/services/vendas/VendaCancelamentoService.js`
- `backend/rotas/financeiro.js`
- `tests/financeiro/fin-int-13-escritas-receber.test.js` (novo)

## Causa e correções

- **Cancelamento:** os lançamentos de `financeiro` e `contas_receber` eram atualizados por `venda_id`, sem restringir a empresa. O serviço agora valida a empresa proprietária da venda e inclui `empresa_id` nas atualizações. Os chamadores do fluxo de cancelamento encaminham a venda e o contexto empresarial já validados.
- **Sincronização de vendas canceladas:** a busca agora carrega `empresa_id` da tabela `vendas` e encaminha esse dado ao cancelamento financeiro, que não depende de uma empresa arbitrária.
- **Devolução parcial:** recebíveis e lançamentos financeiros considerados para reduzir saldo são filtrados pela empresa da venda validada. A atualização do recebível verifica conjuntamente seu `id`, `venda_id` e `empresa_id`; as atualizações da venda também verificam a empresa e o número de linhas afetadas.
- **Pagamento parcial:** a validação da empresa da venda e do recebível passou a ocorrer dentro da transação e antes da inserção do pagamento ou alteração de saldo. Divergência retorna o erro empresarial previsto pelo contrato (`409`) e provoca rollback. Recebíveis sem venda vinculada continuam usando o contexto empresarial validado da requisição.

## Testes executados

Comando:

```text
node --test tests\financeiro\fin-int-13-escritas-receber.test.js tests\financeiro\sprint-2-3-1-recebimentos-integrados.test.js tests\financeiro\fin-int-12-leituras-receber.test.js
```

Resultado: **9 testes passaram; 0 falharam**.

O teste isolado FIN-INT-13 cobre:

- Cancelamento da venda B sem alterar recebível ou lançamento financeiro da empresa A referenciados de forma cruzada.
- Devolução de B com processamento restrito aos recebíveis e lançamentos de B, sem reduzir o saldo de A.
- Pagamento parcial com empresa divergente, resposta `409` e ausência de pagamento/saldo persistido para a operação rejeitada.
- Pagamento parcial válido dentro da empresa B.

As regressões FIN-INT-12 e de recebimentos integrados também passaram. A saída contém logs de erros esperados nos cenários de divergência e saldo obsoleto; as respectivas expectativas de erro/rollback passaram.

Checks de sintaxe executados com `node --check` para:

- `backend\services\vendas\VendaFinanceiroService.js`
- `backend\services\vendas\VendaCancelamentoService.js`
- `backend\rotas\financeiro.js`
- `tests\financeiro\fin-int-13-escritas-receber.test.js`

Resultado: todos passaram.

## Evidência de isolamento e atomicidade

Os testes usam banco SQLite em memória e dados fictícios das empresas A e B. No cenário de cancelamento, a referência cruzada não alterou as linhas pertencentes a A. No recálculo da devolução, o recebível de A manteve o saldo anterior enquanto apenas os registros de B foram processados. No pagamento parcial, a divergência foi detectada antes das escritas e o cenário válido continuou funcionando.

## Segurança dos dados e operações

Nenhum banco oficial ou de cliente foi acessado ou modificado. Nenhuma operação financeira real, pagamento, baixa, cancelamento ou devolução real foi executada. Não houve migração, backfill ou envio fiscal; os testes usam exclusivamente fixtures isoladas em SQLite `:memory:`.

## Limitações e riscos restantes

- Registros legados de `financeiro` com `empresa_id` nulo não são atualizados por estes fluxos, pois não há base segura para atribuir-lhes uma empresa.
- Os testes cobrem os caminhos autorizados desta sprint; não foram executadas a suíte completa nem auditorias de outros serviços.
- O esquema ainda não impede referências cruzadas por uma restrição composta; a proteção desta entrega é aplicada nas validações e consultas dos fluxos tratados.
