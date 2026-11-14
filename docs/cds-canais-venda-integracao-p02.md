# CDS-CANAIS-VENDA-INTEGRACAO-P0.2

## Mapa do fluxo comercial

- `POST /api/pedidos` passa pelo contexto empresarial autenticado e chama `EntradaPedidoService.receber()`.
- `EntradaPedidoService` valida a origem definida pelo servidor e delega criação, validações operacionais, reserva e persistência a `PedidoOperacionalService`.
- `PedidoRepository.criarPedido()` persiste `pedidos.empresa_id` e `pedidos.origem_canal`; pedidos legados sem código de canal continuam com origem `EQUIPE` ou `NULL`, conforme o caminho de criação.
- Conversões de orçamento em pedido mantêm a empresa persistida e não recebem código de canal dinâmico.
- Faturamento de pedido cria/vincula a venda por `vendas.pedido_id`, preservando a empresa do pedido. A venda mantém sua origem comercial (`FATURAMENTO`), distinta do código do canal de entrada.
- Venda direta no PDV e venda direta de entrega seguem fluxos separados; não foram integradas nesta sprint. A identificação fiscal continua usando a empresa já persistida na venda. Nenhuma emissão fiscal foi executada.
- Os campos existentes são suficientes: `pedidos.origem_canal`, `pedidos.empresa_id`, `vendas.pedido_id` e `vendas.empresa_id`. Não foi necessária migration.

## Integração implementada

Um adaptador servidor pode definir `req.canalVendaCodigo`; o valor não é lido do corpo HTTP. A rota de pedidos o encaminha, junto com o usuário autenticado e a conexão de banco, à camada central. Quando ausente, o caminho legado permanece inalterado. Quando informado, o código é resolvido exclusivamente por `CanalVendaEmpresaService.resolverEmpresaDoCanal()`.

Para canais ativos, a empresa vinculada precisa existir, estar ativa e ser autorizada ao usuário. Se ela divergir da empresa selecionada e validada para a operação, a criação é rejeitada com HTTP 409 (`CANAL_EMPRESA_DIVERGENTE`); a empresa operacional não é sobrescrita. A empresa resolvida é persistida no pedido somente quando já coincide com o contexto autorizado.

O código estável resolvido é salvo em `pedidos.origem_canal` e, no faturamento, permanece rastreável pela relação pedido-venda. Não se altera a empresa proprietária do estoque nem se deriva empresa fiscal do canal.

O código especial `PDV` continua usando a configuração existente: `MULTIPLAS` mantém a empresa selecionada na operação; `UNICA` valida `pdv_empresa_id` e rejeita divergência. O modo operacional global não é usado para resolver o canal.

## Limites e validação

No código rastreado não há adaptador externo ativo que defina `req.canalVendaCodigo`; portanto a integração só é acionada por adaptadores internos futuros que atribuam essa propriedade no servidor. Nenhuma rota pública foi criada. Os testes usam banco isolado e dados sintéticos; não foram realizadas operações comerciais reais nem acessado o banco oficial.
