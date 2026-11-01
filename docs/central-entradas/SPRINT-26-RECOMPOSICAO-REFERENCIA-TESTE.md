# Sprint 26 — Recomposição de referência no ambiente de teste

A recomposição de referência só roda quando há dinheiro e somente com a variável de teste ligada. A flag de produção permanece falsa. O distribuidor oficial não foi alterado.

Data: 01/11/2026.

## 1. Arquivos alterados

- `backend/services/vendas/PagamentoSequencialComposicaoService.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/rotas/vendas.js`
- `frontend/pdv/js/pdv.js`
- `tests/pdv/sprint-26-recomposicao-referencia-teste.test.js`

Não foram alterados o distribuidor F×NF, o estoque fiscal, o roteamento de empresas, a flag `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` nem as integrações TEF.

## 2. Flag de teste e produção

Produção: `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` continua `false` em `RecomposicaoFiscalContratoService.js`.

Teste: `CDS_RECOMPOSICAO_REFERENCIA_TESTE=1`, lida só de `process.env`. Não vem do corpo da requisição. Se a flag de produção estivesse verdadeira, o ambiente de teste também não grava a referência.

Sem a variável de teste, dinheiro na venda não calcula nem grava referência.

## 3. Integração

O núcleo é `avaliarReferenciaRecomposicao`.

- Sem dinheiro (débito, crédito, PIX ou a combinação dos três): não chama o motor.
- Com dinheiro: `valor_fiscal_referencia = total financeiro − dinheiro` e `valor_nao_fiscal_referencia = dinheiro`.
- Esse valor fiscal segue para `avaliarCandidatoComBuscarComposicao`, o núcleo do motor de composição já existente.
- `POST /api/vendas/composicao-sequencial` devolve a avaliação e não grava venda.
- O pagamento misto usa essa rota quando a soma fecha e há dinheiro.
- A escolha direta de dinheiro usa a mesma função, com uma parcela de dinheiro no total da venda.
- No fechamento, a referência e o código do motor são gravados em `venda_composicao_referencia`. As parcelas em `venda_pagamentos` e `vendas.total` não são substituídos. `vendas.valor_fiscal` continua o do distribuidor oficial.

Se o motor não autoriza a aplicação, a linha fica só como referência: `aplica_ao_fluxo_oficial = 0` e `distribuicao_oficial_alterada = 0`.

## 4. Testes

`node --test --test-concurrency=1 tests/pdv/sprint-26-recomposicao-referencia-teste.test.js`: 6/6.

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint26-eYUsjQ\mercadao.db`.

`autorizacoesReais` 0. `emissoesFiscais` 0. `producao` false.

| Cenário | Resultado |
| --- | --- |
| A. Só débito | Sem referência |
| B. Só crédito | Sem referência |
| C. Só PIX | Sem referência |
| D. Débito + crédito + PIX | Sem referência |
| E. Só dinheiro, fluxo direto | Referência fiscal 0 e não fiscal 10, em venda de R$ 10,00 |
| F. Débito + dinheiro | Fiscal 6 e não fiscal 4 |
| G. PIX + dinheiro | Fiscal 7 e não fiscal 3 |
| H. Débito + crédito + PIX + dinheiro | Fiscal 6 e não fiscal 4 |
| I. R$ 50,00 | Total 50, referência fiscal 40, não fiscal 10 |
| J. Soma divergente | HTTP 400 `SOMA_PAGAMENTOS_DIVERGENTE`, venda não gravada |
| K. Rejeição e timeout | Parcela nova não aprovada; a anterior permanece |
| L. Parcela já aprovada | Segunda passagem não chama o autorizador |

## 5. Persistência da referência

Na venda de R$ 50,00, `venda_composicao_referencia` ficou com total financeiro 50, referência fiscal 40, referência não fiscal 10 e código `COMPOSICAO_AUSENTE_NO_MOTOR`.

`vendas.total` permaneceu 50. `vendas.valor_fiscal` permaneceu 0 e `vendas.valor_nao_fiscal` 50, porque o estoque do teste era não fiscal e o distribuidor oficial não recebeu a referência. As três parcelas continuam em `venda_pagamentos`.

## 6. Produção protegida

A constante de produção foi lida como `false`. Com a variável de teste removida, a mesma composição de R$ 50,00 devolve `recomposicao_executada` falso e referência nula. Uma venda em dinheiro feita nesse estado gravou o total e não criou linha de referência.

## 7. Pendências

O motor não autorizou a aplicação: não havia modelo fiscal elegível para o item, então o código foi `COMPOSICAO_AUSENTE_NO_MOTOR`. A referência foi guardada e a distribuição oficial não mudou.

Esta Sprint não aplica a referência no distribuidor F×NF, mesmo que um modelo futuro marque `distribuicao_possivel`. A aplicação continua dependente da flag de produção, que permanece desligada.

A tela do PDV em execução não foi aberta, para não usar o banco oficial. A escolha direta de dinheiro chama o mesmo núcleo; a gravação desse caminho foi comprovada pelo fechamento com `pagamento_sequencial` falso.

Nenhuma NFC-e, NF-e, TEF real, PIX real ou evento à SEFAZ foi executado. O banco oficial não foi aberto.

## 8. Ajuste da regra por forma confirmada

A referência deixou de ser `total − dinheiro`.

- Referência fiscal: soma de PIX, débito e crédito efetivamente confirmados.
- Referência não fiscal: soma do dinheiro efetivamente recebido.
- As duas somas fecham o total financeiro quando todas as parcelas da venda estão confirmadas.
- Parcela com status pendente, rejeitada ou falha não entra.
- `CDS_RECOMPOSICAO_REFERENCIA_TESTE=1` e `RECOMPOSICAO_HABILITADA_EM_PRODUCAO = false` permanecem.
- O distribuidor oficial não foi alterado.

Arquivo de código: `backend/services/vendas/PagamentoSequencialComposicaoService.js`.

Teste: `tests/pdv/sprint-26-recomposicao-referencia-teste.test.js`, 8/8, banco `C:\Users\cicer\AppData\Local\Temp\cds-sprint26-JrkV9x\mercadao.db`. `autorizacoesReais` 0, `emissoesFiscais` 0, produção false.

Os seis exemplos gravados: débito 10 + crédito 10 → 20/0; débito 30 + dinheiro 20 → 30/20; dinheiro 15 + PIX 25 → 25/15; PIX 30 + crédito 20 → 50/0; só dinheiro 15 → 0/15; só PIX 50 → 50/0. Em todos, a soma das referências igualou o total e `vendas.valor_fiscal` permaneceu 0.
