# Sprint 28 — pagamento, recomposição e XML da NFC-e

O dinheiro confirmado passou a encaminhar a referência da Sprint 26 ao motor de composição já existente e ao distribuidor oficial. O XML da NFC-e é montado só com as linhas fiscais autorizadas. A flag de produção permanece falsa. Não houve homologação operacional.

Data: 01/11/2026.

## 1. Causa raiz

A confirmação do dinheiro calculava a referência (R$ 40,00 fiscal e R$ 10,00 não fiscal na venda de R$ 50,00) e chamava o motor com modelos vazios. O retorno era `COMPOSICAO_AUSENTE_NO_MOTOR`. A NFC-e continuava a ser montada com os itens comerciais, cuja soma era R$ 50,00. O total da venda não era reduzido dentro do XML: os itens é que não tinham passado pela composição nem pelo distribuidor.

## 2. Arquivos alterados

- `backend/services/vendas/PagamentoRecomposicaoDocumentoService.js`
- `backend/rotas/vendas.js`
- `backend/services/fiscal/emissor.js`
- `frontend/pdv/js/pdv.js`
- `tests/pdv/sprint-28-recomposicao-documento.test.js`

Não foram alterados a fórmula da Sprint 26, o motor pastel → residual → refrigerantes, o distribuidor F×NF, o estoque, a ficha técnica e `RECOMPOSICAO_HABILITADA_EM_PRODUCAO`.

## 3. Fluxo anterior e fluxo corrigido

Antes: a parcela em dinheiro, no direto ou no misto, pedia a referência sem os itens do carrinho. O fechamento fiscal seguia com o carrinho comercial.

Agora, com o pagamento completo e `CDS_RECOMPOSICAO_REFERENCIA_TESTE=1`:

1. A referência continua a soma do PIX, débito e crédito confirmados, e a soma do dinheiro recebido. Pendente, rejeitada e falha ficam de fora.
2. Havendo pastel da categoria `PASTEIS`, o valor desse pastel é fixado e o residual até a referência fiscal vai para `avaliarCandidatoComBuscarComposicao`. Os modelos saem do teste ou de `PedidoPdvComposicaoService`. O corpo da requisição não envia catálogo.
3. A proposta segue para `encaminharPropostaValidadaAoDistribuidorOficial`, com o saldo da empresa da venda. Saldo de outra empresa não entra na conta.
4. `buildNfceXml` recebe somente as linhas com quantidade e valor fiscais. O dinheiro confirmado vai como recebimento não fiscal e não entra no `vPag`. Se a soma dos itens fiscais divergir do total autorizado, o XML não é montado.

Sem a variável de teste, a função não monta documento e o PDV segue o fechamento anterior. A produção continua desligada.

## 4. Como a referência chega ao motor

`avaliarReferenciaRecomposicao` produz `valor_fiscal_referencia` e `valor_nao_fiscal_referencia`. O serviço novo usa o fiscal como teto: subtrai o pastel elegível e entrega o residual ao núcleo `buscarComposicao`, junto com a margem de dinheiro já existente. Sem modelo elegível o código é `COMPOSICAO_AUSENTE_NO_MOTOR` e nenhum produto é criado.

## 5. Como os itens fiscais chegam ao XML

O distribuidor oficial devolve `quantidade_fiscal` e `valor_fiscal` por item. Só essas linhas entram em `buildNfceXml`. No exemplo de R$ 50,00, o pastel de R$ 20,00 e quatro refrigerantes de R$ 5,00 formam `vProd` e `vNF` de R$ 40,00. Dois refrigerantes, R$ 10,00, ficam fora da NFC-e. O emissor, com a variável de teste ligada e a produção desligada, usa essa lista. Se a preparação vier bloqueada, a emissão para antes da SEFAZ.

## 6. Testes

`node --test --test-concurrency=1 tests/pdv/sprint-28-recomposicao-documento.test.js`: 8/8.

Em seguida, `tests/pdv/sprint-26-recomposicao-referencia-teste.test.js`: 8/8. Banco temporário da Sprint 26. A referência financeira permaneceu a das parcelas confirmadas.

| Cenário | Resultado |
| --- | --- |
| 1. R$ 40,00 eletrônicos + R$ 10,00 em dinheiro | XML com `vNF` R$ 40,00 |
| 2. R$ 50,00 só em dinheiro | `REFERENCIA_FISCAL_ZERO`, sem XML |
| 3. R$ 50,00 só eletrônicos | XML com `vNF` R$ 50,00 |
| 4 e 5. Dinheiro como última parcela no direto e no misto | Mesma referência e o mesmo XML |
| 6. Rejeitada ou pendente | Fora da referência; `PAGAMENTO_INCOMPLETO`; sem XML |
| 7. Sem composição elegível | `COMPOSICAO_AUSENTE_NO_MOTOR`; sem produto inventado |
| 8. Pastel e residual de refrigerante | Pastel 1 + refrigerante fiscal 4 |
| 9. Saldo da empresa | Empresa com saldo fiscal 1 no refrigerante: `SALDO_INSUFICIENTE` |
| 10. XML | `vProd` 40, `vNF` 40, `vPag` 40, sem troco e sem dinheiro |

Não houve TEF real, PIX real, emissão à SEFAZ nem abertura do banco oficial. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false`.

## 7. Limitações

A recomposição do documento só corre com `CDS_RECOMPOSICAO_REFERENCIA_TESTE=1`. Sem essa variável, o PDV não bloqueia o fechamento e o emissor não troca os itens.

A aplicação no distribuidor oficial continua dependente da autorização interna já existente (`CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR` ou o harness de teste). Sem ela, o código é `AUTORIZACAO_AUSENTE` e a NFC-e não é montada com o carrinho de R$ 50,00.

O pastel só é reconhecido pela categoria `PASTEIS`, no item ou no cadastro do produto. Sem pastel elegível e com referência fiscal menor que o total, o documento para em `SEM_PASTEL_ELEGIVEL`.

A tela do PDV em execução não foi aberta, para não usar o banco oficial. A homologação visual e operacional fica para o ambiente de teste.
