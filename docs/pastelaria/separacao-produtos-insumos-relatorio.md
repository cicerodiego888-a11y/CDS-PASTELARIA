# Separação de produtos comerciais e insumos

**Data:** 19/10/2026

## Diagnóstico inicial

- O catálogo já tinha `produtos.tipo_operacional`, com `COMERCIAL` como padrão. A normalização também trata valores ausentes como `COMERCIAL`, preservando os registros legados; nenhuma classificação em massa foi feita.
- Já existiam o serviço e o schema de ficha técnica, o catálogo de insumos ativos e validações para permitir fichas somente em produtos comerciais e componentes somente do tipo insumo.
- O PDV oficial já solicitava itens vendáveis, o serviço MIP descartava insumos identificados por código/PLU, e os dois caminhos de gravação de venda chamavam a validação de produto vendável.
- A navegação não tinha tela própria de Insumos e a listagem de Produtos misturava as classificações. A busca MIB também não preservava `tipo_operacional` no snapshot e podia reutilizar resultados de busca de escopos distintos.
- A edição não impedia explicitamente converter um insumo já referenciado em ficha técnica, compra, venda ou estoque.

## Implementação

- Incluído o item **Insumos** em Suprimentos, com a mesma permissão de Produtos e cabeçalho próprio.
- Reutilizada a tela, o modal e o catálogo existentes: Produtos lista `COMERCIAL`; Insumos lista `INSUMO`, mostra código, unidade, custo/compra, estoque e situação, e oferece cadastro, edição e ativação/inativação.
- Os formulários abertos nesses menus fixam o tipo operacional correspondente. O cadastro persiste o tipo no `INSERT`, sem atualização separada nem tabela paralela.
- A listagem da API aceita filtro explícito por tipo operacional. A API de situação só altera registros classificados como insumo.
- A conversão de insumo para comercial retorna conflito se houver referência em ficha técnica, estoque por empresa, compras, vendas, reservas, movimentos/ajustes, lotes, identificadores, conversões MUC, embalagens, atacado ou sincronização com balança.
- O snapshot MIB preserva a classificação, o cache separa o escopo PDV do restante e os resultados em cache do PDV são filtrados como vendáveis. A pesquisa por código/PLU, consulta por categoria e validação final de venda mantêm o motor atual.
- Não foi implementada baixa automática por ficha técnica, produção ou integração com o PDV Universal legado.

## Arquivos alterados

- `backend/services/produtos/tipoOperacionalProduto.js`
- `backend/rotas/produtos.js`
- `backend/motores/mib/SearchEngine.js`
- `backend/motores/mib/catalog/CatalogSnapshot.js`
- `frontend/erp/index.html`
- `frontend/erp/js/app.js`
- `frontend/erp/js/produtos.js`
- `frontend/shared/js/access-control.js`
- `frontend/shared/js/core.js`
- `frontend/shared/js/cds-page-shell.js`
- `tests/pastelaria/separacao-produtos-insumos.test.js`
- `tests/mib/mib-rc11-catalogo-atomico.test.js`
- `tests/produto-identidade/mip-sprint09-pdv-oficial.test.js`
- `docs/pastelaria/separacao-produtos-insumos-relatorio.md`

## Testes executados

- `node tests/pastelaria/separacao-produtos-insumos.test.js` — passou em SQLite `:memory:`; verificou ficha comercial composta por insumo, bloqueio de ficha em insumo, bloqueio de conversão com referências operacionais, compatibilidade legada, filtragem vendável e superfícies de navegação/API.
- `node tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js` — passou, **25/25**.
- `node tests/pastelaria/auditoria-ciclo-ficha-tecnica-03-06.test.js` — passou.
- `node tests/produto-identidade/mip-sprint09-pdv-oficial.test.js` — passou, **11/11**, executado com `DB_DIR` temporário isolado e removido ao final; cobriu código interno, código de barras, PLU e identificação por etiqueta de balança, inclusive insumos.
- `node tests/mib/mib-rc11-catalogo-atomico.test.js` — passou, incluindo o caso de cache de busca ERP que não pode expor insumo no PDV.
- `node tests/produtos/produto-infra-01.test.js` — passou, **6/6**.
- `node tests/produtos/produto-infra-02.test.js` — passou, **6/6**.
- `node tests/muc/muc-04-ficha-consumo.test.js` — passou.
- `node --check` nos arquivos JavaScript alterados — passou.
- `git diff --check` — passou; houve somente um aviso de conversão CRLF preexistente em `backend/server.js`.

## Riscos residuais e limites

- Não foi executado teste visual/browser nem uma requisição HTTP ponta a ponta. A rejeição de venda foi exercitada no validador usado pelos dois caminhos do serviço de venda e conferida nos respectivos pontos de integração.
- A trava de conversão verifica as tabelas operacionais existentes e listadas no serviço; referências adicionadas por extensões externas exigem inclusão explícita nessa lista.
- Insumos já ligados a operações permanecem insumos e não podem ser convertidos por edição; a rotina não migra nem reclassifica registros automaticamente.

## Banco oficial

O banco oficial **não foi aberto, alterado ou migrado**. Os testes de domínio usaram SQLite em memória; o teste MIP que carrega a camada de banco usou diretório temporário, removido após a execução. Nenhuma migração de produção foi executada.
