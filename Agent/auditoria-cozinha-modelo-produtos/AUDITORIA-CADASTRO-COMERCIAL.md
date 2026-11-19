# AUDITORIA — Cadastro COMERCIAL

## Fatos comprovados

### Tabela
- Única tabela de catálogo: **`produtos`** (`docs/arquitetura/FUNDACAO_PRODUTOS_FICHA_TECNICA_PASTELARIA_03_03.md`, `tipoOperacionalProduto.js`).
- Sem `produto_empresa`. Catálogo compartilhado entre empresas.

### Classificação
- `produtos.tipo_operacional = 'COMERCIAL'` (aliases API: `PRODUTO_COMERCIAL`, `PRODUTO`).
- Default se nulo/vazio: **COMERCIAL** (`normalizarTipoOperacional`).

### Cadastro (API)
- Rotas em `backend/rotas/produtos.js` (POST criação / PUT edição).
- Campos relevantes tipicamente gravados: código, nome, `nome_comercial`, unidade, preços (`preco_venda`, `preco_pedido`), categoria, marca, `ativo`, `tipo_operacional`, volume (`utiliza_volume`, `volume_valor`, `volume_unidade`), `utiliza_ficha_tecnica`, `permite_personalizacao_ingredientes`.
- Para COMERCIAL, `comercializavel` é forçado a **0** (`insumoComercializavel.resolverComercializavelEPreco` — “campo não se aplica”).

### Preços e unidades
- `preco_venda` — venda geral / PDV.
- `preco_pedido` — preço específico do Pedido (preferido na personalização: `PedidoPersonalizacaoService.obterPrecoBaseCatalogo`).
- Unidade de cadastro em `produtos.unidade`; volumes comerciais via colunas de volume + MUC.

### Disponibilidade no Pedido
- Entram via MIB SearchService com origem `pdv` na função `buscarComerciaisPdv` embutida em `GET /produtos/consulta-pedido/buscar` (`rotas/produtos.js` ~1561–1624).
- PDV Normal **só** vende COMERCIAL (`produtoEhVendavelPdv`, `sqlFiltroProdutoVendavelPdv`, `INSUMO_NAO_VENDAVEL`).

### Ficha técnica
- Flag `utiliza_ficha_tecnica` (nullable legado).
- Cabeçalho só em produto **comercial** e **ativo** (`FichaTecnicaService` / doc 03.03).
- `permite_personalizacao_ingredientes` exige ficha com opcionais.

### Ativo / inativo
- `produtos.ativo`. Consultas de Pedido de insumos exigem `ativo=1`; comerciais MIB seguem filtros do SearchService (não re-inspecionado linha a linha do MIB nesta auditoria).

### Personalização
- Só faz sentido em COMERCIAL com ficha + flag de personalização (UI ERP `frontend/erp/js/produtos.js` desabilita personalização se não for comercial / sem ficha).

## Exemplos em testes
- `tests/insumos/insumos-produto-comercializavel-01.test.js`: produto `PASTEL01` COMERCIAL id 100 permanece na mescla Pedido; `COPO200` COMERCIAL categoria Refrigerantes é **filtrado** da lista comercial.
- `tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js`, `tests/pastelaria/separacao-produtos-insumos.test.js`.

## Inferências
- “Pastel” não é um enum de banco; é um produto COMERCIAL tipicamente com ficha/personalização e categoria de pasteis.

## Não confirmado
- Conteúdo real do banco oficial de produção (não acessado).
