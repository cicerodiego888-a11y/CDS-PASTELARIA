# MESAS-02 — Núcleo de atendimento e ocupação das mesas

O atendimento de salão ficou em `mesa_atendimentos`. A tabela `atendimentos` do MUV não foi usada. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Modelo

A mesa continua sendo o cadastro já existente: número único por empresa, com ativação e desativação. Mesa livre é a ausência de atendimento `OCUPADA` ou `FECHAMENTO`. Não existe linha artificial para representar mesa livre.

O atendimento guarda empresa, mesa, estado, cliente opcional, operador e horário de abertura, operador e horário de encerramento, e a chave de idempotência quando a requisição envia uma. O horário de abertura sai de `datetime('now')` no servidor.

Estados gravados:

| Estado | Situação da mesa |
|---|---|
| `OCUPADA` | ocupada |
| `FECHAMENTO` | em fechamento; continua ativa |
| `ENCERRADO` | a mesa volta a livre |

`ENCERRADO` existe para o encerramento técnico conservar quem encerrou e quando, sem manter a mesa ocupada. O painel futuro lê só `LIVRE`, `OCUPADA` e `FECHAMENTO`.

## 2. Tabelas, índices e restrições

Criados em `backend/utils/mesasSchema.js`, na mesma migração aditiva de mesas:

- `mesa_atendimentos`, com `CHECK` dos três estados.
- Índice único parcial `ux_mesa_atendimentos_ativo` em `(empresa_id, mesa_id)` enquanto o estado é `OCUPADA` ou `FECHAMENTO`. É a garantia de um atendimento ativo por mesa e empresa, além da validação da aplicação.
- Índice único parcial `ux_mesa_atendimentos_idempotency` em `idempotency_key`.

`pedidos.mesa_atendimento_id` foi adicionada como coluna opcional. Pedido antigo permanece com esse campo nulo. O `PedidoRepository` e o `PedidoOperacionalService` não passaram a gravá-la nem a exigi-la.

## 3. Rotas

Em `/api/mesas`, com o mesmo token, recurso `pedidos` e contexto de empresa do cadastro:

| Método | Caminho | Efeito |
|---|---|---|
| `GET` | `/situacao` | Mesas da empresa e a situação atual. |
| `GET` | `/:id/atendimento` | Atendimento ativo da mesa, ou livre. |
| `POST` | `/:id/atendimento` | Abre. Repetição da mesma chave responde 200. |
| `POST` | `/:id/atendimento/encerrar` | Encerra tecnicamente. |

A empresa vem de `empresaIdDoReqPedido(req)`. O operador vem de `req.user`. Corpo com `empresa_id` ou `operador_id` não é lido. A chave segue o cabeçalho `Idempotency-Key`, ou `idempotency_key` / `chave_idempotencia` no corpo, no mesmo espírito das operações que já aceitam essa chave.

## 4. Concorrência e idempotência

A abertura roda em `BEGIN IMMEDIATE`. Na mesma conexão, as transações entram em fila para não aninhar `BEGIN`. Em conexões diferentes, o índice único parcial decide: a segunda gravação falha e a operação responde `MESA_OCUPADA`, sem linha incompleta.

A mesma chave, a mesma empresa, a mesma mesa e o mesmo operador devolvem o atendimento já aberto. A mesma chave em outra mesa, outro operador ou outra empresa responde `CHAVE_IDEMPOTENCIA_DIVERGENTE` e não cria outro atendimento.

## 5. Isolamento

Toda leitura passa por `MesaService.obterDaEmpresa` ou por `empresa_id` do contexto. Mesa de outra empresa responde `MESA_NAO_ENCONTRADA`. A situação lista só as mesas da empresa autenticada. A mesma numeração em duas empresas são duas mesas e podem ter atendimentos ativos ao mesmo tempo.

## 6. Pedidos legados

Um pedido com `mesa_id` e sem `mesa_atendimento_id` continua consultável, não é reescrito e não gera atendimento. O encerramento técnico não o altera e não o trata como consumo deste atendimento. Só um pedido que já aponte para o atendimento e não esteja `FATURADO` ou `CANCELADO` impede o encerramento, com `ATENDIMENTO_COM_PEDIDO_ABERTO`. Nenhum fluxo atual grava esse ponteiro.

## 7. Encerramento técnico

Permitido a partir de `OCUPADA`, sem venda, estoque, pagamento ou documento fiscal. Grava `ENCERRADO`, o operador e `encerrado_em`. A segunda chamada responde `ATENDIMENTO_JA_ENCERRADO` e não troca o horário.

Atendimento em `FECHAMENTO` não é encerrado por esta operação. Esse estado pertence ao fechamento de conta, que continua no PDV. A resposta é `ATENDIMENTO_EM_FECHAMENTO`.

## 8. Arquivos

- `backend/utils/mesasSchema.js`
- `backend/services/pedido/MesaAtendimentoService.js`
- `backend/rotas/mesas.js`
- `backend/database.js` — só o texto do log da migração já existente
- `tests/pedidos/mesas-02-atendimento.test.js`

`MesaService`, o MUV, `VendaApplicationService`, `VendaPagamentoService` e o pagamento sequencial não foram alterados.

## 9. Testes

Banco temporário. `node --test --test-concurrency=1`.

| Suíte | Resultado |
|---|---|
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-pedido-operacional.test.js` | 12 de 13 |

Os 12 testes de cadastro, vínculo `mesa_id`, isolamento e rotas passaram. O teste que cria pedido pelo serviço real falhou com `UNIDADE_ESTOQUE_INVALIDA` em `PedidoConsumoEstoqueService`, ao converter o produto `Pastel MESA`, que o próprio teste grava sem unidade comercial nem de estoque. A falha ocorre antes do atendimento e não foi introduzida por esta sprint. A regra de estoque não foi alterada.

## 10. Classificação

- CONCLUÍDO: abertura, consulta, ocupação única, idempotência, isolamento e encerramento técnico.
- TESTADO: as suítes acima, no banco temporário.
- HOMOLOGADO: o núcleo coberto pelos testes automatizados, inclusive duas conexões na mesma mesa. Não há painel nem caminhada no PDV.
- BLOQUEADO: entrar em `FECHAMENTO` e concluir conta; ligar pedidos novos ao atendimento; transferência; tempos; painel. A MESAS-03 não foi iniciada.
