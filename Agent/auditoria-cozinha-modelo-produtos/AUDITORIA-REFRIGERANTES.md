# AUDITORIA — Refrigerantes no Pedido

## Pergunta do PO
Por que Coca-Cola, Cajuína, Fanta etc., cadastrados como INSUMOS, aparecem na pesquisa do Pedido? O operador seleciona o INSUMO ou um COMERCIAL de copo?

## Resposta factual

### O operador seleciona o próprio INSUMO
**Fato comprovado pelo código e testes:**

1. `GET /api/produtos/consulta-pedido/buscar` (`backend/rotas/produtos.js` ~1561) chama `PedidoConsultaProdutosService.buscarProdutosParaPedido`.
2. Em paralelo:
   - MIB/SearchService (comerciais vendáveis, origem `pdv`);
   - `PedidoRefrigeranteInsumoConsultaService.buscarRefrigerantesInsumos` — SQL em `produtos` com `tipo_operacional='INSUMO' AND comercializavel=1 AND ativo=1`.
3. Resultado do insumo é adaptado com `origem_cadastro: 'INSUMO'`, `tipo_operacional: 'INSUMO'`, `preco_venda` do cadastro (`adaptarInsumoRefrigeranteParaPedido`).
4. Comerciais cuja categoria é `Refrigerantes`/`Refrigerante` são **removidos** (`filtrarComerciaisSemRefrigerante` + `ehCategoriaRefrigerante`) para não competir com o fluxo operacional de insumo.
5. Teste explícito (`insumos-produto-comercializavel-01.test.js` cenário I):
   - Coca (INSUMO comercializável id 2) **aparece**;
   - Pastel COMERCIAL **aparece**;
   - “Refrigerante Copo 200 ml” COMERCIAL categoria Refrigerantes **não aparece**.

### Não há vínculo insumo → copo comercial
Comentário no próprio serviço (`PedidoRefrigeranteInsumoConsultaService.js` L8):  
“Não altera o motor de composição nem cria vínculo insumo → copo comercial.”

### Nome enganoso da função
`buscarRefrigerantesInsumos` **não** filtra por categoria Refrigerantes no SQL. Filtra **todos** os insumos comercializáveis. A palavra “Refrigerante” no nome reflete o caso de uso principal (bebidas), não o predicado SQL.

Consequência: qualquer INSUMO com `comercializavel=1` (não só refrigerante) entra na busca do Pedido se o termo bater.

### UI
- Desktop: `frontend/erp/js/pedidos.js` → `consulta-pedido/buscar`.
- Mobile: `frontend/mobile-pedido/mobile-pedido.js` L429 → mesma rota.

### Persistência
Item gravado com `produto_id` = id do INSUMO; snapshot `classificacao_operacional_snapshot = 'INSUMO'` (`PedidoRepository.carregarSnapshotsProdutos` / `normalizarClassificacaoOperacional`).

## Separação

| Situação | O que ocorre |
|---|---|
| Refrigerante operacional (Coca 2L) | INSUMO + comercializavel=1 → selecionado direto |
| Copo comercial legado | COMERCIAL categoria Refrigerantes → **oculto** na consulta Pedido |
| Queijo / massa | INSUMO comercializavel=0 → só ficha / catálogo insumos, não busca Pedido |

## Inferência
Em operação Pastelaria, refrigerantes de prateleira foram migrados para INSUMO comercializável; “copos” comerciais deixaram de ser a origem operacional do Pedido.

## Não confirmado
Estado real de cada SKU no banco oficial (não acessado).
