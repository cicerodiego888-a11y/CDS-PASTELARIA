# Sprint 1 — Modelo de domínio das categorias fiscais lógicas

## Decisão sobre o campo `categoria`
**Não reutilizar.** Evidências:
- `backend/database.js` (~l.1488): a tabela `categorias` é **global** (sem `empresa_id`), com `nome TEXT NOT NULL UNIQUE` e `tipo DEFAULT 'produto'`. `subcategorias` idem. `produtos` liga por `categoria_id`/`subcategoria_id` (l.272).
- `backend/rotas/produtos.js`: `categoria` é exibida como nome comercial (`categoria_nome || categoria`) em listagens e cadastro; não há uso fiscal.
- `produtos` não tem `empresa_id` (catálogo compartilhado); logo, o campo não consegue expressar classificação por empresa.
- Além disso, um texto livre/nome comercial não oferece elegibilidade explícita nem validável.

Recomendação adotada: **configuração fiscal separada**, sem alterar o significado de `categoria`, `subcategoria` ou `tipo_operacional`.

## Arquivos
Examinados (somente os do escopo): `backend/database.js` (trechos de `categorias`/`subcategorias`/`produtos`), `backend/rotas/produtos.js` (ocorrências de `categoria`/`empresa_id`), `services/estoque/estoqueEmpresaSchema.js` e `EstoqueEmpresaService.js` (padrão schema+serviço por empresa e validação de `empresa_id`), `services/produtos/tipoOperacionalProduto.js`, `tests/estoque/consulta-administrativa-estoque-empresa.test.js` (convenção de teste).

Criados (nenhum arquivo preexistente foi modificado):
- `backend/services/vendas/categoriaFiscalEmpresaSchema.js`
- `backend/services/vendas/CategoriaFiscalEmpresaService.js`
- `tests/vendas/categoria-fiscal-empresa.test.js`

## Contrato de domínio
Tabela `produto_categoria_fiscal_empresa`: `empresa_id`, `produto_id`, `categoria_fiscal` (CHECK `REFRIGERANTE`|`AGUA`), `elegivel_composicao` (0/1, **padrão 0**), `UNIQUE(empresa_id, produto_id)`, FKs para `empresas` e `produtos`.
- Criada sob demanda pelo serviço (mesmo padrão de `estoque_empresa`); **não foi ligada ao boot de `database.js`** e nenhuma migração foi aplicada.
- As categorias são um enum fixo; marca, sabor, fabricante e embalagem não criam categorias.
- Um produto tem no máximo uma categoria por empresa; empresas diferentes podem classificar o mesmo produto de modo independente.
- API: `definirVinculo`, `definirElegibilidade`, `removerVinculo`, `obterVinculo`, `produtoEhElegivel`, `listarElegiveis`.
- `produtoEhElegivel` exige vínculo explícito + elegibilidade ativa + produto não `INSUMO`. Insumo é rejeitado ao vincular (`INSUMO_NAO_ELEGIVEL`) e deixa de ser elegível se reclassificado depois.
- `empresaId` é obrigatório e a empresa precisa existir (`EMPRESA_OBRIGATORIA`, `EMPRESA_NAO_ENCONTRADA`).
- O serviço nunca lê nome, unidade ou descrição e nunca grava em `produtos`.
- Não há saldo, reserva, débito ou movimento.

## Testes executados (reais)
- `node --check` nos dois arquivos novos: OK.
- `node tests\vendas\categoria-fiscal-empresa.test.js` (SQLite `:memory:`): **passou**. Cobre: categorias `REFRIGERANTE`/`AGUA` e valores inválidos; ativar/desativar elegibilidade; produto sem vínculo (mesmo com nome/categoria comercial de refrigerante) não elegível; insumo rejeitado e não elegível; isolamento por empresa; `AGUA` separada de `REFRIGERANTE`; unicidade por empresa+produto; `produtos` e saldos inalterados e nenhum produto criado.
- Nenhuma outra suíte foi executada nesta Sprint, conforme o escopo.

## Confirmações
Sem movimentação de estoque, sem alteração de cadastros existentes, sem acesso ao banco oficial, sem SEFAZ, sem commit/push/merge. Venda, baixa, NF-e, financeiro e motores Fiscal/Não Fiscal não foram tocados.

## Pendências para a Sprint 2
- Decidir onde garantir o schema em produção (boot de `database.js` ou migração controlada) — hoje só sob demanda.
- Rota/tela administrativa para configurar vínculos (com `x-empresa-id` via `empresaContexto`), não criada.
- Regra de "validade fiscal" do modelo (NCM/CFOP/CSOSN válidos) para validar elegibilidade; ainda não definida.
- Desenho do saldo fiscal em ml por `(empresa_id, categoria_fiscal)` reutilizando o MUC, com ledger e idempotência.
- Decidir se desativar um produto (`ativo`) deve afetar a elegibilidade.
