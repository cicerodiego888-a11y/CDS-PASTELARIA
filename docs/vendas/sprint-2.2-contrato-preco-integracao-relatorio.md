# Sprint 2.2 — Contrato de preço e integração com o PDV

## Conclusão executiva

Esta sprint foi **somente auditoria e definição**. Não foi implementado contrato compartilhado nem integração com o PDV.

O fluxo efetivo de preço da venda de balcão é montado principalmente em `frontend/pdv/js/pdv.js`. O frontend escolhe o preço-base, consulta promoção e faixa de atacado, aplica o cálculo do motor de precisão e mantém o preço unitário interno e o subtotal da linha. O backend de venda valida estoque, distribui valores entre fiscal e não fiscal, aplica o rateio comercial e persiste os valores recebidos; não recalcula a elegibilidade ou o preço de promoção, unidade ou atacado a partir do cadastro.

O simulador da Sprint 2.1 lê `produtos.preco_venda` e calcula os subtotais com aritmética própria em micros/`BigInt`. Esse preço é o preço-base regular, não uma cotação garantida para o carrinho. O fingerprint atual também não cobre as fontes dinâmicas de preço do PDV, em especial registros de promoção e faixas de atacado.

Por essa razão, não é seguro afirmar correspondência entre o valor simulado e o preço que o PDV aceitaria. Alterar o motor para incluir somente uma das regras, ou duplicar no simulador a seleção que hoje está no frontend, criaria uma segunda lógica de preços. A proposta ao fim deste relatório é extrair a menor cotação autoritativa reutilizável, mantendo a conclusão de venda fora desta sprint.

## Arquivos e contratos inspecionados

- [`frontend/pdv/js/pdv.js`](../../frontend/pdv/js/pdv.js) — `obterPrecoBaseItemPdv`, `aplicarCalculoMotorItemPdv`, `buscarPromocaoAtivaProduto`, `adicionarItemNoCarrinho`, `continuarAdicionarProdutoPdv`, `atualizarQuantidade`, `calcularSubtotal`, `calcularTotalValor`, `obterTotalVendaPDV` e montagem do payload de conclusão.
- [`frontend/pdv/index.html`](../../frontend/pdv/index.html) — carrega `/shared/js/motor-preco-atacado.js` antes de `pdv.js`.
- [`frontend/shared/js/motor-preco-atacado.js`](../../frontend/shared/js/motor-preco-atacado.js) — motor JavaScript para browser com precisão interna de seis casas e funções de desconto, preço informado e faixa de atacado.
- [`backend/services/vendas/MotorPrecoAtacado.js`](../../backend/services/vendas/MotorPrecoAtacado.js) — implementação CommonJS correspondente, usada por serviços/testes Node; implementa a aritmética, mas não escolhe promoção, modo de venda ou faixa aplicável.
- [`backend/rotas/produtos.js`](../../backend/rotas/produtos.js) — normalização dos campos de venda por unidade; listagem de produtos; endpoint `GET /:id/promocao-ativa`; endpoint `GET /:id/atacado`; gravação e edição dos dados comerciais.
- [`backend/database.js`](../../backend/database.js) — campos comerciais do produto, tabela `promocoes` e tabela `produto_atacado`.
- [`backend/services/vendas/VendaContract.js`](../../backend/services/vendas/VendaContract.js) — envelopa o payload HTTP sem recalcular preços.
- [`backend/services/vendas/VendaPagamentoService.js`](../../backend/services/vendas/VendaPagamentoService.js) — porta de criação, validação de itens, distribuição, gravação da venda.
- [`backend/services/distribuidorEstoqueVenda.js`](../../backend/services/distribuidorEstoqueVenda.js) — utiliza o preço/subtotal do item para calcular valores fiscal e não fiscal e distribuir ajustes comerciais.
- [`backend/services/vendas/valorFiscalLiquido.js`](../../backend/services/vendas/valorFiscalLiquido.js) — rateio proporcional de desconto/acréscimo entre subtotais fiscal e não fiscal.
- [`backend/services/vendas/ComposicaoFiscalPedidoService.js`](../../backend/services/vendas/ComposicaoFiscalPedidoService.js) — carrega preço dos modelos de `produtos.preco_venda`; converte volume por MUC; fingerprint e algoritmo de composição.
- [`tests/vendas/rcm-atacado-02-precisao-desconto.test.js`](../../tests/vendas/rcm-atacado-02-precisao-desconto.test.js) — testes de precisão do motor CommonJS e verificações estruturais do espelho browser.
- [`tests/vendas/sprint-2-motor-composicao-fiscal.test.js`](../../tests/vendas/sprint-2-motor-composicao-fiscal.test.js) — testes focados da composição. Não foi modificado nesta sprint.

## Mapa da formação de preço atual

### 1. Preço-base de catálogo

`produtos.preco_venda` é selecionado no catálogo e usado em `obterPrecoBaseItemPdv` para venda normal. O banco declara o campo em `produtos`; a listagem de [`backend/rotas/produtos.js`](../../backend/rotas/produtos.js) seleciona `p.*` e a resposta normaliza os campos de unidade comercial.

Para modo de venda por unidade, o frontend usa `produtos.preco_unidade`, desde que o produto permita esse modo e o operador escolha unidade. A quantidade vendida em unidades é convertida para quantidade de estoque usando `peso_medio_unidade` (`obterQuantidadeEstoqueParaVenda`). O preço da unidade e a conversão de estoque são regras distintas: `peso_medio_unidade` não substitui o preço.

No caminho normal de adição ao carrinho, o operador escolhe entre unidade e o modo normal quando `permite_venda_unidade` está habilitado. O fluxo por unidade não passa promoção ou atacado para `adicionarItemNoCarrinho`; também não aplica esses dois mecanismos quando adiciona etiqueta de balança.

### 2. Promoções

O carrinho obtém promoção por `buscarPromocaoAtivaProduto`, que chama `GET /produtos/:id/promocao-ativa`. A rota seleciona registro `status = 'ativa'`, com data inicial menor ou igual à data corrente e data final estritamente maior que a data corrente. A resposta fornece `preco_promocional`, `desconto_percentual` e o identificador.

Para venda normal, `adicionarItemNoCarrinho` usa o preço promocional como candidato de preço quando existe promoção. Promoção não é aplicada ao modo unidade nem à etiqueta de balança. A promoção é consultada separadamente da leitura do catálogo; portanto o produto e a cotação promocional não são uma única resposta/versionamento.

Existe ainda consulta de promoção no MIB (`backend/motores/mib/core/QueryOptimizer.js`) que expõe `tem_promocao`, `preco_promocional` e `desconto_percentual`. Sua janela temporal usa `data_fim >= data(...)`, diferente do endpoint consultado pelo fluxo do carrinho, que usa `data_fim > date('now')`. Não foi demonstrado que essa projeção seja a fonte que o carrinho usa para validar promoção; ela não deve substituir o endpoint do caminho de adição sem reconciliação dessa diferença.

### 3. Preço de atacado

O carrinho só consulta faixas se `produto.venda_atacado` estiver ativo e a venda não for por unidade nem etiqueta de balança. `GET /produtos/:id/atacado` retorna as faixas do produto, ordenadas por quantidade mínima. O frontend escolhe a faixa elegível de maior `quantidade_minima`, calcula o preço com `MotorPrecoAtacado.calcularLinhaAtacadoFaixa` e usa o menor entre o preço promocional corrente (se houver) e o preço calculado para a faixa. A faixa é reavaliada ao adicionar unidades ao item ou alterar sua quantidade.

As faixas são persistidas em `produto_atacado` com `quantidade_minima` e `preco_atacado`; são dados globais do produto, não diferenciados por empresa. A função matemática de atacado não faz a consulta nem escolhe a faixa.

### 4. Descontos manuais, acréscimos e distribuição fiscal

Descontos manuais por item ou venda são separados de promoção e preço por faixa. No PDV, desconto manual pode exigir autorização de administrador/supervisor; o payload inclui `desconto_manual` e `supervisor_token`. O backend verifica a autorização para desconto de venda ou itens marcados como manuais. Promoção e atacado aparecem como condições automáticas do item e não são a autorização manual do desconto calculado pelo motor de composição.

Desconto e acréscimo no cabeçalho alteram o total do carrinho. `valorFiscalLiquido.ratearAjusteComercialFxNF` distribui o ajuste proporcionalmente entre os totais fiscal e não fiscal, arredondando a duas casas e reconciliando diferença de centavos. Esse rateio altera os valores fiscais/não fiscais resultantes; não determina o preço de catálogo, promoção ou atacado do produto.

### 5. Cálculo, arredondamento, exibição e payload

`MotorPrecoAtacado` arredonda valores internos a seis casas e quantidades a três casas. O motor segue a ordem subtotal bruto → desconto → total; o preço unitário interno pode ter frações de centavo. `arredondarMoeda` e `formatarPrecoExibicao` arredondam a duas casas.

No carrinho, `subtotal` interno e `subtotal_exibicao` são guardados separadamente pelo helper. `calcularSubtotal` soma os subtotais e arredonda o subtotal da venda a duas casas; `obterTotalVendaPDV` arredonda o total depois do desconto/acréscimo. Na conclusão, o payload leva preço unitário de exibição (duas casas), `preco_unitario_interno`, `subtotal` de exibição, quantidade, tipo de venda, origem promocional/atacado e metadados de desconto.

Assim, a multiplicação de `preco_unitario` exibido por quantidade não é sempre uma reconstrução segura do subtotal. Um contrato deve transportar tanto o preço interno quanto o subtotal de linha calculado, preservando a regra do motor oficial; não deve recomputar um a partir do outro depois de arredondar a exibição.

## Frontend e backend: quem calcula e quem confia

1. O frontend resolve as condições do carrinho: modo de venda, promoção, faixa de atacado e preço unitário, usando cadastro/rotas de produto e o motor browser.
2. A montagem do payload envia preço exibido, preço interno e subtotal.
3. `VendaContract` apenas normaliza a forma geral do payload; não calcula preço.
4. `VendaPagamentoService` lê produtos para validar existência/estoque/operacionalidade, mas constrói entradas do motor a partir dos itens recebidos. `distribuidorEstoqueVenda` usa `item.preco_unitario` e, se presente, `item.subtotal`; não busca novamente a promoção ativa nem a faixa de atacado para recalcular o preço do item.
5. O backend calcula a distribuição fiscal/não fiscal e os valores líquidos, e persiste preço/subtotal e metadados do item. Isso não equivale a uma validação autoritativa da cotação comercial submetida.

Portanto, frontend e backend não executam atualmente um mesmo resolvedor de regras comerciais. O backend possui funções numéricas correspondentes ao motor browser, mas a seleção de condições comerciais do carrinho está no frontend, e os dados de preço enviados continuam sendo parte da entrada do núcleo de venda.

## Comparação com a Sprint 2.1 e lacunas do fingerprint

O motor da composição atualmente:

- lê `p.preco_venda`, volume e `updated_at`;
- não seleciona `preco_unidade`, `permite_venda_unidade`, `peso_medio_unidade` ou `venda_atacado`;
- não consulta `promocoes` nem `produto_atacado`;
- calcula seu próprio subtotal em centavos com preço em micros e quantidade inteira;
- registra preço/volume/catalogo, configuração fiscal, Pedido/itens, saldo/reservas e critérios da busca no fingerprint.

Isso não cobre todas as fontes que podem modificar o valor de uma linha no PDV. Em particular, alteração de registro de promoção ou faixa de atacado não é comprovadamente refletida no fingerprint por `produtos.updated_at`; são tabelas próprias e a regra atual não as lê. Também não há no resultado atual versão da regra de cotação do carrinho, modo de venda ou condições escolhidas.

Não se deve adicionar campos genéricos irrelevantes. O fingerprint futuro deve incluir apenas as dependências efetivamente lidas para aquela cotação, em especial:

- produto e empresa explícita, modo de venda e quantidade considerada;
- preço-base efetivamente selecionado (`preco_venda` ou `preco_unidade`) e campos de configuração de unidade/peso quando aplicáveis;
- flag de atacado e as faixas consultadas que podem ser escolhidas para a quantidade;
- identificador, preço, status e janela de validade da promoção consultada, quando aplicável;
- versão da regra compartilhada e parâmetros de arredondamento;
- preço/quantidade/subtotal cotados de cada item do pedido e seleção fiscal/volume;
- elegibilidade, conversão MUC, saldo fiscal e reservas usadas para a composição.

Um instante/data de cotação deve ser explícito para que expiração de promoção seja tratável. Fingerprint detecta alteração observada; não congela os dados, não reserva saldo e não impede concorrência. Na futura confirmação, o preço e a disponibilidade precisarão ser revalidados no fluxo transacional.

## Contrato compartilhado proposto

Não foi encontrado um contrato atual que possa ser chamado pelo serviço de composição e pelo backend de vendas para resolver todas as regras do carrinho. `MotorPrecoAtacado` fornece apenas cálculos numéricos; não lê produto/promoção/faixas nem escolhe condições. O simulador não deve passar a aceitar preço fornecido pelo chamador como verdade comercial.

Proposta mínima para a próxima implementação:

1. Extrair/estabelecer um único núcleo de cálculo puro reutilizado pelo browser e pelo Node (a base existente é `MotorPrecoAtacado`, incluindo o espelho em `frontend/shared/js/motor-preco-atacado.js`).
2. Acrescentar uma camada backend de cotação que receba conexão injetada e identificadores/condições, leia produto, modo de venda, promoção e faixas persistidas, aplique as mesmas condições do PDV e use o núcleo puro para os cálculos.
3. Fazer a cotação retornar pelo menos:

```js
{
  produtoId,
  quantidade,
  tipoVenda,
  precoBase: { fonte, valorInterno },
  regrasAplicadas: [
    // origem e identificador da promoção/faixa, se aplicável
  ],
  precoUnitarioInterno,
  precoUnitarioExibicao,
  subtotalInterno,
  subtotalCentavos,
  arredondamento: { casasInternas: 6, casasExibicao: 2 },
  fingerprint,
  cotadoEm
}
```

Esse é um contrato conceitual, não um contrato já implementado. Valores exibidos e enviados pelo browser não são a fonte confiável: a camada backend deve construir ou validar a cotação contra dados persistidos. A futura API pode expor essa cotação ao carrinho, mas o endpoint por si só não substitui revalidação transacional no momento de concluir.

O preço pode depender da quantidade por causa da faixa de atacado; portanto, o motor de composição não pode fixar um preço unitário por produto antes de enumerar quantidades. Cada alternativa de quantidade precisa usar o subtotal oficial daquela quantidade. A busca da composição deverá otimizar por subtotais de linha retornados pelo contrato e adaptar limites/podas para essa função quantidade→subtotal, preservando a prioridade do exato e a prova de optimalidade. Não é seguro reutilizar a busca atual sem essa adaptação.

Para modelos fiscais, o tipo de venda precisa ser definido explicitamente e ser compatível com o que a futura importação colocará no carrinho. Produto com escolha por unidade não pode receber preço/unidade implicitamente: aplicar o preço por unidade ou o preço normal deve corresponder ao `tipo_venda` efetivamente importado.

## Desconto, operador e estados da composição

O resultado da composição deve continuar separando valor comercial do Pedido e representação fiscal. Para o futuro operador do PDV, o contrato precisa apresentar:

- residual comercial a compor;
- total fiscal proposto;
- diferença monetária proposta como desconto;
- critério de seleção e prova de optimalidade;
- estado de busca, incluindo `INCONCLUSIVA`;
- exigência de autorização humana quando existir desconto entre Pedido e composição.

Composição exata continua prioritária. Composição não exata somente é utilizável quando a busca demonstrar que o valor escolhido é o maior total válido abaixo do residual. O candidato parcial de estado `INCONCLUSIVA` deve permanecer explicitamente não utilizável. Nenhum desconto pode ser aplicado silenciosamente, e não se cria teto monetário ou percentual nesta proposta.

A autorização futura deve ocorrer no PDV através do mecanismo oficial de autorização de desconto, sem confundir desconto da composição com promoção/atacado já refletidos no preço dos itens. A definição de como representar esse desconto no carrinho e no backend deve preceder a integração, pois hoje os preços e totais do PDV são recalculados e distribuídos em caminhos que usam itens e total da venda.

## Testes e validação

### Executados nesta sprint

**Nenhum teste foi executado nesta sprint.** A atividade permaneceu em auditoria estática e proposta; nenhum código ou teste de produção foi alterado. Não se declara nesta entrega cobertura de integração do preço do PDV.

O relatório da Sprint 2.1 documenta 26 testes focados da composição aprovados naquela sprint. Eles exercitam o simulador e fixtures SQLite em memória, mas não chamam o resolvedor de promoção/faixa do carrinho e não demonstram paridade de preço PDV↔composição. Não foram reexecutados nesta auditoria.

O teste `rcm-atacado-02-precisao-desconto.test.js` cobre a aritmética do motor CommonJS e verifica estruturalmente que o espelho browser apresenta funções correspondentes e que o script é carregado antes do PDV. Não executa o fluxo de seleção de preço, endpoints de promoção/atacado, payload completo do PDV ou a formação de preço efetiva no servidor.

### Casos necessários antes de afirmar integração

Em ambiente isolado, com a função compartilhada real — não uma cópia de suas regras — devem ser provados:

1. Mesma cotação para produto/quantidade/modo no motor de composição e no PDV.
2. Mesma regra para preço unitário interno, valor exibido, subtotal da linha e total agregado.
3. Produto vendido por unidade, incluindo preço por unidade e conversão de quantidade para estoque.
4. Promoção ativa, início/fim da validade, inativa/expirada e conflito com atacado.
5. Atacado abaixo do limiar, em cada limiar e acima do último limiar, inclusive alteração de quantidade após incluir o item.
6. Conversão MUC do volume fiscal sem confundi-la com conversão de estoque físico ou tipo de venda.
7. Fingerprint inválido após mudança em preço-base, preço de unidade, promoção, flag/faixa de atacado, volume/MUC, elegibilidade, reserva/saldo e dados do Pedido.
8. Fechamento exato prioritário e menor desconto comprovado com subtotal quantidade-dependente.
9. Limite computacional: resultado inconclusivo é bloqueado e candidato parcial nunca entra no carrinho.
10. Desconto calculado não autorizado automaticamente; caminho de autorização humana exercitado no PDV.
11. Regressão dos 26 testes focados e ausência de criação de venda, baixa física, consumo de ficha técnica, cobrança ou movimento financeiro pela simulação.
12. Revalidação backend da cotação e preço efetivo na conclusão, em teste isolado — somente em sprint futura autorizada.

Não é possível fabricar uma prova válida para estes casos antes de existir a função compartilhada e o contrato backend. Testes isolados do simulador atual ou de uma cópia das regras não demonstrariam integração.

## Alterações, limitações e pendências

- **Alterações de produção/testes nesta sprint:** nenhuma.
- **Documento criado:** `docs/vendas/sprint-2.2-contrato-preco-integracao-relatorio.md`.
- **Integração com PDV concluída:** não.
- **Composição usando preço efetivo do carrinho:** não; permanece com `produtos.preco_venda`.
- **Preço backend autoritativo no checkout:** não comprovado; o núcleo recebe os campos de preço/subtotal do payload e os usa na distribuição/persistência.
- **Promoção, unidade e atacado validados pelo motor de composição:** não.
- **Suíte executada nesta sprint:** nenhuma.

Pendências para uma futura implementação da ponte:

1. Definir e testar uma única implementação numérica compartilhada, eliminando deriva entre o arquivo CommonJS do backend e o espelho JavaScript do browser.
2. Criar serviço backend de cotação com `db` explícito, sem banco global/DDL, capaz de resolver as regras comerciais reais.
3. Alinhar limites temporais e regras de promoção do endpoint e das demais projeções existentes.
4. Adaptar a busca fiscal para preço/subtotal dependente de quantidade e preservar prova de optimalidade.
5. Definir o modo de venda que a importação aplicará a cada modelo, sem presumir preço de unidade.
6. Definir como o valor de composição/desconto autorizado será representado no carrinho sem substituir o total comercial original do Pedido.
7. Integrar a cotação ao PDV e validar/recalcular no backend na conclusão, preservando autorização, estoque, ficha técnica e financeiro idempotentes.
8. Executar os testes isolados listados acima antes de declarar paridade ou integração.

Esta auditoria foi estática: não foram acessados bancos operacionais, não foram executadas migrações, e não foram iniciados fluxos de PDV, faturamento, pagamento, cobrança, estoque, emissão fiscal ou SEFAZ.
