# AUDITORIA — Estoque (COMERCIAL vs INSUMO)

## Fatos

### Quem tem saldo
- Saldos empresariais em **`estoque_empresa`** (`empresa_id` + produto).
- Tanto COMERCIAL quanto INSUMO podem ter saldo; o que muda é **como** o Pedido/venda consome.

### COMERCIAL com ficha
- `PedidoConsumoEstoqueService.reservarConsumo`: se produto `utiliza_ficha_tecnica`, resolve requisitos pelos **insumos** da ficha (`FichaTecnicaService.obterPorProdutoId`), não pelo produto acabado (exceto regras de produto simples).
- Insumo da ficha sem controle de estoque → erro `INSUMO_SEM_CONTROLE_ESTOQUE`.
- Modo MANUAL: comentário no serviço — não reserva insumos de ficha; preserva regras de produto simples.

### INSUMO selecionado diretamente no Pedido (refrigerante)
- É uma linha `pedidos_itens` com `produto_id` = INSUMO.
- Entra na reserva como produto da linha (requisito direto), não via ficha do pastel.
- Preço de venda vem do cadastro; estoque debita o próprio SKU do refrigerante.

### Bebidas
- Operacionalmente = INSUMO comercializável (ver refrigerantes).
- Estoque: saldo do próprio produto INSUMO.

### Quando valida / reserva / baixa
| Momento | Comportamento típico |
|---|---|
| Gravar Pedido (fluxos com reserva) | `reservarConsumo` |
| Cancelar Pedido | estorno/liberação (suites 03.07/03.08) |
| Converter em venda | `consumirReservasPedidoNaVenda` / ponte núcleo |
| Ficha na venda | consumo expandido pelos componentes |

Arquivos: `PedidoConsumoEstoqueService.js`, `FichaTecnicaConsumoService.js`, `pedidoReservaPonteNucleo`.

### Empresa
Reservas e saldos filtrados por `empresa_id` do contexto do pedido.

## Não proposto
Nenhuma alteração de estoque nesta auditoria.

## Testes observados
- `tests/pedidos/pedido-consumo-estoque.test.js`
- `tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js`
- `tests/pastelaria/estorno-ficha-*.test.js`
- `tests/estoque/pedido-disponibilidade-multiempresa.test.js`
- `tests/pedidos/modo-manual-reservas-insumos-02.test.js`
