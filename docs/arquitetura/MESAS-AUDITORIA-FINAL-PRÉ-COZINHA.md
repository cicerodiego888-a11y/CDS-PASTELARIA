# Auditoria final do módulo de Mesas — pré-Cozinha

## Conclusão executiva

**Classificação geral: B. APROVADO COM PENDÊNCIAS NÃO BLOQUEANTES para iniciar o desenho e a integração técnica da Cozinha.**

O fluxo atual cobre cadastro e ocupação de mesas, atendimento, pedidos vinculados, transferência, registro local de preparação, faturamento individual/consolidado e liberação após quitação. A consulta somente de leitura ao banco indicado não encontrou registros órfãos ou duplicidades nas relações auditadas. A consolidação encontrada está vinculada a dois pedidos faturados, venda com estado canônico `concluida`, pagamento `quitada`, operação `PDV_COMPOSICAO` `FINALIZADA` e atendimento encerrado.

Esta aprovação é para começar a integração técnica, **não** é homologação operacional nem liberação de produção. Nenhuma tela foi percorrida em sessão autenticada. As suítes de MESAS-02/03/04 apresentam falhas de fixture/inicialização que precisam ser corrigidas para que a regressão do ciclo de atendimento seja confiável. A futura integração também precisa definir entrega, confirmação e estados da Cozinha; hoje o ERP só grava preparação localmente.

Nenhum código funcional ou dado foi alterado nesta auditoria. Os testes usaram o isolamento temporário já definido pelas próprias suítes. As consultas ao banco indicado foram exclusivamente `READONLY`/`query_only`.

## 1. Arquitetura encontrada

| Etapa | Componentes principais | Responsabilidade |
|---|---|---|
| Cadastro/configuração | `backend/services/pedido/MesaService.js`; `backend/rotas/mesas.js` | Cadastro, empresa, número único e ativação lógica da mesa. |
| Atendimento | `backend/services/pedido/MesaAtendimentoService.js`; `backend/utils/mesasSchema.js` | Abrir, consultar, transferir e encerrar atendimento; validar empresa e estados. |
| Criação e consulta de pedidos | `backend/services/pedido/PedidoOperacionalService.js`; `backend/services/pedido/PedidoRepository.js`; `backend/rotas/pedidos.js` | Criar pedido, associá-lo ao atendimento e listar pedidos vigentes. |
| Preparação local | `backend/services/pedido/PedidoPreparacaoService.js`; `backend/services/pedido/preparacaoLimites.js` | Registrar envio/conclusão no ERP e calcular tempo/classificação. |
| Interface de salão | `frontend/erp/js/mesas-painel.js`; `mesas-lancamento.js`; `mesas-conferencia.js`; `mesas-venda-consolidada.js`; `pedidos.js` | Grade, abertura, consulta/edição, transferência, preparação e seleção para consolidação. |
| Fechamento individual | `backend/services/faturamento/FaturamentoService.js`; `PedidoFaturamentoOperacaoRepository.js`; `frontend/pdv/js/pdv.js` | Compor e finalizar uma venda para um pedido e confirmar a operação do PDV. |
| Fechamento consolidado | `backend/services/vendas/VendaConsolidadaMesaService.js`; rota em `backend/rotas/pedidos.js`; `frontend/pdv/js/pdv.js` | Reservar a seleção, criar uma venda pelo núcleo oficial, vincular todos os pedidos e recuperar operações idempotentes. |
| Venda, pagamento e estoque | `backend/services/vendas/VendaApplicationService.js`; `VendaPagamentoService.js` e serviços oficiais já existentes | Persistir venda/pagamento e executar as regras oficiais de estoque e classificação F×NF. |

### Persistência principal

- `mesas`: cadastro por empresa, número e ativação.
- `mesa_atendimentos`: mesa, empresa, estado, cliente, operadores, horários e chave de idempotência.
- `mesa_atendimento_transferencias`: histórico de origem/destino e operador.
- `pedidos` / `pedidos_itens`: pedido comercial, mesa, atendimento, itens, quantidades, preços e observações.
- `pedido_preparacoes`: estado e horários de preparação por pedido.
- `pedido_faturamento_operacoes`: operação individual/consolidada, venda, estado e tipo `PDV_COMPOSICAO`.
- `venda_consolidacoes`, `venda_consolidacao_pedidos`, `venda_consolidacao_itens` e `venda_consolidacao_chaves`: reserva, participantes, snapshot dos itens e idempotência da venda consolidada.
- `vendas` e `venda_pagamentos`: venda e pagamento no núcleo oficial.

O esquema implementa índices únicos e `CHECK`s relevantes, mas não declara chaves estrangeiras entre todas as tabelas de mesa/pedido/preparação. A integridade relacional depende também das transações e validações da aplicação.

## 2. Ciclo da mesa auditado

1. **Mesa livre e abertura:** o atendimento é aberto no servidor; a empresa vem do contexto autenticado e o operador da sessão. A unicidade de atendimento ativo é protegida por índice parcial e transação `BEGIN IMMEDIATE`.
2. **Primeiro e pedidos adicionais:** pedido novo exige atendimento `OCUPADA`; o servidor grava `mesa_id` e `mesa_atendimento_id`. A criação não deve abrir atendimento implicitamente nem enviar preparação automaticamente.
3. **Consulta de pedidos:** a tela consulta o atendimento atual e filtra os pedidos por empresa, mesa, atendimento e estados elegíveis. O acesso a pedido existente usa o identificador devolvido pelo servidor; não cria cópia.
4. **Transferência:** atualiza a mesa do mesmo atendimento e grava histórico na mesma transação. Não recria o atendimento nem reescreve o `mesa_id` histórico dos pedidos; a ocupação atual é determinada pelo atendimento.
5. **Operações inválidas:** mesa inativa/inexistente, empresa divergente, atendimento encerrado/em fechamento, destino ocupado e reutilização divergente de chave são bloqueados nos contratos da aplicação.
6. **Preparação:** salvar pedido não inicia relógio. O envio é explícito e registra `NAO_ENVIADO`, `EM_PREPARACAO` ou `CONCLUIDO`, com horário do servidor e repetição idempotente.
7. **Faturamento individual:** o PDV prepara/finaliza a operação do pedido e vincula a venda. A mesa não é liberada apenas porque o pedido recebeu estado `FATURADO`.
8. **Faturamento consolidado:** a seleção deve pertencer à mesma mesa/atendimento; os preços e itens vêm do pedido persistido. A reserva e o vínculo são idempotentes; venda e pagamento continuam no núcleo oficial e uma venda vincula todos os participantes.
9. **Encerramento/liberação:** o atendimento só é encerrado quando os pedidos estão resolvidos e, para pedidos faturados, a venda tem `vendas.status = concluida`, pagamento `quitada` e operação `PDV_COMPOSICAO` `FINALIZADA`. Atendimento encerrado libera a mesa.

Referências de implementação: [MesaAtendimentoService.js](../../backend/services/pedido/MesaAtendimentoService.js:110), [PedidoPreparacaoService.js](../../backend/services/pedido/PedidoPreparacaoService.js:197), [VendaConsolidadaMesaService.js](../../backend/services/vendas/VendaConsolidadaMesaService.js:523), [FaturamentoService.js](../../backend/services/faturamento/FaturamentoService.js) e [mesasSchema.js](../../backend/utils/mesasSchema.js:24).

## 3. Auditoria do PDV

- O pedido individual conserva seu vínculo simples com uma venda. A consolidação usa tabelas de associação próprias, sem fingir que uma venda pertence a um único pedido.
- A composição consolidada usa itens, quantidades, observações e preços persistidos no pedido; não depende do preço atual do cadastro.
- Reserva, venda persistida e vínculo são etapas distintas. O identificador da consolidação/venda e a chave estável permitem recuperar a operação; não se deve criar outra venda quando a resposta se perde.
- A idempotência mantém o bloqueio para mesma chave com conteúdo divergente e para pedido já reservado por operação incompatível.
- A baixa de estoque e a classificação F×NF permanecem no fluxo oficial da venda única. Esta auditoria não alterou nem reproduziu pagamento, TEF, estoque ou documento fiscal real.
- O fechamento individual e o consolidado precisam continuar testados contra estados pendente/recusado/quitado; a mesa só é liberada pela operação concluída e pelo pagamento quitado.

Referências: [VendaConsolidadaMesaService.js](../../backend/services/vendas/VendaConsolidadaMesaService.js), [PedidoFaturamentoOperacaoRepository.js](../../backend/services/faturamento/PedidoFaturamentoOperacaoRepository.js) e [pdv.js](../../frontend/pdv/js/pdv.js).

## 4. Integridade dos dados de desenvolvimento

O usuário indicou `C:\ProgramData\MercantilFiscal\dados\mercadao.db` para esta auditoria. O código do repositório usa esse diretório como fallback padrão e o guardião SQLite o classifica como caminho protegido; por isso, a inspeção foi feita diretamente em modo `READONLY` com `PRAGMA query_only=ON`, sem iniciar `npm start`. Foram exibidas somente contagens e estados agregados, sem nomes de clientes, itens ou linhas identificáveis.

Resultados da leitura:

| Verificação | Resultado |
|---|---:|
| `PRAGMA integrity_check` | `ok` |
| Mesas / mesas ativas | 6 / 6 |
| Atendimentos por estado | 4 `ENCERRADO`, 1 `OCUPADA` |
| Atendimentos ativos duplicados por empresa/mesa | 0 |
| Atendimento ativo sem mesa ativa da mesma empresa | 0 |
| Pedidos com `mesa_atendimento_id` ausente ou de outra empresa | 0 |
| Pedidos legados com `mesa_id` e sem atendimento | 5 |
| Pedido aberto associado a atendimento encerrado | 0 |
| Preparações por estado | 4 `EM_PREPARACAO`, 2 `NAO_ENVIADO` |
| Preparação sem pedido/empresa correspondente; preparação duplicada por pedido | 0 / 0 |
| Associação de consolidação órfã ou com empresa divergente | 0 |
| Pedido em mais de uma consolidação | 0 |
| Consolidação `VINCULADA` com venda divergente dos participantes | 0 |

Os cinco pedidos sem atendimento são registros legados com `mesa_id`; o código/documentação preservam esse legado e não os convertem automaticamente. Não foram considerados órfãos.

A única consolidação encontrada tem dois pedidos `FATURADO`, ambos vinculados à mesma venda, operação `PDV_COMPOSICAO` `FINALIZADA`, atendimento `ENCERRADO`, pagamento `quitada` e `vendas.status = concluida`. A coluna separada `vendas.status_venda` aparece como `aberta`; o serviço de encerramento e o de consolidação validam `vendas.status`, não essa coluna. Portanto, o estado canônico necessário ao encerramento está satisfeito; a semântica dessa coluna separada deve ser confirmada antes de usá-la como estado para a Cozinha.

Não houve escrita nem correção automática de dados.

## 5. Interface e homologação visual

O painel oferece estados `LIVRE`, `OCUPADA` e `FECHAMENTO`, abertura de atendimento, consulta do cliente/pedidos, transferência e acesso a pedidos existentes. A grade não exibe toda a situação de preparação; tempo/classificação dependem do detalhe do pedido. A consulta é baseada nos contratos do servidor, não numa soma local da conta.

A inspeção estática encontrou ações para lançamento, conferência, lista de pedidos e fechamento consolidado. Não foi possível confirmar foco, responsividade, navegação real, mensagens, estados após falha ou comportamento em uso concorrente numa sessão visual autenticada.

As páginas compartilhadas do navegador estavam na tela de login e registraram `ERR_CONNECTION_REFUSED`; não havia servidor atendendo a porta. `npm start` não foi iniciado porque cria diretórios, abre/cria o banco e executa inicialização/migrações. Assim, **nenhuma funcionalidade visual está classificada como HOMOLOGADO**.

## 6. Preparação para a Cozinha

### O que pode ser reutilizado

- `pedido_id`, `mesa_id`, `mesa_atendimento_id` e `empresa_id` identificam pedido e contexto de salão.
- `pedidos_itens` preserva produto, quantidade, preço e dados/observações do item.
- `pedido_preparacoes` registra envio/conclusão, horários, operador e chaves idempotentes.
- Consulta por mesa/atendimento já alimenta a interface do ERP; limites de tempo são calculados no backend.
- A transferência preserva o mesmo atendimento, portanto a Cozinha deve consultar a mesa atual do atendimento, não inferi-la do `pedidos.mesa_id` histórico.

### O que ainda precisa ser definido/implementado fora do escopo desta auditoria

- Evento/outbox ou fila durável para entrega do pedido à Cozinha; hoje o “envio” é somente um registro local do ERP.
- Confirmação de recebimento, rejeição/falha e reprocessamento idempotente ponta a ponta.
- Estados de produção distintos, por exemplo recebido, em preparo, pronto, cancelado e entrega parcial; os estados atuais não representam todos esses eventos.
- Roteamento por setor de produção e política para itens que pertençam a mais de um setor.
- Regras para alteração/cancelamento após envio, histórico de eventos, ordenação e reconciliação após indisponibilidade.
- Interface/KDS e atualização sincronizada sem depender de polling de uma tela de salão.
- Contrato de permissão, empresa, atendimento, observações e identificadores entre ERP, PDV e Cozinha.

`EM_PREPARACAO` e `CONCLUIDO` não significam que uma cozinha, impressora ou KDS recebeu o pedido.

## 7. Testes e resultados

### Execução abrangente

Executado com `CDS_TEST_ISOLATION=1`, `CDS_BLOQUEAR_BANCO_OFICIAL=1` e `node --test --test-concurrency=1`, incluindo:

- MESAS-05, 05.1, 05.2, 05.2.1, 05.2.2 e 05.3;
- MESAS-02, 03 e 04;
- PDV Mobile 02 a 08;
- faturamento de pedidos Sprint 3.2, 3.5 e 3.6;
- regressões `mesas-pedido-operacional` e `entrada-pedido-central`.

**Resultado do lote: 198 testes, 173 passaram e 25 falharam.** As suítes de interface MESAS-05 a 05.3 e PDV Mobile 02 a 08 não apresentaram falhas nesse lote. MESAS-02/03/04 foram repetidas em processos separados, sequencialmente:

| Suíte | Resultado isolado | Diagnóstico |
|---|---:|---|
| `tests/pedidos/mesas-02-atendimento.test.js` | 2/9 | 7 casos falham porque a fixture em memória não cria `clientes`, tabela consultada pelo serviço. |
| `tests/pedidos/mesas-03-transferencia.test.js` | 1/11 | 10 casos falham pela mesma ausência de `clientes` na fixture. |
| `tests/pedidos/mesas-04-vinculo-preparacao.test.js` | 5/9 | 4 casos encontram `clientes` ainda não criada durante a inicialização assíncrona de `backend/database.js`; a tabela aparece nos logs depois das falhas. |
| `tests/faturamento/sprint32-pedido-consumido-integracao.test.js` | 25/26 | O caso restante é venda avulsa S313 sem saldo suficiente (`Disponível: 8`); não percorre o fechamento de mesa. |
| `tests/faturamento/sprint35-pedidos-ui.test.js` | 4/5 | Uma asserção estática exige um ramo antigo literal para `pedidos`; o catálogo atual declara o recurso no item de navegação. O teste precisa ser atualizado para validar o contrato atual. |
| `tests/faturamento/sprint36-pedidos-ux.test.js` | passou no lote | Regressão de UX sem falha reportada. |
| `tests/pedidos/mesas-pedido-operacional.test.js` e `entrada-pedido-central.test.js` | bloqueadas | Carregam `backend/database` sem `DB_DIR`; o guardião bloqueou fallback para ProgramData. Nenhum acesso adicional foi liberado nem tentado. |

As falhas de MESAS-02/03/04 são problemas comprovados nas fixtures/ordem de inicialização dos testes, não evidência suficiente de defeito funcional em produção. A ausência de `clientes` impede que os casos exercitem a lógica pretendida. Não foram mascaradas nem corrigidas nesta sprint.

O uso de bancos temporários ocorreu apenas porque as suítes de integração criam fixtures mutáveis por teste; todas as gravações ocorreram nos diretórios temporários próprios dos testes. A verificação dos dados existentes foi separada e somente de leitura.

## 8. Problemas, riscos e limitações conhecidos

1. **Cobertura de backend não confiável em MESAS-02/03/04 até corrigir as fixtures.** Criar `clientes` explicitamente nas bases em memória e aguardar a inicialização completa antes dos testes que importam `backend/database`.
2. **Homologação visual pendente.** O servidor estava indisponível e não havia sessão autenticada; automação não substitui esse teste.
3. **Sem entrega real à Cozinha.** O envio atual só persiste estado/horário no ERP.
4. **Integridade relacional baseada na aplicação.** Não há foreign keys declaradas para todas as relações; manter validação transacional e avaliar restrições em migração futura.
5. **Chaves de idempotência globais em alguns índices.** O código detecta conteúdo divergente, mas a unicidade física não inclui sempre `empresa_id`; avaliar escopo composto antes de expor novos produtores de eventos.
6. **Estado de preparação incompleto para produção real.** Não existem estados explícitos de rejeição, cancelamento e entrega parcial.
7. **Testes auxiliares bloqueados pelo guardião.** `mesas-pedido-operacional` e `entrada-pedido-central` precisam receber banco isolado em seus harnesses; não se deve liberar o banco oficial para fazê-los passar.
8. **O teste Sprint 3.5 contém critério textual legado** e deve ser revisto sem alterar o controle de acesso para satisfazer uma regex antiga.

## 9. Recomendações

1. Antes de integrar eventos, corrigir os harnesses MESAS-02/03/04 para montar schema completo e aguardar `whenReady`; manter `--test-concurrency=1`.
2. Executar homologação visual autenticada do ciclo inteiro: abrir mesa, lançar dois pedidos, consultar/conferir, transferir, enviar à preparação, faturar individual e consolidado, pagar e confirmar a liberação.
3. Para a Cozinha, definir contrato de evento/outbox, ACK, idempotência, retry, cancelamento/alteração, setor de produção e entrega parcial antes de conectar qualquer consumidor.
4. Usar `mesa_atendimento_id` como contexto estável e consultar a mesa atual do atendimento após transferência; não usar o `mesa_id` histórico do pedido como estado atual.
5. Preservar os bloqueios de empresa, estoque, F×NF e estado comercial; não criar lógica paralela de venda ou pagamento na Cozinha.
6. Reavaliar índices idempotentes e constraints relacionais com migração aditiva e testes de concorrência. Não reparar os dados de desenvolvimento automaticamente.
7. Atualizar os testes auxiliares e o critério legado da Sprint 3.5, depois repetir as suítes individualmente.

## 10. Classificação final

| Funcionalidade | Classificação | Evidência/pendência |
|---|---|---|
| Cadastro e estados das mesas | TESTADO | Contratos e schema auditados; seis mesas ativas no banco consultado. |
| Abertura, isolamento e idempotência do atendimento | TESTADO | Validações/indexes verificados; sem atendimento ativo duplicado nos dados. Regressão MESAS-02 precisa de fixture corrigida. |
| Criação e consulta de pedidos existentes | TESTADO | Suítes MESAS-05/05.1/05.2.2 passaram; cinco pedidos legados permanecem sem conversão automática. |
| Transferência | PENDENTE | Transação e histórico auditados; suíte MESAS-03 não exercita o fluxo por falta de `clientes` na fixture. |
| Registro local de preparação | PENDENTE | Modelo/rotas auditados e dados sem órfãos; suíte MESAS-04 tem corrida de inicialização. |
| Fechamento individual pelo PDV | TESTADO | Fluxo existente no faturamento; sem pagamento real nem homologação visual nesta auditoria. |
| Fechamento consolidado e vínculo | TESTADO | MESAS-05.3 passou; dados existentes mostram uma consolidação válida de dois pedidos. |
| Encerramento/liberação após quitação | TESTADO | Invariante conferida no código e no agregado de dados; sem pedido aberto em atendimento encerrado. |
| Interface de mesas e Pedidos | PENDENTE | Testes automatizados passaram; visual não foi homologado em navegador autenticado. |
| Integração real com Cozinha/KDS/impressora | PENDENTE | Fora do escopo atual; falta contrato de entrega e confirmação. |

**Decisão:** **B. APROVADO COM PENDÊNCIAS NÃO BLOQUEANTES** para iniciar o desenho e a implementação da integração com a Cozinha. A integração operacional e qualquer homologação do fluxo completo dependem de corrigir os harnesses MESAS-02/03/04, executar a caminhada visual autenticada e definir os contratos de produção acima. Nenhum teste automatizado foi tratado como homologação visual.
