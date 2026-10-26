# Sprint FIN-INT-07A — Auditoria da interface financeira e do contexto multiempresa

**Tipo:** auditoria técnica e funcional, somente leitura  
**Data:** 2026-10-26  
**Homologação:** aguardando Tech Lead

## 1. Resumo executivo

**Comprovado:** existe um seletor empresarial global na barra lateral do ERP. Ele lista empresas ativas vinculadas ao usuário, seleciona automaticamente a empresa marcada como matriz ou a primeira disponível quando ainda não há escolha e envia o contexto por `X-Empresa-Id`. O Financeiro exige contexto no frontend; no backend, as rotas financeiras resolvem e validam empresa e suas consultas ativas filtram os dados por empresa.

**Comprovado:** os relatórios comuns são consultas individuais para a empresa ativa; a tela não oferece visão consolidada de empresas. As fontes são `financeiro`, recebimentos de venda, `contas_receber` e/ou `contas_pagar` MCF conforme o relatório. A lista Contas a Pagar usada pela tela é MCF canônica.

**Comprovado:** “Dry-run histórico” é uma análise de reconciliação de **Contas a Pagar**. A rota chamada pela interface é GET, exige `role === 'admin'` e o serviço não contém SQL de escrita; “Vincular”, “Criar título” etc. são ações sugeridas, não ações executadas. Ainda assim, essa opção e seus indicadores técnicos estão no seletor de relatórios comum sem ocultação por perfil. Usuários sem admin recebem 403 ao executá-la.

**Achado P1:** a rota do dry-run também aceita `multiempresa=1` ou `todas_empresas=1`. Nesse caminho, o serviço carrega todas as empresas ativas, enquanto a autorização empresarial do middleware verifica apenas a empresa ativa da requisição. Não há, nesse caminho, filtragem das empresas resultantes pelos vínculos do usuário. O impacto depende de `admin` representar um privilégio global intencional; o código de vínculo empresarial, por si, é por usuário e empresa. O teste existente cobre admin vinculado a A e B e não prova o caso admin vinculado somente a A.

**Achado de completude:** há um caminho de venda a prazo em `MotorFinalizacaoVenda.js` que grava `empresa_id` no lançamento `financeiro`, mas omite `empresa_id` no `INSERT` em `contas_receber`. Como o relatório FIN-INT-05 filtra a fonte canônica por `cr.empresa_id`, essa linha canônica não entra na consulta; o espelho legado permanece elegível porque a regra de sobreposição também exige empresa correspondente. O recebível tende a continuar representado pelo legado, mas o saldo canônico e seus valores recebido/restante não ficam disponíveis por esse caminho.

Não houve alterações de produto. A evidência visual mencionada na solicitação não estava compartilhada nesta sessão; a conclusão é baseada em código, esquema e testes isolados.

## 2. Arquivos, funções, rotas e serviços inspecionados

- Interface: [`frontend/erp/js/financeiro-relatorios.js`](../../frontend/erp/js/financeiro-relatorios.js) — opções, filtros, requisições, tabelas, estados, indicadores de dry-run e tratamento de erro.
- Tela Financeiro: [`frontend/erp/pages/financeiro.html`](../../frontend/erp/pages/financeiro.html) — período global, abas e conteúdo do Financeiro.
- Shell ERP: [`frontend/erp/index.html`](../../frontend/erp/index.html) — sidebar e host global do seletor de empresa.
- Contexto de empresa frontend: [`frontend/shared/js/cds-empresa-contexto.js`](../../frontend/shared/js/cds-empresa-contexto.js) — lista/seleção de empresas, persistência e `headersAuth`.
- Inicialização frontend: [`frontend/shared/js/core.js`](../../frontend/shared/js/core.js) — inicializa o seletor global antes de carregar a página ERP.
- Orquestração Financeiro: [`frontend/erp/js/financeiro.js`](../../frontend/erp/js/financeiro.js) — exige empresa selecionada, navega abas e recarrega quando o contexto muda.
- Acesso alternativo ao dry-run: [`frontend/erp/js/financeiro-pagar.js`](../../frontend/erp/js/financeiro-pagar.js) — botão visível a administradores e resumo da resposta.
- Estilos: [`frontend/css/financeiro.css`](../../frontend/css/financeiro.css) e [`frontend/css/style.css`](../../frontend/css/style.css) — apresentação dos indicadores técnicos e seletor global.
- Rotas de relatório: [`backend/rotas/financeiro.js`](../../backend/rotas/financeiro.js) — resumo, recebimentos, fluxo e inadimplência.
- Rotas MCF: [`backend/rotas/contas_pagar.js`](../../backend/rotas/contas_pagar.js) — listagem MCF, dry-run e simulação, com autenticação de rota.
- Montagem/autenticação: [`backend/server.js`](../../backend/server.js) — monta `/api/financeiro`, `/api/contas-pagar` e `/api/empresas` sob autenticação.
- Contexto financeiro: [`backend/services/financeiro/FinanceiroEmpresaContextoService.js`](../../backend/services/financeiro/FinanceiroEmpresaContextoService.js) e [`backend/services/fiscalNaoFiscal/empresaContexto.js`](../../backend/services/fiscalNaoFiscal/empresaContexto.js).
- Permissões e seletor: [`backend/rotas/empresas.js`](../../backend/rotas/empresas.js), [`backend/services/empresas/EmpresaService.js`](../../backend/services/empresas/EmpresaService.js) e [`backend/services/empresas/UsuarioEmpresaService.js`](../../backend/services/empresas/UsuarioEmpresaService.js).
- Fonte MCF: [`backend/motores/mcf/services/ContasPagarService.js`](../../backend/motores/mcf/services/ContasPagarService.js) e [`backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService.js`](../../backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService.js).
- Exemplo de materialização com `empresa_id` ausente no CR: [`backend/services/entrega/MotorFinalizacaoVenda.js`](../../backend/services/entrega/MotorFinalizacaoVenda.js). Esquema: [`backend/database.js`](../../backend/database.js).
- Testes focados: [`tests/financeiro/contexto-empresarial-financeiro-p0.test.js`](../../tests/financeiro/contexto-empresarial-financeiro-p0.test.js), [`tests/financeiro/mcf-02.2-interface-dry-run.test.js`](../../tests/financeiro/mcf-02.2-interface-dry-run.test.js), [`tests/financeiro/fin-p1-2-consistencia.test.js`](../../tests/financeiro/fin-p1-2-consistencia.test.js), [`tests/financeiro/fin-int-05-relatorio-receber.test.js`](../../tests/financeiro/fin-int-05-relatorio-receber.test.js) e [`tests/financeiro/fin-int-06-frontend-contrato.test.js`](../../tests/financeiro/fin-int-06-frontend-contrato.test.js).

## 3. Inventário das informações técnicas expostas

| Elemento visível | Renderização e fonte | Significado funcional | Público/risco |
|---|---|---|---|
| “Dry-run histórico” e grupo “Reconciliação — somente leitura” | Opção `dry_run_historico` em `renderRelatoriosFinanceiros`; escolhe `gerarRelatorioDryRunHistorico` e chama `GET /api/contas-pagar/reconciliacao-historica/dry-run`. | Análise de lançamentos de despesa legados frente a títulos MCF; não é reconciliação executada. | O seletor comum não verifica perfil; servidor exige admin. Opção visível a não-admin resulta em erro 403. |
| “Candidatos” | `renderizarDryRunHistorico`; `totais_empresa.gerais.quantidade`. | Quantidade de lançamentos legados elegíveis analisados. | Métrica de diagnóstico, sem explicação ao usuário operacional. |
| “Valor conhecido” | `totais_empresa.gerais.valor_conhecido`; agregado de `valor_lancamento` disponível. | Soma dos valores dos lançamentos legados; não é saldo devedor verificável. O serviço mantém `saldo_conhecido: null` e `saldo_verificavel: false` para o legado. | O rótulo pode ser confundido com saldo/valor liquidável. |
| “Não verificável” | `valor_nao_verificavel_qtd`. | Contagem de itens cujo `valor_lancamento` é nulo/não finito. Não mede a quantidade de saldos de legado sem verificação. | Rótulo ambíguo: o código também informa saldo legado não verificável, mas a métrica exibida é de valor do lançamento ausente. |
| “Vincular”, “Criar título”, “Ignorar”, “Revisão manual” | `totais_empresa.por_acao`; tabela usa `acao_sugerida`, `confianca` e `justificativa`. | Classificação/recomendação do algoritmo para etapa futura, com possibilidade de revisão. Não dispara ações. | Verbos no infinitivo podem sugerir execução; o aviso “Dry-run · somente leitura” e “Nenhuma escrita foi executada” reduz, mas não elimina a ambiguidade. |
| “Projeções MCF excluídas” | `meta.projecoes_excluidas_do_universo`; serviço conta registros de projeção da empresa. | Quantidade excluída do universo de despesas legado analisado. | Detalhe técnico de reconciliação MCF, normalmente interno. |
| Tabela de candidatos | `itens`: IDs Financeiro/MCF, descrição, status legado, valor, ação sugerida, confiança e justificativa. | Evidência de matching; status legado não é usado para inferir quitação/saldo. | Pode expor identificadores, descrições e valores de despesas internas. A rota é admin-only; não é conteúdo apropriado para relatório operacional comum sem decisão de produto. |
| Empresa do dry-run e mensagens de contexto | Dry-run mostra `empresa_id`; o cabeçalho do relatório diz “Empresa do contexto ativo” e o cartão “Empresa ativa”, sem nome/CNPJ selecionado. | Identifica numericamente a empresa no dry-run; o cabeçalho geral identifica apenas contexto implícito. | O seletor global mostra nome/CNPJ, mas o relatório não repete o nome. Pode ser difícil confirmar o escopo quando o usuário olha somente o conteúdo. |
| Mensagens de estado | `mostrarEstadoRelatorio`; estado vazio, carregando e erro. | Diferencia carregamento, ausência de resultado e falha da requisição. | A opção dry-run disponível sem admin culmina em erro de permissão esperado, porém evitável na UI. |

**Público recomendado:** manter o dry-run somente como ferramenta de diagnóstico administrativo/operacional do MCF. Caso seja mantido, a localização mais coerente já existente é a ação administrativa em Contas a Pagar, sob a autorização atual, ou uma área interna MCF específica — não como opção comum de relatório.

## 4. Matriz de implementação multiempresa

| Camada | Estado comprovado | Limite/observação |
|---|---|---|
| Seletor global | Implementado na sidebar do ERP (`#cds-empresa-seletor`), reutilizável pelo módulo. Lista apenas empresas ativas com vínculo ativo do usuário; permite troca. | Não existe seletor empresarial dentro da tela de Relatórios. O texto no cabeçalho do relatório é genérico; a empresa real aparece no seletor global. |
| Seleção inicial | Se não há empresa persistida, o frontend seleciona a empresa marcada como matriz ou a primeira disponível; guarda ID/dados em `localStorage`. | A seleção inicial pode ocorrer sem uma escolha manual explícita do usuário. A evidência não demonstra qual empresa seria padrão em produção. |
| Requisições | `__headersFin()` usa `headersFinanceiro`/`CdsEmpresaContexto.headersAuth`; `X-Empresa-Id` só é incluído se houver contexto. Mudança dispara evento e o Financeiro recarrega a aba ativa. | A troca de empresa reinicializa a aba Relatórios; não preserva necessariamente relatório/filtros que estavam selecionados. |
| Navegação sem empresa | `financeiro.js` verifica `temEmpresaSelecionada()` e interrompe a renderização do conteúdo, exibindo aviso para selecionar a empresa. | O inicializador do seletor usa a mesma mensagem “Você não possui empresa disponível” tanto para lista vazia quanto para falha ao carregar a lista; não distingue indisponibilidade técnica de ausência de vínculo. |
| Resolução backend | `router.use(middlewareResolverEmpresaFinanceiro)` nas rotas Financeiro e Contas a Pagar. MULTIEMPRESA exige `X-Empresa-Id`, valida a empresa e o vínculo `usuario_empresas`; empresa sem autorização retorna erro. | Em `EMPRESA_SIMPLES`, o backend resolve empresa pelo contrato operacional; a UI Financeiro, por sua vez, exige seleção global local. Não foi verificado se há usuário/configuração real em que essa diferença impeça acesso. |
| SQL por empresa | Relatórios Financeiro usam `filtroEmpresaSql` ou `empresa_id = ?`; vendas recebidas usam `v.empresa_id`; Contas a Receber usa `cr.empresa_id`; MCF usa `cp.empresa_id`. | Consultas isolam as linhas base. Algumas junções por chave estrangeira não repetem a condição de empresa; dependem da integridade da relação. |
| Acesso não autorizado | O serviço de empresas valida vínculo ativo do usuário à empresa selecionada. Teste P0 confirma rejeição de empresa B para usuário vinculado somente a A. | O teste de acesso multiempresa do dry-run usa usuário admin vinculado às duas empresas; não cobre admin vinculado apenas à empresa do header. |
| Relatórios individuais | Todos os relatórios comuns usam a empresa do contexto. Não há seletor de empresa próprio no filtro de Relatórios. | O contexto automático/único não é uma visão consolidada. |
| Visão consolidada | Não existe nas opções comuns de Relatórios. Há caminho backend especial no dry-run, via `multiempresa=1`/`todas_empresas=1`. | Esse caminho soma métricas gerais e devolve relatório por empresa; não é usado pelo frontend comum. A autorização por empresa precisa de decisão/validação específica antes de ser considerada segura. |

### Evidência sobre isolamento e limite das junções

- P0 testa ausência de `X-Empresa-Id` no modo MULTIEMPRESA, alternância A/B, rejeição de empresa não autorizada e dados MCF filtrados por empresa.
- As consultas dos relatórios filtram os registros principais por empresa e não agregam os relatórios comuns de empresas distintas.
- No relatório receber, a consulta canônica usa `WHERE cr.empresa_id = ?`, mas `LEFT JOIN vendas v ON v.id = cr.venda_id` não acrescenta `v.empresa_id = cr.empresa_id`. O total e campos fiscais podem usar atributos da venda juntada. A implementação normal cria a conta a partir da venda; não foi encontrada evidência de ocorrência de relação cruzada, mas não há teste da relação malformada nem garantia composta no esquema. Assim, isolamento da linha-base está comprovado; isolamento de relações inconsistentes não está demonstrado.
- `MotorFinalizacaoVenda.js` escreve `empresa_id` no financeiro, porém não o inclui no insert de `contas_receber`. O esquema permite `empresa_id` nulo. O filtro canônico não retorna essa conta; o espelho legado pode permanecer elegível. Isso preserva a linha no cenário com espelho, mas deixa o relatório sem os campos canônicos de saldo/recebido para esse caminho.

## 5. Matriz de opções de relatório

| Opção | Endpoint consumido | Fontes e filtros relevantes | Empresa e leitura/escrita |
|---|---|---|---|
| Resumo financeiro | `GET /api/financeiro/relatorios/resumo` | Agrega `financeiro` por tipo/status; período por `data_movimento`. Complementa recebimentos de venda via `venda_recebimentos`/`vendas`, filtrados por data da venda e modo fiscal. | `filtroEmpresaSql` e `v.empresa_id`; GET somente leitura. |
| Fluxo financeiro | `GET /api/financeiro/relatorios/fluxo` | Agrega `financeiro` por dia/tipo; recebe também `venda_recebimentos`; período, modo fiscal, cancelamentos e projeções MCF excluídas. | `filtroEmpresaSql` e `v.empresa_id`; GET somente leitura. |
| Contas a Receber | `GET /api/financeiro/relatorios/receber` | Legado elegível em `financeiro` mais títulos `contas_receber`; filtros de período, status, cliente e modo fiscal; usa regra oficial para não duplicar espelho e exclui vendas canceladas. | Filtra empresa em ambas as fontes; GET somente leitura. O renderer preserva valores/totalizações anteriores; os campos aditivos de recebido/saldo não são apresentados, conforme FIN-INT-06. |
| Contas a Pagar (MCF) | `GET /api/contas-pagar` | `ContasPagarService.listar`; fonte `contas_pagar` canônica; período por vencimento, status e fornecedor. A interface adapta os nomes de campos para renderização. | `cp.empresa_id = ?`; GET somente leitura para este relatório. Ações de criação/baixa ficam fora do renderer do relatório. |
| Inadimplência | `GET /api/financeiro/relatorios/inadimplencia` | Junta legado `financeiro`, `contas_receber` aberto/parcial e `contas_pagar` aberto/parcial; calcula atraso e total em aberto. | Cada fonte usa empresa do contexto. GET somente leitura. O filtro de período usa `data_movimento` no legado e vencimento nas fontes canônicas; a semântica do mesmo filtro não é idêntica entre fontes. |
| Dry-run histórico | `GET /api/contas-pagar/reconciliacao-historica/dry-run` | Despesas legadas não projetadas/não vinculadas contra títulos MCF; exibe candidatos, matching e sugestões. A página envia filtros comuns, mas esse gerador não os inclui na URL; o serviço não usa período. | Rota exige admin; por padrão usa empresa ativa. Consulta apenas leitura. Flags de multiempresa acionam todas as empresas ativas no backend, mas não são enviadas pelo frontend. |

**Nota sobre rotas:** `GET /api/financeiro/relatorios/pagar` também existe no backend, mas o JavaScript atual chama `GET /api/contas-pagar`; a rota de relatório legado não é o consumidor desta tela. A simulação MCF também possui endpoint separado e não é chamada pelo seletor de Relatórios.

**Estado incompleto da interface:** o botão Exportar apenas exibe mensagem de que a exportação está em desenvolvimento; não há exportação de relatório implementada nessa tela.

## 6. Riscos e lacunas classificados

### P1 — Escopo multiempresa do dry-run não restringe a lista de empresas pelos vínculos do usuário

**Fatos comprovados:** o controlador exige `role === 'admin'`; a rota ainda passa pelo middleware de contexto empresarial, que valida a empresa selecionada. Com os parâmetros `multiempresa=1` ou `todas_empresas=1`, porém, o controlador chama o serviço com `empresaIds: null`; o serviço seleciona todas as empresas ativas e percorre cada uma. Essa execução não recebe usuário nem lista de empresas autorizadas. O modelo `UsuarioEmpresaService` é baseado em vínculo ativo por par usuário/empresa.

**Hipótese/impacto:** caso `role=admin` não seja uma autorização global formal para todas as empresas, um admin com vínculo somente à empresa do header pode obter dados de outras empresas ativas através desses parâmetros. O teste MCF-02.2 comprova isolamento em chamadas individuais e multiempresa com A/B autorizadas, mas não testa admin com vínculo só em A usando a flag. Nenhuma chamada com a flag foi executada nesta auditoria.

**Proposta:** homologar se o dry-run consolidado deve existir. Se sim, restringir a lista por uma autorização global explícita ou passar ao serviço somente os IDs permitidos; adicionar teste isolado para admin vinculado a A e empresa B ativa sem vínculo.

### P1 — Conta canônica sem `empresa_id` em um caminho de venda a prazo

**Fatos comprovados:** `MotorFinalizacaoVenda.js` resolve a empresa e a grava na linha de `financeiro`, mas não passa `empresa_id` no insert de `contas_receber`; o campo no esquema é nullable. O relatório canônico exige `cr.empresa_id = ?`, e o predicado de sobreposição requer mesma empresa.

**Impacto comprovado no fluxo de consulta:** essa linha não é devolvida como CR por empresa. Se o espelho legado estiver presente, ele não é excluído por falta de correspondência de empresa e permanece como a representação do recebível; nesse caso o saldo canônico não aparece na resposta.

**Limite:** não foi acessado banco para confirmar frequência nem existência de linhas produzidas por esse caminho. Não se alterou código de materialização.

**Proposta:** em Sprint separada, revisar a gravação de ownership em todos os caminhos, e decidir a política para legado `empresa_id` nulo sem relaxar filtros de isolamento.

### P2 — Ferramenta administrativa aparece no seletor de relatórios comum

**Fatos comprovados:** a opção Dry-run é sempre criada no HTML da tela, sem condição de perfil. O backend retorna 403 para não-admin. O botão alternativo em Contas a Pagar, ao contrário, é condicionado a `podeAdministrarFinanceiro()`.

**Risco:** usuários comuns veem uma ferramenta técnica, tentam executá-la e recebem erro de permissão; administradores veem valores, IDs, critérios e justificativas técnicos dentro de um relatório operacional.

**Proposta:** retirar o dry-run das opções comuns e mantê-lo, se aprovado, na ação/administração MCF já existente ou em ferramenta interna; explicitar que ações são sugestões.

### P2 — Indicadores do dry-run podem ser interpretados como saldo financeiro

**Fatos comprovados:** “Valor conhecido” soma `valor_lancamento`, e `valor_nao_verificavel_qtd` conta valores de lançamento ausentes. A classificação de status legado sempre deixa `saldo_conhecido` nulo e `saldo_verificavel` falso. A UI não explica essa diferença; “Não verificável” não especifica que se refere ao valor do lançamento.

**Proposta:** se a interface for mantida, renomear e explicar métricas como “Valor dos lançamentos disponível” e “Lançamentos sem valor”, separando-as da verificabilidade de saldo; titular a coluna “Ação sugerida”.

### P2 — A consulta canônica não valida a empresa da venda juntada

**Fato comprovado:** a linha-base `contas_receber` é filtrada por empresa, mas o join em `vendas` usa apenas `v.id = cr.venda_id`; atributos fiscais e código da venda vêm desse join.

**Hipótese/impacto:** uma relação cruzada ou inconsistente entre CR de uma empresa e venda de outra poderia preencher composição fiscal/código com dados da outra empresa. Os caminhos normais de criação inspecionados usam a venda para materializar o CR; não foi provada ocorrência de relação cruzada. O teste de isolamento usa relações coerentes.

**Proposta:** validar em Sprint técnica se `empresa_id` da venda é invariante garantida em todas as gravações e dados legados; se não, impor a mesma empresa na junção e testar uma referência cruzada em fixture isolada.

### P2 — Cabeçalho não identifica nominalmente a empresa e falha do seletor é indistinta de lista vazia

**Fatos comprovados:** a sidebar mostra nome/CNPJ da empresa selecionada, mas a área de relatório usa rótulos genéricos “Empresa do contexto ativo”/“Empresa ativa”. O inicializador do seletor converte falha na chamada de empresas disponíveis no mesmo estado visual usado para “nenhuma empresa disponível”.

**Proposta:** exibir nome/identificador da empresa no conteúdo do relatório e distinguir erro de carregamento de ausência de vínculos.

### P3 — Exportação não implementada

**Fato comprovado:** botão Exportar chama somente uma mensagem de funcionalidade em desenvolvimento.

**Proposta:** retirar/desabilitar até haver escopo e implementação de exportação.

## 7. Testes executados e resultados

Comando:

```text
node --test tests\financeiro\contexto-empresarial-financeiro-p0.test.js tests\financeiro\mcf-02.2-interface-dry-run.test.js tests\financeiro\fin-p1-2-consistencia.test.js tests\financeiro\fin-int-05-relatorio-receber.test.js tests\financeiro\fin-int-06-frontend-contrato.test.js
```

Resultado: **25/25 aprovados**. Foram usados testes focados existentes:

- P0: testes do contexto empresarial, seleção, ausência de header e isolamento A/B.
- MCF-02.2: SQLite `:memory:`, API dry-run admin/não-admin, isolamento A/B e verificação estática de ausência de SQL de escrita no serviço.
- P1.2: fixtures isoladas de consistência financeira.
- FIN-INT-05 e FIN-INT-06: SQLite `:memory:` e mocks de frontend, respectivamente.

Não foi executada suíte completa, Electron contra backend, consulta real, rota com flags multiempresa, reconciliação ou simulação.

## 8. Limitações e integridade

- Nenhuma captura ou página de browser foi compartilhada; não foi feita avaliação visual de runtime.
- Não foi usado banco original ou de cliente. Os testes executados usam SQLite `:memory:`/mocks conforme seus harnesses.
- Não houve migração, backfill, reconciliação, pagamento, criação/alteração/vínculo de título ou envio fiscal.
- As hipóteses sobre a política global de admin, frequência de registros canônicos sem empresa e relações cruzadas requerem validação de contrato ou fixtures adicionais aprovadas; nenhuma foi verificada em dados reais.
- Não houve alteração de frontend, backend, SQL, contrato ou configuração.

## 9. Próximas etapas propostas por escopo

1. **Autorização (P1):** decidir formalmente se admin é global; restringir o dry-run multiempresa por vínculos/permissão explícita e testar admin com acesso parcial.
2. **Ownership de recebíveis (P1):** corrigir em Sprint própria os caminhos de criação que omitem `empresa_id` e definir tratamento seguro para registros legados sem empresa.
3. **Interface comum (P2):** mover o dry-run para área administrativa MCF, clarificar métricas/sugestões, e apresentar o nome da empresa e erro de contexto adequadamente.
4. **Integridade de relações (P2):** comprovar invariante de empresa em vendas/CR; adicionar defesa de junção e teste cruzado se necessário.
5. **Exportação (P3):** só iniciar após definir formatos, dados e filtros exportáveis.
6. **Visão consolidada:** não implementar por inferência. Exige decisão explícita sobre permissões, empresas incluídas e significado dos totais.

**Status:** auditoria concluída; achados e propostas aguardam homologação do Tech Lead. Nenhuma correção ou Sprint subsequente foi iniciada.
