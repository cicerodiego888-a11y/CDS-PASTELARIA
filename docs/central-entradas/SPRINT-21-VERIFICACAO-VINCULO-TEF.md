# Sprint 21 — Verificação do vínculo da transação TEF

Auditoria somente leitura, depois da Etapa E. Nenhuma correção foi implementada. Etapa C não foi iniciada.

Data: 31/10/2026.

Suíte: `node --test --test-concurrency=1 tests/pdv/sprint-21-verificacao-vinculo-tef.test.js` — 9 testes, 9 execuções. O teste registra o comportamento atual. Vários desses comportamentos são falhas de vínculo.

## Arquivos e funções

- `backend/services/OrquestradorPagamento.js`
  - `buscarTransacaoTefPorId` — `SELECT id, status, nsu, autorizacao FROM tef_transacoes WHERE id = ?`
  - `comprovarTransacoesTefAprovadas` — exige `estaAprovado({ status })`. Se o pagamento não trouxer NSU ou autorização, copia os da linha. Não compara valor, tipo, empresa, `venda_id` nem NSU divergente.
  - `processarRecebimentoFiscal` — se todo recebimento que exige TEF tem `tef_transacao_id`, aceita o retorno dessa comprovação e não chama `tefManager.autorizar`.
  - `processarTEFFiscal` — o mesmo critério quando a autorização nova encontra um id já informado.
- `backend/services/vendas/VendaPagamentoService.js`
  - `criarVenda` grava `vendas.tef_transacao_id` com `resultadoFiscal.transacoes[0]`.
  - `vincularTransacoesTef` executa `UPDATE tef_transacoes SET venda_id = ? WHERE id = ?`, sem exigir `venda_id` nulo. Erro nesse update é só registrado no log; a venda segue.
  - `inserirPagamentosDaVenda` grava `venda_pagamentos` com o id, o NSU e a autorização enviados pelo cliente.
- `backend/services/tef/tefContrato.js` — `estaAprovado`.
- `backend/services/tef/TefManager.js` — `autorizar`: se a `idempotency_key` já existe, devolve a linha antes do adapter.
- `backend/rotas/tef.js` — `POST /pagar`: duplicata aprovada segue no HTTP 200; duplicata sem aprovação, no HTTP 409.
- Schema em `backend/database.js`: `tef_transacoes` não tem `empresa_id`. `venda_pagamentos.tef_transacao_id` e `venda_recebimentos.tef_transacao_id` não têm índice único. O único índice único de `tef_transacoes` é `idempotency_key`.

Não há contrato de pagamento parcial ligado ao valor da transação. O orquestrador não soma pagamentos contra `tef_transacoes.valor`.

## Como cada atributo é validado

| Atributo | O que o código faz |
|---|---|
| Status | Confere. Só status aprovado passa. |
| Empresa | Não confere. A tabela não tem `empresa_id`. A leitura não junta `vendas`. |
| Valor | Não confere. A coluna `valor` nem entra no `SELECT`. |
| Forma | Não confere. A coluna `tipo` nem entra no `SELECT`. |
| Vínculo com outra venda | Não confere. O `UPDATE` troca `venda_id` para a venda nova. |
| Dois pagamentos com o mesmo id | Não confere. Não há unicidade. |
| NSU e autorização | Não confere divergência. Valor enviado pelo cliente é gravado. Ausência é preenchida com o da linha. |
| Duplicidade por `idempotency_key` | Confere, no caminho já homologado, antes do adapter. |

## Cenários

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21v-gPiDBq\mercadao.db`. Operador autorizado nas empresas A e B. `emitir_fiscal` permaneceu falso. `tefManager.autorizar` sem `idempotency_key` foi bloqueado e não rodou. Chamadas bloqueadas: 0. Emissões: 0.

| Cenário | Resultado |
|---|---|
| Status `negado` | HTTP 400, “Transação TEF não encontrada ou não aprovada.” Nenhuma venda. |
| Transação compatível (crédito, R$ 10, NSU e autorização iguais, empresa A) | HTTP 200. Venda 1 quitada, `tef_transacao_id` 4, `tef_transacoes.venda_id` 1, NSU `NSU-OK`. |
| Transação da venda A usada na empresa B | HTTP 200 nas duas. Venda 2, empresa 1, quitada. Venda 3, empresa 2, quitada. As duas apontam para a transação 5. `tef_transacoes.venda_id` ficou 3, a da segunda venda. |
| Valor aprovado R$ 100 e pagamento R$ 10 | HTTP 200. Uma venda quitada. |
| Tipo `cartao_debito` e pagamento `cartao_credito` | HTTP 200. Uma venda quitada. |
| NSU `NSU-FALSO` e autorização `AUT-FALSA` contra a linha `NSU-REAL` / `AUT-REAL` | HTTP 200. `venda_pagamentos` gravou os identificadores falsos. |
| Mesma transação em duas vendas da empresa A | HTTP 200 e HTTP 200. Vendas 7 e 8. `venda_id` da transação ficou 8. Dois `venda_pagamentos` com o mesmo id. |
| Mesma transação em dois pagamentos de R$ 5 | HTTP 200. Venda 9. Dois `venda_pagamentos` com o mesmo id. |
| Duplicidade aprovada | Rota real. HTTP 200, `codigo: TRANSACAO_DUPLICADA`, `aprovado: true`, mesmo id. Nenhuma linha nova. |
| Duplicidade não aprovada (`pendente`) | Rota real. HTTP 409, `codigo: TRANSACAO_DUPLICADA`, `aprovado: false`, mesmo id. Nenhuma linha nova. |

A primeira tentativa de vender na empresa B, com estoque nas duas, parou no seletor de empresa e no caixa (`CAIXA_INCOMPATIVEL`), antes do vínculo TEF. Para isolar o vínculo, o saldo fiscal da empresa A foi zerado só nessa chamada, o seletor escolheu a empresa B e a venda foi gravada. O estoque da A foi restaurado em seguida. Essa recusa não é uma checagem de empresa da transação TEF.

## Vulnerabilidades

1. **Empresa.** Causa: `tef_transacoes` não tem `empresa_id`, e `comprovarTransacoesTefAprovadas` não lê a empresa da venda já vinculada. Evidência: transação 5 quitou a venda 2 (empresa 1) e a venda 3 (empresa 2).
2. **Valor.** Causa: o `SELECT` não traz `valor`. Evidência: transação de 100 quitou pagamento de 10.
3. **Forma.** Causa: o `SELECT` não traz `tipo`. Evidência: transação `cartao_debito` quitou pagamento `cartao_credito`.
4. **Reuso em outra venda.** Causa: `vincularTransacoesTef` sobrescreve `venda_id` e ignora falha. Evidência: vendas 7 e 8 quitadas com o mesmo id; a transação passou a apontar só para a 8.
5. **Reuso em dois pagamentos.** Causa: não há unicidade em `venda_pagamentos.tef_transacao_id`. Evidência: venda 9 com dois pagamentos no mesmo id.
6. **NSU e autorização.** Causa: divergência não é rejeitada; o valor do cliente é persistido. Evidência: `NSU-FALSO` e `AUT-FALSA` gravados no pagamento.

O status aprovado e a duplicidade por `idempotency_key` estão íntegros.

## Proposta mínima — não implementada

Em `comprovarTransacoesTefAprovadas`, passar a ler `valor`, `tipo`, `venda_id`, `nsu` e `autorizacao` e recusar quando:

- o status não estiver aprovado;
- o valor da linha não fechar com o valor do pagamento, na tolerância de centavos já usada no orquestrador;
- o mesmo id aparecer em mais de um pagamento, porque não existe contrato de rateio de uma transação;
- `normalizarTipoTef` da forma não for o `tipo` da linha;
- o cliente enviar NSU ou autorização diferente da linha;
- `venda_id` já estiver preenchido, ou já existir `venda_pagamentos` com esse id.

`vincularTransacoesTef` só deve atualizar `venda_id` quando ele estiver nulo, e a falha desse update deve impedir a venda.

Empresa: sem coluna, uma transação ainda sem `venda_id` não tem empresa para conferir. O mínimo sem migração cobre só a transação já ligada a uma venda, comparando `vendas.empresa_id`. Impedir o uso cruzado de uma transação nova exige gravar `empresa_id` na criação da linha TEF. Isso é mudança de schema e não foi feito.

## Isolamento

- Nenhum arquivo de produção foi alterado.
- Arquivo novo de teste: `tests/pdv/sprint-21-verificacao-vinculo-tef.test.js`.
- Banco temporário, fora de `ProgramData\MercantilFiscal`.
- Transações inseridas direto em `tef_transacoes`, com provedor `AUDITORIA`.
- A duplicidade chamou o `TefManager.autorizar` real. A chave já existia, então o retorno ocorreu antes do adapter. Nenhuma linha nova foi criada.
- Nenhuma autorização de adquirente, TEF real, PIX ou pagamento externo.
- Nenhuma NFC-e, NF-e ou consulta à SEFAZ.
