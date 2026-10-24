# Sprint 2.5 — Auditoria de paridade numérica, limites e desempenho

Nenhum código de produção foi alterado. A sprint só acrescentou testes e helpers de teste. O PDV, o motor de composição, a cotação e as regras comerciais ficaram intactos.

## 1. Arquivos alterados (todos novos, não versionados)

- `tests/vendas/helpers/pdv-real-adaptador.js`
  - Extrai por regex o código REAL das funções de `frontend/pdv/js/pdv.js` e o executa em `vm`.
  - Também extrai o SQL real da rota `GET /produtos/:id/promocao-ativa`.
  - Stubs: jQuery/`$.ajax`, notificações e DOM.
- `tests/vendas/helpers/composicao-fixture.js`: fixture SQLite em memória compartilhada.
- `tests/vendas/sprint-2-5-paridade-pdv-arredondamento.test.js`: Frentes 1 e 2 (14 testes).
- `tests/vendas/sprint-2-5-limites-desempenho-saldos.test.js`: Frentes 3, 4 e 5 (17 testes).
- Este relatório.

## 2. Divergências encontradas (comportamento atual documentado; nada foi "corrigido")

| # | Divergência | Origem | Menor correção proposta (depende de decisão) |
|---|---|---|---|
| D1 | A tela do PDV (`calcularSubtotal`) arredonda o **agregado**. O payload e a cotação somam o **arredondado por linha**. Exemplo: 3 × 0,25 kg × 1,99 dá 1,49 na tela e 1,50 no payload. Em varredura sintética de 20.000 carrinhos de 3 linhas, 33,4 % divergiram em ≥1 centavo. | `pdv.js`: `calcularSubtotal` × payload (`subtotal_exibicao`). | Decidir a política de agregação. A composição já segue o payload (por linha). |
| D2 | `atualizarQuantidade` chama `obterPrecoAtacado`, que é aninhada em `adicionarItemNoCarrinho`. Para produto com atacado ela lança `ReferenceError`. Reproduzido por execução. | `pdv.js` (escopo). | Elevar `obterPrecoAtacado` ao escopo do módulo. O PDV não foi tocado. |
| D3 | O núcleo compartilhado arredonda em ponto flutuante (`Math.round(n·10^c)/10^c`). Frente ao half-up decimal exato, 1.521 de 998.000 combinações preço(2 casas) × qtd(2 casas) e 623 de 120.000 combinações preço(3 casas) × qtd inteira diferem em exatamente 1 centavo. Exemplo: 0,335 × 3 = 1,005 dá 1,00 (exato: 1,01). | Núcleo UMD, usado igualmente pelo PDV e pela cotação. | Política pendente (float × half-up exato). Não alterada. |
| D4 | Faixas de atacado com a mesma `quantidade_minima` (só em dados legados; o POST bloqueia). O PDV usa a primeira, a cotação a última. | PDV: `>` estrito. Cotação: `>=` com `ORDER BY qmin, id`. | Padronizar a regra ou sanear os dados. |
| D5 | `promocao-ativa` usa `LIMIT 1` sem `ORDER BY`. A cotação ordena por `id`. Com mais de uma promoção ativa, a escolha pode diferir. | Rota × cotação. | Definir a precedência. Não foi testada com várias promoções ativas (o SQL foi apenas inspecionado). |

Nos itens D1, D3 e D5 a cotação reproduz o PDV, ou o PDV e a cotação divergem apenas em dados anômalos. D1 é uma inconsistência interna do próprio PDV.

## 3. Testes realmente executados

Comandos: `node --test <arquivo>`, com `DB_DIR` apontando para diretório temporário, apagado ao final.

| Suíte | Resultado |
|---|---|
| Nova 2.5 paridade/arredondamento | 14/14 |
| Nova 2.5 limites/desempenho/saldos | 17/17 (uma primeira execução teve 4 falhas de teste, não do motor; foram corrigidas nos testes: alvo inalcançável, fixture reabrindo saldo e comparação de texto no fonte) |
| 2.4 integração | 16/16 |
| Composição fiscal 2.1 | 26/26 |
| 2.3 cotação | 18/18 |
| `rcm-atacado-02-precisao-desconto` | 11/11 |
| `preco-atacado-05-35` | 1/1 |
| `promocao-comercial-05-36` | 1/1 |

**A suíte completa do repositório NÃO foi executada.**

## 4. Paridade com o PDV

Evidência executável:

- O código real de `adicionarItemNoCarrinho`, `atualizarQuantidade`, `calcularSubtotal` e do núcleo UMD foi executado.
- A promoção veio do SQL real da rota, com `date('now')` trocado por data explícita.
- Foram comparados preço interno, preço exibido, subtotal interno, centavos e quantidade, sempre idênticos entre PDV real e cotação:
  - grade determinística de 900 casos (310 com atacado, 186 com promoção, 43 com promoção + atacado, 161 promoções expiradas ou inativas, 444 fracionados);
  - limiares de faixa (abaixo, no limiar e acima), `data_fim` exclusiva e promoção + atacado;
  - adição repetida do mesmo item (equivale a cotar a quantidade somada);
  - modos UNIDADE e ETIQUETA_BALANCA;
  - linha a linha e total da composição (itens fixos + modelos) contra o carrinho real.
- A exceção são os dados legados de faixa duplicada (D4).

O que NÃO foi comprovado:

- Navegador real, jQuery real, rota via HTTP e fluxo de UI, que foram substituídos por stubs.
- Concorrência de abas.
- Produtos com `permite_venda_unidade` combinados com promoções em fluxos de UI.

Conclusão: há paridade de formação de preço por linha, nos caminhos exercitados. Não há paridade comprovada do fluxo integrado.

## 5. Arredondamento (exemplos medidos)

| Preço | Qtd | Interno | Exibido | Subtotal interno | Centavos PDV = cotação = núcleo | Decimal exato |
|---|---|---|---|---|---|---|
| 0,335 | 3 | 0,335 | 0,34 | 1,005 | 100 | 101 |
| 1,005 | 1 | 1,005 | 1,00 | 1,005 | 100 | 101 |
| 2,675 | 1 | 2,675 | 2,68 | 2,675 | 268 | 268 |
| 1,99 | 0,25 | 1,99 | 1,99 | 0,4975 | 50 | 50 |
| 3,333333 | 13 | 3,333333 | 3,33 | 43,333329 | 4333 | — |
| 10,005 | 3 | 10,005 | 10,01 | 30,015 | 3002 | 3002 |

A diferença entre PDV, cotação e núcleo é sempre 0 centavo. A diferença para o decimal exato é de até 1 centavo (D3). Veja também D1 para linhas múltiplas.

## 6. Limites e desempenho (medições desta máquina; sem limite comercial inventado)

Limites inalterados: 250.000 estados e `LIMITE_QUANTIDADES_PARA_PODA = 20.000`.

### Optimalidade

- Contra força bruta independente: 150 cenários aleatórios de 1–3 modelos e 2 categorias, com 98 cenários de subtotal não monotônico (68 com solução exata, 82 sem). Total, vetor de quantidades, exatidão e prova coincidiram em todos.
- `qMax` 19.999, 20.000 e 20.001, e 25.000, todos iguais à força bruta.
  - Com `qMax` ≤ 20.000 a primeira cotação é q=1 (varredura ascendente).
  - Com `qMax` > 20.000 a primeira cotação é a de `qMax` (caminho alternativo, sem varredura).
- Alvos 39.997–40.005 (sem exato, melhor abaixo do residual) corretos.
- Desempate determinístico confirmado: vence o vetor lexicograficamente maior.
- 40 cenários × 5 limites injetados:
  - `limiteAtingido` implica `estadosVisitados == limite`, `completa == false` e nenhum candidato acima do residual.
  - Resultados são idênticos em duas execuções.
  - Prova de optimalidade nunca contradiz a força bruta.
- Limite real de 250.000 (modelos 0,02 e 0,04, 10.000 ml, alvo 44,01): `INCONCLUSIVA`, `composicaoParcialUtilizavel=false`, sem itens nem valor final, e código diferente de `COMPOSICAO_FISCAL_INEXISTENTE`.

### Desempenho

| Cenário | Resultado | ms | Estados | Chamadas `cotar` | Cotações reais |
|---|---|---|---|---|---|
| P1 1 modelo, qMax 1.000 | melhor abaixo | 2,2 | 835 | 1.666 | 833 |
| P2 2 modelos com atacado, 2.000 cada | **INCONCLUSIVA** | 41,3 | 250.000 | 252.210 | 3.024 |
| P3 3 modelos, promoção + atacado, cap. 5.000 | **INCONCLUSIVA** | 51,1 | 250.000 | 241.791 | 3.338 |
| P4 5 modelos, 2 categorias | exata | 0,4 | 273 | 186 | 44 |
| P5 qMax 20.000 (varredura) | melhor abaixo | 51,6 | 20.002 | 40.000 | 20.000 |
| P6 qMax 100.000 (alternativo) | melhor abaixo | 343,9 | 100.002 | 100.000 | 100.000 |
| P7 2 modelos, 10.000 ml compartilhados | **INCONCLUSIVA** | 44,1 | 250.000 | 252.303 | 3.300 |
| P8 8 modelos, cap. 500 | exata | 2,1 | 4.877 | 1.885 | 134 |

Serviço completo com 5, 25 e 100 modelos (saldo de 20.000 ml por categoria): 4,8 ms, 20,5 ms e 81,3 ms, todos com sucesso.

Observações:

- O cache funciona: cada quantidade distinta gera uma cotação real, e as repetições são acertos de cache.
- Gargalo e risco: com poucos modelos de preço baixo e capacidade alta (P2, P3, P7), a busca atinge o limite e retorna `INCONCLUSIVA`. O tempo é baixo, de dezenas de ms, e o resultado é inutilizável.
- Dependendo do catálogo real, a busca pode ser inconclusiva com frequência. Isso exige decisão de produto (veja a seção 9).
- Sem limite de tempo imposto; são apenas medições.

## 7. Saldos e reservas

Validado:

- Saldo insuficiente limita a quantidade mesmo quando o atacado favoreceria mais unidades.
- Reserva de outro Pedido reduz a capacidade. A reserva do próprio Pedido é creditada.
- Dois modelos disputando o mesmo saldo e reserva coincidem com a força bruta, usando a capacidade e a cotação reais.
- O fingerprint muda com alteração de saldo e de reserva. `fingerprintEsperado` antigo gera `COMPOSICAO_DESATUALIZADA`. Dados que mudam entre simulações produzem novo resultado.
- Duas simulações consecutivas usam o MESMO saldo e nada é reservado ou alterado. Isso mostra a limitação de concorrência: o snapshot não garante disponibilidade futura.
- Nenhuma tabela foi alterada (snapshot total antes e depois).

Para alterar o saldo entre simulações o teste usou `UPDATE` direto no banco em memória. O serviço só permite uma abertura por categoria.

## 8. Riscos remanescentes

- D1 a D5 acima.
- Resultado `INCONCLUSIVA` frequente em catálogos de preço baixo com atacado.
- Janela de concorrência entre a simulação e a conclusão.
- O PDV real foi testado por adaptador (`vm`) com stubs, e não por navegador.
- Não foi testado: múltiplas promoções ativas simultâneas e fuso/meia-noite.
- Suíte completa do repositório não executada.

## 9. Decisões de negócio pendentes

1. Política de arredondamento (float × half-up exato) e de agregação (por linha × total).
2. Modo de venda por modelo fiscal (não inventado).
3. UTC × horário local, e `data_fim` exclusiva × inclusiva (não alterado).
4. Precedência entre múltiplas promoções e tratamento de faixas duplicadas.
5. O que fazer quando a busca é `INCONCLUSIVA` (limite maior, restrição de catálogo ou bloqueio).
6. Teto de desconto e autorização (o motor não autoriza descontos).

## 10. Recomendação

**Avançar com ressalvas**, apenas para uma integração de leitura/simulação. **Bloquear** a integração à conclusão da venda até que:

- D1 (agregação) seja decidida;
- D2 (ReferenceError em `atualizarQuantidade`) seja resolvida;
- a política de `INCONCLUSIVA` seja definida;
- seja feita uma validação do fluxo integrado real.

A composição não está pronta para produção.

## Isolamento

Apenas SQLite em memória e diretórios temporários removidos ao final. Não houve acesso a `C:\ProgramData\MercantilFiscal\dados`, SEFAZ, PDV, `FaturamentoService`, TEF ou PIX, nem migração, DDL, commit, push ou merge.
