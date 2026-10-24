# MUC — Simulação de conversão antes de salvar

## Situação encontrada
A rota `POST /api/produtos/conversao/simular` (sem ID) e o uso dela pelo botão já existiam, criados na correção anterior da relação MUC. Este ajuste completa os requisitos que faltavam.

## O que foi alterado
- `backend/rotas/produtos.js` (`POST /conversao/simular`):
  - exige quantidade > 0 e unidade de origem;
  - rejeita relações ambíguas (mesma origem→destino com fatores diferentes) com o código `RELACAO_AMBIGUA`;
  - retorna também `quantidade_origem`, `unidade_origem` e `unidade_estoque`, além do resultado e do caminho.
- `frontend/erp/js/produto-embalagens.js` (botão "Simular conversão"):
  - valida quantidade, unidade de origem e unidade de estoque antes de chamar a API, com mensagens claras;
  - exibe origem, resultado, unidade de estoque e caminho;
  - mantém a rota por ID para produtos salvos (comportamento inalterado).
- Teste novo: `tests/muc/muc-simulacao-antes-de-salvar.test.js`.

## Como funciona
- **Cadastro novo (sem ID):** o frontend envia relações validadas e normalizadas, apresentações e unidade de estoque do formulário. O backend valida com `validarConfiguracao` e calcula com `simularConversaoProduto`/`converterQuantidade`, o motor MUC existente. Não foi criado outro algoritmo.
- **Cadeia:** FARDO → UN (apresentação 12 UN) → ML (relação 1 UN = 1.000 ML). Resultado: 1 FARDO = 12.000 ML, caminho `FARDO → UN → ML`.
- **Persistência:** a rota não grava produto, embalagem, relação nem estoque (`persistido: false`, `estoqueAlterado: false`). O handler não altera campos nem fecha o modal.
- **Produto salvo:** continua usando `POST /produtos/:id/conversao/simular`.

## Testes executados (banco temporário via `DB_DIR`)
`muc-simulacao-antes-de-salvar.test.js`: 11 casos OK.
- Verificação estática do frontend: rota sem ID, rota por ID mantida, sem exigência de ID, sem alterar campos nem fechar o modal, exibição de origem/resultado/unidade de estoque.
- Produto comercial novo (12.000 ML) e insumo novo (2,5 FARDO = 30.000 ML).
- Cadeia com aliases em minúsculas.
- Rejeições: relação ausente, fator 0/negativo/nulo, unidade desconhecida, relação ambígua, quantidade zero e origem vazia.
- Contagens de produtos, relações, embalagens e estoque inalteradas após todas as simulações.
- Produto existente: simulação por ID retorna 12.000 ML sem alterar dados.

Regressões com exit 0:
- `muc-relacao-validacao-cadastro`
- `muc-03-configuracao-produto`
- `muc-06-preview-compra`
- `produto-embalagens`
- `separacao-produtos-insumos`
- `insumo-sem-preco-venda`
- `custo-insumo-fluxo-compras`

## Riscos residuais / não testado
- O clique real no botão (DOM/jQuery no navegador) não foi exercitado. O handler foi verificado por inspeção do código-fonte e pela API por HTTP.
- A ambiguidade é detectada apenas entre relações com a mesma origem e destino. Conflitos entre apresentação e relação não foram tratados.
- Com a opção "Utiliza conversão" desmarcada, o bloco de simulação fica oculto, então a simulação não é oferecida.

## Confirmações
Somente bancos temporários; banco oficial não aberto nem alterado. Nenhuma operação na SEFAZ. Regras de compra, custo, estoque e venda não alteradas. Sem commit, push, merge ou reset; alterações preexistentes preservadas.
