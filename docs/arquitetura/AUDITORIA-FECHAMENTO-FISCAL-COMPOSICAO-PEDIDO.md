# Auditoria do fechamento fiscal após a composição originada do pedido

**ID:** CDS-FISCAL-PEDIDO-FECHAMENTO-AUDIT-01  
**Tipo:** auditoria técnica, somente leitura  
**Classificação:** BLOQUEADO

Nenhum arquivo de produção foi alterado. O banco oficial não foi aberto. Não houve venda, pagamento, TEF, PIX real, transmissão, cancelamento ou evento na SEFAZ. A única escrita desta sprint é este relatório e o teste isolado `tests/vendas/auditoria-fechamento-fiscal-composicao-pedido.test.js`, executado em SQLite `:memory:`.

## 1. Resumo executivo

A preparação do pedido preserva o Pastel do Cheff a R$ 21,99 e fecha `37,11 − 15,12 = 21,99`. O fechamento oficial não mantém esse unitário no documento fiscal.

`distribuirItensVendaComValorFiscalEfetivo` recebe o desconto técnico de R$ 15,12 e aplica `aplicarValorFiscalLiquidoNosItens`. O preço comercial permanece no campo `preco_unitario`, mas `valor_fiscal` do pastel cai para R$ 13,03 e o do refrigerante para R$ 8,96. A soma líquida continua R$ 21,99. O XML de homologação, em `MODELO_LIQUIDO`, zera `vDesc` e emite `vNF` 21,99, então o desconto não é subtraído de novo no total da NFC-e. O `vUnCom` do pastel sai `13.0300000000`, não `21.99`.

O DANFE imprime esses valores já líquidos e, separado, o desconto de R$ 15,12. A soma das linhas impressas já é R$ 21,99. Quem abate o desconto outra vez obtém R$ 6,87, que é a leitura inconsistente do caso original, embora o unitário persistido desta etapa não seja R$ 6,87.

Pagamento só em PIX ou só em dinheiro não muda o valor recebido nem dispara a tolerância de 20%. Pagamento misto, no emissor, pode substituir a composição aprovada: a função `itensFiscaisInteirosParaReferencia` remove o refrigerante, mantém o pastel a R$ 21,99 de catálogo da linha e troca o desconto técnico por outro (R$ 9,59 mais R$ 2,40 de dinheiro). Essa função não está atrás da flag `RECOMPOSICAO_HABILITADA_EM_PRODUCAO`, que continua `false`.

## 2. Fluxo e chamadas

| Etapa | Arquivo | Função | O que faz com o valor |
|---|---|---|---|
| Pedido | `ComposicaoFiscalPedidoService.js` | `carregarPedido` | Confere soma dos itens = total. Não foi alterada. |
| Composição | `PedidoPdvComposicaoService.js` | `prepararComposicaoPedidoPdv` | Linha do pastel = subtotal do pedido. Residual = total − cotação. Desconto = bruto − total. |
| Handoff | `frontend/pdv/js/pdv.js` | `aplicarHandoffPedidoPdv` | Copia preço, subtotal e desconto da composição para o carrinho. Não recalcula o unitário. |
| Pagamento | `VendaPagamentoService.js` | fechamento em torno da linha 1472 | Chama o distribuidor com `desconto` do body. Grava `vendas.total`, `vendas.desconto`, `valor_fiscal` e `valor_nao_fiscal`. |
| Valor líquido | `valorFiscalLiquido.js` | `calcularValorFiscalLiquido`, `aplicarValorFiscalLiquidoNosItens` | Única mutação proporcional dos itens no fechamento normal. |
| Distribuição | `distribuidorEstoqueVenda.js` | `distribuirItensVendaComValorFiscalEfetivo` | Bucket exclusivo. Aplica o líquido antes do valor fiscal efetivo. |
| Recomposição no pagamento | `PagamentoRecomposicaoDocumentoService.js` | `integrarPagamentoRecomposicao` | Só substitui itens se `CDS_RECOMPOSICAO_REFERENCIA_TESTE=1`. Flag de produção está desligada. |
| Tolerância 20% | `RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js` | `calcularMargemToleranciaDinheiro` | Margem matemática. O próprio módulo declara que não é desconto. |
| Reescrita na emissão | `emissor.js` | `selecionarItensFiscaisParaNfce` e, se bloqueado, `itensFiscaisInteirosParaReferencia` | Pode trocar linhas, desconto e `valor_fiscal` da venda em memória antes do XML. |
| XML | `modeloTotais.js`, `xmlBuilder.js` | `determinarModeloDeTotais`, `buildNfceXml` | `vUnCom = valor_fiscal / quantidade_fiscal`. |
| DANFE | `danfe.js` | `gerarDanfeHtml` | Unitário = `(valor_fiscal + valor_nao_fiscal) / quantidade`. Desconto = `venda.desconto`. |

`emitirPorVendaId` não foi executado. O arquivo `emissor.js` importa o banco da aplicação no carregamento. A condição de bloqueio foi lida no fonte e reproduzida com `calcularReferenciasConfirmadas`. A reescrita foi executada chamando `itensFiscaisInteirosParaReferencia` direto, sem transmitir.

O espelho em banco temporário usa as mesmas colunas do `INSERT` de `inserirItensDaVenda` e do `INSERT` de `vendas`. `VendaPagamentoService` não foi chamado, porque ele baixa estoque.

## 3. Fórmulas encontradas

Preparação, já corrigida e não alterada nesta sprint:

```text
linha_pastel = subtotal persistido em pedidos_itens
residual     = total_pedido − cotação de cadastro
desconto     = linha_pastel + refrigerantes − total_pedido
líquido      = total_pedido
```

Fechamento, em `ratearAjusteComercialFxNF`:

```text
subtotal_bruto = valor_fiscal_bruto + valor_nao_fiscal_bruto
total_liquido  = subtotal_bruto − desconto + acrescimo
fator          = total_liquido / subtotal_bruto
```

`aplicarValorFiscalLiquidoNosItens` multiplica `valor_fiscal` e `valor_nao_fiscal` de cada item por esse fator e ajusta o centavo no último item com valor. Quantidade não muda. `preco_unitario` não é reescrito. O desconto usado é o mesmo desconto técnico da preparação. Não é um segundo desconto comercial novo, mas é uma segunda aplicação: as linhas brutas são reduzidas e o campo `vendas.desconto` continua gravado.

No cenário de referência:

```text
bruto  = 21,99 + 15,12 = 37,11
fator  = 21,99 / 37,11 = 0,5925626515763944
pastel = round2(21,99 × fator) = 13,03
copo   = round2(15,12 × fator) = 8,96
soma   = 13,03 + 8,96 = 21,99
```

XML, em `determinarModeloDeTotais`: se a soma de `valor_fiscal` já é o `valor_fiscal` da venda, o modelo é `MODELO_LIQUIDO`, `vDesc = 0` e `vNF = vProd`. O desconto informado não entra de novo no `vNF`.

Tolerância de 20%, só dentro de `itensFiscaisInteirosParaReferencia`, e só quando há referência fiscal e referência em dinheiro, ambas positivas:

```text
excesso           = soma das linhas inteiras − referência fiscal
margem            = 20% do dinheiro, arredondada para baixo em moedas de R$ 0,05
dinheiro_aplicado = min(excesso, margem)
desconto          = excesso − dinheiro_aplicado
```

Aqui a margem vira desconto e dinheiro aplicado. Isso contradiz o comentário do serviço de simulação, que diz que a margem não é desconto. O serviço de simulação não foi alterado. Quem converte a margem é o fechamento do documento.

Distribuição: venda fiscal consome só `saldo_fiscal`; venda não fiscal consome só `saldo_nao_fiscal`. Saldo insuficiente no bucket bloqueia. Não há mistura dos dois saldos no mesmo item.

## 4. Valores antes e depois

### Cenário principal, PIX de R$ 21,99, venda fiscal

| Ponto | Pastel | Refrigerante 300 ml | Desconto | Total |
|---|---:|---:|---:|---:|
| Pedido | R$ 21,99 | — | R$ 0,00 | R$ 21,99 |
| Composição | R$ 21,99 | R$ 15,12 | R$ 15,12 | R$ 21,99 |
| Depois do fator | `preco_unitario` 21,99; `valor_fiscal` 13,03 | `preco_unitario` 15,12; `valor_fiscal` 8,96 | R$ 15,12 ainda no cabeçalho | R$ 21,99 |
| Espelho em `vendas_itens` | preço 21,99; fiscal 13,03 | preço 15,12; fiscal 8,96 | cabeçalho 15,12 | 21,99 |
| XML homologação | `vUnCom` 13.0300000000 | `vProd` 8.96 | `vDesc` 0 | `vNF` 21.99 |
| DANFE | unitário 13,03 | unitário 8,96 | linha Desconto 15,12 | Total 21,99 |

`vProd` do XML é 21,99, não 37,11. O modelo escolhido foi `MODELO_LIQUIDO`. O XML não contém `6.87`. Os saldos de `estoque_empresa` permaneceram 200 ml fiscal 40 / não fiscal 10 e 300 ml fiscal 30 / não fiscal 5. Nenhuma baixa foi executada.

Leitura do DANFE se o desconto impresso for abatido da soma das linhas: `21,99 − 15,12 = 6,87`. Esse R$ 6,87 não está gravado no item. Está na combinação de linhas já líquidas com o desconto ainda impresso.

## 5. Seis cenários

| Cenário | Resultado medido |
|---|---|
| 1. Composição principal | Líquido da venda R$ 21,99. Unitário fiscal do pastel R$ 13,03. XML não reaplica `vDesc`. DANFE mostra o desconto de R$ 15,12 por cima das linhas líquidas. |
| 2. Sem desconto | Pastel comercial = cotação R$ 13,67 e copo de R$ 8,32 fecha o residual. Desconto permanece 0. `valor_fiscal` do pastel permanece 13,67. `vUnCom` 13.6700000000. `vNF` 21,99. O fechamento não inventa desconto. |
| 3. Fiscal e não fiscal | Venda fiscal: quantidade e valor só no fiscal (13,03 e 8,96). Venda não fiscal: os mesmos líquidos só no não fiscal. Saldo fiscal zero com saldo não fiscal disponível bloqueia a venda fiscal, sem pegar o outro bucket. Saldos da tabela não mudaram. |
| 4. PIX, dinheiro e misto | Os três fechamentos devolvem total R$ 21,99. Os valores recebidos do mock não são reescritos. Com a flag de teste desligada, `recomposicao_executada` fica false. No misto (PIX R$ 10,00 + dinheiro R$ 11,99), a referência é fiscal 10,00 e não fiscal 11,99. A reescrita do emissor elimina o refrigerante, deixa o pastel a R$ 21,99, aplica R$ 2,40 de dinheiro e R$ 9,59 de desconto, e o líquido fiscal passa a R$ 12,40. |
| 5. Duas unidades | Quantidade 2, `preco_unitario` 21,99, subtotal 43,98. Desconto técnico R$ 23,12 (copo de R$ 8,00 + copo de R$ 15,12, menor composição inteira acima do residual de cadastro R$ 16,64). `valor_fiscal` do pastel R$ 28,83. Total e `vNF` 43,98. `vDesc` 0. |
| 6. Regressão do preço | `preco_unitario` continua 21,99. O unitário que segue para o XML é 13,03. O preço comercial não volta a 6,87, mas também não é o valor impresso. |

## 6. Payload, banco, XML e DANFE

| Campo | Payload da composição | Banco temporário | XML | DANFE |
|---|---:|---:|---:|---:|
| Preço do pastel | 21,99 | `preco_unitario` 21,99 | `vUnCom` 13,03 | 13,03 |
| Valor fiscal do pastel | não existe ainda; subtotal 21,99 | 13,03 | `vProd` da linha 13,03 | 13,03 |
| Refrigerante | 15,12 | preço 15,12; fiscal 8,96 | 8,96 | 8,96 |
| Desconto | 15,12 | 15,12 | 0 | 15,12 |
| Total | 21,99 | 21,99 | 21,99 | 21,99 |
| Vínculo | `pedidoId` 65 | `vendas.pedido_id` 65 | não vai no total | não vai no total |

O payload validado na preparação e o documento fiscal não são o mesmo conjunto de unitários. O total líquido é o mesmo. A persistência espelhada corresponde ao retorno do distribuidor, não ao payload bruto da composição.

## 7. Testes

Comando:

```text
node --test --test-concurrency=1 tests/vendas/auditoria-fechamento-fiscal-composicao-pedido.test.js
```

Resultado: 6 testes, 6 aprovados, execução sequencial, banco em memória. Nenhum teste desta suíte abre o banco oficial nem chama adquirente ou SEFAZ.

## 8. Riscos

1. O unitário fiscal do produto principal deixa de ser o preço comercial do pedido assim que o desconto técnico entra em `aplicarValorFiscalLiquidoNosItens`. Arquivo: `backend/services/vendas/valorFiscalLiquido.js`, chamado por `distribuirItensVendaComValorFiscalEfetivo`.
2. O DANFE mostra esse unitário líquido e ainda imprime `venda.desconto`. A soma das linhas já é o total. O desconto impresso não deve ser abatido de novo. Arquivo: `backend/services/fiscal/danfe.js`.
3. No pagamento misto, `emissor.js` pode chamar `itensFiscaisInteirosParaReferencia` mesmo com `RECOMPOSICAO_HABILITADA_EM_PRODUCAO = false`. A função troca a composição aprovada, remove o refrigerante e recalcula desconto com a tolerância de 20% do dinheiro.
4. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece false. No pagamento, `integrarPagamentoRecomposicao` não substitui os itens enquanto `CDS_RECOMPOSICAO_REFERENCIA_TESTE` não estiver em `1`.

Correção recomendada, não implementada:

- No fechamento de uma composição de pedido, persistir `valor_fiscal` no valor bruto comercial e deixar um único `vDesc` no `MODELO_BRUTO`, ou persistir o líquido e não gravar o mesmo desconto para impressão no DANFE.
- Não reescrever, no emissor, uma composição de pedido já fechada na preparação. A tolerância de 20% deve continuar só como critério de seleção, como o serviço de simulação declara, e não como desconto de uma composição já aprovada.

## 9. Arquivos analisados

- `backend/services/vendas/PedidoPdvComposicaoService.js` (lido, não alterado)
- `backend/services/vendas/ComposicaoFiscalPedidoService.js` (lido, não alterado)
- `backend/services/vendas/valorFiscalLiquido.js`
- `backend/services/distribuidorEstoqueVenda.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/services/vendas/PagamentoRecomposicaoDocumentoService.js`
- `backend/services/vendas/PagamentoSequencialComposicaoService.js`
- `backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js`
- `backend/services/vendas/RecomposicaoFiscalContratoService.js`
- `backend/services/fiscal/emissor.js`
- `backend/services/fiscal/modeloTotais.js`
- `backend/services/fiscal/xmlBuilder.js`
- `backend/services/fiscal/danfe.js`
- `frontend/pdv/js/pdv.js` (`aplicarHandoffPedidoPdv`)

## 10. Critérios de aceitação

| Critério | Situação |
|---|---|
| Preço comercial do pastel não é substituído no documento | Não comprovado. O campo `preco_unitario` fica 21,99; `vUnCom` e DANFE ficam 13,03. |
| Desconto técnico não é aplicado duas vezes no `vNF` | Comprovado no XML de PIX: `vDesc` 0 e `vNF` 21,99. |
| Desconto não aparece de novo na apresentação | Não comprovado. O DANFE imprime R$ 15,12 sobre linhas que já somam R$ 21,99. |
| Total líquido coerente com o pedido | Comprovado: R$ 21,99 no motor, no espelho e no `vNF`. |
| Valor recebido preservado | Comprovado nos mocks de PIX, dinheiro e misto: os valores de entrada não mudam. |
| Classificação fiscal / não fiscal | Comprovada no distribuidor: buckets exclusivos, saldos da tabela intactos. A baixa real não foi executada. |
| Persistência igual ao payload da composição | Não. A persistência acompanha o retorno do distribuidor, com `valor_fiscal` já reduzido. |
| XML igual aos fiscais persistidos | Comprovado para o espelho do distribuidor: `vUnCom` 13,03 e `vNF` 21,99. |
| DANFE coerente com a venda fechada | O total é o da venda. O unitário é o `valor_fiscal`, não o preço comercial. O desconto do cabeçalho continua visível. |
| Emissor completo e pagamento real | Não executados. Pendentes de autorização. |

## 11. Confirmações

- Nenhum código de produção foi alterado.
- Nenhum banco oficial foi acessado. O SQLite usado foi `:memory:`.
- Nenhuma venda real, pagamento real, TEF, PIX de adquirente, transmissão, cancelamento ou evento fiscal foi executado.
- O XML gerado é homologação local (`ambiente = 2`), sem certificado e sem envio.

## 12. Decisão

**BLOQUEADO.**

O total da operação sobrevive ao fechamento. O preço comercial do pastel não sobrevive no XML nem no DANFE quando existe desconto técnico. O pagamento misto ainda pode descartar o refrigerante já escolhido na preparação. Qualquer correção, homologação fiscal ou operação em ambiente oficial depende de nova autorização do Product Owner.
