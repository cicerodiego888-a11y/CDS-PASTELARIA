# MESAS-05.2.2 — Acesso aos pedidos existentes da mesa

O modal da mesa listava o pedido e não oferecia caminho para a conferência. Cada pedido agora tem uma ação que abre o mesmo pedido na conferência da MESAS-05.2.

A tela não foi percorrida no navegador nesta correção. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Causa

`blocoPedidos` só escrevia o resumo: código, estado comercial, preparação, envio e total. A conferência só abria depois de **Finalizar lançamento** no editor. Não havia consulta de um pedido já gravado.

## 2. Fluxo

No pedido ainda não enviado, o botão é **Conferir pedido**. Nos demais, **Ver pedido**. O clique guarda o identificador só como pista de navegação e abre Pedidos.

A tela consulta o atendimento da mesa, o `GET /api/pedidos/:id` e a lista `GET /api/mesas/:id/atendimento/pedidos`. A conferência usa o pedido devolvido pelo servidor, com a preparação da lista da mesa. Essa consulta não grava pedido e não gera venda.

Pedido de outra empresa, inexistente ou fora do atendimento ativo não abre a conferência. Atendimento encerrado ou em fechamento também não. Falha de rede limpa a conferência anterior. Uma resposta que chega depois da troca de geração é descartada. O segundo clique no mesmo pedido não navega de novo.

## 3. Estados

| Situação | Ação | Edição | Envio |
|---|---|---|---|
| `NAO_ENVIADO` e pedido comercial aberto | Conferir pedido | Corrigir lançamento, pelo fluxo já existente | Só no botão Enviar pedido para cozinha |
| `EM_PREPARACAO` | Ver pedido | Não | Não |
| `CONCLUIDO` | Ver pedido | Não | Não, e o horário de envio permanece |
| `FATURADO`, `CANCELADO` ou `ORCAMENTO` | Ver pedido | Não | Não |

**Lançar pedido** continua criando outro pedido na mesma mesa. Depois de uma alteração, a lista do painel é substituída, sem acrescentar uma cópia.

## 4. Arquivos

- `frontend/erp/js/mesas-conferencia.js`
- `frontend/erp/js/mesas-painel.js`
- `frontend/erp/js/mesas-lancamento.js`
- `frontend/erp/js/pedidos.js`
- `frontend/erp/js/app.js`
- `tests/erp/mesas-05-2-2-acesso-pedidos-existentes.test.js`

Não houve rota nova, nem alteração de venda, pagamento, estoque, ficha, F×NF, MUV, TEF ou fiscal.

## 5. Testes

`node --test --test-concurrency=1`, uma suíte por vez.

| Suíte | Resultado |
|---|---|
| `tests/erp/mesas-05-2-2-acesso-pedidos-existentes.test.js` | 4 de 4 |
| `tests/erp/mesas-05-2-1-ciclo-mesa.test.js` | 10 de 10 |
| `tests/erp/mesas-05-2-envio-preparacao.test.js` | 6 de 6 |
| `tests/erp/mesas-05-1-abertura-pedidos.test.js` | 6 de 6 |
| `tests/erp/mesas-05-painel.test.js` | 8 de 8 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |

A suíte nova cobre conferência do mesmo identificador, ausência de pedido novo, dados persistidos, ver pedido em preparação e concluído, bloqueio de faturado e cancelado, pedido inexistente, outra empresa, atendimento encerrado, duplo clique, rede, resposta atrasada, atualização da lista e o lançamento de pedido novo.

## 6. Limitações

Cozinha, impressão e KDS continuam sem destino real. A tela não foi percorrida no navegador. É preciso atualizar a página do ERP para carregar o painel novo.

## 7. Classificação

- CONCLUÍDO: o modal abre o pedido existente na conferência ou na visualização do estado real.
- TESTADO: as oito suítes acima.
- HOMOLOGADO: não. A ação não foi percorrida no navegador.
- BLOQUEADO: cozinha, impressão e KDS.
