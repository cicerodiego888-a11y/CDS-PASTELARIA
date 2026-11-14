# Auditoria do arredondamento da tolerância de 20% do dinheiro

**ID:** CDS-FISCAL-TOLERANCIA-DINHEIRO-AUDIT-01  
**Classificação:** REGRA CONFIRMADA

Nenhum código foi alterado. Nenhum teste existente foi alterado. O banco oficial não foi aberto. Não houve pagamento real nem transmissão à SEFAZ. A NFC-e de pagamento misto continua bloqueada por `COMPOSICAO_PEDIDO_MISTA_SEM_NFC`.

## 1. Implementação encontrada

A margem da tolerância está em `calcularMargemToleranciaDinheiro`, no arquivo `backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js`.

O percentual padrão é `PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO = 0.2`.

A conta usa centavos inteiros. O dinheiro entra por `Math.round((valor + Number.EPSILON) × 100)`. Só parcelas cuja forma é dinheiro, espécie ou cash entram na soma. PIX, débito e crédito não entram nessa função.

```text
centavos_da_margem = Math.round(centavos_do_dinheiro × 0,20)
margem_maxima      = round2(centavos_da_margem / 100)
```

Não há piso em múltiplos de R$ 0,05 dentro dessa função. O objeto devolvido marca `nao_e_desconto: true`, `nao_e_voucher: true`, `nao_e_ajuste_pagamento: true` e `nao_e_valor_nao_fiscal: true`. A fórmula gravada no retorno é `percentual * soma(pagamentos em dinheiro)`.

## 2. De onde veio o R$ 0,05

O piso em moedas de R$ 0,05 está em outra função, `centavosMoedaReal`, em `PagamentoRecomposicaoDocumentoService.js`:

```text
centavos_inteiros = floor(centavos)
resultado         = centavos_inteiros − (centavos_inteiros % 5)
```

O teste `pdv-mobile-03` fixa esse contrato à parte: `centavosMoedaReal(153) = 150`.

`itensFiscaisInteirosParaReferencia` chama as duas em sequência. Primeiro obtém `margem_maxima`. Depois aplica o piso de R$ 0,05 sobre esse valor já arredondado ao centavo. O que passar da margem vira `desconto`; o que cabe na margem vira `dinheiro_aplicado`. Esse caminho não é a margem em si. O emissor só entra nele se `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` for verdadeira. A flag continua falsa.

## 3. Tabela executada na função real

A função foi chamada com uma parcela `dinheiro` de cada valor. O piso bruto é o corte de R$ 0,05 aplicado ao percentual cru, antes do `Math.round` dos centavos. O piso da função é o mesmo corte aplicado depois do resultado real.

| Dinheiro | 20% matemático | Centavos do dinheiro | Centavos após `Math.round` | Função real | Piso de R$ 0,05 no valor cru | Piso de R$ 0,05 no resultado da função | Função − piso cru |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,00 | 0,20 | 100 | 20 | 0,20 | 0,20 | 0,20 | 0,00 |
| 5,00 | 1,00 | 500 | 100 | 1,00 | 1,00 | 1,00 | 0,00 |
| 10,00 | 2,00 | 1000 | 200 | 2,00 | 2,00 | 2,00 | 0,00 |
| 11,99 | 2,398 | 1199 | 240 | 2,40 | 2,35 | 2,40 | 0,05 |
| 12,49 | 2,498 | 1249 | 250 | 2,50 | 2,45 | 2,50 | 0,05 |
| 15,00 | 3,00 | 1500 | 300 | 3,00 | 3,00 | 3,00 | 0,00 |
| 19,99 | 3,998 | 1999 | 400 | 4,00 | 3,95 | 4,00 | 0,05 |
| 20,00 | 4,00 | 2000 | 400 | 4,00 | 4,00 | 4,00 | 0,00 |
| 25,99 | 5,198 | 2599 | 520 | 5,20 | 5,15 | 5,20 | 0,05 |
| 50,00 | 10,00 | 5000 | 1000 | 10,00 | 10,00 | 10,00 | 0,00 |

## 4. R$ 11,99: R$ 2,40 e R$ 2,35

```text
11,99 × 0,20 = 2,398
centavos do dinheiro = 1199
Math.round(1199 × 0,20) = Math.round(239,8) = 240
margem_maxima = R$ 2,40
```

R$ 2,35 só aparece se o corte de R$ 0,05 for feito no valor cru de 239,8 centavos, antes do arredondamento para o centavo mais próximo: `floor(239,8) = 239`, e `239 − (239 % 5) = 235`.

A função real não faz isso. Ela arredonda 239,8 para 240. 240 já é múltiplo de 5, então o piso de moeda aplicado depois também permanece R$ 2,40. A diferença de R$ 0,05 existe entre o percentual cru e a função. Não existe entre a função e o piso de R$ 0,05 aplicado ao resultado dela.

O relatório da correção descreveu esta função. A auditoria anterior descreveu o piso de `centavosMoedaReal` como se ele fosse o arredondamento da própria margem. No exemplo de R$ 11,99 os dois textos parecem discordar, mas o piso posterior não muda R$ 2,40.

## 5. Contrato original

O contrato da margem está no teste `cds-pagamento-misto-recomposicao-fiscal-05`:

- R$ 10,00 de dinheiro produzem margem de R$ 2,00.
- R$ 10,05 produzem margem de R$ 2,01, não R$ 2,00.
- R$ 0,10 + R$ 0,20 produzem margem de R$ 0,06.
- `nao_e_desconto` permanece verdadeiro.
- `aplicou_desconto` permanece falso quando a quantidade inteira não cabe na margem. O código de recusa é `MARGEM_INSUFICIENTE`.

R$ 2,01 não é múltiplo de R$ 0,05. Se a margem fosse cortada para baixo em moedas de cinco centavos, o teste exigiria R$ 2,00. O contrato original é o centavo mais próximo.

A Sprint 32 registra a mesma fórmula, `0,20 × soma do dinheiro`, e afirma que a margem não vira `vDesc`. O motor `buscarComposicao` só usa a margem, em centavos inteiros, para limitar a faixa `[alvo − margem, alvo]`. O comentário desse motor diz que a margem não é desconto nem classificação fiscal.

## 6. Pontos de chamada

| Consumidor | Uso da margem |
|---|---|
| `RecomposicaoFiscalToleranciaDinheiroSimulacaoService.avaliarCandidatosComToleranciaDinheiro` | Distância até um total de quantidade inteira. Não aplica desconto. |
| `RecomposicaoFiscalComposicaoMotorSimulacaoService` | Converte `margem_maxima` para centavos e entrega a faixa ao `buscarComposicao`. |
| `RecomposicaoFiscalIntegracaoSimulacaoService` | Simulação isolada. Não grava venda. |
| `PagamentoSequencialComposicaoService.avaliarPagamentosSequenciais` | Guarda a margem e marca `margem_convertida_em_desconto: false`. |
| `PagamentoRecomposicaoDocumentoService`, na proposta do residual | Usa a margem como limite de seleção. A apresentação declara `desconto_convertido_da_margem: false`. |
| `PagamentoRecomposicaoDocumentoService.itensFiscaisInteirosParaReferencia` | Único ponto que transforma o excedente acima da margem em `desconto` e a parte que cabe em `dinheiro_aplicado`, depois do piso de R$ 0,05. |

A margem calculada não altera o valor recebido. Ela não soma valor fiscal. Ela não mexe na composição aprovada do pedido. A simulação trata a margem como faixa. A emissão só converteria essa faixa em desconto se a flag de produção estivesse ligada e a seleção fiscal estivesse bloqueada. As duas condições não estão ativas.

## 7. Riscos

1. Os dois relatórios misturaram duas funções. A margem é R$ 2,40 para R$ 11,99. R$ 2,35 não é o resultado implementado.
2. `itensFiscaisInteirosParaReferencia` ainda sabe converter excedente em desconto. O emissor não a chama com a flag desligada. Reativar a flag sem separar as duas regras faria o piso de R$ 0,05 e o desconto voltarem juntos.
3. Para valores como R$ 10,05, a margem real é R$ 2,01. O piso de moeda, se fosse aplicado em seguida, reduziria isso para R$ 2,00. Essa redução não faz parte de `calcularMargemToleranciaDinheiro`.

## 8. Confirmações

- Nenhum arquivo de produção foi modificado.
- Nenhum teste existente foi modificado.
- O percentual permanece 0,2.
- A classificação do dinheiro não foi alterada.
- O fechamento corrigido na sprint anterior não foi alterado.
- A flag de produção não foi ligada.
- O banco oficial não foi acessado.
- Nenhum pagamento real e nenhuma NFC-e foram executados.

## 9. Recomendação

Não mudar `calcularMargemToleranciaDinheiro`. O contrato testado é o arredondamento para o centavo mais próximo.

Se o Product Owner quiser que a tolerância operacional seja o piso de R$ 0,05, essa decisão precisa ser explícita e aplicada só no consumidor que usa a margem como limite, sem transformar o resultado em desconto. R$ 11,99 continuaria em R$ 2,40 mesmo com esse piso, porque 240 centavos já são múltiplos de 5. A diferença apareceria em casos como R$ 10,05, de R$ 2,01 para R$ 2,00.

Não implementar essa troca nesta auditoria.
