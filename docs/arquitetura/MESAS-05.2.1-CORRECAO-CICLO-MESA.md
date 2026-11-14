# MESAS-05.2.1 — Correção do ciclo da mesa

A mesa ficava ocupada porque a conclusão da venda não atualizava o atendimento. O lançamento da mesa também parava na lista de Pedidos e esperava o clique em Novo. As duas correções usam o fluxo que já existia.

A tela não foi aberta no navegador. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Causa da mesa ocupada

`POST /api/vendas` grava a venda em `VendaPagamentoService.criarVenda`, chamado por `VendaApplicationService.concluirVendaNoNucleoOficial`. O pedido de salão só fica `FATURADO` depois, em `POST /api/pedidos/:id/finalizar-venda-pdv`, quando `FaturamentoService.finalizarVendaPdvPedido` confirma a operação `PDV_COMPOSICAO` já persistida.

Nenhum desses passos lia `mesa_atendimentos`. `FATURADO` sozinho não torna a mesa livre. Livre continua sendo a ausência de atendimento `OCUPADA` ou `FECHAMENTO`.

## 2. Quando o atendimento encerra

Depois que `finalizarVendaPdvPedido` confirma a venda, uma transação seguinte avalia o atendimento do pedido. Ela não entra na transação da venda: essa conexão exclusiva já foi commitada e fechada. Se a avaliação falhar, a venda permanece e o atendimento também.

A mesma avaliação roda quando o Controle de Mesas consulta `GET /api/mesas/situacao`. Uma venda concluída antes do processo carregar esta correção libera a mesa na atualização seguinte, sem nova venda. A consulta sem operador não encerra nada.

A mesa só fica livre quando todos os pedidos daquele atendimento estão resolvidos:

- `FATURADO`, com venda da mesma empresa, `status_pagamento` igual a `quitada` e operação `PDV_COMPOSICAO` em `FINALIZADA`; ou
- `CANCELADO` sem venda pendente.

Pagamento `pendente`, `recusado`, `aguardando_nao_fiscal` ou operação ainda não finalizada mantém a mesa ocupada. Um pedido ainda aberto também mantém. `FECHAMENTO` não é usado para liberar a mesa. Pedido sem mesa não mexe em atendimento.

A repetição encontra o atendimento `ENCERRADO` e devolve o mesmo horário, sem outra linha. Atendimento transferido libera a mesa de destino. O `mesa_id` histórico do pedido e a transferência permanecem. Outra empresa não encerra o atendimento.

## 3. Modal de novo pedido

Ao abrir ou recuperar a mesa, o Controle de Mesas grava a intenção de abrir o modal. Pedidos consulta `GET /api/mesas/:id/atendimento` e, com a mesa ocupada confirmada pelo servidor, abre o modal oficial já com a mesa preenchida. O identificador guardado no navegador não escolhe empresa, operador nem atendimento.

O modal oficial é reutilizado. Um segundo clique não empilha outro. Fechar sem salvar não cria pedido. Recarregar Pedidos não abre outro atendimento nem outro pedido: a intenção é consumida na primeira abertura. Mesa em fechamento não abre o modal. Pedido sem mesa segue o caminho antigo, inclusive a pergunta da venda no PDV.

## 4. Arquivos

- `backend/services/pedido/MesaAtendimentoService.js`
- `backend/services/faturamento/FaturamentoService.js`
- `backend/rotas/pedidos.js`
- `frontend/erp/js/mesas-lancamento.js`
- `frontend/erp/js/pedidos.js`
- `tests/erp/mesas-05-2-1-ciclo-mesa.test.js`
- `tests/erp/mesas-05-1-abertura-pedidos.test.js` — a leitura do servidor passou a ser `decidirAberturaModal(data`

O motor de pagamento, o estoque, a ficha, o F×NF, a composição, o MUV, o TEF e o fiscal não foram alterados.

## 5. Testes

`node --test --test-concurrency=1`, uma suíte por vez. Banco temporário da suíte nova: `C:\Users\cicer\AppData\Local\Temp\cds-mesas0521-kwWd5z\mercadao.db`.

| Suíte | Resultado |
|---|---|
| `tests/erp/mesas-05-2-1-ciclo-mesa.test.js` | 9 de 9 |
| `tests/erp/mesas-05-2-envio-preparacao.test.js` | 6 de 6 |
| `tests/erp/mesas-05-1-abertura-pedidos.test.js` | 6 de 6 |
| `tests/erp/mesas-05-painel.test.js` | 8 de 8 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |
| `tests/faturamento/sprint32-pedido-consumido-integracao.test.js` | 25 de 26 |

A falha da Sprint 3.2 está em `VendaPagamentoService`, na venda avulsa sem pedido: `Saldo insuficiente para S313 venda avulsa. Disponível: 8`. Esse caminho não passa pela mesa. A regra de estoque não foi alterada para contornar o resultado.

## 6. Limitações

A liberação depende de cada pedido ter a própria conclusão PDV confirmada. Uma venda única reunindo vários pedidos da mesa continua fora deste ciclo. Cozinha, impressão e KDS continuam sem destino real. A tela não foi percorrida no navegador.

## 7. Classificação

- CONCLUÍDO: mesa liberada só com o atendimento quitado, e modal aberto a partir da mesa confirmada.
- TESTADO: as suítes acima, no banco temporário.
- HOMOLOGADO: não. A tela não foi percorrida no navegador.
- BLOQUEADO: fechamento consolidado de vários pedidos numa venda só; cozinha, impressão e KDS.
