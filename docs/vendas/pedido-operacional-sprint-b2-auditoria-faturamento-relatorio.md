# Sprint Pedido Operacional — Fase B2: auditoria de idempotência do faturamento

## Conclusão executiva

O fluxo impede uma segunda solicitação **sequencial após o Pedido estar marcado `FATURADO`**: `FaturamentoService.faturarPedido` retorna conflito e inclui o `venda_id` atual. Isso não prova idempotência integral.

A implementação não envolve a validação do Pedido, a criação da venda, o vínculo Pedido–venda e a atualização do status em uma única transação. Há janelas observáveis para falha parcial e concorrência:

- a venda e os efeitos do núcleo (itens, baixa física, consumo da ficha e dados financeiros) são confirmados antes de o serviço atualizar `vendas.origem/pedido_id` e antes de `pedidos.status/venda_id`;
- falha ao gravar o vínculo é apenas registrada em `console.warn`, e o fluxo continua;
- falha ao atualizar o Pedido ocorre depois que a venda já foi gerada e o método lança erro;
- duas solicitações podem passar pela leitura do status antes de qualquer atualização; o status condicional bloqueia uma das gravações do cabeçalho do Pedido, mas não desfaz a venda que a solicitação concorrente já tiver confirmado;
- erros ao consumir reservas do Pedido são ignorados por callback no núcleo e também são tratados como advertência no serviço de faturamento.

São **riscos identificados pelo código**, não falhas reproduzidas nesta sprint. Não foi alterado código nem teste. O teste existente executado valida o contrato básico de faturamento e a gravação de status/venda_id, mas não executa `faturarPedido` de ponta a ponta nem testa falhas, repetição concorrente ou consumo duplicado.

## 1. Arquivos e funções inspecionados

- `backend/services/faturamento/FaturamentoService.js`
  - `montarPayloadVendaDoPedido`
  - `invocarNucleo`
  - `faturarPedido`
- `backend/services/pedido/PedidoOperacionalService.js`
  - `confirmarEstoqueViaMotorComercial`
  - leitura/validação de Pedido, criação/edição/cancelamento e transições de estado pertinentes ao ciclo operacional
- `backend/services/pedido/PedidoService.js`
  - `criarPedido` e confirmação inicial pelo Motor Comercial
- `backend/services/pedido/PedidoRepository.js`
  - `obterPorId`
  - `marcarFaturado`
  - persistência transacional de Pedido (`criarPedido`, `substituirPedido`)
- `backend/services/vendas/VendaApplicationService.js`
  - `criarVendaComContexto`
  - `concluirVendaNoNucleoOficial`
- `backend/services/vendas/VendaPagamentoService.js`
  - identificação do `pedido_id`
  - `reduzirEstoqueDistribuido`
  - `aposBaixaItensDaVenda`
  - transações de criação da venda, item, baixa, pagamentos e financeiro
- `backend/services/estoque/pedidoReservaPonteNucleo.js`
  - `consumirReservasPedidoNaVenda`
  - wrapper `consumirReservasPedidoNaVendaCb`
- `backend/services/estoque/EstoqueConsumoReserva.js`
  - `consumirReservasDaVenda`
- `backend/services/produtos/FichaTecnicaConsumoService.js`
  - `consumirFichaTecnicaDaVenda`
- `backend/services/produtos/vendaFichaConsumoSchema.js`
  - schema de idempotência do consumo de ficha
- `backend/database.js`
  - schemas de `pedidos`, `vendas` e índice de `vendas.pedido_id`
- Testes examinados para seleção:
  - `tests/faturamento/sprint31-faturamento.test.js`
  - `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js`
  - `tests/faturamento/rc400-central-faturamento.test.js`

### Estado local relevante

`FaturamentoService.js` estava modificado no workspace antes desta auditoria. O diff local restringe-se à listagem de vendas faturadas (join/consulta para documentos NFC-e); não altera `faturarPedido`. Também havia alterações locais em `CentralFaturamentoService.js` e nos serviços de Pedido da Fase B1. Nenhum arquivo foi revertido ou modificado nesta auditoria.

## 2. Sequência real — Cenário A: faturamento normal

### Antes do núcleo

1. `faturarPedido` valida o ID numérico.
2. Lê o Pedido e seus itens por `PedidoRepository.obterPorId`.
3. Valida o ownership por `empresa_id` através de `exigirOperacaoDoPedido`.
4. Rejeita Pedido já `FATURADO`, estados fora de `ABERTO`/`AGUARDANDO_FATURAMENTO` ou pedido sem itens.
5. Atualiza metadados fiscais do Pedido antes da venda (`atualizarDadosFiscais`). A operação é fora da transação de venda; erro é capturado e apenas avisado. Esses campos não atualizam `pedidos.total`.
6. Monta um `VendaContract` derivado dos itens/valores do Pedido e inclui `pedido_id`. `total` do payload deriva de `pedido.total` com os ajustes fiscais/de operação extraídos da solicitação. O código não recalcula os itens usando preços atuais do catálogo.

### No núcleo transacional da venda

7. `VendaApplicationService` delega a origem `FATURAMENTO` a `VendaPagamentoService.criarVenda`.
8. O núcleo valida o contexto de empresa e prepara a distribuição de estoque.
9. Na transação `BEGIN IMMEDIATE`, grava `vendas`.
10. Grava `vendas_itens` e executa `reduzirEstoqueDistribuido` (baixa física por saldo/lote).
11. Após a baixa dos itens, chama `consumirFichaTecnicaDaVenda`. O schema grava um registro único por `venda_id` em `venda_ficha_consumo`; a função verifica esse registro e retorna `ja_consumido` quando já existe. A tabela e o consumo participam da mesma conexão/transação do núcleo.
12. Chama o consumo de reserva associada ao Pedido (`consumirReservasPedidoNaVendaCb`).
13. Grava `venda_pagamentos`, `financeiro` e, para formas a prazo aplicáveis, os registros financeiros/parcelas e `contas_receber`/crédito do cliente dentro da transação do núcleo.
14. Executa `COMMIT` e responde com o ID da venda. Na rota à vista observada, a chamada a `COMMIT` é enfileirada antes da resposta; o callback de commit não é usado para detectar erro.

O núcleo não persiste `pedido_id` na primeira inserção de `vendas`; esse vínculo é feito pelo serviço de faturamento depois da resposta do núcleo.

### Depois da venda confirmada

15. `FaturamentoService` atualiza `vendas.origem` e `vendas.pedido_id`, fora da transação do núcleo. Se falhar, registra advertência e prossegue.
16. Chama `consumirReservasDaVenda` (reservas originadas por venda/PDV); falhas são avisadas e ignoradas.
17. Chama novamente `consumirReservasPedidoNaVenda`, agora pela ponte de Pedido; falhas também são avisadas e ignoradas.
18. Chama `PedidoRepository.marcarFaturado`. O `UPDATE` é condicional a status permitido e empresa; se não alterar linha, o serviço lança erro `Venda gerada, mas falha ao atualizar status do pedido.` A venda já existe e os efeitos do núcleo já foram confirmados.
19. Se o status for atualizado, relê o Pedido e responde sucesso.

## 3. Limites transacionais

| Operação | Fronteira observada | Implicação |
|---|---|---|
| Metadados fiscais no Pedido | Update separado, antes da venda; falha não aborta | Metadados podem ser atualizados sem venda. `pedidos.total` operacional não é atualizado por esse método |
| Cabeçalho/itens da venda | Transação no `VendaPagamentoService` | Inserções da venda e itens são agrupadas com as operações subsequentes do núcleo |
| Baixa física | Dentro da transação do núcleo e associada aos itens da venda | Erros explícitos provocam `ROLLBACK`; não há chave de idempotência por Pedido para uma nova venda |
| Consumo da ficha técnica | Mesma conexão/transação do núcleo; uma linha única por `venda_id` | Idempotência por ID de venda, não por ID de Pedido |
| Consumo da reserva do Pedido no núcleo | Executado durante a transação do núcleo, mas o erro é ignorado pelo callback que sempre continua | Erro pode não abortar a venda; detalhes abaixo |
| Pagamentos/financeiro | Inseridos antes do `COMMIT` do núcleo | Em princípio agrupados com a venda, embora alguns callbacks de persistência não interrompam uniformemente o encadeamento |
| Vínculo `vendas.pedido_id` | Update separado após a resposta/commit do núcleo | Não atômico com a criação da venda; falha é apenas avisada |
| Reserva pós-núcleo | Chamadas externas à transação, cada uma com catch e warning | Podem falhar sem impedir a tentativa de marcar o Pedido faturado |
| Status e `pedidos.venda_id` | Update separado depois da venda, sem transação conjunta | Falha deixa a venda confirmada e o Pedido possivelmente ainda faturável |

O schema de `vendas` tem índice não único em `pedido_id` (`idx_vendas_pedido_id`); não foi encontrada restrição única que impeça várias vendas vinculadas ao mesmo Pedido.

## 4. Resultados dos cenários A–E

### A — Faturamento normal

**Fato:** ordem e limites descritos acima. A venda, baixa física, consumo da ficha e integração financeira do núcleo precedem o vínculo e a transição final do Pedido.

**Risco:** falha pós-commit pode deixar estados divergentes, sem rollback da venda. O relatório não afirma que tal falha tenha ocorrido em execução real.

### B — Repetição sequencial da mesma solicitação

**Fato:** se a primeira execução conclui `marcarFaturado`, a próxima leitura detecta `FATURADO` e retorna conflito 409 com `venda_id`; não retorna a venda anterior como sucesso idempotente.

**Fato:** o teste executado confirma separadamente a atualização condicional de status e gravação de `venda_id`, mas não invoca o serviço em duas solicitações.

**Risco:** se a primeira execução confirmou a venda, mas falhou antes de marcar o Pedido como faturado, a segunda tentativa pode passar pela validação de status e criar outra venda. Não há índice único por `pedido_id` que impeça isso.

### C — Falha após criar a venda

**Fato:** link update falho é capturado e não impede o fluxo. Falha no `marcarFaturado` lança erro depois da geração da venda.

**Risco:** falha de vínculo com sucesso no update do Pedido deixa `pedidos.venda_id` apontando para venda cujo `vendas.pedido_id` não foi gravado. Falha no status deixa o Pedido aparentemente aguardando apesar de a venda/baixa/financeiro já estarem confirmados, tornando possível uma nova tentativa.

**Não testado:** injeção de falha em link/status após commit.

### D — Falha durante consumo de reservas

**Fato:** o núcleo chama `consumirReservasPedidoNaVendaCb`, mas o callback fornecido não inspeciona o argumento de erro; chama o próximo passo em qualquer resultado. Assim, erro da ponte de reservas não aciona rollback nesse callback.

**Fato:** depois do núcleo, `FaturamentoService` tenta consumir reservas do tipo venda e reservas do Pedido. Captura erros com warning e ainda segue para `marcarFaturado`.

**Fato:** a ponte do Pedido seleciona apenas reservas `ATIVA`, atualiza estado para `CONSUMIDA` e retorna quantas consumiu. Uma repetição após consumo tende a não encontrar reservas ativas e retornar `consumidas: 0`; esse retorno, sozinho, não distingue reserva já consumida de inexistente. Erros são lançados pela função, mas o chamador os absorve.

**Risco:** a venda/Pedido podem concluir sem confirmação de que as reservas foram liberadas/consumidas. Se a falha acontecer durante processamento de várias reservas, operações parciais podem estar dentro da transação em andamento; como o erro pode ser ignorado, não há garantia geral de rollback nessa etapa. O segundo consumidor externo pode recuperar uma reserva ativa em alguns casos, mas seu erro também é absorvido.

### E — Concorrência

**Fato:** validação de status ocorre antes de entrar no núcleo transacional; `faturarPedido` não reserva/atualiza atomicamente o Pedido para um estado intermediário antes de criar a venda.

**Fato:** `marcarFaturado` tem `WHERE status IN (...)`, então apenas uma atualização final pode alterar o Pedido de um estado pendente. Isso protege a transição final, mas ocorre após as vendas já terem sido criadas.

**Risco:** duas chamadas simultâneas podem ambas ler o Pedido pendente e criar vendas no núcleo em transações serializadas separadas. A segunda transação não revalida o status do Pedido nem encontra constraint única de `vendas.pedido_id`; se passar pelas validações de saldo/estoque, pode confirmar efeitos próprios. Uma delas poderá então falhar ao atualizar o status, tarde demais para desfazer sua venda já confirmada.

**Limite:** concorrência não foi executada nem simulada, conforme a restrição da sprint.

## 5. Teste executado

Foi selecionado um único teste existente que cobre a ponte de Pedido para venda e a persistência básica do estado:

```text
NODE_ENV=test
DB_DIR=<diretório temporário dedicado>
node tests\faturamento\sprint31-faturamento.test.js
```

**Resultado real: 8 testes aprovados, 0 falhas, exit code 0.**

O teste cobre política da origem `FATURAMENTO`, montagem do payload com `pedido_id`, delegação da origem ao núcleo, presença da rota e uma atualização condicional de `pedidos.status`/`venda_id` em SQLite temporário. Não cobre uma execução completa de `faturarPedido`, repetição de chamada, falhas intermediárias, reserva, baixa física ou concorrência. Não foram executados outros testes nesta sprint.

## 6. Possíveis efeitos duplicados/divergentes

1. **Venda duplicada por retry ou concorrência:** não existe idempotency key por Pedido nem unicidade de `vendas.pedido_id`; a proteção de status ocorre depois da criação da venda.
2. **Baixa física e financeiro duplicados:** cada nova venda recebe novo `venda_id`; baixa/financeiro estão vinculados à transação dessa venda e não são naturalmente deduplicados pelo Pedido. Uma segunda venda confirmada pode gerar novos lançamentos e baixa, se estoque/disponibilidade permitirem.
3. **Ficha técnica:** chave única e busca são por `venda_id`; outra venda para o mesmo Pedido tem outro ID e pode consumir ficha novamente. O mecanismo previne duplicação por venda, não por pedido.
4. **Reserva do Pedido:** consumo da mesma linha ativa usa status `ATIVA`→`CONSUMIDA`, e uma segunda passagem normal vê zero linhas ativas. Porém erro é absorvido em dois pontos e a resposta de zero consumos não especifica causa.
5. **Vínculo:** falha no update da venda pode deixar o Pedido com `venda_id` sem `vendas.pedido_id`, ou, combinada com falha no status, deixar venda sem vínculo recuperável pelo caminho do Pedido.
6. **Status:** `marcarFaturado` condicionado reduz risco de sobrescrever estado inválido, mas o erro não reverte venda já confirmada.

Nenhum desses efeitos foi produzido durante a execução do teste.

## 7. Recomendações mínimas para revisão futura

Sem implementar nesta fase:

1. Definir estratégia idempotente por Pedido que cubra também concorrência, sem criar outro serviço/sistema de pedidos.
2. Tornar atômicos ou recuperáveis o vínculo `vendas.pedido_id`, `pedidos.venda_id` e a transição `FATURADO` em relação à venda confirmada; considerar também estados intermediários/reconciliação após falha.
3. Decidir explicitamente se falha ao consumir reservas deve impedir commit/faturamento ou ser registrada como estado de recuperação; hoje os catches não garantem sucesso nem diferenciam falha recuperável de definitiva.
4. Adicionar, em sprint posterior aprovada, testes de serviço para repetição sequencial, falha pós-venda, erro de consumo e concorrência controlada, além de verificar invariantes de baixa, ficha e financeiro.
5. Manter `pedidos.total` como fonte operacional e tratar ajustes de faturamento/fiscais em campos/valores derivados, com reconciliação explícita entre Pedido e venda.

## 8. Segurança e escopo

- Nenhum código de produção ou teste foi alterado nesta sprint; apenas este relatório foi criado.
- Nenhum banco operacional foi acessado; o teste foi executado com `NODE_ENV=test`, `DB_DIR` temporário e a fixture SQLite própria do teste em diretório temporário.
- Nenhuma operação SEFAZ foi executada.
- Nenhum backend/ERP foi iniciado contra banco operacional.
- Não houve reset, checkout destrutivo, commit, push ou merge.

