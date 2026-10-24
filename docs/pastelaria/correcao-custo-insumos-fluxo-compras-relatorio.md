# Correção do custo de insumos no fluxo de compras — Relatório

## 1. Diagnóstico do fluxo anterior

Fluxo mapeado em `backend/rotas/compras.js`:

- **Registro**: `POST /compras` abre `BEGIN IMMEDIATE`, insere `compras` já com `status = 'concluida'`, chama `processarItensCompra` (por item: MUC → INSERT em `compras_itens` → crédito de estoque pela porta pública → `UPDATE produtos` → lote → histórico em `produtos_preco_historico`), cria o financeiro e só então `COMMIT`. Qualquer erro em item/financeiro faz `ROLLBACK` (inclusive do `UPDATE produtos`).
- **Estados**: não existe estado "pendente" em `compras`; somente `concluida` e `cancelada`. A **confirmação real é o `COMMIT`** do `POST /compras` (o UPDATE de `preco_compra` ocorre dentro da transação, antes do COMMIT, e é desfeito em caso de falha). Pendências de Central de Entradas (fora do escopo/proibido) ficam fora desse serviço até virarem `POST /compras`.
- **Único ponto que atualiza `preco_compra`/`preco_venda`/`lucro_percentual` em compras**: o `UPDATE produtos` em `processarItensCompra` (`continuarItem`). `preco_venda` e `lucro_percentual` eram atualizados quando `atualizar_preco_venda = 1` (padrão), **sem considerar `tipo_operacional`** → um INSUMO recebia `preco_venda = custo × (1 + margem)` e markup. O mesmo UPDATE também sobrescrevia `unidade`, `produto_fracionado` e `vendido_por_peso` do produto com os valores do item da compra.
- **Bonificação**: representada por `tipo_fiscal_item = 'BONIFICACAO'`, `bonificacao = 1` ou CFOP x910/x949 (`TratamentoFiscalItemCompra`). Regras existentes: `entrada_bonificacao_gerar_estoque` (padrão: gera estoque) e `entrada_bonificacao_atualizar_custo` (padrão: **não** atualiza custo). Quando a config atualiza custo, o custo vinha do próprio item (`custo_unitario_final`, rateado, ou `preco_unitario`). **Lacuna:** se o item bonificado tivesse valor 0, o `preco_compra` do produto era gravado como 0.
- **Cancelamento** (`POST /:id/cancelar`): debita estoque, cancela financeiro, marca a compra `cancelada`. **Não toca `preco_compra`/`preco_venda`** (não há reversão de custo). **Devolução** (`POST /:id/devolver`) também não altera custo.
- **Idempotência**: `chave_acesso` é única (segunda confirmação → 400, `ROLLBACK`). Compras manuais sem chave são compras distintas por natureza.
- **Custo por embalagem/conversão**: calculado por `resolverCustoUnitarioCadastro` (`backend/lib/motorConversaoUnidades.js`). Produto fracionado (`produto_fracionado = 1`) usa custo por unidade convertida; embalagem comercial sem fracionamento usa o custo por embalagem comercial. Não foi alterado.

## 2. Arquivos alterados

- `backend/rotas/compras.js` (`continuarItem` em `processarItensCompra` + import de `TipoOperacionalProduto`).
- `tests/compras/custo-insumo-fluxo-compras.test.js` (novo, banco temporário isolado).
- `docs/pastelaria/correcao-custo-insumos-fluxo-compras-relatorio.md` (este relatório).

## 3. Mudanças implementadas

Para produto `tipo_operacional = 'INSUMO'` (lido junto com o custo anterior, `COALESCE(...,'COMERCIAL')`):

- `atualizarVenda` forçado a `false` → `preco_venda` e `lucro_percentual` **não** são alterados, independentemente de `atualizar_preco_venda`.
- `preco_venda_sugerido` gravado em `compras_itens` = 0 (não é preenchido com custo/markup).
- `unidade`, `produto_fracionado` e `vendido_por_peso` do cadastro são preservados (antes eram sobrescritos pelo item da compra).
- `preco_compra` continua sendo atualizado no mesmo evento de confirmação (dentro da transação do `POST /compras`).

Para `COMERCIAL`: nenhuma mudança de comportamento (preço, markup, unidade e fracionamento como antes).

## 4. Regra de confirmação e fórmula de bonificação

**Confirmação:** o custo definitivo só é gravado quando o `POST /compras` conclui com `COMMIT`. Falhas fazem `ROLLBACK` (custo, estoque e itens revertem). Compras canceladas/devolvidas não executam nenhuma atualização de custo. Não foi criada nenhuma reversão de custo.

**Bonificação** (modelo existente preservado, lacuna fechada):

- Padrão (`entrada_bonificacao_atualizar_custo = false`): o item bonificado gera estoque (conforme config) e **não altera** `preco_compra`.
- Com a config ligada: `custo = custo efetivo apurado do item ÷ quantidade recebida` (mesma apuração dos itens pagos: valor do item + rateios, dividido pela quantidade convertida). Não se presume custo zero.
- Se o custo apurável for ≤ 0 (bonificação sem valor), o último custo confirmado é preservado (nova proteção).
- Compra mista (itens pagos + bonificados do mesmo produto): cada linha é processada em ordem; linha bonificada com a config padrão não altera o custo; o custo permanece o da linha paga. Com a config ligada e valor apurável, a última linha com valor define o custo.
- **Não foi inventada** fórmula de rateio do valor pago entre quantidade paga e bonificada (custo médio efetivo da operação). O sistema atual não define esse rateio; é uma decisão contábil pendente (ver riscos).

## 5. Resultados reais dos testes

Novo teste: `node tests/compras/custo-insumo-fluxo-compras.test.js` → **14 OK, 0 falhas** (HTTP real no router de compras, banco SQLite temporário via `DB_DIR`; empresa de teste criada no banco temporário).

| Cenário do pedido | Resultado | Observação |
|---|---|---|
| 1. Compra confirmada de INSUMO atualiza custo | OK | |
| 2. Compra pendente | OK (parcial) | Não existe estado "pendente"; testado o equivalente: compra não confirmada (erro → rollback) não altera custo, estoque nem itens |
| 3. Compra cancelada | OK | Cancelamento não altera custo/venda; segundo cancelamento bloqueado (400) |
| 4. INSUMO com atualização de venda ligada | OK | `preco_venda`, `lucro_percentual`, `unidade` preservados; `preco_venda_sugerido` do item = 0 |
| 5. COMERCIAL mantém comportamento | OK | Opção ligada: venda = custo×(1+margem), markup gravado; opção desligada: venda/markup intactos |
| 6. Bonificação isolada, mista, config ligada/desligada | OK | 5 testes (padrão, valor apurável, valor zero, mista com e sem config) |
| 7. Embalagem/conversão | OK | Embalagem comercial (custo por embalagem = 50) e produto fracionado (custo unitário = 5); unidade preservada |
| 8. Confirmação repetida | OK | Mesma chave de acesso → 400, custo/estoque/itens inalterados |
| 9. Cancelamento/devolução | Parcial | Cancelamento com estoque consumido é bloqueado sem alterar custo. **Devolução (`/devolver`) não foi executada** |

Regressão (execução sequencial de 61 arquivos de `tests/compras`, `tests/pastelaria`, `tests/produtos`, `tests/estoque` filtrados por nome — compras, insumo, ficha, produto, estorno, etc.):

- Primeira passada (sem `DB_DIR`): 47 passam; 5 deles foram bloqueados pela barreira do banco oficial (o banco oficial **não** foi aberto). Reexecutados com `DB_DIR` temporário.
- Comparação com `HEAD` (cópia via `git archive` em pasta temporária) para os 14 arquivos que falharam: **13 falham igualmente no `HEAD`** (pré-existentes: ex. `rc4314-insert-compras-alignment`, `rc43110`, `rc43112.2`, `rc4312-central-fluxos`, `rc840`, `importacao-inicial-produtos`, `compras-multiempresa-contexto`, `rc80z-produtos-ux`) ou passam com `DB_DIR` (`rc43111`, `rc90`, `rc91`, `05-53`, `05-47`).
- `tests/estoque/listagem-produtos-empresa.test.js`: falha no workspace atual e passa no `HEAD`. A falha é na asserção sobre o código-fonte de `backend/rotas/produtos.js`, que possui **alterações preexistentes no workspace** (106 linhas, não minhas); `produtos.js` não foi tocado por esta sprint. Não investigado além disso.
- Passam: `insumo-sem-preco-venda`, `separacao-produtos-insumos`, `fundacao-produtos-ficha-tecnica-03-03`, testes de ficha técnica 03-04/03-06/03-07/03-08, `credito-compra-porta-publica`, `debito-cancel-dev-compra-porta-publica`, `produto-embalagens`, `produto-infra-01/02`, entre outros.

Não foi feito teste de mutação contra o código antigo; a ausência de alteração em venda/markup (teste 4) é validada pelo estado final no banco.

## 6. Riscos residuais e cenários não testados

- **Custo após cancelamento/devolução**: o `preco_compra` não é revertido ao cancelar/devolver uma compra (comportamento preexistente, mantido). O custo pode ficar com o valor de uma compra cancelada até a próxima compra. Reverter exige regra de negócio própria (histórico em `produtos_preco_historico` permite).
- **Bonificação mista**: sem rateio do valor pago sobre a quantidade total (custo médio efetivo). Decisão contábil pendente.
- Devolução (`/devolver`, depende de caixa aberto) e NF-e de devolução não foram exercitadas.
- Conversões via relações MUC entre unidades distintas (ex.: CAIXA→KG com produto em KG) não testadas; o MUC rejeitou essa combinação no cenário montado sem cadastro de relação.
- Observação (preexistente, não corrigida): em compra com embalagem (`quantidade_por_embalagem`), o estoque creditado no teste foi o dobro do informado em `quantidade_nao_fiscal` (40 vs 20); fora do escopo desta sprint.
- Os efeitos no produto ocorrem antes do `COMMIT` na mesma conexão SQLite; leituras concorrentes na mesma conexão poderiam enxergar o custo antes do commit. Mover para pós-commit exigiria refatoração maior.
- `fornecedor`, `ncm` e `codigo_barras` de insumos continuam sendo atualizados por `COALESCE` como antes.
- Produtos novos criados implicitamente por uma compra (`ensureProductForItemLegado`) seguem o comportamento antigo (são COMERCIAL por padrão).
- Central de Entradas, SEFAZ, fiscal e PDV não foram modificados nem testados.

## 7. Banco oficial

O banco oficial **não foi acessado, aberto, migrado ou alterado**. Todos os testes usaram `DB_DIR` apontando para diretórios temporários (removidos ao final); a barreira `exigirAberturaDatabaseModule` bloqueou as execuções sem `DB_DIR`. Nenhum commit, push, merge ou reset foi executado; alterações preexistentes do workspace foram preservadas.
