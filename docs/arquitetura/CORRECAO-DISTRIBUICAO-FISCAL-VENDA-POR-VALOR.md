# Correção da distribuição fiscal na Venda por Valor

**ID:** CDS-COMPOSICAO-VALOR-DISTRIBUICAO-01  
**Base:** `docs/arquitetura/AUDITORIA-GERAL-MOTOR-COMPOSICAO.md`  
**Classificação:** CORRIGIDO NO CAMINHO DA VENDA POR VALOR

O pedido continua com o valor comercial informado. A composição fiscal do mesmo pedido passa a ser cadastro do pastel mais componentes, com desconto técnico só no excedente da busca. A composição normal não mudou.

## Resultado do pedido #68

Cadastro artificial do teste: pastel #747 a R$ 8,99, copo 200 ml #748 a R$ 12,99, copo 300 ml #749 a R$ 19,80. Quantidade 2. Valor informado R$ 61,98.

| | Antes | Depois |
|---|---:|---:|
| Pedido, total | R$ 61,98 | R$ 61,98 |
| Pedido, desconto | R$ 0,00 | R$ 0,00 |
| Linha comercial do pastel | R$ 61,98 | R$ 61,98 |
| Pastel fiscal | R$ 61,98 | R$ 17,98 |
| Componentes | R$ 45,78 | R$ 45,78 |
| Desconto técnico | R$ 45,78 | R$ 1,78 |
| Total fiscal | R$ 61,98 | R$ 61,98 |

A conta fiscal fica `17,98 + 45,78 − 1,78 = 61,98`. O excedente de R$ 1,78 é o quanto a menor combinação acima do residual de R$ 44,00 passou do alvo. A busca dos copos não foi alterada.

## O que mudou

`persistirMassaMonetariaPedidoAlvo` continua gravando o valor informado na linha do pastel para a soma dos itens fechar o total do pedido. Esse número é o valor comercial.

`prepararComposicaoPedidoPdv` segue escolhendo os componentes pelo residual de cadastro. No retorno, se `pedidos.observacao` é `VENDA_POR_VALOR_PASTEIS`, `distribuirValorFiscalVendaPorValor` substitui o subtotal fiscal do pastel pelo cadastro (`total − residual`) e reduz o desconto ao excedente (`componentes − residual`). Pedido sem essa origem não entra nessa função. A composição normal do cenário auditado continua com desconto de R$ 27,78.

Conferência e PDV leem o mesmo payload. Os dois campos, `desconto` e `itens`, saem dessa distribuição. A reabertura chama o mesmo motor e devolve o mesmo desconto, sem gravar os copos de novo em `pedidos_itens`.

`buscarComposicao`, a tolerância de 20%, a classificação fiscal/não fiscal, o estoque, o contrato de fechamento, o pagamento e o emissor não foram alterados. `FechamentoComposicaoPedidoContrato` não precisou de mudança: o payload já fecha `bruto fiscal − desconto = total` (R$ 63,76 − R$ 1,78 = R$ 61,98), que é a identidade que o fechamento já preserva.

## Arquivos

- `backend/services/vendas/VendaPorValorPasteisService.js` — função `distribuirValorFiscalVendaPorValor`.
- `backend/services/vendas/PedidoPdvComposicaoService.js` — aplica a função só quando a origem do pedido é Venda por Valor.
- `tests/vendas/cds-venda-valor-pasteis-01.test.js` — casos da sprint e ajuste das asserções que ainda esperavam o desconto igual aos copos.
- `docs/arquitetura/CORRECAO-DISTRIBUICAO-FISCAL-VENDA-POR-VALOR.md` — este relatório.

## Testes

`node --test --test-concurrency=1` em:

- `tests/vendas/cds-venda-valor-pasteis-01.test.js`
- `tests/vendas/pedido-pdv-composicao.test.js`
- `tests/vendas/composicao-fiscal-pedido-preco-principal.test.js`

40 testes, 40 aprovações, 0 falhas. Banco em memória, com `DB_DIR` temporário. Banco oficial, TEF, PIX e SEFAZ não foram usados.

Cobertos: desconto de R$ 1,78 no pedido #68; combinação exata com desconto R$ 0,00; excedente isolado; composição normal em R$ 27,78; valor comercial intacto no pedido; valor fiscal no payload; reabertura sem segunda linha; conferência e PDV no mesmo `desconto`; quantidades 1, 2 e 3; valores com centavos (R$ 21,98, R$ 40,05, R$ 50,00 e R$ 61,98).

## Limitações

O fingerprint continua calculado antes da troca do subtotal fiscal. Duas preparações do mesmo pedido produzem o mesmo fingerprint. Ele identifica o pedido comercial e a seleção de componentes. Não é um hash do preço fiscal já distribuído.

Operação que já tenha `venda_id` devolve o snapshot gravado. Pedidos vendidos com o desconto antigo de R$ 45,78 não são reescritos.

O XML e o DANFE não foram gerados nesta sprint. O payload que o fechamento já sabe preservar é o fiscal: pastel R$ 17,98, componentes R$ 45,78, desconto R$ 1,78, total R$ 61,98.

## Preservação da regra do dinheiro

A distribuição fiscal da Venda por Valor não alterou a regra do dinheiro. O hash destes arquivos é o mesmo de antes da correção:

- `RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js`
- `PagamentoSequencialComposicaoService.js`
- `RecomposicaoFiscalContratoService.js`
- `OrquestradorPagamento.js`
- `tefFluxoPagamento.js`

`PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO` permanece 0,2. `calcularMargemToleranciaDinheiro` permanece `Math.round(centavos do dinheiro × 0,2)`, com `nao_e_desconto` verdadeiro. A margem não entra no desconto técnico da Venda por Valor.

Os oito cenários, medidos de novo nas funções atuais, repetem o resultado anterior:

| Cenário | Fiscal | Não fiscal | Margem | Estado |
|---|---:|---:|---:|---|
| Dinheiro confirmado R$ 21,99 | 0,00 | 21,99 | 4,40 | quitada |
| PIX aprovado R$ 21,99 | 21,99 | 0,00 | 0,00 | quitada |
| PIX R$ 10,00 aprovado + dinheiro R$ 11,99 confirmado | 10,00 | 11,99 | 2,40 | quitada |
| Mesma mistura com o dinheiro lançado antes do PIX | 10,00 | 11,99 | 2,40 | quitada |
| Dinheiro confirmado e PIX ainda pendente | 0,00 | 11,99 | 2,40 | pendente |
| PIX aprovado e dinheiro ainda não confirmado | 10,00 | 0,00 | 2,40 | aguardando não fiscal |
| PIX pendente R$ 21,99 | 0,00 | 0,00 | 0,00 | pendente |
| PIX recusado ou com falha | 0,00 | 0,00 | 0,00 | pendente |

Débito e crédito aprovados entram só no fiscal. Pendente, recusado e falha ficam fora: débito aprovado R$ 8,00 mais PIX aprovado R$ 3,00, com crédito em falha de R$ 4,00, fecha fiscal R$ 11,00 e não fiscal R$ 0,00. PIX pendente de R$ 5,00 e PIX recusado de R$ 3,00 ao lado de PIX aprovado R$ 10,00 e dinheiro confirmado R$ 11,99 não aumentam o recebido: fiscal R$ 10,00 e não fiscal R$ 11,99.

Arredondamento da margem, no centavo mais próximo: R$ 10,05 → R$ 2,01; R$ 11,99 → R$ 2,40; R$ 19,99 → R$ 4,00; R$ 25,99 → R$ 5,20. O contrato já existente `cds-pagamento-misto-recomposicao-fiscal-05` passou 8/8, inclusive R$ 10,05 → R$ 2,01 e R$ 0,10 + R$ 0,20 → R$ 0,06.

Quando o dinheiro é lançado primeiro e o PIX ainda não foi aprovado, o status permanece pendente. O valor digital não entra no fiscal. Quando o PIX é aprovado primeiro e o dinheiro ainda não foi confirmado, o status fica aguardando o não fiscal. A ordem dos lançamentos não muda a soma das referências.
