# Auditoria da classificação da modalidade de pagamento

**ID:** CDS-PDV-CLASSIFICACAO-PAGAMENTO-01  
**Tipo:** somente leitura. Nenhum arquivo de produção foi alterado.  
**Banco oficial:** não foi consultado.

## Causa raiz

Uma venda com um único débito chega à listagem como `misto` porque o fechamento direto grava essa palavra no cabeçalho da venda. A parcela em si continua `cartao_debito`.

O caminho é este:

1. O botão Débito envia `cartao_debito`. O título do modal de valor usa esse código e fica **Débito**.
2. Ao quitar, `iniciarFechamentoDireto` copia as parcelas e força `formaPagamentoSelecionadaPDV = 'misto'`, mesmo com uma parcela só. Isso está em `frontend/pdv/js/pdv.js`, por volta da linha 7208.
3. Qualquer lista com pelo menos uma parcela entra no ramo `lista_sequencial`. Esse ramo grava de novo `dados.forma_pagamento = 'misto'`, por volta da linha 5956.
4. O backend só troca para `misto` quando `pagamentos.length > 1` (`VendaPagamentoService.js`, linhas 1191–1192). Com um débito a lista tem um item, então ele preserva o `misto` que o PDV já mandou.
5. `vendas.forma_pagamento` recebe esse cabeçalho. `venda_pagamentos.forma_pagamento` recebe `cartao_debito`.
6. A listagem do ERP e do PDV mostra `rotuloFormaPagamento(venda.forma_pagamento)`. O mapa não tem a chave `misto`, então a tela imprime a palavra `misto`.

Misto, nesta regra, é duas ou mais modalidades distintas já recebidas. O código atual trata como misto a existência da tela de pagamento direto ou a quantidade de registros.

## Modal Crédito e modal Débito

Os códigos dos botões não estão invertidos. Débito envia `cartao_debito` e o título fica Débito. Crédito envia `cartao_credito` e o título fica Crédito.

Enquanto o modal de valor está aberto, o mesmo teclado da tela de pagamento continua ativo se o campo Valor não tem foco. A tecla `4` chama `escolherFormaDireta('cartao_credito')` e o título passa a ser Crédito. A tecla `3` volta para Débito. Não há conversão de `debito` em `credito` na gravação. `cartao_debito` e `DÉBITO` são a mesma modalidade na regra auditada; o cabeçalho não usa essa normalização.

O rótulo **Crédito** da listagem só aparece quando o valor gravado é `credito`. O caso do débito único grava `misto`, não `credito`.

## Campos

| Onde | O que guarda nesta venda |
|---|---|
| Seleção | `cartao_debito` |
| `venda_pagamentos.forma_pagamento` | `cartao_debito` |
| `vendas.forma_pagamento` | `misto` |
| Listagem | o cabeçalho, exibido como `misto` |

Reabrir a venda relê o cabeçalho. A parcela de débito continua na sequência, mas a listagem não recalcula as modalidades distintas.

## Testes

`node --test --test-concurrency=1 tests/vendas/auditoria-classificacao-modalidade-pagamento.test.js`

5 testes, 5 aprovações. Os doze cenários da regra foram medidos no classificador de modalidades recebidas e no fechamento atual:

| Cenário | Regra | Fechamento atual |
|---|---|---|
| Só débito aprovado | DÉBITO | misto |
| Só crédito, PIX ou dinheiro | o próprio nome | misto no fluxo direto |
| Débito + crédito, débito + PIX, PIX + dinheiro | MISTO | misto |
| Dois débitos | DÉBITO | misto, porque há dois registros |
| Débito aprovado e crédito recusado | DÉBITO | misto |
| PIX pendente, sem outro recebimento | PENDENTE | não entra na lista exportada e não vira misto |
| Reabertura | a parcela continua débito | o cabeçalho gravado continua misto |

## Plano de correção

Não aplicado nesta auditoria.

1. Classificar o cabeçalho pelas modalidades distintas com status recebido. Um débito, ainda que em dois registros, fica débito. Duas modalidades ficam misto.
2. Não forçar `misto` em `iniciarFechamentoDireto` nem no ramo `lista_sequencial` só porque a lista existe.
3. No backend, não usar `pagamentos.length > 1` como sinônimo de misto.
4. Enquanto o modal de valor estiver aberto, não deixar as teclas `1` a `6` trocarem a modalidade.
5. A listagem deve exibir o rótulo da modalidade, e `misto` somente quando houver mais de uma modalidade recebida.

Dinheiro de 20%, fiscal e não fiscal, composição, estoque, TEF, fechamento e emissor ficam fora dessa correção.

## Correção aplicada

A venda `VND-20261112110416` (id 71) foi paga em débito e o detalhe lia `vendas.forma_pagamento`, que tinha sido gravado como `misto`.

A classificação agora usa as modalidades distintas já recebidas. Um débito, mesmo em mais de um registro, fica `cartao_debito`. Duas modalidades diferentes ficam `misto`. O detalhe e a listagem leem as parcelas de `venda_pagamentos` quando elas existem, então a venda 71 passa a aparecer como Débito sem regravar o banco. Vendas novas também gravam o cabeçalho pela mesma regra.
