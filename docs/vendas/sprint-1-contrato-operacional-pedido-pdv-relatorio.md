# Sprint 1 — Contrato Operacional do Pedido e da Venda Composta

**Escopo:** auditoria estática complementar e especificação arquitetural.  
**Conclusão:** contrato proposto para revisão; nenhuma funcionalidade foi implementada.  
**Persistência:** nenhum banco foi aberto, consultado ou escrito; nenhuma migração foi executada.  
**Testes e integrações:** nenhum teste foi executado; ERP/Electron não foi iniciado e nenhuma operação SEFAZ foi realizada.

## 1. Resumo executivo

O repositório oferece uma entidade comercial reaproveitável (`pedidos` e `pedidos_itens`), uma interface ERP de manutenção/expedição e um PDV oficial que envia seu carrinho ao núcleo compartilhado. O contrato atual, porém, não modela Pedido operacional e composição fiscal como conjuntos distintos. A venda persistida e os efeitos de estoque/ficha técnica são calculados a partir dos itens de venda recebidos.

O Motor de Vendas já tem dois fundamentos reutilizáveis: vínculo explícito de produto elegível por empresa nas categorias lógicas `REFRIGERANTE` e `AGUA`, e saldo fiscal em mililitros por empresa/categoria. Também há um serviço independente de reservas desse saldo. Nenhum desses módulos implementa hoje a composição substitutiva do exemplo ou o consumo de saldo fiscal no ciclo de venda. O distribuidor atual reparte os produtos já presentes no carrinho entre valores/quantidades fiscais e não fiscais.

O faturamento legado cria a venda pelo núcleo, mas grava `vendas.pedido_id` e atualiza `pedidos.venda_id`/status em operações posteriores ao commit da venda. Não há índice único sobre Pedido/empresa. O núcleo autoriza o fluxo de pagamento antes da transação SQLite; por isso uma falha ou perda de resposta nessa fronteira não pode ser resolvida por retry cego.

**Proposta central:** manter `pedidos` como fonte comercial; importar pelo PDV oficial; calcular e validar a composição exclusivamente no servidor; e concluir a venda com uma operação durável e idempotente por (empresa, Pedido). O novo caminho deve alimentar o consumo físico/ficha técnica com os itens operacionais do Pedido, mantendo os itens fiscais de representação fora da baixa física. O faturamento legado permanece existente e sem expansão funcional.

## 2. Escopo e método

Foi lido o relatório de referência [Auditoria Pedido Operacional → PDV](./auditoria-pedido-operacional-ponte-pdv-relatorio.md) e inspecionados os arquivos reais do workspace listados abaixo. Esta auditoria não iniciou o ERP, não conectou a banco, não executou testes e não realizou escrita ou migração.

### 2.1 Arquivos e funções inspecionados

**Pedido e persistência**

- [PedidoOperacionalService.js](../../backend/services/pedido/PedidoOperacionalService.js): `normalizarItens`, `montarCabecalho`, `resolverStatusInicial`, `statusExigeConfirmacaoFiscal`, `criar`, `atualizar`, `cancelar`, `converterParaPedido` e `enviarParaFaturamento`.
- [PedidoRepository.js](../../backend/services/pedido/PedidoRepository.js): `listarPedidos`, `obterPorId`, `criarPedido`, `substituirPedido`, `atualizarStatus` e `marcarFaturado`.
- [PedidoService.js](../../backend/services/pedido/PedidoService.js) e [enums.js](../../backend/services/pedido/enums.js): contratos do serviço legado e estados.
- [pedidos.js](../../backend/rotas/pedidos.js): rotas do Pedido Operacional e aplicação do contexto de empresa.
- [database.js](../../backend/database.js): DDL base e alterações incrementais observadas para Pedido, snapshots e vínculo de venda.

**PDV e núcleo de vendas**

- [pdv.js](../../frontend/pdv/js/pdv.js): `obterTotalVendaPDV`, `calcularTotal`, `abrirModalPagamento`, `precalcularDistribuicaoFiscalVenda` e o fluxo `enviarVenda(payload)`.
- [pdv.html](../../frontend/pdv/pages/pdv.html) e [app.js](../../frontend/pdv/js/app.js): tela oficial e carregamento.
- [vendas.js](../../backend/rotas/vendas.js): `POST /api/vendas/pre-calcular-distribuicao`, `POST /api/vendas` e middlewares.
- [VendaContract.js](../../backend/services/vendas/VendaContract.js), [VendaContext.js](../../backend/services/vendas/VendaContext.js) e [VendaOrigin.js](../../backend/services/vendas/VendaOrigin.js): payload, contexto e origens.
- [VendaApplicationService.js](../../backend/services/vendas/VendaApplicationService.js): `criarVenda`, `criarVendaComContexto` e `concluirVendaNoNucleoOficial`.
- [VendaPagamentoService.js](../../backend/services/vendas/VendaPagamentoService.js): `preCalcularDistribuicao`, `criarVenda`, validações e transações.
- [distribuidorEstoqueVenda.js](../../backend/services/distribuidorEstoqueVenda.js): `distribuirItensVendaComValorFiscalEfetivo`.
- [FichaTecnicaConsumoService.js](../../backend/services/produtos/FichaTecnicaConsumoService.js): `montarLinhasConsumo` e `consumirFichaTecnicaDaVenda`.

**Reservas, saldo fiscal e legado**

- [pedidoReservaPonteNucleo.js](../../backend/services/estoque/pedidoReservaPonteNucleo.js): crédito e consumo de reservas originadas de Pedido.
- [EstoqueConsumoReserva.js](../../backend/services/estoque/EstoqueConsumoReserva.js): consumo de reservas anexas à venda.
- [CategoriaFiscalEmpresaService.js](../../backend/services/vendas/CategoriaFiscalEmpresaService.js) e [categoriaFiscalEmpresaSchema.js](../../backend/services/vendas/categoriaFiscalEmpresaSchema.js): vínculo e elegibilidade por empresa/categoria.
- [SaldoFiscalCategoriaService.js](../../backend/services/vendas/SaldoFiscalCategoriaService.js), [saldoFiscalCategoriaSchema.js](../../backend/services/vendas/saldoFiscalCategoriaSchema.js), [ReservaSaldoFiscalCategoriaService.js](../../backend/services/vendas/ReservaSaldoFiscalCategoriaService.js) e [reservaSaldoFiscalCategoriaSchema.js](../../backend/services/vendas/reservaSaldoFiscalCategoriaSchema.js): saldo em ml, movimentos e reservas.
- [FaturamentoService.js](../../backend/services/faturamento/FaturamentoService.js), [faturamento.js](../../backend/rotas/faturamento.js), [pedidos.js ERP](../../frontend/erp/js/pedidos.js) e [faturamento.js ERP](../../frontend/erp/js/faturamento.js): fluxo legado e seus consumidores.
- Testes candidatos observados para as próximas sprints: [pedido-operacional-sprint-b1.test.js](../../tests/pedidos/pedido-operacional-sprint-b1.test.js), [venda-application-service.test.js](../../tests/vendas/venda-application-service.test.js), [categoria-fiscal-empresa.test.js](../../tests/vendas/categoria-fiscal-empresa.test.js), [saldo-fiscal-categoria.test.js](../../tests/vendas/saldo-fiscal-categoria.test.js), [saldo-fiscal-categoria-concorrencia.test.js](../../tests/vendas/saldo-fiscal-categoria-concorrencia.test.js), [reserva-saldo-fiscal-categoria.test.js](../../tests/vendas/reserva-saldo-fiscal-categoria.test.js), [consumo-reserva-pedido-porta-publica.test.js](../../tests/estoque/consumo-reserva-pedido-porta-publica.test.js), [rc412-ponte-reserva-pedido-nucleo.test.js](../../tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js) e [sprint31-faturamento.test.js](../../tests/faturamento/sprint31-faturamento.test.js).

## 3. Estado real comprovado

### 3.1 Modelo, empresa, snapshots e valores do Pedido

**Campos atuais no DDL e alterações incrementais**

- `pedidos`: `id`, `codigo`, `data_pedido`, `cliente_id`, `total`, `desconto`, `status`, `representante_id`, `representante_nome`, `observacao`, `operador_id`, `venda_id`, `empresa_id`, `faturado_em`, `faturado_por`, `created_at`, `updated_at`. Alterações incrementais adicionam, entre outros, `frete`, `acrescimo`, `natureza_operacao`, `cfop`, dados de transporte e metadados fiscais.
- `pedidos_itens`: `id`, `pedido_id`, `produto_id`, `quantidade`, `preco_unitario`, `desconto_percentual`, `subtotal`, `tipo_venda`, e snapshots opcionais de classificação operacional, código, nome e unidade do produto.
- `empresa_id` é persistido no Pedido e recebido pela aplicação a partir do contexto autenticado. As rotas usam `criarMiddlewareContextoEmpresa`; o serviço do Pedido valida a propriedade. `PedidoRepository.obterPorId` lê pelo ID e a verificação de propriedade ocorre no serviço, não na consulta isolada do repositório.
- `cliente_id` é opcional para o Pedido e ligado a `clientes`; modalidades de crédito/a prazo no núcleo impõem suas próprias validações de cliente.

**Fatos e lacunas de snapshots**

- Preço unitário, quantidade, desconto percentual e subtotal são gravados no item do Pedido. Esses valores são o snapshot comercial mais importante.
- Os snapshots opcionais gravam classificação operacional e identificadores descritivos na criação/edição, quando as colunas existem. Itens antigos podem retornar nome/código/unidade do catálogo atual; a origem da classificação é indicada como snapshot ou catálogo legado.
- Não há snapshot da composição fiscal. Também não há snapshot da ficha técnica, componentes, quantidade de insumo ou caminho de conversão de unidade no agregado do Pedido.
- `FichaTecnicaConsumoService.montarLinhasConsumo` busca a ficha técnica atual no momento do consumo. Depois registra linhas da ficha usada em `venda_ficha_consumo_itens`, o que permite rastrear/estornar o consumo efetivamente gravado, mas não prova qual receita estava vigente quando o Pedido foi criado.

**Regra de preço/total atualmente codificada**

`PedidoOperacionalService.montarCabecalho` normaliza os itens e calcula `subtotal` como o valor recebido, ou `quantidade × preço unitário × (1 - desconto percentual / 100)` quando omitido. Calcula o total esperado como `soma dos subtotais - desconto global + frete`, arredondado a centavos; se o cliente envia `total`, o serviço rejeita divergência acima da tolerância monetária. `PedidoRepository` persiste total, desconto e frete junto com os itens.

Embora exista coluna incremental `pedidos.acrescimo`, a normalização do cabeçalho e os métodos `criarPedido`/`substituirPedido` inspecionados não a incluem no cálculo ou persistência operacional. Logo, `acrescimo` não deve ser apresentado no contrato atual como componente comercial já suportado; seu uso exigiria decisão e alteração futura.

### 3.2 Estados e transições atuais

Os estados de `PedidoStatus` são `ORCAMENTO`, `PEDIDO`, `ABERTO`, `EM_SEPARACAO`, `AGUARDANDO_FATURAMENTO`, `FATURADO` e `CANCELADO`. `ABERTO` e `EM_SEPARACAO` são marcados no código como compatibilidade legada.

- Criar `ORCAMENTO` não executa confirmação de saldo no Motor Comercial.
- Criar `PEDIDO` (e estados que exigem confirmação) chama `MotorComercial.confirmarPedidoFiscal` depois de persistir o Pedido.
- Converter orçamento confirma estoque fiscal e então transiciona de `ORCAMENTO` para `PEDIDO`.
- Enviar para Expedição confirma novamente a reserva e transiciona `PEDIDO`/`ABERTO`/`EM_SEPARACAO` para `AGUARDANDO_FATURAMENTO`.
- `cancelar` libera a reserva do Motor Comercial e transiciona os estados não faturados permitidos para `CANCELADO`; `FATURADO` não pode ser cancelado por essa tela.
- `substituirPedido` usa `BEGIN IMMEDIATE` para atualizar cabeçalho/itens, mas aceita também `AGUARDANDO_FATURAMENTO`; portanto, o código atual não torna automaticamente imutável o Pedido enviado à fila.
- `marcarFaturado` atualiza status, `venda_id`, `faturado_em` e `faturado_por` por `UPDATE` condicional e por `empresa_id`, mas é uma operação separada do commit do núcleo legado.

### 3.3 Carrinho, total, pagamento e validação do PDV

**Cliente oficial**

- `carrinho` alimenta `calcularSubtotal`; `calcularTotalValor` subtrai o desconto e soma o acréscimo do PDV; `obterTotalVendaPDV` arredonda a centavos.
- `abrirModalPagamento` exige carrinho não vazio e total positivo. O fluxo de seleção de pagamento coleta pagamento único ou misto.
- O payload de venda é montado a partir do carrinho: itens com produto, quantidade, preço, desconto e subtotal; também envia cliente, total e pagamentos.
- `precalcularDistribuicaoFiscalVenda` chama o pré-cálculo do servidor. Se a chamada falha, o PDV registra aviso e usa cálculo local; esse fallback não pode ser fonte de autoridade para a composição de Pedido proposta.
- A função local `enviarVenda(payload)` faz `POST /api/vendas`, anexa o contexto de empresa via header e trata a resposta com o ID da venda. A interação com TEF ou confirmação fiscal pode ocorrer antes do envio final.

**Servidor oficial**

- `POST /api/vendas/pre-calcular-distribuicao` passa por `validarCaixaAberto`; `POST /api/vendas` passa por `validarCaixaSeOrigemPdv` e delega a `VendaApplicationService`.
- `VendaApplicationService` permite concluir no `VendaPagamentoService` somente origens `PDV`, `FATURAMENTO` e `NF_AVULSA`. `PEDIDO` existe no enum, mas **não** está habilitada em `origemPodeConcluirVenda`. A nova ponte não pode presumir o contrário.
- O núcleo exige empresa da operação, itens não vazios, `produto_id` e total positivo. O `VendaFinanceiroService.validarSomaPagamentosVenda` valida os valores pagos em relação ao total e valores fiscais calculados.
- Na leitura focal de `criarVenda`, não foi encontrada uma validação que recalcule `Pedido.total` e compare o total recebido contra a soma de linhas recebidas como equivalência de Pedido. O núcleo recebe o total do corpo e valida positividade/pagamento. A ponte deve recalcular total e composição no servidor; não confiar no total, preço ou produto enviado pelo navegador.
- O pré-cálculo atual carrega os produtos informados no carrinho e os distribui entre quantidades/valores fiscais e não fiscais. Não procura substitutos entre os produtos de uma categoria.

### 3.4 Núcleo da venda: ordem e fronteiras transacionais

No caminho normal de `VendaPagamentoService.criarVenda`, os pontos observados ocorrem nesta ordem:

1. Resolve/valida empresa, caixa e itens; consulta produtos e saldos/disponibilidade.
2. Calcula a distribuição fiscal e valida o total/pagamentos.
3. Executa `OrquestradorPagamento.processarFluxoPagamentoVenda`, que pode envolver TEF ou confirmação de pagamento **antes** de `BEGIN IMMEDIATE`.
4. Abre `BEGIN IMMEDIATE` na conexão `db` do serviço.
5. Insere `vendas` e obtém o ID.
6. Insere `vendas_itens` e chama `reduzirEstoqueDistribuido` para cada item.
7. Chama `consumirFichaTecnicaDaVendaCb` com os itens distribuídos; a ficha atual é consultada e o débito/snapshot é realizado usando o `db` passado.
8. Se houver `pedido_id` no corpo, tenta consumir reservas de Pedido.
9. Registra `venda_pagamentos`, recebimentos, `contas_receber` quando cabível e lançamento(s) em `financeiro`.
10. Executa `COMMIT` e responde com o ID da venda. Se solicitado e aplicável, a emissão NFC-e ocorre no fluxo de resposta posterior ao commit.

**Limites e riscos observados**

- A autorização/execução externa de TEF ou pagamento antecede a transação local. SQLite não torna o TEF atômico com os writes locais; uma resposta perdida/falha pós-autorização exige consulta/reconciliação pela referência do pagamento antes de retry.
- Venda, linhas, baixa dos itens, ficha técnica, pagamentos e lançamentos financeiros passam pela conexão `db` e são estruturados no bloco transacional, mas alguns callbacks de inserção (por exemplo, iteração de pagamentos) não expõem no código uma cadeia uniforme de espera/erro. A estratégia futura deve validar e tornar explícita a confirmação de cada write antes do commit.
- O núcleo recebe `pedido_id` para consultar crédito/consumir reserva, mas o `INSERT INTO vendas` inspecionado não inclui `pedido_id`. A migração cria `vendas.pedido_id` e um índice comum, não único. No legado, `FaturamentoService` atualiza `vendas.origem/pedido_id` depois de o núcleo responder.
- Após o commit do núcleo legado, `FaturamentoService` tenta consumir outras reservas e chama `PedidoRepository.marcarFaturado` em escrita separada. Não há atomicidade entre venda confirmada e status/vínculos do Pedido.
- `pedidoReservaPonteNucleo` afirma usar a mesma conexão sem transação própria; entretanto o callback em `VendaPagamentoService` recebe a operação com `() => next()` e ignora tanto o erro quanto o resultado. A falha no consumo de reservas pode, portanto, ser seguida pelo fluxo de pagamento/commit como se tivesse terminado normalmente. Resultado sem exceção também não é prova de consumo: reservas ausentes são um caso possível.
- `consumirFichaTecnicaDaVenda` verifica existência prévia de consumo por `venda_id`, evitando repetir o consumo para uma venda já marcada, e registra as linhas reais usadas. Isso não corrige duplicidade de venda: uma segunda venda teria outro `venda_id` e pode consumir novamente.
- Em pagamento concluído, a emissão fiscal é posterior ao commit; uma falha de emissão não equivale a uma falha de criação da venda. A recuperação da venda não deve reenviar pagamento ou recriar venda apenas para reparar NFC-e.

### 3.5 Categorias, saldo fiscal em ml e reservas

- `CategoriaFiscalEmpresaService` exige vínculo explícito de produto e empresa, categoria `REFRIGERANTE` ou `AGUA`, elegibilidade ativa e produto não classificado como insumo.
- `SaldoFiscalCategoriaService` mantém saldo lógico por `(empresa_id, categoria_fiscal)` em mililitros inteiros. A documentação/DDL declara independência dos saldos físicos de `produtos`/`estoque_empresa`. O ledger atual aceita abertura, ajustes de entrada/saída e estorno idempotente; sua transação é de propriedade do próprio serviço e rejeita uma transação externa ativa.
- `ReservaSaldoFiscalCategoriaService` oferece reserva, ajuste e liberação do saldo reservado por empresa/categoria/Pedido, em transação própria, com chave idempotente e estado `ATIVA`/`LIBERADA`. Não fornece operação de consumo de reserva pela venda; não integra a criação de composição, o núcleo de venda, o cancelamento do Pedido ou o faturamento legado. O serviço não é ligado ao boot e exige schema preparado.
- A integração atual de Pedido usa `pedido_estoque_reservas`, que é uma reserva de quantidade fiscal de produto, distinta da reserva lógica compartilhada em ml. O consumo da primeira libera quantidade reservada e marca suas linhas `CONSUMIDA`; não implementa o consumo do ledger de categoria.
- Não foi encontrada implementação que percorra todos os produtos elegíveis das categorias, converta/considere suas apresentações em ml e encontre uma combinação de valores que complete a venda. Também não foi encontrado consumo/estorno do saldo lógico por venda.

## 4. Diagrama textual do fluxo proposto

```text
PDV Oficial
  ├─ pesquisa por empresa ativa
  ├─ carrega PedidoComercial persistido e apresenta conferência
  ├─ solicita prévia (somente informativa) da ComposicaoFiscal
  └─ operador confirma pagamento
       ↓
API/Ponte Pedido-PDV (autentica e resolve empresa no servidor)
  ├─ reivindica (empresa_id, pedido_id) atomicamente e bloqueia edição/legado
  ├─ relê Pedido, estado, valores e propriedade
  ├─ revalida ou reserva saldo/capacidade fiscal e validade da composição
  └─ encaminha contrato validado ao núcleo compartilhado
       ↓
Núcleo transacional
  ├─ reconcilia idempotência e resultado do pagamento externo
  ├─ cria/vincula uma única venda por Pedido e empresa
  ├─ persiste itens fiscais de representação sem baixa física indevida
  ├─ consome itens operacionais do Pedido uma única vez (estoque + ficha)
  ├─ confirma/reserva/consome saldo fiscal por operação idempotente
  ├─ registra pagamentos e financeiro uma única vez
  └─ finaliza Pedido/venda ou deixa estado explícito para recuperação
       ↓
PDV recebe venda já existente/concluída ou estado de reconciliação;
não repete pagamento nem cria outra venda automaticamente.
```

## 5. Contratos especificados

Os contratos abaixo são **propostos**, não DTOs ou estados já implementados. Todo o conteúdo financeiro/comercial deve vir do servidor, relendo o Pedido pela empresa autenticada. O navegador pode enviar apenas IDs de operação/prévia e dados de pagamento necessários.

### 5.1 `PedidoComercial`

| Campo conceitual | Estado |
|---|---|
| `pedido_id` | Atual: `pedidos.id` |
| `empresa_id` | Atual: `pedidos.empresa_id`; precisa ser validado contra o contexto, não aceito como autoridade do body |
| `cliente_id`, `status` | Atuais: cabeçalho `pedidos` |
| `total_comercial`, `desconto`, `frete` | Atuais: `total`, `desconto`, `frete`; total é validado como subtotal dos itens − desconto + frete |
| `acrescimo` | Coluna existe em alteração incremental, mas os métodos operacionais inspecionados não a calculam/persistem. Não faz parte do contrato atual sem aprovação e wiring |
| `itens_operacionais[]` | Atuais: linhas de `pedidos_itens` com produto, quantidade, preço unitário, desconto percentual, subtotal e tipo de venda |
| snapshots de classificação/nome/código/unidade | Opcionais/atuais no workspace; campos ausentes em registros antigos podem recorrer ao catálogo atual |
| snapshots de ficha técnica/conversão | Não existem no Pedido atual; qualquer adição é decisão futura |

O pedido importado deve continuar com o total comercial de **R$ 61,98** no exemplo. A composição fiscal não reescreve total, itens, preços ou quantidades de `PedidoComercial`.

### 5.2 `ComposicaoFiscal`

**Proposta de estrutura conceitual:**

```text
ComposicaoFiscal:
  composicao_id
  pedido_id, empresa_id
  total_comercial_reconciliado
  itens_fiscais[]:
    produto_id, quantidade, preco/valor fiscal,
    categoria (REFRIGERANTE | AGUA ou item fiscal elegível próprio),
    quantidade_ml e origem/conversão utilizada quando aplicável
  desconto_aplicado
  regra_versao, configuracao_versao ou hash dos dados determinantes
  criada_em, expira_em, estado
  reserva_fiscal_id/referencias de idempotência por empresa/categoria
```

- Itens, preços, categorias e saldos devem ser carregados/validados pelo servidor usando a empresa do Pedido. O serviço de elegibilidade existente só demonstra vínculo produto-empresa-categoria e exclusão de insumos; ainda é necessário definir quais modelos fiscais (incluindo as linhas de pastéis) e preços são aptos à composição.
- O total da composição deve reconciliar com o valor a receber. Para o exemplo: 2 pastéis × R$ 8,99 = R$ 17,98 e R$ 44,00 de itens fiscais elegíveis de refrigerantes; a composição total e pagamento ficam em R$ 61,98. A Coca-Cola 2 L física permanece somente em `PedidoComercial`/consumo operacional, não como item real da composição.
- Regra de busca: primeiro soluções exatas sem desconto; usar desconto somente se a política/configuração da empresa permitir, se a solução exata não existir e se houver autorização requerida. Se não houver uma combinação válida, interromper sem venda/pagamento.
- A prévia do navegador é informativa e expira. Na confirmação, o servidor deve revalidar o estado, elegibilidade, preço/política, saldo fiscal e capacidade reservada. Se houver prévia persistida, seu identificador precisa ser imutável e vinculado a empresa, Pedido e hash do conteúdo; não aceitar linhas ou valores substituídos pelo navegador.
- A conversão para ml pode reutilizar o adaptador MUC, mas deve validar caminho/ambiguidade e resultado inteiro em ml. A unidade fiscal lógica jamais pode ser tratada como unidade de estoque físico.
- O saldo fiscal categoria atual tem reserva por ml, mas não debit/consumption por venda. É necessário desenhar um evento de consumo vinculado a `venda_id`/operação, uma chave idempotente, e seu estorno condicionado a cancelamento/devolução autorizado; não reaproveitar genericamente `AJUSTE_SAIDA` sem contrato auditável.

### 5.3 `ConclusaoVenda`

**Proposta de registro idempotente (não existe atualmente):**

```text
ConclusaoVenda:
  operacao_id
  empresa_id, pedido_id
  idempotency_key
  estado:
    RESERVADA | PAGAMENTO_PENDENTE | VENDA_CONFIRMADA |
    EFEITOS_PENDENTES | CONCLUIDA | FALHA_RECONCILIACAO
  composicao_id/hash
  pagamento_ref / resultado externo
  venda_id
  estado_estoque, estado_ficha, estado_reservas, estado_financeiro
  tentativas, erro_codigo, criada_em, atualizada_em
```

Esse registro deve ser um journal mínimo de operação, não uma segunda entidade de Pedido: `pedidos` continua sendo o agregado comercial. Proposta recomendada: unicidade de `(empresa_id, pedido_id)` no journal, status de Pedido dedicado durante conclusão para bloquear edição/fila legada, e índice único parcial `(empresa_id, pedido_id)` em `vendas` quando `pedido_id IS NOT NULL` como última barreira. A migração futura deve primeiro investigar duplicidades existentes em cópia de teste autorizada; não se presume que o índice atual não único possa ser trocado sem análise de dados.

O núcleo deve gravar `pedido_id` e empresa na própria inserção da venda e manter `pedidos.venda_id`/status coerentes, ou registrar de forma durável estados intermediários e reconciliá-los. Depois de venda confirmada, retry retorna/reconcilia essa venda. Divergência entre os vínculos, pagamento externo incerto ou efeito parcial bloqueia novo pagamento e nova venda.

## 6. Elegibilidade e matriz de estados

Estados abaixo são **atuais**; elegibilidade, confirmação e regras à direita são **propostas**. Para não concorrer com o caminho legado, a recomendação é começar importando apenas `PEDIDO` e `EM_SEPARACAO`. `ABERTO` não é elegível inicialmente porque o faturamento legado aceita esse estado diretamente. `AGUARDANDO_FATURAMENTO` pertence à fila legado e não deve ser importado pela nova ponte.

| Estado atual | Importável na proposta inicial? | Confirmação operacional | Edição após reivindicar para o PDV | Cancelar/alterar antes da conclusão | Prevenção do conflito legado |
|---|---:|---|---|---|---|
| `ORCAMENTO` | Não | Converter primeiro pelo fluxo próprio em `PEDIDO` | Edição permitida conforme regra atual, até conversão | Cancelamento/exclusão conforme regras atuais; nenhuma venda | Fora do fluxo novo e da fila de faturamento até conversão |
| `PEDIDO` | Sim | Operador confirma itens/total e solicita conclusão | Bloqueada ao reivindicar; status passa a um estado exclusivo de processamento no fluxo futuro | Antes da reivindicação: regras atuais. Depois: somente recuperação/cancelamento controlado e sem reenvio cego de pagamento | Reivindicação transacional condicional. Se o envio à fila vencer a corrida e alterar status, a importação falha; se o PDV reivindicar primeiro, o estado novo não é elegível para envio/faturamento legado |
| `ABERTO` | Não, inicialmente | Não se aplica nesta primeira fase por conflito: faturamento legado aceita `ABERTO` | Não se aplica | Permanecem regras atuais | Pode ser reconsiderado somente com bloqueio legado comprovado e teste de corrida |
| `EM_SEPARACAO` | Sim | Confirmação final do operador/produção | Bloqueada ao reivindicar | Mesma regra de `PEDIDO` | Atualização condicional serializa contra envio para `AGUARDANDO_FATURAMENTO`; falha se o legado vencer |
| `AGUARDANDO_FATURAMENTO` | Não | Fluxo legado já assumiu o Pedido; não misturar filas | Não se aplica | Manter processo legado atual; não reclassificar pedidos existentes | Nenhum endpoint novo deve aceitar; preservar pedidos/estados atuais sem migração automática |
| `FATURADO` | Não para importação nova; sim para consulta/retry idempotente | Não solicita outro pagamento | Não editável por regra atual | Concilia/consulta a venda já vinculada; reversão somente nos fluxos próprios de cancelamento/devolução | Procurar venda pelo vínculo e por `(empresa, Pedido)`; nunca criar nova |
| `CANCELADO` | Não | Não se aplica | Não editável para venda | Novo fluxo não reabre automaticamente | Rejeição explícita; sem composição ou pagamento |

O estado exclusivo de processamento e seu journal são **propostos**, ainda não existem. A operação precisa entrar nesse estado por update condicional na mesma transação de claim. O estado não deve ser confundido com `AGUARDANDO_FATURAMENTO`. Não editar nem migrar registros existentes automaticamente.

### Edição, cancelamento e alterações durante o fluxo

- A tela pode exibir e calcular a prévia sem travar o Pedido. O lock persistente é adquirido ao confirmar a operação/pagamento, não apenas ao abrir a tela.
- No commit do lock, reler versão/total/itens e confirmar que continuam iguais aos da prévia. Se mudou, invalidar a prévia e exigir conferência novamente.
- Enquanto em processamento ou resultado desconhecido, bloquear edição, exclusão e envio à fila. Não liberar o Pedido apenas por timeout de HTTP.
- Se pagamento ainda não foi autorizado e a operação pode ser cancelada com segurança, liberar reserva fiscal e retornar ao estado elegível de forma condicional.
- Se TEF/pagamento foi autorizado ou ficou incerto, preservar lock/journal e reconciliar com a adquirente antes de liberar/retry. Cancelamento do Pedido não apaga pagamento nem efeitos já confirmados.

## 7. Ficha técnica: alternativas e recomendação

### A. Usar a ficha técnica vigente no momento da conclusão/produção

- **Pedidos abertos durante mudança de receita:** usam a receita vigente quando efetivamente produzidos/concluídos, mesmo que diferente da data do Pedido.
- **Rastreabilidade:** compatível com a implementação observada, que busca a ficha vigente e grava em `venda_ficha_consumo_itens` as linhas realmente consumidas; não registra a receita histórica ao aceitar o Pedido.
- **Estoque físico:** baixa os insumos correspondentes à receita efetivamente usada para preparar a mercadoria, se o momento da conclusão coincidir com a produção.
- **Ped. antigos:** compatibilidade simples, sem backfill ou migração.
- **Complexidade/risco:** menor e alinhada ao comportamento atual; risco de mudança entre pedido e preparo se a política comercial exigir receita congelada na aceitação.

### B. Gravar snapshot de ficha no Pedido

- **Pedidos abertos durante mudança de receita:** mantêm a receita e quantidades comprometidas no momento do Pedido.
- **Rastreabilidade:** forte evidência de qual composição deveria ser produzida, além do registro real de consumo.
- **Estoque físico:** pode consumir uma receita antiga mesmo que a produção use receita atual; exige decidir quando o snapshot é criado/atualizado e como tratar substituições.
- **Ped. antigos:** sem snapshot; precisaria regra explícita de fallback, não se deve reconstruir história usando catálogo atual como se fosse snapshot.
- **Complexidade/risco:** exige novo schema, validação de conversões, snapshots recursivos/consistentes e política de reedição; amplia bastante a superfície de migração.

**Recomendação arquitetural:** começar pela alternativa A, usando a ficha vigente quando o produto for efetivamente preparado/concluído e confiando no snapshot de consumo da venda para registrar o que foi debitado. É a opção que acompanha o código atual e evita inventar histórico para Pedidos antigos. A conclusão deve ocorrer no ponto operacional em que a produção/entrega está confirmada; se o negócio precisa garantir receita ao aceitar o Pedido, essa decisão muda para B e exige aprovação explícita e sprint própria antes da implementação.

## 8. Transações, idempotência e recuperação

### 8.1 Fronteira recomendada

1. **Claim SQLite:** em transação curta `BEGIN IMMEDIATE`, validar empresa/estado/versão do Pedido, reivindicar `(empresa_id, pedido_id)` e impedir que o mesmo Pedido seja enviado simultaneamente à fila legada. Um registro idempotente por operação fornece auditoria/recuperação; status dedicado impede que os fluxos existentes de edição/envio/faturamento aceitem o Pedido reivindicado.
2. **Pagamento:** executar autorização externa com referência/idempotency key única, e persistir seu resultado/referência de forma recuperável. O TEF não participa da transação SQLite; consultar/reconciliar o resultado antes de retry.
3. **Transação do núcleo:** em conexão e transação comprovadas, criar venda com `pedido_id` desde o `INSERT`, itens da composição, efeitos operacionais exatos, pagamentos/financeiro e estados locais idempotentes. Repetir deve retornar a venda por identidade do Pedido, nunca inserir outra.
4. **Saldo fiscal em ml:** a reserva do saldo fiscal não está hoje integrada. `ReservaSaldoFiscalCategoriaService` é dono de sua transação e recusa chamada dentro de transação externa. Para atomicidade total, desenhar uma operação interna que aplique débito/consumo da reserva no mesmo `db`/`BEGIN IMMEDIATE` do núcleo, ou formalizar uma saga/journal com estados e reconciliação. Não chamar o serviço transacional atual dentro da transação de venda esperando atomicidade.
5. **Finalização/reconciliação:** atualizar `pedidos.venda_id` e `FATURADO` na mesma transação, se possível, ou persistir etapa e estado recuperáveis. Efeitos externos (TEF e documento fiscal) têm seus próprios resultados; não devem provocar segunda venda/baixa.

Uma transação SQLite serializa writers na base, mas uma validação em memória antes da transação não protege de concorrência. A claim e a criação da venda precisam estar apoiadas por updates condicionais e/ou índices únicos persistentes. Caso a camada de pagamentos/estoque não possa ser movida para a transação segura sem alteração ampla do núcleo, interromper para aprovação arquitetural — não simular atomicidade.

### 8.2 Identidade e resultados para retry

- Chave de negócio: `(empresa_id, pedido_id)`. Chave de repetição do pedido de pagamento: `idempotency_key` da operação, nunca escolhida livremente por outra empresa.
- Índice único sobre `(empresa_id, pedido_id)` na venda impede duplicidade mesmo quando chamadas concorrentes ultrapassem validações iniciais; exige primeiro auditoria offline de duplicatas históricas.
- `VENDA_CONFIRMADA`/vínculos coerentes: retornar a venda existente, sem reaplicar estoque, ficha, reserva ou financeiro.
- `PAGAMENTO_PENDENTE`/resultado externo incerto: consultar adquirente/TEF e reconciliar; não reapresentar cobrança automaticamente.
- `VENDA_CONFIRMADA` sem Pedido finalizado: localizar por vínculo e empresa; conferir um para um, reparar status/vínculo condicionalmente, sem criar venda.
- `pedidos.venda_id` e `vendas.pedido_id` divergentes: bloquear e gerar alerta/ação de reconciliação explícita; não escolher nem sobrescrever silenciosamente um dos vínculos.
- Reserva fiscal ativa: confirmar empresa, categoria, quantidade, composição e referência. Reserva já consumida pela mesma operação é sucesso idempotente; reserva ausente/inconclusiva ou ativa incompatível não é sucesso e bloqueia finalização/retry até reconciliação.
- Efeitos de estoque e ficha devem ser únicos por `venda_id`/operação. A ficha atual guarda marcador por venda, mas uma venda duplicada usa outro ID; unicidade por Pedido é indispensável para evitar duplicidade em conjunto.
- Pagamentos/financeiro devem possuir referências únicas a venda/operação e estados verificáveis. O controle local precisa reconhecer o caso em que lançamento foi confirmado e a resposta se perdeu.

### 8.3 Riscos e limites atuais

| Fronteira | Evidência atual | Requisito proposto |
|---|---|---|
| Venda por Pedido | `vendas.pedido_id` é adicionado por migração e tem índice não único; núcleo não o inclui no INSERT observado | Persistir desde criação, chave única composta com empresa e reconciliar dados antigos antes do índice |
| Pedido-venda | Legado atualiza venda e Pedido depois do commit | Claim e vínculos coordenados; estado recuperável se uma transação única não for possível |
| Pagamento-DB | Pagamento/TEF processado antes de `BEGIN IMMEDIATE` | Idempotência externa e reconciliação antes de nova tentativa |
| Estoque físico | Redução acionada por cada `vendas_itens` | Itens fiscais de representação não podem ser tratados automaticamente como bens físicos entregues |
| Ficha técnica | Consulta ficha vigente, grava snapshot do consumo por venda | Passar apenas itens operacionais ao consumo uma vez; adotar decisão A/B acima |
| Reservas antigas de Pedido | Callback de consumo ignora erro e resultado no núcleo | Tornar erro explícito e distinguir consumida, já consumida, ausente e inconclusiva |
| Saldo fiscal categoria | Serviço reserva em ml e tem transação própria, sem consume por venda | Consumo idempotente e coordenado; não misturar ml com quantidade física |
| Financeiro | Writes no bloco do núcleo, usando venda/empresa; TEF e eventual NFC-e têm fronteira externa | Confirmar writes antes do commit; não duplicar recebíveis/financeiro em retry |
| Compatibilidade legado | Faturamento aceita `ABERTO`/`AGUARDANDO_FATURAMENTO`; encaminhamento altera para `AGUARDANDO_FATURAMENTO` | Reivindicar estados diferentes em update condicional, excluir `ABERTO`/`AGUARDANDO` inicialmente e testar a corrida com envio à fila |
| Empresa | Middleware e serviços validam empresa em vários pontos; o produto pode ser global no catálogo | Pedido, reserva, saldo, venda e efeitos sempre escopados pela empresa resolvida; nenhuma empresa do body ou fallback global |

## 9. Arquivos candidatos por sprint futura

Esta lista é uma proposta de escopo, não autorização para alterar esses arquivos agora.

### Sprint 2 — Motor de composição e saldo fiscal

- Reutilizar e, se aprovado, ampliar `CategoriaFiscalEmpresaService.js`, `SaldoFiscalCategoriaService.js`, `ReservaSaldoFiscalCategoriaService.js` e respectivos schemas.
- Criar serviço delimitado de composição (por exemplo, `backend/services/vendas/ComposicaoFiscalPedidoService.js`) para busca de solução exata, regras de desconto, conversão em ml, validação de elegibilidade e prévia versionada.
- Integrar sem tocar estoque físico; adicionar testes novos isolados de composição, saldo insuficiente, concorrência, chave idempotente e categorias `REFRIGERANTE`/`AGUA`.

### Sprint 3 — API e interface de importação no PDV

- [pdv.html](../../frontend/pdv/pages/pdv.html), [pdv.js](../../frontend/pdv/js/pdv.js) e, se necessário, [app.js](../../frontend/pdv/js/app.js) para ação, pesquisa, conferência e pagamento.
- Nova rota/serviço dedicado ao PDV ou extensão cuidadosamente delimitada de [pedidos.js](../../backend/rotas/pedidos.js) e [PedidoOperacionalService.js](../../backend/services/pedido/PedidoOperacionalService.js). Nunca reutilizar `POST /api/faturamento/pedidos/:id/faturar`.
- Testes de interface/API: filtro de empresa, estados elegíveis, alteração entre prévia e confirmação, total de R$ 61,98 e falha explícita sem composição.

### Sprint 4 — conclusão transacional e integração de efeitos

- [VendaContract.js](../../backend/services/vendas/VendaContract.js), [VendaContext.js](../../backend/services/vendas/VendaContext.js), [VendaOrigin.js](../../backend/services/vendas/VendaOrigin.js), [VendaApplicationService.js](../../backend/services/vendas/VendaApplicationService.js) e [VendaPagamentoService.js](../../backend/services/vendas/VendaPagamentoService.js).
- [PedidoRepository.js](../../backend/services/pedido/PedidoRepository.js), [PedidoOperacionalService.js](../../backend/services/pedido/PedidoOperacionalService.js), migrações controladas em [database.js](../../backend/database.js) e schema de journal proposto.
- Serviço de baixa/consumo compartilhado de estoque, [FichaTecnicaConsumoService.js](../../backend/services/produtos/FichaTecnicaConsumoService.js), reservas e integração financeira. Inspecionar conexão/transaction ownership antes de modificar.
- Mudança mínima de compatibilidade no estado/claim do Pedido, mantendo rotas e funcionalidade do legado. Se a barreira exigir mudar o próprio fluxo legado além de um guard transacional, parar para revisão arquitetural.
- Testes novos: sucesso, retry, concorrência, pagamento incerto, venda confirmada/Pedido desatualizado, vínculos divergentes, consumo de reservas, uma baixa física/ficha/financeiro e isolamento multiempresa.

### Sprint 5 — regressão e habilitação

- Executar os testes focados existentes de Pedido, PDV, serviço de venda, reserva, saldo fiscal, faturamento e estoque referenciados na seção 2.1, além dos testes novos da ponte.
- Habilitar por configuração/flag somente após aceite dos invariantes e plano de reconciliação operacional. Esta auditoria não recomenda ativação automática.

## 10. Critérios de aceite testáveis para implementação futura

1. Importação e pagamento mantêm Pedido e venda comercial em **R$ 61,98** no exemplo, sem editar `pedidos.total` ou seus preços.
2. Composição inclui 2 pastéis fiscais a R$ 8,99 e fecha R$ 44,00 com produtos fiscais elegíveis reais; composição inexistente/exata indisponível sem desconto retorna erro e não cria venda.
3. Desconto só aparece quando habilitado e autorizado; preços, produtos e quantidades não podem ser introduzidos pelo browser.
4. Coca-Cola 2 L continua no Pedido e aciona consumo operacional; não aparece como linha fiscal substitutiva se a regra de negócio proíbe, e o saldo lógico em ml não altera estoque físico.
5. Uma venda por `(empresa, Pedido)` com execução sequencial e concorrência controlada; retry após resposta perdida retorna a venda existente.
6. Pagamento externo aprovado seguido de falha local entra em recuperação e não dispara nova cobrança ou venda até consultar a referência externa.
7. Venda confirmada com Pedido ainda não finalizado é reconciliada sem recriar venda; vínculos divergentes bloqueiam.
8. Consumo operacional de produto/ficha técnica, reserva fiscal, pagamento e lançamento financeiro ocorre uma vez e tem estado persistente verificável.
9. Reserva ativa, consumida, liberada, ausente, incompatível ou inconclusiva produz resultado distinto e testado; “sem exceção” não basta como confirmação.
10. Pedido cancelado, orçamento, faturado, em fila legado ou de outra empresa não é concluído pela ponte.
11. A corrida entre claim PDV e envio/faturamento legado permite exatamente um vencedor; Pedido reivindicado não pode ser editado, cancelado ou enviado à fila por fluxos paralelos.
12. Testes existentes de Pedido/PDV/faturamento/estoque passam no ambiente isolado; cobertura declarada deve corresponder aos testes executados.

## 11. Questões que precisam de aprovação explícita

1. **Ficha técnica:** aprovar recomendação A (ficha vigente no preparo/conclusão) ou optar por snapshot B no momento de confirmação do Pedido.
2. **Estados iniciais elegíveis:** aprovar `PEDIDO` e `EM_SEPARACAO` apenas; manter `ABERTO` e `AGUARDANDO_FATURAMENTO` fora da ponte inicial para evitar sobreposição com o legado.
3. **Estado/journal de operação:** aprovar estado temporário exclusivo e um journal idempotente mínimo por empresa/Pedido, sem criar entidade paralela de Pedido.
4. **Descontos na composição:** definir em qual configuração empresarial o desconto é permitido, limite e autorização; sem resposta, o padrão deve ser falhar se não houver fechamento exato.
5. **Composição elegível:** especificar preços e modelos fiscais elegíveis para itens como pastel e refrigerantes, política de uso de `REFRIGERANTE`/`AGUA`, e quantidades fiscais permitidas. O código inspecionado não prova que existam dados suficientes para fechar os R$ 44,00 do exemplo.
6. **Consumo do saldo fiscal:** aprovar serviço transacional que debita/consome reserva dentro da conexão do núcleo ou saga persistente com reconciliação; os serviços atuais são transação-proprietária e não estão integrados à venda.
7. **TEF/pagamento:** definir consulta/reconciliação e decisão operacional para autorização externa incerta; SQLite não coordena atomicamente a adquirente.
8. **Histórico legado:** aprovar processo de auditoria de duplicidades em cópia isolada antes de criar índice único em `vendas`; nenhuma base oficial foi lida nesta sprint.
9. **Frete/acréscimo:** confirmar se `acrescimo` deve integrar o contrato comercial do Pedido, dado que a coluna existe mas não participa do cálculo/persistência operacional observado.

## 12. Limitações e encerramento

- O trabalho é estático; nenhum teste, simulação de concorrência ou reprodução de fluxo foi realizado.
- Nenhum schema foi aplicado, nenhuma migração executada e nenhum banco operacional ou de teste foi consultado.
- Não houve chamada SEFAZ, inicialização do ERP/Electron, commit, push, merge, reset ou checkout destrutivo.
- O estado do worktree já continha alterações locais em outras áreas; foram preservadas. Esta sprint adiciona somente este relatório.
- Não foi comprovada em runtime a capacidade dos produtos configurados de fechar exatamente o exemplo de R$ 61,98. Essa prova depende de fixtures sintéticas e testes isolados futuros.

**Conclusão:** há base para um contrato separado de Pedido comercial, composição fiscal e conclusão, mas ainda não há ponte implementada. Antes da Sprint 2, a arquitetura deve aprovar os estados elegíveis, política de ficha técnica, política de desconto, mecanismo idempotente e fronteira de consumo do saldo fiscal. A análise termina aqui para revisão arquitetural; nenhuma implementação foi iniciada.
