# Ajuste do formulário de insumo — sem preço de venda

## Escopo
Quando `tipo_operacional = 'INSUMO'`, o cadastro oculta Markup (%), Preço Unitário (venda) e Valor Total Venda. O formulário `COMERCIAL` não foi alterado.

## Diagnóstico
- O formulário único está em `frontend/erp/js/produtos.js` (reutilizado por Produtos e Insumos).
- O frontend já dispensava `preco_venda > 0` para INSUMO, mas o campo era `required` e a sincronização de preço derivava `preco_venda = custo + markup` (com markup 0, igual ao custo). Isso foi bloqueado para INSUMO.
- O backend não validava `preco_venda`, mas `produtos.preco_venda` é `NOT NULL`.

## Alterações
- `frontend/erp/js/produtos.js`
  - Campos de venda (Markup, Preço Unitário, Valor de Venda da Embalagem, Valor Total Venda e o card "Informações em tempo real" de margem) marcados com `data-campo-venda-comercial` e ocultados via `hidden` para INSUMO; `required` removido de `#preco_venda` para INSUMO. Reage à troca do tipo operacional.
  - Para INSUMO, `sincronizarFormacaoPrecoProduto` não deriva venda a partir do custo; o payload envia `preco_venda = 0` e `lucro_percentual = 0`. O cálculo de custo por embalagem (MUC) segue ativo.
  - Custo, unidade, quantidade, estoque inicial e demais campos preservados.
- `backend/rotas/produtos.js`
  - POST: INSUMO grava `preco_venda = 0` e `lucro_percentual = 0`, ignorando valores enviados.
  - PUT: se o tipo resultante é INSUMO, `preco_venda`/`lucro_percentual` do corpo são ignorados; só são zerados ao converter COMERCIAL → INSUMO. Insumos legados com preço gravado não são alterados em massa.
- `tests/pastelaria/insumo-sem-preco-venda.test.js` (novo).

`0` é ausência de preço (coluna `NOT NULL`), não preço fictício nem cópia do custo.

## Custo de compra (última compra confirmada)
`backend/rotas/compras.js` (~linha 750), ao registrar a compra, já executa `UPDATE produtos SET preco_compra = ?` com o custo da compra (via `resolverPrecosCadastroAposCompra`). A regra "último custo" **já existe** e foi preservada; o histórico de `compras_itens` não é recalculado.

Lacunas observadas (não alteradas, a avaliar separadamente):
- O mesmo UPDATE pode alterar `preco_venda`/`lucro_percentual` quando `atualizar_preco_venda = 1`, inclusive para INSUMO.
- Tratamento de bonificação (`entrada_bonificacao_atualizar_custo`) pode não atualizar o custo.
- Esta correção não valida se a compra está "confirmada" no sentido de status; o fluxo atual atualiza no registro.

## Testes executados (resultados reais)
Banco temporário isolado (`DB_DIR` em pasta temp, removida ao final):
- `node tests/pastelaria/insumo-sem-preco-venda.test.js` — OK: criação e edição de INSUMO sem preço/markup, `preco_venda` forçado a 0 mesmo se enviado, custo e saldo inicial (10) gravados, listagem de insumos, COMERCIAL grava e edita preço/markup normalmente, presença da regra de custo na compra.
- `node tests/pastelaria/separacao-produtos-insumos.test.js` — OK.
- `node tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js` — 25/25.
- `node --check` em `produtos.js` (front e back) e `git diff --check` sem erros.

Não houve teste visual no navegador; a ocultação foi validada por inspeção do código.

## Restrições
Sem alteração em PDV, ficha técnica, formação de preço comercial, fiscal, Central de Entradas ou fluxo de compras. Sem migração. Banco oficial não aberto nem alterado por este ajuste. Sem commit/push/merge/reset.
