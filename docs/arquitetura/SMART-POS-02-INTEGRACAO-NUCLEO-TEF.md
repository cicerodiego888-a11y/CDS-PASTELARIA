# SMART-POS-02 — Integração do simulador ao núcleo TEF

Nenhuma transação real foi executada. O banco oficial não foi aberto. A configuração oficial do provedor TEF não foi alterada. A Smart POS Itaú continua sem integração.

## 1. Arquitetura encontrada

`TefManager.autorizar` valida o fiscal, a análise de fraude, a chave de idempotência, a empresa e o operador. Só então chama `tefFactory.obterAdapter`, grava a linha em `tef_transacoes` com status `pendente` e entrega a solicitação ao adaptador. O retorno volta por `tefContrato` e `atualizarTransacao`.

`obterAdapter` lia a primeira linha de `tef_configuracao`. Não havia ramo que persistisse o simulador da SMART-POS-01: cada `obterAdapter` criava um adaptador novo, e a memória dele se perdia na consulta seguinte.

`consultar` pedia o estado ao adaptador. `cancelar` pedia o cancelamento e gravava o status devolvido. `acompanharPorCorrelacao` continua só leitura e não chama adaptador.

`PagamentoSequencial` reconhece `aprovado` com `transacao_id`, deixa `pendente` fora da soma e não inclui recusa, timeout nem falha. `comprovarTransacoesTefAprovadas` quitava qualquer linha `aprovado` da empresa e do operador, ainda sem venda. O vínculo da venda é o `UPDATE` de `VendaPagamentoService`, condicionado a `venda_id` nulo, empresa e operador.

O ambiente de teste já isola o banco com `DB_DIR` temporário, `CDS_TEST_ISOLATION` e `CDS_BLOQUEAR_BANCO_OFICIAL`. A configuração do provedor fica nesse banco, não no arquivo oficial.

## 2. Arquivos

Novos:

- `tests/tef/smart-pos-02.test.js`
- este relatório

Modificados:

- `backend/services/tef/tefFactory.js` — `smart_pos_simulador` só com os dois sinais de teste
- `backend/services/tef/TefManager.js` — grava timeout e falha simulados; repetição marca simulação; cancelamento de transação vinculada não apaga o status
- `backend/services/tef/adapters/SmartPosSimuladorAdapter.js` — consulta e cancelamento pelo id gravado em `tef_transacoes`
- `backend/services/tef/tefContrato.js` — a resposta leva `simulado: true` quando o retorno é de simulação
- `backend/services/OrquestradorPagamento.js` — comprovação recusa `provedor = smart_pos_simulador`

SiTef, PayGo, Stone, Cielo, Rede e Getnet não foram alterados. O SiTef de simulação continua `CliSiTef`.

## 3. Caminho percorrido

No teste, a primeira linha de `tef_configuracao` do banco temporário tem provedor `smart_pos_simulador`. Fora dos sinais de teste, a fábrica recusa esse provedor.

O caminho executado:

`iniciarPagamento` → `TefManager.autorizar` → `obterAdapter` → `SmartPosSimuladorAdapter.autorizarPagamento` → `tef_transacoes` → consulta pelo id → `PagamentoSequencial.classificarRetornoAutorizador` → `comprovarTransacoesTefAprovadas`

PIX, débito e crédito usam o mesmo caminho. O valor e a modalidade gravados são os que o núcleo recebeu. `aprovado`, NSU e autorização enviados na solicitação não entram na linha. O adquirente gravado é `SIMULADOR` e a resposta traz `simulado: true`.

## 4. Persistência

A linha nasce `pendente` e recebe o status do simulador. Aprovado fica `aprovado`. Recusa fica `negado`. Pendência fica `pendente`. Timeout fica `timeout`. Falha de comunicação fica `erro`, com uma única linha por chave. A consulta seguinte usa outro adaptador, sem a memória da autorização, e lê a linha. Um segundo processo Node, no mesmo banco temporário, consultou a mesma transação e devolveu `aprovado`, `simulado: true` e NSU nulo.

## 5. Idempotência, empresa e operador

A mesma chave devolve `TRANSACAO_DUPLICADA` e o mesmo `transacao_id`. A contagem da chave permanece 1. A mesma chave com outra empresa devolve `TEF_EMPRESA_DIVERGENTE`. A mesma chave com outro operador devolve `TEF_OPERADOR_DIVERGENTE`, sem o id da transação. A chave de uma transação cujo `venda_id` já está preenchido devolve `TEF_JA_VINCULADO`.

## 6. Vínculo com a venda

O fechamento não aceita a aprovação simulada. `comprovarTransacoesTefAprovadas` responde `SIMULACAO_NAO_E_RECEBIMENTO` e não copia a transação para a venda. Duas tentativas seguidas deixaram `vendas` em zero e `venda_id` nulo.

Recusa, pendência, timeout e falha também são recusados na comprovação. No pagamento sequencial, esses quatro estados deixam a soma em zero. Transação inexistente é recusada. Uma linha de teste com provedor `sitef` e `venda_id` já preenchido continua recusada como já vinculada a outra venda.

Cancelar uma pendente grava `cancelado`. Cancelar a aprovada que o teste marcou com `venda_id` responde `TRANSACAO_JA_VINCULADA` e preserva status `aprovado` e o vínculo.

A consulta pública de acompanhamento da chave continua sem NSU e sem autorização.

## 7. Resultados

Executados em sequência, com `node --test --test-concurrency=1`, cada um no próprio banco temporário.

| Suíte | Resultado |
|---|---|
| `tests/tef/smart-pos-02.test.js` | 8 de 8 |
| `tests/tef/smart-pos-01.test.js` | 10 de 10 |
| `tests/mobile-pdv/pdv-mobile-05.test.js` | 12 de 12 |
| `tests/pdv/sprint-21-verificacao-vinculo-tef.test.js` | 14 de 14 |

## 8. Classificação

- CONCLUÍDO: o simulador percorre o `TefManager`, persiste em `tef_transacoes` de teste e respeita idempotência, empresa, operador e a recusa de reutilização.
- TESTADO: as quatro suítes acima.
- HOMOLOGADO: autorização, persistência, consulta após outro processo, cancelamento, acompanhamento sem NSU e recusa do fechamento que trataria a simulação como recebimento.
- BLOQUEADO: quitar uma venda de teste com a aprovação simulada. O núcleo só vincula a transação aprovada quando a comprovação a aceita como recebimento. Aceitar a simulação nesse ponto a contabilizaria como dinheiro recebido. A proteção foi mantida.

O menor ajuste futuro, ainda não feito, é um recebimento de teste que grave o vínculo como simulação e não entre em `venda_pagamentos` nem no saldo financeiro. Isso depende de uma decisão explícita. Não é um atalho de aprovação.

O celular continua acompanhando a cobrança iniciada pela estação. Esta sprint não o faz comandar o equipamento.

## 9. Confirmação

Não houve adquirente, Smart POS física, NFC-e, NF-e nem evento à SEFAZ. O instalador não foi reconstruído. A licença não foi desligada. As regras de preço, composição e F×NF não foram alteradas.
