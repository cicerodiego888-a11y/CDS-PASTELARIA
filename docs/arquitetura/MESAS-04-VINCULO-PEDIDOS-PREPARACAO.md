# MESAS-04 — Vínculo de pedidos e controle de preparação

O pedido novo de salão passa a apontar para o atendimento ativo da mesa. O relógio de espera só começa num envio explícito, gravado à parte do status comercial. Não houve venda, pagamento, TEF, NFC-e nem acesso ao banco oficial.

## 1. Fluxo real encontrado

`POST /api/pedidos` entra em `EntradaPedidoService.receber` com canal `EQUIPE` e segue para `PedidoOperacionalService.criar`. O corpo pode trazer `mesa_id`. A empresa vem de `req.empresaId`. O Mobile Pedido continua enviando `mesa_id: null`.

Não existe operação de cozinha, KDS ou produção. `EM_SEPARACAO` é status legado de pedido, sem horário de envio. `created_at` não representa preparação. `POST /api/pedidos/:id/preparar-venda-pdv` prepara a venda do PDV, não a cozinha.

O ponto em que o pedido deixa de ser rascunho comercial é a criação com status `PEDIDO`, ou a conversão de `ORCAMENTO` para `PEDIDO`. Nenhum desses passos envia o pedido a um destino operacional. Por isso o envio e a conclusão desta sprint são um contrato explícito do salão, e não uma mudança de status.

## 2. Vínculo

Na mesma transação de `criar`, depois da validação da mesa e da reserva já existente:

1. A mesa livre, encerrada ou em `FECHAMENTO` recusa o pedido. O atendimento não é aberto automaticamente.
2. O atendimento `OCUPADA` da empresa e da mesa é gravado em `pedidos.mesa_atendimento_id`.
3. `mesa_atendimento_id` vindo do corpo é ignorado, também no hash de idempotência.
4. Nasce uma linha em `pedido_preparacoes` com estado `NAO_ENVIADO` e sem horário de envio.

Pedido sem mesa não entra nesse vínculo e não ganha preparação. Pedido antigo, com `mesa_id` e atendimento nulo, não é convertido. A transferência continua sem reescrever `pedidos.mesa_id`. O pedido permanece no mesmo `mesa_atendimento_id`.

## 3. Preparação

Tabela `pedido_preparacoes`, uma linha por pedido (`ux_pedido_preparacoes_pedido`):

| Estado | Significado |
|---|---|
| `NAO_ENVIADO` | pedido de salão ainda em edição ou orçamento |
| `EM_PREPARACAO` | envio explícito gravado |
| `CONCLUIDO` | conclusão explícita gravada |

`CHECK` impede envio sem horário e conclusão sem os dois horários. O status comercial do pedido não muda. Não há `INSERT` em `vendas`.

Rotas, com empresa do contexto e operador da sessão:

| Método | Caminho | Efeito |
|---|---|---|
| `POST` | `/api/pedidos/:id/preparacao/enviar` | Inicia o relógio |
| `POST` | `/api/pedidos/:id/preparacao/concluir` | Encerra o relógio |
| `GET` | `/api/mesas/:id/atendimento/pedidos` | Pedidos do atendimento ativo da mesa |

Orçamento, cancelado, faturado e pedido sem atendimento não são enviados. Repetir o envio ou a conclusão devolve o horário original. A conclusão não libera a mesa nem encerra o atendimento. Duas conexões disputando o mesmo pedido deixam um único horário.

Não há fila, impressora nem tela de cozinha recebendo esse evento. O registro é o marco de domínio pedido pelo salão. Não é um envio operacional para a produção.

## 4. Tempo

A consulta calcula `agora do servidor - enviado_em`. Pedido concluído usa `concluido_em - enviado_em` e para de contar. Nada é gravado a cada segundo.

Os limites estão só em `backend/services/pedido/preparacaoLimites.js`: 5 minutos para `ATRASADO` e 20 para `CRITICO`. Abaixo de 5 é `NORMAL`. No minuto exato entra na faixa seguinte. `CRITICO` substitui `ATRASADO`. Pedido não enviado permanece `NAO_ENVIADO`. A transferência não altera `enviado_em`.

O horário do aparelho não é aceito. Os testes injetam o relógio somente com `CDS_TEST_ISOLATION` e `CDS_BLOQUEAR_BANCO_OFICIAL`.

## 5. Arquivos

- `backend/utils/mesasSchema.js`
- `backend/services/pedido/preparacaoLimites.js`
- `backend/services/pedido/PedidoPreparacaoService.js`
- `backend/services/pedido/MesaAtendimentoService.js`
- `backend/services/pedido/PedidoOperacionalService.js`
- `backend/services/pedido/PedidoRepository.js`
- `backend/rotas/pedidos.js`
- `backend/rotas/mesas.js`
- `tests/pedidos/mesas-04-vinculo-preparacao.test.js`

O MUV, a venda, o pagamento sequencial, o estoque e a ficha técnica não foram alterados.

## 6. Testes

Banco temporário. `node --test --test-concurrency=1`, uma suíte por vez.

| Suíte | Resultado |
|---|---|
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 9 de 9 |
| `tests/pedidos/mesas-02-atendimento.test.js` | 9 de 9 |
| `tests/pedidos/mesas-03-transferencia.test.js` | 11 de 11 |
| `tests/pedidos/mesas-pedido-operacional.test.js` | 12 de 13 |
| `tests/pedidos/entrada-pedido-central.test.js` | 8 de 9 |

O teste da mesa com o produto `Pastel MESA` falhou de novo com `UNIDADE_ESTOQUE_INVALIDA`, antes do vínculo, porque a fixture não grava unidade. A regra de estoque não foi alterada.

O teste da entrada central, sem mesa, criou o pedido e falhou na conferência `200 !== 197` do saldo fiscal. O vínculo de salão não participa desse pedido. A diferença já era conhecida e não foi mascarada.

## 7. Classificação

- CONCLUÍDO: vínculo do pedido novo, preservação do legado e do pedido sem mesa, envio e conclusão explícitos, tempos de 5 e 20 minutos.
- TESTADO: as suítes acima, no banco temporário.
- HOMOLOGADO: o vínculo, a transferência e o relógio cobertos pelos testes. Não há caminhada no PDV nem na cozinha.
- BLOQUEADO: painel, fechamento de conta, venda com vários pedidos e destino real de preparação. O evento não é despachado para cozinha, impressora ou KDS. O Mobile Pedido segue com `mesa_id` nulo.
