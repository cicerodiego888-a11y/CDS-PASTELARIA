# Complemento da auditoria — Sprint 23 — cenário R$ 50,00

Cenário obrigatório: débito R$ 20,00 autorizado, crédito R$ 20,00 autorizado sem reautorizar o débito, dinheiro R$ 10,00, total R$ 50,00 quitado. A referência fiscal de R$ 40,00 deve ser avaliada e não pode ser forçada.

Data: 31/10/2026.

Somente leitura. Nenhum código de produção foi alterado. Banco oficial não foi aberto. Não houve TEF real, PIX real, NFC-e, NF-e nem evento à SEFAZ. `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece `false`.

## Resultado financeiro do caminho testado

No fechamento não fiscal com autorizador simulado, as três parcelas permanecem e o total permanece R$ 50,00.

| Parcela | Valor | Autorização | Gravado |
| --- | --- | --- | --- |
| Débito | R$ 20,00 | transação simulada, NSU e autorização da linha TEF | sim |
| Crédito | R$ 20,00 | transação simulada, distinta da do débito | sim |
| Dinheiro | R$ 10,00 | sem NSU e sem autorização inventados | sim |
| Total | R$ 50,00 | quitado no teste de persistência | sim |

O valor fiscal gravado nessa venda não foi R$ 40,00. O distribuidor oficial, com saldo não fiscal, devolveu fiscal R$ 0,00 e não fiscal R$ 50,00. A soma continua R$ 50,00.

## A. O motor de composição no fluxo real do PDV — PARCIAL

O PDV chama a validação sequencial, não o motor que avalia o candidato de R$ 40,00.

Quando a lista tem dinheiro e a soma fecha o total, `abrirPagamentoMisto` envia `POST /api/vendas/composicao-sequencial`. A rota chama `avaliarPagamentosSequenciais`. O fechamento repete essa função se `pagamento_sequencial` é verdadeiro.

`avaliarPagamentosSequenciais` chama `prepararContratoRecomposicaoFiscal` e `calcularMargemToleranciaDinheiro`. Não chama `avaliarCandidatosComMotorComposicao` nem `simularComposicao`. `VendaPagamentoService` também não importa esse motor.

Sonda em memória, sem banco, com as três parcelas:

- total comercial R$ 50,00
- total financeiro R$ 50,00
- parcelas 20, 20 e 10
- `valor_fiscal_candidato`: null
- `valor_fiscal_presumido`: false
- `aplica_ao_fluxo_oficial`: false
- produção: false
- margem do dinheiro: R$ 2,00
- `nao_e_desconto`: true

O contrato isolado documenta `valor_fiscal_candidato: 40` como entrada típica. O fluxo do PDV não envia esse 40. A função sequencial grava o candidato como null.

O motor isolado `avaliarCandidatosComMotorComposicao`, chamado só nesta sonda e com o candidato 40 informado à mão, devolve `persistiu: false`, `aplica_ao_fluxo_oficial: false`, `altera_vendas_total: false`, `distribuicao_possivel: false` e código `COMPOSICAO_AUSENTE_NO_MOTOR`. Ele não entra no PDV.

Classe do requisito “acionar o motor e avaliar R$ 40,00”: **NÃO IMPLEMENTADO** no fluxo real. A validação da soma e da margem está **CONCLUÍDA**.

## B. Composição fiscal persistida à parte — NÃO IMPLEMENTADO

`POST /api/vendas/composicao-sequencial` responde e não grava. Não há registro separado do candidato, da margem nem da avaliação do motor. O fechamento grava `vendas.valor_fiscal` e `vendas.valor_nao_fiscal` com o resultado do distribuidor oficial. Isso não é a composição de referência.

## C. Três parcelas persistidas — CONCLUÍDO no caminho não fiscal testado

`inserirPagamentosDaVenda` grava uma linha por parcela. O teste 12 da suíte da Sprint 23, com TEF simulado, gravou três linhas, manteve os dois `tef_transacao_id` e o dinheiro de R$ 10,00. A segunda tentativa com as mesmas transações foi recusada. Nenhum NSU foi inventado para o dinheiro.

**COM DEFEITO** se o TEF está ligado e o valor fiscal da venda é maior que zero. `executarFinalizacaoVenda` entra em `deveUsarTefAutomatico && totalFiscal > 0` antes do ramo misto, autoriza um único valor e substitui a lista. Esse ramo não é o do teste de R$ 50,00 não fiscal.

## D. Consulta posterior — PARCIAL

`GET /api/vendas/:id` devolve as três linhas de `venda_pagamentos`: forma, valor, transação, NSU e autorização. Não devolve a composição fiscal de referência, porque ela não foi gravada. O histórico do PDV também não mostra modalidade, operador nem horário.

## E. Distribuidor oficial F×NF — CONCLUÍDO

O fechamento chama `distribuirItensVendaComValorFiscalEfetivo`. No cenário não fiscal do teste, fiscal e não fiscal somam R$ 50,00 e o fiscal não é 40. `encaminharPropostaValidadaAoDistribuidorOficial` sem a autorização interna retorna `AUTORIZACAO_AUSENTE`, `distribuicao_aplicada: false` e `producao_habilitada: false`. A margem não vira desconto. O distribuidor oficial não foi alterado. A flag de produção permanece falsa.

## F. Proteções da Sprint 24 — PARCIAL

Com TEF ligado e venda não fiscal, parcela já aprovada não é autorizada de novo. O teste percorreu débito, depois crédito, e a segunda chamada não reenviou o débito.

Com TEF desligado, o PDV real inclui débito e crédito como parcelas informadas, sem transação. A Sprint 24 confirma essa lista no modal manual e não inventa NSU. Esse caminho não cumpre o requisito de autorização simulada deste cenário.

A função `marcarParcelaConfirmacaoManual` preserva a parcela que já tem `tef_transacao_id`. Não cria identificador fictício.

## G. O que impede a homologação deste cenário

1. O fluxo real não avalia o candidato fiscal de R$ 40,00. A referência fica null.
2. A composição não é persistida e a consulta não a recupera.
3. O modal sequencial não foi aberto no PDV. A evidência é de teste, não de tela.
4. Com TEF ligado e valor fiscal positivo, a lista sequencial é substituída.
5. Com TEF desligado, débito e crédito não recebem autorização simulada.

## Teste

Suíte já executada nesta auditoria, um arquivo, banco temporário:

`node --test --test-concurrency=1 tests/pdv/sprint-23-pagamento-sequencial-recomposicao.test.js`

**5/5.** Banco `C:\Users\cicer\AppData\Local\Temp\cds-sprint23-fREeRU\mercadao.db`. Autorizações reais: 0. Emissões fiscais: 0.

Os casos 1, 4 a 6 e 12 e 13 são este cenário. A sonda em memória do candidato 40 não grava venda e não usa banco.

A frente não está homologada.

Aguardando avaliação do Tech Lead.
