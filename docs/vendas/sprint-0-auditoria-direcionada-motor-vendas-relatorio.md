# Sprint 0 — Auditoria direcionada do Motor de Vendas

Auditoria estática, somente leitura. Nenhum código, banco ou configuração foi alterado e nenhum teste foi executado.
Legenda: **[C]** comprovado por leitura do código · **[I]** inferido · **[P]** pendente/não verificado.

## A. Resumo executivo

1. **[C]** O Pedido **não baixa estoque físico**. Criar, editar, converter e enviar ao faturamento apenas **reservam saldo fiscal** (`MotorComercialService.confirmarPedidoFiscal` → `fxnfReservas.criarReservaFiscal`). Pode haver transferência não fiscal→fiscal via MTS, com autorização de supervisor.
2. **[C]** A baixa física ocorre **uma única vez, na criação da venda** (`VendaPagamentoService.criarVenda` → `reduzirEstoqueDistribuido` → `debitarEstoqueItemVenda` → `estoqueSaldosPublico.debitarSaldo`). Ela usa `quantidade_fiscal` e `quantidade_nao_fiscal` do mesmo `produto_id`.
3. **[C]** A ficha técnica é consumida **dentro da mesma transação** da venda (`aposBaixaItensDaVenda` → `consumirFichaTecnicaDaVendaCb`, antes do `COMMIT`). Qualquer falha dá `ROLLBACK`.
4. **[C]** Idempotência do consumo da ficha: `venda_ficha_consumo.venda_id UNIQUE`, com `SELECT` prévio e snapshot em `venda_ficha_consumo_itens`. Estorno: `estornado_em` + tabela de estornos com índice único por devolução.
5. **[C]** A venda do Faturamento recebe **exatamente os itens do Pedido** (`FaturamentoService.montarPayloadVendaDoPedido`). Não existe composição independente.
6. **[C]** O Motor F×NF (`distribuidorEstoqueVenda`) apenas divide a **quantidade de cada produto** entre saldo fiscal e não fiscal. Nunca troca o produto, o modelo fiscal nem agrupa produtos.
7. **[C]** A NF-e é emitida a partir de `vendas_itens` com `quantidade_fiscal>0` e `valor_fiscal>0` (`itemEntraNaNfe`). NCM, CFOP e CSOSN vêm do **mesmo produto** (`nfeEmissorVenda.carregarVendaParaNfe`). Compor com modelos fiscais diferentes exigiria uma camada nova.
8. **[C]** **Não existe saldo fiscal compartilhado por categoria lógica, nem saldo em ml.** O saldo é por produto (`produtos.saldo_fiscal`, `saldo_nao_fiscal` e o espelho `estoque_empresa`).
9. **[C]** O financeiro usa `total` do body (`totalNum`), não a soma dos itens distribuídos. As parcelas fiscal e não fiscal vêm do Motor.
10. **[C]** Há lacunas de consistência no consumo/vínculo da reserva do Pedido (ver seção E): erros ignorados ou só com `console.warn`.

## B. Matriz de evidências

| Pergunta | Arquivo e função | Comportamento atual comprovado | Lacuna | Recomendação |
|---|---|---|---|---|
| 1 Pedido | `services/pedido/PedidoOperacionalService.js`: `criar`, `atualizar`, `converterParaPedido`, `enviarParaFaturamento`, `cancelar` | Orçamento não reserva. Status `PEDIDO/ABERTO/EM_SEPARACAO/AGUARDANDO_FATURAMENTO` chamam `confirmarEstoqueViaMotorComercial`. O cancelamento chama `liberarReservasDoPedido` e muda o status para `CANCELADO` | Pedido só conhece saldo fiscal por produto | Manter o Pedido como fonte da verdade |
| 1 Reserva | `motores/comercial/MotorComercialService.js`: `analisarDisponibilidadeFiscal`, `executarConfirmacaoFiscal` | Recalcula sob `BEGIN IMMEDIATE`, libera reservas anteriores do pedido, transfere via MTS e grava reserva por linha com auditoria | Agrega por `produto_id`; sem noção de grupo | Estender o plano para grupo lógico depois |
| 1 Baixa | `services/vendas/VendaPagamentoService.js`: `criarVenda`, `reduzirEstoqueDistribuido`, `reduzirEstoqueComFEFO` | Baixa por item após `INSERT vendas_itens`. FEFO se o produto controla validade | Sem guarda própria contra baixa dupla além de a venda ser criada uma vez | Guarda em nível de venda (ver F) |
| 1 Ficha/MUC | `services/produtos/FichaTecnicaConsumoService.js`: `montarLinhasConsumo`, `converterQuantidadeFichaParaEstoque` | Ficha da venda → insumo (`tipo_operacional=INSUMO`) → conversão via `obterMuc(db).converterQuantidade` até a unidade de estoque do insumo | O MUC só atua na ficha e nas compras. No caminho Pedido/Venda não há conversão venda→estoque **[P: PDV pode enviar `quantidade_estoque`; não verificado]** | Reutilizar |
| 1 Anti-repetição | `consumirFichaTecnicaDaVenda`; `vendaFichaConsumoSchema.js` | `venda_id UNIQUE`, retorno `ja_consumido` e INSERT no cabeçalho/itens na mesma transação | `SELECT` prévio + `INSERT`: a unicidade protege a segunda inserção, mas a baixa do insumo precede o `INSERT` e é desfeita só pelo `ROLLBACK` | Manter; testar concorrência |
| 1 Cancelamento | `VendaCancelamentoService.devolverEstoqueEEstornarFichaDaVenda`; `FichaTecnicaConsumoService.estornarConsumoFichaTecnicaDaVenda` | Devolve estoque com base em `vendas_itens` e estorna o snapshot da ficha (não relê a ficha vigente). Idempotente por `estornado_em`; empresa conferida | O cancelamento da venda **não referencia pedido** (zero ocorrências de "pedido" no arquivo) | Definir regra de status do Pedido/reserva após cancelar venda |
| 2 Entrada de itens | `distribuidorEstoqueVenda.distribuirItensVendaComValorFiscalEfetivo` | Recebe `{item, saldoFiscal, saldoNaoFiscal}`, mais `venda_fiscal`, pagamentos, desconto, acréscimo e política MPFC | Por item, nunca entre produtos | Reutilizar o Motor como base de entrada |
| 2 Separação | `distribuirQuantidadeVenda`, `corrigirIntegridadeQuantidadesFiscais`, `montarComposicaoFiscalInteiraAbaixo/ParaCima` | Com `venda_fiscal` prioriza saldo fiscal. Sem ele usa o mínimo fiscal. Ajusta o valor fiscal efetivo (MIDP). Preserva quantidade inteira para unidades não fracionáveis | **Composição para cima/para baixo ajusta quantidade de itens que já existem**, e não escolhe modelos fiscais alternativos | Criar um novo componente de composição |
| 2 Saldos | `fiscalNaoFiscal/estoqueSaldosPublico.js`: `consultarSaldo`, `_ajustarSaldo`, `debitarSaldo`, `transferirSaldoEntreTipos` | Porta única. Com empresa lê `estoque_empresa` (sem registro = 0). A escrita lê `produtos`, valida e grava `produtos`, com espelho em `estoque_empresa` | Leitura e escrita usam fontes diferentes. Saldo por produto | Estender com cuidado; não duplicar |
| 2 Reservas | `fiscalNaoFiscal/reservasPublico.js`; `services/estoque/EstoqueDisponivelService.calcularEstoqueProduto` | `disponivel = saldo - reservado` por tipo. `pedido_estoque_reservas` com `ATIVA/CONSUMIDA/CANCELADA`, filtrado por empresa | Reservas por `produto_id` | Estender |
| 2 Classificação | `produtos.tipo_operacional` (`COMERCIAL`/`INSUMO`), `exigirProdutosVendaveisNaVenda` | Só distingue insumo de comercial | **Não há categoria lógica refrigerante/água para saldo** **[P: `categoria` existe no cadastro; não avaliada como chave de grupo]** | Investigar |
| 2 Empresa/ambiente | `fiscalNaoFiscal/empresaContexto.js`; `PedidoEmpresaContextoService`; `VendaEmpresaContextoService`; `nfeCertificadoUso.carregarConfigEAplicarGateCertificadoNfe` | Pedido: `pedidos.empresa_id`. Venda: `vendas.empresa_id`. A NF-e usa configuração fiscal da empresa (`getFiscalConfig({empresaId})`) e `config.ambiente` | O ambiente é lido da configuração fiscal; não aprofundei a origem no Motor | Reutilizar |
| 3 Pedido→Venda | `FaturamentoService.faturarPedido`, `montarPayloadVendaDoPedido`, `invocarNucleo` | Itens do pedido copiados 1:1 (produto, quantidade, preço, desconto, subtotal). Total = `pedido.total + frete + acréscimo − desconto`. `emitir_fiscal=false`, `venda_fiscal` = modo F12 | Sem objeto de composição fiscal separado | Criar a composição derivada, em tabela própria |
| 3 Venda→Financeiro | `criarVenda`: `INSERT financeiro` (`totalNum`), `contas_receber` quando a prazo | Valor = `total` do body, dentro da transação da venda | Divergência possível entre `total` e itens distribuídos; validação só via `validarSomaPagamentosVenda` com fiscal/não fiscal do Motor | Validar total contra o Pedido na composição |
| 3 Pós-venda | `faturarPedido`: `UPDATE vendas SET origem, pedido_id` e `consumirReservasDaVenda`/`consumirReservasPedidoNaVenda` | Rodam **depois** da venda e fora da transação dela; falhas só viram `console.warn` | Venda pode ficar sem `pedido_id` e reserva `ATIVA` residual | Ver riscos |
| 3 NF-e | `nfeEmissorVenda.emitirNfePorVendaId`; `xmlBuilderNfeVenda.itemEntraNaNfe` | NF-e a partir de `vendas_itens` (parcela fiscal) + dados do produto | Sem tabela intermediária de itens fiscais | Criar camada de composição antes da NF-e |
| 4 Persistência | `produtos.saldo_fiscal/saldo_nao_fiscal/estoque_atual` e `estoque_empresa` | Invariante `estoque_atual = fiscal + não fiscal` | **Sem saldo em ml compartilhado nem grupo lógico** | Criar componente novo |
| 4 Unidades | `motores/muc/**`, `ProdutoConversaoConfigService`, `core/unidadesSi.js` | ML é unidade SI conhecida. Conversões por produto (`utiliza_conversao`, relações e apresentações) | Conversão é por produto. Não há conversão para unidade de grupo | Reutilizar o MUC para produto→ml |
| 4 Concorrência | `executarConfirmacaoFiscal` (`BEGIN IMMEDIATE` + recálculo); `reservasPublico.executarComTxOuReutilizar` | Reservas recalculadas sob lock | Débitos de venda e reservas não consideram grupo | Estender |
| 4 Estoque mínimo | `produtos.estoque_minimo`, `MisIndicadoresService` (consulta `estoque <= estoque_minimo`) | Existe por produto, usado em indicador | Sem estoque mínimo por grupo | Estender |

## C. Fluxos atuais (somente o que foi comprovado)

**Pedido e consumo**
`PedidoOperacionalService.criar/converter/enviarParaFaturamento` → `MotorComercial.analisarDisponibilidadeFiscal` → (`TRANSFERIR_E_RESERVAR` exige supervisor) → `executarConfirmacaoFiscal` (`BEGIN IMMEDIATE` → `liberarReservasPedido` → `mts.transferirSaldo` se necessário → `criarReservaFiscal` por linha). **Sem baixa física nesta etapa.**

**Venda e composição fiscal**
`FaturamentoService.faturarPedido` → `montarPayloadVendaDoPedido` (itens 1:1) → `invocarNucleo` → `VendaApplicationService.criarVendaComContexto` → `VendaPagamentoService.criarVenda`. Dentro de `criarVenda`: `obterCreditoReservaPedidoCb` → `distribuirItensVendaComValorFiscalEfetivo` → `INSERT vendas` → `INSERT vendas_itens` → `reduzirEstoqueDistribuido` → `aposBaixaItensDaVenda` (ficha + `consumirReservasPedidoNaVendaCb`) → financeiro → `COMMIT`. NF-e depois, pela Central: `CentralFaturamentoService.emitir` → `emitirNfePorVendaId` (itens fiscais de `vendas_itens`).

**Venda e financeiro**
`criarVenda` → (a prazo: `contas_receber`) → `INSERT financeiro` (`receita`, valor `totalNum`) → opcionalmente `clientes.credito_atual` → `COMMIT`.

**Cancelamento e estorno**
- *Venda*: `cancelarVendaPut/Post` (`BEGIN IMMEDIATE`) → `devolverEstoqueItensVenda` (por `vendas_itens`) → `estornarConsumoFichaTecnicaDaVendaCb` (snapshot) → recebimentos cancelados → `vendas.status='cancelada'` → `cancelarFinanceiroVenda` + lançamento de estorno → `COMMIT`.
- *Devolução parcial*: `VendaDevolucaoService` (`BEGIN IMMEDIATE`) → estoque proporcional → `estornarConsumoFichaTecnicaDaDevolucaoCb`.
- *Pedido*: `cancelar` → `liberarReservasDoPedido` → status `CANCELADO` (não permitido para `FATURADO`).
- **[P]** Não foi lido o ponto que decide se o cancelamento de NFC-e/NF-e já autorizada altera o estoque além do que está descrito acima.

## D. Matriz de reaproveitamento

| Componente | Classificação | Justificativa |
|---|---|---|
| `PedidoOperacionalService` / `PedidoRepository` | Reutilizar | O Pedido já é a fonte operacional e não baixa estoque. |
| `MotorComercialService` (reserva fiscal) | Estender | Já reserva com lock e auditoria, mas por produto; falta disponibilidade por grupo. |
| `FaturamentoService.faturarPedido` | Estender | Ponto único de Pedido→Venda; é onde a composição derivada deve ser anexada. |
| `VendaPagamentoService.criarVenda` | Reutilizar | A baixa operacional e o financeiro devem permanecer; evitar mexer na ordem. |
| `distribuidorEstoqueVenda` | Reutilizar | Distribui fiscal/não fiscal por produto; é a base para o saldo físico e o valor fiscal máximo. |
| Motor de composição fiscal entre modelos | Criar componente novo | Nada hoje escolhe modelos fiscais diferentes dos produtos do Pedido. |
| `FichaTecnicaConsumoService` | Reutilizar | Já é idempotente, transacional e com estorno por snapshot. |
| `estoqueSaldosPublico` / `reservasPublico` | Estender | Porta única de saldos com empresa; precisa de um saldo lógico por grupo em ml. |
| Saldo fiscal compartilhado em ml | Criar componente novo | Não existe tabela, coluna ou serviço. |
| MUC (`obterMuc().converterQuantidade`) | Reutilizar | Já converte produto→ml com relações validadas. |
| `tipo_operacional` | Investigar antes de decidir | Só separa COMERCIAL/INSUMO; categoria lógica refrigerante/água ainda não existe. |
| `estoque_minimo` + MIS | Estender | Existe por produto; falta para o grupo. |
| `nfeEmissorVenda` / `xmlBuilderNfeVenda` | Investigar antes de decidir | Consomem `vendas_itens`; precisa-se decidir se leem itens da composição. |
| `VendaCancelamentoService` / `VendaDevolucaoService` | Estender | Já estornam ficha e estoque; precisam estornar a composição fiscal. |

## E. Riscos de integração (todos sustentados por evidência)

1. **Baixa duplicada** — **[C]** Pedido não baixa, mas a venda baixa o produto. Se a composição fiscal debitar o saldo lógico em ml **e** o produto físico, haveria duplicidade. A venda fiscal precisa ser só derivada. A guarda atual da ficha (`venda_id UNIQUE`) é por venda; não existe guarda equivalente para a baixa de produtos.
2. **Mistura de saldos** — **[C]** Hoje o saldo fiscal é por produto. Um saldo lógico em ml exige estrutura separada e rastreável, sem reutilizar `produtos.saldo_fiscal` (invariante `estoque_atual = fiscal + não fiscal`).
3. **Concorrência entre caixas** — **[C]** `_ajustarSaldo` lê `produtos`, valida e grava (check-then-act) e depende da `BEGIN IMMEDIATE` do chamador. Leitura de saldo (`estoque_empresa`) e escrita (`produtos`) usam fontes diferentes. Um saldo compartilhado amplia a janela de corrida **[I]**.
4. **Reprocessamento** — **[C]** `faturarPedido` rejeita pedido já `FATURADO`, mas o vínculo `vendas.pedido_id` e o consumo de reservas ocorrem fora da transação da venda, com falha só em `console.warn`. Uma falha entre `criarVenda` e `marcarFaturado` deixa venda criada com pedido ainda aguardando faturamento **[I]**.
5. **Reserva residual** — **[C]** Em `criarVenda`, o erro de `consumirReservasPedidoNaVendaCb` é ignorado (`() => next()`).
6. **Divergência de valores** — **[C]** O financeiro grava `total` do body; a composição fiscal precisa fechar com esse total e com `valor_fiscal`/`valor_nao_fiscal` do Motor.
7. **Cancelamento e estorno** — **[C]** O cancelamento da venda não toca o Pedido nem reservas. Uma composição fiscal precisaria ser estornada junto, com idempotência equivalente à da ficha.
8. **Isolamento por empresa** — **[C]** Pedido, venda, reservas, consumo da ficha e NF-e já carregam `empresa_id`; um grupo lógico precisaria da mesma chave. A ficha técnica **não** tem `empresa_id` (por desenho).
9. **Validade fiscal / modelos** — **[P]** Não foi lida nenhuma regra de "validade fiscal" de modelo; o requisito precisa ser definido antes.

## F. Plano de implementação sugerido (ordem de dependência)

1. **Sprint 1 — Modelo de domínio (somente leitura/migração local de teste).** Definir categorias lógicas (refrigerante, água) e vínculo produto→grupo, por empresa. Alvos: novo serviço em `backend/services/estoque/`, schema próprio e testes. Decisão prévia sobre o uso de `categoria`.
2. **Sprint 2 — Saldo fiscal lógico em ml.** Tabela e porta de leitura, reserva e débito com chave `(empresa_id, grupo)`, idempotência por venda/pedido e ledger de movimentos. Alvos: `estoqueSaldosPublico.js`, `reservasPublico.js` (extensão) e MUC para produto→ml.
3. **Sprint 3 — Motor de composição fiscal.** Dado o Pedido e o saldo lógico, escolher modelos elegíveis: fechamento exato, senão menor desconto permitido. Componente novo, puro e testável, sem acessar banco. Alvo: novo módulo ao lado de `distribuidorEstoqueVenda.js`.
4. **Sprint 4 — Persistência da composição.** Tabela de itens fiscais derivados da venda (referência a `vendas_itens`, `empresa_id`, `modelo_fiscal`, quantidade e valor). Gravar dentro da transação de `criarVenda`, sem alterar a ordem. Alvos: `VendaPagamentoService.js`, `FaturamentoService.js`.
5. **Sprint 5 — NF-e e financeiro.** Fazer `nfeEmissorVenda`/`xmlBuilderNfeVenda` consumirem a composição quando existir; validar o total contra o Pedido. Alvos: `nfeEmissorVenda.js`, `CentralFaturamentoService.js`.
6. **Sprint 6 — Cancelamento, devolução e reprocessamento.** Estornar a composição e o saldo lógico com idempotência; tratar reserva residual e vínculo `pedido_id`. Alvos: `VendaCancelamentoService.js`, `VendaDevolucaoService.js`, `pedidoReservaPonteNucleo.js`.
7. **Sprint 7 — Estoque mínimo e alertas por grupo.** Reutilizar o padrão de `MisIndicadoresService`.

## G. Limitações

- O ZIP `CDS PASTELARIA(6).zip` **não foi encontrado**. Existe `CDS PASTELARIA.zip` na raiz, que não foi usado.
- Não foram lidos integralmente: `VendaApplicationService.criarVendaComContexto`, `VendaFiscalService`, `FinanceiroEmpresaContextoService`, `mts/`, `EstoqueEmpresaService`, trechos de `distribuidorEstoqueVenda` (ajuste do valor fiscal efetivo/MIDP) e `VendaDevolucaoService` além dos pontos de entrada.
- **[P]** Não se verificou se o PDV envia `quantidade_estoque` ou outro campo de conversão de unidade de venda.
- **[P]** Não se confirmou a origem do `ambiente` além de `config.ambiente` vindo de `getFiscalConfig({empresaId})`.
- **[P]** Não se avaliou o fluxo de entrega (`CriarVendaEntregaService`) nem NF-e avulsa.
- Nenhum teste foi executado, nenhuma suíte completa, nenhum acesso ao banco oficial e nenhuma chamada à SEFAZ.
- Apenas este relatório e o diretório `docs/vendas/` foram criados. A área de trabalho já continha ~290 alterações preexistentes não relacionadas, que não foram tocadas.
