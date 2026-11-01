# Sprint 23 — Pagamento sequencial e integração da recomposição dinâmica

O PDV Express deixa de depender de combinações fixas de dois pagamentos. O operador inclui débito, crédito, dinheiro e as demais formas já suportadas, uma parcela por vez. Cada cartão é autorizado pelo TEF existente no momento da inclusão. O dinheiro dispara a validação da lista completa pelo contrato e pela tolerância já existentes. O fechamento continua em `criarVenda`.

Data: 31/10/2026.

Parecer técnico para o Tech Lead: o cenário de três pagamentos foi demonstrado em banco temporário, com autorizações preservadas, composição validada, persistência das três parcelas e comprovante sem dados de pagamento. A flag de produção da recomposição permanece desligada. Esta entrega não é homologação financeira real.

## 1. Fluxo anterior

O modal de pagamento misto oferecia só três pares: dinheiro + PIX, dinheiro + débito e dinheiro + crédito. A confirmação montava `pagamentosMistos` sem identificador TEF. A autorização das parcelas de cartão acontecia junta, no fechamento, por `processarPagamentosMistosTEF`. Não havia estado de parcela, valor restante depois de uma autorização, cancelamento de parcela ainda não autorizada nem bloqueio de nova autorização para parcela já aprovada.

## 2. Fluxo novo

1. O operador escolhe a forma e o valor e adiciona a parcela.
2. Se o TEF está ligado e a forma exige TEF, `processarPagamentoTEF` autoriza só essa parcela, com `idempotency_key` própria.
3. A parcela entra na lista somente depois da aprovação. Rejeição, timeout ou falha de comunicação não apagam as parcelas anteriores.
4. Um segundo clique enquanto a autorização está em curso recebe `AUTORIZACAO_EM_CURSO` e não dispara outra autorização.
5. Parcela TEF aprovada não é editada nem cancelada por esse modal.
6. Quando a lista que contém dinheiro fecha o total comercial, o PDV envia a lista inteira para `POST /api/vendas/composicao-sequencial`.
7. Qualquer alteração posterior invalida a composição. A confirmação só segue com a composição válida.
8. No fechamento, `processarPagamentosMistosTEF` não pede nova autorização para parcela que já tem transação aprovada.
9. `criarVenda` recebe `pagamento_sequencial: true` e valida de novo a lista completa antes de gravar. O backend ignora valor fiscal vindo do navegador.
10. A gravação permanece em `executarTransacaoVendaExclusiva`. O distribuidor oficial F×NF continua sendo `distribuirItensVendaComValorFiscalEfetivo`.

## 3. Arquivos alterados

- `frontend/pdv/js/pagamentoSequencial.js` — estado das parcelas, autorização única, invalidação da composição.
- `frontend/pdv/js/pdv.js` — modal sequencial no lugar das combinações fixas; fechamento marca `pagamento_sequencial` quando há mais de uma parcela.
- `frontend/pdv/index.html` — carrega o script antes de `pdv.js`.
- `frontend/shared/js/fiscalImpressao.js` — o comprovante não fiscal deixa de imprimir formas, valores de pagamento, NSU e autorização.
- `backend/services/vendas/PagamentoSequencialComposicaoService.js` — chama o contrato e a tolerância de dinheiro existentes.
- `backend/rotas/vendas.js` — `POST /api/vendas/composicao-sequencial`, sem persistência.
- `backend/services/vendas/VendaPagamentoService.js` — `criarVenda` revalida a lista quando `pagamento_sequencial` é verdadeiro. Soma divergente responde `400` `SOMA_PAGAMENTOS_DIVERGENTE` e não grava a venda.
- `tests/pdv/sprint-23-pagamento-sequencial-recomposicao.test.js` — suíte da sprint.
- `tests/pdv/sprint-21-etapa-g-consulta-historico.test.js` e `tests/pdv/sprint-21-etapa-i-reimpressao-empresa.test.js` — o comprovante deixa de ser cobrado por NSU. A consulta e o modal do histórico continuam exigindo NSU e autorização.

Não foram alterados `RecomposicaoFiscalFechamentoAdaptadorService.js`, `valorFiscalLiquido.js`, `distribuidorEstoqueVenda.js` nem `RECOMPOSICAO_HABILITADA_EM_PRODUCAO`.

## 4. Serviços reutilizados

- `prepararContratoRecomposicaoFiscal` — soma da lista contra o total comercial, sem candidato fiscal informado pelo PDV.
- `calcularMargemToleranciaDinheiro` — margem de 20% do dinheiro. No cenário de referência, R$ 10,00 de dinheiro produzem margem de R$ 2,00. `nao_e_desconto` permanece verdadeiro. A margem não vira desconto nem valor fiscal presumido de R$ 40,00.
- `processarPagamentoTEF` e `processarPagamentosMistosTEF` — o mesmo cliente TEF. Parcelas já aprovadas são puladas.
- `criarVenda`, `comprovarTransacoesTefAprovadas` e o índice `idx_venda_pagamentos_tef_transacao_unica` — vínculo empresarial, valor, tipo, NSU, autorização e uso único.
- `distribuirItensVendaComValorFiscalEfetivo` — distribuidor oficial. O encaminhamento de proposta validada (`encaminharPropostaValidadaAoDistribuidorOficial`) só segue com `CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR` ou harness interno. Sem essa autorização o retorno é `AUTORIZACAO_AUSENTE`, `distribuicao_aplicada: false`, `producao_habilitada: false`. `CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO` continua bloqueando, não habilitando.

`RecomposicaoFiscalIntegracaoPdvProposta.js` permanece módulo puro, sem import no fechamento. O ponto usado é o que `criarVenda` já ocupa: validar a lista e então chamar o distribuidor oficial.

## 5. Como a composição chega ao distribuidor

Com dinheiro e a soma igual ao total, o PDV pede a composição da lista inteira. `criarVenda` repete essa validação. O resultado do contrato não substitui o motor. Em seguida o fechamento oficial chama `distribuirItensVendaComValorFiscalEfetivo` com os pagamentos, o desconto e o acréscimo comerciais. Na venda de R$ 50,00 não fiscal, o motor devolveu fiscal R$ 0,00 e não fiscal R$ 50,00. Esses valores foram os gravados. O desconto gravado foi 0. A margem de R$ 2,00 não entrou como desconto.

O diagnóstico do adaptador registrou `diagnostico_nao_solicitado` porque `CDS_RECOMPOSICAO_DIAGNOSTICO` não foi ligado. A flag de produção permanece `false`.

## 6. Comprovante

O comprovante não fiscal imprime itens, total, desconto e acréscimo comercial. Não imprime forma de pagamento, valores de débito, crédito ou dinheiro, NSU, autorização TEF nem candidato interno de recomposição. `venda_pagamentos` e o histórico continuam com NSU e autorização.

## 7. Testes

Suíte `tests/pdv/sprint-23-pagamento-sequencial-recomposicao.test.js`: **5/5**. Banco `C:\Users\cicer\AppData\Local\Temp\cds-sprint23-8uDTNg\mercadao.db`. Autorizações reais: 0. Emissões fiscais: 0.

| Caso | Resultado |
| --- | --- |
| 1. Débito de R$ 20,00 aprovado | Parcela autorizada, transação 11 |
| 2. Crédito de R$ 20,00 depois do débito | Duas parcelas; o débito permanece |
| 3. Dinheiro de R$ 10,00 | Terceira parcela, sem nova chamada TEF |
| 4. Composição com os três pagamentos | Contrato válido, três valores 20, 20 e 10 |
| 5. Total financeiro | R$ 50,00 |
| 6. Três parcelas | Preservadas na lista e em `venda_pagamentos` |
| 7. TEF rejeitado | Parcela não entra; a anterior fica |
| 8. Timeout / falha de comunicação | Parcela não entra; a anterior fica |
| 9. Duplo clique | Uma autorização; a segunda responde `AUTORIZACAO_EM_CURSO` |
| 10. Alteração de parcela | Composição anterior deixa de valer; TEF aprovado não é editado |
| 11. Recomposição divergente | HTTP 400, nenhuma venda nova |
| 12. Persistência e vínculo | Três pagamentos, NSU e autorização internos, segunda venda com a mesma transação recusada |
| 13. Distribuidor oficial F×NF | Fiscal 0 e não fiscal 50, iguais ao gravado; proposta sem autorização não é aplicada |
| 14. Regressão | Etapa B 14/14, etapa C 7/7, etapa G 2/2, etapa I 4/4, Sprint 22 8/8 |
| 15. Comprovante | Sem NSU, autorização, cartão, dinheiro ou candidato fiscal |

Regressões, um arquivo por vez:

- Etapa B: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-g1VDo1\mercadao.db`, autorizações reais 0, emissões fiscais 0.
- Etapa C: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21c-Jkr28h\mercadao.db`, autorizações reais 0, emissões fiscais 0.
- Etapa G: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21g-2MJilz\mercadao.db`.
- Etapa I: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21i-2zEk7L\mercadao.db`.
- Sprint 22: `C:\Users\cicer\AppData\Local\Temp\cds-sprint22a-DsYevh\mercadao.db`, autorizações reais 0.

## 8. Pendências e riscos

- A recomposição não está habilitada em produção. O distribuidor oficial da venda continua o caminho já homologado. Uma proposta de recomposição só substitui esse resultado com a autorização interna existente, que não foi ligada.
- A margem de dinheiro é calculada e exibida no contrato. Ela não altera desconto, total comercial nem valor fiscal.
- O modal novo não foi exercitado num PDV aberto no navegador. A máquina de parcelas e o fechamento foram exercitados por teste. A homologação visual do modal fica para uma etapa própria, se o Tech Lead pedir.
- Abandonar o modal depois de um cartão aprovado deixa a transação sem venda. O índice único impede reutilizá-la em outra venda. Não há estorno de TEF nesta sprint.
- O histórico continua mostrando NSU e autorização. Só o comprovante foi restringido.

## 9. Confirmação operacional

Não houve alteração do banco oficial. Não houve TEF real, PIX real, adquirente real, NFC-e, NF-e nem transmissão à SEFAZ. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false`. Nenhuma outra sprint foi iniciada.
