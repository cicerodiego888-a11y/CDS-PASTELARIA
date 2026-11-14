# MESAS-03 — Transferência atômica entre mesas

A transferência muda a mesa do atendimento já aberto e grava o histórico na mesma transação. O atendimento não é recriado. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Histórico

A tabela `mesa_atendimento_transferencias` guarda a evidência permanente de cada mudança:

- empresa, atendimento, mesa de origem, mesa de destino, operador e `transferido_em`;
- chave de idempotência, quando a requisição envia uma.

O horário de abertura, o cliente e o operador que abriu continuam no atendimento. O histórico não os copia. `CHECK (mesa_origem_id <> mesa_destino_id)` impede origem e destino iguais. O índice único parcial `ux_mesa_transferencias_idempotency` impede a mesma chave em duas transferências. Uma transferência nova insere outra linha; não altera as anteriores.

## 2. Rota e contrato

`POST /api/mesas/:id/atendimento/transferir`

`:id` é a mesa de origem. O corpo informa `mesa_destino_id` e, se houver, a chave já aceita na abertura: cabeçalho `Idempotency-Key` ou `idempotency_key` / `chave_idempotencia`. A empresa vem de `empresaIdDoReqPedido(req)`. O operador vem da sessão. Corpo com empresa ou operador não é lido.

A resposta traz o atendimento atualizado, a transferência gravada e a situação da origem e do destino. Repetição da mesma chave devolve esse resultado com `repetida: true` e não insere outra linha.

## 3. Transação e rollback

`transferir` usa o mesmo `BEGIN IMMEDIATE` da abertura. Na mesma conexão, as transações entram em fila. A troca de `mesa_id` e o `INSERT` do histórico acontecem antes do `COMMIT`. Se o histórico falha, o `ROLLBACK` devolve o atendimento à mesa de origem. A origem só fica livre quando a transação confirma.

O `UPDATE` exige `estado = 'OCUPADA'` e a mesa de origem ainda vinculada. Não altera `aberto_em`, cliente, operador de abertura nem estado. Não há `INSERT` em `mesa_atendimentos`.

## 4. Concorrência

O índice `ux_mesa_atendimentos_ativo` permanece em `(empresa_id, mesa_id)` para `OCUPADA` e `FECHAMENTO`. Duas transferências para o mesmo destino não ocupam a mesa duas vezes: a segunda responde `MESA_OCUPADA` e não grava histórico. Duas transferências do mesmo atendimento deixam um único histórico e o atendimento em um só destino.

## 5. Idempotência

A chave é conferida dentro da transação, antes de mover a mesa. O mesmo contexto — empresa, atendimento, origem, destino e operador — devolve a transferência existente. Outro destino, operador, empresa ou atendimento responde `CHAVE_IDEMPOTENCIA_DIVERGENTE`, sem expor o registro alheio. Disputa da mesma chave em duas conexões grava uma linha.

## 6. Isolamento

Origem e destino passam por `MesaService.obterDaEmpresa`. Mesa de outra empresa, ou inexistente, responde `MESA_NAO_ENCONTRADA`. Mesa inativa responde `MESA_INATIVA`. A mesma numeração em outra empresa é outra mesa.

Bloqueios de domínio:

| Situação | Código |
|---|---|
| Origem livre | `MESA_LIVRE` |
| Atendimento encerrado | `ATENDIMENTO_JA_ENCERRADO` |
| Atendimento em `FECHAMENTO` | `ATENDIMENTO_EM_FECHAMENTO` |
| Destino ocupado | `MESA_OCUPADA` |
| Origem e destino iguais | `MESA_DESTINO_IGUAL` |

`FECHAMENTO` não é transferido. Esse estado continua reservado ao fechamento de conta.

## 7. Atendimento e pedidos

O identificador do atendimento permanece. O pedido que já aponta `mesa_atendimento_id` continua apontando para ele. A transferência não atualiza `pedidos`, não duplica itens e não recalcula totais. O pedido legado, com `mesa_id` e sem atendimento, permanece como estava. `pedidos.mesa_id` não é reescrito para acompanhar a mesa nova: a ocupação do salão é a do atendimento, e o pedido legado não é convertido.

## 8. Arquivos

- `backend/utils/mesasSchema.js`
- `backend/services/pedido/MesaAtendimentoService.js`
- `backend/rotas/mesas.js`
- `tests/pedidos/mesas-03-transferencia.test.js`

`MesaService`, o MUV, `VendaApplicationService`, `VendaPagamentoService` e o pagamento sequencial não foram alterados.

## 9. Testes

Banco temporário. `node --test --test-concurrency=1`.

| Suíte | Resultado |
|---|---|
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-pedido-operacional.test.js` | 12 de 13 |

Os 11 testes cobrem a mudança de mesa, a preservação do atendimento e do horário de abertura, o pedido vinculado, o histórico acumulado, os bloqueios de domínio, o rollback quando o histórico não grava, as duas disputas de concorrência, a idempotência e o pedido legado.

O teste que cria pedido pelo serviço real voltou a falhar com `UNIDADE_ESTOQUE_INVALIDA` em `PedidoConsumoEstoqueService`, no produto `Pastel MESA` gravado pela fixture sem unidade comercial nem de estoque. A falha é anterior à transferência. A regra de estoque não foi alterada e a falha não foi mascarada.

## 10. Classificação

- CONCLUÍDO: transferência atômica, histórico permanente, idempotência e isolamento.
- TESTADO: as três suítes acima, no banco temporário.
- HOMOLOGADO: o núcleo coberto pelos testes, inclusive concorrência e rollback. Não há painel nem caminhada no PDV.
- BLOQUEADO: painel, envio à preparação, temporizadores, fechamento de conta e composição de uma venda com vários pedidos. A transferência não reescreve `pedidos.mesa_id`.
