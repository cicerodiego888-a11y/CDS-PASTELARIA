# MESAS-05.1 — Abertura da mesa e lançamento em Pedidos

O garçom confirma a mesa no Controle de Mesas e a tela de Pedidos abre com essa mesa já escolhida. O atendimento continua nascendo só em `POST /api/mesas/:id/atendimento`. O pedido continua nascendo em `POST /api/pedidos`, e o servidor é quem grava `pedidos.mesa_atendimento_id`.

## 1. Causa dos erros

O `409` com a mensagem "Abra o atendimento da mesa antes de lançar o pedido" é `ATENDIMENTO_NAO_ABERTO`. Ele ocorre quando `POST /api/pedidos` traz `mesa_id` e a mesa não tem atendimento `OCUPADA`. A transação desfaz o pedido: a contagem de `pedidos` não muda. O bloqueio permanece.

No banco temporário, o mesmo `POST` com atendimento aberto responde sucesso. O pedido fica com o `mesa_atendimento_id` do atendimento ativo. Um `mesa_atendimento_id` enviado no corpo é ignorado. O segundo pedido usa o mesmo atendimento e não altera `aberto_em`. Mesa em fechamento responde `409` `ATENDIMENTO_EM_FECHAMENTO`. Mesa de outra empresa responde `404` `MESA_NAO_ENCONTRADA`. Pedido sem mesa continua sem atendimento e sem preparação.

O `500` em `POST /api/pedidos` não apareceu nesse caminho. A entrada real, `EntradaPedido.receber`, não foi transformada em sucesso artificial.

## 2. Fluxo

Mesa livre: o modal abre o atendimento e, com a confirmação do servidor, grava no `sessionStorage` a mesa, o atendimento informado pelo servidor e a empresa da sessão. Em seguida chama `loadPage('pedidos')`.

Mesa ocupada: "Lançar pedido" não cria atendimento. Leva o atendimento já consultado para a mesma tela.

Mesa em fechamento: não há lançamento. A faixa avisa que o atendimento não recebe pedido novo. Salvar com essa mesa selecionada é interrompido na tela, e o servidor continua recusando.

A tela de Pedidos lê o `sessionStorage`, consulta `GET /api/mesas/:id/atendimento` e usa somente essa resposta. O título fica **PEDIDO DA MESA 05**, com o número, o estado e o cliente quando o contrato traz o identificador. O nome do cliente não vem da API. O botão "Voltar ao Controle de Mesas" retorna ao painel.

Recarregar Pedidos consulta de novo e não chama a abertura. Dois cliques em "Abrir atendimento" disparam um único `POST`. Conflito `MESA_OCUPADA` não redireciona.

O corpo do pedido envia `mesa_id`. Não envia `empresa_id`, `operador_id` nem `mesa_atendimento_id`.

## 3. Arquivos

- `frontend/erp/js/mesas-lancamento.js`
- `frontend/erp/js/mesas-painel.js`
- `frontend/erp/js/pedidos.js`
- `frontend/erp/js/app.js`
- `tests/erp/mesas-05-1-abertura-pedidos.test.js`

O formulário de Pedidos, o estoque, a ficha, a composição, o F×NF, o MUV, o pagamento e o fiscal não foram alterados. Abrir atendimento não cria venda.

## 4. Testes

`node --test --test-concurrency=1`, uma suíte por vez. Banco temporário da suíte nova: `C:\Users\cicer\AppData\Local\Temp\cds-mesas051-zvO6iv\mercadao.db`.

| Suíte | Resultado |
|---|---|
| `tests/erp/mesas-05-1-abertura-pedidos.test.js` | 6 de 6 |
| `tests/erp/mesas-05-painel.test.js` | 8 de 8 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |

A suíte nova cobre a abertura com redirecionamento, a mesa ocupada sem segundo atendimento, o segundo pedido no mesmo atendimento, a transferência com os pedidos preservados, o fechamento, a outra empresa, o conflito, a recarga sem nova abertura e o pedido sem mesa.

## 5. Limitações

A tela não foi aberta no navegador. O `500` citado pelo operador não foi reproduzido no banco temporário. O contrato de atendimento identifica o cliente pelo número, sem o nome.
