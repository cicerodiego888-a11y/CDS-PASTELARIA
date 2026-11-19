# AUDITORIA — Cadastro INSUMOS

## Fatos comprovados

### Tabela
- Mesma `produtos` com `tipo_operacional = 'INSUMO'`.
- Doc oficial: “Não há tabela paralela” (`FUNDACAO_PRODUTOS_FICHA_TECNICA_PASTELARIA_03_03.md` §3).

### Campos específicos / relevantes
| Campo | Finalidade |
|---|---|
| `tipo_operacional` | Marca INSUMO |
| `comercializavel` | Opt-in venda direta no **Pedido** (não no PDV) |
| `preco_venda` | Obrigatório > 0 se `comercializavel=1` |
| `preco_compra` | Custo; **não** usado como preço no Pedido |
| `controla_estoque` | Consumo/reserva |
| `unidade` / volume | Cadastro e conversão MUC |
| `categoria_id` | Ex.: “Refrigerantes”, “Ingredientes” — não é tipo operacional |

Resolver: `backend/services/produtos/insumoComercializavel.js`.

### Papéis distintos do mesmo INSUMO
1. **Componente de ficha** (`ficha_tecnica_itens.insumo_id`) — tipicamente `comercializavel=0` (massa, queijo…).
2. **Seleção direta no Pedido** — exige `comercializavel=1` (Coca, Fanta…).
3. **Ingrediente de personalização** — aparece como opção da ficha (`OPCIONAL` / `OPCIONAL_COM_ADICIONAL`), não como linha de catálogo vendável.

### Bebidas / refrigerantes
Não há tipo “BEBIDA” no cadastro. Refrigerantes vendáveis = INSUMO + `comercializavel=1` (+ frequentemente categoria Refrigerantes). Detalhe em `AUDITORIA-REFRIGERANTES.md`.

### Unidades e estoque
- Unidade de cadastro no produto; unidade de consumo na ficha pode diferir (`ficha_tecnica_itens.unidade`).
- Saldo empresarial: `estoque_empresa` (por `empresa_id`).
- PDV rejeita venda de INSUMO (`INSUMO_NAO_VENDAVEL`).

### Quando aparece no Pedido
Somente se `buscarRefrigerantesInsumos` / `buscarInsumosComercializaveis` encontrar:  
`tipo_operacional=INSUMO AND ativo=1 AND comercializavel=1` (+ match de termo em código/nome/marca).

### Quando aparece só na ficha
`comercializavel=0` (ou NULL→0): permanece no catálogo INSUMOS do ERP, entra em fichas, **não** na busca de venda do Pedido (teste J/H em `insumos-produto-comercializavel-01.test.js`).

## Testes observados
- `tests/insumos/insumos-produto-comercializavel-01.test.js`
- `tests/pastelaria/insumo-sem-preco-venda.test.js`
- `tests/pastelaria/separacao-produtos-insumos.test.js`
- `tests/compras/custo-insumo-fluxo-compras.test.js`
