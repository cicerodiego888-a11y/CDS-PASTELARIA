# Sprint 21F — Integridade e uso único das transações TEF

Correção das falhas da auditoria `SPRINT-21-VERIFICACAO-VINCULO-TEF.md`. Uma transação TEF aprovada só quita a venda quando a empresa, o valor, a forma, o NSU e a autorização conferem com a linha persistida, e quando o vínculo ainda está livre. A reivindicação do `venda_id` ocorre dentro da mesma transação SQLite da venda.

Etapas C e D não foram iniciadas. O banco oficial não foi migrado nesta sprint.

Data: 31/10/2026.

## Diagnóstico e causa

A comprovação anterior lia só o status. `tef_transacoes` não tinha `empresa_id`. Valor, tipo, NSU e autorização enviados pelo cliente não eram confrontados com a linha. `vincularTransacoesTef` executava `UPDATE tef_transacoes SET venda_id = ? WHERE id = ?` e, se falhasse, apenas registrava o erro. A venda seguia quitada. Não havia restrição única em `venda_pagamentos.tef_transacao_id`. Duas requisições podiam gravar a mesma autorização em vendas diferentes.

## Arquivos alterados

- `backend/database.js`
- `backend/services/tef/tefRepository.js`
- `backend/services/tef/TefManager.js`
- `backend/rotas/tef.js`
- `backend/services/OrquestradorPagamento.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `backend/services/entrega/MotorFinalizacaoVenda.js`
- `tests/pdv/sprint-21-verificacao-vinculo-tef.test.js`
- `tests/pdv/sprint-21-etapa-b-automatico.test.js`

Não foram alterados `frontend/pdv/js/pdv.js`, o Motor F×NF, o rateio, o desconto, o acréscimo nem `isConfirmacaoFiscalManualFlag`.

## Migration e registros históricos

`CREATE TABLE tef_transacoes` passa a incluir `empresa_id INTEGER`. Bancos já existentes recebem `ALTER TABLE tef_transacoes ADD COLUMN empresa_id INTEGER` em `aplicarAlteracoesPosCriacao`.

A empresa gravada na criação vem do contexto autenticado. `POST /api/tef/pagar` exige token. Se o header `X-Empresa-Id` estiver presente, a empresa só é aceita depois de `exigirEmpresaAutorizada`. Sem header, a empresa é a do único caixa aberto do operador autenticado. `empresa_id` do corpo é ignorado. Sem header e sem um único caixa aberto, a rota responde HTTP 400 com `TEF_EMPRESA_AUSENTE`, antes do adapter.

Registros antigos permanecem com `empresa_id` nulo. Nenhuma empresa é atribuída por suposição nem pelo usuário da requisição. Na comprovação, linha sem empresa é recusada para fechamento novo. O histórico não é apagado nem reescrito.

O índice `idx_venda_pagamentos_tef_transacao_unica` é único e parcial (`WHERE tef_transacao_id IS NOT NULL`). Antes de criá-lo, a inicialização procura `tef_transacao_id` repetido. Se houver duplicidade histórica, o índice não é criado e o motivo fica no log. Nesta sprint o índice foi criado só nos bancos temporários, que não tinham repetição. A proteção que decide a venda é o `UPDATE` condicional, não apenas o índice.

A alteração de schema está no caminho de inicialização do sistema. Ela não foi executada em `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.

## Regras de validação

`comprovarTransacoesTefAprovadas` lê `id`, `status`, `valor`, `tipo`, `nsu`, `autorizacao`, `venda_id` e `empresa_id`. A conferência usa o pagamento comercial inteiro, antes do MIDP, com a empresa efetiva da venda.

1. A transação existe e o id é inteiro positivo.
2. O status passa em `tefContrato.estaAprovado`.
3. O valor aprovado e o valor do pagamento coincidem com a tolerância já usada no orquestrador: diferença absoluta de no máximo 0,009 depois de `arredondarCentavos`.
4. `normalizarTipoTef` da forma e do tipo da linha são iguais.
5. NSU ou autorização enviados pelo cliente, quando presentes, são idênticos aos persistidos. Divergência rejeita a venda.
6. A gravação de `venda_pagamentos` e da prestação de entrega relê NSU e autorização da linha, na mesma conexão da venda.
7. `venda_id` da linha precisa estar nulo.
8. O mesmo id não pode aparecer em dois pagamentos da operação.

Não há contrato de pagamento parcial. Uma autorização quita um pagamento pelo valor integral.

O ramo em que todos os recebimentos fiscais já têm id não repete a comparação de valor sobre a fatia do MIDP. A reivindicação atômica continua sendo a barreira de uso único. O caminho que ainda autoriza no adquirente envia `empresa_id` da venda.

## Uso único e concorrência

`vincularTransacoesTef` executa, na conexão exclusiva da venda:

```sql
UPDATE tef_transacoes
SET venda_id = ?, atualizado_em = datetime('now')
WHERE id = ? AND venda_id IS NULL AND empresa_id = ?
```

O resultado precisa ter `changes = 1`. Zero linhas gera HTTP 409, código `TEF_VINCULO_RECUSADO`, e a exceção desfaz a venda. A mesma condição vale na prestação de entrega, dentro do `BEGIN IMMEDIATE` já existente.

A consulta prévia não é a garantia final. `executarTransacaoVendaExclusiva` abre conexão exclusiva, faz `BEGIN IMMEDIATE` e só então grava venda, recebimentos, vínculo, itens e pagamentos. `PRAGMA busy_timeout` dessa conexão permanece 30000. Duas requisições serializam no banco. A segunda encontra `venda_id` preenchido e não conclui.

## Rollback

Falha na vinculação, na leitura da linha ou no índice único acontece antes do `COMMIT`. `executarTransacaoVendaExclusiva` executa `ROLLBACK` e relança o erro. `criarVenda` devolve o erro e não responde sucesso. Não permanece venda quitada, pagamento ou `venda_id` preenchido.

O gancho `CDS_TEF_VINCULO_FALHA=1` lança a falha dentro de `vincularTransacoesTef`, antes do `UPDATE`, só quando o teste liga a variável. Fora disso ela não existe.

## Idempotência

Chave já existente e aprovada continua em HTTP 200, `TRANSACAO_DUPLICADA`, `aprovado: true`, o mesmo id, sem linha nova e sem chamada ao adapter. Chave existente sem aprovação continua em HTTP 409, `aprovado: false`, o mesmo id. A consulta da chave ocorre antes da exigência de empresa da autorização nova e antes de `obterAdapter`.

Se a linha já tem empresa e o pedido resolvido é de outra empresa, a resposta é `TEF_EMPRESA_DIVERGENTE`, sem adapter e sem autorização nova. Repetição da mesma empresa mantém 200 ou 409. Linha histórica sem empresa ainda devolve a duplicata; o fechamento da venda é que a recusa. A idempotência não libera a mesma transação em outra venda: o `venda_id` nulo continua obrigatório na comprovação e no `UPDATE`.

## Cenários

Suíte dirigida: `node --test --test-concurrency=1 tests/pdv/sprint-21-verificacao-vinculo-tef.test.js`.

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21v-PLe6BQ\mercadao.db`.

14 testes, 14 aprovações. `autorizacoesBloqueadas`: 0. `emissoesFiscais`: 0.

| Cenário | Resultado |
|---|---|
| F1 — empresa, valor, forma, NSU e autorização compatíveis | HTTP 200. Venda 1 quitada. `venda_id` da transação = 1. NSU gravado `NSU-OK`. |
| F2 — transação da empresa A na venda da empresa B | HTTP 400. `Transação TEF pertence a outra empresa.` Nenhuma venda B. Vínculo original na venda A preservado. |
| F3 — transação sem `empresa_id` | HTTP 400. `Transação TEF sem vínculo empresarial não pode quitar a venda.` Nenhuma venda nova. |
| F4 — R$ 100 contra pagamento de R$ 10 | HTTP 400. `Valor da transação TEF não confere com o pagamento.` |
| F5 — débito contra crédito | HTTP 400. `Forma de pagamento incompatível com a transação TEF.` |
| F6 — NSU e autorização diferentes dos persistidos | HTTP 400. `NSU informado não confere com a transação TEF.` Nenhum identificador falso gravado. |
| F7 — reutilização em outra venda | HTTP 400. `Transação TEF já vinculada a outra venda.` `venda_id` original e um único pagamento preservados. |
| F8 — o mesmo id em dois pagamentos | HTTP 400. `A mesma transação TEF não pode quitar mais de um pagamento.` Nenhuma venda e nenhum pagamento. |
| F9 — duas requisições simultâneas | HTTP 200 e HTTP 409. Uma venda quitada. A outra rejeitada. |
| F10 — falha controlada na vinculação | HTTP 409. Nenhuma venda nova, nenhum pagamento, `venda_id` nulo. |
| F11 — duplicidade aprovada | HTTP 200, `TRANSACAO_DUPLICADA`, mesmo id, sem linha nova. |
| F12 — duplicidade não aprovada | HTTP 409, `TRANSACAO_DUPLICADA`, `aprovado: false`, mesmo id, sem linha nova. |
| F13 — regressão da Etapa E | POST direto sem autorização: HTTP 400, a mensagem da Etapa E, nenhuma venda. Confirmação manual explícita com modo `MANUAL`: HTTP 200. A falha simultânea dos dois GETs foi reexecutada na suíte da Etapa B (E1): a venda não foi enviada, o carrinho permaneceu e não houve POST de venda nem de TEF. |
| F14 — regressão do Motor F×NF | Item de R$ 10, desconto 1 e acréscimo 0,50. Total 9,50, `valor_fiscal` 9,50. O corpo com `valor_fiscal` 999 foi ignorado. O motor não foi alterado. |

Regressão da homologação anterior: `node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-b-automatico.test.js`.

Banco: `C:\Users\cicer\AppData\Local\Temp\cds-sprint21b-s9btKp\mercadao.db`.

14 testes, 14 aprovações. `autorizacoesReais`: 0. `emissoesFiscais`: 0. B1–B7 e E1–E7 aprovados. B6 e E7 mantiveram total 9,50 e `valor_fiscal` 9,50. O mock de inserção passou a gravar `empresa_id`. A segunda gravação dos cenários de sabotagem e de empresa usa transação nova, porque a primeira já consome o vínculo.

## Preservação e limites

A idempotência homologada permanece: 200 para duplicata aprovada e 409 para duplicata sem aprovação, ambas antes do adapter.

Não houve transação financeira real, conexão com adquirente, TEF real, PIX real, emissão de NFC-e/NF-e nem evento à SEFAZ. O emissor fiscal dos testes permanece bloqueado. `autorizar` sem `idempotency_key` permanece bloqueado nos testes de vínculo.

A interface do PDV não recebeu header novo. Sem `X-Empresa-Id`, a criação da transação usa o único caixa aberto do usuário autenticado. O PDV de balcão envia o token do operador que abriu esse caixa.

A sprint para aqui, para avaliação do Tech Lead.
