# Classificação de itens da NF-e de entrada

## Diagnóstico do fluxo anterior

1. A Central processa o XML pelo Parser e MIIP e persiste o resultado em `parse_json`. `CentralComprasBridgeService.montarPayloadAbrirCompra` devolve uma cópia dos itens persistidos; `/abrir-compra` move o documento para `EM_COMPRA` e abre o formulário de Compras.
2. A entrada só é efetivamente confirmada quando `POST /compras` conclui o processamento dos itens, financeiro e estoque e executa `COMMIT`. `EM_COMPRA` representa abertura do formulário, não confirmação.
3. Antes desta alteração, o formulário não exigia a classificação operacional por item. Sem vínculo escolhido, `ensureProductForItem` podia resolver o item por MIP/MIIP ou criar um produto no caminho legado, sem uma escolha explícita entre `COMERCIAL` e `INSUMO`.
4. O cadastro compartilhado já possui `produtos.tipo_operacional`; Produtos/Insumos, compras e o MUC já o consultam. O MIB já filtrava insumos no resultado do `SearchEngine` em buscas PDV, mas a chave do cache externo do `SearchPipeline` não separava buscas de cadastro das buscas PDV. Uma consulta de cadastro podia, portanto, reaproveitar resultados no escopo PDV.
5. O estoque permanece creditado pelo fluxo de compras existente e pelas quantidades resultantes do MUC. Não foi criada uma segunda rotina de estoque nem integração com ficha técnica.

## Comportamento implementado

- Cada item do recebimento Central mostra uma escolha obrigatória independente: `Produto Comercial (COMERCIAL)` ou `Insumo (INSUMO)`. A classificação começa vazia; nome, NCM, preço, código de barras, fornecedor e sugestão MIIP não preenchem esse campo.
- Após classificar, o operador pode selecionar um cadastro existente do mesmo tipo ou escolher explicitamente a criação de um novo cadastro. A lista de vínculos é filtrada pelo tipo escolhido.
- O servidor rejeita item sem classificação, sem vínculo/criação explícita ou cujo cadastro vinculado tenha outro tipo. Não altera silenciosamente o tipo de um cadastro existente.
- Cadastros novos são criados na tabela existente `produtos`, dentro da transação da compra. Novos insumos recebem `preco_venda = 0` e `lucro_percentual = 0`; o tratamento de compra de insumos já existente atualiza o custo e protege esses campos.
- Para `COMERCIAL`, o cadastro e a atualização de preço/markup seguem a regra atual.
- A classe operacional segue no próprio produto associado ao item; o item de compra continua referenciando `produto_id`. Assim, não há catálogo paralelo nem necessidade de duplicar o tipo em uma nova tabela.
- Quantidades, valores fiscais, XML e conversões continuam pelo parse persistido e pelo MUC. A confirmação não credita estoque por uma segunda via. A criação do produto, os itens, custo, estoque e financeiro permanecem sujeitos ao `COMMIT`/`ROLLBACK` já usado pelo `POST /compras`.
- A idempotência existente por chave de acesso foi preservada. O reprocessamento de uma chave já gravada é rejeitado antes de novo crédito.
- O cache do SearchPipeline agora separa o escopo PDV do escopo geral para não reutilizar resultados de cadastro que incluam insumos. Comerciais continuam elegíveis no PDV; insumos continuam disponíveis no cadastro e fora do PDV.

### Uso e Consumo simplificado

Foi preservado o fluxo simplificado `USO_CONSUMO`, conforme decisão do solicitante: ele continua registrando a entrada financeira sem itens de catálogo ou estoque e, portanto, fica fora da classificação COMERCIAL/INSUMO desta sprint. Não houve alteração de suas regras fiscais ou financeiras.

## Arquivos alterados

- `frontend/erp/js/compras.js` — controles de classificação/vínculo/criação por item, validação antes de confirmar e representação sem preço de venda para INSUMO.
- `backend/rotas/compras.js` — validação autoritativa do tipo e do vínculo; criação transacional no cadastro existente; novo INSUMO sem preço de venda/markup.
- `backend/motores/mib/enterprise/SearchPipeline.js` — chave de cache separada para produtos no escopo PDV.
- `tests/compras/classificacao-itens-nfe-compra.test.js` — cenários de classificação, vínculo, criação, estoque, custo, idempotência e rollback com banco temporário e XML de fixture.
- `tests/mib/mib-401-busca-cadastro-produtos.test.js` — esquema de teste com `tipo_operacional` e cobertura de busca INSUMO/COMERCIAL em cadastro e PDV.
- `docs/pastelaria/classificacao-itens-nfe-produtos-insumos-relatorio.md` — este relatório.

Não foram alterados os arquivos da Central de Entradas, Parser, MIIP, SEFAZ, cadastro de Produtos ou Motor de Vendas. O filtro operacional existente no `SearchEngine` foi preservado.

## Testes executados

Todos os testes de rota foram executados com bancos temporários próprios via `DB_DIR`; o teste de separação usa SQLite em memória e o teste MIB cria seu próprio arquivo temporário.

### Novos testes

- `classificacao-itens-nfe-compra.test.js`: **14 OK, 0 falhas**. Inclui NF-e COMERCIAL, INSUMO e mista; vínculo sem duplicação; criação dos dois tipos; classificação ausente; classificação sem vínculo/criação; tipo divergente; insumo sem venda e custo atualizado; embalagem/conversão, reprocessamento idempotente, falha transacional e preservação do caminho simplificado `USO_CONSUMO`.
- `mib-401-busca-cadastro-produtos.test.js`: **15 testes OK**, incluindo insumo encontrado no cadastro e removido do escopo PDV, comercial mantido no PDV e separação de cache entre origens.

### Regressões executadas

- `custo-insumo-fluxo-compras.test.js`: **18 OK, 0 falhas**.
- `rc91-classificacao-entrada.test.js`: **16 OK, 0 falhas**.
- `separacao-produtos-insumos.test.js`: passou.
- `insumo-sem-preco-venda.test.js`: passou.
- `muc-03-configuracao-produto.test.js`, `muc-04-ficha-consumo.test.js` e `muc-06-preview-compra.test.js`: passaram; cada um reportou `fail 0`.
- `fundacao-produtos-ficha-tecnica-03-03.test.js`: passou.
- `consumo-ficha-tecnica-venda-03-04.test.js`: passou.
- `auditoria-ciclo-ficha-tecnica-03-06.test.js`: **24 pass, 0 falhas**.
- `estorno-ficha-cancelamento-03-07.test.js`: **20 pass, 0 falhas**.
- `estorno-ficha-devolucao-03-08.test.js`: **25 pass, 0 falhas**.
- `ownership-documento-compra-05-56.test.js`: **10/10 OK**.
- `mip-sprint09-pdv-oficial.test.js`: **11 OK, 0 falhas**.
- `central-entradas-03-xml.test.js`: **11 OK e 6 falhas** no ciclo XML em banco em memória. As falhas reportam `SQLITE_ERROR: no such table: central_entradas_nsu`, seguido de falhas nas asserções de recuperação/lock. A fixture do teste usa transporte SOAP simulado; nenhuma consulta real à SEFAZ foi feita. Esse teste e a tabela ausente não foram alterados nesta sprint.
- `node --check` nos arquivos JS alterados: passou.
- `git diff --check`: passou; houve apenas aviso de normalização CRLF preexistente em `backend/server.js`.

Mensagens de migração `duplicate column tef_*` foram emitidas por inicializadores de testes, sem impedir os casos bem-sucedidos.

## Riscos residuais e limites

- O caminho simplificado `USO_CONSUMO` permanece sem classificação por item, conforme decisão registrada acima.
- Cadastros novos são criados com os dados básicos do item da NF-e no helper de Compras existente. Casos que exijam unidade de estoque ou conversão fora dos dados já disponíveis ainda dependem da configuração normal do produto/MUC; não há inferência automática adicional nesta sprint.
- A transação garante compra, itens, movimentos de estoque e financeiro juntos. O vínculo final do documento Central à compra ocorre após o `COMMIT`, como no fluxo anterior; uma falha nessa etapa pode deixar a compra gravada sem o vínculo documental atualizado, embora a chave da NF-e impeça duplicar a compra em nova tentativa.
- O teste `central-entradas-03-xml.test.js` permanece com as 6 falhas de fixture/tabela descritas acima; requer correção própria do ambiente de teste antes de considerar esse ciclo validado.
- Não foram executadas chamadas reais à SEFAZ, cenários fiscais de homologação, nem testes visuais em navegador.

## Conformidade

Nenhum banco oficial foi aberto, consultado, migrado ou alterado. Nenhuma consulta/evento foi enviado à SEFAZ. Não foram alteradas regras fiscais/financeiras, bonificações, cancelamento/devolução, ficha técnica, Central de Entradas ou Motor de Vendas. Não houve commit, push, merge, reset ou descarte de alterações preexistentes.
