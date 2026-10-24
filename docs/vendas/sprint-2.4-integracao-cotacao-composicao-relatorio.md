# Sprint 2.4 — Integração da cotação à composição fiscal

## 1. Resumo
- **Implementado:** `ComposicaoFiscalPedidoService.js` agora obtém os subtotais de modelos e de itens fixos exclusivamente de `CotacaoPrecoProdutoService.js`, por quantidade.
- **Testes unitários/focados** executados e aprovados (seção 8).
- **Não realizado:** integração com PDV, carrinho, conclusão de venda ou teste do fluxo integrado do PDV. **Não se declara paridade com o PDV**: a composição usa a cotação backend, que reproduz as regras lidas em `pdv.js` (ver relatório 2.3); o `pdv.js` real não foi executado.

## 2. Arquivos alterados
| Arquivo | Alteração |
|---|---|
| `backend/services/vendas/CotacaoPrecoProdutoService.js` | Refatorado em carga de dependências (async, 1x) + cálculo síncrono por quantidade; novo `criarCotadorPreco` (cache local). `cotarPrecoProduto` mantém o contrato (testes 2.3 passam). Regras de preço não mudaram. |
| `backend/services/vendas/ComposicaoFiscalPedidoService.js` | Usa o cotador; busca adaptada ao subtotal por quantidade; novos parâmetros `modoVenda`, `dataReferencia`; fingerprint estendido. |
| `tests/vendas/sprint-2-motor-composicao-fiscal.test.js` | Apenas o **fixture**: colunas `preco_unidade, permite_venda_unidade, produto_fracionado, vendido_por_peso, venda_atacado` e tabelas `promocoes`, `produto_atacado` (a cotação exige o schema real). Nenhuma asserção alterada. |
| `tests/vendas/sprint-2-4-integracao-cotacao-composicao.test.js` | Novo (16 testes). |
| Este relatório | Novo. |

## 3. Integração cotação × composição
- Por modelo (e por item fixo) é criado um cotador (`criarCotadorPreco`) com `empresaId`, `tipoVenda` e `agora` explícitos; dependências lidas uma vez por simulação. Cada alternativa de quantidade chama `cotador.cotar(q).subtotalCentavos`.
- A composição **não contém** regras de preço-base, unidade, promoção ou atacado (teste de inspeção de fonte: nenhuma referência a `preco_atacado`, `preco_unidade`, `preco_promocional`, `quantidade_minima`, `FROM promocoes`/`produto_atacado`, `preco_venda`).
- Itens compostos e fixos agora trazem `regrasAplicadas` e `cotacaoFingerprint`; `precoUnitario*` é o preço interno efetivo daquela quantidade.
- Conexão injetada; sem DDL; sem importar o banco padrão (verificado por teste de fonte). A composição continua somente leitura.

## 4. Algoritmo e garantias de optimalidade
DFS por modelo (ordem existente), quantidade de `qMax` até 0, memoização por estado `(indice, restante, budgets)`, exato primeiro, melhor total ≤ residual, desempate lexicográfico (quantidades maiores, `produto_id` asc).

Mudanças necessárias porque o subtotal **não é monotônico** com atacado:
1. **Limite de quantidade por valor:** `quantidadeMaximaPorValor` usa o **menor preço unitário possível** do modelo (mínimo entre preço-base, promoção >0 e faixas >0 — `precoUnitarioMinimoInterno`). É um limite superior seguro: nenhuma quantidade acima dele pode ter subtotal ≤ residual.
2. **Quantidade acima do residual é descartada com `continue`**, nunca encerrando a varredura (não se assume que quantidades maiores custam mais).
3. **Poda por sufixo:** o limite de cada modelo é o **maior subtotal ≤ residual entre todas as quantidades 1..qMax** (varredura completa, cacheada). Se `qMax > LIMITE_QUANTIDADES_PARA_PODA` (20.000) usa-se o próprio residual (limite seguro, menos eficiente). Poda só ocorre com `<` estrito, preservando o desempate.
4. Cada quantidade avaliada e descartada conta no orçamento de estados (`LIMITE_ESTADOS_BUSCA` = 250.000, inalterado).

**Prova:** a busca é exaustiva sobre o espaço `{0..qMax}` por modelo, com limites superiores válidos; se terminou sem atingir o limite, o melhor encontrado é ótimo (ou exato). Se o limite de estados é atingido: `status: INCONCLUSIVA`, `composicaoParcialUtilizavel:false`, `otimalidadeComprovada:false`, sem afirmar inexistência.
**Evidência executável:** teste de força bruta que recalcula todas as combinações com `cotarPrecoProduto` real (2 modelos com atacado, saldo limitado) e compara total e quantidades — coincidem. Limitação: é um cenário pequeno; não é prova formal por teste.

## 5. Cache e limites
- Cache por cotador (Map por quantidade), criado dentro de `simularComposicao` e descartado ao fim. Dependências são um snapshot lido no início da simulação (consistente na simulação; não há isolamento transacional contra escrita concorrente).
- Teste: reaproveita cálculo para mesma quantidade; cotador existente não vê update posterior; nova simulação vê.
- Limites: 250.000 estados e 20.000 quantidades para poda. Não foram aumentados.

## 6. Fingerprint
Inclui (por modelo e item fixo): `cotacaoDependenciasFingerprint` / `cotacaoFingerprint`, que cobrem versão da cotação e do núcleo numérico, regra de arredondamento, produto, modo, preço-base e fonte, promoção selecionada (id, preço, status, datas, data de referência), faixas de atacado (id, mínimo, preço) e flag de atacado; além de: Pedido e itens, volume/MUC, elegibilidade, saldos e reservas (já cobertos), `modoVenda`, critérios de busca (versão `fiscal-composition-v3-cotacao`, limites, desempate). Não inclui a hora da cotação nem `empresaId` da cotação (preço global). O fingerprint final não é recomputado após a busca: o resultado é função determinística das entradas já cobertas. **Não reserva saldo nem garante disponibilidade futura.**
Testado: mudança de preço da faixa, mínimo da faixa, promoção, status da promoção, preço-base, flag de atacado, volume, data de referência com promoção.

## 7. Modo de venda, promoções e data de referência
- Modo explícito: `modoVenda` aceita apenas `PESO` (nome do modo regular no contrato do PDV: `preco_venda`, promoção e atacado). Padrão `PESO`, devolvido em `modoVendaModelos`. `UNIDADE`, `ETIQUETA_BALANCA` e valores desconhecidos → `MODO_VENDA_NAO_SUPORTADO`. Produtos com `permite_venda_unidade` **não** usam `preco_unidade` (testado).
- **Pendência de negócio:** não há regra definida de qual modo cada modelo fiscal deve usar; só o modo regular está liberado.
- Promoção: regra do endpoint do carrinho, `data_fim` exclusiva (testado com data de referência = `data_fim`). Não foi alinhado ao `QueryOptimizer` (inclusivo).
- `dataReferencia` explícita (padrão: instante da simulação, capturado uma vez e devolvido em `dataReferenciaCotacao`); usada em todas as cotações. A data é a UTC do instante (como `date('now')` do endpoint). **Decisão UTC × local pendente:** perto da meia-noite local uma promoção pode ser considerada ativa/expirada de forma diferente do estabelecimento. Nenhuma regra de fuso foi introduzida.

## 8. Testes realmente executados (SQLite `:memory:`, `DB_DIR` temporário removido)
| Suíte | Resultado |
|---|---|
| `sprint-2-4-integracao-cotacao-composicao.test.js` | 16/16 |
| `sprint-2-motor-composicao-fiscal.test.js` (Sprint 2.1) | 26/26 |
| `sprint-2-3-cotacao-backend.test.js` | 18/18 |
| `rcm-atacado-02-precisao-desconto.test.js` | 11/11 |
| `preco-atacado-05-35.test.js` / `promocao-comercial-05-36.test.js` | 1/1 e 1/1 |

Cobertura nova: exato via atacado; subtotal não monotônico; promoção+atacado; promoção expirada e `data_fim` exclusiva; seleção de modo; arredondamento/reconciliação (soma das linhas = total; fingerprint da cotação igual); itens fixos cotados; menor desconto vs força bruta; desempate; saldo e volume; limite → `INCONCLUSIVA` inutilizável; ausência de solução; invalidação de fingerprint (+ `COMPOSICAO_DESATUALIZADA`); cache; snapshot completo de schema e de **todas** as tabelas do banco igual antes/depois (inclui pedidos, itens, saldos); inspeção de fonte.

**Não executado / não coberto por teste novo:** suíte completa do repositório; reservas de saldo sob cotação (cobertas apenas pelos 26 testes da 2.1, que seguem passando); caso de `qMax > 20.000` (fallback de poda); desempenho com muitos modelos/quantidades; PDV real; banco real.

## 9. Limitações e decisões pendentes
1. Modo de venda por modelo (só `PESO`).
2. UTC × local e `data_fim` exclusiva/inclusiva.
3. Mudança de comportamento: o subtotal agora vem do núcleo `Motor` (ponto flutuante, 6 casas internas → 2) em vez de BigInt half-up sobre micros; podem divergir em casos de borda de meio-centavo. Os testes existentes (incl. 21,995 e 44,004999) passam, mas não foi feita varredura sistemática.
4. Os fixtures dos testes precisaram refletir o schema real de produtos/promoções/atacado; o serviço falha com `SCHEMA_INCOMPATIVEL` se faltarem.
5. O candidato `INCONCLUSIVA` continua exposto apenas como `composicaoParcial` com `composicaoParcialUtilizavel:false`; consumidores futuros devem tratá-lo como inutilizável.
6. Desconto calculado ≠ autorizado (`simulacaoAutorizaDesconto:false`, `descontoRequerAprovacao`); nenhum teto foi inventado.

## 10. Isolamento
Sem efeitos operacionais (verificado por snapshot de todas as tabelas). Banco oficial/operacional não acessado; sem migrações; sem commit/push/merge; PDV, carrinho, `FaturamentoService`, TEF, PIX, SEFAZ e conclusão de venda intocados.

## 11. Pendências antes da ponte com o PDV
- Definir modo de venda por modelo fiscal e fuso/`data_fim`.
- Teste de paridade executável entre cotação e o cálculo do `pdv.js`.
- Revalidar a composição e a cotação no backend na conclusão da venda (fluxo atual confia no payload).
- Fluxo de autorização humana do desconto e apresentação ao operador.
- Teste de desempenho/limites em catálogos reais e teste de reservas sob cotação.
