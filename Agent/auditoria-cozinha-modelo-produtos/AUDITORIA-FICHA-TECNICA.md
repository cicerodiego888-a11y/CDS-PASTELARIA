# AUDITORIA — Ficha Técnica e Personalização

## Caminho completo (fatos)

```
Produto COMERCIAL
  → produtos.utiliza_ficha_tecnica / permite_personalizacao_ingredientes
  → ficha_tecnica (produto_id UNIQUE)
  → ficha_tecnica_itens (insumo_id, quantidade, unidade, classificacao_comercial, preco_adicional)
  → UI Pedido (se personalização ligada)
  → PedidoPersonalizacaoService.prepararItens
  → pedidos_itens (+ snapshots de preço/personalização)
  → pedido_item_ingredientes (snapshots por ingrediente)
  → (Cozinha Sprint 02 copia para cozinha_item_ingredientes no despacho)
```

## Schema
Arquivos: `fichaTecnicaSchema.js`, `personalizacaoIngredientesSchema.js`.

### Classificações comerciais do componente
- `OBRIGATORIO_OCULTO` — sempre selecionado; não é opção de UI.
- `OPCIONAL` — operador pode incluir/excluir; sem preço extra.
- `OPCIONAL_COM_ADICIONAL` — opcional com `preco_adicional`.

Serviço: `FichaTecnicaService` (`CLASSIFICACOES_COMERCIAIS`).

## Interface
- ERP cadastro: `frontend/erp/js/produtos.js` (habilita personalização só se comercial + ficha).
- Pedido desktop: `frontend/erp/js/pedidos.js` — se `permite_personalizacao_ingredientes=1`, abre fluxo de seleção.
- Mobile: `frontend/mobile-pedido/mobile-pedido.js` — painel `mp-personalizacao`, envia `ingredientes_selecionados`.

## Carregamento e seleção
`PedidoPersonalizacaoService`:
- Carrega ficha via `FichaTecnicaService.obterPorProdutoId`.
- Valida IDs selecionados contra opcionais (`validarSelecaoContraFicha`).
- `montarSnapshot`: obrigatórios ficam `selecionado=1`; opcionais conforme escolha.
- Preço unitário = base catálogo (`preco_pedido` > promoção > `preco_venda`) + soma de adicionais selecionados.

## Preservação se cadastro mudar
- Snapshots em `pedido_item_ingredientes` (nome, qty, unidade, classificação, preço adicional, selecionado).
- Se configuração do produto mudar após item já personalizado, regras de preservação / erro `PERSONALIZACAO_CONFIGURACAO_ALTERADA`.
- Teste insumos comercializável L: alteração de `preco_venda` do produto **não** altera `preco_unitario` já gravado no item.

## Relação com Cozinha
Despacho Sprint 02 lê `pedido_item_ingredientes` e grava `cozinha_item_ingredientes` — **sem** recalcular ficha.

## Distinção das 5 situações

| # | Situação | Mecanismo |
|---|---|---|
| 1 | Comercial vendido | `pedidos_itens.produto_id` → COMERCIAL |
| 2 | Insumo na produção | `ficha_tecnica_itens` / consumo estoque |
| 3 | Insumo direto no Pedido | `comercializavel=1` → linha em `pedidos_itens` |
| 4 | Opção de personalização | ficha `OPCIONAL*` → UI + snapshot |
| 5 | Componente obrigatório | `OBRIGATORIO_OCULTO` → sempre no snapshot |

## Arquivos-chave
- `backend/services/produtos/FichaTecnicaService.js`
- `backend/services/produtos/FichaTecnicaConsumoService.js`
- `backend/services/pedido/PedidoPersonalizacaoService.js`
