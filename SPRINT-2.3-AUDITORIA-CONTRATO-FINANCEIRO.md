# Sprint 2.3 — Auditoria e contrato financeiro do Pedido

**Status:** diagnóstico do código concluído; contrato observado documentado; correções de produção e regressões ainda em andamento.  
**Banco oficial:** não acessado nem migrado.  
**Git:** nenhum commit, push, merge, reset ou descarte executado.

## 1. Estado inicial e preservação

Antes de iniciar a Sprint 2.3, `git status --short --untracked-files=all` já mostrava um worktree amplamente modificado e com arquivos não rastreados. Entre os arquivos de interesse já alterados estavam:

- `backend/database.js`, `backend/rotas/pedidos.js` e `backend/rotas/fiscal.js`;
- `backend/services/pedido/PedidoOperacionalService.js`, `PedidoRepository.js` e `PedidoService.js`;
- `backend/services/faturamento/FaturamentoService.js` e `CentralFaturamentoService.js`;
- serviços existentes de fiscal, venda e emissão;
- `frontend/erp/js/pedidos.js`;
- testes não rastreados de Pedido/preço e o relatório da Sprint 2.1/2.2.

Esse estado foi registrado antes de qualquer edição desta Sprint. Essas mudanças não foram revertidas nem atribuídas à Sprint 2.3. O relatório atual foi criado como novo arquivo. Ainda não foram feitas alterações de produção nesta Sprint.

## 2. Diagnóstico da divergência A — desconto por item

### Caminho confirmado

1. `frontend/erp/js/pedidos.js` calcula `subtotal = quantidade × preco_unitario × (1 − desconto_percentual/100)`, arredondado a centavos. Esse subtotal é líquido do desconto da linha.
2. `salvarPedido` envia separadamente `preco_unitario`, `desconto_percentual` e `subtotal`.
3. `PedidoOperacionalService.normalizarItens` preserva o subtotal recebido; só o calcula pela mesma fórmula quando o cliente não o envia. `montarCabecalho` soma esses subtotais.
4. `PedidoRepository` persiste os três valores sem reconstruir o subtotal.
5. `FaturamentoService.montarPayloadVendaDoPedido` copia preço, percentual e subtotal persistidos; não consulta preço atual do produto.
6. `VendaPagamentoService` passa os itens para `distribuirItensVendaComValorFiscalEfetivo`; os caminhos regular e a prazo usam esse distribuidor.
7. Antes desta Sprint, `distribuidorEstoqueVenda.calcularValoresFiscaisItem` reconstruía `subtotalVenda` como quantidade × preço unitário. Quando quantidade de estoque e quantidade vendida coincidiam, calculava valores fiscais/não fiscais pelo preço unitário e ignorava um subtotal líquido diferente. O desconto percentual permanecia em `vendas_itens`, mas não reduzia essa base do distribuidor.
8. Os dois caminhos de persistência gravam em `vendas_itens` o preço, o desconto percentual e o subtotal enviado, além dos valores fiscal/não fiscal que saíram do distribuidor. O cabeçalho grava `vendas.total`, `vendas.desconto`, `vendas.valor_fiscal` e `vendas.valor_nao_fiscal`.
9. O fluxo fiscal consome os valores fiscais persistidos. `modeloTotais` evita reaplicar o desconto de cabeçalho quando reconhece que os itens já estão líquidos; os dados da emissão também tratam frete e acréscimo em campos separados.

### Reprodução antes da correção

Entrada: quantidade 2, preço unitário R$ 10,00, desconto por item 10%, subtotal persistido R$ 18,00, desconto de cabeçalho R$ 0,00.

| Etapa | Valor |
|---|---:|
| Preço bruto (`2 × 10`) | R$ 20,00 |
| Desconto da linha (10%) | R$ 2,00 |
| Subtotal líquido do Pedido | R$ 18,00 |
| Base calculada pelo distribuidor atual | R$ 20,00 |
| Divergência | R$ 2,00 |

### Correção aplicada e validada

`calcularValoresFiscaisItem` agora usa o subtotal explícito quando ele difere do valor bruto calculado por quantidade × preço unitário e rateia esse subtotal por quantidade fiscal/não fiscal. Quando o subtotal é igual ao bruto, o cálculo existente permanece. O desconto de cabeçalho continua sendo aplicado uma única vez depois, pelo ajuste comercial existente. Os testes focados verificam o caso integral, o rateio fiscal/não fiscal e a combinação com desconto de cabeçalho.

### Contrato observado

`pedidos_itens.subtotal` e `vendas_itens.subtotal` representam o valor líquido da linha após o desconto percentual da linha. `preco_unitario` continua sendo o valor unitário escolhido; `desconto_percentual` registra a taxa aplicada. O subtotal não deve sofrer novamente o mesmo desconto. O desconto de cabeçalho é um ajuste posterior aplicado uma única vez pelo fluxo comercial/fiscal existente.

## 3. Diagnóstico da divergência B — total de conversão

### Caminho confirmado

- A UI e `PedidoOperacionalService.montarCabecalho` usam a mesma composição: `soma dos subtotais líquidos − desconto de cabeçalho + frete`. Essa composição fica salva em `pedidos.total`.
- `FaturamentoService.extrairDadosNfe` escolhe frete, desconto e acréscimo efetivos: valores fornecidos no corpo da requisição substituem os valores do Pedido; caso contrário, usa os valores salvos.
- `montarPayloadVendaDoPedido` atualmente soma novamente frete e acréscimo e subtrai novamente o desconto de cabeçalho a partir de `pedido.total`. Também envia `pedido.desconto` ao núcleo, mesmo quando o corpo da requisição forneceu um desconto substituto.
- A tela de expedição (`frontend/erp/js/faturamento.js`, `totalModalExpedir`) calcula a mesma composição duplicada e envia o valor para os meios de pagamento.
- A expedição salva os metadados de frete/desconto/acréscimo no Pedido antes da conversão. Frete e acréscimo são consumidos separadamente na preparação fiscal; não são enviados como campos do payload ao distribuidor do núcleo. O desconto de cabeçalho é enviado ao distribuidor e aplicado na partilha dos valores fiscais/não fiscais.
- A validação de pagamentos compara a soma dos pagamentos ao total enviado; vendas regulares e a prazo persistem esse total no cabeçalho.

### Reprodução antes da correção

Com subtotal de linhas R$ 18,00, desconto de cabeçalho R$ 2,00 e frete R$ 5,00:

| Etapa | Fórmula | Valor |
|---|---|---:|
| Total operacional salvo | `18 − 2 + 5` | R$ 21,00 |
| Payload atual, sem overrides | `21 + 5 − 2` | R$ 24,00 |
| Duplicidade introduzida | `+5 −2` reaplicados | R$ 3,00 |

Com overrides explícitos, a fórmula atual parte do total antigo e soma todos os novos ajustes, em vez de recompor o total com os subtotais líquidos e os valores efetivos do corpo. Além disso, o campo de desconto enviado ao núcleo continua vindo do Pedido, não do override.

Reprodução executada em isolamento, com Pedido `total=21`, `desconto=2`, `frete=5` e linha líquida de R$ 18,00:

| Entrada da conversão | Resultado atual do payload | Desconto enviado |
|---|---:|---:|
| Sem override no corpo | R$ 24,00 | R$ 2,00 |
| Override `desconto=1`, `frete=8`, `acrescimo=3` | R$ 31,00 | R$ 2,00 |
| Resultado comercial esperado pela composição | R$ 28,00 | R$ 1,00 |

### Contrato aprovado para recebimentos complementares

Uma verificação isolada do `OrquestradorPagamento` com produto fiscal líquido de R$ 16,00 e pagamento comercial de R$ 21,00 terminou com `sucesso=true` e `statusPagamento='quitada'`, mas retornou recebimento fiscal de apenas R$ 16,00. O orquestrador distribui pagamentos apenas contra os totais de produto fiscal/não fiscal; o excedente de frete/acréscimo não aparece nos recebimentos retornados. Portanto corrigir o payload para incluir frete/acréscimo no total comercial sem definir a destinação desse excedente pode persistir uma venda como quitada com recebimento menor que `vendas.total`.

O Tech Lead/Product Owner aprovou o seguinte contrato para esta integração:

- O total comercial inclui frete e acréscimo; o valor combinado é registrado em `vendas.valor_outros`.
- Os recebimentos desses componentes usam `venda_recebimentos.tipo_recebimento = 'outros'`, sem reclassificação como fiscal ou não fiscal.
- O TEF permanece limitado ao valor fiscal que já autoriza. Para cartão/TEF com componente Outros, a tela exige uma segunda forma sem TEF para cobrir o complemento. O núcleo rejeita a operação antes da autorização se essa cobertura não estiver presente.
- Em venda a prazo, Outros não é gravado como recebido na criação. As parcelas de `contas_receber` são separadas por componente (`produtos` e `outros`) e seus valores somam exatamente o total comercial da parcela. A classificação usa a nova coluna aditiva `contas_receber.componente`; linhas históricas recebem o default `produtos`.
- A baixa de cada parcela mantém a trilha do componente, e a venda só é marcada quitada quando todas as parcelas, inclusive Outros, forem pagas.
- O Financeiro ERP já baixa lançamentos de `financeiro` separados do repositório `contas_receber`. Foi aprovada a sincronização transacional dessas baixas para as linhas da mesma venda/parcela, com registro em `contas_receber_pagamentos`; a operação valida que a soma dos componentes corresponde à parcela financeira e evita liquidação duplicada.
- As regras fiscais, XML e cálculos F/NF de produto permanecem fora da alteração.

## 4. Contrato financeiro observado

| Componente | Origem | Significado observado | Onde é aplicado | Campo persistido |
|---|---|---|---|---|
| Preço unitário | Item do Pedido | Preço escolhido pelo operador; preço bruto unitário da linha | Conversão e núcleo de venda | `pedidos_itens.preco_unitario`; `vendas_itens.preco_unitario` |
| Desconto por item | Item do Pedido | Percentual aplicado à base preço × quantidade para obter o subtotal líquido da linha | UI calcula; Pedido conserva; distribuição deve partir do subtotal resultante | `pedidos_itens.desconto_percentual`; `vendas_itens.desconto_percentual` |
| Subtotal do item | Editor/Pedido | Valor líquido após desconto percentual da linha; não reaplicar o percentual | Base de produto para distribuição e soma do Pedido | `pedidos_itens.subtotal`; `vendas_itens.subtotal` |
| Desconto geral | Cabeçalho do Pedido ou override da requisição | Valor monetário aplicado uma vez após os subtotais líquidos das linhas | Total do Pedido/conversão e ajuste comercial da distribuição | `pedidos.desconto`; `vendas.desconto` |
| Frete | Cabeçalho do Pedido ou override da requisição | Valor adicional à operação, fora do subtotal de produtos | Total comercial; preparação da NF-e trata o frete em separado | `pedidos.frete`; o fluxo de venda pelo Pedido mantém a informação de origem no próprio Pedido |
| Acréscimo | Pedido/metadado fiscal ou override da requisição | Valor adicional informado à operação; não compõe o total operacional atual da UI | Total comercial e campo de acréscimo na preparação fiscal; não é enviado ao distribuidor desta conversão | `pedidos.acrescimo` |
| Total do Pedido | Cabeçalho do Pedido | Resultado operacional salvo: soma dos subtotais líquidos − desconto geral + frete; não inclui acréscimo | Pedido e comparação histórica | `pedidos.total` |
| Total da venda | Contrato recebido pelo núcleo | Valor comercial que pagamentos devem liquidar; deve ser recomposto com subtotais líquidos e ajustes efetivos | `VendaPagamentoService` e persistência regular/a prazo | `vendas.total` |
| Parcela fiscal/não fiscal | Distribuição de venda | Partilha dos valores de produto após descontos, independente da composição do total comercial por frete/acréscimo | Distribuição e emissão; emissão soma componentes adicionais em seus campos próprios | `vendas.valor_fiscal`, `vendas.valor_nao_fiscal`, `vendas_itens.valor_fiscal`, `vendas_itens.valor_nao_fiscal` |
| Outros | Componentes de frete e acréscimo efetivos | Valor comercial fora da base de produtos F/NF; à vista só é recebido com forma sem TEF confirmada; a prazo vira componente de parcela | Orquestrador separa recebimento `outros`; venda a prazo gera parcelas marcadas `outros` | `vendas.valor_outros`; `venda_recebimentos.tipo_recebimento='outros'`; `contas_receber.componente='outros'` |

**Regra de recomposição derivada dos contratos observados:** `total da venda = soma(subtotal líquido dos itens) − desconto geral efetivo + frete efetivo + acréscimo efetivo`. No payload do núcleo, `desconto` deve ser o mesmo desconto geral efetivo usado nessa composição. Frete e acréscimo permanecem em seus campos fiscais próprios, sem serem adicionados novamente ao distribuidor.

O preço escolhido no Pedido, inclusive quando originado de `preco_pedido`, permanece inalterado: não se busca preço corrente do produto durante a conversão.

**Contrato aprovado e implementação em andamento:** a soma fiscal/não fiscal permanece restrita a produtos; a diferença para o total é o componente explícito Outros. A autorização TEF continua somente fiscal. Pagamentos imediatos de Outros devem aparecer como recebimentos separados, e os pagamentos a prazo devem permanecer em contas a receber, segregados por componente.

## 5. Fórmulas e valores-alvo dos cenários

Valores arredondados a duas casas após o cálculo de cada linha, conforme UI atual:

| Cenário | Linhas (subtotal líquido) | Desconto geral | Frete | Acréscimo | Total comercial esperado |
|---|---:|---:|---:|---:|---:|
| Item sem desconto: 1 × R$ 10,00 | R$ 10,00 | R$ 0,00 | R$ 0,00 | R$ 0,00 | R$ 10,00 |
| Item com 10%: 1 × R$ 10,00 | R$ 9,00 | R$ 0,00 | R$ 0,00 | R$ 0,00 | R$ 9,00 |
| Quantidade 2, preço R$ 10,00, 10% | R$ 18,00 | R$ 0,00 | R$ 0,00 | R$ 0,00 | R$ 18,00 |
| Desconto geral sem frete: linha R$ 18,00 | R$ 18,00 | R$ 2,00 | R$ 0,00 | R$ 0,00 | R$ 16,00 |
| Frete sem desconto: linha R$ 18,00 | R$ 18,00 | R$ 0,00 | R$ 5,00 | R$ 0,00 | R$ 23,00 |
| Desconto e frete: linha R$ 18,00 | R$ 18,00 | R$ 2,00 | R$ 5,00 | R$ 0,00 | R$ 21,00 |
| Acréscimo sem desconto: linha R$ 18,00 | R$ 18,00 | R$ 0,00 | R$ 0,00 | R$ 3,00 | R$ 21,00 |
| Desconto, frete e acréscimo | R$ 18,00 | R$ 2,00 | R$ 5,00 | R$ 3,00 | R$ 24,00 |

Os valores de distribuição fiscal/não fiscal, pagamentos e persistência precisam ser verificados cenário a cenário nos testes isolados. Esta tabela especifica o contrato comercial observado; não altera fórmula de Motor Fiscal, XML ou partilha legal.

## 6. Testes planejados para os 19 cenários solicitados

1. Item sem desconto.
2. Item com desconto percentual.
3. Item com desconto e quantidade maior que um.
4. Desconto geral sem frete.
5. Frete sem desconto geral.
6. Desconto geral e frete combinados.
7. Acréscimo sem desconto.
8. Desconto, frete e acréscimo combinados.
9. Conversão sem overrides no corpo.
10. Conversão com frete/desconto/acréscimo explicitamente informados.
11. Venda regular.
12. Venda a prazo.
13. Persistência do cabeçalho e dos itens.
14. Distribuição fiscal e não fiscal.
15. Preço escolhido diferente de `preco_venda`.
16. Preço escolhido proveniente de `preco_pedido`.
17. Preço unitário zero em uma linha e Pedido cujo total inteiro é zero como casos distintos.
18. Reabertura de Pedido histórico.
19. Conversão do Pedido salvo sem consultar preços atuais do cadastro.

Os testes devem comparar subtotais, desconto, frete, acréscimo, total do contrato, total persistido, pagamentos, campos de venda e partilha fiscal/não fiscal. Os casos fiscais/pagamentos que exigirem alteração de regra adicional serão bloqueados até contrato aprovado; não se deve alterar XML ou pagamentos para forçar igualdade.

## 7. Falhas históricas pendentes de diagnóstico

- `tests/faturamento/sprint35-pedidos-ui.test.js`: a expectativa `page === 'pedidos'` estava desatualizada; a verificação foi ajustada para a condição observada `p === 'pedidos'` com recurso `pedidos`. **Passou** após o ajuste.
- `tests/faturamento/sprint314-orcamento-pedidos.test.js`: a consulta monta seu filtro em `where`, começando por `p.status IN ('AGUARDANDO_FATURAMENTO')`, e concatena esse array na cláusula `WHERE`. A expectativa foi ajustada para verificar os dois trechos. **Passou**; o filtro continua restrito ao status de faturamento.
- `tests/faturamento/rc412-ponte-reserva-pedido-nucleo.test.js`: reexecutado isoladamente com `DB_DIR` temporário, sem concorrência com outros testes. O processo carregou a inicialização completa de `backend/database.js`, registrou duplicidade de colunas TEF já prevista por migrações adicionais e terminou com `SQLITE_NOMEM: out of memory` antes de concluir os cenários. A inicialização também registrou uso de heap de 591,1 MiB acima do limite configurado de 512 MiB. **Não aprovado**; próxima ação é isolar o bootstrap de banco pesado usado pelos imports do teste, mantendo os cenários locais em `:memory:`, ou executar em ambiente de teste com memória/configuração compatível. Não silenciar os erros nem remover migrações.

## 8. Pendências da auditoria

- Executar testes de conversão/persistência em banco temporário e confirmar os valores intermediários e persistidos nos fluxos regular e a prazo.
- Verificar a interação das linhas líquidas com pagamentos, `valor_fiscal`/`valor_nao_fiscal` e o modelo de totais de NF-e, sem modificar regras fiscais.
- Confirmar a instalação das migrações aditivas apenas em ambiente local/de teste antes de qualquer implantação; o banco oficial não foi acessado.
- Executar testes integrados de persistência da coluna `valor_outros`, recebimentos mistos e parcelas agrupadas por vencimento.
- Diagnosticar Sprint 3.5, Sprint 3.14 e RC4.1.2.
- Atualizar este relatório com arquivos alterados, resultados por cenário, testes pendentes e decisões que ainda exigirem aprovação.

### Testes já executados nesta Sprint

- **Passaram — 67 testes**: `tests/vendas/fiscal-402-desconto-pagamento.test.js`, `tests/vendas/rc7101-valor-fiscal-liquido.test.js`, `tests/vendas/sprint312-integridade-itens-fiscais.test.js` e `tests/vendas/sprint-2-7-recalculo-preco-quantidade.test.js`, todos com `DB_DIR` temporário.
- **Passaram — 11 testes**: regressões Sprint 3.5 e Sprint 3.14 após correção das expectativas textuais.
- **Falhou**: RC4.1.2, com `SQLITE_NOMEM` na inicialização pesada, conforme seção 7.
- **Reproduções puras concluídas**: preço com desconto de linha gerava R$ 20,00 em vez de R$ 18,00; conversão sem override gerava R$ 24,00 em vez de R$ 21,00; conversão com override gerava R$ 31,00 em vez de R$ 28,00 e ignorava o desconto substituto no campo enviado.

## 9. Implementação após aprovação do contrato

Implementação preparada sem acesso ao banco oficial:

- `backend/services/faturamento/CalculoFinanceiroPedido.js` recompõe o total a partir dos subtotais líquidos e dos ajustes efetivos; subtotal explícito zero é preservado.
- `backend/services/faturamento/FaturamentoService.js` envia `total`, desconto efetivo e `valor_outros` sem somar novamente os valores já refletidos no Pedido.
- `frontend/erp/js/faturamento.js` calcula o total do modal sem reaplicar desconto/frete; para TEF com Outros, exige um pagamento não-TEF separado e monta linhas comerciais distintas.
- `backend/services/OrquestradorPagamento.js` mantém o MIDP limitado aos totais de produto, grava Outros separadamente, nunca usa o restante de um cartão/TEF como Outros e rejeita a operação antes de acionar o TEF se o complemento à vista não tiver outro meio informado.
- `backend/services/vendas/VendaPagamentoService.js` valida `fiscal + não fiscal + Outros = total`, grava `vendas.valor_outros`, cria parcelas com componentes independentes e impede a quitação da venda enquanto existir saldo Outros.
- `backend/database.js` acrescenta `vendas.valor_outros` e `contas_receber.componente` por migrações aditivas, com default histórico `produtos`.
- `backend/rotas/financeiro.js`, `backend/rotas/contas_receber.js` e `frontend/erp/js/financeiro-receber.js` expõem a identificação do componente, sincronizam a baixa financeira numa transação e impedem que uma parcela com componentes ainda abertos finalize prematuramente o financeiro da venda.
- `backend/services/vendas/ParcelasReceber.js` distribui centavos por parcela sem diferença de arredondamento.

### Validação desta implementação

- Passaram os testes puros `tests/faturamento/calculo-financeiro-pedido.test.js` (4 casos) e `tests/vendas/parcelas-receber-componentes.test.js`, cobrindo subtotal líquido, override, zero explícito, alocação por componente e reconciliação exata.
- Passou `tests/orquestrador-pagamento.test.js` em `DB_DIR` temporário, incluindo recebimento separado e boleto a prazo sem recebimento antecipado.
- Passaram os testes FISCAL-4.0.2, RC7.10.1, Sprint 3.12 e Sprint 2.7 quando executados isoladamente com banco temporário; a execução paralela conjunta teve atividade assíncrona de inicialização/`UNIQUE constraint failed: configuracoes.chave`, por isso os casos foram repetidos serialmente.
- Passaram Sprint 3.5 (4 testes) e Sprint 3.14 (7 testes).
- RC4.1.2 continua falhando antes da conclusão dos cenários: mesmo com heap máximo aumentado para 1 GiB, o bootstrap atingiu `Zone Allocation failed - process out of memory` após alerta de heap de 584 MiB. Não foi declarado aprovado.
- A verificação de sintaxe passou para os arquivos JavaScript alterados.
