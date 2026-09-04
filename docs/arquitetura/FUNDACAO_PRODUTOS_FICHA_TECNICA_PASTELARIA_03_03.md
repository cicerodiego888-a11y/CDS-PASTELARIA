# Fundação de produtos e ficha técnica — Operação Pastelaria (Sprint 03.03)

## 1. Estrutura existente (auditoria)

| Estrutura | Classe | Decisão |
|-----------|--------|---------|
| `produtos` | A reutilizar | Catálogo compartilhado; sem `empresa_id` |
| `categorias.tipo` | C legado | Só `produto` / `despesa` — **não** é comercial/insumo |
| Tabela de insumos | E ausente | Tipo no próprio produto |
| Ficha técnica | E ausente | Criada nesta sprint |
| `estoque_empresa` | A reutilizar | Saldo por `empresa_id` |
| MUC / `MotorUnidadesMedida` / `MotorConversao` | A reutilizar | Sem conversor novo |
| `produto_embalagens` | A reutilizar | Compra vs consumo |
| Consulta PDV `GET /api/produtos` | B adaptar | Filtro `somente_vendaveis` / origem PDV |
| MIB `consulta-pdv/buscar` | B adaptar | Origem `pdv` exclui INSUMO |
| PDV Universal | C legado congelado | Não alterado |

Não existe `produto_empresa`. Não foi criado.

## 2. Produtos

Uma linha em `produtos` é o item de catálogo. Default legado: **COMERCIAL** (vendável). PLU, código de barras, atalho, preço, unidade, peso e volume permanecem nos campos atuais.

## 3. Insumos

Não há tabela paralela. Insumo = `produtos.tipo_operacional = 'INSUMO'`.

Pode ter unidade de cadastro/compra (MUC, embalagens) e unidade de consumo na ficha (`ficha_tecnica_itens.unidade`).

## 4. Produto comercial

`tipo_operacional = 'COMERCIAL'` (aliases aceitos na API: `PRODUTO_COMERCIAL`, `PRODUTO`). É o único tipo que entra no PDV Normal e no `POST /api/vendas`.

## 5. Ficha técnica

Característica do **produto**, compartilhada entre empresas:

- `ficha_tecnica`: `id`, `produto_id` (único), `ativo`
- **Sem `empresa_id`** — não é configuração por CNPJ

Cabeçalho só em produto **comercial** e **ativo**.

## 6. Componentes

`ficha_tecnica_itens`: `insumo_id` (produto INSUMO ativo), `quantidade` > 0, `unidade` conhecida no Motor de Unidades.

Não: comercial como componente; ficha em insumo; aninhar ficha de insumo.

## 7. Unidades

`MotorUnidadesMedida` (`UNIDADES_COMERCIAIS`, mapa XML). Validação da ficha usa `isUnidadeComercialConhecida` (não cai em `UN` para lixo).

## 8. Conversões

`MotorConversao` / pipeline MUC. A ficha **não** baixa estoque. `converterQuantidadeFicha` só reexporta o conversor existente para consumo futuro (cubas / baixa).

## 9. Catálogo compartilhado

O mesmo `produto.id` vale para todas as empresas. Não duplicar por CNPJ.

## 10. Estoque empresarial

`estoque_empresa.empresa_id`. Venda A debita A; venda B debita B.

## 11. PDV

Oficial: **PDV Normal** (`frontend/pdv`).

Filtros de vendável:

- `GET /api/produtos?somente_vendaveis=1`
- MIB origem `pdv`
- `POST/GET /produtos/identificar` (MIP)
- `VendaPagamentoService` rejeita INSUMO (`INSUMO_NAO_VENDAVEL`)

Não confiar só na UI.

## 12. MULTIEMPRESA

`X-Empresa-Id` continua no PDV. Catálogo não usa empresa. Operações de estoque/venda exigem contexto (`EMPRESA_CONTEXT_REQUIRED`). Sem fallback para empresa 1, primeira empresa ou COMPAT.

## 13. Backend

- `tipoOperacionalProduto.js`
- `fichaTecnicaSchema.js` / `FichaTecnicaService.js`
- Rotas: `GET /produtos/catalogo/insumos`, `GET|PUT /produtos/:id/ficha-tecnica`
- Schema no boot (`database.js`)

Núcleo de venda: **não** consome ficha. Só classifica vendável.

## 14. Frontend

Cadastro ERP (`frontend/erp/js/produtos.js`): tipo operacional + card de ficha (insumos). PDV: `urlProdutosPdv` e consulta por categoria com `somente_vendaveis=1`. Sem tela paralela. PDV Universal não tocado.

## 15. Decisões

1. Classificação em coluna do produto, não em categoria.
2. Ficha compartilhada (não por empresa): a receita do pastel é do produto.
3. Insumo fora do PDV no backend.
4. Sem baixa automática na venda nesta sprint.
5. Sem cubas, Alô Chefia, cardápio, iFood, Motor de Precificação.

## 16. Reutilizado

Catálogo `produtos`, `estoque_empresa`, MUC, MIP, MIB (com filtro), PDV Normal, `VendaPagamentoService`.

## 17. Adaptado

Listagem PDV, MIB (SQL + memória), identificação MIP, bloqueio de venda de insumo, cadastro ERP.

## 18. Não implementado

Baixa de ficha na venda; produção automática; cubas; Alô Chefia; cardápio online; iFood; Motor de Precificação; evolução do PDV Universal; `produto_empresa`.

## 19. Riscos

1. Catálogo MIB em memória sem rebuild após classificar insumo: filtro em `finalizar` cobre origem PDV; SQL também filtra.
2. `GET /produtos` do ERP lista insumos (correto). Quem chamar sem `somente_vendaveis` vê tudo.
3. Ficha compartilhada: alterar componentes vale para todas as lojas. Config operacional por empresa fica para sprint futura, se o negócio exigir.
4. Insumo com preço 0 no cadastro: validação de preço de venda relaxada só para INSUMO no ERP.

## 20. Próxima etapa

Consumo da ficha na venda (baixa de insumos) **depois** do cadastro estável; em seguida cubas (açaí) e produção. Sem segundo motor de venda.

```
produto compartilhado
    → ficha técnica (comercial → insumos)
estoque_empresa.empresa_id
vendas.empresa_id
PDV NORMAL
```
