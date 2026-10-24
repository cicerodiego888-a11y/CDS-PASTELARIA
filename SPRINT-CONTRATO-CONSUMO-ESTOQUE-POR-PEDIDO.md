# Sprint técnico — Contrato de consumo de estoque por Pedido

## Conclusão da implementação

A implementação autorizada adiciona consumo de estoque com origem `PEDIDO`, registro durável por item e idempotência por empresa/chave, compartilhando uma conexão SQLite e uma transação `BEGIN IMMEDIATE` entre Pedido, requisitos, confirmação do Motor Comercial, débitos, reservas e ledger. O fluxo legado de vendas sem consumo prévio por Pedido permanece disponível.

As seções de auditoria abaixo descrevem o baseline verificado antes da implementação; a seção **Contrato implementado e validação final** registra o comportamento atual. A validação funcional subsequente confirmou que o salvamento pela tela já estava conectado ao contrato. Cancelamento/estorno e geração de venda continuam fora do escopo.

## Fluxo auditado antes da implementação

```text
POST /pedidos
  → EntradaPedidoService.receber
  → PedidoOperacionalService.criar
  → analisar disponibilidade fiscal (sem mutação)
  → PedidoRepository.criarPedido: grava Pedido e itens em uma transação própria
  → MotorComercial.confirmarPedidoFiscal: nova transação
       → recalcula disponibilidade sob BEGIN IMMEDIATE
       → se autorizado, MTS transfere saldo não fiscal para fiscal
       → cria pedido_estoque_reservas e atualiza reservado_fiscal
       → grava auditoria e confirma

Venda vinculada ao Pedido
  → VendaPagamentoService abre BEGIN IMMEDIATE
  → grava venda e vendas_itens
  → baixa produto vendido via porta pública de saldo / FEFO, se aplicável
  → consome ingredientes da ficha técnica e registra o snapshot do consumo
  → libera reservado_fiscal do Pedido e marca a reserva como CONSUMIDA
  → confirma a transação da venda
```

A reserva do Motor Comercial **não é uma baixa física**. O serviço `consumirReservasPedidoNaVenda` libera a quantidade reservada e marca a linha como consumida, mas não reduz saldo físico; a redução já foi executada no fluxo da venda.

## Arquivos, funções e dados relevantes

### Pedido e reserva do Motor Comercial

- [`backend/rotas/pedidos.js`](backend/rotas/pedidos.js): `POST /` delega à entrada central; `POST /:id/cancelar` delega o cancelamento ao serviço operacional.
- [`backend/services/pedido/EntradaPedidoService.js`](backend/services/pedido/EntradaPedidoService.js): valida canal e empresa e encaminha para `PedidoOperacionalService.criar`.
- [`backend/services/pedido/PedidoOperacionalService.js`](backend/services/pedido/PedidoOperacionalService.js):
  - `criar`: valida itens/totais, persiste Pedido, depois confirma/reserva estoque.
  - `atualizar`: substitui Pedido/itens antes de reconfirmar o estoque.
  - `cancelar`: libera reservas e, em seguida, altera o status do Pedido.
- [`backend/services/pedido/PedidoRepository.js`](backend/services/pedido/PedidoRepository.js): `criarPedido` grava cabeçalho e itens entre `BEGIN IMMEDIATE` e `COMMIT`; aceita conexão `db`, mas inicia a transação internamente sem opção de reutilizar uma transação ativa.
- [`backend/motores/comercial/MotorComercialService.js`](backend/motores/comercial/MotorComercialService.js):
  - `analisarDisponibilidadeFiscal` consulta a disponibilidade do produto final do item do Pedido.
  - `executarConfirmacaoFiscal` abre transação, recalcula a disponibilidade sob lock, executa eventual transferência MTS e cria as reservas.
  - `liberarReservasDoPedido` delega a liberação à porta pública.
- [`backend/services/fiscalNaoFiscal/reservasPublico.js`](backend/services/fiscalNaoFiscal/reservasPublico.js):
  - `criarReservaFiscal` registra `pedido_estoque_reservas` e altera saldo reservado, não saldo físico.
  - A criação da reserva reutiliza uma transação ativa se receber a mesma conexão; a liberação não abre transação própria e depende do caller para atomicidade.
- [`backend/motores/comercial/PedidoEstoqueAuditoria.js`](backend/motores/comercial/PedidoEstoqueAuditoria.js): registra consulta, reserva, transferência, confirmação, bloqueio e rollback em `auditoria_pedido_estoque_fiscal`. É auditoria do processo, não razão de movimentos físicos.
- [`backend/motores/mts/MtsService.js`](backend/motores/mts/MtsService.js) e [`backend/motores/mts/MtsAuditoriaRepository.js`](backend/motores/mts/MtsAuditoriaRepository.js): transferência entre saldo não fiscal e fiscal; registra `movimentos_transferencia_saldos`. Transferência entre tipos não é consumo líquido de estoque.

Tabelas principais:

- `pedidos` e `pedidos_itens`: cabeçalho, quantidades, preços e subtotais; o repositório preserva os valores efetivamente enviados.
- `pedido_estoque_reservas`: quantidade fiscal reservada, empresa, item associado e status `ATIVA`, `CANCELADA` ou `CONSUMIDA`.
- `produtos`: saldos agregados fiscal/não fiscal, reservas e `estoque_atual`.
- `estoque_empresa`: leitura e espelhamento de saldos/reservas por empresa.
- `auditoria_pedido_estoque_fiscal`: trilha do Motor Comercial.
- `movimentos_transferencia_saldos`: trilha de transferências MTS, não de saída física.

### Baixa na venda e ficha técnica

- [`backend/services/vendas/VendaPagamentoService.js`](backend/services/vendas/VendaPagamentoService.js):
  - `reduzirEstoqueDistribuido` baixa as quantidades fiscal/não fiscal já calculadas para a venda e respeita `controla_estoque`; pode usar FEFO.
  - Dentro do fluxo de venda, chama depois o consumo da ficha técnica e a ponte de reserva do Pedido, antes do commit da transação.
- [`backend/services/vendas/debitoEstoqueVendaViaPorta.js`](backend/services/vendas/debitoEstoqueVendaViaPorta.js): `debitarEstoqueItemVenda` encaminha o débito à porta pública de saldo.
- [`backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`](backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js): `debitarSaldo` não inicia transação. `_ajustarSaldo` atualiza `produtos` e espelha o delta em `estoque_empresa`.
- [`backend/services/produtos/FichaTecnicaConsumoService.js`](backend/services/produtos/FichaTecnicaConsumoService.js):
  - `montarLinhasConsumo` aplica quantidade vendida × ficha e converte unidade da ficha para unidade de estoque usando MUC.
  - `consumirFichaTecnicaDaVenda` agrega ingredientes, valida saldo, consome saldo fiscal e depois não fiscal, e grava o detalhe do consumo.
- [`backend/services/produtos/vendaFichaConsumoSchema.js`](backend/services/produtos/vendaFichaConsumoSchema.js): `venda_ficha_consumo` tem `venda_id UNIQUE`; as tabelas `venda_ficha_consumo_itens` e `venda_ficha_consumo_estornos` guardam detalhes e estornos vinculados à venda.
- [`backend/services/estoque/pedidoReservaPonteNucleo.js`](backend/services/estoque/pedidoReservaPonteNucleo.js): após a baixa da venda, libera reservado fiscal e marca as reservas do Pedido como consumidas; ignora linhas que não estão ativas.

O débito direto altera saldos; nos serviços examinados não há um ledger genérico de movimento físico por origem para esse débito. `vendas_itens` registra a venda e as tabelas `venda_ficha_consumo_*` registram consumo de ficha. A reserva do Pedido e a auditoria do Motor não substituem esse ledger.

Há também `venda_estoque_reservas` e [`backend/services/estoque/EstoqueConsumoReserva.js`](backend/services/estoque/EstoqueConsumoReserva.js), usados no fluxo de reserva do PDV. Esse fluxo separado não é a reserva `pedido_estoque_reservas` do Motor Comercial.

## Conexões e limites transacionais comprovados

1. [`backend/database.js`](backend/database.js) cria uma instância SQLite e a exporta como `db`. Os serviços usam essa instância por padrão, mas SQLite associa transações à conexão, não apenas ao arquivo de banco.
2. `PedidoRepository.criarPedido` aceita `db` injetado, mas executa seu próprio `BEGIN IMMEDIATE`/`COMMIT`. Não pode ser chamado dentro de uma transação aberta pelo caller sem refatoração, pois tentaria iniciar uma transação aninhada.
3. O Motor Comercial usa `estoqueSaldosPublico.executarEmTransacao`, que abre `BEGIN IMMEDIATE` e passa a conexão da transação às operações de reserva e ao MTS. Isso torna a confirmação da reserva e a transferência atômicas entre si.
4. `debitarEstoqueItemVenda` e `consumirFichaTecnicaDaVenda` usam a conexão recebida e não iniciam sua própria transação. O fluxo de venda os chama dentro da transação SQLite da venda.
5. Portanto, a porta pública de débito **pode** participar de uma transação comum se receber a mesma conexão exata e o caller controlar o limite transacional. O fluxo de criação do Pedido **não faz isso hoje**: grava e confirma o Pedido antes da transação própria do Motor.
6. O caminho de cancelamento também é dividido: libera reservas primeiro e altera o status do Pedido depois, sem uma transação comum. Na falha da confirmação inicial, o serviço tenta liberar reservas e marcar o Pedido como cancelado; essas tentativas são separadas e erros são ignorados.

### Ownership e saldo negativo

O Motor Comercial toma `pedidos.empresa_id` como ownership e rejeita divergência com a empresa do caller; a reserva persiste `empresa_id`. Consultas de saldo por empresa leem `estoque_empresa` sem fallback para outra empresa. Na escrita, porém, `_ajustarSaldo` valida o piso usando saldos agregados de `produtos` e depois chama `EstoqueEmpresaService.aplicarEfeitoSaldo`, que aplica o delta à linha da empresa sem validar piso. Assim, o caminho examinado não demonstra que a baixa impede saldo negativo **por empresa** quando ainda há saldo agregado em `produtos`. Essa garantia precisa ser resolvida/validada antes de usar a porta para consumo operacional multiempresa.

## Produtos simples, ficha técnica e reservas existentes

- **Produto simples controlado por estoque:** a venda baixa as quantidades já distribuídas entre fiscal e não fiscal. A função de baixa não converte quantidade comercial em unidade de estoque. `ProdutoConversaoConfigService.simularConversaoProduto` e MUC oferecem regras de conversão, mas não estão ligados a essa baixa. Para um produto comercializado como garrafa e controlado em mililitros, o caminho atual não comprova a conversão de 1 garrafa para 2.000 ml.
- **Produto com ficha ativa:** o consumo da ficha converte ingredientes e unidades via MUC. No fluxo de venda, a baixa direta do produto vendido ocorre antes do consumo dos ingredientes quando `controla_estoque` está habilitado. É necessário decidir se um produto com ficha deve consumir somente ingredientes ou também o estoque do produto final; sem essa regra, aplicar ambas as operações pode causar dupla baixa.
- **Ficha ausente/inativa/vazia:** `montarLinhasConsumo` não gera linhas de ingrediente. O comportamento de baixa direta permanece regido por `controla_estoque`.
- **Reserva fiscal de Pedido:** representa disponibilidade do produto pedido, não dos ingredientes da ficha. O Motor pode transferir não fiscal para fiscal mediante autorização e depois reservar fiscal. Na venda, a baixa física e o consumo de ficha ocorrem antes da liberação da reserva.
- **Pedidos antigos:** não há base para inferir que seus itens já sofreram baixa. A futura implementação não deve consumir retroativamente em leitura, reabertura, edição ou recálculo. Reservas já ativas devem continuar no ciclo legado até decisão explícita de migração/conversão; a nova baixa não pode deixar a reserva antiga ativa sobre o mesmo estoque consumido.

## Opções técnicas avaliadas na inspeção inicial

1. **Chamar o serviço de ficha técnica com um `vendaId` fictício — rejeitada.** Viola o vínculo e as FKs de venda, mistura domínios e não resolve baixa de produtos simples nem idempotência por Pedido.
2. **Criar um segundo serviço de estoque para Pedido — rejeitada.** Duplicaria conversão, validação, distribuição fiscal/não fiscal e a porta pública de baixa, permitindo divergência de regras.
3. **Reaproveitar um núcleo único de requisitos/consumo com adaptadores de origem — recomendada.** Extrair a composição de necessidades, validação/distribuição e débito para um fluxo compartilhado. O adaptador de venda preserva seu contrato; o de Pedido registra consumo com origem `PEDIDO`, sem inventar venda. A ficha continua usando a mesma conversão MUC e a baixa continua usando a porta pública.

## Recomendação inicial

1. Definir um único planejador de necessidades de estoque por item: ficha técnica ativa consome insumos; sem ficha ativa, produto controlado consome a própria quantidade. Conversão comercial → unidade de estoque deve usar MUC/configuração existente e falhar explicitamente quando a relação necessária não existir.
2. Fazer Pedido, itens, validação de disponibilidade, consumo, ledger e reconciliação/liberação das reservas no mesmo `BEGIN IMMEDIATE`, com a mesma conexão injetada. Para isso, extrair no repositório uma operação que grava Pedido/itens na transação do caller, preservando o caminho transacional existente para os demais callers.
3. Criar um registro durável de consumo por Pedido com unicidade de `pedido_id` e linhas contendo empresa, item do Pedido, produto/insumo, origem do requisito, quantidade/unidade consumida e distribuição fiscal/não fiscal. A unicidade e a gravação na mesma transação tornam o reprocessamento do mesmo Pedido idempotente.
4. Adicionar chave de idempotência na criação da operação (escopada à empresa) para que o retry de um `POST` não crie um segundo Pedido, já que unicidade do consumo por `pedido_id` sozinha não detecta dois IDs de Pedido gerados para a mesma solicitação.
5. Reconciliar a política do Motor Comercial: consumos de Pedido não podem deixar reservas ativas duplicando a baixa. A confirmação deve reservar/autorizar as necessidades reais (produto simples ou ingredientes) e consumir/liberar a reserva dentro da mesma transação, ou usar uma política equivalente aprovada que preserve a transferência/supervisão atuais.
6. Antes de ativar o débito por empresa, corrigir ou comprovar o piso de saldo na própria linha `estoque_empresa`; não confiar apenas no saldo agregado de `produtos`.
7. Registrar consumo apenas para Pedido confirmado, nunca para `ORCAMENTO`. Não alterar estoque de pedidos históricos.

## Decisões de negócio e pendências

- Para produto com ficha ativa, a ficha substitui totalmente o consumo do produto final, ou o produto final também pode ter estoque controlado?
- Qual configuração representa a unidade comercial de venda para produtos por volume, e como se relaciona com `unidade_estoque`/MUC? Sem conversão definida, deve bloquear a baixa em vez de inferir o fator.
- O consumo imediato será fiscal, não fiscal ou seguirá a mesma regra de análise/autorização do Motor Comercial? A forma como ingredientes herdam essa classificação também precisa ser definida.
- Como tratar edição de itens/quantidades depois da baixa? A opção segura inicial é impedir edição que altere necessidades de estoque até existir ajuste compensatório.
- Como tratar cancelamento enquanto estorno ainda não está implementado? A opção segura é bloquear cancelamento de Pedido já consumido até o fluxo de estorno ser aprovado e entregue.
- Para novas solicitações, qual componente gera e reapresenta a chave de idempotência em um retry?
- Como manter pedidos antigos com reservas ativas sem baixa retroativa e sem duplicar consumo ao editar/reconfirmar?

Foram aprovadas para esta implementação: ficha ativa consome somente ingredientes; distribuição/classificação segue a autorização do Motor Comercial; e alterações de estoque em Pedido consumido ficam bloqueadas até existir ajuste transacional. Permanecem fora do escopo a política de estorno e a ativação da baixa pela interface. O futuro estorno deve usar as linhas imutáveis do ledger, creditar apenas quantidades ainda não estornadas e registrar identificador único na mesma transação; este Sprint não o implementa.

## Testes direcionados previstos na inspeção inicial

Executar somente em banco isolado e sequencialmente:

1. Pedido com dois produtos: persistência de itens, quantidades, preços/subtotais e total calculado; preservar preço praticado após alteração posterior do catálogo.
2. Item com ficha técnica ativa e quantidade > 1: consumo exato dos ingredientes, agregação de insumo repetido e conversão MUC; falha explícita para ficha inválida, insumo inativo/inexistente ou conversão ausente.
3. Produto simples controlado por unidade e por volume: conversão configurada (ex.: 1 garrafa de 2 L → 2.000 ml) e falha sem relação configurada; `controla_estoque = 0` não deve gerar baixa direta.
4. Produto com ficha e estoque próprio: assertar a regra aprovada para evitar baixa dupla do produto final e dos ingredientes.
5. Multiempresa: débito no estoque da empresa do Pedido, rejeição de empresa divergente, ausência de fallback e bloqueio de saldo negativo por empresa, inclusive com tentativa concorrente.
6. Atomicidade: injetar falha após a primeira linha de débito e verificar rollback de Pedido, itens, todas as baixas, ledger, transferência e reservas.
7. Idempotência: repetir o mesmo Pedido e repetir a mesma chave de criação; confirmar que não surgem Pedido ou baixas adicionais.
8. Reservas: testar supervisor/transferência não fiscal, consumo imediato, ausência de reserva ativa após commit e preservação do ciclo legado para pedidos anteriores.
9. Edição e cancelamento de Pedido consumido: verificar o bloqueio até existir ajuste/estorno transacional; no futuro, repetir estorno e provar que só há um crédito.
10. Reexecutar os testes focados já relacionados: `tests/pedidos/entrada-pedido-central.test.js`, `tests/estoque/pedido-disponibilidade-multiempresa.test.js`, `tests/estoque/consumo-reserva-pedido-porta-publica.test.js`, `tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js`, `tests/muc/muc-04-ficha-consumo.test.js` e `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js`. Atualizar a expectativa existente de “sem baixa” somente quando a implementação futura for aprovada, nunca para mascarar falhas.

## Contrato implementado e validação final

### Fluxo de consumo por Pedido

```text
POST de criação de Pedido (Idempotency-Key)
  → chave escopada à empresa + hash do payload
  → BEGIN IMMEDIATE na conexão SQLite compartilhada
  → PedidoRepository grava cabeçalho e itens sem transação aninhada
  → PedidoConsumoEstoqueService monta requisitos:
       ficha ativa → somente ingredientes, conversões MUC
       sem ficha → produto simples controlado, unidade comercial → estoque via MUC/configuração
  → Motor Comercial analisa/confirma e aplica sua classificação/autorização
  → baixa pela porta pública de estoque, com validação do saldo da empresa
  → libera/marca as reservas atendidas e grava ledger + chave idempotente
  → COMMIT; qualquer erro anterior causa ROLLBACK conjunto
```

Orçamento não consome ao ser criado; a conversão para Pedido faz a operação dentro da transação que muda o status. Pedido consumido não pode ser editado nem cancelado sem fluxo transacional de ajuste/estorno. Pedidos históricos sem ledger não recebem baixa retroativa. Ao faturar um Pedido já consumido, a compatibilidade local usa o ledger para impedir um segundo débito físico/consumo de ficha; pedidos legados sem ledger continuam no caminho anterior.

### Contrato e garantias

- `pedido_estoque_consumos`/`pedido_estoque_consumo_itens` identificam Pedido, empresa, item, produto/insumo, origem do requisito (`PRODUTO_SIMPLES` ou `FICHA_TECNICA`), quantidade/unidade consumida, distribuição fiscal/não fiscal e operação.
- `pedido_id` único no ledger impede consumo confirmado duplicado; `(empresa_id, chave)` na tabela de idempotência impede criação duplicada por retry. Repetir a chave com payload diferente é conflito. Pedido, consumo e chave são gravados na mesma transação.
- A confirmação do Motor Comercial e a porta pública de estoque recebem a mesma conexão/transação. O repositório preserva seu comportamento transacional padrão para outros callers e aceita o modo `jaEmTransacao` para o caller que já abriu a transação.
- O débito verifica o piso em `estoque_empresa` para a empresa correta e atualiza condicionalmente a linha empresarial. Não usa saldo agregado de outra empresa como fallback.
- Requisitos de ficha reutilizam `FichaTecnicaConsumoService.montarLinhasConsumo`; produto simples reutiliza configuração/MUC e conversões disponíveis, incluindo apresentação principal de venda. Relação ausente falha explicitamente como `CONVERSAO_NAO_DISPONIVEL`.
- Reserva não é tratada como débito físico. A operação coordena a confirmação do Motor Comercial e a liberação/marcação de reservas na mesma transação para não deixar reserva ativa duplicando estoque já consumido.

### Arquivos alterados

- `backend/services/pedido/PedidoConsumoEstoqueService.js`: ledger, idempotência, planejamento de requisitos, MUC e coordenação de consumo.
- `backend/services/pedido/PedidoOperacionalService.js`, `PedidoRepository.js`, `PedidoService.js` e `EntradaPedidoService.js`: orquestração atômica, gravação com transação do caller, conversão de orçamento, bloqueios após consumo e integração com criação legada.
- `backend/rotas/pedidos.js` e `backend/rotas/faturamento.js`: aceitação/propagação da chave de idempotência nos endpoints de criação.
- `frontend/erp/js/pedidos.js` e `frontend/erp/js/faturamento.js`: geração e reapresentação da chave nos retries.
- `backend/services/produtos/FichaTecnicaConsumoService.js`: associação dos requisitos aos itens do Pedido.
- `backend/services/estoque/EstoqueEmpresaService.js` e `backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js`: piso de saldo aplicado por empresa.
- `backend/services/estoque/pedidoReservaPonteNucleo.js` e `backend/services/vendas/VendaPagamentoService.js`: compatibilidade no faturamento de Pedido já consumido, sem repetir o débito.
- `tests/pedidos/pedido-consumo-estoque.test.js`: testes integrados direcionados do novo contrato.
- `tests/faturamento/rc3161-pedido-motor-comercial-mts.test.js`: fixture atualizado para estoque por empresa e expectativa arquitetural alinhada à delegação pelo serviço operacional.

### Testes executados

Todos foram executados sequencialmente, com `DB_DIR` direcionado a `%TEMP%\cds-test-pedido-consumo`; não foi executada a suíte integral:

- `tests/pedidos/pedido-consumo-estoque.test.js`: **10/10 aprovados**, incluindo ficha técnica, produto simples e conversão 2 L → 2.000 ml, apresentação principal, falha explícita sem relação MUC, idempotência, orçamento, bloqueios, rollback, isolamento empresarial, MTS/autorização de supervisor e dois débitos concorrentes em conexões SQLite separadas.
- `tests/faturamento/rc3161-pedido-motor-comercial-mts.test.js`: **9 cenários aprovados**, incluindo supervisor ausente/rejeitado/aprovado, transferência MTS, rollback, concorrência e liberação de reserva.
- `tests/pedidos/pedido-operacional-sprint-b1.test.js`: **3/3 aprovados**.
- `tests/muc/muc-04-ficha-consumo.test.js`: **29/29 aprovados**.
- `tests/estoque/consumo-reserva-pedido-porta-publica.test.js`: **passou** (teste do arquivo).
- `tests/estoque/pedido-disponibilidade-multiempresa.test.js`: **passou** (teste do arquivo).
- `tests/faturamento/sprint35-pedidos-ui.test.js`: **4/4 aprovados**.
- `tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js`: **passou** (teste do arquivo).
- `node --check`: passou nos 13 arquivos de produção anteriormente verificados e, após esta validação complementar, nos dois arquivos de teste diretamente alterados.

### Limitações e escopo preservado

- A falha foi injetada depois de cada um dos três débitos de insumo. Em cada ponto, foram verificados rollback de Pedido/itens, saldos globais e empresariais, ledger, idempotência, movimentações MTS, auditoria e reservas.
- A primeira execução da RC3.16.1 expôs fixture sem empresa/estoque empresarial e uma expectativa antiga de acoplamento direto em `PedidoService`; após alinhar fixture e assertiva ao contrato atual, os nove cenários passaram sem alterar código de produção.
- A baixa acionada pela tela de Pedido não exigiu alteração nesta validação funcional porque o caminho já estava conectado; cancelamento/estorno, edição compensatória, geração de venda e migração retroativa continuam fora do escopo.
- Não foram intencionalmente alterados XML ou regras fiscais, TEF ou pagamentos; a mudança em `VendaPagamentoService` limita-se à compatibilidade para não repetir consumo de estoque de Pedido já registrado.
- Nenhum banco oficial foi acessado ou migrado. Não houve commit, push, merge, reset ou descarte de alterações locais.

## Sprint 1 Funcional — verificação da ativação ao salvar

### Fluxo confirmado

```text
frontend/erp/js/pedidos.js salvarPedido()
  → POST /pedidos com Idempotency-Key e payload status PEDIDO
  → backend/rotas/pedidos.js
  → EntradaPedidoService.receber (exige chave e empresa)
  → PedidoOperacionalService.criar
       BEGIN IMMEDIATE
       PedidoRepository.criarPedido(... jaEmTransacao: true)
       se status confirmado: PedidoConsumoEstoqueService.registrarConsumo(...)
       grava chave idempotente e COMMIT
```

`statusExigeConfirmacaoFiscal` exclui `ORCAMENTO`; a conversão chama o mesmo serviço de consumo dentro da transação que muda o status. O consumo confirmado é detectado pelo ledger antes do faturamento: o fluxo de venda não executa outro débito físico nem outro consumo da ficha. Sem ledger, `consumo_confirmado` permanece falso e o caminho de venda legado continua habilitado. Pedidos já consumidos continuam bloqueados contra edição e cancelamento.

### Testes direcionados desta validação

Executados sequencialmente em banco isolado, com `DB_DIR` temporário. Não foi executada a suíte integral:

- `tests/pedidos/pedido-consumo-estoque.test.js`: **10/10 aprovados** — Pedido com vários itens, ingredientes sem baixa do produto final, volume/MUC, orçamento e conversão única, idempotência, rollback em cada débito, reserva, segunda baixa e bloqueios.
- `tests/pedidos/entrada-pedido-central.test.js`: **9/9 aprovados** — POST pelo caminho central, empresa correta e baixa confirmada, além de validação/rollback da entrada e rotas.
- `tests/pedidos/pedido-operacional-sprint-b1.test.js`: **3/3 aprovados** — persistência de itens, quantidades e preços efetivamente praticados.
- `tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js`: **35/35 cenários aprovados** — consumo de venda/ficha, estoque por empresa e prevenção de consumo duplicado.
- `node --check`: aprovado em `tests/pedidos/entrada-pedido-central.test.js`.

A primeira execução da entrada central encontrou expectativas anteriores à ativação (esperava ausência de baixa), chamadas sem `Idempotency-Key` e produto de fixture sem unidade comercial. A atualização foi restrita ao teste: passou a exigir a chave, validar o débito por empresa e usar unidade válida. A execução repetida passou integralmente.

### Arquivos alterados nesta validação

- `tests/pedidos/entrada-pedido-central.test.js`: expectativa obsoleta substituída por verificação da baixa já ativa; fixture completado com unidade comercial e chave de idempotência.
- `SPRINT-CONTRATO-CONSUMO-ESTOQUE-POR-PEDIDO.md`: registro do fluxo confirmado e dos resultados desta Sprint.

Nenhum arquivo de produção foi alterado. Os testes de migração executados pelo arquivo de entrada usaram exclusivamente o banco temporário; não houve migração de produção nem acesso ao banco oficial.

## Sprint 2 — cancelamento e estorno transacional

### Fluxo implementado

```text
POST /pedidos/:id/cancelar
  → frontend envia Idempotency-Key (preservada em tentativas na página)
  → rota valida empresa e encaminha operador/chave
  → PedidoOperacionalService.cancelar
       se não houver ledger: mantém o caminho legado de reservas/status
       se houver ledger:
         garantirSchema (DDL aditivo, sem migração retroativa)
         BEGIN IMMEDIATE na conexão do caller
         recarregar Pedido e validar empresa/estado
         bloquear qualquer venda vinculada após consultar venda e documentos
         creditar as quantidades imutáveis do ledger por empresa e classificação
         gravar cabeçalho/detalhes/solicitação idempotente do estorno
         atualizar status para CANCELADO
         COMMIT; qualquer erro → ROLLBACK
```

O crédito usa a porta pública `estoqueSaldosPublico.creditarSaldo`, sempre com a conexão da transação, `empresaId` do pedido e os valores `quantidade_fiscal`/`quantidade_nao_fiscal` do consumo original. Para produto com ficha, credita `insumo_id`; para produto simples, credita `produto_id`. Não consulta a ficha técnica atual nem recalcula conversões. As linhas de estorno preservam item de pedido, origem do requisito, produto/insumo, quantidade e unidade originais.

### Idempotência, venda e reservas

- `pedido_estoque_estornos` garante um estorno por pedido e por consumo; `pedido_estoque_estorno_itens` impede estornar duas vezes a mesma linha de consumo.
- `pedido_estoque_estorno_solicitacoes` registra a chave por empresa, hash da operação, Pedido e estorno. Repetir a mesma chave/operação retorna o resultado já registrado; reutilizar a chave para outro Pedido é rejeitado. A unicidade do estorno impede crédito duplicado mesmo se uma nova chave for enviada.
- O frontend mantém a chave enquanto a solicitação falhar e a remove após sucesso. Pedidos sem ledger continuam no caminho legado e não recebem estorno inventado.
- Quando `venda_id` está preenchido, o serviço consulta o estado da venda e os registros de NF-e/NFC-e. Nesta Sprint, qualquer venda vinculada bloqueia o cancelamento automático: estados fiscais autorizados/pendentes e indisponibilidade de verificação recebem erro explícito. A venda não é cancelada nem o estoque é devolvido por fora do fluxo comercial/fiscal.
- O fluxo de estorno não altera reservas. O teste de rollback compara as reservas antes/depois de falha injetada; o caminho legado segue liberando reservas com a conexão SQLite recebida.

### Arquivos alterados

- `backend/services/pedido/PedidoConsumoEstoqueService.js`: schema aditivo do estorno, leitura do ledger, créditos por saldo fiscal/não fiscal, trilha de auditoria e idempotência.
- `backend/services/pedido/PedidoOperacionalService.js`: estorno e mudança de status na mesma transação; bloqueio seguro de venda vinculada; encaminhamento da conexão nos caminhos legado e atualizado.
- `backend/rotas/pedidos.js`: encaminha empresa, operador e `Idempotency-Key`.
- `frontend/erp/js/pedidos.js`: gera e preserva a chave de cancelamento em tentativas.
- `tests/pedidos/pedido-consumo-estoque.test.js`: cobertura de cancelamento, retry, colisão de chave, isolamento por empresa, rollback após cada crédito, vínculo fiscal e orçamento sem ledger.
- `SPRINT-CONTRATO-CONSUMO-ESTOQUE-POR-PEDIDO.md`: registro do contrato e resultados.

### Testes executados

Execução sequencial e isolada com `DB_DIR` temporário; nenhuma suíte integral foi executada:

- `node --check` nos quatro arquivos JavaScript de produção alterados e no teste: aprovado.
- `node --test tests/pedidos/pedido-consumo-estoque.test.js`: **13/13 aprovados**.
- Cenários incluídos: cancelamento após conversão de orçamento; retry com mesma chave; colisão da chave em outro pedido; preservação de saldo de outra empresa; rollback após cada um de três créditos; preservação de Pedido, ledger original e reservas no rollback; bloqueio por venda com NFC-e autorizada; orçamento legado sem consumo.

Uma execução inicial expôs que o serviço de cancelamento perdia a conexão injetada ao reler o Pedido e liberar reservas. O caminho foi ajustado para encaminhar a mesma conexão; a suíte focada subsequente passou. A primeira tentativa direta de teste sem `DB_DIR` foi bloqueada pelo guard oficial do projeto; os testes foram então executados somente com diretório temporário.

### Limitações e escopo preservado

- Pedidos com venda vinculada permanecem bloqueados, inclusive quando a venda aparenta cancelada; reconciliar venda, estoque, recebimentos, TEF e documentos fiscais requer fluxo próprio aprovado.
- Não foram implementados cancelamento/estorno da venda, cancelamento fiscal, edição compensatória, baixa por interface, geração de venda, alteração de XML/tributos, TEF ou pagamentos.
- Os pedidos históricos sem ledger não recebem baixa ou estorno retroativo.
- As tabelas novas são criadas pelo mecanismo aditivo `garantirSchema` quando o serviço é usado; nenhuma migração foi executada no banco oficial. Nenhum banco oficial foi acessado. Não houve commit, push, merge, reset ou limpeza de arquivos.
- Sprint 2 foi encerrado para revisão; aguardar autorização antes do Sprint 3.

## Sprint 3 — Auditoria de integridade Pedido → consumo/estorno → venda

### Resultado executivo

**BLOQUEADO POR FALHA IDENTIFICADA NA INSPEÇÃO ESTÁTICA.** O fluxo real de faturamento não propaga o indicador `pedidoJaConsumido` para as chamadas que debitam os itens da venda. Portanto, não há garantia de impedir a segunda baixa quando uma venda é criada a partir de Pedido já consumido. O defeito não foi reproduzido em teste ponta a ponta; os testes de faturamento executados não exercitam essa chamada completa.

Nenhum arquivo de produção ou teste foi alterado. Os testes direcionados listados abaixo passaram em bancos temporários isolados, sequencialmente. Isso não elimina os cenários marcados como não testados nem a falha estática.

### Fluxos reais observados

```text
Pedido confirmado
  → PedidoOperacionalService.criar / converterParaPedido
  → BEGIN IMMEDIATE
  → Pedido + itens na conexão do caller
  → autorização/reserva Motor Comercial
  → baixa por empresa + ledger de consumo + idempotência
  → confirmação da reserva
  → COMMIT

Orçamento
  → sem consumo enquanto orçamento
  → conversão para Pedido no fluxo transacional acima

Cancelamento de Pedido consumido
  → BEGIN IMMEDIATE
  → bloqueio se houver venda vinculada
  → créditos conforme ledger imutável e empresa original
  → auditoria do estorno + status CANCELADO
  → COMMIT

Faturamento de Pedido
  → FaturamentoService.faturarPedido valida status
  → VendaPagamentoService grava venda/itens e tenta baixar estoque na transação da venda
  → COMMIT da venda
  → vínculo venda↔Pedido, consumo de reservas e status FATURADO em operações posteriores
```

O fluxo de criação/conversão e o estorno mantêm as operações de Pedido, estoque e ledger na mesma conexão/transação. Já o faturamento não envolve a venda, o vínculo, a coordenação final das reservas e o status do Pedido em uma única transação.

### Achados e riscos

| ID | Resultado | Evidência e risco |
|---|---|---|
| D02 | **Falha estática; sem reprodução ponta a ponta** | Em `VendaPagamentoService.js`, `pedidoJaConsumido` é obtido do crédito da reserva (perto da linha 981) e impede o novo consumo da ficha técnica (linhas 1077–1080). O guard que suprime a baixa física exige `opcoes.pedidoJaConsumido === true` (linhas 174–186), mas `opcoesBaixaEstoque` é montado sem essa propriedade (linhas 765–768) e é passado às baixas dos dois caminhos de venda (linhas 1316–1472 e 1700–1860). Assim, um Pedido simples pode ser baixado de novo; para produto com ficha, a baixa dos ingredientes é evitada, mas o produto final ainda pode ser baixado. |
| T01 | **Risco transacional** | `FaturamentoService.js` chama o núcleo que conclui a venda antes de atualizar `vendas.pedido_id`, consumir reservas e marcar o Pedido como faturado (linhas 262–300). Falha/crash entre essas etapas pode deixar venda e Pedido inconsistentes; falha ao marcar faturado retorna erro após a venda existir. Não há garantia transacional conjunta. |
| T02 | **Risco de concorrência não testado** | A validação do status ocorre antes da criação da venda. Não foi localizada unicidade de venda por `pedido_id` que impeça duas requisições simultâneas de faturarem o mesmo Pedido antes da atualização condicional do status. A corrida não foi reproduzida. |
| T03 | **Falha estática no tratamento de erro de reserva** | Em `VendaPagamentoService.js` (linhas 1065–1074), o callback de `consumirReservasPedidoNaVendaCb` não recebe nem verifica o erro e chama a continuação. A venda pode seguir para commit mesmo se a coordenação das reservas falhar parcialmente. Além disso, `FaturamentoService.js` captura erros de vínculo e de consumo de reservas e continua para marcar o Pedido faturado (linhas 262–300). |
| T04 | **Fallback silencioso** | `pedidoReservaPonteNucleo.js` (linhas 90–108) transforma qualquer falha da consulta de reservas em mapa vazio, não apenas ausência de tabela legada. Isso pode fazer o faturamento tratar erro de consulta como ausência de reserva/consumo confirmado. |
| T05 | **Classificação registrada** | `PedidoConsumoEstoqueService.js` grava `quantidade_fiscal = quantidade` e `quantidade_nao_fiscal = 0` no ledger (linhas 662–680); o estorno credita a classificação registrada, sem recalcular a ficha. A restauração de eventual distribuição anterior ao Motor Comercial/MTS não foi validada em cenário ponta a ponta de consumo, faturamento e estorno. |

### Matriz de cenários

| ID | Cenário | Resultado | Base |
|---|---|---|---|
| T01 | Criar Pedido confirmado e persistir Pedido, itens, consumo e ledger | **Passou** | `pedido-consumo-estoque.test.js` (13/13), `pedido-operacional-sprint-b1.test.js` (3/3). |
| T02 | Orçamento não baixa estoque antes da conversão; conversão consome uma vez | **Passou** | `entrada-pedido-central.test.js` (9/9) e `pedido-consumo-estoque.test.js` (13/13). |
| T03 | Rollback de falha durante consumo/estorno restaura os registros e saldos afetados | **Passou nos pontos injetados** | `pedido-consumo-estoque.test.js` (13/13), incluindo falha após cada um de três créditos do estorno. |
| T04 | Pedido histórico/legado sem ledger não recebe baixa ou estorno retroativo | **Passou nos casos cobertos** | `pedido-consumo-estoque.test.js` e `sprint31-faturamento.test.js` (8/8). |
| S01 | Produto com ficha técnica consome ingredientes, não o produto final, no serviço de consumo | **Passou no teste do serviço** | `consumo-ficha-tecnica-venda-03-04.test.js` (35 cenários internos); isso não cobre faturamento completo do Pedido. |
| S02 | Produto simples e conversão comercial para unidade de estoque | **Passou nos testes direcionados do contrato** | `consumo-reserva-pedido-porta-publica.test.js` (10 cenários internos); não exercita o débito real da venda originada pelo Pedido. |
| S03 | Piso de saldo e isolamento por empresa | **Passou nos casos cobertos** | `pedido-disponibilidade-multiempresa.test.js` (1/1) e `pedido-consumo-estoque.test.js` (13/13). |
| S04 | MTS e supervisão/autorização do Motor Comercial | **Passou parcialmente** | `rc3161-pedido-motor-comercial-mts.test.js` (9 cenários internos) e `rc412-ponte-reserva-pedido-nucleo.test.js` (5 cenários internos); são testes do Motor Comercial/ponte, não do faturamento ponta a ponta. |
| C01 | Cancelar e devolver quantidades a partir do ledger, sem recalcular a ficha atual | **Não testado ponta a ponta para todos os tipos de requisito** | Inspeção confirma leitura do ledger; testes cobrem rollback e cancelamento, mas não demonstram cancelamento bem-sucedido após alteração da ficha nem todos os casos de múltiplos ingredientes. |
| C02 | Falha após cada crédito não deixa estorno parcial | **Passou nos pontos injetados** | `pedido-consumo-estoque.test.js` (13/13), falha após cada um de três créditos. |
| C03 | Retry de cancelamento não credita estoque duas vezes | **Passou para repetição coberta** | `pedido-consumo-estoque.test.js` (13/13), retry com a mesma chave e colisão da chave em outro Pedido. |
| C04 | Pedido legado sem ledger mantém fluxo anterior | **Passou nos casos cobertos** | `pedido-consumo-estoque.test.js` (13/13). |
| C05 | Pedido com venda/documento fiscal vinculado é bloqueado sem estorno automático | **Passou no caso autorizado coberto** | `pedido-consumo-estoque.test.js` (13/13), bloqueio com NFC-e autorizada; outros estados de venda/documento não foram exercitados. |
| D01 | Repetição da criação/consumo não duplica Pedido ou débito | **Passou nos casos cobertos** | `pedido-consumo-estoque.test.js` (13/13) e `entrada-pedido-central.test.js` (9/9). |
| D02 | Faturar Pedido já consumido não realiza segunda baixa | **Falhou na inspeção estática; não testado em integração** | Propagação ausente de `pedidoJaConsumido` nas opções de `reduzirEstoqueDistribuido`. Os testes aprovados verificam o helper isolado ou simulam faturamento. |
| D03 | Duas requisições simultâneas de faturamento não criam vendas duplicadas | **Não testado** | Não foi executado cenário concorrente ponta a ponta. |

### Testes executados

Todos foram executados sequencialmente com `DB_DIR` temporário. Não foi executada a suíte integral nem acessado banco oficial:

- `node --test tests/pedidos/pedido-consumo-estoque.test.js` — **13/13 aprovados**.
- `node --test tests/pedidos/entrada-pedido-central.test.js` — **9/9 aprovados**.
- `node --test tests/pedidos/pedido-operacional-sprint-b1.test.js` — **3/3 aprovados**.
- `node --test tests/estoque/pedido-disponibilidade-multiempresa.test.js` — **1/1 aprovado**.
- `node --test tests/estoque/consumo-reserva-pedido-porta-publica.test.js` — runner aprovado; **10 cenários internos**.
- `node --test tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js` — runner aprovado; **35 cenários internos**.
- `node --test tests/faturamento/rc3161-pedido-motor-comercial-mts.test.js` — runner aprovado; **9 cenários internos**.
- `node --test tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js` — runner aprovado; **5 cenários internos**.
- `node --test tests/faturamento/sprint31-faturamento.test.js` — **8/8 aprovados**.

Os testes RC4.1.2 simulam a baixa/reserva e não invocam o caminho completo de faturamento do Pedido pelo núcleo de venda. Portanto, os resultados positivos não comprovam ausência de segunda baixa nem atomicidade entre venda, vínculo, reserva e status.

### Recomendação e limites

Antes de liberar o faturamento de Pedidos já consumidos, corrigir e testar a propagação do indicador de consumo confirmado até todas as chamadas de baixa de estoque, e definir a resposta a falhas na coordenação de reservas. Em seguida, validar atomicidade/idempotência do faturamento e concorrência por Pedido em banco isolado, incluindo produto simples, produto com ficha técnica, MTS e rollback após falhas em cada etapa.

Esta etapa foi somente auditoria: nenhum arquivo foi alterado, nenhum teste foi modificado, não houve venda real, migração, commit, push, merge, reset ou limpeza. Cancelamento fiscal, estorno de venda e mudanças de faturamento permanecem fora do escopo. **Parar e aguardar autorização antes de corrigir qualquer achado ou iniciar outro Sprint.**

## Sprint 3.1 — Correção direcionada da baixa duplicada

### Causa-raiz confirmada

`VendaPagamentoService` já consulta `obterCreditoReservaPedidoCb` usando o `pedido_id` enviado pelo payload e deriva `pedidoJaConsumido` de `creditoReserva.consumo_confirmado`. O contrato de `pedidoReservaPonteNucleo.obterCreditoReservaPedido` define esse indicador pela existência de uma linha em `pedido_estoque_consumos`; não é inferido da existência do Pedido ou de uma reserva ativa.

O resultado já era usado em `aposBaixaItensDaVenda` para não invocar novamente `FichaTecnicaConsumoService`, mas não era encaminhado a `reduzirEstoqueDistribuido`. Este helper aceita `opcoes.pedidoJaConsumido` e, quando verdadeiro, retorna sem baixar o saldo. Como as baixas dos caminhos de venda normal e a prazo compartilham `opcoesBaixaEstoque`, a causa confirmada era a ausência da atribuição do indicador do ledger nesse objeto.

### Alterações

- `backend/services/vendas/VendaPagamentoService.js`: após a consulta ao ledger, atribui o indicador calculado pelo resultado do ledger a `opcoesBaixaEstoque.pedidoJaConsumido`. As duas chamadas de baixa já recebem esse objeto; nenhuma assinatura ou regra do motor de estoque foi alterada.
- `tests/pedidos/pedido-consumo-estoque.test.js`: amplia o caso de consumo para dois ingredientes e um produto simples convertido por volume; verifica a propagação e as decisões de baixa/ficha, e acrescenta um caso de Pedido legado sem ledger para preservar o débito normal.
- `SPRINT-CONTRATO-CONSUMO-ESTOQUE-POR-PEDIDO.md`: registra a causa, evidência, validação e limites transacionais.

Não foram alterados `FaturamentoService`, classificação fiscal/não fiscal, conversões MUC, TEF, pagamentos, documentos fiscais nem contratos de cancelamento/estorno.

### Evidência e validação

- Com ledger confirmado, `opcoesBaixaEstoque` recebe `pedidoJaConsumido=true`; o helper de baixa retorna antes de debitar. A mesma condição de consumo já existente em `aposBaixaItensDaVenda` evita a segunda chamada à ficha técnica.
- O teste focado prepara um Pedido com dois ingredientes e um produto simples comercial por volume, verifica o ledger e os saldos após o consumo, e exercita o helper de baixa com o indicador confirmado para os produtos de venda. O teste também protege estruturalmente a atribuição e o desvio antes da chamada da ficha técnica.
- Para Pedido legado sem linha em `pedido_estoque_consumos`, `consumo_confirmado=false`; o helper continua no caminho normal e o teste confirma o débito físico esperado.
- Esses testes validam o contrato do ledger, a propagação no código e o comportamento do helper, mas não simulam a requisição completa `FaturamentoService → VendaApplicationService → VendaPagamentoService`. Portanto, não são uma reprodução ponta a ponta de faturamento.

### Testes executados

Execução sequencial com `DB_DIR` exclusivo e temporário por processo; sem acesso ao banco oficial:

Na primeira execução do teste de Pedido, a nova asserção do saldo por empresa encontrou a fixture sem linha de `estoque_empresa` para o produto com ficha. A fixture foi completada e a repetição passou; não foi uma falha de produção.

- `node --check backend\services\vendas\VendaPagamentoService.js` — aprovado.
- `node --check tests\pedidos\pedido-consumo-estoque.test.js` — aprovado.
- `node --test tests\pedidos\pedido-consumo-estoque.test.js` — **14/14 aprovados**.
- `node --test tests\faturamento\sprint31-faturamento.test.js` — runner aprovado (**8/8**).
- `node --test tests\faturamento\rc412-ponte-reserva-pedido-nucleo.test.js` — **5 cenários internos aprovados**.
- `node --test tests\estoque\consumo-reserva-pedido-porta-publica.test.js` — **10/10 aprovados**.
- `node --test tests\pastelaria\consumo-ficha-tecnica-venda-03-04.test.js` — **35 cenários internos aprovados**.
- `node --test tests\faturamento\rc3161-pedido-motor-comercial-mts.test.js` — runner aprovado; cenários direcionados de MTS/autorização executados.

### Transação, reservas e pendências

Na venda, o helper de baixa recebe a conexão SQLite `db` usada pelo núcleo. O consumo de ficha técnica recebe a mesma conexão e o consumo de reservas do Pedido também recebe esse `db`, sem abrir transação própria. Essas operações ocorrem dentro do `BEGIN IMMEDIATE` da venda e, quando erros são tratados pelos caminhos existentes, participam do rollback/commit dessa transação.

O limite não inclui o fluxo inteiro de faturamento: após o núcleo confirmar a venda, `FaturamentoService` atualiza o vínculo venda↔Pedido, consome reservas e marca o Pedido como faturado em operações posteriores. Os erros dessas operações posteriores continuam capturados e registrados como aviso; a atomicidade entre venda, vínculo e status, assim como concorrência/idempotência de múltiplos faturamentos, permanece pendente.

O callback de `consumirReservasPedidoNaVendaCb` no núcleo ainda não examina seu argumento de erro antes de continuar. A correção deste Sprint não alterou esse tratamento porque é independente da propagação de `pedidoJaConsumido`; o risco deve ser tratado em alteração autorizada própria. Os testes da ponte cobrem liberação bem-sucedida e erros retornados pelo serviço, mas não comprovam o encaminhamento do erro pelo callback do fluxo de venda.

**Recomendação: PARCIALMENTE VALIDADO.** A propagação foi corrigida e os testes de componente/contrato cobrem Pedido consumido e legado. Falta teste ponta a ponta do faturamento e permanecem os riscos transacionais e de erros de reserva descritos acima.

## Sprint 3.2 — Validação integrada do faturamento de Pedidos consumidos

### A. Resumo executivo

**BLOQUEADO POR DEFEITO CONFIRMADO.** O cenário A chegou ao `FaturamentoService.faturarPedido`, mas não concluiu a criação da venda. O serviço retornou `Núcleo não retornou venda válida.`; na sequência assíncrona do núcleo, a validação SQL também rejeitou o `INSERT INTO vendas` por desalinhamento entre colunas e valores. Não foi possível validar os saldos posteriores ao faturamento nem prosseguir com segurança para os demais cenários.

Não houve alteração em código de produção. O defeito não foi corrigido neste Sprint, conforme o limite de escopo.

### B. Evidência de consumo

O teste integrado isolado do cenário A criou um produto simples com saldo inicial de 10, confirmou um Pedido de quantidade 2 e, antes de faturar, verificou saldo fiscal da empresa igual a 8 e uma linha de consumo no ledger. Essas pré-condições passaram; a execução falhou ao chamar o faturamento, antes das asserções de saldo, venda e retry posteriores.

Portanto, não há leitura válida de saldo ou ledger após o faturamento nesta execução. Não se afirma que o produto deixou de sofrer segunda baixa com base em um faturamento concluído.

### C. Caminho percorrido e causa confirmada

O teste invoca diretamente `FaturamentoService.faturarPedido` (não faz uma requisição HTTP pela rota). O método consulta o Pedido, monta o contrato/contexto e chama `invocarNucleo`, que encaminha a criação para `VendaApplicationService.criarVendaComContexto` e `VendaPagamentoService`.

Foram confirmados dois problemas observáveis no caminho:

1. `invocarNucleo` resolve a promessa com `{ success: true }` se a promessa do núcleo terminar antes de `res.json`. O caminho de `VendaPagamentoService.criarVenda` pode retornar a promessa da resolução de empresa enquanto a chamada recursiva apenas inicia operações SQLite por callback; a promessa não aguarda a conclusão desses callbacks. `faturarPedido` recebe então uma resposta sem `id`/`venda_id` e rejeita com `Núcleo não retornou venda válida.`.
2. O núcleo tenta inserir a venda com 20 colunas, 18 placeholders e um literal, totalizando 19 slots para 19 valores. A certificação rejeita o comando: `InsertAlignmentError: INSERT desalinhado: colunas=20, placeholders=18, literais=1, slots=19, valores=19, tabela=vendas`. A falha ocorreu depois de `BEGIN IMMEDIATE` e antes de o fluxo registrar uma venda válida. A associação causal entre essa falha SQL e a resposta prematura não foi tratada como uma única causa: são evidências de dois problemas no mesmo fluxo assíncrono.

O defeito confirmado impede concluir o faturamento pelo teste integrado e torna inválidas como evidência as tentativas posteriores do primeiro ensaio amplo, que também foram afetadas pela falha da operação anterior.

### D. Auditoria transacional

- `VendaPagamentoService` inicia `BEGIN IMMEDIATE` na conexão SQLite singleton `db`. A baixa direta e os serviços de ficha técnica/reservas recebem esse mesmo objeto `db`; esses helpers não iniciam uma transação própria. Com o ledger confirmado, `pedidoJaConsumido` desvia a baixa direta e evita nova chamada de consumo de ficha técnica.
- O `INSERT INTO vendas` desalinhado acontece após o início da transação. Nesta reprodução, não houve callback de sucesso nem confirmação de venda. O teste não obteve um estado posterior confiável para afirmar se todos os efeitos da transação foram revertidos.
- A atomicidade não cobre o faturamento inteiro. Antes de chamar o núcleo, `FaturamentoService` persiste metadados fiscais do Pedido em operação separada. Depois do retorno do núcleo, atualiza o vínculo venda↔Pedido, consome reservas e marca o Pedido como faturado em operações posteriores, sem uma transação única com a transação da venda.
- O teste bloqueado não demonstrou rollback ponta a ponta para falhas antes da conclusão, durante a baixa/ficha ou durante liberação de reservas. Esses cenários permanecem sem validação integrada.

### E. Reservas

O contrato do wrapper `consumirReservasPedidoNaVendaCb` entrega erros ao callback. Porém, em `VendaPagamentoService`, o callback passado ignora o argumento e chama `next()` incondicionalmente. Assim, uma falha na operação de consumo/liberação das reservas pode permitir que o processamento da venda continue e alcance o commit com reservas inconsistentes. É um risco confirmado pela inspeção estática, mas não reproduzido por injeção de falha neste Sprint.

Além disso, no pós-processamento de `FaturamentoService`, erros de atualização do vínculo e de consumo das reservas são registrados em `console.warn` e o fluxo continua; a atualização final do status do Pedido ocorre depois, fora da transação da venda.

### F. Testes executados

- `node --test tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — primeira execução ampla não utilizável como validação: a fixture inicial enviava `tipo: 'pedido'`, prevalecendo sobre o status esperado. A fixture foi corrigida; as falhas em cascata daquela execução não são contadas como reproduções independentes.
- Execução isolada do teste `A — fatura produto simples sem segunda baixa; retry não cria nova venda`, no mesmo arquivo — **falhou** com `Núcleo não retornou venda válida.` e o `InsertAlignmentError` acima.
- O teste configura `DB_DIR` antes de carregar o módulo de banco e cria diretório temporário exclusivo por execução, no padrão `%TEMP%\cds-sprint32-faturamento-*`; não foi usado o banco oficial.
- Diretórios temporários observados nesta validação: `%TEMP%\cds-sprint32-faturamento-YvhkXU` e `%TEMP%\cds-sprint32-faturamento-HX53kQ`.
- Os cenários B, C, D e E (ficha técnica, Pedido misto, Pedido legado, repetição e falhas/reservas) não foram executados após a reprodução do defeito impeditivo. Não foi executada a suíte integral.

### G. Pendências

**Defeitos confirmados**

- A promessa de criação do núcleo pode resolver sem aguardar a conclusão do callback de venda, e o faturamento rejeita a resposta sem identificador.
- O `INSERT INTO vendas` usado no caminho exercitado falha na certificação por divergência entre colunas, placeholders e slots.

**Riscos identificados sem reprodução integrada**

- Erro da liberação/consumo de reservas é ignorado pelo callback do núcleo.
- O faturamento não compartilha uma única transação SQLite entre venda, vínculo, reservas e atualização do Pedido.
- Estado pós-falha do `BEGIN IMMEDIATE` e rollback integral não foram comprovados neste cenário.

**Lacunas de cobertura**

- Faturamento concluído para produto simples, ficha técnica e múltiplos itens; comportamento de Pedido legado; retry; rollback em cada etapa; e erro injetado na liberação de reservas.
- A rota HTTP de faturamento não foi exercitada; o teste chamou diretamente o serviço real de faturamento.

### H. Recomendação

**Não avançar para validação integral nem considerar o fluxo validado.** Corrigir e autorizar separadamente os dois defeitos impeditivos antes de retomar os cenários restantes. Aguardar autorização para qualquer correção de produção ou continuação do Sprint.

## Sprint 3.3 — Correção dos bloqueios do faturamento

### Causas e alterações

1. **Retorno prematuro:** `invocarNucleo` tratava a resolução da Promise devolvida por `VendaApplicationService` como conclusão da venda e fabricava `{ success: true }`. No núcleo, essa Promise pode resolver após iniciar o caminho recursivo de callbacks SQLite, antes de qualquer resposta real. O adaptador agora só resolve com o corpo passado a `res.json`; uma rejeição da Promise é propagada como erro, sem sucesso substituto. A chamada do núcleo continua sendo feita uma única vez. `nfeAvulsaService` tem um adaptador próprio semelhante e não foi alterado; não é chamado pelo faturamento de Pedido.
2. **`INSERT INTO vendas`:** o diff local preexistente havia acrescentado a coluna e o valor `valor_outros`, mas a lista `VALUES` ficou com apenas 18 placeholders para 19 parâmetros e 20 colunas, sendo `status` um literal. Foi acrescentado o placeholder final que associa `empresaIdVenda` a `empresa_id`. O comando passa a ter 20 slots (19 placeholders e um literal), correspondentes às 20 colunas e aos 19 parâmetros.

O diff local existente foi inspecionado antes da edição. As alterações preexistentes de cálculo financeiro, `valor_outros`, propagação de `pedidoJaConsumido` e demais ajustes dos serviços foram preservadas.

### Evidência após as correções e novo bloqueio

A execução filtrada do cenário A chegou mais longe que a reprodução anterior: não retornou `{ success: true }` prematuramente nem falhou na certificação do `INSERT INTO vendas`. O caminho prosseguiu até a inserção do item da venda, e a falha real dessa persistência foi entregue ao chamador com status 500 e etapa `insert_vendas_itens`. Isso demonstra que o adaptador aguardou a resposta efetiva do callback e que o desalinhamento original do cabeçalho foi corrigido em execução.

A operação, contudo, foi bloqueada por um terceiro problema, fora do escopo autorizado: `SQLITE_ERROR: table vendas_itens has no column named valor_nao_fiscal`. A instrução de inserção do item já inclui essa coluna, mas a definição de `vendas_itens` em `backend/database.js` não a cria. O fluxo não chegou às asserções finais de saldo, ledger, persistência da venda ou retry; não se considera o cenário A concluído nem se afirma ausência de segunda baixa. Esse problema não foi corrigido neste Sprint.

### Testes executados

- `node --check backend\services\faturamento\FaturamentoService.js` — aprovado.
- `node --check backend\services\vendas\VendaPagamentoService.js` — aprovado.
- `node --check tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — aprovado.
- `node --test --test-name-pattern='A — fatura produto simples' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — falhou no novo bloqueio `vendas_itens.valor_nao_fiscal`, após a criação do cabeçalho da venda chegar ao callback de inserção dos itens.
- `DB_DIR` temporário observado: `%TEMP%\cds-sprint32-faturamento-iBj3bK\mercadao.db`. Não foi usado o banco oficial.
- Os cenários B–E e os testes focados anteriores não foram executados após a identificação do novo defeito, conforme a regra de parar e documentar quando o fluxo avança para outro bloqueio. O teste de falha direta do `INSERT INTO vendas` foi adicionado, mas ainda não executado.

### Estado final, limitações e recomendação

As correções dos dois defeitos solicitados estão no código e têm evidência parcial em execução: o cabeçalho avançou para a próxima etapa e os erros de persistência foram observados no chamador, sem resposta de sucesso fictícia. Não foi comprovada a persistência final da venda nem passaram as asserções do cenário A, pois o erro de schema em `vendas_itens` interrompeu a transação.

Permanecem sem validação integrada a comparação final de saldos e ledger, a unicidade após retry, os cenários de ficha técnica/itens múltiplos/legado, os testes focados prévios e a falha direta injetada no cabeçalho. Também permanecem as limitações de atomicidade entre faturamento e pós-processamento e o callback de reservas que ignora erros, já descritos no Sprint 3.2.

**Classificação: BLOQUEADO.** Não considerar o faturamento funcional. O novo problema de schema deve ser avaliado e autorizado antes de continuar a validação; não foi feita correção fora do escopo deste Sprint.

## Sprint 3.4 — Correção da persistência dos itens da venda

### Causa-raiz e contrato confirmado

O INSERT normal de `VendaPagamentoService` persiste `item_fiscal`, quantidades fiscais/não fiscais e valores fiscais/não fiscais por item. Leituras de financeiro e de documentos fiscais também selecionam `vendas_itens.valor_nao_fiscal`. O campo, portanto, faz parte do contrato de persistência existente; removê-lo do INSERT descartaria um dado utilizado pelo modelo.

A inicialização global já adicionava `quantidade_fiscal`, `quantidade_nao_fiscal` e `valor_fiscal` em `vendas_itens`, mas omitia `valor_nao_fiscal`. O serviço de materialização MUV já garantia os dois campos de valor com `REAL DEFAULT 0`. A incompatibilidade foi corrigida adicionando a coluna faltante à sequência aditiva `aplicarAlteracoesPosCriacao`, junto à migração de `valor_fiscal`. Não houve alteração de valores, classificação, tabelas históricas ou dados; registros existentes recebem a semântica padrão zero usada pelos campos equivalentes. A alteração é não destrutiva e foi exercitada somente em bancos temporários.

### Arquivos alterados

- `backend/database.js`: adicionada a migração segura `ALTER TABLE vendas_itens ADD COLUMN valor_nao_fiscal REAL DEFAULT 0`. As demais alterações locais preexistentes do arquivo foram preservadas.
- `tests/faturamento/sprint32-pedido-consumido-integracao.test.js`: o cenário A agora verifica valores e quantidades fiscais/não fiscais persistidos e igualdade do ledger antes/depois; os testes focados E0/E1 verificam propagação de falhas e rollback.
- `SPRINT-CONTRATO-CONSUMO-ESTOQUE-POR-PEDIDO.md`: registra diagnóstico, impacto e evidências desta validação.

Não foram alterados novamente nesta Sprint `FaturamentoService.js` nem `VendaPagamentoService.js`; as correções assíncronas e do INSERT do cabeçalho da Sprint 3.3 foram preservadas.

### Resultado do cenário A

**Aprovado em banco temporário isolado**, com o caminho `FaturamentoService → VendaApplicationService → VendaPagamentoService` concluindo até as verificações finais.

- Banco: `%TEMP%\cds-sprint32-faturamento-qAaW4j\mercadao.db`.
- Pedido `1`, empresa `1`, produto simples `1`, quantidade vendida `2`, total `10`.
- Saldo antes de faturar, após consumo do Pedido: `8` unidades fiscais na empresa e no saldo global. Saldo depois do faturamento: `8` em ambos; `estoque_atual=8` e reserva fiscal `0`. Um gatilho de teste também impediu qualquer segunda redução do saldo durante a venda.
- Ledger antes/depois: mesma linha de consumo, Pedido `1`, empresa `1`, item `1`, produto `1`, origem `PRODUTO_SIMPLES`, quantidade `2 UN`, fiscal `2`, não fiscal `0`.
- Venda persistida: ID `1`, código `VND-20261023151245`, status `concluida`, origem `FATURAMENTO`, `pedido_id=1`, `empresa_id=1`, total `10`; o Pedido terminou `FATURADO` com `venda_id=1`.
- Item persistido: produto `1`, quantidade `2`, `item_fiscal=1`, quantidade fiscal `2`, não fiscal `0`, valor fiscal `10`, não fiscal `0`.
- O retry do mesmo Pedido foi rejeitado com status 409 e a contagem continuou em uma venda vinculada.

Assim, o cenário A demonstra a resposta efetiva com identificador real, persistência do cabeçalho e do item, vínculo Pedido/empresa e ausência de segunda baixa do produto simples.

### Testes executados

Todos foram executados sequencialmente; os testes integrados criaram um `DB_DIR` exclusivo antes de carregar o módulo de banco.

- `node --check backend\database.js` — aprovado.
- `node --check tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — aprovado.
- `node --test --test-name-pattern='A — fatura produto simples' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **1/1 aprovado**, inclusive persistência dos valores fiscais/não fiscais, saldo, ledger, vínculo e retry.
- `node --test --test-name-pattern='E0 — falha no INSERT da venda' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **1/1 aprovado**; o erro real chegou ao chamador e o pedido/estoque/ledger permaneceram sem alterações parciais.

## Personalização dos ingredientes da ficha técnica

A personalização comercial é opt-in por produto, configurada por `permite_personalizacao_ingredientes`. Cada componente da ficha recebe uma classificação:

- `OBRIGATORIO_OCULTO`: integra a receita e o consumo sem aparecer como escolha do operador. É o padrão das linhas preexistentes.
- `OPCIONAL`: aparece na seleção e só é consumido quando selecionado.
- `OPCIONAL_COM_ADICIONAL`: também é opcional; quando selecionado, acrescenta ao preço unitário o adicional cadastrado na ficha.

O Pedido envia a escolha e o preço-base unitário. O backend valida os IDs escolhidos contra a ficha ativa do produto persistido, recalcula o preço unitário com os adicionais autoritativos da ficha e valida os subtotais e o total. O preço enviado pela interface não é autoridade para o valor dos adicionais. Preço-base ausente, nulo, vazio, negativo ou não finito é rejeitado; zero explícito permanece válido. Produtos sem a opção habilitada mantêm o comportamento anterior.

`pedidos_itens` guarda a opção de personalização e os snapshots de preço-base e adicionais unitários. `pedido_item_ingredientes` guarda, por item do Pedido, identificação e nome do insumo, quantidade, unidade, classificação, seleção e adicional unitário. A edição e a reabertura leem os snapshots já persistidos; itens personalizados mantêm escolhas e preços históricos quando não são alterados. A conversão para Pedido e a edição também passam a usar o banco injetado ao reler e atualizar o registro, preservando o isolamento usado por testes e transações.

No consumo, os itens obrigatórios e os opcionais selecionados são enviados ao serviço de consumo da ficha e usam o MUC já existente. O consumo permanece na transação operacional do Pedido, com isolamento de saldo por empresa e rollback de pedido, itens, snapshots, ledger, reservas e saldos em falha. Ficha válida sem personalização conserva a baixa anterior de todos os componentes; a personalização só restringe os opcionais quando está habilitada.

A interface de produtos permite habilitar a personalização e classificar cada linha, definindo adicional apenas para `OPCIONAL_COM_ADICIONAL`. A interface do Pedido abre a seleção em duas colunas de opcionais, mantém o preço-base editável, mostra o adicional unitário e os componentes selecionados no item e na impressão. Componentes obrigatórios/ocultos não são expostos como opção.

### Validação desta entrega

Executados em bancos temporários:

- `node --check` dos 12 arquivos JavaScript alterados — aprovado após os últimos ajustes.
- Testes focados de personalização (`pedido-consumo-estoque.test.js`, nomes “persiste a personalização...” e “rejeita seleção inválida...”) — **2/2 aprovados**, incluindo recálculo, edição/reabertura, consumo seletivo, rollback, nova tentativa e idempotência.
- Arquivo completo `tests/pedidos/pedido-consumo-estoque.test.js` — **19/20 aprovados**. A única falha é uma asserção estática preexistente que exige o trecho `consumirReservaPedidoAposBaixa(vendaId, continuar)` em `VendaPagamentoService`; a implementação atual retorna diretamente nesse ponto. O comportamento de faturamento não foi alterado e o teste não foi modificado para mascarar a divergência.
- `tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js` — **1/1 aprovado**.
- `tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js` — falha em três verificações do contrato estático/validação legado (T12 código esperado para insumo inativo, T13 código esperado para quantidade inválida e T29 ordem textual da transação); **32/35 verificações internas passaram**. Nenhuma dessas falhas foi alterada ou mascarada nesta entrega.

A validação de operação no Electron ainda está pendente; esses testes não comprovam o carregamento da nova interface nem o comportamento de uma instalação empacotada. É necessário iniciar a versão reconstruída/atualizada com as migrações aditivas habilitadas e confirmar um Pedido real de teste antes de declarar a entrega operacionalmente validada.
- `node --test --test-name-pattern='E1 — falha ao inserir item da venda' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **1/1 aprovado**; rollback preservou saldo, ledger e status do Pedido, sem venda vinculada.
- `node --test tests\faturamento\sprint31-faturamento.test.js` — **8/8 aprovados**.
- `node --test tests\vendas\venda-application-service.test.js` — **2/2 aprovados**.
- Diretórios temporários dos testes integrados: `%TEMP%\cds-sprint32-faturamento-qAaW4j`, `%TEMP%\cds-sprint32-faturamento-5LrLHH` e `%TEMP%\cds-sprint32-faturamento-YqqYde`. Não houve acesso ao banco oficial nem execução de migração de produção.

Os cenários B–D e E2–E4 não foram executados; não foi executada a suíte integral.

### Limitações e classificação

As limitações transacionais do faturamento fora do núcleo e o callback de reservas que ignora erros permanecem conforme documentado no Sprint 3.2; não foram modificados nem validados por estes testes. A cobertura desta entrega comprova o cenário A e os dois caminhos focados de rollback, não todos os cenários da validação integrada.

**Classificação: CORRIGIDO E VALIDADO PARA O CENÁRIO A E OS ROLLBACKS E0/E1.** O bloqueio de schema foi removido e a persistência relevante foi verificada em banco temporário. Não se declara validado o faturamento de todos os cenários.

## Sprint 3.5 — Validação progressiva do faturamento de Pedidos

### Critérios e execução

O relatório anterior registrava B–D e E2–E4 como lacunas, sem repetir seus critérios detalhados. Conforme autorização recebida para esta Sprint, foram usadas as asserções já existentes no teste integrado como fonte dos critérios. Foi executada novamente a regressão A e, em seguida, somente o primeiro cenário pendente, B. Não foram iniciados C, D ou E2–E4.

- **A — regressão obrigatória:** faturar produto simples já consumido; saldo fica inalterado, venda/item/vínculo são persistidos e retry não cria outra venda.
- **B — cenário liberado:** Pedido de produto com ficha técnica ativa com dois ingredientes; o consumo original é registrado no ledger, o faturamento não reduz novamente o saldo do produto final nem dos ingredientes, não cria consumo de ficha da venda e mantém o ledger.

### Resultados e evidências

- Regressão A: `node --test --test-name-pattern='A — fatura produto simples' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **1/1 aprovado** em `%TEMP%\cds-sprint32-faturamento-58sCwq`.
- Cenário B: `node --test --test-name-pattern='B — fatura ficha técnica' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **1/1 aprovado** em `%TEMP%\cds-sprint32-faturamento-QMxdjZ`.

No banco temporário de B, Pedido `1` (empresa `1`) faturou na venda `1`, código `VND-20261023160051`, total `10`, status `concluida`, com vínculo `pedido_id=1` e `empresa_id=1`. O Pedido terminou `FATURADO` e guardou `venda_id=1`; a venda contém um item do produto final, quantidade `2`.

| Produto | Saldo inicial | Após consumo do Pedido / antes do faturamento | Depois do faturamento | Reserva após faturar |
|---|---:|---:|---:|---:|
| Produto final “S32 receita” | 15 | 15 | 15 | 0 |
| Farinha | 1000 | 940 | 940 | 0 |
| Queijo | 500 | 480 | 480 | 0 |

Os valores de saldo global e por empresa coincidiram em cada medição. O teste instalou gatilhos que rejeitariam qualquer nova redução; o faturamento concluiu e os snapshots antes/depois foram iguais. O ledger conservou exatamente dois requisitos de ficha técnica: farinha `60 G` e queijo `20 G`, ambos fiscais, associados ao Pedido/empresa. A tabela `venda_ficha_consumo` não recebeu linhas para a venda. A quantidade e os valores do item persistido foram fiscais (`quantidade_fiscal=2`, `valor_fiscal=10`) e não fiscais iguais a zero.

### Alterações, limitações e classificação

Nenhum código de produção ou teste foi alterado nesta validação; somente este relatório foi atualizado. Os bancos usados foram temporários e isolados, sem acesso ao banco oficial. Não foram executados cenários C, D ou E2–E4.

**Classificação: VALIDADO PARA A REGRESSÃO A E O CENÁRIO B.** A ausência de segunda baixa foi comprovada para produto simples (A) e produto com ficha técnica e dois ingredientes (B). O faturamento completo, os cenários restantes e os riscos de atomicidade do pós-processamento e tratamento de erro de reservas continuam sem validação própria. Parar aqui e aguardar autorização antes de avançar.

## Sprint 3.6 — Validação isolada do cenário C

### Definição e critérios utilizados

O cenário C da validação integrada cobre um Pedido misto com produtos simples, produtos com ficha técnica e ingrediente compartilhado/repetido. Os critérios operacionais são os do teste existente: comparar os saldos e o ledger após o consumo do Pedido e após faturar; verificar que a venda contém os três produtos e que o faturamento não volta a consumir estoque nem ficha técnica.

O teste também exige que os itens da venda estejam na mesma ordem do Pedido. Essa asserção foi mantida sem alteração, conforme a regra de não alterar critérios. A descrição original do cenário C exige comparar os registros de venda, mas não explicita uma ordem de persistência.

### Testes executados

- Regressão A: `node --test --test-name-pattern='A — fatura produto simples' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **1/1 aprovado**, em `%TEMP%\cds-sprint32-faturamento-fTTqY9`.
- Cenário C: `node --test --test-name-pattern='C — mantém saldos e ledger' tests\faturamento\sprint32-pedido-consumido-integracao.test.js` — **0/1 aprovado; bloqueado** pela asserção de ordem de itens, em `%TEMP%\cds-sprint32-faturamento-v7U0dS`.

Não foram executados B, D ou E2–E4 nesta Sprint.

### Evidências do cenário C

O Pedido `1` (empresa `1`, total `30`) foi faturado na venda `1`, código `VND-20261023160703`, status `concluida`, origem `FATURAMENTO`, vínculo `pedido_id=1` e `empresa_id=1`. O Pedido terminou `FATURADO`, com `venda_id=1`; existe uma única venda vinculada e três itens da venda, correspondentes aos três produtos do Pedido.

| Produto | Saldo inicial | Após consumo do Pedido / antes do faturamento | Após faturamento | Reserva fiscal após faturar |
|---|---:|---:|---:|---:|
| Receita A | 12 | 12 | 12 | 0 |
| Receita B | 9 | 9 | 9 | 0 |
| Produto simples | 20 | 17 | 17 | 0 |
| Ingrediente compartilhado | 1000 | 955 | 955 | 0 |
| Ingrediente exclusivo da receita A | 700 | 690 | 690 | 0 |

Os saldos fiscais/não fiscais globais e por empresa foram consultados após a execução; os valores globais e empresariais coincidiram, e os saldos não fiscais permaneceram em zero. Os saldos depois do faturamento coincidem com os snapshots feitos imediatamente antes dele. O ledger consultado contém quatro linhas: ingrediente compartilhado `20 G` para a receita A, ingrediente exclusivo `10 G` para a receita A, ingrediente compartilhado `25 G` para a receita B e produto simples `3 UN`. Essas quantidades correspondem ao consumo original do Pedido. `venda_ficha_consumo` contém zero linhas para a venda.

### Bloqueio reproduzível

A execução percorreu o faturamento e passou pelas verificações de saldo, obtendo a venda e os itens persistidos. Falhou na comparação de sequência da lista de produtos: o teste esperava `[1, 2, 3]` (receita A, receita B, produto simples), mas a consulta dos itens da venda em ordem de ID retornou `[3, 2, 1]`. A falha é reproduzível no teste isolado; não foi comprovado se a ordem é um contrato funcional ou apenas uma expectativa mais restritiva da asserção. O ponto exato que inverte a ordem ainda não foi isolado e não foi alterado.

Como o teste interrompeu nas verificações de ordem, as consultas pós-execução ao banco temporário foram feitas em modo somente leitura para registrar saldos, ledger, vínculo, status, itens e ausência de consumo de ficha técnica. O cenário não exercitou retry; a regressão A continua sendo a evidência de retry. Nenhum código de produção ou teste foi alterado nesta Sprint; somente este relatório foi atualizado.

**Classificação do cenário C: BLOQUEADO.** Os saldos e o ledger não indicam consumo duplicado, mas a asserção existente sobre a ordem dos itens falhou. Não foram corrigidos código nem critérios e não foram iniciados D ou E2–E4. Parar e aguardar autorização.

## Sprint 3.8 — Captura da ordem dos itens no faturamento

### Inicialização do banco temporário

A tentativa anterior que excedeu 90 segundos foi executada com um preload global `NODE_OPTIONS`/`--require` para interceptar módulos. O output registrou o timeout de `whenReady` e uma atividade assíncrona com `SqlCertificationError`; não demonstrou que a inicialização normal do SQLite levasse 90 segundos. A interação interna que fez aquele preload perder a prontidão não foi isolada.

Na execução desta Sprint, sem preload global, o banco isolado `C:\Users\cicer\AppData\Local\Temp\cds-sprint32-faturamento-2P9G94\mercadao.db` ficou pronto: o módulo carregou em `66 ms`, os sinais de inicialização ocorreram em `478 ms`, `2010 ms` e `2346 ms`, e `whenReady` concluiu em `2144 ms`. O faturamento de C levou aproximadamente `268 ms`. Portanto, o tempo de inicialização foi separado do tempo do cenário; o timeout anterior foi específico à tentativa de instrumentação via preload, embora a causa interna dessa interferência permaneça sem diagnóstico.

### Execuções

- Com instrumentação temporária, `node --test --test-name-pattern="C — mantém saldos e ledger" tests\faturamento\sprint32-pedido-consumido-integracao.test.js`: o banco inicializou e C percorreu o faturamento. **0/1 aprovado**, falhando somente na ordem; esperava `[1, 2, 3]`, observou `[1, 3, 2]`.
- Após remover toda instrumentação, o mesmo comando foi executado novamente em banco novo, `C:\Users\cicer\AppData\Local\Temp\cds-sprint32-faturamento-yZA4kJ\mercadao.db`: **1/1 aprovado**, duração total `7.87 s`, cenário `254 ms`.

O segundo resultado não invalida a captura do primeiro: o comportamento observado depende da ordem de conclusão das gravações, como demonstrado abaixo. A validação de C é, portanto, instável e não deve ser considerada confiável enquanto a persistência não tiver ordenação determinística.

### Sequência capturada

Correlação da execução instrumentada: `3ef54ae8-ac8e-4132-a79a-a73a0e5a9b26`.

| Fronteira | Sequência de produtos |
|---|---|
| Identidades do cenário | `1=RECEITA_A`, `2=RECEITA_B`, `3=SIMPLES`, `4=INSUMO_COMPARTILHADO`, `5=INSUMO_EXCLUSIVO_A` |
| Pedido criado e leitura do `PedidoRepository` | IDs de item `1,2,3` → produtos `[1,2,3]` |
| Entrada e saída de `montarPayloadVendaDoPedido` | `[1,2,3]` → `[1,2,3]` |
| Entrada do `VendaApplicationService` e núcleo | `[1,2,3]` |
| Entrada de `VendaPagamentoService.criarVenda` | `[1,2,3]` nas duas entradas observadas (resolução do contexto financeiro e chamada efetiva) |
| Entrada e saída do distribuidor | `[1,2,3]` → `[1,2,3]` |
| Lista antes da persistência | `[1,2,3]` |
| Chamadas de INSERT submetidas | `#1 produto 1`, `#2 produto 2`, `#3 produto 3` |
| Callbacks de INSERT concluídos | `#1 produto 1`, `#2 produto 3`, `#3 produto 2` |
| Consulta final `ORDER BY id` | `id 1 → produto 1`, `id 2 → produto 3`, `id 3 → produto 2` |

As quantidades e parâmetros principais nas três chamadas foram, respectivamente: produto `1`, `2 UN`, subtotal/valor fiscal `10`; produto `2`, `1 UN`, subtotal/valor fiscal `5`; produto `3`, `3 UN`, subtotal/valor fiscal `15`. Todos foram classificados como fiscais, sem quantidade ou valor não fiscal. Os IDs das linhas de Pedido estavam disponíveis antes da montagem do payload; o payload de venda não transporta esses IDs.

### Primeira transição e causa comprovada

A primeira fronteira divergente é a execução dos INSERTs: a lista e as chamadas submetidas continuam em `[1,2,3]`, mas os callbacks completam em `[1,3,2]`; a consulta final mostra os IDs de linha atribuídos nessa mesma ordem efetiva. Assim, `ORDER BY id` recupera fielmente os registros persistidos e não cria a divergência.

O núcleo de `VendaPagamentoService` inicia `BEGIN` e o cabeçalho dentro de `db.serialize(() => ...)`, mas os INSERTs dos itens são submetidos dentro do callback assíncrono do INSERT do cabeçalho, depois que a função passada a `serialize` já retornou. No driver instalado `sqlite3`, `Database::Serialize` restaura imediatamente o estado anterior ao fim da execução síncrona do callback; o estado inicial é `serialize=false`. Consequentemente, as chamadas de INSERT dos itens são executadas em modo paralelo e podem concluir em ordem diferente da submissão. Não há chamada de `parallelize` no backend que explique o caso; o modo paralelo decorre do estado padrão restaurado.

Isso explica tanto a captura atual `[1,3,2]` quanto o resultado anterior `[3,2,1]`. O teste limpo que passou demonstra que a corrida não falha em toda execução; não elimina a condição de ordenação não determinística.

### Instrumentação e estado final

Foram instrumentados temporariamente `backend/database.js`, `backend/services/pedido/PedidoRepository.js`, `backend/services/faturamento/FaturamentoService.js`, `backend/services/vendas/VendaApplicationService.js`, `backend/services/vendas/VendaPagamentoService.js` e `tests/faturamento/sprint32-pedido-consumido-integracao.test.js`. A instrumentação apenas registrou IDs, parâmetros, etapas e tempos; não reordenou nem modificou os arrays. Todos os logs, alterações de consulta e medições temporárias foram removidos. Uma busca pelos marcadores `SPRINT38_TRACE_ID`, `sprint38` e `S3.8` não encontrou sobras, e `node --check` passou nos seis arquivos após a remoção.

Nenhuma correção de produção, mudança de critério ou avanço para D/E2–E4 foi feito. O menor ajuste a avaliar, sujeito a autorização, é garantir serialização/encadeamento explícito dos INSERTs de itens, preservando a ordem de entrada; depois, repetir C e a regressão A.

**Resultado da investigação: CONCLUSIVO — corrida de ordenação entre submissão e conclusão dos INSERTs. Cenário C permanece BLOQUEADO para fechamento funcional, pois a ordem atual é não determinística. Aguardar autorização antes de corrigir.**

## Sprint 3.10 — Auditoria arquitetural do núcleo transacional do faturamento

### Escopo e resultado

Auditoria estática e somente leitura. Não foram executados testes, comandos Git, consultas ao banco, alterações de código/testes/schema ou operações no banco oficial. A versão instalada foi confirmada em `node_modules/sqlite3/package.json`: `sqlite3` **5.1.6**. O relatório é o único arquivo desta entrega que deve ser atualizado.

Conclusão arquitetural: para a primeira correção de ordenação/atomicidade do núcleo de venda, a opção de menor alcance seguro é uma **conexão SQLite exclusiva por operação de faturamento**, com a mesma instância de conexão injetada em todos os helpers que participam da transação. Isso evita que outra operação use a mesma conexão SQLite durante o ciclo da venda. Não garante, por si só, a atomicidade do pós-processamento de Pedido executado depois do commit em `FaturamentoService`; esse limite deve permanecer explícito até aprovação de uma etapa que altere a ownership da transação.

Um coordenador global também é viável, mas não como uma fila adicionada somente a `VendaPagamentoService` nem como uma fila que proteja apenas chamadas `BEGIN`. Para garantir exclusividade na conexão compartilhada, seria preciso coordenar também as consultas e escritas legadas que poderiam ser submetidas enquanto outra operação mantém uma transação aberta, propagar o contexto transacional pelos helpers/repositórios e definir comportamento de reentrada. A busca textual abaixo encontrou 28 arquivos; a inspeção distinguiu SQL transacional direto, transação delegada a helper e menções documentais.

### Mapa da conexão e ciclo do faturamento

#### Conexão compartilhada

- `backend/database.js` resolve e valida `DB_DIR`/`DB_PATH` por `exigirAberturaDatabaseModule()` antes de criar o diretório ou abrir o SQLite. O mesmo módulo instala o guardião SQLite, instancia `new sqlite3.Database(DB_PATH)`, atribui `db.dbDir`/`db.dbPath` e exporta essa instância singleton.
- No callback de abertura, a conexão compartilhada agenda `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=30000` e `PRAGMA foreign_keys=ON`, e inicia a inicialização do schema. `db.whenReady()` é o ponto de prontidão do módulo. Os `PRAGMA`s são enviados sem callbacks de conclusão individuais; uma futura fábrica de conexões deve encadear e verificar sua própria configuração antes de devolver a conexão pronta.
- A certificação SQL é aplicada à instância exportada por `aplicarCertificacaoSql(db)`. Uma conexão adicional não deve contornar essa certificação nem o guardião de caminhos; a criação precisa ocorrer por uma fábrica do próprio módulo de banco, a partir do `db.dbPath` já validado.
- Não foi localizado encerramento da conexão exportada no ciclo normal do backend/Electron. As ocorrências de `db.close()` no backend são de scripts utilitários; o handler `will-quit` do Electron fecha o gerenciador de equipamentos, não o SQLite. Uma conexão por operação, portanto, requer ownership explícita e fechamento após a conclusão de todas as queries e do callback final de `COMMIT`/`ROLLBACK`.
- `foreign_keys` e `busy_timeout` são configurações por conexão. `journal_mode=WAL` é persistente no arquivo. Uma conexão nova deve habilitar/verificar `foreign_keys`, configurar seu próprio `busy_timeout` e confirmar o journal mode, sem tentar trocar o journal mode no meio de uma transação. Não há `PRAGMA synchronous` explícito no trecho de inicialização examinado.

#### Caminho real e fronteiras

```text
FaturamentoService.faturarPedido
  → lê Pedido/status e atualiza metadados fiscais antes do núcleo (fora da transação da venda)
  → monta payload com pedido_id e itens na ordem lida do repositório
  → VendaApplicationService (fachada; não possui conexão nem transação)
  → VendaPagamentoService.criarVenda
       → valida e calcula/distribui itens; consulta crédito/consumo do Pedido
       → BEGIN IMMEDIATE na conexão singleton
       → INSERT do cabeçalho
       → INSERTs de vendas_itens enviados por forEach/callbacks
       → baixa/FEFO, recebimentos, consumo de ficha/ledger e/ou consumo de reservas,
         conforme o estado e o tipo de item
       → COMMIT solicitado pelo núcleo
  → FaturamentoService, depois da resposta do núcleo, usa a conexão singleton:
       → atualiza vendas.origem/pedido_id
       → tenta consumir reservas
       → marca Pedido como FATURADO
```

Fatos relevantes:

1. `VendaApplicationService` apenas encaminha ao núcleo; ele não cria uma transação compartilhável pelo faturamento.
2. `FaturamentoService` verifica o estado do Pedido antes da venda. A atualização do vínculo da venda, a segunda tentativa idempotente de consumir reservas e `PedidoRepository.marcarFaturado` ocorrem depois do retorno do núcleo. A atualização de vínculo e o consumo de reservas capturam erro com `console.warn` e continuam; o status final do Pedido também não pertence à transação de `VendaPagamentoService`.
3. O payload do Pedido contém `pedido_id`. `VendaPagamentoService` consulta a reserva/ledger antes da distribuição. Quando `consumo_confirmado` é verdadeiro, configura `pedidoJaConsumido`: a função de baixa direta não debita novamente e a etapa de pós-baixa não consome outra vez a ficha; a ponte de reserva pode marcar as reservas como consumidas. Esses serviços recebem uma conexão por parâmetro/opção, mas no fluxo atual recebem o singleton.
4. O núcleo faz `db.serialize(() => { ... })` para submeter `BEGIN IMMEDIATE` e o `INSERT` do cabeçalho. O driver restaura `serialize` ao valor anterior imediatamente quando o callback síncrono retorna (`node_modules/sqlite3/src/database.cc`, `Database::Serialize`; inicialização `serialize=false` em `database.h`). O loop de itens ocorre depois, em callback assíncrono, e usa `forEach`; a captura da Sprint 3.8 já demonstrou submissão `[1,2,3]`, callbacks `[1,3,2]` e leitura final `ORDER BY id` `[1,3,2]`.
5. No caminho à vista, o `COMMIT` é enviado sem callback de conclusão antes da resposta. O helper `gravarRecebimentos` usa a conexão global e é callback-based; o chamador inicia essa cadeia sem aguardar sua conclusão antes de continuar o processamento dos itens. Os `INSERT`s do loop de itens não são encadeados sequencialmente. A etapa de estoque dos itens só incrementa o contador quando seu callback conclui, mas isso não ordena os IDs dos INSERTs já enviados.
6. A ponte de reservas é chamada com callback que não recebe/propaga erro no núcleo; o fluxo chama a continuação. A ficha técnica recebe `db` explicitamente e propaga erro. Esses comportamentos e os riscos de pós-processamento já registrados acima não foram alterados nem revalidados nesta auditoria.
7. A atomicidade comprovável na primeira etapa pode cobrir apenas os comandos que usam a mesma conexão e cujo callback/Promise de sucesso é aguardado antes do commit. TEF, integração externa e o pós-processamento posterior não passam automaticamente a participar de uma transação SQLite.

### Classificação dos pontos transacionais encontrados

A pesquisa `BEGIN IMMEDIATE|BEGIN TRANSACTION|BEGIN;` encontrou 28 arquivos. Em dois deles, a ocorrência é documental/de delegação, não um `BEGIN` SQL próprio: `MotorComercialService` recebe/delega `executarEmTransacao`, e `ReservaSaldoFiscalCategoriaService` reutiliza a fila de `SaldoFiscalCategoriaService`. As demais entradas abaixo são fluxos distintos; a presença de `BEGIN` não significa que todos tenham o mesmo defeito ou usem necessariamente a mesma instância: os serviços com `db`/`deps.db`/`params.db` dependem da conexão fornecida pelo chamador.

| Arquivo | Fluxo e ownership da conexão | Risco real de interferência |
|---|---|---|
| `backend/services/vendas/VendaPagamentoService.js` | Núcleo PDV/FATURAMENTO usa `require('../../database')`; quatro blocos transacionais no módulo. | **Direto e comprovado no faturamento**: `serialize` não cobre callbacks posteriores; itens são submetidos em paralelo; recebimentos não são aguardados; commit não tem callback neste caminho. |
| `backend/services/vendas/VendaCancelamentoService.js` | Cancelamento usa o singleton; dois blocos com callbacks assíncronos dentro de `serialize`. | Pode disputar a mesma conexão com venda/faturamento. O callback de `BEGIN` não mantém exclusividade contra outros chamadores da conexão. |
| `backend/services/vendas/VendaDevolucaoService.js` | Devolução usa o singleton e processa itens por callbacks encadeados após `BEGIN`. | Pode disputar a conexão do núcleo; não há coordenador compartilhado visível neste serviço. |
| `backend/services/vendas/VendaFinanceiroService.js` | Serviço usa singleton; `cancelarFinanceiroVenda` abre transação própria, salvo `gerenciarTransacao:false`. | Transação própria não está coordenada com `VendaPagamentoService`; a opção explícita de não gerenciar permite participação na transação do caller, mas não cria isolamento por si só. |
| `backend/services/entrega/CriarVendaEntregaService.js` | Criação de venda de entrega importa o singleton; transação callback-based. | Outra escrita de venda na mesma conexão; não é o cenário C, mas pode conflitar se concorrer com faturamento. |
| `backend/services/entrega/MotorFinalizacaoVenda.js` | Finalização de entrega importa o singleton e usa `BEGIN`/`COMMIT` via Promises; lock em memória é por `vendaId`. | O lock por venda evita duplicidade da mesma prestação, não serializa transações distintas da conexão. |
| `backend/services/pedido/PedidoOperacionalService.js` | Aceita `opcoes.db`, com fallback a `dbPadrao`; criação/alteração/confirmação usam transação e `await`s. | As operações internas são sequenciais, mas não há fila por conexão. Chamadas concorrentes com o singleton podem colidir no `BEGIN`; há caminho externo que repassa a mesma conexão ao Motor/estoque. |
| `backend/services/pedido/PedidoRepository.js` | Repositório aceita conexão injetada e por padrão usa singleton; `criarPedido` aceita `jaEmTransacao`, outros métodos abrem transação própria. | Bom ponto de injeção/reuso explícito; sem coordenador entre chamadas independentes. `marcarFaturado` é pós-processamento e, sem `opts.db`, volta ao singleton. |
| `backend/motores/comercial/MotorComercialService.js` | O fluxo aceita conexão/executor injetados e propaga `txDb` aos serviços de estoque/MTS. | A confirmação pode reutilizar a transação do caller; o helper padrão abre transação. A ocorrência de `BEGIN` no arquivo é comentário, não SQL local. |
| `backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js` | `executarEmTransacao` aceita `opts.db` ou singleton e aguarda `work(db)` antes de commit. | As operações próprias são aguardadas, mas não há fila compartilhada com outros módulos quando a mesma conexão é injetada. |
| `backend/services/fiscalNaoFiscal/reservasPublico.js` | Aceita `db` e tenta abrir transação própria; ao detectar erro “cannot start a transaction within a transaction”, assume que deve reutilizar a transação existente. | Reuso é útil quando explicitamente chamado dentro do caller, mas a mensagem de conexão ocupada não identifica ownership: numa conexão global sem coordenador, pode confundir uma transação concorrente não relacionada com uma transação pai intencional. |
| `backend/services/produtos/FichaTecnicaConsumoService.js` | Não abre `BEGIN`; recebe `db` explicitamente e usa-o nas leituras/débitos/ledger. | Participa da transação certa se receber o mesmo objeto de conexão; se algum helper voltar ao singleton por omissão, a operação fica fora do limite pretendido. |
| `backend/services/estoque/pedidoReservaPonteNucleo.js` | Não abre transação própria; aceita `opts.db` para consulta/consumo de reserva. | Participa da transação do caller quando a conexão é passada. Algumas leituras tratam tabela legada ausente como compatibilidade; erros não relacionados são propagados na API Promise. |
| `backend/services/vendas/SaldoFiscalCategoriaService.js` | Usa fila `WeakMap` por conexão para as operações próprias, com `BEGIN IMMEDIATE`; rejeita transação externa ativa. | A fila protege somente métodos deste serviço; não coordena vendas, rotas ou outros serviços que usam a mesma conexão. |
| `backend/services/vendas/ReservaSaldoFiscalCategoriaService.js` | Reutiliza `executarEmTransacao` de `SaldoFiscalCategoriaService`; não emite seu próprio `BEGIN`. | Herda a fila local de Saldo Fiscal, não uma fila global da conexão. A ocorrência textual é comentário/documentação. |
| `backend/services/fiscal/empresasConfiguracaoFiscal.js` | Transação por `deps.db`; APIs de configuração fiscal recebem/injetam a conexão. | Condicional à conexão passada; o helper não prova que seja privada. Operações de configuração não pertencem ao faturamento do Pedido, mas podem compartilhar o singleton. |
| `backend/services/produto-embalagem/ProdutoEmbalagemService.js` | A instância recebe `db` no construtor (`this.db`); uma operação usa `BEGIN TRANSACTION`. | Risco condicionado a instâncias construídas com o singleton. O fluxo usa callbacks e não tem coordenação global. |
| `backend/services/importacao-inicial-produtos/importer.js` | Importação recebe `db` como argumento e faz transação com Promises/loops sequenciais. | A transação local é ordenada; poderá bloquear/colidir se o chamador fornecer a conexão compartilhada durante faturamento. |
| `backend/services/importacao-inicial-produtos/quantidadeUpdater.js` | Atualização de quantidades recebe `db` como argumento e faz transação com Promises/loops sequenciais. | Mesmo risco condicional de conexão; operação administrativa não tem fila comum com vendas. |
| `backend/motores/muv/AtendimentoMultiempresaService.js` | Cinco operações recebem `deps.db` ou recorrem ao singleton e executam transações assíncronas. | Sem fila compartilhada; concorrência depende da conexão escolhida. Não participa do faturamento do Pedido, mas pode compartilhar o singleton. |
| `backend/motores/bancario/services/ConciliacaoBancariaService.js` | Recebe `db` por parâmetro; possui `WeakMap`/fila própria no módulo. | Serializa operações de conciliação entre si na mesma instância, não com faturamento nem com os outros módulos bancários. |
| `backend/motores/bancario/services/ContaBancariaService.js` | Recebe `db` por parâmetro; dois fluxos transacionais diretos. | Não foi localizada fila por conexão no serviço; risco condicional ao uso do singleton. |
| `backend/motores/bancario/services/ConsentimentoOpenFinanceService.js` | Recebe `db` por parâmetro; fila `WeakMap` local. | Protege operações do próprio módulo, não os demais consumidores do banco. |
| `backend/motores/bancario/services/SincronizacaoBancariaService.js` | Recebe `db` por parâmetro; fila `WeakMap` local. | Protege sincronizações deste módulo, não o faturamento nem transações externas à fila. |
| `backend/motores/mcf/services/ContasPagarService.js` | Recebe `db` por parâmetro; `withTx` executa transação própria sem fila por conexão visível. | Risco condicional à conexão recebida; fora do fluxo funcional do Pedido. |
| `backend/rotas/caixa.js` | Importa o singleton; quatro transações de caixa em callbacks. | Competidor direto na conexão do backend; vários callbacks continuam após `serialize`. |
| `backend/rotas/compras.js` | Importa o singleton; três transações de compra/devolução com callbacks assíncronos. | Competidor potencial; não está coordenado com venda, mesmo que escreva tabelas distintas. |
| `backend/rotas/contas_receber.js` | Importa o singleton; transação de baixa de recebimento encadeia atualizações/inserções. | Pode concorrer com o núcleo e com o financeiro; uso de `serialize` não é mutex de transação. |
| `backend/rotas/financeiro.js` | Importa o singleton; dois fluxos transacionais. | Pode concorrer com venda/financeiro; serialização síncrona do callback não isola a sequência assíncrona. |
| `backend/utils/centralEntradasEmpresaHelpers.js` | Recebe `db`; transação de backfill/reconstrução de identidade documental. | Risco condicional à conexão injetada e à execução concomitante; é manutenção documental, não parte do faturamento. |

Fora dos 28 resultados da busca, `FaturamentoService` é essencial ao limite de atomicidade: não inicia `BEGIN`, mas lê/atualiza por padrão via conexão singleton e executa operações antes/depois do núcleo. `VendaApplicationService` é uma fachada sem conexão. O teste `tests/faturamento/sprint32-pedido-consumido-integracao.test.js` configura `DB_DIR` temporário antes de carregar `backend/database.js`; ele cobre A/B/C/E1 e é adequado para regressões focadas, mas nenhum teste foi executado nesta auditoria.

### Alternativa A — conexão exclusiva para a operação de faturamento

**Viabilidade confirmada no nível do driver/arquivo.** `sqlite3` 5.1.6 permite abrir outra instância `Database` para o mesmo arquivo. A factory deve usar o `db.dbPath` já validado, aguardar `db.whenReady()` da conexão principal para garantir schema disponível e executar a configuração própria antes de liberar o handle. Não deve criar outro `DB_DIR`, copiar o banco, nem consultar o caminho oficial.

Com `BEGIN IMMEDIATE`, a conexão exclusiva obtém o lock de escrita do arquivo SQLite. Outras conexões escritoras não passam a integrar a transação da venda: aguardam o lock ou falham com `SQLITE_BUSY`/erro equivalente após seu próprio timeout. Com WAL, leitores de outras conexões podem seguir lendo o snapshot committed anterior. Isso é isolamento entre conexões, não exclusão de leitores nem garantia de atomicidade automática de efeitos fora do arquivo.

Condições necessárias:

1. Configurar e verificar `PRAGMA foreign_keys=ON` e `busy_timeout` para cada conexão; verificar `journal_mode=WAL`, já configurado no arquivo pela conexão principal. Aplicar também `aplicarCertificacaoSql` e manter a barreira do caminho. Tratar falha ao abrir/configurar como erro explícito, sem fallback para a conexão global.
2. Passar a conexão exclusiva explicitamente pelo cabeçalho, recebimentos, itens, pagamentos/financeiro que forem parte do limite, baixa/FEFO, consumo de ficha/ledger e consumo de reservas. `FichaTecnicaConsumoService`, `debitarEstoqueItemVenda`, a ponte de reserva e vários repositórios já aceitam conexão; `gravarRecebimentos` atualmente captura a global e precisa de uma opção/conexão explícita para uso transacional.
3. Encadear cada `INSERT INTO vendas_itens` com `await`/callback antes do próximo, preservar o array de entrada e aguardar todos os demais efeitos SQL antes do `COMMIT`. No erro, esperar o `ROLLBACK` concluir antes de responder; preservar erro original e também registrar erro do rollback/close, sem retorno de sucesso prematuro.
4. Fechar a conexão depois que não houver statement pendente e após sucesso, erro, validação tardia ou rollback. A API callback-based atual não oferece um `finally` simples: recomenda-se que o núcleo tenha uma operação interna Promise que devolva resultado/erro e que o adaptador HTTP responda e feche a conexão fora dela.
5. Revalidar status/vínculo/idempotência do Pedido sob o lock de escrita. A leitura do status ocorre antes do núcleo e não há evidência de unicidade por `pedido_id`; duas requisições simultâneas podem passar pela validação antiga. Um `BEGIN IMMEDIATE` na nova conexão serializa os escritores, mas não corrige decisões feitas com leitura prévia obsoleta.

**Limite de atomicidade:** se todo o núcleo e seus helpers receberem a mesma conexão, cabeçalho, itens e efeitos de estoque/ledger/reservas que terminam antes do commit poderão ser revertidos juntos. A atualização do vínculo venda↔Pedido, a segunda tentativa de reserva e `marcarFaturado` continuam fora disso enquanto forem executadas depois do retorno do núcleo por `FaturamentoService` na conexão global. Portanto, a conexão exclusiva não resolve T01/T03 nem a idempotência concorrente por Pedido automaticamente; não se deve anunciar atomicidade comercial ponta a ponta.

### Alternativa B — coordenador transacional compartilhado

Um helper por conexão com `WeakMap` e fila pode serializar operações que chamem esse helper. O projeto já tem exemplos locais: `SaldoFiscalCategoriaService`/`ReservaSaldoFiscalCategoriaService` e algumas rotinas bancárias. Esses mecanismos não são compartilhados entre módulos e, portanto, não coordenam suas transações com `VendaPagamentoService`.

Para uma garantia real na conexão comum, o contrato precisaria:

- Ter um owner por conexão, adquirir o lock antes de `BEGIN`, liberá-lo em `finally` após commit/rollback e propagar erro/timeout/cancelamento. Uma fila que comece apenas no `BEGIN` não basta: uma query enviada por outro fluxo durante a transação ainda pode ser executada na mesma conexão.
- Roteiar **todas** as operações enquanto houver transação ativa pelo contexto/handle correto, inclusive chamadas diretas a `db.run/get/all/prepare`, ou impedir que o singleton aceite operações externas à transação até sua liberação. As APIs atuais misturam métodos callback (`db.serialize`, `db.run`), Promises e helpers com fallback implícito para `require('../../database')`.
- Propagar um contexto transacional explícito aos repositórios e serviços. Subserviços devem reutilizar o handle do caller ou rejeitar uso aninhado; não inferir ownership apenas da mensagem de erro “cannot start a transaction within a transaction”, como faz o fallback de `reservasPublico`.
- Definir nested transaction com contrato claro (preferencialmente reutilização explícita pelo contexto; `SAVEPOINT` apenas se houver necessidade definida) e impedir que commit/rollback de serviço filho finalize a transação do caller. Evitar reentrância na fila, que pode causar deadlock se uma operação já dentro da transação tentar adquirir novamente o mesmo lock.
- Migrar os pontos diretos dos módulos listados e os helpers/repositórios que fazem SQL fora do wrapper. A busca por 28 arquivos é um inventário inicial, não a totalidade das chamadas a `db`; um coordenador só nos 28 `BEGIN` deixa consultas e escritas diretas sem owner. A migração gradual pode existir, mas não oferece garantia global até que os acessos legados estejam bloqueados ou roteados.

O benefício é manter uma conexão e um contrato único para serviços que já a recebem por injeção. O custo/risco é transversal: callback chains e integração de caixa, compras, financeiro, vendas, estoques, fiscal, bancos, importadores, MUV e MCF podem passar a esperar por um lock global. São necessários limites de fila, timeout e métricas para evitar espera indefinida, além de testes de compatibilidade para chamadas aninhadas e callbacks. **Não é seguro** tratar as filas locais existentes como prova de que a conexão inteira já está coordenada.

### Matriz de comparação

| Critério | A. Conexão exclusiva do faturamento | B. Coordenador da conexão compartilhada |
|---|---|---|
| Isolamento entre transações | Forte para a transação que usa exclusivamente o novo handle: outras conexões não entram na transação SQLite. Escritores disputam o lock do arquivo; leitores WAL podem observar apenas estado committed anterior. | Forte somente depois que todos os acessos concorrentes à conexão compartilham o owner/contexto. Uma fila de `BEGIN` isolada não basta. |
| Atomicidade | Cabeçalho/itens e efeitos que usem o handle exclusivo e aguardem sucesso podem compartilhar rollback. Não inclui automaticamente pós-processamento de `FaturamentoService`, TEF ou efeitos externos. | Pode unificar serviços na mesma transação se todos receberem/reutilizarem o mesmo handle e o commit tiver um owner único. Não inclui efeitos externos não transacionais. |
| Impacto em arquivos | Localizado: factory/ownership em `database.js`, núcleo `VendaPagamentoService`, helpers que hoje capturam db global, e possivelmente a fronteira do `FaturamentoService` em fase posterior. | Alto: os 28 caminhos pesquisados e as operações diretas sem `BEGIN`, além de repositórios/helpers que dependem da conexão global. |
| Complexidade | Média/alta no núcleo: lifecycle, injeção de db, sequência/espera de callbacks, busy handling e fechamento. Menor alcance de regressão. | Muito alta: contexto/lock, migração callback e Promise, reentrância, nested tx, bloqueio de SQL legado e timeout. |
| Compatibilidade | Os helpers de estoque/ficha/reserva e `PedidoRepository` já aceitam `db` em vários pontos; `gravarRecebimentos` e acessos implícitos precisam ser adaptados. | Conserva a instância comum, mas altera a semântica/espera de consultas de vários consumidores legados. |
| Risco de regressão | Moderado: conexão sem pragmas/certificação, falha de abertura/close, `SQLITE_BUSY`, helper que acidentalmente usa singleton. | Alto: regressões e deadlocks em módulos não relacionados; serviço não migrado pode continuar usando a conexão dentro da transação de outro owner. |
| Estratégia de testes | Focada no núcleo e em uma conexão concorrente, com DB_DIR temporário novo; assertar ordem por `ORDER BY id`, commit/rollback, estoque/ledger/reserva e fechamento. | Além das regressões do faturamento, testes de concorrência cruzada para cada família de transação e guard que prove bloqueio/roteamento de SQL legado. |
| Implantação gradual | Sim, por fluxo de faturamento, sem alegar que o pós-processamento existente se tornou atômico. | Só em modo compatível/sombra durante migração; garantia global apenas após completar cobertura e impedir bypasses. |
| Limitações residuais | Pós-processamento do Pedido permanece fora do núcleo; leituras pré-lock podem ficar obsoletas; SQLite continua com um escritor por vez. | Não tem garantia se qualquer operação compartilhada acessar `db` sem coordenador/contexto; a lista de `BEGIN` sozinha não cobre o sistema. |

### Recomendação e plano de implementação após aprovação

**Recomendo A, com delimitação explícita em duas fases.** A primeira fase deve resolver determinismo e atomicidade do núcleo da venda com conexão por operação. É a forma mais pequena de impedir que caixa/compras/financeiro/Pedido — ou outra transação na conexão singleton — sejam incorporados acidentalmente ao `BEGIN` da venda, sem reformar esses módulos. `BEGIN IMMEDIATE` na conexão dedicada coordena o lock de escritor no mesmo arquivo SQLite; a ordem dos itens continua sendo garantida pelo encadeamento sequencial, não pela existência de uma conexão nova.

#### Fase 1 — núcleo da venda

- Criar fábrica no módulo de banco que só abra `db.dbPath` já validado, aguarde a prontidão do schema, aplique certificação SQL, configure foreign keys/busy timeout e confirme o modo WAL. A factory deve rejeitar falha de configuração e não retornar o singleton como fallback.
- Tornar explícita a ownership da conexão na operação `VendaPagamentoService.criarVenda`; passar o mesmo handle para os helpers e evitar qualquer fallback ao singleton dentro do limite transacional.
- Refatorar a persistência do núcleo para fluxo sequencial verificável: `BEGIN IMMEDIATE` confirmado → cabeçalho → cada item em ordem, aguardando callback → operações de estoque/ledger/reserva necessárias, aguardando todas → demais INSERTs pertencentes ao contrato da venda, aguardados → `COMMIT` confirmado. Qualquer falha antes de commit aciona rollback aguardado. Só então responder sucesso/erro e fechar a conexão.
- Preservar a decisão `pedidoJaConsumido`: para Pedido com consumo confirmado, não baixar novamente produto/ingredientes; apenas concluir o estado de reserva previsto. Para legado sem ledger, manter o caminho anterior de venda. Não mudar classificação fiscal/não fiscal nem payload de itens.
- Revalidar o Pedido sob a transação/lock antes de persistir venda e definir idempotência concorrente em contrato. A conexão exclusiva não deve ser considerada suficiente para retry simultâneo.

#### Fase 2 — vínculo e pós-processamento do Pedido

Manter como limite conhecido, sem alegar solução nesta fase: `vendas.pedido_id`, `pedidos.status='FATURADO'` e parte da coordenação de reservas são executados após o commit do núcleo. Para atomicidade ponta a ponta, requer-se decisão e mudança de ownership: uma operação de aplicação de faturamento deve possuir o handle/contexto e envolver persistência da venda, vínculo, consumo de reservas e status do Pedido numa única unidade transacional, ou adotar um protocolo durável idempotente de recuperação. O núcleo atual responde via adaptador HTTP antes de `FaturamentoService` completar esse pós-processamento, então isso não se obtém apenas adicionando uma conexão em `VendaPagamentoService`. A aprovação dessa fase deve considerar `PedidoRepository` (reuso de transação), erros hoje registrados e ignorados, retries e comportamento fiscal/financeiro já existentes; não alterar Motor Fiscal/XML/TEF sem novo contrato.

#### Testes e critérios de aceite para futura implementação

Todos os testes devem usar DB_DIR novo e temporário por processo, configurado antes de carregar `backend/database.js`; nenhuma suíte integral ou banco oficial:

1. C original, mantendo a asserção da ordem; repetir sequencialmente em bancos novos e confirmar `ORDER BY id` igual à ordem de entrada.
2. Regressões A e B, sem alterar critérios; validar venda, itens, empresa e vínculo ao Pedido, status e retorno do núcleo.
3. E1 com falha injetada em item intermediário: aguardar erro e verificar ausência de cabeçalho/itens/parciais financeiros, saldo fiscal/não fiscal global e por empresa, reservas, ledger e status do Pedido idênticos ao estado anterior.
4. Verificar todos os campos fiscais/não fiscais e valores por produto, assegurando que sequência/encadeamento não desprenda dados de seu item.
5. Verificar que a conexão da venda recebe `foreign_keys=1`, timeout previsto e journal mode esperado; simular erro ao abrir/configurar, no INSERT, no `COMMIT`, no `ROLLBACK` e no close; provar que não há handle pendente após sucesso ou falha.
6. Teste concorrente entre faturamento e uma escrita iniciada por outra conexão: demonstrar espera/`SQLITE_BUSY` conforme timeout e ausência de alterações dessa operação dentro da venda; acrescentar concorrência de duas tentativas para o mesmo Pedido e comprovar idempotência/revalidação.
7. Teste específico para o limite da Fase 2: uma falha após a venda e antes do vínculo/status deve ser classificada como risco de pós-processamento, não como rollback já garantido pelo núcleo.

**Decisões pendentes de aprovação:** confirmar a conexão exclusiva como desenho da Fase 1; aprovar o limite de atomicidade do núcleo versus ponta a ponta; definir a política para `SQLITE_BUSY`/retry e faturamento concorrente do mesmo Pedido; aprovar separadamente se a Fase 2 deve unificar venda, vínculo, reservas e status ou usar recuperação idempotente. Nenhuma implementação foi iniciada nesta Sprint.

**Classificação da Sprint 3.10: AUDITORIA CONCLUÍDA — recomendação fundamentada, implementação pendente de aprovação arquitetural.**

## Sprint 3.11A — Correção da colisão de código e validação transacional

### Causa e correção da colisão

`VendaPagamentoService.criarVenda` gera o código com `agoraLocalBrasil()`, que retorna data e hora local até segundos, e remove os separadores para formar `VND-YYYYMMDDHHmmss`. A coluna `vendas.codigo` continua protegida por `UNIQUE`. Assim, duas criações no mesmo segundo produziam o mesmo valor e a segunda era rejeitada. A falha foi reproduzida determinísticamente com relógio fixado no teste de colisão.

A correção mantém o código-base no formato existente quando disponível. Dentro da conexão exclusiva, depois de `BEGIN IMMEDIATE` e antes do cabeçalho, o núcleo consulta a disponibilidade e, se necessário, seleciona `VND-YYYYMMDDHHmmss-01`, `-02` e assim por diante. A transação de escrita serializa a seleção entre conexões SQLite; a restrição `UNIQUE` permanece como proteção final. Não houve alteração de schema nem tratamento que ignore erros de unicidade. A autorização para o sufixo condicional foi confirmada pelo Product Owner.

A busca no repositório encontrou a geração `VND-` nos dois caminhos do `VendaPagamentoService`; os demais consumidores internos exibem, transportam ou registram `venda.codigo`, sem parser do formato. Exemplos e contrato foram atualizados em [ARQUITETURA_PAGAMENTOS.md](./docs/arquitetura/ARQUITETURA_PAGAMENTOS.md) e [NUCLEO_TRANSACIONAL_VENDA_V1.md](./docs/arquitetura/NUCLEO_TRANSACIONAL_VENDA_V1.md).

### Persistência e rollback

Os caminhos à vista e a prazo usam a conexão exclusiva no arquivo definido por `DB_DIR`. Ela aguarda a prontidão do banco, aplica a certificação SQL, configura e verifica `busy_timeout`, foreign keys e WAL. Cada fluxo executa e aguarda `BEGIN IMMEDIATE`, cabeçalho, recebimentos, gravações dos itens em sequência de entrada, pagamentos e gravações financeiras antes de aguardar `COMMIT`. Falhas fatais aguardam `ROLLBACK`, preservam o erro original e acrescentam ao erro informações de eventual falha no rollback ou fechamento.

E1 e E1b injetam erro de INSERT e confirmam a propagação da mensagem original. E1b falha no segundo item, depois de o primeiro ter sido submetido sequencialmente. Em ambos os casos, os testes verificam que as contagens de vendas e itens não aumentaram e comparam antes/depois os saldos, ledger de consumo, reservas, vínculo com venda e status do Pedido. O estado do Pedido permanece `AGUARDANDO_FATURAMENTO`.

### Testes executados

Todos os testes foram executados por seletores focados do arquivo [sprint32-pedido-consumido-integracao.test.js](./tests/faturamento/sprint32-pedido-consumido-integracao.test.js), cada caso em processo e banco temporário isolados; as dez repetições de C usaram dez novos diretórios `DB_DIR`. Também foram executados `node --check` em `backend/database.js`, `backend/services/vendas/VendaPagamentoService.js` e no arquivo de teste.

| Verificação | Resultado |
|---|---|
| `node --check` nos três arquivos | 3/3 aprovados |
| Conexão exclusiva: mesmo arquivo, WAL, foreign keys e busy timeout | 1/1 aprovado |
| Colisão de código com relógio fixo | 1/1 aprovado; `VND-20261023120000` e `VND-20261023120000-01` |
| Cenário C original | 1/1 aprovado; ordem por `ORDER BY id` permaneceu `[receita A, receita B, produto simples]` |
| Dez repetições de C em bancos novos | 10/10 aprovadas |
| Regressão A | 1/1 aprovada |
| Regressão B | 1/1 aprovada |
| Falha de INSERT de item, E1 | 1/1 aprovado; nenhuma venda/item parcial permaneceu |
| Falha no segundo item, E1b | 1/1 aprovado; cabeçalho e primeiro item foram revertidos |

A e B mantiveram seus critérios originais. C preservou a ordem dos itens, os saldos e o ledger, sem baixa ou consumo duplicado da ficha técnica. E1 e E1b comprovaram rollback por ausência de registros parciais e igualdade dos snapshots do estado antes/depois. O teste de configuração verificou a conexão aberta e fechada pelo caso; não foi injetada falha artificial no callback de fechamento ou no próprio comando `ROLLBACK`.

### Limites e riscos remanescentes

A classificação como VALIDADA aplica-se ao núcleo transacional e aos cenários autorizados nesta Sprint. Não significa atomicidade ponta a ponta. O vínculo `vendas.pedido_id`, a atualização do status do Pedido e efeitos de finalização de reserva feitos por `FaturamentoService` após o commit continuam fora da transação exclusiva; falhas nessa etapa não desfazem a venda já confirmada. O helper de reserva chamado pelo núcleo recebe a conexão da transação, mas seu wrapper mantém o comportamento não fatal existente e não propaga erro do callback. O tratamento de falhas de vinculação TEF também continua não fatal e é registrado em log.

Não foram executados D, E2–E4, a suíte integral, migrações ou operações Git; não foi acessado banco oficial. `PedidoOperacionalService.js`, regras fiscais, schema e dependências permaneceram sem alteração.

**Estado final:** A — VALIDADO; B — VALIDADO; C — VALIDADO; Sprint 3.11 — **VALIDADA**, dentro dos limites acima.

## Sprint 3.12 — Auditoria do pós-processamento do Pedido

### Sequência efetiva confirmada

O fluxo real contém dois momentos de consumo de reserva do Pedido:

1. `VendaPagamentoService` grava cabeçalho/itens e executa baixa/consumo no handle exclusivo. Após os itens, `aposBaixaItensDaVenda` chama `consumirReservaPedidoAposBaixa` antes do commit. Porém, o wrapper Promise ignora o argumento de erro do callback e resolve mesmo se `consumirReservasPedidoNaVendaCb` chamar `callback(err)`. A transação pode, assim, prosseguir para pagamentos/financeiro e commit apesar de falha na atualização do tracking.
2. `executarTransacaoVendaExclusiva` aguarda e confirma `COMMIT`; o núcleo só então responde ao adaptador.
3. `FaturamentoService` tenta atualizar `vendas.origem` e `vendas.pedido_id`. Erros são capturados e apenas enviados a `console.warn`; o processamento continua.
4. Depois tenta `consumirReservasDaVenda` (reservas vinculadas à venda), também capturando e avisando erros.
5. Em seguida chama novamente `consumirReservasPedidoNaVenda` para as reservas do Pedido; erros são capturados e avisados.
6. Por fim, `PedidoRepository.marcarFaturado` atualiza status e `pedidos.venda_id`. Um erro SQLite propaga; `false` resulta em erro 500. Não há rollback do commit da venda. A leitura do Pedido atualizado acontece somente após sucesso de `marcarFaturado`.

Evidências nos arquivos [VendaPagamentoService.js](./backend/services/vendas/VendaPagamentoService.js), [FaturamentoService.js](./backend/services/faturamento/FaturamentoService.js), [pedidoReservaPonteNucleo.js](./backend/services/estoque/pedidoReservaPonteNucleo.js) e [PedidoRepository.js](./backend/services/pedido/PedidoRepository.js). Em particular, `marcarFaturado` usa a conexão padrão do repositório porque o chamador não injeta `opts.db`; não participa da conexão exclusiva do núcleo.

### Testes focados e estados observados

Os casos foram executados sequencialmente, cada seletor em processo e `DB_DIR` temporário novo. Nenhuma alteração de produção foi feita. Os testes de auditoria foram adicionados ao arquivo [sprint32-pedido-consumido-integracao.test.js](./tests/faturamento/sprint32-pedido-consumido-integracao.test.js); o caso E4 existente foi fortalecido com comparações antes/depois.

| Caso | Resultado | Evidência e classificação |
|---|---|---|
| P1 — falha ao atualizar `vendas.pedido_id` após o commit | Reproduzido; teste focado passou | Trigger aborta o vínculo; `FaturamentoService` retorna sucesso sem código de erro ao chamador. Existe 1 venda e 1 item; `pedidos.venda_id` aponta para a venda, mas `vendas.pedido_id` é `NULL`. Saldo e ledger permanecem iguais. Retry resulta em HTTP lógico 409 porque o Pedido foi marcado `FATURADO`; não corrige o vínculo. **Inconsistência reproduzida; sem recuperação automática.** |
| P2 — falha ao atualizar status do Pedido | Reproduzido; teste focado passou | Trigger aborta `marcarFaturado` com `code=SQLITE_CONSTRAINT` e mensagem contendo `s312_falha_status_pedido_injetada`. O erro propaga ao chamador. A venda e seu item já estão committed e ligados por `vendas.pedido_id`; Pedido permanece `AGUARDANDO_FATURAMENTO`, sem `venda_id`. Saldos, ledger e reservas do Pedido não sofrem segunda alteração nessa execução. **Inconsistência reproduzida.** |
| P3 — falha no processamento de reserva do Pedido | Reproduzido pelo teste E4; teste focado passou | Trigger aborta a atualização de tracking. A chamada do núcleo não propaga o erro do callback e o faturamento termina com sucesso; aviso posterior registra a falha. Venda/item existem; Pedido termina `FATURADO`; reserva continua `ATIVA`, enquanto os contadores global e empresarial de reservado caem de valor positivo para zero. Saldo físico e ledger de consumo permanecem iguais. Retry resulta em 409 e não recupera a reserva. **Inconsistência reproduzida.** |
| P4 — repetição depois de falha no status | Reproduzido; teste focado passou | Após P2, removido o trigger e repetida a operação. Como o serviço só bloqueia por status do Pedido e não reconcilia uma venda já criada, surge uma segunda venda ligada ao mesmo Pedido: 2 cabeçalhos e 2 itens. A ordem final do Pedido aponta à segunda venda. Saldo e ledger não se alteram na segunda tentativa porque `pedidoJaConsumido` evita segunda baixa/consumo. **Não idempotente; duplicação de venda reproduzida.** |
| P5 — faturar novamente após sucesso normal | Validado; teste focado passou | Uma venda e um item permanecem; a tentativa seguinte retorna 409 com `venda_id`, sem criar venda, baixar estoque nem alterar ledger. **Bloqueio de duplicação funciona apenas quando o status já foi finalizado.** |

P1/P2/P3/P4 foram verificações de estado após falha; os seletores passaram porque os testes afirmam os estados observados, não porque o fluxo esteja funcionalmente íntegro. Os bancos foram temporários. Não foram executados testes E2–E4 além do E4 reutilizado, D ou a suíte integral.

### Propostas de correção — aguardam autorização

Nenhuma correção de produção foi implementada nesta auditoria.

1. **P1/P2/P4 — finalização idempotente por venda existente:** não engolir falha de vínculo. Antes de criar outra venda, procurar uma venda candidata por `pedidos.venda_id` e/ou `vendas.pedido_id`, validar empresa, estado e itens, e retomar apenas as etapas faltantes usando o mesmo `venda_id`. A reconciliação precisa atender ambos os estados assimétricos de P1 e P2; uma simples repetição de `UPDATE` ou um retry HTTP do fluxo atual não basta. Avaliar uma proteção de unicidade por Pedido no banco, compatível com vendas sem Pedido, como barreira adicional. Arquivos potencialmente afetados: `FaturamentoService.js`, `PedidoRepository.js` e, se a proteção persistente for aprovada, schema/migração de `vendas`.
2. **P3 — erro real e único owner da reserva:** fazer o wrapper do núcleo propagar `err` ao Promise, garantindo que a operação transacional não confirme alteração parcial do contador e tracking. Definir um único ponto responsável por consumir reserva do Pedido; hoje a operação aparece no núcleo e novamente após o commit no `FaturamentoService`. O processamento de liberação do contador e mudança do tracking precisa ser atômico. Para estado legado já divergente (`ATIVA` com contador zero), disponibilizar reconciliação idempotente que não faça baixa física nem consumo de ficha técnica.
3. **Resposta ao chamador e recuperação:** erros após commit devem identificar explicitamente que a venda existe e informar o `venda_id`, sem resposta indistinguível de uma falha anterior ao commit. A ação de retry precisa concluir pós-processamento da venda existente, nunca chamar novamente a criação do núcleo.

As propostas são localizadas, mas P1/P2/P4 exigem definir um contrato de recuperação pós-commit e a barreira contra venda duplicada; P3 requer escolher ownership única para reservas. Esta auditoria não implementa tais decisões. Não se declara atomicidade ponta a ponta enquanto vínculo, status e reservas ainda possam falhar fora do commit do núcleo.

**Classificação da Sprint 3.12:** auditoria concluída; **P1/P2/P3/P4 — INCONSISTÊNCIA REPRODUZIDA; P5 — VALIDADO no caminho de sucesso. Correção de produção pendente de autorização.**

## Sprint 3.13 — Integridade transacional do faturamento de Pedidos

### Implementação

O faturamento agora possui uma identidade persistente por Pedido em `pedido_faturamento_operacoes`, com `pedido_id` único. A tabela é criada de forma não destrutiva por `CREATE TABLE IF NOT EXISTS` no banco ativo; não foi aplicada migração destrutiva nem alterada a restrição de `vendas.codigo`. A operação guarda a empresa, o `venda_id` e os estados `INICIADA`, `VENDA_CRIADA` e `FINALIZADA`.

Sequência efetiva:

1. `PedidoFaturamentoOperacaoRepository.prepararOperacao` abre conexão SQLite exclusiva e usa `BEGIN IMMEDIATE`. Lê candidatos por `pedidos.venda_id`, `vendas.pedido_id` e pelo identificador persistido da operação. Mais de uma candidata, vínculo inexistente ou conflito bloqueia a operação sem escolher uma venda.
2. Sem venda candidata, `VendaPagamentoService` executa o núcleo na conexão exclusiva já estabelecida. Cabeçalho, itens, estoque/ledger e o `venda_id` da operação são gravados na mesma transação. A segunda tentativa, serializada pelo lock de escrita SQLite, encontra a mesma operação e valida empresa, estado, total e itens antes de reutilizar a venda; não insere novo cabeçalho, itens, pagamentos/financeiro nem repete consumo.
3. Depois do commit do núcleo, `FaturamentoService.finalizarPedidoComVenda` abre outra conexão exclusiva e transação `BEGIN IMMEDIATE`. Na mesma transação valida novamente os dados, corrige os dois sentidos do vínculo sem sobrescrever outro `venda_id`, define a origem, processa as reservas da venda e do Pedido, marca o Pedido como `FATURADO` e marca a operação como `FINALIZADA`.
4. Falha em qualquer etapa da finalização faz rollback do vínculo, status, tracking e contadores abrangidos por essa transação. O cabeçalho/itens da venda permanecem committed; o erro é propagado com `venda_id` e indicação `venda_persistida`, além de preservar eventual erro de rollback/fechamento. Retry retoma a venda registrada na operação.

O consumo de reservas do Pedido passou a ter um único owner no pós-processamento de `FaturamentoService`; foi removido do núcleo de venda. `consumirReservasPedidoNaVenda` recebe o mesmo handle exclusivo da finalização. A mudança de status da reserva e os deltas dos contadores global/empresarial participam da transação. Se uma reserva antiga estiver `ATIVA` com contadores zerados, o decremento existente mantém o piso em zero e o tracking pode ser reconciliado sem baixa física ou consumo de receita.

Arquivos alterados:

- [FaturamentoService.js](./backend/services/faturamento/FaturamentoService.js) — seleção/validação da venda existente e finalização atômica do pós-processamento.
- [PedidoFaturamentoOperacaoRepository.js](./backend/services/faturamento/PedidoFaturamentoOperacaoRepository.js) — identidade persistente, lock, busca de candidatos e bloqueio conservador de possíveis vendas órfãs antigas.
- [PedidoRepository.js](./backend/services/pedido/PedidoRepository.js) — `marcarFaturado` aceita retry idempotente somente para a mesma venda e não substitui vínculo diferente.
- [VendaPagamentoService.js](./backend/services/vendas/VendaPagamentoService.js) — consulta/validação da operação no lock do núcleo, registro do `venda_id` na transação da venda e retirada do consumo duplicado de reserva do Pedido.
- [sprint32-pedido-consumido-integracao.test.js](./tests/faturamento/sprint32-pedido-consumido-integracao.test.js) — recuperação, falhas, conflito, concorrência e regressões.

`PedidoOperacionalService.js`, Motor Fiscal, XML, NF-e/NFC-e, regras de pagamento/TEF, estoque/ledger já validado e contratos de vendas sem Pedido não foram alterados.

### Resultados dos testes

Executados em banco isolado criado por `DB_DIR`; nenhum banco oficial foi aberto. A suíte integral não foi executada.

| Caso | Resultado e evidência |
|---|---|
| A — produto simples | Passou; sem segunda baixa e sem nova venda no retry. |
| B — ficha técnica | Passou; sem segunda baixa no produto final ou ingredientes. |
| C — itens mistos | Passou; ordem e ledger preservados. |
| D — Pedido legado sem ledger | Passou; baixa legada mantida. |
| E0/E1/E1b | Passaram; erro original propagado e rollback do cabeçalho/itens, inclusive falha no segundo item. |
| E2/E3 | Passaram; falhas de estoque/ledger reverteram as gravações cobertas pela transação do núcleo. |
| E4 — reserva ativa e contadores zerados | Passou; reserva reconciliada, contadores não negativos, estoque físico/ledger inalterados. |
| P1 — falha ao vincular `vendas.pedido_id` | Passou; venda e item committed, finalização retorna erro com `venda_id`, Pedido continua pendente e vínculos permanecem sem alteração parcial. Após remover o trigger, retry finaliza a mesma venda; contagem final: um cabeçalho e um item. |
| P2 — falha no status | Passou; rollback reverte vínculo/status pós-commit; a venda existente é recuperada no retry, sem novo cabeçalho ou item. |
| P3 — falha no tracking da reserva | Passou; erro propagado, contadores e tracking restaurados pelo rollback; retry consome a reserva uma vez, sem mudança adicional no estoque físico/ledger. |
| P4 — repetição após falha parcial | Passou; uma venda, um conjunto de itens e um único vínculo/status final. |
| P5 — nova tentativa após faturamento concluído | Passou; retorna 409 com `venda_id` e preserva venda, estoque e ledger. |
| Vínculo assimétrico (`vendas.pedido_id` preenchido) | Passou; recuperou a venda original e completou o vínculo do Pedido. |
| Venda histórica sem qualquer vínculo/claim | Passou com bloqueio explícito; a assinatura exata da venda foi detectada e nenhuma segunda venda foi criada. |
| Múltiplas candidatas / itens divergentes / ownership incompatível | Passaram; bloqueio diagnóstico sem eleger venda nem criar outra. |
| Venda sem Pedido associado | Passou; caminho normal do Núcleo preserva `pedido_id = NULL` e não cria operação de Pedido. |
| Concorrência | Passou; duas chamadas simultâneas por conexões SQLite exclusivas resultaram em no máximo uma venda, um item, um vínculo e um consumo. |
| Colisão de código e conexão exclusiva | Passaram; sufixo em colisão preservado e configuração WAL/foreign keys/busy timeout validada. |

Resultado da integração: **24 testes, 24 aprovados, 0 falhas**. `node --check` passou nos cinco arquivos JavaScript alterados. Regressão `venda-multi-origem-sprint22.test.js`: **13 testes, 13 aprovados, 0 falhas**.

### Limites e pendências

- A venda e o pós-processamento continuam sendo duas transações: a venda pode permanecer persistida se a finalização falhar. Isso é intencional e recuperável pela operação persistente; não se declara atomicidade global entre ambos os commits.
- Uma venda antiga sem qualquer vínculo e sem operação persistida não contém identidade suficiente para ser associada com segurança. O sistema bloqueia se encontrar uma assinatura compatível (mesma empresa/cliente, criada após o Pedido, mesmo total e mesmos itens) e informa as candidatas, em vez de escolher arbitrariamente. Esse bloqueio conservador pode exigir diagnóstico manual quando uma venda legítima distinta tem assinatura idêntica. Uma venda histórica com dados divergentes dessa assinatura não pode ser identificada automaticamente. Antes de implantação, é necessária auditoria dos dados existentes e tratamento manual dos órfãos encontrados.
- A concorrência foi exercitada com duas chamadas simultâneas no mesmo processo, usando conexões exclusivas distintas; não foi executado um teste multi-processo nem um teste com autorização TEF concorrente. O lock é `BEGIN IMMEDIATE` no arquivo SQLite, mas esses cenários externos não foram simulados.
- Nenhum teste de emissão fiscal ou operação TEF foi executado, pois essas superfícies não foram alteradas.

**Classificação da Sprint 3.13:** P1–P5 e regressões focadas validados em banco temporário; recuperação automática garantida para operações novas e para vendas antigas com um vínculo inequívoco. Vendas históricas completamente órfãs permanecem em **bloqueio diagnóstico**, não em recuperação automática, até auditoria manual. Não foi executado Git, commit, push, merge ou reset.

## Estabilização da personalização — análise das divergências

### Divergências analisadas

- A asserção no teste de consumo do Pedido espera que `VendaPagamentoService` chame `consumirReservaPedidoAposBaixa(vendaId, continuar)` quando o Pedido já foi consumido. Esse helper não existe no contrato atual. A baixa duplicada é evitada em `VendaPagamentoService`; a finalização do faturamento libera e marca a reserva por `consumirReservasPedidoNaVenda`, usando a conexão exclusiva e a transação de `FaturamentoService`. Classificação: **teste desatualizado**, não regressão de consumo. Recomenda-se atualizar a asserção para verificar os contratos atuais de não duplicação e finalização transacional; o teste não foi alterado.
- T12 e T13 falhavam porque `FichaTecnicaService.obterPorProdutoId()` valida a ficha antes de `FichaTecnicaConsumoService` alcançar suas próprias verificações: o serviço compartilhado lança `INSUMO_INATIVO` e `QUANTIDADE_INVALIDA`, enquanto o contrato público do consumo na venda já usa `FICHA_INSUMO_INATIVO` e `FICHA_QUANTIDADE_INVALIDA`. A rejeição e a ausência de consumo parcial já eram corretas, mas os códigos públicos eram incompatíveis. Classificação: **regressão de compatibilidade dos códigos de erro**. `FichaTecnicaConsumoService` agora traduz apenas esses códigos no limite do consumo, preservando a causa; `PedidoConsumoEstoqueService` usa a mesma tradução. Os códigos do `FichaTecnicaService` permanecem inalterados para seus outros chamadores.
- T29 procura `db.run('BEGIN IMMEDIATE')` e compara sua posição textual com a chamada de consumo. A implementação atual usa `executarTransacaoVendaExclusiva()`, abre conexão exclusiva, executa `runSqlite(transacaoDb, 'BEGIN IMMEDIATE')` e passa essa mesma conexão às gravações e ao consumo. O teste não encontra a forma textual antiga e compara pontos de fluxos diferentes. Classificação: **teste estático desatualizado**, sem evidência de falha transacional. Recomenda-se verificar o helper e a conexão transacional atual, ou adicionar um teste comportamental de rollback; o teste não foi alterado.

### Alteração e validação

Arquivos alterados nesta estabilização:

- `backend/services/produtos/FichaTecnicaConsumoService.js`: tradução explícita dos códigos genéricos de validação da ficha para os códigos do contrato de consumo.
- `backend/services/pedido/PedidoConsumoEstoqueService.js`: aplicação da mesma tradução ao validar fichas no consumo originado pelo Pedido.

Testes em banco temporário:

- Personalização focada no Pedido — **2/2 aprovados**, incluindo preço, snapshots, seleção, rollback e retry idempotente.
- Consumo completo do Pedido — **19/20 aprovados**. A única falha é a asserção estática desatualizada sobre `consumirReservaPedidoAposBaixa`; os testes comportamentais restantes passaram.
- Consumo legado da ficha técnica — **34/35 verificações internas aprovadas**. T12 e T13 passaram após a tradução dos códigos; a única falha restante é T29, a asserção textual desatualizada sobre o início da transação.
- MUC-04 — **29/29 aprovados**.
- `node --check` nos dois arquivos JavaScript alterados nesta estabilização — aprovado.

Na validação anterior, as duas divergências restantes foram justificadas como expectativas estáticas desatualizadas e os testes não foram alterados naquela etapa. A atualização posterior e os novos resultados estão registrados na seção seguinte. A homologação operacional no Electron continuava pendente.

## Fechamento dos testes e preparação da homologação Electron

As duas verificações estáticas foram atualizadas para o contrato real, sem mudança na implementação de produção:

- O teste de consumo do Pedido agora verifica o flag de não repetição da baixa, o comportamento de saldo já coberto no próprio cenário e a liberação da reserva em `FaturamentoService` dentro da transação de finalização.
- T29 agora verifica `executarTransacaoVendaExclusiva`, a abertura exclusiva, `BEGIN IMMEDIATE`, passagem da conexão ao callback, `COMMIT`/`ROLLBACK` e o uso da mesma conexão nas gravações/consumo. A atomicidade também foi exercitada comportamentalmente pelos testes E3 e P3 da integração.

Resultados em banco temporário:

- Personalização focada: **2/2 aprovados**.
- Consumo do Pedido: **20/20 aprovados**.
- Consumo da ficha técnica: **35/35 verificações aprovadas**, incluindo T12, T13 e T29.
- MUC-04: **29/29 aprovados**.
- Integração faturamento — B, E3 e P3: **3/3 aprovados**; inclui ficha faturada sem segunda baixa, rollback de venda/itens/estoque/ledger em falha e rollback/retry da reserva.
- `node --check` nos dois arquivos de teste alterados: aprovado.

### Limite operacional do Electron

O entrypoint declarado no `package.json` é `electron.js`; `npm start` executa o Electron local a partir do workspace. Esse entrypoint carrega `./backend/server`, portanto o modo de desenvolvimento referencia o código-fonte do workspace, e não um pacote recém-reconstruído. O pacote oficial não foi reconstruído nem instalado.

O próprio `electron.js` preserva `DB_DIR` se definido pelo ambiente, mas, se estiver ausente, escolhe `%ProgramData%\MercantilFiscal\dados`; essa é a base padrão oficial. O aplicativo não foi iniciado nem qualquer banco foi aberto nesta etapa. Para uma homologação isolada, deve-se iniciar o desenvolvimento com `DB_DIR` explicitamente apontado a uma pasta temporária não oficial e confirmar o caminho/arquivo `mercadao.db` antes de cadastrar dados ou salvar Pedido.

A homologação funcional no Electron — preço final com adicionais, consumo obrigatório e opcional selecionado, ausência de baixa do opcional desmarcado e ausência de duplicidade — permanece **pendente de confirmação do diretório de banco autorizado**. Nenhum resultado automatizado equivale a essa homologação operacional.

### Inspeção read-only do banco indicado

Após confirmação explícita do usuário para inspecionar o caminho informado, foi aberta somente em `OPEN_READONLY` a base `C:\ProgramData\MercantilFiscal\dados\mercadao.db`. O arquivo existe. O schema ainda não contém os campos/tabelas aditivos de personalização; iniciar o Electron nesse `DB_DIR` executaria as migrações de inicialização nessa base.

Foi encontrado o produto comercial ID `747` (`Pastel Especial`, nome comercial `Pastel do Cheff`) com ficha ativa e três componentes: Carne de Sol (`766`, `0,2 G`), Massa de Pastel (`752`, `2 UN`) e Frango desfiado (`765`, `0,2 G`). A ficha não tem classificação opcional/adicional gravada no schema atual. Não há linhas em `estoque_empresa` para esses três insumos, portanto não existe saldo empresarial confirmado para executar o pedido de teste nesse banco.

Nenhuma migração foi executada, nenhum produto/ficha/saldo foi alterado e nenhum Pedido foi criado. Não é seguro fabricar saldo ou reclassificar a ficha do produto operacional para tornar o teste possível. A homologação requer uma base de staging autorizada já abastecida/configurada, ou uma decisão explícita sobre um procedimento seguro de preparação de dados de teste; até lá, o Electron permanece sem iniciar nesse diretório oficial.

### Atualização operacional — staging temporário

Em 24/10/2026, a versão de desenvolvimento foi iniciada por `npm start` (`electron.js` → `backend/server.js`) com `DB_DIR` explicitamente definido como `%TEMP%\cds-personalizacao-electron-stage-20261024`. O log de inicialização confirmou esse diretório; nenhuma instalação/pacote oficial foi reconstruído ou alterado. A interface controlada nesta etapa foi uma página de navegador conectada ao backend local; isso não comprova, por si só, a operação pela janela nativa do Electron.

O primeiro `GET /api/produtos` respondeu HTTP 403 `LICENCA_AUSENTE`. Posteriormente, a tela Assinatura exibiu status `Ativa` e o mesmo endpoint passou a responder HTTP 200. A leitura de `GET /api/configuracoes-avancadas/recursos` mostrou `pedidos: false`; por isso o menu Pedidos foi ocultado. Nenhum middleware, recurso ou licença foi contornado ou alterado manualmente.

Com autorização explícita para usar dados sintéticos somente no staging, foram criados pela interface a empresa `TESTE HOMOLOGACAO TEMPORARIA CDS` (ID 1, CNPJ sintético `00.000.000/0001-91`) e os seguintes registros: massa (ID 1, 100 UN), Carne de Sol (ID 2, 1.000 G), Frango desfiado (ID 3, 1.000 G) e Pastel Especial de homologação (ID 4). A ficha do produto foi salva com HTTP 200 e contém massa obrigatória (2 UN), Carne de Sol opcional (0,2 G) e Frango desfiado opcional com adicional de R$ 3,00 (0,2 G); os preços base configurados no produto de teste são R$ 15,00. Esses registros e saldos existem apenas no banco temporário.

**Resultado operacional: pendente/bloqueado.** Nenhum Pedido foi criado e nenhum consumo foi exercitado. O usuário optou por ativar uma licença de teste que inclua Pedidos diretamente na janela nativa; a validação deverá ser retomada somente após a confirmação dessa ativação. Permanecem pendentes a criação do Pedido, a conferência do preço final, o débito dos ingredientes obrigatórios e opcionais selecionados, a ausência de débito do opcional desmarcado e a ausência de consumo duplicado/parcial. A homologação no Electron não está aprovada.

### Atualização — pedido e consumo verificados no staging

Após o usuário informar que a licença estava ativa, a tela de Assinatura confirmou o status ativo. O recurso `pedidos` ainda estava desligado na configuração temporária (`GET /api/configuracoes-avancadas/recursos` retornava `pedidos: false`), então foi habilitado somente pelo Centro de Configurações da própria aplicação, com `habilitar_expedicao: false`. A configuração pertence ao diretório temporário; nenhuma licença ou regra foi contornada e nenhuma configuração oficial foi alterada.

Na interface ligada ao backend local, foi criado um único Pedido de teste, ID 1, empresa 1, total R$ 18,00: preço-base R$ 15,00 mais R$ 3,00 do Frango desfiado. O snapshot persistido contém a massa obrigatória selecionada (2 UN), Carne de Sol opcional desmarcada (0,2 G) e Frango desfiado selecionado (0,2 G, adicional R$ 3,00). O POST respondeu HTTP 201; a leitura subsequente do Pedido respondeu HTTP 200.

Após o encerramento do processo do aplicativo, o banco temporário foi consultado em modo read-only para confirmar persistência: há um registro em `pedido_estoque_consumos` e duas linhas em `pedido_estoque_consumo_itens` — massa 2 UN e Frango 0,2 G. Carne não aparece no consumo. O saldo empresarial ficou: massa 100 → 98 UN; Carne de Sol permaneceu 1.000 G; Frango 1.000 → 999,8 G. Não há estoque empresarial do produto final. As deltas correspondem a um único consumo, sem baixa do ingrediente desmarcado nem duplicidade observada.

**Validação na janela nativa: confirmada pelo usuário.** A operação automatizada da interface ocorreu numa página de navegador conectada ao backend do workspace; depois, o usuário confirmou que o Pedido persistido aparece na janela nativa do Electron usando o staging temporário. Somando essa confirmação à leitura read-only após commit, a criação do Pedido e o consumo personalizado estão validados para este cenário: preço final R$ 18,00, consumo de 2 UN da massa e 0,2 G do Frango selecionado, nenhuma baixa da Carne desmarcada e uma única operação de consumo. O produto final não teve estoque debitado.

O processo Electron da execução automatizada havia terminado com código 0 e o backend deixara de responder. Para reproduzir somente o staging temporário em PowerShell:

```powershell
$env:DB_DIR = 'C:\Users\cicer\AppData\Local\Temp\cds-personalizacao-electron-stage-20261024'
npm start
```

Não reconstruir nem instalar pacote oficial. A homologação cobre Pedido e consumo de estoque personalizado nesse staging; não cobre faturamento, venda nem documento fiscal.
