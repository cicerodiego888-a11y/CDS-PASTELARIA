# PDV-MOBILE-02 — Venda mobile com pagamento sequencial

A tela do celular encaminha o pedido e fecha a venda pelo mesmo contrato do PDV do computador. Não há segundo núcleo de preço, estoque, pagamento ou NFC-e.

Esta entrega não é homologação no aparelho. PIX, débito e crédito continuam dependendo da estação que tem o pinpad.

## Arquivos

Criados:

- `frontend/mobile-pdv/index.html`
- `frontend/mobile-pdv/mobile-pdv.css`
- `frontend/mobile-pdv/mobile-pdv.js`
- `frontend/pdv/js/pdv-fechamento-oficial.js`
- `tests/mobile-pdv/pdv-mobile-02.test.js`

Alterados:

- `backend/server.js` — `GET /mobile-pdv`.
- `frontend/shared/js/pdv-acesso-oficial.js` — `/mobile-pdv` no retorno seguro do login.
- `frontend/mobile-pedido/index.html` e `mobile-pedido.js` — botão **Enviar para o PDV**.
- `frontend/shared/js/tefFluxoPagamento.js` — `montarParcelasListaSequencial`, a mesma montagem que o PDV já fazia no ramo `lista_sequencial`.
- `frontend/pdv/js/pdv.js` — o fechamento desktop passa a chamar essa função. O corpo da parcela não mudou.

Não foram alterados `VendaApplicationService`, `VendaPagamentoService`, o motor de recomposição, o estoque, o emissor nem o PDV Universal.

## Encaminhamento do pedido

Na confirmação de `/mobile-pedido`, **Enviar para o PDV**:

1. `POST /api/pedidos/:id/preparar-venda-pdv` com o token e `X-Empresa-Id`.
2. Confere `empresa_id` da composição com a empresa da sessão.
3. Se o pedido já tem venda concluída ou `venda_id`, avisa e não abre outro fechamento.
4. Grava o JSON oficial em `sessionStorage.pdvPedidoHandoff`.
5. Abre `/mobile-pdv` na mesma aba.

Pedido cancelado continua sendo recusado por `prepararOperacaoPdv`. Preparar de novo reutiliza a mesma operação. O carrinho digitado no pedido não substitui o snapshot.

## Fechamento

`/mobile-pdv` mostra empresa, operador da sessão, pedido, itens e total do snapshot. O desconto do snapshot não é editado.

O pagamento usa `PagamentoSequencial` e `InteracaoPagamentoMisto`, os mesmos do computador. A ordem das parcelas é a ordem em que foram confirmadas.

- Dinheiro entra como parcela `informada`, confirmação manual, recebimento não fiscal.
- PIX, débito e crédito só entram com retorno aprovado e `tef_transacao_id`. Pendente, recusa e falha de comunicação não viram parcela recebida.
- Com dinheiro e a soma fechada, a tela chama `POST /api/vendas/composicao-sequencial`. A recomposição, a tolerância de 20% e o arredondamento saem desse serviço. A tela não recalcula.
- A distribuição sai de `POST /api/vendas/pre-calcular-distribuicao`. Se essa chamada falha, a venda não é enviada.
- A gravação é `POST /api/vendas`, com `origem: PDV`, `chave_fechamento_pdv`, `pedido_id`, `pedido_faturamento_operacao_id` e `pagamento_sequencial: true`.
- As parcelas do corpo são as de `montarParcelasListaSequencial`, a mesma função do `executarFinalizacaoVenda`.
- Depois da venda, `POST /api/pedidos/:id/finalizar-venda-pdv`.
- Segundo clique e venda já persistida não geram outra venda. Sem caixa aberto, o servidor recusa e a tela mostra o erro.

Venda avulsa, sem pedido, pesquisa em `GET /api/produtos/consulta-pdv/buscar` e usa o preço promocional ou `preco_venda` devolvido pela API. Não usa o motor de atacado nem a etiqueta de balança do PDV desktop.

## Igualdade com o computador

Para a mesma lista de parcelas já confirmadas, o JSON de `pagamentos` do celular é o retorno de `montarParcelasListaSequencial`. O PDV desktop, no ramo sequencial, grava essa mesma lista. A classificação fiscal ou não fiscal de cada parcela e a recomposição continuam no servidor, quando a tela pede `composicao-sequencial` e `pre-calcular-distribuicao`.

A ordem PIX depois de dinheiro, ou dinheiro depois de PIX, é preservada no corpo. O resultado da recomposição não é recalculado na página.

## TEF e NFC-e

O navegador do celular não é a estação do pinpad. Sem `electronAPI`, a tela não chama `POST /api/tef/pagar` e avisa que PIX, débito e crédito são confirmados na estação. Não há aprovação simulada na interface.

`emitir_fiscal` segue falso. A tela não chama `POST /api/fiscal/emitir/venda/:id`. Se o `POST /api/vendas` devolver um resultado fiscal, ele é mostrado. Nesta entrega não há transmissão à SEFAZ.

O incremento de R$ 0,05 do dinheiro permanece no serviço de recomposição já existente. A tela não criou outra regra.

## Testes

`node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-02.test.js`

Banco temporário `%TEMP%\cds-mobpdv02-*`, com bloqueio do banco oficial. 14 testes, 14 passaram.

No banco de testes, um pedido `EQUIPE` foi preparado duas vezes na mesma operação, o snapshot conferiu empresa, quantidade e total, o corpo saiu com `origem: PDV` e a chave de fechamento, o pedido cancelado foi recusado na segunda preparação e `vendas` permaneceu em zero.

Em seguida, sem falha:

- `tests/pdv/sprint-25-interacao-sequencial.test.js` — 4
- `tests/vendas/pedido-pdv-composicao.test.js` — 19
- `tests/faturamento/sprint35-pedidos-ui.test.js` — 5

## Limitações

- Não houve uso manual no celular. O processo do CDS que já estava aberto precisa ser reiniciado para servir `/mobile-pdv`.
- PIX, débito e crédito no aparelho ficam bloqueados até a estação com pinpad. O computador continua autorizando pelo fluxo TEF atual.
- A NFC-e não é pedida por esta tela.
- A venda avulsa não passa pelo MIP nem pelo preço de atacado do PDV desktop.
- Caixa fechado continua impedindo o `POST /api/vendas`.
- No modo Empresa única, se `pdv_empresa_id` for outra empresa, o snapshot não é carregado.

## Estado

| Estado | Situação |
|---|---|
| CONCLUÍDO | O pedido do celular abre `/mobile-pdv` com o snapshot oficial e o fechamento sequencial usa o `POST /api/vendas` |
| TESTADO | 14 testes da tela e as regressões de pagamento, composição e listagem do ERP |
| HOMOLOGADO | Não. Falta a conferência manual no navegador do celular, com caixa de testes |
| BLOQUEADO | Pagamento eletrônico no aparelho, enquanto o pinpad estiver só na estação, e a emissão de NFC-e por esta tela |
