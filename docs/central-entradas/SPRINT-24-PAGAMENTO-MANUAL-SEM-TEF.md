# Sprint 24 — Pagamento manual sem TEF

O PDV fecha a venda quando o TEF está desligado, desde que o operador confirme o recebimento no modal que já existia. A ausência do TEF deixa de impedir dinheiro, PIX, débito, crédito e pagamento misto, inclusive quando o valor fiscal é zero.

Data: 31/10/2026.

Parecer técnico para o Tech Lead: a confirmação manual explícita grava forma, valor, modalidade, operador e data/hora, sem NSU, autorização, transação TEF ou adquirente inventados. Com o TEF ligado e a forma exigindo TEF, o caminho automático permanece. Esta entrega não é homologação financeira real.

## 1. Regra

O TEF é opcional. Com ele desligado, `resolverFluxoPagamentoFiscal` marca `usarConfirmacaoManual` para dinheiro, PIX, débito, crédito e misto, mesmo com o modo de confirmação em TEF e mesmo com `valor_fiscal = 0`.

Com o TEF ligado, cartão e PIX continuam no caminho automático. O modo MANUAL sozinho não desliga esse caminho. Dinheiro com TEF ligado e modo TEF continua sem abrir o modal.

A confirmação usa o modal `#confirmacaoFiscalManualModal` e o botão `#confirmar-recebimento-fiscal-manual`. Quando o fiscal é zero, o mesmo modal exibe o valor recebido e exige o clique. Valor zero nos dois campos continua sem modal, porque não há o que confirmar.

Sem o clique, o PDV não envia a venda. No backend, cartão, PIX, débito ou crédito sem `tef_transacao_id` e sem `confirmacao_fiscal_manual` explícita continuam recusados quando o TEF está desligado. A flag explícita com o TEF ligado e o modo em TEF não transforma a parcela em manual: o orquestrador segue para a autorização TEF.

Um segundo clique no mesmo botão é ignorado. `executarFinalizacaoVenda` continua recusando outra finalização enquanto a primeira está em curso.

Parcela que já tem transação TEF aprovada é comprovada e vinculada. Ela não recebe nova autorização quando a parcela seguinte é manual.

A soma das parcelas continua conferida com o total da venda antes da gravação. Soma diferente responde 400 e não grava.

## 2. O que cada parcela manual grava

Em `venda_pagamentos`, a parcela manual fica com:

- forma de pagamento e valor;
- `confirmacao_modalidade = manual` e `confirmacao_manual = 1`;
- `operador_id` do usuário autenticado;
- `confirmado_em` com data e hora locais.

NSU, autorização, `tef_transacao_id`, bandeira e adquirente ficam nulos, mesmo se o pedido enviar esses campos. Parcela com transação TEF real mantém o NSU e a autorização lidos da linha de `tef_transacoes` e a modalidade `tef`.

## 3. Arquivos alterados

- `backend/services/tef/tefFluxoPagamento.js` e `frontend/shared/js/tefFluxoPagamento.js` — caminho manual com TEF desligado; trava do segundo clique.
- `frontend/pdv/js/pdv.js` — o modal existente passa a confirmar também valor fiscal zero e marca as parcelas manuais sem identificador TEF.
- `backend/services/OrquestradorPagamento.js` — confirmação explícita com TEF desligado; parcela já aprovada não é reautorizada.
- `backend/services/vendas/VendaPagamentoService.js` — gravação da modalidade, do operador e do horário, sem identificadores fictícios.
- `backend/database.js` — colunas `confirmacao_modalidade`, `confirmacao_manual`, `operador_id` e `confirmado_em` em `venda_pagamentos`, por alteração idempotente.
- `backend/rotas/vendas.js` — a consulta da venda devolve esses campos.
- `tests/tef/tef-fluxo-pagamento.test.js` — casos do caminho manual e do segundo clique.
- `tests/pdv/sprint-24-pagamento-manual-sem-tef.test.js` — suíte da sprint.

Não foram alterados o distribuidor oficial F×NF, o adaptador de recomposição, `valorFiscalLiquido.js`, a regra de empresa matriz do PDV nem o roteamento iFood. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece falsa. O banco oficial não foi migrado.

O distribuidor oficial continua com bucket exclusivo. Um fechamento novo fica todo fiscal ou todo não fiscal. A suíte prova os dois lados em separado e prova que o pagamento manual não cruza os valores.

## 4. Testes

Unidade, isolada: `node tests/tef/tef-fluxo-pagamento.test.js` — 16/16.

Suíte da sprint, isolada, banco temporário: `node --test --test-concurrency=1 tests/pdv/sprint-24-pagamento-manual-sem-tef.test.js` — 7/7.

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint24-zdYPdi\mercadao.db`.

Cobertura da suíte:

- venda 100% não fiscal com cartão manual;
- venda 100% não fiscal com PIX manual;
- venda fiscal com pagamento manual, sem emissão de nota;
- buckets fiscal e não fiscal pelo distribuidor oficial, sem cruzar valores;
- três parcelas manuais (débito, crédito e dinheiro);
- soma divergente recusada, sem gravar;
- segundo clique da confirmação recusado;
- cartão sem confirmação explícita recusado, sem gravar;
- TEF ligado não aceita cartão como manual; a autorização simulada é bloqueada e a venda não grava;
- parcela TEF já aprovada não é autorizada de novo quando entra dinheiro manual.

`autorizacoesReais`: 1. É a chamada bloqueada do teste de regressão (`TEF_REAL_BLOQUEADO`). Nenhuma transação financeira real. `emissoesFiscais`: 0.

## 5. Parar

Aguardando avaliação do Tech Lead.
