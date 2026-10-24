# Sprint 2.1 — Refinamento da composição fiscal

## Registro de auditoria anterior à alteração

Antes de editar o serviço ou os testes, foram lidos integralmente o motor da Sprint 2, os 19 testes existentes e o relatório anterior. A busca atual é uma DFS sobre quantidades inteiras, em ordem decrescente por modelo; os modelos vêm ordenados por `produto_id` e categoria. A cota de 250.000 estados é contada por visita recursiva. Ao ultrapassá-la, o serviço atualmente lança `COMPOSICAO_BUSCA_COMPLEXA`; esse erro não fornece o melhor resultado parcial de forma estruturada e, quando a chamada procura um desconto, não permite identificar uma solução ótima.

O algoritmo atual só tenta uma composição abaixo do residual se `resolverPoliticaDesconto` fornecer um limite. Isso contradiz a regra desta sprint: primeiro buscar o valor exato e, se não existir, maximizar o total fiscal válido abaixo do residual, sem inventar teto. A ordenação determinística atual favorece quantidades maiores dos produtos de menor `produto_id`, mas o desempate não era documentado nem retornado ao chamador.

O motor já exige conexão injetada, usa consultas de leitura, não executa DDL e converte volumes pelo núcleo puro do MUC. O fingerprint anterior incluía valores de catálogo/modelo, volumes convertidos, elegibilidade refletida no conjunto de modelos, saldos e reservas agregados, além dos dados comerciais do Pedido; não identificava explicitamente a versão/critérios da busca. A verificação do fingerprint ocorria antes da busca, mas só havia teste de alteração de preço.

### Evidência sobre preços e arredondamento

- `backend/database.js` define `produtos.preco_venda` como preço de catálogo (`DECIMAL(18,6)`), distinto de `preco_compra`.
- `frontend/pdv/js/pdv.js`, em `obterPrecoBaseItemPdv`, usa `produto.preco_venda` como preço base regular; o PDV também pode aplicar preço de unidade, promoção e preço de atacado. Para itens do carrinho, persiste preço unitário e subtotal próprios.
- A regra de unidade monetária do PDV usa `MotorPrecoAtacado.arredondarMoeda`, que arredonda o total a duas casas, e `obterTotalVendaPDV`, que arredonda o total final a centavos. `backend/services/vendas/valorFiscalLiquido.js` também usa arredondamento de moeda a duas casas para o rateio fiscal/não fiscal. Não foi localizada tabela/configuração de preço fiscal diferente por empresa/modelo.
- Portanto, `produtos.preco_venda` é uma fonte global comprovada para o preço base atual do catálogo/PDV, não prova de que toda venda efetiva use apenas esse valor: promoções, atacado, preço por unidade e ajustes fiscais podem alterar o valor final. O simulador continua limitado ao preço de catálogo e essa limitação deve ser tratada antes da integração com o PDV.

### Ajustes estritamente necessários identificados

1. Remover a dependência de política/teto de desconto da busca simulada, preservando a prioridade de composição exata.
2. Fazer a busca maximizar o total abaixo do residual; documentar o desempate determinístico.
3. Interromper com resultado estruturado inconclusivo ao atingir o limite sem prova de optimalidade; não retornar a composição parcial como utilizável.
4. Incluir critérios/versão da busca no fingerprint e testar alterações de preço, elegibilidade, volume, saldo, reservas e dados do Pedido/itens.
5. Manter explícito que encontrar uma composição com desconto não autoriza o desconto: o resultado é apenas simulação.

## Implementação e validação

### Estratégia e algoritmo

O motor continua sendo apenas um simulador: exige a conexão `db` injetada, consulta somente schemas já existentes e não executa DDL, migração, reserva, baixa ou conclusão de venda.

A busca agora:

1. Maximiza o total fiscal sem ultrapassar o valor residual nem o saldo fiscal disponível.
2. Reconhece uma composição exata como ótima assim que a encontra.
3. Se não houver solução exata, só declara o menor desconto quando termina a busca completa. O limite permanece em 250.000 estados; atingir esse limite retorna `status: INCONCLUSIVA`, `otimalidadeComprovada: false` e um eventual candidato parcial marcado como inutilizável.
4. Em soluções do mesmo valor, percorre modelos ordenados por `produto_id` e categoria ascendente e prefere, de forma determinística, o vetor de quantidades lexicograficamente maior nessa ordem.
5. Aplica limites superiores conservadores de valor e capacidade para podar a busca sem alegar optimalidade após interrupção.

O desconto monetário é informado no resultado, mas não autorizado pelo simulador: `descontoRequerAprovacao` sinaliza valores positivos e `simulacaoAutorizaDesconto` permanece falso. Não há teto monetário ou percentual arbitrário, nem dependência de política externa para procurar uma composição.

### Preços e arredondamento

O motor mantém `produtos.preco_venda` como preço global base do catálogo. A evidência e a ressalva da auditoria permanecem: o PDV também pode aplicar preço por unidade, promoção, atacado e ajustes fiscais; portanto, o campo não representa por si só todo preço efetivo possível de uma venda. Não foi localizada fonte fiscal separada por empresa/modelo, e o preço não foi alterado nesta sprint.

O preço de catálogo é representado internamente em micros (seis casas decimais). O subtotal de cada linha composta é arredondado a centavos, meio para cima, com aritmética `BigInt` equivalente a:

```text
subtotal_centavos = (preco_unitario_micros × quantidade + 5.000) / 10.000
```

A divisão inteira implementa o arredondamento; o arredondamento ocorre no subtotal da linha, e não primeiro no preço unitário. O cálculo do limite de quantidade também considera esse arredondamento, inclusive o caso de preço em seis casas cujo subtotal arredonda exatamente ao residual.

### Fingerprint e disponibilidade

O fingerprint inclui empresa e Pedido; status, total, desconto, frete, código e itens do Pedido; itens fixos e preço/cadastro do produto; modelos válidos e inválidos (incluindo preço, elegibilidade, volume e conversão); saldos, reservas e categorias; além da versão, limite e critério de desempate da busca. Uma alteração detectada rejeita um fingerprint anterior com `COMPOSICAO_DESATUALIZADA`.

Os testes exercitaram alterações posteriores no preço, elegibilidade fiscal, volume, regra MUC, saldo, reserva, Pedido/itens e categorias da busca. Fingerprint é uma verificação de mudança, não uma reserva: não impede concorrência nem garante que o saldo continue disponível depois da simulação. A validação transacional definitiva é responsabilidade de uma futura integração de conclusão de venda.

### Arquivos criados ou alterados

- `backend/services/vendas/ComposicaoFiscalPedidoService.js` — busca de melhor valor comprovado, estados inconclusivos, cálculo monetário com seis casas, fingerprint ampliado e metadados explícitos sobre desconto, prova de optimalidade e efeitos.
- `tests/vendas/sprint-2-motor-composicao-fiscal.test.js` — cenários de composição, optimalidade, arredondamento, fingerprint e ausência de efeitos, com fixtures SQLite em memória.
- `docs/vendas/sprint-2.1-refinamento-composicao-fiscal-relatorio.md` — auditoria prévia, decisões, resultados e limitações desta sprint.

Nenhuma rota, tela, integração PDV, serviço de faturamento, pagamento ou conclusão de venda foi alterada.

### Testes realmente executados

Validação de sintaxe:

```text
node --check backend\services\vendas\ComposicaoFiscalPedidoService.js
node --check tests\vendas\sprint-2-motor-composicao-fiscal.test.js
```

Suíte focal:

```text
node --test tests\vendas\sprint-2-motor-composicao-fiscal.test.js
```

Execução sequencial, com `DB_DIR` apontado para um diretório temporário único e limpo ao final. Os fixtures de negócio foram criados em SQLite `:memory:`; o serviço recebeu explicitamente essa conexão.

**Resultado final observado: 26 testes passaram; 0 falharam.** A suíte completa do repositório não foi executada.

Os 26 testes cobriram, de fato:

- preservação do Pedido operacional e residual do exemplo; prioridade e resultado exato;
- menor desconto entre composições válidas, desempate determinístico e composição entre `REFRIGERANTE` e `AGUA`;
- composição abaixo do residual sem teto, sem autorização implícita de desconto;
- ausência de modelos válidos e exclusão de produto inativo, insumo ou modelo sem volume/preço utilizável;
- saldo fiscal, reserva própria do Pedido, reserva de outro Pedido, divergência de reservas e saldo insuficiente;
- limite de estados com candidato parcial explicitamente inconclusivo e inutilizável;
- conversão MUC, validação de empresa e isolamento de Pedido/modelos por empresa;
- validação de estados do Pedido, frete, total, itens fixos e quantidades;
- arredondamento monetário, inclusive preço de seis casas e subtotal calculado após multiplicar pela quantidade;
- fingerprint determinístico e rejeição após mudanças nas fontes listadas acima;
- ausência de alteração no Pedido, catálogo, schema, movimentos e reservas, e ausência de venda, baixa física, consumo de ficha técnica, cobrança, pagamento ou lançamento financeiro.

Os cenários de optimalidade foram exercitados com solução exata, busca completa sem solução exata e busca interrompida por limite. Não se afirma que resultados inconclusivos sejam ótimos ou que não exista solução neles.

### Limitações e riscos residuais

- O motor usa o preço base `produtos.preco_venda`; não reproduz automaticamente promoções, preços por unidade, atacado ou todos os ajustes fiscais do PDV. Antes da ponte, a regra de preço deve ser alinhada ao preço efetivo que o PDV apresentará.
- O arredondamento por linha foi coberto em teste, mas a integração futura ainda precisa demonstrar que o total composto e o desconto são aceitos pela validação e pelo fluxo de preço reais do PDV.
- O limite de 250.000 estados pode produzir `INCONCLUSIVA` em cenários complexos. Nesse caso, não há composição utilizável nem declaração de inexistência ou optimalidade.
- O fingerprint não reserva estoque fiscal, não protege contra corrida e não substitui validação transacional no fechamento.
- A simulação não implementa política/autorização de desconto, importação de Pedido, seleção de itens no PDV ou conclusão de venda.
- Não foram executados testes de integração com o PDV, testes da suíte completa, cenários com preço promocional/atacado nem validação transacional de concorrência.

### Isolamento e confirmação

Os testes usaram exclusivamente fixtures em SQLite `:memory:` e o serviço não importa o banco padrão nem cria/alter schema. Nenhuma rota, PDV, faturamento, cobrança, TEF/PIX, documento fiscal ou SEFAZ foi invocada.

**Confirmação: nenhum banco oficial ou operacional foi aberto, consultado, migrado ou alterado.** A composição permanece uma simulação sem efeitos operacionais. Antes de iniciar a ponte com o PDV, permanecem pendentes a compatibilidade com a formação de preço efetiva do carrinho e a revalidação/coordenação transacional de disponibilidade.
