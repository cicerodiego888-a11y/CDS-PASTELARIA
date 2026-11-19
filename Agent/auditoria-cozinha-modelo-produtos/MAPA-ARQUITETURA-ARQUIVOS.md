# MAPA — Arquivos e serviços do fluxo real

| Etapa | Arquivo | Função/serviço | Responsabilidade | Chamado por | Dados / tabelas |
|---|---|---|---|---|---|
| Tipo operacional | `backend/services/produtos/tipoOperacionalProduto.js` | `normalizarTipoOperacional`, filtros PDV | COMERCIAL vs INSUMO | rotas produtos, vendas, MIB | `produtos.tipo_operacional` |
| Insumo comercializável | `backend/services/produtos/insumoComercializavel.js` | `resolverComercializavelEPreco` | Flag + preço INSUMO | `rotas/produtos.js` create/update | `produtos.comercializavel`, `preco_venda` |
| Cadastro UI | `frontend/erp/js/produtos.js` | formulário | Cadastro comercial/insumo/ficha | operador ERP | API produtos |
| Schema ficha | `backend/services/produtos/fichaTecnicaSchema.js` | DDL | Tabelas ficha | init / serviços | `ficha_tecnica*` |
| Ficha | `backend/services/produtos/FichaTecnicaService.js` | `obterPorProdutoId`, gravar | CRUD ficha | rotas produtos, personalização, estoque | ficha + itens |
| Personalização schema | `personalizacaoIngredientesSchema.js` | garantir colunas/tabela | Pedido ingredients | personalização | `pedido_item_ingredientes` |
| Personalização | `PedidoPersonalizacaoService.js` | `prepararItens` | Seleção + preço | `PedidoOperacionalService` / repo | snapshots |
| Busca Pedido | `rotas/produtos.js` `GET …/consulta-pedido/buscar` | handler | HTTP | UI Pedido | — |
| Mescla busca | `PedidoConsultaProdutosService.js` | `buscarProdutosParaPedido` | Comerciais + insumos | rota acima | — |
| Insumos na busca | `PedidoRefrigeranteInsumoConsultaService.js` | `buscarRefrigerantesInsumos` | SQL comercializáveis | consulta Pedido | `produtos` |
| Filtro copo | mesmo arquivo | `ehCategoriaRefrigerante` | Remove COMERCIAL Refrigerantes | consulta Pedido | categoria nome |
| UI Pedido | `frontend/erp/js/pedidos.js` | fetch consulta + montagem | Operador desktop | — | API |
| UI Mobile | `frontend/mobile-pedido/mobile-pedido.js` | idem | Operador mobile | — | API |
| Operacional | `PedidoOperacionalService.js` | criar/editar/cancelar/enviar | Ciclo de vida | `rotas/pedidos.js` | pedidos* |
| Persistência | `PedidoRepository.js` | criar/atualizar/obter | SQL + snapshots | operacional | `pedidos`, `pedidos_itens` |
| Estoque pedido | `PedidoConsumoEstoqueService.js` | `reservarConsumo` | Reserva/consumo | operacional | reservas / estoque |
| Consumo ficha | `FichaTecnicaConsumoService.js` | consumo | Expansão insumos | estoque/venda | ficha |
| Mesa | `MesaAtendimentoService.js` | abrir/vincular | Atendimento | mesas/pedidos | `mesa_atendimentos` |
| Prep legado | `PedidoPreparacaoService.js` | envio prep | Legado (não Cozinha V1) | rotas | `pedido_preparacoes` |
| Despacho Cozinha | `CozinhaDespachoService.js` | `despacharLote` | Rodada FIFO | `rotas/cozinha.js` | `cozinha_*` (lê pedido) |
| Enums status | `pedido/enums.js` | `PedidoStatus` | Estados | vários | `pedidos.status` |

Prioridade: estes arquivos estão no caminho de execução real da Pastelaria; nomes “parecidos” (ex.: composição fiscal PDV) **não** substituem a consulta Pedido.
