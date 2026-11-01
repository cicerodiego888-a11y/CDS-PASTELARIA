# Sprint 32 — Gatilho do dinheiro, unidades inteiras e tolerância existente

Implementação no fluxo de fechamento do PDV. A homologação visual e operacional permanece com o usuário. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` continua `false`. Nenhum pagamento real e nenhum documento foi enviado à SEFAZ.

## 1. Diagnóstico do fluxo anterior

A Sprint 31 já classificava o dinheiro confirmado como não fiscal e só persistia a NFC-e com a distribuição autorizada. A composição, porém, só era pedida quando a soma das parcelas já fechava o total. Selecionar Dinheiro não marcava a espera, e a tela não mostrava a composição fiscal separada do carrinho. Uma parcela digital pendente impedia o saldo de fechar, mas o módulo não dizia, de forma explícita, que a composição estava suspensa.

## 2. Regra original dos 20%

Serviço: `backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js`.

Fórmula confirmada no código:

`margem_maxima = 0,20 × soma dos pagamentos em dinheiro`

O mesmo serviço declara `nao_e_desconto: true` e `aplicou_desconto_automatico: false`. O motor `buscarComposicao`, em `ComposicaoFiscalPedidoService.js`, usa essa margem só para limitar a faixa `[alvo − margem, alvo]`. O comentário do motor diz que a margem não é desconto nem classificação fiscal.

Há outro desconto, em `PedidoPdvComposicaoService.js`: quando a composição do pedido fica acima do residual, `desconto = total composto − residual`. Esse desconto não é limitado a 20% do dinheiro e pertence ao pedido, não ao fechamento fiscal do PDV.

Por isso a diferença dentro da tolerância não foi convertida em `vDesc`. Inventar essa conversão contradiria o contrato existente. O excedente fora da margem continua no código já existente: `MARGEM_INSUFICIENTE`, sem fracionar a unidade e sem criar desconto.

## 3. Arquivos alterados

- `frontend/pdv/js/pagamentoSequencial.js` — marca a recomposição quando há dinheiro e suspende a composição enquanto houver autorização digital pendente.
- `frontend/pdv/js/pdv.js` — painel da composição fiscal no pagamento misto e no direto; cancelar o fluxo invalida a composição.
- `backend/services/vendas/PagamentoRecomposicaoDocumentoService.js` — apresentação somente leitura da composição já calculada.
- `backend/rotas/vendas.js` — a rota `composicao-sequencial` devolve essa apresentação.
- `tests/pdv/sprint-32-gatilho-dinheiro-recomposicao.test.js`

Não foi criado outro motor de pagamento, composição ou distribuição.

## 4. Gatilho Dinheiro

Ao existir parcela em dinheiro, `recomposicaoNecessaria()` fica verdadeiro. Se ainda houver parcela digital pendente, ou se o saldo da venda não fechou, a tela informa que a composição aguarda os pagamentos digitais e a avaliação não é chamada. PIX, débito e crédito pendentes, recusados ou com falha não entram na referência. Cancelar o modal sem confirmar invalida a composição e não emite documento.

## 5. Três ordens

As três sequências foram exportadas por `PagamentoSequencial.exportar` e avaliadas pela referência existente:

1. Dinheiro, PIX, débito, crédito.
2. PIX, dinheiro, débito, crédito.
3. PIX, débito, crédito, dinheiro.

Nas três, a referência foi R$ 50,00 fiscal e R$ 10,00 não fiscal.

## 6. Dinheiro sempre não fiscal

Cada parcela de dinheiro saiu com `tipo_recebimento: 'nao_fiscal'`, confirmação manual e sem `aprovado: false`. Duas parcelas de R$ 4,00 e R$ 6,00 somaram R$ 10,00 não fiscais. O dinheiro não exige transação TEF.

## 7. Unidade não fracionada

A avaliação com quantidade 1,8 não produz totais inteiros e devolve `DISTRIBUICAO_INCOMPATIVEL_QUANTIDADE_INTEIRA`. A unidade de preço inteiro encontrada dentro da margem permanece inteira. Volume de 200 ml, quando informado, é preservado na apresentação. Não é gerado 180 ml nem outra fração.

## 8. Fórmula e desconto

Margem de R$ 10,00 em dinheiro: R$ 2,00. A avaliação dentro e fora da margem devolve `aplicou_desconto: false`. A apresentação fiscal grava `desconto_ajuste: 0` e `desconto_convertido_da_margem: false`. Fora da margem, o código existente é `MARGEM_INSUFICIENTE`. O preço de cadastro e o preço do carrinho não são alterados.

## 9. Composição na interface

O pagamento misto mostra `#painelComposicaoFiscalPdv` e o pagamento direto mostra `#painelComposicaoFiscalDireta`. O texto identifica a composição fiscal da venda, lista produto, quantidade inteira, volume quando existir e valores fiscal e em dinheiro. Não há campo para o operador editar quantidade fiscal. Bloqueio do backend aparece com código e motivo. A conferência foi feita no código e nos testes. A tela em operação não foi homologada.

## 10. Distribuição e persistência

O fechamento continua o da Sprint 31: referência, composição pastel/residual, distribuidor oficial da empresa da venda e gravação das quantidades fiscais e não fiscais. Sem autorização, a venda é preservada com quantidade fiscal zerada. A mesma `chave_fechamento_pdv` não cria outra venda.

## 11. XML

O XML sintético conferido na Sprint 31 permanece o contrato do emissor: `vProd` e `vNF` iguais à soma dos itens fiscais autorizados, pagamentos só eletrônicos e dinheiro fora do documento. Nesta sprint não foi introduzido `vDesc` a partir da margem de 20%, porque o contrato existente proíbe essa conversão.

## 12. Regressões

Executadas em sequência, cada uma no próprio banco temporário.

| Suíte | Resultado |
|---|---|
| Sprint 32 | 4 testes, 0 falhas |
| Sprint 26 | 8 testes, 0 falhas |
| Sprint 28 | 8 testes, 0 falhas |
| Sprint 29 | 9 testes, 0 falhas |
| Sprint 31 | 5 testes, 0 falhas |

## 13. Limitações

- A margem de 20% do dinheiro não é desconto. O desconto global do pedido continua em outro serviço e não foi acoplado ao fechamento fiscal.
- A flag de produção permanece desligada. A distribuição autorizada no fechamento continua dependendo do ambiente de teste e da autorização do distribuidor.
- A composição exibida vem do backend. Sem o ambiente de teste, a avaliação não produz itens fiscais e a tela mostra o bloqueio.
- A homologação na tela do PDV não foi feita.
