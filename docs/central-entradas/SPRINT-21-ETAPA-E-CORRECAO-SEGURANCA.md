# Sprint 21 — Etapa E: bloqueio sem autorização TEF ou confirmação manual

Correção da falha da Etapa B. Quando as duas consultas de configuração falham juntas, o PDV não fecha venda de cartão sem autorização TEF válida ou confirmação manual explícita. A mesma regra vale no backend, que não aceita o corpo enviado direto.

Etapas C e D não foram iniciadas.

Data: 31/10/2026.

Suíte: `node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-b-automatico.test.js` — 14 testes, 14 aprovações.

## Causa

As duas consultas falhavam de forma aberta. `obterModoConfirmacaoFiscal` devolvia `TEF` e `obterTefHabilitadoConfig` devolvia `false`. Com isso, `deveUsarTefAutomatico` e `usarConfirmacaoManual` ficavam falsos. `executarFinalizacaoVenda` não entrava em nenhum ramo e chamava `enviarVenda` com o cartão original, sem `dados.tef` e sem `confirmacao_fiscal_manual`.

No backend, `deveUsarTEFParaFiscal` também devolvia falso quando o TEF estava desligado, antes de olhar a forma. `processarRecebimentoFiscal` então chamava `processarConfirmacaoManualFiscal`, que marcava o recebimento como aprovado sem flag explícita. Cartão com TEF indisponível virava venda quitada. Um id informado pelo cliente era aceito sem leitura do status em `tef_transacoes`.

## Arquivos alterados

- `frontend/pdv/js/pdv.js`
- `backend/services/OrquestradorPagamento.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `tests/pdv/sprint-21-etapa-b-automatico.test.js`
- `docs/central-entradas/SPRINT-21-ETAPA-E-CORRECAO-SEGURANCA.md`

Não foram alterados o Motor F×NF, o rateio, a rota de duplicidade do TEF, o isolamento de empresa nem o fluxo de emissão.

## Proteção no frontend

Antes das consultas, a tela calcula se a forma exige TEF (`cartao`, `pix` e as demais formas já previstas em `formaPagamentoUsaTEF`). Essa informação permanece mesmo quando os dois GETs falham.

`enviarVenda` só segue se um ramo legítimo tiver terminado, ou se o payload já tiver autorização TEF (`dados.tef.transacao_id` ou `tef_transacao_id` no pagamento) ou `confirmacao_fiscal_manual` explícita. A falha de consulta não liga essa flag e não é tratada como sucesso de HTTP.

Se nenhuma dessas condições existir, a finalização para, `vendaEmProcessamento` volta a falso, o carrinho permanece e a tela mostra: “Não foi possível confirmar a configuração ou a autorização do pagamento. A venda não foi enviada.”

Os ramos que já existiam continuam: TEF automático com valor fiscal, pagamento misto com TEF, confirmação do recebimento não fiscal quando o TEF foi lido como habilitado e o total fiscal é zero, e o modal manual que grava `confirmacao_fiscal_manual: true`.

## Proteção no backend

`VendaPagamentoService` repassa `req.body.confirmacao_fiscal_manual` ao orquestrador, na venda à vista e na venda a prazo.

Para forma que exige TEF:

- Com `tef_transacao_id` em todos os pagamentos dessa forma, o orquestrador lê `tef_transacoes` e só aceita status aprovado (`estaAprovado`). Não chama `tefManager.autorizar`.
- Com o modo persistido `MANUAL` e a flag explícita (`true`, `'true'`, `1` ou `'1'`), segue o recebimento manual já existente.
- Com TEF habilitado, modo diferente de `MANUAL` e valor fiscal maior que zero, sem id prévio, permanece o caminho atual de autorização.
- Nos demais casos a venda é rejeitada com HTTP 400 e a mensagem “Não foi possível confirmar a autorização do pagamento. A venda não foi registrada.” Nenhuma venda quitada é gravada.

TEF desligado ou configuração indisponível não transforma cartão em recebimento manual. O modo `MANUAL` sozinho também não autoriza forma que exige TEF: a flag explícita é obrigatória. `isConfirmacaoFiscalManualFlag` não foi alterada; o orquestrador deixou de usar esse atalho para essas formas.

Dinheiro e as demais formas que não exigem TEF continuam no caminho anterior. A duplicidade homologada (HTTP 200 com `TRANSACAO_DUPLICADA` quando a transação já está aprovada, HTTP 409 quando não está) não foi modificada.

## Testes

| Cenário | Resultado |
|---|---|
| B1 a B7 | Aprovados, inclusive rateio e duplicidade |
| E1 falha simultânea | Bloqueado |
| E2 POST direto de cartão | Rejeitado, fiscal e não fiscal |
| E3 TEF aprovado | Venda quitada vinculada à transação 6 |
| E4 manual explícito | Venda 9 quitada, sem `tef_transacao_id` e sem autorização real |
| E5 dinheiro | Venda 10 quitada no bucket não fiscal |
| E6 duplicidade | Transação 7 reaproveitada, HTTP 200, uma linha |
| E7 rateio | Total 9,50, `valor_fiscal` 9,50, corpo 999 ignorado |

## Evidência do bloqueio

E1: os dois GETs responderam 503, forma cartão, sem TEF e sem confirmação manual. `POST /api/vendas`: 0. `POST /api/tef/pagar`: 0. Vendas novas: 0. Carrinho: 1 item. `vendaEmProcessamento`: falso. Notificação: “Não foi possível confirmar a configuração ou a autorização do pagamento. A venda não foi enviada.”

E2: POST direto de cartão de crédito, sem transação aprovada e sem flag. Fiscal: HTTP 400. Não fiscal: HTTP 400. Vendas novas: 0. Quitadas novas: 0. Autorizações reais: 0. Erro: “Não foi possível confirmar a autorização do pagamento. A venda não foi registrada.”

## Fluxos preservados

- B1 e E3: mock aprovado, venda quitada, transação vinculada, `tefManager.autorizar` não chamado.
- E4: modo `MANUAL` gravado na configuração temporária e `confirmacao_fiscal_manual: true`, o mesmo campo que o modal existente grava. Venda quitada sem transação TEF. O clique no modal não foi executado; a Etapa C não foi aberta.
- E5: dinheiro com TEF desligado gravou venda quitada.
- B3 e E6: transação já aprovada reaproveitada. Duplicata aprovada em HTTP 200; a rota de duplicata sem aprovação segue em HTTP 409.
- B6 e E7: desconto 1 e acréscimo 0,50. Total 9,50. O Motor recalculou e ignorou `valor_fiscal: 999`.

## Isolamento

- Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-4mDavI\mercadao.db`
- O caminho não contém `ProgramData\MercantilFiscal`.
- `DB_DIR` foi definido antes de `backend/database.js`.
- TEF, adquirente, PIX e a gravação da venda usaram mock e SQLite temporário.
- `tefManager.autorizar`: **0** chamadas.
- `emitirPorVendaId`: **0** chamadas.
- Nenhuma NFC-e, NF-e ou consulta à SEFAZ.
- Nenhuma transação financeira real.
