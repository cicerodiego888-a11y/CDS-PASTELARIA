# AUDITORIA — Persistência do Pedido

## Tabelas envolvidas (fatos)

| Tabela | Papel |
|---|---|
| `pedidos` | Cabeçalho (status, empresa_id, mesa_*, totais, operador…) |
| `pedidos_itens` | Linhas (`produto_id`, qty, preços, snapshots) |
| `pedido_item_ingredientes` | Personalização por item |
| `produtos` | Catálogo (FK lógica de `produto_id` / `insumo_id`) |
| `ficha_tecnica` / `ficha_tecnica_itens` | Cadastro (não duplicado no pedido; snapshots sim) |
| Reservas | `pedido_estoque_reservas` (+ pontes estoque) |

## Campos-chave em `pedidos_itens`
- `produto_id`, `quantidade`, `preco_unitario`, `subtotal`, `tipo_venda`
- Snapshots: `classificacao_operacional_snapshot`, `produto_*_snapshot`, `preco_*_snapshot`
- Personalização: `personalizacao_ingredientes_snapshot`, `preco_base_unitario_snapshot`, `preco_adicionais_unitario_snapshot`

## Como distinguir COMERCIAL vs INSUMO após gravado
**Fato:**  
`COALESCE(i.classificacao_operacional_snapshot, UPPER(COALESCE(pr.tipo_operacional,'COMERCIAL')), 'COMERCIAL')`  
em `PedidoRepository` (consulta obter pedido ~605–613).  
Origem marcada como `SNAPSHOT_PEDIDO` ou `CATALOGO_ATUAL_LEGADO`.

Valor do snapshot vem de `normalizarClassificacaoOperacional(tipo_operacional)` → `'INSUMO'` ou `'COMERCIAL'` (`PedidoRepository` ~40–41, ~214).

## Serviços / repositórios
- `PedidoOperacionalService` — orquestra UI comercial
- `PedidoRepository` — INSERT/UPDATE/DELETE + snapshots
- `PedidoPersonalizacaoService` — prepara ingredientes/preço
- `PedidoConsumoEstoqueService` — reserva/consumo
- Transações: padrões `BEGIN`/`IMMEDIATE` nos serviços de estoque/pedido (detalhe pontual depende do fluxo chamado)

## Relacionamentos
- Item → produto: `produto_id`
- Ingrediente pedido → item: `pedido_item_id`
- Ingrediente → catálogo: `insumo_id` (também `produtos.id`)
- Pedido → empresa / mesa / atendimento

## Exclusão de itens
`PedidoRepository` remove linhas anteriores não reassociadas:  
`DELETE FROM pedido_item_ingredientes` + `DELETE FROM pedidos_itens` (~886–893).

## Cozinha (reuso sem alterar Pedido)
`CozinhaDespachoService` lê pedido/itens/ingredientes e grava snapshots em `cozinha_*` — não reescreve o Pedido.
