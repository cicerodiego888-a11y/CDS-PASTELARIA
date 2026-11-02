# SMART-POS-01 — Contrato e simulador de pagamentos

A Smart POS Itaú não está integrada. Esta sprint deixa um contrato independente de fabricante e um adaptador só de teste. A comunicação com um equipamento real continua dependendo do modelo e da documentação, SDK ou protocolo autorizado pelo fabricante.

## 1. Arquitetura TEF encontrada

O núcleo escolhe o adaptador em `tefFactory.obterAdapter`. A escolha lê o provedor da configuração principal e instancia SiTef, PayGo, Stone, Cielo, Rede ou Getnet. Provedor desconhecido continua sendo recusado. Esses adaptadores existentes não foram tratados como integração operacional.

`BaseAdapter` define `autorizarPagamento`, `consultarTransacao`, `cancelarPagamento`, reimpressão, diagnóstico, teste de conexão e status. `TefManager.autorizar` valida empresa, operador, idempotência e vínculo com venda antes de chamar o adaptador. A mesma chave de outro operador devolve `TEF_OPERADOR_DIVERGENTE`. A mesma chave de outra empresa devolve `TEF_EMPRESA_DIVERGENTE`. Transação com `venda_id` devolve `TEF_JA_VINCULADO`.

O status gravado pelo CDS é `aprovado`, `negado`, `pendente`, `cancelado` e `erro`. O acompanhamento também preserva `timeout` e `falha_comunicacao`. `PagamentoSequencial` só soma parcela eletrônica aprovada com `transacao_id`. Pendente entra na lista e não conta. Recusa, timeout e falha não entram.

`GET /api/tef/acompanhamento` só lê a cobrança já gravada pela estação. A resposta pública omite NSU e autorização. O celular sem `electronAPI` não chama `POST /api/tef/pagar`: devolve `TEF_ESTACAO` e espera a consulta da estação.

`SimulatedGatewayAdapter` e `simulacaoControlada` simulam gateway por `resultado_simulado`. Não são contrato de Smart POS e não foram estendidos.

## 2. Contratos e arquivos reutilizados

- `backend/services/tef/tefContrato.js` — formato de autorização, consulta, cancelamento e acompanhamento público
- `backend/services/tef/adapters/BaseAdapter.js` — métodos que o simulador implementa
- `backend/services/tef/tefFactory.js` — seleção por provedor
- `backend/services/tef/tefFluxoPagamento.js` — PIX, débito e crédito já normalizados
- `frontend/pdv/js/pagamentoSequencial.js` — consumo do retorno aprovado, recusado, pendente, timeout e falha
- `TefManager`, `tefRepository`, `VendaPagamentoService` e `comprovarTransacoesTefAprovadas` — empresa, operador, idempotência e vínculo único com venda

Nenhuma regra comercial, fiscal ou de composição F×NF foi alterada.

## 3. Arquivos novos e modificados

Novos:

- `backend/services/tef/smartPosContrato.js`
- `backend/services/tef/adapters/SmartPosSimuladorAdapter.js`
- `tests/tef/smart-pos-01.test.js`
- este relatório

Modificados:

- `backend/services/tef/tefFactory.js` — ramo `smart_pos_simulador` e `criarAdapter`
- `frontend/mobile-pdv/index.html` — texto de que simulação não é recebimento
- `frontend/mobile-pdv/mobile-pdv.js` — `textoSmartPosSimulado`

SiTef, PayGo, Stone, Cielo, Rede, Getnet e o acompanhamento pela estação permanecem.

## 4. Contrato independente

O contrato não cita marca, modelo, SDK nem protocolo. A solicitação aceita só o que o núcleo já validou: modalidade, valor, `empresa_id`, `operador_id` e chave de idempotência. Modalidade fora de PIX, débito ou crédito, valor inválido, empresa ausente ou operador ausente são recusados. Um campo `aprovado` ou NSU enviado junto com a solicitação é ignorado.

Operações:

| Operação | Método do adaptador |
|---|---|
| Iniciar pagamento | `autorizarPagamento` |
| Consultar pagamento | `consultarTransacao` |
| Cancelar pagamento | `cancelarPagamento` |
| Identificar terminal | `identificarTerminal` |
| Identificar modalidade | `normalizarModalidade` |
| Receber resultado | resposta de `tefContrato` mais `payloadRetorno.estado` |
| Falha de comunicação | erro com código `FALHA_COMUNICACAO`, sem gravar aprovação |

`identificarTerminal` devolve o identificador configurado, `simulado: true`, e fabricante, modelo e protocolo nulos.

`podeContabilizarComoRecebimentoReal` só é verdadeiro para status `aprovado` com `transacao_id` quando o retorno não está marcado como simulação. O formato aprovado do simulador é compatível com `PagamentoSequencial`, e continua identificado como simulado.

## 5. Adaptador simulado

`SmartPosSimuladorAdapter` usa o mesmo contrato. O nome é `smart_pos_simulador` e o modo é `simulacao`. A fábrica só o instancia quando o provedor informado é exatamente esse. Não é o provedor padrão e não foi gravado na configuração oficial.

O resultado vem de `resultado_simulado`. Sem esse campo, o adaptador responde `RESULTADO_SIMULADO_AUSENTE` e não aprova. A memória do adaptador guarda a solicitação. A mesma chave devolve o mesmo registro. Outra empresa ou outro operador na mesma chave é recusado, sem NSU. Consulta de id inexistente devolve `TRANSACAO_INEXISTENTE`. `vincularVenda` marca o vínculo de teste; a repetição e o cancelamento passam a responder `TRANSACAO_JA_VINCULADA`.

Não há adquirente, terminal físico, SDK externo nem serviço financeiro. O adquirente da resposta é o texto `SIMULADOR`.

## 6. Estados e transições

| Estado do contrato | Status TEF já usado pelo CDS | Conta como recebido |
|---|---|---|
| `solicitada` | `pendente` | não |
| `aguardando_terminal` | `pendente` | não |
| `processando` | `pendente` | não |
| `aprovada` | `aprovado` | só fora de simulação |
| `recusada` | `negado` | não |
| `cancelada` | `cancelado` | não |
| `timeout` | `timeout` | não |
| `falha` | `erro` | não |

Timeout e falha interrompem antes de criar o registro simulado. Cancelamento muda o registro para `cancelada`. Repetir a chave não cria outra cobrança. Aprovar de novo uma transação já vinculada não cria outra cobrança e não a devolve como recebida.

## 7. Resultados dos testes

Executados em sequência, com `node --test --test-concurrency=1`, em banco temporário. O banco oficial não foi aberto.

`tests/tef/smart-pos-01.test.js`: 10 testes, 10 aprovações.

Cobertos: PIX, débito e crédito; solicitada, aguardando terminal, processando, aprovada, recusada, cancelada, timeout e falha; formato aprovado no pagamento sequencial; recusa fora da soma; idempotência; consulta repetida; consulta inexistente; isolamento de empresa e de operador; reutilização de transação vinculada; omissão de NSU na resposta pública; celular sem pinpad continua em `TEF_ESTACAO`; texto de simulação.

`tests/mobile-pdv/pdv-mobile-05.test.js`: 12 testes, 12 aprovações. O acompanhamento iniciado pela estação, o operador, a empresa e o fechamento continuam como estavam.

## 8. Limitações ainda existentes

O simulador vive na memória do processo de teste. Ele não grava `tef_transacoes` e não passa pelo `TefManager` enquanto a configuração principal não apontar o provedor de teste. Essa configuração não foi alterada.

O celular continua sem iniciar cobrança no equipamento. PIX, débito e crédito na tela seguem a confirmação da estação. A frase nova só avisa que uma resposta simulada não é recebimento real.

Não houve homologação visual no aparelho. Não houve transação financeira. Não houve NFC-e, NF-e nem evento à SEFAZ.

## 9. O que falta para o equipamento real

- modelo da Smart POS e o meio pelo qual o celular chega até ela
- documentação técnica, SDK ou protocolo autorizado pelo fabricante
- identificador do terminal, credenciais e ambiente de homologação fornecidos pelo fabricante
- tabela oficial dos retornos desse protocolo, para mapeá-los nos estados deste contrato
- prova de que a repetição da solicitação não gera segunda cobrança no equipamento

Enquanto isso não existir, o provedor `smart_pos_simulador` permanece restrito a teste. Um nome de fabricante na configuração continua sendo provedor não suportado.
