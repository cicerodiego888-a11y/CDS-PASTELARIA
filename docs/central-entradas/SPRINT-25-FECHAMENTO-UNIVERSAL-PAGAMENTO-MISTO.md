# Sprint 25 — Fechamento universal do pagamento misto

O fechamento da venda passa a tratar a lista sequencial do operador antes de qualquer caminho que substitua `dados.pagamentos` por um pagamento único. A lista vale com o TEF ligado ou desligado.

Data: 31/10/2026.

Parecer técnico para o Tech Lead: a correção está implementada e coberta por testes em banco temporário. Esta entrega não declara a Sprint concluída e não é homologação financeira real.

## 1. Causa raiz

Em `executarFinalizacaoVenda`, o ramo `deveUsarTefAutomatico && totalFiscal > 0` vinha antes do pagamento misto. Com TEF ligado e valor fiscal positivo, `processarVendaFiscalNaoFiscal` gravava um único pagamento do valor fiscal e descartava débito, crédito e dinheiro.

Com o TEF desligado, esse ramo não era escolhido. O caminho da Sprint 24 já mantinha a lista. O defeito aparece quando o TEF está ligado e a venda tem valor fiscal.

## 2. Arquivos alterados

- `frontend/shared/js/tefFluxoPagamento.js`
- `backend/services/tef/tefFluxoPagamento.js`
- `frontend/pdv/js/pdv.js`
- `tests/tef/tef-fluxo-pagamento.test.js`
- `tests/pdv/sprint-25-fechamento-universal-misto.test.js`

O distribuidor oficial F×NF não foi alterado. A recomposição fiscal em produção permanece desligada. O total financeiro da venda não foi recalculado para R$ 40,00.

## 3. Correção aplicada

`resolverFluxoPagamentoFiscal` marca `preservarListaSequencial` quando há pagamento misto com mais de uma parcela de valor positivo.

`ramoFechamentoPagamento` escolhe o ramo nesta ordem:

1. `lista_sequencial` — a lista do operador.
2. `pagamento_unico_fiscal` — venda de uma forma, TEF ligado e valor fiscal positivo.
3. `tef_misto`, `tef_simples` ou `manual`, nos casos que já existiam.

No ramo da lista:

- com TEF ligado, `processarPagamentosMistosTEF` autoriza só a parcela ainda pendente;
- parcela com `tef_transacao_id` e status aprovada segue sem nova autorização e permanece modalidade `tef`;
- dinheiro, e qualquer parcela sem transação TEF, usa o modal de confirmação manual já existente;
- com TEF desligado, nenhuma autorização TEF é chamada;
- cancelar a confirmação encerra o fechamento sem gravar;
- `dados.pagamentos` recebe as parcelas originais e `pagamento_sequencial` fica verdadeiro para a conferência da soma no backend.

Parcela com transação TEF não passa por `marcarParcelaConfirmacaoManual`, que apagaria NSU e autorização. Parcela manual continua sem NSU, autorização, adquirente ou identificador TEF fabricados.

## 4. Testes e resultados

Executados um arquivo por vez, com `--test-concurrency=1`.

| Arquivo | Resultado | Banco |
| --- | --- | --- |
| `tests/tef/tef-fluxo-pagamento.test.js` | 18/18 | sem banco |
| `tests/pdv/sprint-25-fechamento-universal-misto.test.js` | 6/6 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint25-xffAiJ\mercadao.db` |
| `tests/pdv/sprint-24-pagamento-manual-sem-tef.test.js` | 7/7 | `C:\Users\cicer\AppData\Local\Temp\cds-sprint24-iILuVE\mercadao.db` |

Cenários da Sprint 25:

- A. TEF desligado: débito 20, crédito 20 e dinheiro 10 manuais. Total R$ 50,00. NSU, autorização e adquirente nulos.
- B e D. TEF ligado: débito e crédito já autorizados permanecem com o mesmo `tef_transacao_id`. Dinheiro manual. Nenhuma chamada ao autorizador no fechamento.
- C. Valor fiscal positivo: ramo `lista_sequencial`. Três parcelas gravadas. `valor_fiscal` 50 e `valor_nao_fiscal` 0. O valor fiscal não virou 40.
- E. Rejeição da segunda parcela deixa a primeira na lista.
- F. Timeout marca a parcela como falha, sem aprová-la, e não remove a anterior.
- G. Soma 30 contra total 50: HTTP 400 `SOMA_PAGAMENTOS_DIVERGENTE`. Nenhuma venda nova.
- H. Consulta das parcelas da venda recupera as três linhas.
- I. Segundo clique da confirmação é recusado. Segundo POST com as mesmas transações TEF não cria outra venda.
- J. Regressão da Sprint 24: pagamento manual sem TEF continua gravando. O caso em que o TEF ligado tentaria virar manual continua bloqueado pelo autorizador simulado e a venda não é gravada.

Sprint 25: `autorizacoesReais` 0 e `emissoesFiscais` 0.

Sprint 24: `autorizacoesReais` 1 é só o stub `TEF_REAL_BLOQUEADO` do caso que impede transformar TEF em manual. `emissoesFiscais` 0.

## 5. A lista não é substituída

Com três parcelas, TEF ligado e `totalFiscal` 50, o resolvedor devolve `preservarListaSequencial` verdadeiro e o ramo `lista_sequencial`. O ramo de pagamento único fiscal só entra depois, para venda que não é lista sequencial.

No banco temporário, a venda fiscal de R$ 50,00 ficou com três linhas em `venda_pagamentos`: débito 20, crédito 20 e dinheiro 10.

## 6. Parcela TEF aprovada não é reautorizada

`autorizarParcelasPendentes` recebeu débito e crédito já aprovados e não chamou o autorizador. O POST seguinte usou os mesmos identificadores. O stub que lança `TEF_REAL_BLOQUEADO` não foi acionado nesse fechamento.

## 7. Banco temporário

Os dois arquivos de venda usaram diretórios próprios em `%TEMP%`, criados antes de carregar `backend/database.js`. O banco oficial não foi aberto nem migrado.

## 8. Transações reais e emissão fiscal

Nenhuma transação TEF, PIX ou adquirente real. Nenhuma NFC-e, NF-e ou evento à SEFAZ. `emitir_fiscal` permaneceu falso nos cenários gravados. A flag de recomposição em produção permanece falsa.

## 9. Continuidade — sequência na tela

A preservação da lista no fechamento permanece. A tela do pagamento misto é que estava incompleta: forma e valor apareciam juntos, e o operador podia montar a composição inteira antes de confirmar cada parcela.

Agora a escolha da forma abre o pedido do valor daquela forma. A confirmação registra a parcela, atualiza o restante e volta para a escolha da próxima forma. O botão de fechar a venda só habilita quando a soma chega ao total. Valor acima do restante é recusado e a lista anterior permanece.

Com o TEF ligado, débito e crédito são autorizados no momento em que o operador confirma o valor daquela parcela. Dinheiro fica informado, sem autorização TEF. Uma segunda passagem pela lista não autoriza de novo as parcelas já aprovadas. Com o TEF desligado, nenhuma autorização é chamada; as parcelas ficam para a confirmação manual explícita do fechamento.

Arquivos desta continuidade:

- `frontend/pdv/js/interacaoPagamentoMisto.js`
- `frontend/pdv/js/pdv.js`
- `frontend/pdv/index.html`
- `tests/pdv/sprint-25-interacao-sequencial.test.js`

`node --test --test-concurrency=1 tests/pdv/sprint-25-interacao-sequencial.test.js`: 4/4. Esse teste não abre banco, porque a sequência acontece no PDV antes do POST. O autorizador é simulado. A persistência das três parcelas continua a da suíte anterior, no banco temporário `cds-sprint25-xffAiJ`.

A Sprint aguarda avaliação do Tech Lead.
