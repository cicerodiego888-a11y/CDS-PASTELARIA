# Sprint 2.6 — Correções de consistência comercial do PDV

## 1. Resumo executivo

- **Frente A (corrigida):** `atualizarQuantidade` lançava `ReferenceError` porque `obterPrecoAtacado` estava aninhada em `adicionarItemNoCarrinho`. A função foi movida para o escopo do módulo, sem duplicar a regra.
- **Frente B (investigada, regra mantida):** a tela arredonda o total agregado; o payload envia subtotais arredondados por linha; o backend não reconcilia os dois. Não há regra oficial inequívoca, então o arredondamento não foi alterado. Decisão pendente.
- **Frente C (diagnosticada):** faixas duplicadas fazem PDV e cotação escolherem preços diferentes. Reproduzido. Precedência não alterada.
- **Frente D (diagnosticada):** o sistema permite duas promoções ativas do mesmo produto. Rota e cotação coincidem apenas por acaso do plano de consulta. Precedência não alterada.
- **Achado novo (A):** após a correção, `atualizarQuantidade` mantém o preço de atacado quando a quantidade diminui. Não foi corrigido (decisão pendente, seção 9).
- **Validação:** só testes com stubs executando o código real do `pdv.js` via `vm`. Nenhuma validação em navegador real.

## 2. Arquivos alterados

Produção:
- `frontend/pdv/js/pdv.js`: `obterPrecoAtacado(produtoId, quantidadeTotal, precoBase, produto)` agora é função de módulo (antes de `adicionarItemNoCarrinho`). O corpo é o mesmo; a variável `produto`, antes capturada por closure, virou o 4º parâmetro. As 3 chamadas (2 em `adicionarItemNoCarrinho`, 1 em `atualizarQuantidade`) passam `produto`.

Testes (novos ou editados):
- `tests/vendas/sprint-2-6-atualizar-quantidade-atacado.test.js` (novo, 9 testes)
- `tests/vendas/sprint-2-6-total-faixas-promocoes.test.js` (novo, 11 testes)
- `tests/vendas/helpers/pdv-real-adaptador.js`: `obterPrecoAtacado` adicionada a `FUNCOES_REAIS`.
- `tests/vendas/sprint-2-5-paridade-pdv-arredondamento.test.js`: o teste que documentava o `ReferenceError` foi reescrito para afirmar a correção. Mudança de expectativa causada apenas pela correção pretendida.

Não alterados: `ComposicaoFiscalPedidoService.js`, `CotacaoPrecoProdutoService.js`, limites (250.000 estados / 20.000 quantidades), backend, banco.

## 3. Correção de `atualizarQuantidade`

Causa: `atualizarQuantidade` chamava `obterPrecoAtacado`, definida dentro de `adicionarItemNoCarrinho`, logo inacessível. Com `venda_atacado=1` isso gerava `ReferenceError`.

Evidência (testes executados, todos verdes): estrutura (definição única, no módulo, 3 chamadas com `produto`); produto sem atacado; abaixo, no limiar e acima (q=4,5,6,9,10,11); paridade com a cotação em quantidades crescentes; produtos distintos sem contaminação; promoção + atacado; quantidade 0 remove o item; inclusão e soma ao item existente inalteradas.

### Achado: preço de atacado preso ao reduzir quantidade
`atualizarQuantidade` usa `item.preco_unitario` (já com atacado) como preço base. Sequência observada com faixas [5→8, 10→7] e preço 10: q = 4, 5, 10, 9, 3, 1, 12 → preços 10, 8, 7, **7, 7, 7**, 7. A cotação e `adicionarItemNoCarrinho` dariam 8 e 10 em 9 e 3. O preço só cai, nunca sobe, ao alterar a quantidade. Não corrigi: `atualizarPrecoUnitario`, `atualizarPercentual` e `atualizarDescontoValor` também gravam `item.preco_unitario`, e o preço promocional não é guardado no item. Corrigir exige novo estado (preço pré-atacado) e decisão sobre edições manuais. O teste de caracterização documenta o comportamento atual.

## 4. Mapa de cálculo, tela, payload e persistência

| Etapa | Onde | Valor |
|---|---|---|
| Preço interno | `aplicarCalculoMotorItemPdv` | `item.preco_unitario` (6 casas) |
| Subtotal interno | idem | `item.subtotal` (6 casas, sem arredondar a centavos) |
| Subtotal exibido da linha | idem | `item.subtotal_exibicao` (round2) |
| Subtotal da tela | `calcularSubtotal()` | `arredondarMoeda(Σ item.subtotal)` — **agregado** |
| Total da tela | `calcularTotalValor` / `obterTotalVendaPDV` | `max(0, subtotal − desconto + acréscimo)`, round2 |
| `total` do payload | pdv.js ~4775 | igual ao total da tela (**agregado**) |
| `itens[].subtotal` | payload | `subtotal_exibicao` (**por linha**) |
| `pagamentos[].valor` padrão | payload | `total` |
| Distribuição fiscal | `precalcularDistribuicaoFiscalVenda` / `distribuirItensVendaComValorFiscalEfetivo` | calculada a partir dos valores dos itens |

Backend (`POST /api/vendas` → `VendaApplicationService.criarVenda` → `VendaPagamentoService.criarVenda`): **não recalcula preços nem total**. O `total` do cliente só é validado como número > 0 e gravado em `vendas.total`; o `subtotal` de cada item é gravado em `vendas_itens.subtotal`. A única checagem financeira é `validarSomaPagamentosVenda` (|Σ pagamentos − total| ≤ 0,01). Nada compara Σ itens com o total. Logo, `vendas.total` pode diferir de Σ `vendas_itens.subtotal`, e o backend aceita.

Limite da verificação: não inspecionei consumidores posteriores do total (ex.: `MotorFinalizacaoVenda`, `CriarVendaEntregaService`).

## 5. Quantificação do arredondamento (testes B2 e B3)

Casos no PDV real (centavos; soma das linhas × subtotal da tela):

| Caso | Σ linhas | Tela | Dif. |
|---|---|---|---|
| 3 × 0,25 kg × 1,99 | 150 | 149 | +1 |
| 1 linha de 0,005 | 1 | 1 | 0 |
| 2 linhas de 0,005 | 2 | 1 | +1 |
| 3 × 0,4975, desconto 0,10 | total tela 139 | soma por linha 140 | +1 |
| 3 × 0,4975, acréscimo 0,05 | total tela 154 | soma por linha 155 | +1 |
| linhas inteiras | 3400 | 3400 | 0 |

Varredura determinística (semente 26, 20.000 carrinhos por tamanho; preço 0,01–50,00; qtd 0,01–5,00):

| Linhas | % divergentes | máx. |dif.| (centavos) |
|---|---|---|
| 1 | 0,00 | 0 |
| 2 | 25,45 | 1 |
| 3 | 33,48 | 1 |
| 4 | 40,26 | 2 |
| 5 | 44,91 | 2 |
| 6 | 48,66 | 3 |
| 8 | 54,94 | 3 |
| 10 | 58,85 | 3 |

Com 4 ou mais linhas a diferença pode passar de 1 centavo, acima da tolerância de 0,01 de `validarSomaPagamentosVenda` (relevante apenas se pagamentos fossem montados pela soma dos itens). Desconto e acréscimo não alteram a diferença, apenas a deslocam.

Opções de política (sem escolha):
1. Soma dos subtotais arredondados por linha (como payload, cotação e composição).
2. Arredondamento só do total agregado (como a tela).
3. Híbrido, com resíduo de centavos alocado a uma linha. Não há evidência no código.

Evidência de regra oficial: `rcm-atacado-02` só fixa precisão **dentro** da linha ("sem arredondar antes do total"); `motor-preco-atacado.js` não exporta função de agregação do carrinho. Regra oficial de agregação não foi determinada → comportamento mantido.

## 6. Faixas de atacado duplicadas

- `POST /produtos/:id/atacado` e `PUT /produtos/atacado/:faixaId` rejeitam duplicata de `quantidade_minima` e exigem preços coerentes entre faixas.
- `inserirFaixasAtacadoProduto` (criação e edição do produto, `atacado_faixas`) **não** verifica duplicatas nem na lista enviada nem no banco.
- `produto_atacado` não tem índice UNIQUE. Dados legados e importações também podem duplicar. Não verifiquei importações em massa fora de `produtos.js`.
- Reprodução (teste C3, faixas [5→8],[5→7], qtd 6): PDV usa a primeira linha retornada, cotação a última por `id`. Inserindo na ordem inversa o resultado também inverte (PDV 8/cotação 7 → PDV 7/cotação 8).
- Decisão necessária: qual faixa prevalece (menor preço, maior id, mais recente?). Recomendação: impedir novas duplicidades validando em `inserirFaixasAtacadoProduto` e criar `UNIQUE(produto_id, quantidade_minima)` em migração futura aprovada, após saneamento dos dados legados. Nada disso foi feito aqui; sem saneamento em banco real.

## 7. Múltiplas promoções ativas

- `POST /promocoes` insere com status `'ativa'` sem consultar promoções existentes; a tabela não tem restrição. Duas promoções ativas e vigentes do mesmo produto são possíveis (teste D1/D2).
- Rota `promocao-ativa`: `LIMIT 1` sem `ORDER BY`. Cotação: `ORDER BY id ASC LIMIT 1`.
- Resultado observado (D2: id 1 a 9,00 e id 2 a 7,00, ambas vigentes): rota devolveu id 1 (plano `SCAN`), cotação 9,00. Coincidem hoje por acaso do plano. D3: adicionar um índice no banco de teste não mudou o resultado; a dependência de plano é uma garantia que o SQL não oferece, mas não foi demonstrado um caso em que mude.
- Opções de precedência (não escolhida): menor id, maior id, menor preço, início mais recente.
- Vigência (`data_fim` exclusiva) e fuso não foram alterados (D4).

## 8. Testes executados

Executados em SQLite em memória / diretório temporário, um arquivo por vez com `node --test <arquivo>`:

| Suíte | Resultado |
|---|---|
| sprint-2-6-atualizar-quantidade-atacado | 9/9 |
| sprint-2-6-total-faixas-promocoes | 11/11 |
| sprint-2-5-paridade-pdv-arredondamento | 14/14 |
| sprint-2-5-limites-desempenho-saldos | 17/17 |
| sprint-2-4-integracao-cotacao-composicao | 16/16 |
| sprint-2-motor-composicao-fiscal (2.1) | 26/26 |
| sprint-2-3-cotacao-backend | 18/18 |
| rcm-atacado-02-precisao-desconto | 11/11 |
| pdv-universal/preco-atacado-05-35 | 1/1 |
| pdv-universal/promocao-comercial-05-36 | 1/1 |

A suíte completa do repositório **não foi executada**. Uma falha inicial no teste novo (comparação `deepEqual` de arrays entre contextos do `vm`) foi corrigida no próprio teste; nenhuma asserção existente foi enfraquecida.

## 9. Decisões comerciais pendentes

1. Política de agregação/arredondamento do total (por linha × agregado × híbrido).
2. Preço de atacado ao reduzir quantidade em `atualizarQuantidade` (recalcular a partir do preço de varejo/promoção × manter), incluindo tratamento de edição manual de preço.
3. Precedência entre faixas de atacado com mesma `quantidade_minima`.
4. Precedência entre promoções ativas simultâneas.
5. Fuso horário e regra `data_fim` exclusiva (herdadas das sprints anteriores).

## 10. Riscos remanescentes

- Testes do PDV usam stubs de jQuery/DOM/AJAX; não há validação em navegador real.
- Divergência de centavos entre `vendas.total` e Σ itens persiste em produção.
- Preço de atacado preso pode cobrar menos que a regra comercial ao reduzir quantidade.
- Duplicidades de faixa/promoção podem existir em bases reais; não foram medidas (banco oficial não acessado).
- Importações em massa e consumidores posteriores do total não foram inspecionados.
- Composição fiscal continua sem integração à venda; a divergência de total deve ser decidida antes dessa integração.

## 11. Confirmação de isolamento

Não foram alterados: `ComposicaoFiscalPedidoService.js`, `CotacaoPrecoProdutoService.js`, limites de 250.000/20.000, regras fiscais, saldos, reservas, estoque, ficha técnica, pagamento, TEF, PIX, SEFAZ. Nenhuma migração ou DDL (a única criação de índice ocorreu em banco SQLite em memória de teste). O banco oficial em `C:\ProgramData\MercantilFiscal\dados` não foi acessado. Nenhum commit, push, merge ou reset. Alterações preexistentes do workspace foram preservadas.
