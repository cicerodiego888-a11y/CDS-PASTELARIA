# Correção da classificação da modalidade de pagamento

**ID:** CDS-PDV-CLASSIFICACAO-PAGAMENTO-02  
**Base:** `docs/arquitetura/AUDITORIA-CLASSIFICACAO-MODALIDADE-PAGAMENTO.md`

## Causa raiz

O fechamento direto gravava `vendas.forma_pagamento = misto` porque existia uma lista de parcelas, e não porque havia duas modalidades. A listagem lia esse cabeçalho. A parcela em `venda_pagamentos` continuava `cartao_debito`.

Com o modal de valor aberto e o campo sem foco, as teclas 3 e 4 ainda chamavam a escolha de débito e crédito.

## O que já estava corrigido

Um único classificador, `frontend/shared/js/classificacaoModalidadePagamento.js`, normaliza `cartao_debito`, `debito` e `DÉBITO` para a mesma modalidade, e o mesmo para crédito, PIX e dinheiro. Misto só sai quando há duas modalidades distintas já recebidas. Recusado, falho e pendente ficam de fora. Só pendente vira `pendente`.

Esse módulo já era usado por:

- `iniciarFechamentoDireto` e o ramo `lista_sequencial` em `frontend/pdv/js/pdv.js`
- `VendaPagamentoService.js`, que grava `vendas.forma_pagamento`
- `MotorFinalizacaoVenda.js` e `PDVUniversalVendaAdapter.js`
- `pdv-fechamento-oficial.js`
- o detalhe e a listagem do ERP

As parcelas continuam com a forma original em `venda_pagamentos.forma_pagamento`. Vendas antigas não são regravadas. Sem parcelas, a tela usa o cabeçalho histórico.

## O que esta sprint completou

- A listagem do PDV passou a usar a mesma função do ERP, `formaExibidaDaVenda`.
- `pendente` deixou de ser trocado pelo valor alternativo no fechamento.
- Com o modal de valor aberto, as teclas 1 a 6 não escolhem outra modalidade. O campo recebe a digitação. Enter confirma e Esc fecha só esse modal. Fora dele, os atalhos do pagamento voltam. O listener não age quando a tela de pagamento está fechada.

## Venda 71

Forma registrada: `cartao_debito`. Cabeçalho histórico: `misto`, não regravado. Classificação exibida: Débito. A parcela não é duplicada e o valor não muda. O banco oficial não foi aberto.

## Vendas novas

Um débito fecha com `forma_pagamento = cartao_debito` e a parcela também `cartao_debito`. PIX mais dinheiro fecha com `misto`, e cada parcela guarda a própria forma.

## Cenários

| # | Resultado |
|---|---|
| 1 Um débito | Débito |
| 2 Dois débitos | Débito |
| 3 Um crédito | Crédito |
| 4 Dois créditos | Crédito |
| 5 Um PIX | PIX |
| 6 Um dinheiro | Dinheiro |
| 7 Débito + PIX | Misto |
| 8 Débito + crédito | Misto |
| 9 PIX + dinheiro | Misto |
| 10 Débito aprovado + crédito recusado | Débito |
| 11 PIX aprovado + PIX pendente | PIX |
| 12 Só pendente | Pendente |
| 13 Reabertura | a mesma classificação |
| 14 Sem parcelas | o cabeçalho histórico |
| 15 Cabeçalho misto e uma parcela de débito | Débito |
| 16 Venda 71 | Débito, histórico intacto |
| 17 Listagem ERP | a mesma função |
| 18 Listagem PDV | a mesma função |
| 19 Fechamento com um débito | `cartao_debito` |
| 20 Fechamento com duas modalidades | `misto` |
| 21 Tecla 4 no modal de valor | digita, não vira crédito |
| 22 Tecla 3 no modal de valor | digita, não vira débito |
| 23 Digitação | `61,9` permanece no valor |
| 24 Enter e Esc | confirma e cancela o modal; fora da tela de pagamento a tecla 4 não faz nada |

`node --test --test-concurrency=1` nos arquivos `tests/vendas/classificacao-modalidade-pagamento-02.test.js` e `tests/vendas/auditoria-classificacao-modalidade-pagamento.test.js`: 30 testes, 30 aprovações. Nenhum deles abre o banco oficial.

## Classificação do resultado

| Camada | Estado |
|---|---|
| Classificador, fechamento e gravação do cabeçalho | corrigido e testado em isolamento |
| Detalhe, listagem do ERP e listagem do PDV | corrigido e testado em isolamento |
| Venda 71 | testada pelo formato já conhecido da venda; o registro oficial não foi lido nem alterado |
| Teclado do modal | corrigido e testado pela decisão da tecla |
| Tela do PDV com operador | não validada nesta sessão; é preciso atualizar a página |
| Dinheiro de 20%, fiscal e não fiscal, composição, estoque, TEF, PIX, NFC-e e chaves estrangeiras | não alterados |

O rótulo na tela é Débito, Crédito, PIX, Dinheiro, Misto ou Pendente. O código gravado continua `cartao_debito`, `cartao_credito`, `pix`, `dinheiro`, `misto` ou `pendente`.
