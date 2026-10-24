# Sprint 2.7 — Recálculo correto de preço e consistência do total

## 1. Resumo

- **Frente A (corrigida):** `atualizarQuantidade` agora recalcula o preço a partir da **origem comercial** do item (promoção ou varejo) e reaplica a faixa de atacado da nova quantidade. Sequência pedida (base 10, faixas 5→8 e 10→7): quantidade 10 → 7,00; 9 → 8,00; 3 → 10,00.
- **Motor como autoridade (decisão final):** descontos do motor (atacado/promoção) não são edição manual, e o desconto percentual/valor informado na interface **não** congela o preço: mudar a quantidade recalcula tudo a partir de `preco_origem`. Somente `preco_editado_manual` (edição explícita do preço unitário) preserva o preço. `desconto_manual` permanece no payload por compatibilidade, mas é zerado quando o motor recalcula e nunca altera o preço calculado. Zerar o desconto recalcula o preço comercial da quantidade atual.
- **Frente B (proposta, sem alterar produção):** contrato monetário proposto, medido contra o comportamento atual. A política de arredondamento não foi alterada.
- Os testes usam stubs de jQuery/DOM/AJAX executando o código real de `pdv.js` via `vm`. **Não há validação em navegador real.**

## 2. Arquivos alterados

Produção:
- `frontend/pdv/js/pdv.js`
  - Novos campos no item: `preco_origem` e `preco_editado_manual`.
  - Nova `resolverPrecoComercialItemPdv(item, produto, quantidade)`: reutiliza `obterPrecoAtacado` (a regra de faixa continua com uma única implementação).
  - Nova `restaurarPrecoComercialItemPdv(item, produto)`.
  - `adicionarItemNoCarrinho`: grava `preco_origem` (no item novo e no existente) e preserva preço editado manualmente ao somar quantidade.
  - `atualizarQuantidade`: usa o resolvedor, atualiza `tipo_preco` e `desconto_atacado`, e preserva preço manual.
  - Nova `itemTemPrecoManualPdv(item)`: apenas `preco_editado_manual === 1`. Usada em `atualizarQuantidade` e na soma ao item existente. `atualizarQuantidade`/soma zeram `desconto_manual` quando o motor recalcula (origem conhecida).
  - `resolverPrecoComercialItemPdv`: item legado com atacado aplicado e sem `preco_origem` mantém o preço atual (origem irrecuperável).
  - `atualizarPrecoUnitario` marca `preco_editado_manual`. `atualizarPercentual` e `atualizarDescontoValor` (> 0) **limpam** `preco_editado_manual` (correção da revisão final: o desconto substitui o preço digitado e a flag não pode ficar obsoleta). `desconto_manual` segue como antes (`atualizarDescontoValor` e `aplicarDescontoPercentualComAuth` o definem). Desconto 0 restaura o preço calculado.

Testes:
- Novos: `tests/vendas/sprint-2-7-recalculo-preco-quantidade.test.js` (16 testes: A1–A15, incluindo A14b) e `tests/vendas/sprint-2-7-contrato-monetario-carrinho.test.js` (5).
- `tests/vendas/helpers/pdv-real-adaptador.js`: incluiu as novas funções e as de edição em `FUNCOES_REAIS`.
- `tests/vendas/sprint-2-6-atualizar-quantidade-atacado.test.js`: **duas expectativas alteradas por causa da correção pretendida** (não para obter verde):
  - o teste de caracterização do "preço preso" (agora afirma 10, 8, 7, 8, 10, 10, 7);
  - o teste de produtos distintos: o item B volta ao varejo 5,00 com quantidade 2 (antes ficava em 4,00).

## 3. Modelo de origem do preço

| Campo | Significado |
|---|---|
| `preco_base` (já existia) | preço de varejo/unidade cadastrado; base dos descontos percentual e por valor |
| `preco_origem` (novo) | preço comercial **antes do atacado**: preço promocional vigente na inclusão, ou o varejo/unidade |
| `preco_unitario` | preço aplicado (resultado do cálculo ou edição manual) |
| `preco_editado_manual` (novo) | 1 somente quando o operador edita explicitamente o preço unitário (`atualizarPrecoUnitario`). Descontos automáticos do motor nunca o ativam |
| `desconto_manual` (já existia) | desconto percentual/valor informado na interface; enviado no payload por compatibilidade. Não congela o preço; zerado quando o motor recalcula |

Recálculo automático: `preco = obterPrecoAtacado(produto, quantidade, preco_origem)` = `min(preco_origem, preço da faixa mais alta atendida)`. Se a faixa for pior que a promoção, vale a promoção.

Os campos novos **não** são enviados ao backend (o payload mapeia campos explicitamente; verificado por teste).

## 4. Comportamento antes e depois

| Situação | Antes | Depois |
|---|---|---|
| 10 → 9 → 3 (base 10, faixas 5→8, 10→7) | 7,00 → 7,00 → 7,00 | 7,00 → 8,00 → 10,00 |
| Promoção 9,00 e faixa 5→8,50; qtd 5 → 3 | 8,50 (preso) | 9,00 (volta à promoção) |
| Badge/`tipo_preco` ao reduzir quantidade | permanecia `atacado` | acompanha a faixa |
| Preço manual + mudança de quantidade | substituído por `min(manual, faixa)` | preservado |
| Preço manual + adicionar o mesmo produto | substituído pelo atacado/promoção | preservado |
| Desconto 0 (percentual ou valor) | preço de **varejo**, perdia promoção/atacado | preço comercial calculado da quantidade atual |
| Item sem `preco_origem` (legado) | — | sem atacado aplicado: preço atual é a origem; com atacado aplicado: preço mantido, atacado não é reaplicado (ver limitações) |

Efeito comercial: ao reduzir a quantidade, o preço sobe até o da faixa devida; ao zerar um desconto, itens com promoção ou atacado não perdem mais esses preços.

## 5. Tratamento de edição manual

**Decisão final: o motor é a autoridade dos descontos.**

- Único preservador de preço: `preco_editado_manual = 1`, marcado somente por `atualizarPrecoUnitario`. Aplicar desconto percentual ou por valor (> 0) depois limpa a flag, porque o desconto substitui o preço digitado.
- Desconto percentual ou por valor informado na interface **não** congela o preço e **não** é regra comercial independente: ao mudar a quantidade, o preço é recalculado pelo motor a partir de `preco_origem` (atacado/promoção) e o desconto informado é descartado. `itemTemPrecoManualPdv` agora considera apenas `preco_editado_manual`; a condição baseada em `desconto_manual` foi removida.
- Compatibilidade de payload: `desconto_manual` continua no payload (usado por `vendaTemDescontoManualPdv` e enviado em `itens[]`); não foi removido. Ele continua sendo definido ao aplicar desconto pela interface, mas é **zerado** quando o motor recalcula o preço (mudança de quantidade ou soma ao item existente com origem conhecida), para não rotular como desconto manual um preço que o motor recalculou. Não altera o preço calculado em nenhum caminho. Campos `desconto_percentual`/`desconto_valor` enviados refletem o resultado do motor.
- O desconto informado pela interface continua sendo aplicado no momento da digitação (`atualizarPercentual`/`atualizarDescontoValor`, via motor `calcularLinha*`); apenas não sobrevive a uma nova quantidade.
- Reversão: desconto 0 (percentual ou valor) recalcula o preço comercial da quantidade atual e zera as flags. Para preço unitário digitado não há "desfazer" dedicado (não foi criado mecanismo novo).
- Itens legados sem `preco_origem` e com atacado/desconto já aplicado: preço mantido (origem irrecuperável), `desconto_manual` não é zerado nesses itens.
- `desconto_atacado` e `tipo_preco` de item com preço editado não são tocados nas mudanças de quantidade.
- Decisão pendente: preço digitado igual ao calculado continua marcado como manual.

## 6. Contrato monetário proposto (Frente B)

Mapa (detalhado na Sprint 2.6): tela e campo `total` do payload usam o **total agregado** (`arredondarMoeda(Σ subtotal interno)`); `itens[].subtotal` do payload usa o **total da linha arredondado**; o backend grava ambos sem reconciliar; `validarSomaPagamentosVenda` compara pagamentos com `total` (tolerância 0,01).

Proposta (em centavos inteiros):
1. Preço unitário interno com 6 casas, sem arredondar antes do total da linha.
2. Linha = `round2(totalInterno)` (já é o que o payload e a cotação usam).
3. Subtotal da venda = Σ linhas em centavos.
4. Total = `max(0, subtotal − desconto + acréscimo)`.
5. Pagamentos somam exatamente o total; fiscal/não fiscal distribuídos a partir das linhas.
6. Sem distribuição de resíduo de centavos entre linhas.

Consequência: `Σ itens persistidos = subtotal` e `total = Σ itens − desconto + acréscimo` valem por construção. A política atual quebra isso em 24,6% (2 linhas), 33,6% (3), 45,6% (5) e 58,7% (10) de 20.000 carrinhos sintéticos por tamanho; diferença máxima de 1, 1, 2 e 3 centavos, respectivamente. As invariantes da proposta valem por construção e foram verificadas em 5.000 carrinhos; a "quebra zero" da proposta na medição é consequência da definição, não uma descoberta empírica.

**Não aplicada.** Mudar a política alteraria `calcularSubtotal`, o total exibido, o valor padrão de pagamento e a base do fallback fiscal local. Isso exige confirmar impacto em pagamentos e consumidores posteriores (decisão abaixo).

## 7. Testes executados

Comando por suíte: `node --test <arquivo>` com `DB_DIR` temporário, apagado ao fim (última rodada: revisão final de conformidade, após a correção da flag obsoleta). Todas as linhas abaixo são da última rodada; nenhuma suíte está repetida.

| Suíte | Resultado (última rodada) |
|---|---|
| sprint-2-7-recalculo-preco-quantidade | 16/16 |
| sprint-2-7-contrato-monetario-carrinho | 5/5 |
| sprint-2-6-atualizar-quantidade-atacado | 9/9 (2 expectativas atualizadas por causa da correção, item 2) |
| sprint-2-6-total-faixas-promocoes | 11/11 |
| sprint-2-5-paridade-pdv-arredondamento | 14/14 |
| sprint-2-5-limites-desempenho-saldos | 17/17 |
| sprint-2-4-integracao-cotacao-composicao | 16/16 |
| sprint-2-motor-composicao-fiscal (2.1) | 26/26 |
| sprint-2-3-cotacao-backend | 18/18 |
| rcm-atacado-02-precisao-desconto | 11/11 |
| pdv-universal/preco-atacado-05-35 | exit 0 (arquivo sem contador de testes) |
| pdv-universal/promocao-comercial-05-36 | exit 0 (arquivo sem contador de testes) |

Não executados: nenhum teste em navegador real. Os testes de `pdv.js` usam o código real via `vm`, mas com stubs de jQuery/DOM/AJAX.

### Suíte completa do repositório

Não existe script `npm test` global. Foi executada, em processos isolados (`DB_DIR` temporário por arquivo, `NODE_ENV=test`, 4 em paralelo, timeout 240 s), cada um dos **650** arquivos `tests/**/*.test.js` (runner na pasta da sessão, fora do repositório).

- Resultado: **530 arquivos com exit 0 e 120 arquivos com exit ≠ 0**. A suíte completa **não está verde**.
- Os 12 arquivos desta sprint e das anteriores (tabela acima) passaram.
- Distribuição das 120 falhas por pasta: central-entradas 27, motor-equipamentos 13, fiscal 12, estoque 12, faturamento 7, vendas-entrega 7, monitoring 5, mib 4, compras 4, produtos 3, produto-identidade 3, equipamentos 3, empresas 3, demais em 1–2 por pasta (muc, stable, erp, homologacao, embalagens, vendas, tef, muv, configuracoes, mts, design-system, plataforma, pdv-universal, rc11-4-lazy-erp).
- **Relação com a sprint:** das 120, só 12 referenciam `frontend/pdv/js/pdv.js` (ou o adaptador). Teste A/B reversível: fiz backup de `pdv.js`, rodei esses 12 com a versão do `HEAD` e depois com a atual (hash restaurado conferido). **Todos os 12 têm exit 1 nas duas versões**, portanto a falha não foi causada pelas mudanças de `pdv.js`. Os motivos observados em amostra (ux01: asserções de interface; `pdv-identificacao-estoque-empresa`: `no such column: tipo_operacional`; `hotfix-visao-comercial-pos-nfe` e `gestao-visual-multiempresa-05-11`: asserções próprias) estão fora desta sprint. As outras 108 falhas não carregam `pdv.js`; a causa individual **não foi investigada** (fora do escopo) e o estado delas antes da sprint **não foi medido**. Não corrigi nenhuma.
- Limite da prova: a comparação A/B usa o exit code, não a lista de asserções falhas.

Cobertura da Frente A: sequência pedida; promoção; produto sem atacado; 180 passos determinísticos comparando `atualizarQuantidade` do PDV real com a cotação backend (3 cenários, preço interno e centavos); produtos distintos; preço, percentual e valor manuais; soma ao item existente; venda por unidade; item legado; unicidade da regra de atacado e ausência dos campos novos no payload.

A suíte completa foi executada nesta rodada (ver acima) e **tem 120 arquivos com falha**, nenhum relacionado comprovadamente a esta sprint. Nenhum teste em navegador real.

## 7.1 Separação das mudanças entre as Sprints 2.6 e 2.7 (`pdv.js`, diff vs. `HEAD`)

- **Sprint 2.6:** içamento de `obterPrecoAtacado` para escopo de módulo (hunk em ~2899, 82 linhas adicionadas) e remoção da cópia aninhada em `adicionarItemNoCarrinho` (hunk −50 linhas). Corrige o `ReferenceError` de `atualizarQuantidade`. Regra de atacado inalterada.
- **Sprint 2.7:** `itemTemPrecoManualPdv`, `resolverPrecoComercialItemPdv`, `restaurarPrecoComercialItemPdv`; campos `preco_origem` / `preco_editado_manual`; alterações em `adicionarItemNoCarrinho` (item novo e existente), `atualizarQuantidade`, `atualizarPercentual`, `atualizarDescontoValor`, `atualizarPrecoUnitario`.
- Outros arquivos de `frontend/pdv` com modificação (`index.html`, `js/vendas.js`) são **preexistentes** (datas de modificação anteriores à Sprint 2.5) e não foram tocados.
- Testes 2.6: `sprint-2-6-atualizar-quantidade-atacado.test.js` e `sprint-2-6-total-faixas-promocoes.test.js` (a primeira teve 2 expectativas ajustadas na 2.7). Testes 2.7: os dois arquivos `sprint-2-7-*`. Adaptador `tests/vendas/helpers/pdv-real-adaptador.js` (criado na 2.5, ampliado na 2.6/2.7).

## 7.2 Conformidade com o contrato comercial (revisão final)

| # | Requisito | Situação | Evidência |
|---|---|---|---|
| 1 | Motor é a autoridade dos descontos automáticos | Conforme | A13, A4 (180 passos = cotação) |
| 2 | `preco_editado_manual` só na edição explícita do preço unitário | Conforme após correção | Divergência encontrada: desconto aplicado após preço digitado deixava a flag obsoleta e congelava o preço. Corrigido (`atualizarPercentual`/`atualizarDescontoValor` limpam a flag). Teste A14b |
| 3 | `desconto_manual` não determina nem congela o preço | Conforme | A8, A9, A15 |
| 4 | Quantidade recalcula atacado/promoção a partir de `preco_origem` | Conforme | A1, A2, A5, A13 |
| 5 | Zerar desconto restaura o preço da quantidade atual | Conforme | A8, A9 |
| 6 | Legado sem `preco_origem` mantém tratamento seguro | Conforme | A11 |
| 7 | `desconto_manual` no payload compatível | Conforme, ver abaixo | A15 |

## 7.3 Compatibilidade do payload (`desconto_manual`)

Consumidores diretamente ligados ao campo:
- `frontend/pdv/js/pdv.js` (payload `itens[]`, ~4896) e `pdv-venda-entrega.js` / `pdv-universal-entrega.js`: enviam `0/1`.
- `backend/services/vendas/VendaPagamentoService.js`: `vendaExigeAutorizacaoDescontoManual` (exige autorização apenas se `desconto_manual = 1` **e** houver desconto) e dois `INSERT` em `vendas_itens` que gravam `0/1` (coluna já existente, sem DDL).

Efeito de zerar durante o recálculo do motor: o desconto remanescente é o do atacado/promoção, que é automático, então não exige a autorização de desconto manual. Isso é coerente com o contrato; não foi encontrada inconsistência. Observações, sem alteração: (a) o formato enviado continua `0/1`; (b) um preço unitário digitado abaixo do preço (que gera `desconto_percentual > 0` com `desconto_manual = 0`) já não exigia autorização antes desta sprint; esse comportamento é anterior e permanece. Análise limitada a esses consumidores, sem auditoria geral do financeiro.

## 8. Riscos e decisões pendentes

1. Política de total (seção 6): decidir entre manter ou adotar a proposta, após revisar pagamentos (`validarSomaPagamentosVenda`, valor padrão de pagamento, troco), distribuição fiscal e consumidores como `MotorFinalizacaoVenda` (lê `venda.total`). Inspeção desses consumidores foi parcial.
2. Mudança de comportamento ao zerar desconto: antes voltava ao varejo; agora volta à promoção/atacado. Confirmar que é a regra desejada.
3. Preço manual igual ao calculado continua marcado como manual; sem "desfazer" dedicado para preço unitário digitado.
4. Itens de etiqueta de balança: `atualizarQuantidade` já aplicava atacado a eles (diferente da inclusão); comportamento preservado, não investigado a fundo (subtotal fixo da etiqueta é recalculado pelo motor).
5. **Itens já no carrinho antes do deploy (sem `preco_origem`):** a origem não pode ser inferida de `preco_unitario` quando ele já inclui atacado ou desconto, e nenhuma origem foi inventada. Regra aplicada: (a) sem atacado aplicado (`desconto_atacado = 0` e `tipo_preco ≠ atacado`), o preço atual é a própria origem e o atacado passa a ser recalculado; (b) com atacado aplicado, o preço é mantido e o atacado não é reaplicado sobre preço já reduzido, ou seja, não acompanha mudanças de quantidade até o item ser removido e adicionado de novo. Limitação conhecida; testada em A11.
6. Pendências herdadas: precedência de faixas duplicadas e de promoções simultâneas, `data_fim` exclusiva e fuso.
7. Risco de UX: o preço de um item pode subir ao reduzir a quantidade (esperado, mas visível ao operador).

## 9. Confirmação de isolamento

Não foram alterados: `ComposicaoFiscalPedidoService.js`, `CotacaoPrecoProdutoService.js`, limites 250.000/20.000, saldos, reservas, estoque, ficha técnica, TEF, PIX, SEFAZ, regras fiscais, backend em geral. Nenhuma migração ou DDL. O banco oficial `C:\ProgramData\MercantilFiscal\dados` não foi acessado (todos os testes usaram `DB_DIR` temporário ou SQLite em memória). A composição fiscal não foi integrada à venda. Sem commit, push, merge ou reset. Na revisão final, o único arquivo de produção alterado foi `frontend/pdv/js/pdv.js`; no A/B o arquivo foi trocado temporariamente pela versão do `HEAD` e restaurado a partir de backup, com hash idêntico conferido. O workspace tem outras 190+ modificações preexistentes (central de entradas, fiscal etc.), preservadas e não tocadas.
