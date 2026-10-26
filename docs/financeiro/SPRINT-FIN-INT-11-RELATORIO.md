# FIN-INT-11 — Auditoria de isolamento nas operações de Contas a Receber

## Resumo executivo

A consulta canônica do relatório financeiro já exige correspondência empresarial desde FIN-INT-10. A auditoria encontrou outros caminhos em `backend/rotas/financeiro.js` e nos serviços de vendas que ainda associam recebíveis a vendas somente por ID.

Os riscos não são uniformes:

- Listagem, detalhes, extrato e histórico de pagamentos podem obter código, total, data ou produtos da venda de outra empresa.
- A agregação de recebíveis pode excluir títulos da empresa A quando a venda referenciada de B está cancelada.
- O pagamento parcial tem uma validação oficial posterior que detecta a divergência e desfaz a transação; a fixture confirmou que saldo, registro de pagamento e financeiro permanecem inalterados.
- Os serviços de cancelamento e devolução parcial não aplicam empresa ao selecionar/atualizar recebíveis por `venda_id`. Em fixture isolada, uma venda B cancelou um recebível A e uma devolução de B reduziu o saldo de um recebível A. A alteração da devolução foi revertida pela transação de diagnóstico.
- O endpoint de histórico de pagamentos retorna HTTP 500 na fixture: a consulta referencia `cr.conta_receber_id`, coluna que não existe em `contas_receber` no esquema atual.

Nenhum código de produção ou contrato foi alterado. As conclusões e correções propostas abaixo aguardam homologação.

## Invariante de esquema e método

O esquema declara referências separadas para `contas_receber.venda_id → vendas.id` e `contas_receber.empresa_id → empresas.id`; não há chave estrangeira composta que obrigue a venda e o recebível a pertencerem à mesma empresa. Portanto, uma linha pode ter referências individualmente válidas, mas empresarialmente inconsistentes.

Foram inspecionados `backend/rotas/financeiro.js`, `backend/services/vendas/VendaFinanceiroService.js`, `backend/services/vendas/VendaPagamentoService.js`, `backend/services/vendas/VendaCancelamentoService.js`, `backend/services/vendas/VendaDevolucaoService.js` e as tabelas relacionadas em `backend/database.js`.

As reproduções foram feitas em SQLite `:memory:` com empresa A, empresa B, clientes, vendas, recebíveis e pagamentos fictícios. Os handlers da rota utilizaram somente essa conexão de fixture. Não houve acesso a bancos oficiais/de clientes ou execução de operação financeira real.

## Inventário de caminhos

| Caminho | Associação e dados da venda | Filtros de empresa e consequência | Classificação |
|---|---|---|---|
| `GET /receber` — `buildReceberCanonicoQueryFilters` | `LEFT JOIN vendas v ON v.id = cr.venda_id`; retorna `v.codigo`, usado na descrição. | Filtra `cr.empresa_id`, mas não exige `v.empresa_id = cr.empresa_id`. Um recebível A associado a venda ativa B aparece na lista com o código de B. O helper de cancelamento também consulta status de venda apenas por ID e pode suprimir um recebível A quando a venda B está cancelada. | **P1** para exposição do código; **P2** para exclusão por cancelamento estrangeiro. |
| `GET /receber/agrupado` | Não junta a tabela `vendas`; agrega quantidade de títulos, saldos e vencimentos do CR. | Filtra `cr.empresa_id`, mas usa `sqlExcluirContaVendaCancelada('cr')`, cujo subselect considera cancelamento por ID sem empresa. A fixture demonstrou saldo menor quando um recebível A referencia venda B cancelada. Para venda estrangeira ativa, o endpoint não usa campos da venda e agrega o CR normalmente. | **P2** — total/contagem podem ficar incorretos por status estrangeiro. |
| `GET /receber/agrupado/:clienteId` — detalhes | `JOIN vendas v ON v.id = cr.venda_id`; retorna código, data e total da venda. Em seguida consulta `vendas_itens` pelos IDs de venda obtidos e retorna itens, quantidades e valores. | O CR é filtrado por cliente e empresa, mas a venda e seus itens não são. Com venda B ativa, a resposta A pode mostrar dados e itens de B associados ao título A. O `JOIN` interno também omite títulos sem venda associada. | **P1** — exposição de atributos e itens de outra empresa. |
| `GET /receber/agrupado/:clienteId/extrato` | `JOIN vendas v ON v.id = cr.venda_id`; retorna código, data e total, e carrega `vendas_itens` por ID. | Filtra cliente e `cr.empresa_id`; a identificação da empresa do extrato vem do contexto A, mas os atributos podem ser da venda B. Não aplica o helper de exclusão de venda cancelada. O `JOIN` interno omite CR sem venda. | **P1** — dados estrangeiros podem aparecer em documento/extrato identificado como A. |
| `GET /receber/agrupado/:clienteId/pagamentos` | Junta pagamento→CR→venda por IDs e seleciona `v.codigo`. | Restringe cliente e `cr.empresa_id`, não a empresa da venda. Contudo, a consulta seleciona `cr.conta_receber_id`; essa coluna não existe no esquema atual de `contas_receber` (cuja PK é `id`). A chamada retorna HTTP 500, de modo que não houve resposta com o código estrangeiro. Se a consulta for corrigida, a junção continuará sem guarda empresarial. | **P1** funcional para a falha do endpoint; risco de isolamento **P2** após correção do erro SQL. |
| `POST /receber/agrupado/:clienteId/pagamento-parcial` | `LEFT JOIN vendas v ON v.id = cr.venda_id`; usa código e `v.empresa_id` ao materializar/atualizar o lançamento financeiro. | Filtra o CR por empresa A. A resolução oficial recebe a empresa da requisição e a empresa da venda; divergência lança erro 409. Como isso ocorre dentro da transação, o pagamento e a atualização prévia do CR são revertidos. | **P2** — comportamento atual falha de modo seguro na divergência, embora a consulta leia a venda estrangeira antes de rejeitar. |
| `GET /relatorios/receber` | Junção canônica já condicionada por `v.empresa_id = cr.empresa_id` desde FIN-INT-10; o cancelamento é considerado somente sobre a venda associada da mesma empresa. | O recebível é filtrado por `cr.empresa_id`; relação válida e CR sem venda mantêm o comportamento coberto pelos testes FIN-INT-05. | **Sem achado novo** neste endpoint. |
| `VendaFinanceiroService.cancelarFinanceiroVenda` / `executarCancelamentoFinanceiro` | Atualiza CR por `WHERE venda_id = ?`, sem condição de empresa. | Uma venda B pode cancelar recebíveis A que tenham referência inconsistente à venda B. A chamada foi verificada em fixture isolada e alterou o status do CR A para `cancelado`. | **P1** — escrita financeira cruzada. |
| `VendaFinanceiroService.recalcularFinanceiroDevolucaoVenda` | Seleciona CR por `venda_id` e atualiza as linhas selecionadas por ID, sem empresa. | Uma devolução da venda B reduziu o saldo de um CR A com referência cruzada. A fixture mostrou `80 → 60`; a transação de diagnóstico foi revertida ao final. | **P1** — cálculo/escrita de saldo cruzado. |
| `VendaPagamentoService.verificarSaldoOutrosVenda` | Agrega `valor_parcela` e `valor_restante` de `contas_receber` por `venda_id` e componente, sem empresa. | Os valores de um CR A ligado a venda B podem influenciar a verificação de saldo “outros” da venda B. A relação estática foi confirmada; esta função privada não foi invocada isoladamente nesta auditoria. | **P2** — cálculo pode incluir valores de outra empresa; requer reprodução específica no fluxo chamador. |

### Leitura versus escrita

Os endpoints de listagem, resumo, detalhes, extrato e histórico são leituras: os riscos confirmados são apresentação de dados de venda estrangeira e, no resumo/lista, inclusão ou exclusão incorreta de CR conforme o estado da venda estrangeira.

O pagamento parcial é uma escrita iniciada por uma requisição da empresa A, mas a validação de ownership detecta venda B e a transação é revertida. Já cancelamento e devolução parcial são caminhos de escrita dos serviços de vendas: os testes isolados confirmaram alterações em CR A vinculados incorretamente à venda B.

## Evidências dos testes

### Diagnósticos de rota em SQLite `:memory:`

O harness temporário invocou os handlers da rota com recebíveis válidos, cruzados, sem venda e ligados a venda estrangeira cancelada:

- **Listagem canônica:** as asserções de fixture confirmaram que o CR A ligado à venda ativa B aparece com o código `V-B`; o CR A sem venda também aparece; o CR A ligado à venda B cancelada é excluído pelo helper global.
- **Resumo agrupado:** o total do cliente A foi `110`, correspondente ao CR cruzado ativo (`80`) e ao CR sem venda (`30`); o CR A com venda estrangeira cancelada (`60`) foi omitido.
- **Detalhes:** a resposta da empresa A mostrou a venda `V-B`, total `999` e produto “Produto da empresa B”.
- **Extrato:** a resposta identificada com a empresa A mostrou `V-B` e total `999`.
- **Histórico de pagamentos:** a consulta retornou HTTP 500 com `SQLITE_ERROR: no such column: cr.conta_receber_id`. O esquema usa `contas_receber.id`; portanto, o risco de resposta cruzada neste handler não foi demonstrado devido à falha SQL anterior.

### Diagnóstico de caminhos de escrita

Em outra fixture `:memory:`:

- A tentativa de pagamento parcial do CR A ligado à venda B respondeu **409** por divergência empresarial.
- Após a resposta, `valor_restante` do CR permaneceu `80`, nenhuma linha nova foi gravada em `contas_receber_pagamentos` e a tabela `financeiro` permaneceu inalterada: o rollback foi confirmado.
- Dentro de transação de diagnóstico, `recalcularFinanceiroDevolucaoVenda` para a venda B reduziu o CR A de `80` para `60`; o rollback restaurou `80`.
- `cancelarFinanceiroVenda` para a venda B alterou o CR A cruzado para `cancelado` na fixture isolada.

### Regressão anterior

Executado:

```text
node --test tests\financeiro\fin-int-05-relatorio-receber.test.js
```

Resultado: **2 testes passaram, 0 falhas**, incluindo relação válida A→A, relação cruzada A→B, venda estrangeira cancelada, CR sem venda e isolamento do relatório FIN-INT-10.

Os harnesses temporários de diagnóstico não foram adicionados ao repositório. O teste do serviço de devolução usou transação explícita com rollback; o teste de cancelamento rodou em conexão `:memory:` descartada ao final.

## Achados e prioridade

1. **P1 — Escrita cruzada no cancelamento e na devolução.** `cancelarFinanceiroVenda` e `recalcularFinanceiroDevolucaoVenda` selecionam/alteram CR por ID da venda sem conferir `cr.empresa_id = venda.empresa_id`. Ambos foram reproduzidos em fixture.
2. **P1 — Dados de venda/itens estrangeiros em detalhes e extrato.** Os joins por ID e consultas subsequentes a `vendas_itens` permitem montar uma resposta da empresa A com informações de venda B.
3. **P1 — Histórico de pagamentos indisponível.** A consulta usa coluna inexistente em `contas_receber`; a falha ocorre antes da avaliação da associação empresarial.
4. **P1 — Código estrangeiro na listagem canônica.** `GET /receber` filtra a empresa do CR, mas o código é obtido por join sem escopo empresarial.
5. **P2 — Resumo/listagem condicionados por cancelamento de venda estrangeira.** O helper `sqlExcluirContaVendaCancelada` filtra status somente por `venda_id`, podendo suprimir CR da empresa proprietária.
6. **P2 — Pagamento parcial.** O fluxo atualmente recusa a divergência com 409 e reverte a transação; a consulta, porém, lê atributos da venda antes de detectar a inconsistência.
7. **P2 — Cálculo de saldo “outros”.** A verificação em `VendaPagamentoService` soma recebíveis por venda sem escopo de empresa; risco estático, sem execução isolada do método privado.

Não foi identificado motivo para classificar qualquer achado como P0. O status **P3** não foi necessário para os riscos encontrados.

## Proposta de correções separadas por sprint

- **FIN-INT-12 — Leituras de recebíveis:** exigir correspondência de empresa nas junções com `vendas` e nas consultas subsequentes de itens; avaliar o helper de cancelamento para que o estado de uma venda estrangeira não filtre CR. Corrigir o alias da PK no histórico de pagamentos e testar o endpoint. Definir explicitamente se detalhes/extrato devem incluir CR válido sem venda, hoje omitido pelo `JOIN` interno.
- **FIN-INT-13 — Escritas de recebíveis:** antes de aceitar pagamento parcial, cancelamento ou devolução, validar que a empresa da venda e a do recebível coincidem; selecionar e atualizar por `venda_id` **e** `empresa_id`; preservar rollback e cobrir relação cruzada com fixtures. Para pagamento parcial, formalizar se CR sem venda pode ser pago por esse fluxo.
- **FIN-INT-14 — Cálculos auxiliares de vendas:** escopar `verificarSaldoOutrosVenda` e outras agregações de CR à empresa proprietária da venda; comparar resultados com relações válidas e cruzadas em SQLite `:memory:`.

Essas propostas não foram implementadas. Nenhum pagamento, baixa, cancelamento, devolução, migração, backfill ou evento fiscal foi executado fora de dados descartáveis em memória. A auditoria encerra aqui e aguarda homologação do Tech Lead.
