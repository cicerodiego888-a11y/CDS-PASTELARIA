# Correção MUC — HTTP 400 "Unidade da relação inválida ou vazia"

## Causa comprovada
- A mensagem vem de `validarRelacaoSi` em `backend/services/produtos/ProdutoConversaoConfigService.js`. Ela é lançada quando `normalizarUnidade()` não resolve origem **ou** destino.
- Nesse caso, o backend dispara a mesma mensagem para unidade vazia e para unidade preenchida mas não reconhecida (ex.: `mililitros`, `UN (Unidade)`). A mensagem não distinguia os dois casos.
- Os campos `.rel-origem` e `.rel-destino` em `frontend/erp/js/produto-embalagens.js` são texto livre. A validação do `saveProduto()` só checava "não vazio" e nunca normalizava nem conferia a unidade contra o catálogo MUC. O frontend aceitava o texto e o backend devolvia 400.
- Nomes de campos: **não** havia divergência. O frontend já envia `unidade_origem`, `unidade_destino`, `de`, `para` e `fator`, e o backend lê esses nomes.
- Evidência: com o payload real do frontend (HTTP `POST /produtos` em banco temporário), `UN→ML` e `FARDO 12 UN + UN→ML` retornaram 200. Destino vazio, `mililitros` e `UN (Unidade)` retornaram 400 com a mensagem do erro. Relação sem destino com `FARDO` sem relação retornou `CONVERSAO_NAO_DISPONIVEL`.

## Contrato corrigido
Cada relação enviada: `{ id?, unidade_origem, unidade_destino, de, para, fator }`, com unidades já normalizadas para o código MUC (ex.: `un`→`UN`, `cx`→`CAIXA`) e `fator > 0`.

- Frontend: `ProdutoEmbalagensUI.validarRelacoesFormulario()` valida origem, fator e destino de cada relação com o mesmo catálogo/aliases do MUC.
  - Origem e destino: obrigatórios, reconhecidos e diferentes entre si.
  - Fator: maior que zero.
  - Retorna mensagem "Relação N: …" e o campo (`origem`/`destino`/`fator`). `saveProduto` exibe a mensagem e foca o campo.
  - Relações válidas são normalizadas e mantidas; nada é descartado em silêncio. Linhas totalmente vazias continuam ignoradas, como antes.
- Backend: a validação **não foi enfraquecida**. Só a mensagem foi diferenciada: "unidade da relação desconhecida" vs. "inválida ou vazia".

## Simulação antes de salvar
- Novo endpoint `POST /api/produtos/conversao/simular`, sem ID de produto.
- Valida a configuração recebida (`validarConfiguracao`) e simula com `simularConversaoProduto` (motor MUC existente). Não grava nada e não toca em estoque (`persistido: false`, `estoqueAlterado: false`).
- O botão "Simular conversão" usa esse endpoint quando o produto ainda não foi salvo, e continua usando `/:id/conversao/simular` para produtos existentes.
- Exemplo testado: 1 FARDO (12 UN) com 1 UN = 1.000 ML → 12.000 ML.

## Arquivos alterados
- `frontend/erp/js/produto-embalagens.js` (validação, normalização, simulação pré-cadastro)
- `frontend/erp/js/produtos.js` (`saveProduto` usa a validação)
- `backend/rotas/produtos.js` (rota `POST /conversao/simular`)
- `backend/services/produtos/ProdutoConversaoConfigService.js` (mensagem diferenciada)
- `tests/muc/muc-relacao-validacao-cadastro.test.js` (novo)

## Testes executados (banco temporário via `DB_DIR`)
- `muc-relacao-validacao-cadastro.test.js`: 16 casos OK.
  - Frontend (módulo real carregado em `vm`): relação válida, lista vazia, origem ausente, destino ausente, fator inválido (0/negativo/vazio/NaN), unidade desconhecida, origem = destino, uso da validação em `saveProduto`.
  - Backend HTTP: sem conversão, relação válida, embalagem + relação, INSUMO com relação (venda = 0), rejeições (destino/origem vazios, fator 0, unidade desconhecida), edição de produto existente (e rejeição na edição).
  - Simulação sem persistência (contagens de produtos, relações, movimentações e estoque inalteradas) e rejeição de relação inválida ou sem caminho.
- Regressão, todos com exit 0: `muc-03-configuracao-produto`, `muc-06-preview-compra`, `produto-embalagens`, `separacao-produtos-insumos`, `insumo-sem-preco-venda`, `custo-insumo-fluxo-compras`, `classificacao-itens-nfe-compra`.

## Riscos residuais e não testado
- O comportamento do navegador (DOM/jQuery real, foco do campo, notificação) não foi exercitado. Só a lógica de validação foi testada com um jQuery mínimo.
- Os campos de unidade continuam texto livre (a validação os normaliza). Trocar por `<select>` seria uma melhoria de UX fora do escopo.
- O formulário com muitos campos (preço, fiscal etc.) não foi percorrido ponta a ponta.
- `listagem-produtos-empresa` e as falhas preexistentes já registradas não foram reavaliadas nesta sprint.

## Confirmações
- Somente bancos temporários com `DB_DIR` isolado; o banco oficial não foi aberto nem alterado.
- Nenhuma operação na SEFAZ. Sem commit, push, merge ou reset. Alterações preexistentes preservadas.
