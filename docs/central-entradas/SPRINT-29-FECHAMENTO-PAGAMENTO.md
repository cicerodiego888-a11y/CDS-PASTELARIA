# Sprint PDV-UX-29 — fechamento do pagamento

Homologação operacional não declarada. A validação abaixo é automatizada, em banco temporário, sem TEF, PIX, NFC-e ou SEFAZ reais. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece falsa.

## Causas

1. Confirmação fiscal redundante. No ramo `lista_sequencial`, o fechamento chamava `processarVendaFiscalManual` sempre que o TEF estava desligado ou alguma parcela não tinha `tef_transacao_id`. Dinheiro nunca tem esse identificador. A tela "Confirme que o valor fiscal foi recebido" abria depois de cada parcela já ter sido confirmada. Cancelar essa tela retornava antes do `POST /api/vendas`.

2. Modal de valor do PIX. Depois da aprovação, `mostrarModalPixTefPDV` substituía o HTML de `#modal-container`, onde está a tela de pagamento, e `#modalValorDireto` ficava no `body`. O fechamento não começava sozinho quando o saldo zerava.

3. Venda não finalizada. O processo parava em duas etapas: a parcela integral não chamava o fechamento, e o ramo sequencial esperava a confirmação extra antes da persistência. Se a resposta já tinha identificador e a atualização da tela falhava, um novo envio podia criar outra venda.

## Fluxo corrigido

Parcela eletrônica continua passando pelo autorizador antes de ser registrada. Dinheiro continua manual. Com a lista já confirmada, o fechamento marca o dinheiro como confirmação manual, sem segundo clique e sem NSU inventado, e segue para a venda. Parcela pendente, recusada ou sem autorização bloqueia com o código real.

O modal de valor é fechado e o backdrop é removido depois da aprovação. PIX de parcela não abre outra tela por cima da de pagamento. Saldo restante volta à escolha da forma. Saldo zerado inicia o fechamento existente.

A chave `chave_fechamento_pdv` grava a venda uma vez. Repetir a mesma chave devolve a venda existente.

## Arquivos

- `frontend/pdv/js/pdv.js`
- `frontend/shared/js/tefFluxoPagamento.js`
- `backend/rotas/vendas.js`
- `tests/pdv/sprint-29-fechamento-pagamento.test.js`

## Teste

`node --test --test-concurrency=1 tests/pdv/sprint-29-fechamento-pagamento.test.js`

Resultado: 9 testes, 0 falhas. Banco temporário `cds-sprint29-*`. Autorizações reais: 0. Emissões: 0. Flag de produção: falsa.

A venda integral de PIX simulado foi persistida e reconhecida pelo identificador. O segundo envio da mesma chave devolveu o mesmo id. Pagamento divergente não foi apresentado como concluído. Referência de R$ 40,00 fiscais e R$ 10,00 em dinheiro manteve `vProd` 40. Sem composição elegível, o bloqueio veio com código e sem XML.

## Limitações

O PDV oficial não foi aberto. A confirmação visual do modal no Electron fica para o operador. O ramo manual de venda sem parcelas sequenciais ainda usa a confirmação fiscal da Sprint 24. A suíte não emite NFC-e.
