# MESAS-05.3 — Fechamento consolidado da mesa

Dois ou mais pedidos da mesma mesa e do mesmo atendimento podem seguir para uma única venda no PDV. A ação **Gerar venda no PDV** de cada pedido continua.

A tela não foi percorrida no navegador. Não houve NFC-e, TEF, pagamento real nem acesso ao banco oficial.

## 1. Arquitetura encontrada

A venda oficial nasce em `VendaApplicationService.concluirVendaNoNucleoOficial`, que chama `VendaPagamentoService.criarVenda`. O PDV monta um carrinho, cobra uma vez e grava uma venda. O estoque e o F×NF são tratados nesse núcleo, uma vez por venda.

O pedido individual entra por `POST /api/pedidos/:id/preparar-venda-pdv`. O PDV recebe um handoff com um `pedido_id` e, depois do pagamento, chama `POST /api/pedidos/:id/finalizar-venda-pdv`. A coluna `vendas.pedido_id` cabe um pedido. `pedidos.venda_id` também é um vínculo simples. Por isso o corpo da venda individual não foi alargado para uma lista de pedidos.

A mesa só fica livre em `MesaAtendimentoService.encerrarAtendimentoQuitado`, quando todos os pedidos do atendimento estão faturados, o pagamento está `quitada` e a operação `PDV_COMPOSICAO` está `FINALIZADA`.
O estado da venda também precisa ser `concluida`; um pagamento quitado não libera uma venda cancelada ou não concluída.

## 2. Vínculo

`vendas.pedido_id` permanece vazio na venda consolidada, para não parecer que a venda pertence a um único pedido.

O histórico fica em três tabelas:

- `venda_consolidacoes`: empresa, mesa, atendimento, venda, chave de idempotência, operador, total e o contrato.
- `venda_consolidacao_pedidos`: um pedido só pode estar em uma consolidação.
- `venda_consolidacao_itens`: cada linha guarda o pedido e o item de origem, o preço gravado e a observação do pedido.

Cada pedido participante recebe `pedidos.venda_id` da mesma venda e uma operação `PDV_COMPOSICAO` `FINALIZADA`.

## 3. Fluxo

Na listagem, a mesa com pelo menos dois pedidos elegíveis mostra **Gerar venda consolidada da mesa**. O modal lista itens, quantidades, observações e o total lidos do servidor. Dá para tirar um pedido, desde que restem dois. A confirmação só reserva a operação.

O PDV abre com os itens e os preços já gravados nos pedidos. O pagamento é o pagamento normal do PDV, uma vez. A venda não leva `pedido_id`. Depois da gravação, `POST /api/pedidos/venda-consolidada-mesa/:id/vincular` liga todos os pedidos àquela venda. Se o vínculo falhar, a repetição usa a venda já gravada e não abre outra.

O contrato enviado ao núcleo soma os subtotais persistidos. Não consulta o preço atual do cadastro.

O PDV usa uma chave de fechamento estável derivada da consolidação. Se a venda já foi persistida e a resposta se perdeu, a repetição recupera a mesma venda pelo registro idempotente do PDV. Se o vínculo falhou, o handoff mantém o identificador da venda e, ao reabrir o PDV, repete apenas o vínculo; não reenvia o pagamento nem cria outra venda.

## 4. Idempotência

A chave vai no cabeçalho `Idempotency-Key` e fica estável para a mesma empresa, mesa, atendimento e seleção. Uma tabela de chaves associa repetições da mesma seleção à reserva original. Reutilizar a chave com outra seleção continua bloqueado. Pedido já reservado não entra em outra consolidação nem no fechamento individual. Falha ambígua na criação mantém a reserva e os participantes sem faturá-los; uma nova tentativa automática é bloqueada até que a existência da venda seja verificada. Falha depois da venda deixa o identificador gravado para o reprocessamento.

A chave também fica vinculada à mesa e à seleção exata de pedidos; reusá-la com outra seleção é recusado. O vínculo confere produto, quantidade, preço e subtotal de cada item, não apenas a quantidade de linhas. Repetir um vínculo já concluído reavalia o encerramento do atendimento, sem criar outra venda.

## 5. Mesa, estoque e fiscal

Pagamento `pendente` ou `recusado`, ou operação que não está `FINALIZADA`, mantém a mesa ocupada. Quitação com todos os pedidos do atendimento resolvidos encerra o atendimento, pelo mesmo serviço da MESAS-05.2.1. Um pedido ainda aberto no atendimento segura a mesa.

A baixa de estoque e a classificação F×NF continuam dentro da venda única do PDV. O serviço de consolidação não escreve saldo nem ficha técnica. Não há um documento fiscal por pedido: se o PDV emitir, emite o documento daquela única venda. Essa emissão não foi homologada.

## 6. Arquivos

- `backend/services/vendas/VendaConsolidadaMesaService.js`
- `backend/services/vendas/VendaApplicationService.js`
- `backend/services/pedido/MesaAtendimentoService.js`
- `backend/rotas/pedidos.js`
- `backend/services/faturamento/PedidoFaturamentoOperacaoRepository.js`
- `backend/services/pedido/PedidoRepository.js`
- `frontend/erp/js/mesas-venda-consolidada.js`
- `frontend/erp/js/pedidos.js`
- `frontend/erp/js/app.js`
- `frontend/pdv/js/pdv.js`
- `tests/erp/mesas-05-3-fechamento-consolidado.test.js`

## 7. Testes

`node --test --test-concurrency=1`, uma suíte por vez, banco temporário.

| Suíte | Resultado |
|---|---|
| `tests/erp/mesas-05-3-fechamento-consolidado.test.js` | 17 de 17 |
| `tests/erp/mesas-05-2-2-acesso-pedidos-existentes.test.js` | 4 de 4 |
| `tests/erp/mesas-05-2-1-ciclo-mesa.test.js` | 10 de 10 |
| `tests/erp/mesas-05-2-envio-preparacao.test.js` | 6 de 6 |
| `tests/erp/mesas-05-1-abertura-pedidos.test.js` | 6 de 6 |
| `tests/erp/mesas-05-painel.test.js` | 8 de 8 |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/vendas/venda-application-service.test.js` | 2 de 2 |
| `tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js` | 1 de 1 |

A suíte nova cobre os 28 casos pedidos: uma venda para dois e para três pedidos, soma e preços gravados, observação e origem, bloqueios, pagamento, falha, idempotência, concorrência, mesa ocupada ou livre, fluxo individual, pedido sem mesa, uma movimentação e F×NF intocado.

Bloqueios/falhas observados nesta execução:

- `tests/vendas/venda-mista-pagamento-integral.test.js`, `tests/pastelaria/pos-venda-venda-pagamento-03-02.test.js` e `tests/faturamento/sprint31-faturamento.test.js` foram bloqueados por `CDS_BANCO_OFICIAL_BLOQUEADO`; não foi liberado acesso ao banco oficial.
- `tests/estoque/venda-baixa-empresa-contexto.test.js` falhou por saldo fiscal indisponível na empresa de teste.
- `tests/faturamento/sprint32-pedido-consumido-integracao.test.js`: 25 de 26; o caso de venda sem Pedido falhou por saldo insuficiente (`Disponível: 8`).
- `tests/faturamento/sprint35-pedidos-ui.test.js`: 4 de 5; falha no critério legado de `frontend/shared/js/core.js`, que libera Pedidos e Mesas juntos. Esse arquivo não foi alterado nesta sprint.

## 8. Limitações

Cozinha, impressão e KDS continuam sem destino. A confirmação no PDV e a tela de Pedidos não foram percorridas no navegador. O processo que está no ar precisa ser reiniciado para publicar a rota nova; a página de Pedidos precisa ser atualizada para mostrar o botão.

## 9. Classificação

- CONCLUÍDO: pedidos elegíveis da mesma mesa seguem para uma venda, com vínculo de todos e liberação só depois da quitação do atendimento.
- TESTADO: as suítes da tabela acima.
- HOMOLOGADO: não. O fluxo não foi percorrido no navegador nem com pagamento real.
- BLOQUEADO: cozinha, impressão, KDS e homologação fiscal da venda consolidada.
