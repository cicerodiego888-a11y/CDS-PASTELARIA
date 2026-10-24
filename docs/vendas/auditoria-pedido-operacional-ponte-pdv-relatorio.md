# Auditoria arquitetural — Pedido Operacional e ponte oficial com o PDV

**Escopo:** auditoria estática e proposta arquitetural.  
**Resultado:** nenhuma alteração de produção ou de testes foi feita nesta etapa.  
**Banco e integrações fiscais:** nenhum banco foi aberto ou escrito; nenhum ERP foi iniciado e nenhuma operação SEFAZ foi executada.

## 1. Síntese executiva

O repositório já possui um Pedido Operacional persistido em `pedidos` e `pedidos_itens`, uma interface administrativa para criá-lo e acompanhá-lo, e um PDV oficial com carrinho, pagamento e entrada no núcleo transacional de vendas. Não foi encontrado, nos pontos inspecionados, um comando para pesquisar/importar Pedidos no PDV.

O faturamento atual do Pedido é um caminho distinto: a tela de Expedição consome as rotas de `/api/faturamento` e chama `FaturamentoService`. Esse fluxo deve permanecer legado e congelado para a nova ponte. A nova experiência deve concluir a venda pelo PDV oficial e pelo núcleo compartilhado de vendas — não chamar `FaturamentoService`.

O distribuidor fiscal atual reparte os itens que já recebeu entre parcelas fiscais e não fiscais. Ele não substitui produtos do Pedido por outros produtos elegíveis e não implementa a composição do exemplo de negócio. A ponte requer um componente explícito de composição fiscal, com produtos e saldo fiscal elegíveis para a empresa, mantendo em separado o Pedido comercial e os itens que efetivamente representam a venda composta.

Há uma lacuna crítica de integridade: o núcleo de venda atualmente usa os itens da venda para seus efeitos de estoque e ficha técnica, enquanto os itens da venda composta não precisam ser os produtos físicos originalmente solicitados no Pedido. A futura implementação precisa fornecer ao núcleo os itens operacionais do Pedido para consumo físico/ficha técnica, sem provocar uma segunda baixa pelos itens de representação fiscal.

## 2. Arquivos e funções efetivamente inspecionados

### PDV e venda oficial

- `frontend/pdv/index.html`, `frontend/pdv/pages/pdv.html` e `frontend/pdv/js/app.js`: carregamento e estrutura da tela oficial.
- `frontend/pdv/js/pdv.js`: manutenção do carrinho, cálculo do total, abertura do pagamento, pré-cálculo de distribuição e envio da venda.
- `backend/rotas/vendas.js`: rotas oficiais de venda e middleware de contexto/empresa.
- `backend/services/vendas/VendaApplicationService.js`: `criarVenda`, `criarVendaComContexto` e `concluirVendaNoNucleoOficial`.
- `backend/services/vendas/VendaContract.js`, `VendaContext.js` e `VendaOrigin.js`: contrato, contexto e política de origem.
- `backend/services/vendas/VendaPagamentoService.js`: `preCalcularDistribuicao` e `criarVenda`, validação do total e persistência/efeitos do núcleo.
- `backend/services/distribuidorEstoqueVenda.js`: `distribuirItensVendaComValorFiscalEfetivo`.
- `backend/services/produtos/FichaTecnicaConsumoService.js`: montagem das linhas de consumo a partir dos itens recebidos e da ficha técnica obtida no momento do consumo.
- `backend/services/vendas/VendaFinanceiroService.js` e os fluxos de pagamento/financeiro chamados pelo núcleo.

### Pedido Operacional e faturamento legado

- `backend/rotas/pedidos.js` e `backend/services/pedido/PedidoOperacionalService.js`: operações de Pedido, incluindo criação/edição, cancelamento, duplicação, conversão e envio à fila.
- `backend/services/pedido/PedidoRepository.js`: `listarPedidos`, `listarAguardandoFaturamento`, `obterPorId`, `criarPedido` e persistência dos itens.
- `backend/services/pedido/PedidoService.js` e `backend/services/pedido/enums.js`: contratos de Pedido e estados.
- `backend/rotas/faturamento.js` e `backend/services/faturamento/FaturamentoService.js`: fila, detalhe e faturamento legado.
- `frontend/erp/js/pedidos.js`: manutenção e envio do Pedido à fila de Expedição.
- `frontend/erp/js/faturamento.js`: fila de faturamento, consulta do Pedido e chamada de faturamento legado.
- `backend/services/vendas/VendaPagamentoService.js` e serviços de estoque, ficha técnica, pagamento e financeiro: superfícies compartilhadas pelo PDV oficial, portanto não são exclusivas do fluxo legado.

### Testes encontrados por área

Foram localizados testes de Pedido, PDV, faturamento, vendas, estoque e saldo fiscal, incluindo `tests/pedidos/pedido-operacional-sprint-b1.test.js`, `tests/pdv/rc141515-busca-plu-exata-v1.test.js`, testes de `tests/faturamento/`, `tests/vendas/` e `tests/estoque/`. Nenhum teste foi executado nesta auditoria estática.

## 3. Estado atual comprovado

### 3.1 Modelo e estados do Pedido

O Pedido existente é persistido em `pedidos`, com seus itens em `pedidos_itens`; não é necessário criar uma segunda entidade de Pedido. O cabeçalho contém dados comerciais e operacionais, incluindo total, desconto/frete, cliente, operador, `empresa_id`, `status` e vínculo `venda_id`, além de metadados associados ao faturamento. Os itens preservam produto, quantidade, preço unitário, desconto percentual, subtotal e tipo de venda.

Os estados definidos em `pedido/enums.js` são `ORCAMENTO`, `PEDIDO`, `ABERTO`, `EM_SEPARACAO`, `AGUARDANDO_FATURAMENTO`, `FATURADO` e `CANCELADO`. `ABERTO` e `EM_SEPARACAO` são mantidos por compatibilidade com o legado. O fluxo legado coloca Pedidos em `AGUARDANDO_FATURAMENTO` e os apresenta na fila própria de Expedição.

No workspace desta auditoria há snapshots opcionais dos itens para classificação operacional (`COMERCIAL`/`INSUMO`), código, nome e unidade do produto. `PedidoRepository.obterPorId` indica quando a classificação veio do snapshot ou do catálogo atual. Preço, quantidade, desconto e subtotal do Pedido já ficam registrados no item; nome/código/unidade e classificação ainda podem depender de fallback para o catálogo em registros antigos.

Esses snapshots não congelam a composição da ficha técnica, as quantidades de insumos nem as conversões aplicáveis. `FichaTecnicaConsumoService.montarLinhasConsumo` busca a ficha técnica atual pelo produto e usa seus componentes na hora do consumo. Assim, o código observado não demonstra que o Pedido mantenha uma fotografia histórica da receita que será consumida.

**Lacunas para a ponte:** não existe estado explícito de importação/conclusão pelo PDV distinto do faturamento legado; não há vínculo atômico Pedido-venda comprovado para o novo caminho; não há fotografia imutável da composição fiscal proposta; tampouco há um contrato que distinga itens operacionais dos itens fiscais de representação.

### 3.2 PDV oficial e núcleo

O PDV é carregado por `frontend/pdv/js/app.js` e sua interface reside em `frontend/pdv/pages/pdv.html`. `frontend/pdv/js/pdv.js` mantém o carrinho e calcula o total comercial a partir dos itens, descontos e acréscimos. O fluxo de pagamento faz o pré-cálculo por `POST /api/vendas/pre-calcular-distribuicao` e a conclusão por `POST /api/vendas`.

O pré-cálculo exige itens com `produto_id`, consulta os produtos e a disponibilidade no contexto da empresa e envia os próprios itens ao `distribuidorEstoqueVenda`. O distribuidor calcula partilhas fiscal/não fiscal e valores efetivos desses itens; não escolhe outro produto para substituir um item original. O `POST /api/vendas` passa por `VendaApplicationService` e, para origens habilitadas a concluir, delega ao `VendaPagamentoService`.

O núcleo valida um total recebido maior que zero e exige produtos vinculados nos itens, mas o contrato observado não representa em campos separados o total comercial original do Pedido, a composição fiscal e os produtos físicos a consumir. Portanto, o PDV não pode simplesmente receber o total do Pedido e trocar as linhas do carrinho sem uma regra de reconciliação no servidor.

Nos arquivos PDV inspecionados não foi encontrada ação “Importar Pedido” nem pesquisa pela API de Pedidos. A venda oficial é, atualmente, iniciada a partir do carrinho montado no PDV.

### 3.3 Classificação do fluxo legado

**Exclusivo do faturamento legado:** fila e detalhe de Expedição em `/api/faturamento/pedidos/...`, endpoint `POST /api/faturamento/pedidos/:id/faturar`, `FaturamentoService.faturarPedido` e a interface `frontend/erp/js/faturamento.js` que os consome. `frontend/erp/js/pedidos.js` também contém a ação de enviar um Pedido para a fila.

**Compartilhado e necessário ao PDV:** `VendaApplicationService`, `VendaContract`, `VendaContext`, `VendaOrigin`, `VendaPagamentoService` e os serviços de baixa de estoque, ficha técnica, pagamento e financeiro. Congelar ou contornar esses componentes junto com o legado impediria ou duplicaria partes do fluxo oficial.

O `VendaApplicationService` reconhece origens que não estão habilitadas para conclusão e responde sem concluir a venda. A ponte não deve presumir que uma origem `PEDIDO` já conclui no núcleo, nem habilitar essa origem sem desenhar e testar seu contrato. O caminho recomendado é uma entrada explícita no PDV oficial, com validações de Pedido próprias e a conclusão pelo núcleo compartilhado; nenhuma chamada ao faturamento legado.

### 3.4 Estoque físico, ficha técnica, saldo fiscal e financeiro

O pré-cálculo atual usa saldo fiscal/não fiscal associado aos produtos recebidos. Há serviços e tabelas de categoria fiscal e saldo fiscal por empresa em mililitros, separados do estoque físico. A configuração de produtos elegíveis por categoria e o ledger existem, mas a auditoria não encontrou o fluxo de composição por categoria integrado à criação da venda nem um consumo desse ledger como substituto da baixa física.

O núcleo oficial da venda persiste venda e itens e aciona os fluxos existentes de estoque, ficha técnica e pagamento/financeiro. A ficha técnica é consultada no consumo, e não é derivada automaticamente de uma composição fiscal. O fluxo deve manter uma única integração de pagamento/financeiro e não baixar fisicamente os produtos fiscais de representação como se fossem, necessariamente, as mercadorias entregues ao cliente.

Os detalhes e limites transacionais entre a criação da venda, efeitos de estoque/ficha, vínculo ao Pedido e status do Pedido já foram documentados na auditoria B2. A auditoria B3 também registrou que `vendas.pedido_id` é associado depois do commit no caminho legado e que a proteção observada não equivale a uma restrição única persistente. Essas conclusões anteriores não foram reimplementadas nem retestadas nesta etapa; consultar [relatório B2](./pedido-operacional-sprint-b2-auditoria-faturamento-relatorio.md) e [relatório B3](./pedido-operacional-sprint-b3-idempotencia-relatorio.md).

## 4. Arquitetura proposta para importar no PDV

1. **Ação e pesquisa:** adicionar no PDV oficial a ação “Importar Pedido”. Pesquisar somente Pedidos da empresa ativa, por rota autenticada com `empresa_id` resolvido no servidor. A rota deve excluir Pedido cancelado/orçamento/faturado e impedir a importação de Pedidos já em processamento por outra via.
2. **Revisão antes da importação:** apresentar código, cliente, itens operacionais, quantidades, preços e total comercial persistidos. Não permitir que o operador interprete os itens fiscais compostos como substituição dos produtos efetivamente solicitados.
3. **Composição fiscal no servidor:** enviar o identificador do Pedido e a empresa resolvida a um serviço do Motor de Vendas que consulte o Pedido e a configuração fiscal da mesma empresa. Gerar opções exclusivamente com produtos fiscais elegíveis existentes e dados reais de preço, quantidade, categoria e saldo fiscal. Nenhum produto, preço ou quantidade pode ser inventado pelo cliente.
4. **Fechamento:** procurar primeiro composição exata sem desconto. Só usar desconto se a política da empresa permitir, houver autorização aplicável e a composição exata não for possível. Se nenhum fechamento permitido existir, devolver erro explícito e não criar venda.
5. **Carrinho e pagamento:** mostrar ao operador a composição e seus valores para conferência; seguir o pagamento e a conclusão no PDV oficial. O PDV não deve enviar como mercadoria física os produtos operacionais apenas para alcançar o total fiscal.
6. **Validação na conclusão:** o servidor recarrega e valida Pedido, empresa, estado, total e composição antes de aceitar o pagamento/venda. Uma prévia de composição no navegador não é prova suficiente: saldo, estado e disponibilidade podem mudar entre prévia e conclusão.
7. **Consumo operacional único:** a venda deve preservar os itens fiscais necessários à representação fiscal e, separadamente, referenciar os itens operacionais do Pedido para a baixa física/ficha técnica. O núcleo deve garantir que as linhas de representação fiscal não acionem uma segunda baixa física nem consumo duplicado de receita. Não criar uma segunda rotina independente de baixa.
8. **Conclusão:** registrar a venda e os vínculos Pedido-venda de modo consistente, marcar o Pedido como concluído pelo novo caminho e garantir que o pagamento/financeiro aconteça uma única vez. O fluxo não chama `FaturamentoService`.

### 4.1 Exemplo de negócio — valores que devem ser preservados

**Pedido operacional:** 2 pastéis a R$ 21,99 (R$ 43,98) e 1 Coca-Cola 2 L a R$ 18,00 (R$ 18,00). Total comercial: **R$ 61,98**.

**Representação fiscal no PDV:** 2 pastéis a R$ 8,99 (R$ 17,98) e composição de **R$ 44,00** com itens fiscais de refrigerantes elegíveis configurados para a empresa. A composição deve totalizar **R$ 61,98**. A Coca-Cola 2 L original continua no Pedido como produto físico operacional, mas não entra como uma linha real da venda composta. O saldo fiscal compartilhado em mililitros permanece separado do estoque físico.

Esse exemplo define o requisito; não é evidência de que o motor atual consiga produzi-lo. O distribuidor existente não realiza a substituição/composição descrita.

## 5. Contrato de dados proposto para a ponte

O cliente deve enviar uma referência ao Pedido e os dados necessários à seleção de pagamento; não deve ser a fonte de verdade dos itens do Pedido, do preço, da empresa ou da composição.

```json
{
  "pedido_id": 123,
  "empresa_id": 7,
  "composicao_id": "identificador-opaco-da-previa",
  "pagamentos": [
    { "forma_pagamento": "dinheiro", "valor": 61.98 }
  ]
}
```

`empresa_id` acima representa o contexto esperado, não uma autorização confiável fornecida pelo navegador. O servidor deve resolver a empresa ativa, exigir correspondência com o Pedido e rejeitar divergências. O identificador de prévia, se usado, deve ser associado no servidor a Pedido, empresa, composição, total, política e expiração; alternativamente o servidor pode recompor e validar a proposta no momento da conclusão.

O núcleo deve operar com uma representação interna claramente tipada, conceitualmente equivalente a:

```text
PedidoComercial:
  pedido_id, empresa_id, cliente_id, status, total_comercial, desconto, frete
  itens_operacionais[]: produto_id, quantidade, preço/subtotal persistidos,
                        tipo_venda e snapshots existentes

ComposicaoFiscal:
  composição_id, pedido_id, empresa_id, total_comercial_reconciliado
  itens_fiscais[]: produto_id elegível, quantidade, preço/valor fiscal,
                   categoria/unidade fiscal e origem da configuração
  desconto_aplicado, regra/política, versão e dados de validação

Conclusao:
  pedido_id, venda_id, empresa_id, chave de idempotência,
  resultado de pagamento, estado dos efeitos operacionais
```

É uma separação lógica/contratual, não proposta para uma segunda tabela de Pedido. A persistência concreta de composição, idempotência e estados de recuperação deve ser definida após confirmar limites de conexão/transação do núcleo. O valor total pago e o total comercial autorizado precisam reconciliar; a soma da composição fiscal apresentada deve ser igual ao total aceito, inclusive descontos/acréscimos autorizados. A API deve recalcular essa condição no servidor e não confiar em totais ou linhas arbitrários do front-end.

## 6. Estratégia proposta de idempotência, empresa e recuperação

- Definir a identidade pela dupla **empresa + Pedido**. Todas as consultas do Pedido, composição, venda, saldo fiscal e efeitos operacionais devem receber a empresa explícita; não usar fallback global.
- Proteger o direito de concluir no banco, não apenas com verificação de status em memória. Preferência: serialização em transação SQLite (`BEGIN IMMEDIATE`, usando a conexão efetivamente responsável pelos writes) junto com restrição persistente única para uma venda concluída por empresa/Pedido. O índice atual de `vendas.pedido_id` mencionado no relatório B3 não prova essa unicidade.
- Persistir `pedido_id` e `empresa_id` na criação da venda, e manter `pedidos.venda_id` e `vendas.pedido_id` consistentes sob a mesma estratégia transacional. Antes de qualquer repetição, procurar e reconciliar vínculos existentes; uma venda confirmada nunca deve ser recriada por mera ausência de resposta HTTP.
- Tornar os efeitos secundários idempotentes sob o mesmo identificador de operação/venda: consumo de reservas, estoque físico, ficha técnica, pagamentos e lançamentos financeiros. Resultado de chamada sem erro não deve ser interpretado como prova de consumo concluído; distinguir concluído, já realizado, pendente/inconclusivo e erro.
- Se não for viável manter venda, vínculos e efeitos na mesma transação/conexão, parar antes de implementação e desenhar recuperação durável por estados e reconciliação. Não tratar um estado transitório como autorização para criar outra venda ou reaplicar baixa.
- Em divergência entre `pedidos.venda_id` e `vendas.pedido_id`, bloquear nova venda, registrar erro explícito e reconciliar por empresa/Pedido/venda. Não “corrigir” silenciosamente o total nem escolher arbitrariamente um dos vínculos.
- Excluir o estado de falha/resultado desconhecido de qualquer caminho de repetição automática. A interface deve comunicar ao operador que a conclusão está em reconciliação e não solicitar novo pagamento.

## 7. Matriz de riscos e dependências

| Risco/dependência | Evidência atual | Tratamento requerido antes do aceite |
|---|---|---|
| Composição fiscal não implementa substituição por categoria | O distribuidor atual reparte itens recebidos; não busca produtos alternativos elegíveis | Motor novo de composição, configurado por empresa, com saldo fiscal em ml |
| Total operacional confundido com fiscal | O contrato atual de venda não separa claramente os conjuntos operacional e fiscal | Contrato explícito e validação server-side da igualdade de valores |
| Baixa física ou ficha duplicada/errada | Núcleo usa itens da venda; a composição fiscal pode divergir dos produtos físicos do Pedido | Passar as linhas operacionais ao mecanismo compartilhado de consumo uma única vez e excluir a representação fiscal desse consumo |
| Ficha técnica não congelada no Pedido | A ficha consultada é a atual no momento do consumo | Decidir se usa ficha vigente na conclusão ou se precisa snapshot; testar a decisão |
| Duplo faturamento pelos caminhos novo e legado | Legado tem fila `AGUARDANDO_FATURAMENTO`; status/vínculos não são um lock transacional suficiente | Definir whitelist de estados e bloquear concorrência entre os dois caminhos |
| Venda/pagamento persistidos com Pedido ainda aberto | Limites de transação do legado são separados; B2/B3 documentam risco de falha intermediária | Restrição persistente, transação/conexão comprovada ou recuperação durável antes de nova tentativa |
| Empresa cruzada ou fallback | Há middleware de empresa no PDV, mas cada operação nova precisa carregar o contexto até todas as consultas | Testar empresas distintas, Pedido de outra empresa e ausência de contexto |
| Estoque fiscal confundido com físico | Ledger de categoria em ml é separado, mas não foi encontrado consumo integrado à composição oficial | Integrar e reconciliar saldo fiscal sem usá-lo como saldo físico |
| Desconto ou arredondamento alteram o total | Distribuidor atual aplica regras de partilha/valor fiscal; composição exata é nova | Testes de centavos, desconto autorizado e falha sem solução exata |
| Compatibilidade do fluxo legado | ERP continua usando os endpoints e telas de faturamento | Congelar comportamento, manter rotas e provar que a ponte não os invoca |

## 8. Sequência recomendada de implementação e critérios de aceite

### Sprint futura 1 — contrato e estados

- Aprovar estados elegíveis à importação e comportamento para `AGUARDANDO_FATURAMENTO`.
- Aprovar política de composição exata/desconto e o tratamento da ficha técnica vigente.
- Definir contrato tipado Pedido operacional/composição fiscal/pagamento, sem alteração da composição comercial do Pedido.
- Critério: Pedido de outra empresa, cancelado, faturado ou em fluxo legado não pode ser importado; o caminho legado segue funcionando sem ampliação.

### Sprint futura 2 — composição fiscal em modo isolado

- Implementar proposta de composição usando apenas produtos/categorias fiscais elegíveis e saldos da empresa.
- Priorizar fechamento exato sem desconto e aplicar desconto apenas se política e autorização permitirem.
- Critério: demonstrar o exemplo de R$ 61,98 quando os produtos e saldos de teste o permitirem; demonstrar erro sem venda quando não houver composição válida; provar que saldo fiscal em ml não altera estoque físico.

### Sprint futura 3 — entrada de importação no PDV

- Adicionar pesquisa, revisão e seleção na interface oficial.
- Gerar carrinho composto sem converter todos os itens operacionais em itens de venda; manter referência interna e não confiar nos valores editáveis do cliente.
- Critério: o operador visualiza Pedido e composição separadamente, não consegue alterar silenciosamente o Pedido nem pagar total divergente; a conclusão segue a rota oficial de vendas.

### Sprint futura 4 — transação, efeitos e idempotência

- Integrar a referência Pedido-venda, serialização/constraint persistente e consumo operacional no núcleo compartilhado.
- Tornar consumo de estoque, ficha, pagamento e financeiro único e recuperável.
- Critério: repetição sequencial e concorrência controlada produzem uma venda e uma única aplicação de cada efeito; falha após venda e vínculos divergentes são reconciliados sem criar nova venda; isolamento por empresa demonstrado.

### Sprint futura 5 — regressão e habilitação

- Executar testes isolados para PDV, Pedido, faturamento legado, vendas, estoque físico, ficha técnica, pagamentos/financeiro, composição e multiempresa.
- Habilitar a ponte por configuração/flag quando houver estratégia de retorno operacional.
- Critério: os testes provam os invariantes e a regressão do legado; nenhuma dupla baixa, consumo de ficha, cobrança ou lançamento financeiro.

## 9. Limitações da auditoria

- Auditoria estática; nenhum teste foi executado e nenhum comportamento foi reproduzido em runtime.
- Não foi feito acesso, leitura ou escrita em banco operacional ou de teste.
- Não foram executadas migrações, operações fiscais ou chamadas SEFAZ; ERP/Electron não foi iniciado.
- A composição por categoria fiscal do exemplo não existe nos pontos inspecionados; não há evidência para afirmar que os modelos e saldos atuais consigam compor R$ 44,00.
- A transação interna completa do núcleo e a possibilidade de incluir todos os efeitos em uma única transação/conexão devem ser verificadas novamente na sprint de implementação, com escopo controlado.
- A elegibilidade exata dos estados do Pedido e o uso da ficha vigente versus snapshot histórico exigem decisão de negócio/arquitetura.
- Alterações locais preexistentes foram preservadas. Esta entrega adiciona somente este relatório.

## 10. Conclusão

Reaproveitar `pedidos` e `pedidos_itens` como fonte comercial e usar o PDV/núcleo de vendas existente como caminho de pagamento é viável em princípio, mas não é seguro apenas adicionar um botão que transforme os itens do Pedido em itens do carrinho. A composição fiscal por categoria, a separação entre linhas fiscais e consumo físico, e a idempotência transacional precisam ser desenhadas como contratos explícitos antes de qualquer implementação.

O faturamento legado deve permanecer congelado e separado. A arquitetura futura deve entrar pelo PDV oficial, validar Pedido/empresa/composição no servidor e concluir pelo núcleo compartilhado, com efeitos operacionais idempotentes. Esta sprint termina com a proposta para revisão arquitetural; nenhuma implementação foi iniciada.
