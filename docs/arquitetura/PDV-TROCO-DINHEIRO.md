# PDV — pagamento em dinheiro com troco

## Causa da validação anterior

O modal sequencial recusava qualquer valor acima do saldo em `confirmarValorDireto`, com o aviso "O valor supera o saldo restante". `PagamentoSequencial.adicionar` repetia o bloqueio (`VALOR_ACIMA_DO_RESTANTE`) para todas as formas. O valor gravado em `venda_pagamentos.valor` é o que a soma dos pagamentos compara com o total da venda.

## Implementação

Só dinheiro (também espécie/cash) pode ser informado acima do saldo. O cálculo usa centavos inteiros:

- valor aplicado = mínimo entre o entregue e o saldo restante;
- troco = entregue − aplicado.

PIX, débito e crédito continuam no bloqueio anterior. A confirmação mostra DINHEIRO ENTREGUE, SALDO RESTANTE, VALOR APLICADO e TROCO, com Voltar e Confirmar pagamento. Voltar não grava. Um segundo clique durante o registro é ignorado.

`venda_pagamentos.valor` recebe o aplicado. `valor_entregue` e `troco` ficam em colunas próprias. A soma dos pagamentos continua igual ao total da venda. O troco não entra na referência fiscal/não fiscal. A classificação F×NF não foi alterada.

## Arquivos

- `frontend/pdv/js/valorMonetarioPdv.js`
- `frontend/pdv/js/pagamentoSequencial.js`
- `frontend/pdv/js/pdv.js`
- `backend/services/vendas/registroTrocoDinheiro.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/database.js`
- `backend/rotas/vendas.js`
- `tests/pdv/pdv-troco-dinheiro.test.js`
- `tests/pdv/fluxo-direto-valor-parcial.test.js`

## Testes

Executado com `node --test --test-concurrency=1` nas dez suítes PDV relacionadas: **56/56 testes passaram**. Foram cobertos dinheiro com e sem troco, valores parciais e sequenciais, duplo clique, falhas/recusas de formas eletrônicas, recomposição F×NF, classificação fiscal e fluxo antigo de pagamento manual.

A suíte `node tests\database\banco-init-01.test.js` passou **7/7**, incluindo inicialização de banco vazio, migração de tabela `venda_pagamentos` legada, preservação do pagamento antigo e idempotência. A validação verifica que `valor_entregue` e `troco` existem após a migração e que não há erro de coluna duplicada.

Em banco SQLite temporário, sem acessar o banco oficial, foram conferidos:

- preservação do pagamento anterior de R$ 40,00;
- persistência de R$ 8,99 aplicado, R$ 9,00 entregue e R$ 0,01 de troco;
- soma aplicada de R$ 48,99;
- leitura dos três campos após a gravação.

Essa verificação isolada valida migração e formato persistido; não executou uma venda real nem uma requisição autenticada ao serviço de pagamento.

O `npm start -- --cds-forcar-local` também foi iniciado com banco temporário, bloqueio do banco oficial e porta isolada. O log confirmou `DATABASE READY` e `HTTP LISTENING`; `/pdv/` respondeu HTTP 200. Não houve mensagens de coluna duplicada após a correção da migração. Foram observados avisos de configuração de chaves de desenvolvimento e uma advertência de dependência circular, sem impedir a inicialização.

## Homologação visual

Não foi possível concluir o cenário visual. A sessão do navegador foi redirecionada para o login e não havia autenticação local disponível. Portanto, não foram informados os R$ 40,00 e R$ 9,00 na tela, nem confirmada uma venda; não houve pagamento, TEF ou emissão fiscal.

## Classificação

| Item | Estado |
| --- | --- |
| Dinheiro acima do saldo, com aplicado e troco separados | CONCLUÍDO |
| Confirmação antes do registro | CONCLUÍDO |
| PIX, débito e crédito ainda limitados ao saldo | TESTADO |
| Recomposição com o valor aplicado, sem mudar F×NF | TESTADO |
| Migração e persistência isolada das três quantias | TESTADO |
| Inicialização do servidor com banco temporário | TESTADO |
| Homologação visual/autenticada no PDV | BLOQUEADO |

## Limitações

**Classificação geral: BLOQUEADO para homologação visual; TESTADO para regressões, migração, persistência isolada e inicialização.** A etapa visual depende de uma sessão local autenticada. O servidor usado na validação foi encerrado após o teste e a base temporária ficou isolada do banco oficial.

O caminho antigo de uma única forma em dinheiro segue gravando o recebido em `vendas.valor_recebido`. A separação na parcela vale para o pagamento sequencial.
