# RELATÓRIO EXECUTIVO — Cadastros, Insumos e Fluxo de Pedidos

**Projeto:** CDS Sistemas — Pastelaria  
**Tipo:** Auditoria somente leitura  
**Data:** 2026-11-16  
**Objetivo:** Entender o modelo atual antes de classificar PASTEL/BEBIDA/OUTRO na Cozinha.

---

## Veredito em uma frase

O CDS diferencia **COMERCIAL** e **INSUMO** na mesma tabela `produtos` via `tipo_operacional`; refrigerantes entram no Pedido como **INSUMO com `comercializavel=1`**, não como produto COMERCIAL de “copo”, e pastéis entram como **COMERCIAL** com ficha técnica e personalização opcional.

---

## Respostas às 10 perguntas obrigatórias

### 1. Como o CDS diferencia COMERCIAL e INSUMOS?
**Fato:** coluna `produtos.tipo_operacional` ∈ `{COMERCIAL, INSUMO}` (`backend/services/produtos/tipoOperacionalProduto.js`). Default legado = `COMERCIAL`. Não há tabela paralela de insumos.

### 2. Por que refrigerantes (Coca, Fanta…) aparecem no Pedido sendo INSUMO?
**Fato:** sprint `CDS-INSUMOS-PRODUTO-COMERCIALIZAVEL-01`. Flag `produtos.comercializavel=1` + `tipo_operacional=INSUMO` + `ativo=1` → incluídos em `PedidoRefrigeranteInsumoConsultaService.buscarRefrigerantesInsumos`.  
A rota `GET /api/produtos/consulta-pedido/buscar` mescla esses insumos com comerciais MIB, e **remove** comerciais da categoria `Refrigerantes`/`Refrigerante` para evitar duplicidade com “copo”.

### 3. Fluxo de seleção/gravação dos refrigerantes
Pesquisa Pedido → seleciona `produto.id` do INSUMO comercializável → grava em `pedidos_itens.produto_id` com `classificacao_operacional_snapshot='INSUMO'` → preço = `preco_venda` (nunca `preco_compra`). Sem ficha técnica obrigatória para esse item.

### 4. Fluxo dos pastéis
COMERCIAL ativo (tipicamente categoria Pasteis) → pesquisa MIB na consulta Pedido → se `permite_personalizacao_ingredientes=1`, UI abre ficha → grava item + `pedido_item_ingredientes` com snapshots.

### 5. Ficha técnica pastel → insumos
`ficha_tecnica` (1 por `produto_id` COMERCIAL) → `ficha_tecnica_itens.insumo_id` aponta para `produtos` INSUMO. Classificações: `OBRIGATORIO_OCULTO | OPCIONAL | OPCIONAL_COM_ADICIONAL`.

### 6. Personalizações
Tabela `pedido_item_ingredientes` + flags em `pedidos_itens` (`personalizacao_ingredientes_snapshot`, preços base/adicionais). Serviço: `PedidoPersonalizacaoService`.

### 7. Como a Cozinha recebe dados sem mudar o Pedido?
Reutilizar: `pedidos` / `pedidos_itens` / `pedido_item_ingredientes` / snapshots (`classificacao_operacional_snapshot`, nomes, qty) já copiados no despacho Sprint 02 para `cozinha_*`. Não alterar o motor do Pedido.

### 8. O que já existe e pode ser reutilizado?
- `tipo_operacional` + snapshot no item  
- `comercializavel` (INSUMO vendável no Pedido)  
- `categoria` (ex.: Refrigerantes) — útil como **sinal**, não como classificação Cozinha única  
- Ficha + personalização + snapshots de ingredientes  
- Unidades/volume (`utiliza_volume`, `volume_*`)  
- Mesa/atendimento/pedido status  

### 9. O que está ausente?
- Campo oficial **PASTEL | BEBIDA | OUTRO** no cadastro ou no item  
- Distinção Cozinha entre INSUMO-ingrediente e INSUMO-bebida além de `comercializavel` + categoria  
- Soft-cancel de linha de pedido (só DELETE)

### 10. Forma mais segura de classificar PASTEL/BEBIDA/OUTRO (sem inventar ainda)
Ver `RECOMENDACAO-CLASSIFICACAO-COZINHA.md`. Em resumo: **não** mapear `COMERCIAL→PASTEL`; usar sinais já existentes (`comercializavel`, categoria, personalização/ficha) como *heurística candidata* só após decisão do PO; preferir campo explícito se a operação exigir certeza.

---

## Separação epistemológica

| Tipo | Conteúdo |
|---|---|
| **Fatos** | Códigos/serviços citados nos documentos deste pacote |
| **Testes observados** | `tests/insumos/insumos-produto-comercializavel-01.test.js`, `tests/pedidos/pedido-busca-refrigerantes-insumos-02.test.js`, suites pastelaria/ficha |
| **Inferências** | Que “pastel” operacional = COMERCIAL com ficha/personalização (padrão de uso, não enum) |
| **Não confirmado** | Dados reais do banco oficial (não acessado); se todos os refrigerantes de produção estão de fato com `comercializavel=1` |

---

## Declaração

- Nenhum arquivo do projeto foi modificado nesta auditoria (somente criação sob `Agent/auditoria-cozinha-modelo-produtos/`).  
- Nenhuma migration, cadastro, operação fiscal/financeira/estoque.  
- Banco oficial não acessado.  
- Sprint 03 não iniciada.  
- Classificação PASTEL/BEBIDA/OUTRO **não** implementada.
