# Pedido Operacional — Fase B3: fundação da idempotência de faturamento

## Status

**Execução interrompida após auditoria focal, antes de alterar código ou testes.**

A solução segura exige alterações no caminho transacional central de criação de venda e nos limites entre o Núcleo, o serviço de faturamento e o Pedido. A sprint determina que, nesse caso, a implementação pare após análise e apresente proposta para revisão. Nenhuma mudança funcional foi aplicada.

## 1. Auditoria focal

### Arquivos e funções efetivamente inspecionados

- `backend/services/faturamento/FaturamentoService.js`
  - `faturarPedido`
  - `montarPayloadVendaDoPedido`
  - `invocarNucleo`
- `backend/services/pedido/PedidoRepository.js`
  - `obterPorId`
  - `marcarFaturado`
- `backend/services/vendas/VendaApplicationService.js`
  - `criarVendaComContexto`
  - `concluirVendaNoNucleoOficial`
- `backend/services/vendas/VendaPagamentoService.js`
  - identificação do `pedido_id` do payload
  - os dois blocos de `BEGIN IMMEDIATE`/`INSERT INTO vendas` (caminho a prazo e caminho à vista)
  - gravação de `vendas_itens`, baixa, ficha, reservas, pagamentos/financeiro e `COMMIT`
- `backend/services/estoque/pedidoReservaPonteNucleo.js`
  - `consumirReservasPedidoNaVenda`
  - `consumirReservasPedidoNaVendaCb`
- `backend/services/estoque/EstoqueConsumoReserva.js`
  - `consumirReservasDaVenda`
- `backend/services/produtos/FichaTecnicaConsumoService.js`
  - `consumirFichaTecnicaDaVenda`
- `backend/services/produtos/vendaFichaConsumoSchema.js`
  - chave única de `venda_ficha_consumo.venda_id`
- `backend/database.js`
  - migração/índice de `vendas.pedido_id`
  - schemas de `pedidos` e `vendas`
- Testes consultados para contratos existentes:
  - `tests/faturamento/sprint31-faturamento.test.js`
  - `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js`

### Evidência do estado atual

1. `faturarPedido` lê Pedido/status e verifica empresa antes de iniciar o fluxo de criação da venda.
2. O payload já carrega `pedido_id`, e o Núcleo lê esse campo como `pedidoIdVenda`.
3. Apesar disso, os dois `INSERT INTO vendas` inspecionados não incluem `pedido_id`. O Serviço grava `vendas.origem` e `vendas.pedido_id` em um `UPDATE` **depois** da resposta/commit do Núcleo.
4. O índice atual em `vendas.pedido_id` é não único. Não impede duas vendas para o mesmo Pedido.
5. `marcarFaturado` condiciona o `UPDATE` ao status pendente e empresa, mas é chamado depois da criação e do commit da venda.
6. `faturarPedido` não retorna a venda existente em sucesso idempotente: se o Pedido já está `FATURADO`, lança conflito 409.
7. O consumo de ficha técnica é idempotente por `venda_id` (`UNIQUE` em `venda_ficha_consumo.venda_id`), não por `pedido_id`.
8. O núcleo chama `consumirReservasPedidoNaVendaCb`, mas o callback atual não verifica o erro recebido e avança para o restante do fluxo. Fora do núcleo, os erros das duas tentativas de consumo de reservas também são capturados como warning, e o fluxo continua.
9. O esquema atual não possui estado persistido que distinga “faturamento em andamento” de “Pedido livre” nem registro de tentativa recuperável.

## 2. Por que não implementar nesta etapa

Uma proteção somente no serviço de Pedido seria insuficiente: duas chamadas podem ler o mesmo status antes de qualquer mudança e o serviço não controla a transação interna do Núcleo. Uma atualização do Pedido antes do Núcleo também criaria um estado de reserva que poderia ficar abandonado por encerramento do processo.

Uma restrição única apenas no índice atual também seria insuficiente enquanto o `pedido_id` só for escrito após o commit. Para garantir que a inserção concorrente seja rejeitada **antes** dos itens, baixa e lançamentos financeiros, a chave do Pedido precisa estar presente na linha de `vendas` no mesmo `INSERT` que inicia a transação central.

Além disso, o consumo de reservas no núcleo não propaga hoje falha para abortar a transação. A recuperação precisa distinguir:

- inexistência legítima de reserva;
- reserva já consumida;
- reserva ativa ainda não consumida;
- erro transitório/definitivo.

Ignorar a falha e marcar o Pedido como faturado não satisfaz o requisito de não tratar uma chamada sem exceção como prova de consumo.

Portanto, implementar com segurança envolve modificar os dois ramos transacionais em `VendaPagamentoService.js`, criar uma restrição/migração persistente, alterar a coordenação/recuperação no serviço de faturamento, corrigir a propagação/verificação do resultado de reserva e cobrir os efeitos financeiros/de estoque em testes integrados. Isso altera componentes centrais e fronteiras transacionais, acionando o critério de parada definido na sprint.

## 3. Proposta para revisão arquitetural

### Estratégia recomendada (ainda não implementada)

1. **Chave persistente:** tornar `vendas.pedido_id` uma chave única para vendas de faturamento, com tratamento explícito de `NULL` para vendas não originadas por Pedido.
2. **Gravação atômica da chave:** incluir `pedido_id` e origem `FATURAMENTO` no próprio `INSERT INTO vendas`, nos dois caminhos de pagamento, dentro do `BEGIN IMMEDIATE` existente. A inserção duplicada falha antes da gravação de itens e demais efeitos.
3. **Retry idempotente:** quando houver uma venda confirmada para o mesmo `pedido_id` e `empresa_id`, devolver/reconciliar essa venda em vez de iniciar novo faturamento. Não criar outra venda.
4. **Recuperação de vínculos:** comparar `pedidos.venda_id` com `vendas.id/pedido_id/empresa_id`; reparar somente vínculos consistentes. Divergência ou múltiplas vendas antigas deve resultar em bloqueio explícito e diagnóstico, não escolha silenciosa.
5. **Consumo de reserva:** estabelecer resultado explícito (consumida, já consumida, inexistente ou erro), confirmar estado persistido das reservas e propagar erro conforme política transacional acordada. Falha inconclusiva não pode resultar em resposta de faturamento concluído.
6. **Migração segura:** antes de criar unicidade, verificar duplicidades históricas de `vendas.pedido_id`. A migração não deve apagar, escolher ou relinkar dados automaticamente. Se houver duplicidades, parar a migração com erro claro e exigir reconciliação controlada.
7. **Empresa:** todas as leituras, chaves e reparos devem confirmar igualdade entre `pedidos.empresa_id` e `vendas.empresa_id`, sem fallback global.

### Perguntas que precisam de decisão antes da implementação

- A restrição será `UNIQUE(vendas.pedido_id)` para qualquer venda ligada a Pedido, ou limitada a `origem='FATURAMENTO'`? O índice atual e a única escritora identificada sugerem que todo vínculo é de Faturamento, mas a migração deve verificar dados históricos.
- Se a venda está confirmada e a reserva continua `ATIVA`, o retry deve bloquear e encaminhar para reparo, ou pode consumir a reserva em recuperação com verificação de integridade?
- Qual contrato a API deve devolver quando recuperar sucesso anterior: HTTP 200 com `ja_faturado=true` e a venda existente, ou conflito 409 com identificador da venda?
- Qual procedimento operacional aprovado para duplicidades históricas encontradas na migração?

## 4. Plano de testes proposto (não executado)

Os testes da Fase B3 ainda não foram criados. Após a aprovação da estratégia:

1. Primeiro faturamento conclui e grava ambos os vínculos.
2. Retry sequencial devolve a venda existente sem duplicar estoque, ficha ou financeiro.
3. Duas tentativas concorrentes controladas resultam em uma venda por Pedido.
4. Falha depois do commit da venda pode ser recuperada sem segunda venda.
5. Vínculos divergentes bloqueiam a recuperação e preservam evidência.
6. Falha de consumo de reserva não produz sucesso aparente; estado de reserva é consultado explicitamente.
7. Comparação antes/depois comprova que estoque, consumo de ficha e lançamentos financeiros têm no máximo um efeito por Pedido.
8. Pedido e venda de outra empresa não podem ser conciliados.

Todos devem usar SQLite temporário e dados sintéticos; nenhum teste contra banco operacional.

## 5. Testes executados nesta etapa

**Nenhum teste executado nesta etapa.** A implementação foi interrompida na auditoria, conforme a regra de parada para mudanças no núcleo/limites transacionais. Os testes de `sprint31-faturamento` e `rc412-ponte-reserva-pedido-nucleo` foram apenas inspecionados, não reexecutados.

## 6. Alterações e segurança

- Código de produção: **não alterado**.
- Testes existentes ou novos: **não alterados/criados**.
- Este relatório é o único arquivo criado nesta etapa.
- Nenhum banco operacional foi aberto, consultado ou migrado.
- Nenhuma operação SEFAZ foi executada.
- Nenhum ERP foi iniciado contra base operacional.
- Nenhum reset, checkout destrutivo, commit, push ou merge foi executado.
- As alterações locais preexistentes foram preservadas.

## 7. Próxima ação

Solicitar revisão arquitetural das decisões da seção 3. Somente após aprovação, implementar a chave atômica, recuperação e política de consumo de reservas, seguido dos testes direcionados da seção 4. Esta sprint não inicia automaticamente a implementação.
