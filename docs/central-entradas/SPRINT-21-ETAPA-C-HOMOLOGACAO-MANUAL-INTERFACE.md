# Sprint 21C — Homologação do fluxo manual pela interface do PDV

O fechamento manual foi exercitado pelo código real de `frontend/pdv/js/pdv.js`. O operador só conclui a venda depois do clique em `#confirmar-recebimento-fiscal-manual`. Abrir o modal, ou cancelá-lo, não grava venda.

A Sprint 21D não foi iniciada. Nenhuma regra das Sprints 21A, 21B, 21E ou 21F foi alterada.

Data: 31/10/2026.

## Arquivos inspecionados

- `frontend/pdv/js/pdv.js` — `abrirModalConfirmacaoFiscalManual`, `confirmarRecebimentoFiscalManual`, `processarVendaFiscalManual`, `executarFinalizacaoVenda`
- `frontend/shared/js/tefFluxoPagamento.js` e `backend/services/tef/tefFluxoPagamento.js`
- `backend/services/OrquestradorPagamento.js`
- `backend/rotas/configuracoes_avancadas.js`
- `tests/tef/tef-fluxo-pagamento.test.js`
- `tests/pdv/sprint-21-etapa-b-automatico.test.js`

## Arquivos alterados

- `tests/pdv/sprint-21-etapa-c-manual-interface.test.js`
- `docs/central-entradas/SPRINT-21-ETAPA-C-HOMOLOGACAO-MANUAL-INTERFACE.md`

Não houve alteração de produção. O Motor F×NF, a autorização TEF, o vínculo único da transação, a empresa, o valor, a forma, o NSU e a confirmação explícita do backend permanecem como estavam.

## Contrato do fluxo manual

O seletor já homologado escolhe o modal quando o modo persistido é `MANUAL`, o valor fiscal é maior que zero e o TEF automático não entra. Com TEF habilitado, cartão em modo `MANUAL` continua no fluxo automático. Esse contrato está em `tests/tef/tef-fluxo-pagamento.test.js` e não foi modificado.

A homologação da interface usou modo `MANUAL` com TEF desligado, que é o caminho em que o modal é o fechamento. O clique de confirmar é o handler registrado por `pdv.js` no botão `#confirmar-recebimento-fiscal-manual`. O cancelar segue o `data-bs-dismiss="modal"`, que dispara `hidden.bs.modal` com a confirmação ainda falsa.

## Cenários

Suíte da interface: `node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-c-manual-interface.test.js`.

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21c-YSC2Dx\mercadao.db`.

7 testes, 7 aprovações, 0 reprovações. Autorizações reais: 0. Emissões fiscais: 0. O único pagamento TEF foi o mock do C7.

| Cenário | Resultado |
|---|---|
| C1 — abertura do modal | Modo lido: `MANUAL`. Modal `#confirmacaoFiscalManualModal` aberto, com o botão `#confirmar-recebimento-fiscal-manual`. Nenhum `POST /api/vendas` e nenhuma venda nova enquanto o modal estava aberto. |
| C2 — confirmação explícita | Um `POST /api/vendas`. Corpo com `confirmacao_fiscal_manual: true`. Header `X-Empresa-Id: 1`, igual à empresa gravada. Venda quitada, total 10, `valor_fiscal` 10, `valor_nao_fiscal` 0, sem `tef_transacao_id`. Uma notificação de sucesso. Carrinho esvaziado uma vez. |
| C3 — cancelamento | Dois aberturas do modal, dois cancelamentos. Nenhum POST, nenhuma venda, nenhum recebimento novo. Carrinho com 1 item. `vendaEmProcessamento` falso. A segunda tentativa reabriu o modal. |
| C4 — sem clique | Com o modal aberto, nenhum corpo continha `confirmacao_fiscal_manual: true`. `POST /api/vendas` direto, sem o indicador: HTTP 400, `Não foi possível confirmar a autorização do pagamento. A venda não foi registrada.` Nenhuma venda nova. |
| C5 — modo diferente de `MANUAL` | Interface em modo `TEF` e TEF desligado: modal não abriu, nenhum POST, notificação da Etapa E, carrinho preservado. `POST` direto com `confirmacao_fiscal_manual: true`: HTTP 400, a mesma recusa, nenhuma venda. |
| C6 — dinheiro | Modo `TEF`. Modal não abriu. Um POST sem o indicador manual. Venda em dinheiro quitada. Uma conclusão na interface. |
| C7 — fluxo automático | Modo `TEF`, mock de TEF. Modal não abriu. `POST /api/tef/pagar` antes de `POST /api/vendas`. Venda quitada com o `tef_transacao_id` do mock. Autorização real: 0. |

Regressão da suíte já existente: `node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-b-automatico.test.js`.

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-Fd5p4y\mercadao.db`.

14 testes, 14 aprovações, 0 reprovações. Autorizações reais: 0. Emissões fiscais: 0. B1–B7 e E1–E7 permaneceram aprovados.

## Requisições

C2, interface, depois do clique:

- `POST /api/vendas`
- Header `X-Empresa-Id` da empresa A
- `confirmacao_fiscal_manual: true`
- Pagamento de cartão de crédito, valor 10, sem transação TEF
- Resultado: venda quitada, fiscal 10, não fiscal 0

C4, corpo direto sem o indicador, modo `MANUAL`: HTTP 400.

C5, corpo direto com o indicador, modo `TEF`: HTTP 400.

C7: `POST /api/tef/pagar` no mock, em seguida `POST /api/vendas` com o id retornado. Sem `confirmacao_fiscal_manual`.

## Cancelamento

No C3, os dois fechamentos do modal ocorreram antes de qualquer `POST /api/vendas`. A contagem de vendas e de `venda_recebimentos` não mudou. O carrinho continuou com o item e o operador reabriu o modal na tentativa seguinte.

## Pendências

Dinheiro com a configuração persistida em `MANUAL` continua abrindo o modal de recebimento fiscal. É o contrato do teste unitário `TEF habilitado + modo MANUAL + dinheiro → manual (sem TEF)`. O fluxo normal de dinheiro, em modo `TEF`, não abre esse modal. A regra não foi alterada.

Com TEF habilitado, cartão em modo `MANUAL` permanece no fluxo automático. Também é contrato unitário anterior. A interface manual homologada nesta sprint é a de TEF desligado e modo `MANUAL`.

## Confirmação operacional

Não houve transação financeira real, adquirente, PIX, crédito ou débito reais, emissão de NFC-e/NF-e nem evento à SEFAZ. O banco oficial não foi usado nem migrado. Configuração e dados do cliente não foram alterados.
