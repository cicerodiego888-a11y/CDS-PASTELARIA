# Correção do fechamento fiscal, regra do dinheiro e preservação da composição

**ID:** CDS-FISCAL-FECHAMENTO-COMPOSICAO-02  
**Classificação:** CONCLUÍDO COM RESSALVAS

A correção foi testada em banco temporário. Não é homologação fiscal de produção. Nenhum banco oficial foi aberto. Não houve venda, pagamento, TEF, PIX real, transmissão, cancelamento ou evento na SEFAZ.

## 1. Causa raiz

**Problema A.** `distribuirItensVendaComValorFiscalEfetivo` aplicava o desconto técnico da composição em `aplicarValorFiscalLiquidoNosItens`. O fator `21,99 / 37,11` reduzia o pastel para R$ 13,03 e o refrigerante para R$ 8,96. O cabeçalho continuava com o desconto de R$ 15,12. O DANFE imprimia linhas que já somavam R$ 21,99 e o desconto outra vez. O XML caía em `MODELO_LIQUIDO`, zerava `vDesc` e gravava `vUnCom` 13,03.

**Problema B.** Com a seleção fiscal bloqueada, `emissor.js` chamava `itensFiscaisInteirosParaReferencia` mesmo com `RECOMPOSICAO_HABILITADA_EM_PRODUCAO = false`. No PIX de R$ 10,00 mais dinheiro de R$ 11,99, essa função removia o refrigerante, aplicava R$ 2,40 da margem e criava desconto de R$ 9,59.

## 2. Arquivos alterados

- `backend/services/distribuidorEstoqueVenda.js`
- `backend/services/vendas/FechamentoComposicaoPedidoContrato.js` (novo)
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/services/fiscal/emissor.js`
- `frontend/pdv/js/pdv.js` — o pré-cálculo passa a enviar `pedido_id` e `total` quando a venda vem do pedido
- `tests/vendas/fechamento-fiscal-composicao-pedido.test.js`

## 3. Arquivos preservados

Não foram alterados `PedidoPdvComposicaoService.js`, `ComposicaoFiscalPedidoService.js`, `valorFiscalLiquido.js`, `RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js`, `PagamentoRecomposicaoDocumentoService.js` (a função de reescrita permanece), `modeloTotais.js`, `xmlBuilder.js` e `danfe.js`.

A flag `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` continua `false`. O percentual de 20% não mudou.

## 4. Contrato final

A preservação só vale quando a venda tem `pedido_id` e a identidade comercial fecha:

```text
soma dos subtotais − desconto + acréscimo = total do pedido
```

Nesse contrato:

- os itens ficam no preço comercial e nas quantidades aprovadas;
- o desconto técnico fica só no cabeçalho da venda;
- o total financeiro é o valor recebido;
- venda sem pedido continua com o rateio proporcional antigo.

Classificação de pagamento, a mesma função já existente `calcularReferenciasConfirmadas`:

| Forma confirmada | Referência |
|---|---|
| PIX, débito ou crédito aprovados | Fiscal |
| Dinheiro confirmado | Não fiscal |
| Pendente, rejeitado ou falha | Não entra |

A ordem das parcelas não altera a soma. A margem de 20% do dinheiro continua calculada por `calcularMargemToleranciaDinheiro` e marcada como `nao_e_desconto`. O emissor só pode reescrever produtos se a flag de produção estiver ligada.

## 5. Fórmulas

Composição de pedido, no distribuidor, com o contrato ativo:

```text
valor_fiscal do item = preço comercial × quantidade
cabeçalho líquido    = bruto − desconto técnico
```

No PIX integral, o modelo tributário já existente escolhe `MODELO_BRUTO`:

```text
vProd = 37,11
vDesc = 15,12
vNF   = 37,11 − 15,12 = 21,99
vUnCom do pastel = 21,99
```

Venda sem esse contrato mantém:

```text
fator = (bruto − desconto) / bruto
valor_fiscal do item = round2(bruto do item × fator)
```

Tolerância, inalterada:

```text
margem = round(centavos do dinheiro × 0,20) / 100
```

Para R$ 11,99 em dinheiro, a margem é R$ 2,40. Ela não é gravada como desconto.

## 6. Cenários

| Cenário | Resultado |
|---|---|
| 1. PIX R$ 21,99 | Pastel fiscal R$ 21,99. Refrigerante R$ 15,12. Cabeçalho R$ 21,99. XML `MODELO_BRUTO`, `vDesc` 15,12, `vNF` 21,99. DANFE mostra 21,99 e 15,12, sem 13,03 e sem 6,87. |
| 2. Só dinheiro | Referência fiscal R$ 0,00. Referência não fiscal R$ 21,99. NFC-e não é emitida. |
| 3. PIX R$ 10,00 + dinheiro R$ 11,99 | Referências 10,00 e 11,99. Refrigerante permanece. Desconto técnico permanece R$ 15,12. Não surge desconto de R$ 9,59. NFC-e mista não é montada. |
| 4 e 5. Ordem do dinheiro e do PIX | As duas ordens produzem a mesma referência. |
| 6. Pendente, rejeitado e falha | Débito 20 + crédito 20 + dinheiro 10 = fiscal 40 e não fiscal 10. As tentativas de R$ 30, R$ 15 e R$ 8 ficam de fora. Total financeiro considerado: R$ 50,00. |
| 7. Tolerância | Margem R$ 2,40, `nao_e_desconto = true`, reescrita do emissor desligada. |
| 8. Duas unidades | Quantidade 2, subtotal e valor fiscal R$ 43,98, total R$ 43,98. O refrigerante da composição permanece. |
| 9. Estoque | Venda fiscal só no saldo fiscal. Venda não fiscal só no saldo não fiscal. Saldo fiscal zero bloqueia. A tabela de estoque do teste não foi alterada. |
| 10. Venda sem pedido | O rateio antigo permanece: pastel R$ 13,03 e refrigerante R$ 8,96. |

## 7. XML e DANFE locais

Homologação `ambiente = 2`, sem certificado e sem transmissão, no cenário de PIX:

| Campo | Valor |
|---|---:|
| `vUnCom` do pastel | 21.9900000000 |
| `vProd` | 37.11 |
| `vDesc` | 15.12 |
| `vNF` | 21.99 |

O DANFE imprime as linhas comerciais e o desconto uma vez. O total impresso é R$ 21,99, que é `37,11 − 15,12`. As linhas não somam o total antes do desconto.

## 8. Testes

```text
node --test --test-concurrency=1 tests/vendas/fechamento-fiscal-composicao-pedido.test.js
```

8 testes, 8 aprovados.

Regressão, em sequência:

- `tests/vendas/auditoria-fechamento-fiscal-composicao-pedido.test.js`: 6/6. O caminho sem o contrato do pedido continua reduzindo os itens.
- `tests/vendas/pedido-pdv-composicao.test.js`: 19/19.

A suíte `rc7101-valor-fiscal-liquido` não foi executada porque o módulo de orquestração de pagamento carrega o banco da aplicação.

## 9. Regressões verificadas

- Preparação do pedido inalterada.
- Rateio proporcional das vendas sem `pedido_id` inalterado.
- Buckets fiscal e não fiscal continuam exclusivos.
- Flag de produção continua desligada.
- A função `itensFiscaisInteirosParaReferencia` não foi reescrita. O emissor deixou de chamá-la enquanto a flag estiver desligada.

## 10. Pendência tributária

**BLOQUEADO para NFC-e de pagamento misto.**

A composição e o financeiro do misto estão preservados: fiscal R$ 10,00, não fiscal R$ 11,99, total R$ 21,99, produtos e desconto técnico intactos. Não há regra comprovada para dividir o pastel de R$ 21,99, o refrigerante de R$ 15,12 e o desconto de R$ 15,12 entre essas duas referências sem inventar `vNF`. A emissão fica bloqueada com `COMPOSICAO_PEDIDO_MISTA_SEM_NFC`. Isso não autoriza montar a NFC-e mista.

O PIX integral usa o `MODELO_BRUTO` já existente. A validação desse XML na SEFAZ de produção continua pendente.

## 11. Confirmações

- Nenhum código de produção foi usado para venda real.
- Nenhum banco oficial foi acessado. O SQLite dos testes foi `:memory:`.
- Nenhuma operação fiscal ou financeira real foi executada.
- A flag de recomposição em produção não foi ligada.
