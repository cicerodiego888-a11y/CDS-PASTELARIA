# Correção da composição fiscal originada do pedido

Auditoria e correção da distribuição de valores entre o produto principal e os componentes, no caminho Pedido → composição fiscal do PDV → payload → XML NFC-e de homologação.

Esta correção não é homologação fiscal de produção. Nenhum documento foi transmitido à SEFAZ, nenhum banco oficial foi aberto e nenhuma venda real foi registrada. Operação fiscal real continua dependente de autorização do Product Owner.

## Causa raiz

A redução do Pastel do Cheff acontecia em `prepararComposicaoPedidoPdv`, em `backend/services/vendas/PedidoPdvComposicaoService.js`.

A função cotava o pastel em `CotacaoPrecoProdutoService` (`produtos.preco_venda`, promoção ou atacado) e gravava essa cotação como preço e subtotal da linha fiscal. O preço persistido em `pedidos_itens.preco_unitario` / `pedidos_itens.subtotal` era descartado.

O residual da busca de refrigerante era `total do pedido − cotação do pastel`. `buscarComposicao` não foi a origem da redução: ele só escolhe quantidades inteiras de refrigerante. O desconto técnico antigo só era preenchido no ramo de menor composição acima do residual:

```text
desconto = total dos refrigerantes − residual
líquido  = cotação do pastel + refrigerantes − desconto
         = total do pedido
```

No ramo exato, o desconto permanecia zero e a linha do pastel continuava no preço de cadastro, não no preço do pedido.

O Motor de Composição (`ComposicaoFiscalPedidoService.buscarComposicao`) não foi alterado. O DANFE (`danfe.js`) também não recalcula o pastel: imprime `(valor_fiscal + valor_nao_fiscal) / quantidade` e, à parte, `venda.desconto`. O XML (`xmlBuilder.js`) usa o mesmo `valor_fiscal` em `vProd` / `vUnCom` e rateia `venda.desconto` em `vDesc` somente no `MODELO_BRUTO`.

## Aritmética do caso reportado

Pedido: 1 Pastel do Cheff, R$ 21,99. DANFE reportado: pastel R$ 6,87, refrigerante 300 ml R$ 15,12, desconto R$ 6,80, total R$ 21,99.

| Origem | Valor | O que o código faz com ele |
|---|---:|---|
| Pedido original | R$ 21,99 | Total persistido. Continua sendo o líquido. |
| Preço comercial do pastel | R$ 21,99 | Antes era substituído pela cotação. Agora é a linha fiscal. |
| Pastel na composição antiga | R$ 6,87 | Não é uma fórmula própria do DANFE. Fecha com `21,99 − 15,12` e também com `13,67 − 6,80`. |
| Refrigerante 300 ml | R$ 15,12 | Preço de cadastro do componente escolhido. |
| Desconto informado | R$ 6,80 | Fecha com `15,12 − (21,99 − 13,67) = 15,12 − 8,32`. |
| Soma das linhas impressas | R$ 21,99 | `6,87 + 15,12`. O desconto de R$ 6,80 não entra de novo nessa soma. |
| Se o desconto fosse abatido outra vez | R$ 15,19 | `21,99 − 6,80`. Não é o total apresentado. |

O banco oficial não foi consultado, então o preço de cadastro vigente do Pastel do Cheff não foi lido. As duas identidades abaixo são as que o código antigo produz, e as duas explicam os números impressos:

1. Cotação do pastel = R$ 6,87 e copo de R$ 15,12 fecha o residual em exato. A linha fiscal sai a R$ 6,87, o desconto técnico deste ramo fica R$ 0,00 e o líquido é R$ 21,99. O desconto de R$ 6,80 não nasce nessa conta.
2. Cotação do pastel = R$ 13,67. Residual = R$ 8,32. O copo de R$ 15,12 é a menor composição inteira acima do residual. Desconto técnico = R$ 6,80. A linha gravada pelo código antigo seria R$ 13,67, não R$ 6,87. O valor R$ 6,87 aparece se esse desconto de R$ 6,80 é absorvido no unitário do pastel e ainda impresso no campo de desconto. `6,87 + 15,12` já é o total, então o desconto fica matematicamente duplicado na leitura do DANFE.

O rateio proporcional de `aplicarValorFiscalLiquidoNosItens` não produz esse par. Ele multiplicaria pastel e refrigerante pelo mesmo fator. Um refrigerante que permanece em R$ 15,12 com o pastel caindo para R$ 6,87 é a substituição do preço comercial pela cotação, não um rateio uniforme.

## Fluxo anterior

1. `carregarPedido` confere `soma dos subtotais − desconto do pedido = total` e frete zero.
2. Pastéis da categoria `PASTEIS` são cotados. A linha fiscal recebe `cotacao.precoUnitarioInterno` e `cotacao.subtotalCentavos`.
3. Residual = total do pedido − essa cotação.
4. Refrigerantes elegíveis: categoria `REFRIGERANTES`, volume MUC 200, 300 ou 500 ml, preço válido e disponibilidade em `estoque_empresa` (saldo menos reservado, mais crédito de reserva do pedido).
5. `buscarComposicao` tenta o total exato do residual. Se não houver, busca a menor composição inteira acima do residual, com limite `residual + maior preço unitário`.
6. Desconto = excesso dos refrigerantes sobre o residual, ou zero no exato.
7. O PDV carrega essas linhas e o desconto em `aplicarHandoffPedidoPdv`. O pagamento e o emissor seguem com esses valores.

## Fluxo corrigido

A busca do componente permanece a do passo 3 ao 5, ainda baseada na cotação de cadastro. O que muda é a linha do produto principal e a conta do desconto:

```text
linha do pastel = subtotal persistido em pedidos_itens
                  (preco_unitario, se ele reproduz o subtotal em centavos)

residual        = total do pedido − cotação de cadastro do pastel

desconto        = (linha comercial do pastel + refrigerantes) − total do pedido

líquido         = bruto − desconto
                = total do pedido
```

Desconto negativo é recusado com `TOTAL_COMPOSICAO_DIVERGENTE`. Quando o preço comercial é igual à cotação, o desconto novo é idêntico ao antigo (`refrigerantes − residual`).

A linha do pastel sai com desconto de item zero. O desconto técnico fica só no desconto global da composição, que o XML de homologação leva em `vDesc`.

## Fórmulas encontradas

Preço comercial da linha, em `precoComercialPersistido`:

```text
subtotal_centavos = soma de round(pedidos_itens.subtotal × 100)
preço unitário    = preco_unitario da linha,
                    se round(preço × quantidade × 100) = subtotal_centavos
                    senão subtotal_centavos / quantidade / 100
```

Cotação, inalterada, em `CotacaoPrecoProdutoService`: preço interno a partir de `preco_venda`, com promoção ou atacado quando a regra da cotação se aplica. Ela alimenta o residual e o preço do refrigerante. Não alimenta mais o preço do pastel.

Busca, inalterada, em `buscarComposicao`:

```text
primeiro: combinação inteira cujo total = residual
senão:    menor total inteiro ≥ residual + 1,
          limitado a residual + maior preço unitário dos modelos
```

Desconto técnico antigo, só no ramo acima do residual:

```text
desconto = total_refrigerantes − residual
```

Desconto técnico atual:

```text
desconto = total_comercial_do_pastel + total_refrigerantes − total_do_pedido
```

Tolerância de 20%: não existe em `PedidoPdvComposicaoService`. A regra histórica está em `RecomposicaoFiscalToleranciaDinheiroSimulacaoService` (`PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO = 0.2`, marcada como `nao_e_desconto`) e no excedente de `itensFiscaisInteirosParaReferencia`. Esses módulos não foram alterados. A composição originada do pedido não aplica essa margem.

Quantidades: o pastel do pedido precisa ser inteiro (`QUANTIDADE_PASTEL_INVALIDA` caso contrário). A busca trabalha com quantidades inteiras de refrigerante.

Financeiro: `efeitosOperacionais` permanece `false`. A preparação não grava pagamento, não baixa estoque e não altera `saldo_fiscal` nem `saldo_nao_fiscal`.

Classificação fiscal / não fiscal: a composição não reclassifica saldos. A separação continua no distribuidor de estoque da venda, fora desta correção.

## 200 ml e 300 ml

Não foi criada prioridade entre volumes. Os dois são elegíveis quando o cadastro tem categoria Refrigerantes, volume 200 ou 300 ml, preço e saldo.

Cenário isolado do caso, com cotação do pastel em R$ 13,67 (a identidade que produz o desconto de R$ 6,80):

| Cenário | Residual de cadastro | Copo escolhido | Pastel na composição | Desconto | Líquido |
|---|---:|---|---:|---:|---:|
| 200 ml a R$ 8,00 e 300 ml a R$ 15,12 | R$ 8,32 | 300 ml. O 200 ml não alcança R$ 8,32; dois copos de 200 ml (R$ 16,00) perdem para um de R$ 15,12 | R$ 21,99 | R$ 15,12 | R$ 21,99 |
| 200 ml a R$ 8,32 | R$ 8,32 | 200 ml, porque fecha o residual em exato. O 300 ml fica de fora | R$ 21,99 | R$ 8,32 | R$ 21,99 |
| Só 200 ml a R$ 5,00 | R$ 8,32 | 2 × R$ 5,00, menor inteiro acima de R$ 8,32 | R$ 21,99 | R$ 10,00 | R$ 21,99 |
| Só 300 ml a R$ 25,00, acima do principal | R$ 8,32 | 1 × R$ 25,00, no preço de cadastro | R$ 21,99 | R$ 25,00 | R$ 21,99 |
| Comercial = cadastro R$ 13,67 e copo R$ 8,32 exato | R$ 8,32 | 200 ml | R$ 13,67 | R$ 0,00 | R$ 21,99 |
| 2 × R$ 21,99 | R$ 16,64 | mesma regra de residual | R$ 43,98 | o excesso da busca | R$ 43,98 |

A disponibilidade entra como quantidade máxima do modelo. O teste já existente “respeita disponibilidade empresarial” continuou escolhendo o 300 ml quando o 200 ml está com saldo zero, com desconto de R$ 6,81 sobre o residual de cadastro. Estoque oficial não foi modificado.

## Evidência do preço e do financeiro

No banco SQLite em memória do caso acima:

- linha do pastel: quantidade 1, preço R$ 21,99, subtotal R$ 21,99;
- refrigerante 300 ml: quantidade 1, preço R$ 15,12;
- bruto R$ 37,11, desconto R$ 15,12, líquido R$ 21,99;
- `efeitosOperacionais = false`;
- `estoque_empresa` do 200 ml permaneceu fiscal 40 / não fiscal 10;
- `estoque_empresa` do 300 ml permaneceu fiscal 30 / não fiscal 5;
- o XML não contém `6.87`.

Quando o preço comercial já é o de cadastro, o desconto técnico antigo se mantém. No fixture de duas unidades a R$ 21,99 com cadastro R$ 8,99 e total R$ 61,98, a linha permanece R$ 43,98, o residual de cadastro permanece R$ 44,00 e o líquido permanece R$ 61,98.

## Pedido, composição, payload e XML

XML gerado por `buildNfceXml` com `ambiente = 2`, sem certificado e sem transmissão.

| Etapa | Pastel | Refrigerante | Desconto | Total |
|---|---:|---:|---:|---:|
| Pedido persistido | R$ 21,99 | — | R$ 0,00 | R$ 21,99 |
| Composição calculada | R$ 21,99 | R$ 15,12 | R$ 15,12 | R$ 21,99 |
| Payload (`itens`, `desconto`, `valorFinalCentavos`) | R$ 21,99 | R$ 15,12 | R$ 15,12 | R$ 21,99 |
| XML homologação | `vUnCom` 21.9900000000 | `vProd` 15.12 | `vDesc` 15.12 | `vNF` 21.99 |

Totais do XML: `vProd` 37.11, modelo `MODELO_BRUTO`. Identidade: `37,11 − 15,12 = 21,99`.

O DANFE, se receber esses mesmos `valor_fiscal` brutos e o `venda.desconto`, imprime o unitário comercial e o desconto em separado. Ele não foi alterado.

## Arquivos e funções

Alterados:

- `backend/services/vendas/PedidoPdvComposicaoService.js`
  - `precoComercialPersistido`
  - `prepararComposicaoPedidoPdv`
- `tests/vendas/pedido-pdv-composicao.test.js`
- `tests/vendas/composicao-fiscal-pedido-preco-principal.test.js`
- `tests/vendas/cds-venda-valor-pasteis-01.test.js`

Não alterados, e auditados neste fluxo:

- `ComposicaoFiscalPedidoService.buscarComposicao` e `carregarPedido`
- `CotacaoPrecoProdutoService`
- `VendaPorValorPasteisService` (continua gravando a massa informada na linha; a composição agora preserva essa massa)
- `RecomposicaoFiscalToleranciaDinheiroSimulacaoService`
- `PagamentoRecomposicaoDocumentoService.itensFiscaisInteirosParaReferencia`
- `valorFiscalLiquido.aplicarValorFiscalLiquidoNosItens`
- `distribuidorEstoqueVenda.js`
- `xmlBuilder.js`, `danfe.js`, `emissor.js`
- ficha técnica, estoque oficial e regras de pagamento

## Testes

Banco temporário em memória ou em diretório temporário. Sequência executada sem SEFAZ:

| Teste | Resultado |
|---|---|
| Pastel do Cheff com 300 ml quando o 200 ml não cobre o residual | passou |
| 200 ml quando fecha o residual em exato | passou |
| 200 ml e 300 ml disponíveis ao mesmo tempo | passou, nos dois sentidos acima |
| Componente mais barato que o residual | passou, 2 × R$ 5,00 |
| Componente mais caro que o principal | passou, R$ 25,00 no preço de cadastro |
| Composição com desconto técnico | passou |
| Composição sem desconto | passou |
| Várias unidades | passou, 2 × R$ 21,99 |
| Saldos fiscal e não fiscal | passaram inalterados |
| Financeiro / líquido do pedido | passou, `efeitosOperacionais = false` |
| Preço comercial original | passou |
| Composição × XML homologação | passou, `vNF` 21.99 e `vUnCom` 21.99 |
| Suíte `pedido-pdv-composicao.test.js` | 19/19 |
| Suíte `cds-venda-valor-pasteis-01.test.js` | 10/10 |

Os dois testes de venda por valor que exigiam linhas idênticas entre “valor informado” e “pedido tradicional” foram alinhados ao contrato novo. O residual e os refrigerantes continuam iguais. O subtotal do pastel segue o preço persistido em cada pedido, e o desconto absorve a diferença para o mesmo líquido.

## Regressões verificadas

- Pedido só com refrigerante continua em passthrough, sem pastel artificial.
- Pedido só com pastel e residual zero continua sem desconto.
- Volume fora de 200, 300 e 500 ml continua inelegível.
- Residual de cadastro negativo continua bloqueado antes da busca.
- Produto inativo ou insumo continua fora.
- Disponibilidade zerada continua trocando o componente.
- Cotação com fração de centavo continua arredondando o subtotal sem quebrar a identidade.
- Mudar o preço de cadastro muda o residual e não muda o preço comercial da linha.

## Pendências de homologação

- Não houve transmissão, cancelamento ou evento na SEFAZ.
- Não houve leitura nem escrita no banco oficial. O preço de cadastro real do Pastel do Cheff que gerou o DANFE de R$ 6,87 permanece por confirmar com o Product Owner.
- O fechamento da venda ainda pode aplicar o valor fiscal líquido e a recomposição de unidades inteiras com tolerância de 20%. Esses motores não fazem parte desta correção. A conferência do DANFE de uma venda fechada, em homologação autorizada, ainda é necessária para ver o unitário depois do pagamento.
- O XML comprovado aqui é o de `buildNfceXml` em ambiente 2, montado com o payload da composição, sem certificado.
