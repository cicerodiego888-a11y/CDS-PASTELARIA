# MOBILE-PEDIDO-02 — Primeira interface mobile de pedidos

Casca mobile no frontend atual do CDS. A gravação continua em `POST /api/pedidos`. O canal segue `EQUIPE`, definido no servidor. Não há segundo núcleo, `PedidoLoader`, API nova, banco novo, `CARDAPIO_WEB`, PDV nem emissão fiscal.

Esta entrega não é homologação operacional. A conferência no celular fica para o navegador, no ambiente de testes.

## Arquivos

Criados:

- `frontend/mobile-pedido/index.html`
- `frontend/mobile-pedido/mobile-pedido.css`
- `frontend/mobile-pedido/mobile-pedido.js`
- `tests/mobile-pedido/mobile-pedido-02.test.js`

Alterados:

- `backend/server.js` — rota `GET /mobile-pedido`.
- `frontend/shared/js/pdv-acesso-oficial.js` — `/mobile-pedido` entra nos destinos seguros do login (`?next=`).
- `frontend/erp/js/pedidos.js` — apenas publica as funções de preço e personalização que a casca chama (`cdsPedidoResolverPrecoSugerido`, `cdsPedidoCalcularTotaisPersonalizacao`, `cdsPedidoPersonalizacaoEquivalente`). O modal desktop não foi reescrito.

## Estrutura da interface

Endereço: `/mobile-pedido`. Sem sessão, a página vai para `/login?next=/mobile-pedido`.

Cabeçalho com a marca CDS Sistemas e a empresa do `CdsEmpresaContexto`. Sem empresa selecionada, e havendo uma só empresa disponível, a página seleciona essa empresa pelo mesmo contexto. Com várias, o operador escolhe antes de gravar. A gravação não dispara sem `X-Empresa-Id`.

Quatro etapas, em botões próprios, fora do modal `modal-xl`:

1. Cliente — `GET /api/clientes/buscar?termo=`. Cliente é opcional.
2. Produtos — `GET /api/produtos/consulta-pdv/buscar?q=&limite=15`, depois `GET /api/produtos/:id`. Se o produto personaliza, `GET /api/produtos/:id/ficha-tecnica`.
3. Carrinho — quantidade, preço unitário editável no item comum, desconto percentual, subtotal, remoção. O preço do item personalizado permanece somente leitura.
4. Conferência — empresa, cliente, itens, desconto do pedido, observação geral e total. O botão grava.

Depois da resposta, a tela mostra o código devolvido, a empresa e o cliente, e avisa que o registro é um pedido, não uma venda. “Novo pedido” limpa o carrinho. Não há chamada a `/pdv`.

O carrinho fica na memória da página. Trocar de etapa não apaga os itens. Fechar o navegador perde o rascunho.

## Contratos reutilizados

| Uso | Contrato |
|---|---|
| Sessão | token já gravado no login |
| Empresa | `CdsEmpresaContexto` e `X-Empresa-Id` |
| Clientes | `GET /api/clientes/buscar` |
| Catálogo | `GET /api/produtos/consulta-pdv/buscar` e `GET /api/produtos/:id` |
| Ficha | `GET /api/produtos/:id/ficha-tecnica` |
| Preço | as mesmas funções de `pedidos.js`: `preco_pedido`, depois promoção, depois `preco_venda`, com os snapshots `PRECO_PEDIDO`, `PROMOCAO` e `PRECO_VENDA` |
| Gravação | `POST /api/pedidos`, `Idempotency-Key`, `tipo: pedido`, `status: PEDIDO`. O corpo não envia canal |
| Núcleo | `EntradaPedidoService` → `PedidoOperacionalService` → `PedidoRepository` |

Um segundo clique enquanto a gravação está em curso não faz outro `POST`. Falha de rede, `EMPRESA_CONTEXT_REQUIRED`, `PEDIDO_TOTAL_INCONSISTENTE`, `UNIDADE_ESTOQUE_INVALIDA`, `MODULO_NAO_LICENCIADO` e `401` mantêm o carrinho e mostram a mensagem. Pesquisa de cliente ou produto com erro também mostra a mensagem.

## Segundo núcleo

Não foi criado. A página não tem repositório, cálculo de estoque nem canal próprio. O preço sugerido e os adicionais da ficha saem das funções já usadas pelo ERP. O total enviado é a soma que o servidor volta a conferir.

## Testes

`node --test --test-concurrency=1 tests/mobile-pedido/mobile-pedido-02.test.js`

Banco temporário em `%TEMP%\cds-mobped02-*`, com `CDS_TEST_ISOLATION=1` e `CDS_BLOQUEAR_BANCO_OFICIAL=1`. O caminho do arquivo não contém `ProgramData\MercantilFiscal`. Nenhuma NFC-e, TEF ou PIX.

Resultado: 9 testes, 9 passaram, 0 falharam.

Cobertos: sessão, bloqueio sem empresa, pesquisa de cliente e de produto com erro visível, regra de preço, inclusão, alteração, remoção e troca de etapa sem perder o carrinho, personalização, payload com snapshots e `Idempotency-Key`, ausência de canal no corpo, bloqueio do segundo envio, código retornado, erros do backend e ausência de `/pdv`.

A gravação de evidência usou `EntradaPedidoService.receber` com o payload montado pela casca. O pedido foi lido de volta por `PedidoRepository.obterPorId`: `origem_canal` `EQUIPE`, empresa da fixture, cliente nulo, um item com quantidade 2, e nenhuma linha em `vendas`.

Em seguida, os testes da tela desktop continuaram passando: `sprint35-pedidos-ui` (5) e `sprint36-pedidos-ux` (7).

## Limitações

- Não houve uso manual no navegador de um celular. Homologação operacional permanece em aberto.
- O processo do CDS que já estava aberto antes desta rota não a serve até ser reiniciado.
- Carrinho só em memória. Sem rascunho persistente, sem observação livre por item, sem PWA e sem aplicativo nativo.
- As falhas já registradas na auditoria não foram corrigidas: baixa de estoque do teste central, `UNIDADE_ESTOQUE_INVALIDA` do cenário de mesa, coluna `utiliza_ficha_tecnica` duplicada no teste em migração, e a asserção antiga de fonte do nome comercial.
- Se o backend recusar o produto por unidade de estoque, a casca mostra `UNIDADE_ESTOQUE_INVALIDA` e conserva o carrinho. Não contorna a validação.

## Estado

| Estado | Situação |
|---|---|
| CONCLUÍDO | A casca mobile grava pelo contrato existente e mostra o código do pedido |
| TESTADO | 9 testes da casca e a regressão da tela desktop de pedidos |
| HOMOLOGADO | Não. Falta a conferência manual no celular |
| BLOQUEADO | Uso operacional no aparelho, até essa conferência. O núcleo antigo de estoque, mesa e ficha técnica permanece como estava |
