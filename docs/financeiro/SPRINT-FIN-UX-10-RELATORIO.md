# FIN-UX-10 — Cabeçalho único e visão multiempresa nas abas financeiras

## Resultado

Concluída a remoção do cabeçalho duplicado e habilitada a leitura consolidada nas abas Financeiras, sem tratar a opção “Todas as empresas” como uma empresa única. O backend usa a lista oficial de empresas autorizadas do usuário; os IDs enviados pelo frontend não ampliam esse escopo.

## Contratos e endpoints

Antes desta sprint, o seletor consolidado era funcional no Dashboard, mas as abas operacionais exibiam um bloqueio ou chamavam endpoints de empresa única. A sprint preservou os endpoints existentes de empresa única e adicionou rotas de leitura para o escopo consolidado. As respostas de linhas incluem identificação da empresa de origem (`empresa_id`, `empresa_nome` e, quando aplicável, `empresa_cnpj`); recebíveis também mantêm `fonte` e `chave` com empresa e fonte para evitar colisões de IDs.

| Aba | Endpoint no escopo “Todas” | Contrato e comportamento |
|---|---|---|
| Dashboard | `GET /api/financeiro/dashboard/multiempresa` | Endpoint consolidado já existente; permanece sem alteração nesta sprint. |
| Contas a Receber | `GET /api/financeiro/multiempresa/receber` | União das linhas legadas elegíveis e de `contas_receber`; exclui espelhos pela regra oficial, aplica os filtros existentes e identifica a origem e a empresa em cada linha. |
| Dívidas por Cliente | `GET /api/financeiro/multiempresa/dividas-cliente` | Agrega por cliente **e empresa**, preservando clientes de mesmo ID/nome em empresas diferentes como grupos distintos. Mantém filtros de cliente, status e vencimento. |
| Contas a Pagar | `GET /api/contas-pagar/multiempresa` | Consulta títulos canônicos MCF por empresa autorizada, agrega, ordena e aplica o limite global depois da agregação. Mantém filtros de fornecedor, status e período. |
| Condições de Pagamento | `GET /api/condicoes-pagamento?todas=1` | Catálogo compartilhado já existente, sem `empresa_id` e com unicidade global de nome; a interface agora explicita esse escopo. Não foram combinados catálogos independentes. |
| Histórico | `GET /api/financeiro/multiempresa/historico` | Mantém a semântica anterior de movimentos de `financeiro` e aplica período, tipo, status e busca em todas as empresas autorizadas. Cada linha identifica a empresa. Não acrescenta títulos canônicos que não pertencem ao contrato do Histórico. |
| Relatórios | `GET /api/financeiro/multiempresa/relatorios/resumo`, `/receber`, `/fluxo`, `/inadimplencia`; `GET /api/contas-pagar/multiempresa` para o relatório de pagar | Mantém filtros e modo fiscal existentes. O relatório de recebíveis evita espelhos, preserva composição fiscal e origem; Contas a Pagar usa MCF canônico, sem somar projeções como obrigações extras. |

As rotas consolidadas consultam as empresas com `UsuarioEmpresaService.listarEmpresasPermitidas(req.user)`. Nenhuma aceita uma lista arbitrária de empresas do cliente. Falhas em uma consulta consolidada são retornadas como erro, sem montar resposta parcial com aparência de sucesso.

## Escopo e ações

- O seletor global continua em “Todas as empresas” durante a navegação entre abas; cada aba inicia sua consulta consolidada sem alterar silenciosamente a empresa ativa.
- A lista de recebíveis mostra empresa em coluna própria; Dívidas por Cliente, Contas a Pagar, Histórico e relatórios também identificam a origem da linha.
- Ações sobre registros existentes usam a empresa identificada no próprio registro e enviam o contexto correspondente, que continua validado pelo backend.
- Criar uma nova despesa requer uma empresa específica. Em “Todas”, o formulário apresenta um seletor local de empresa proprietária; isso não altera o filtro global e a operação continua sujeita à autorização backend.
- “Ver financeiro da empresa” é uma navegação intencional para o escopo individual daquela empresa.
- O catálogo de Condições de Pagamento continua global, inclusive para operações de cadastro, pois seu esquema e contrato atuais não associam condições a uma empresa. A interface informa esse compartilhamento.
- “Nova Conta a Receber” permanece apenas como ação “Em desenvolvimento”; nenhum fluxo de escrita ou operação financeira foi introduzido nesta sprint.

## Arquivos alterados nesta sprint

- `backend/rotas/financeiro.js`
- `backend/rotas/contas_pagar.js`
- `frontend/erp/pages/financeiro.html`
- `frontend/erp/js/financeiro.js`
- `frontend/erp/js/financeiro-receber.js`
- `frontend/erp/js/financeiro-pagar.js`
- `frontend/erp/js/financeiro-historico.js`
- `frontend/erp/js/financeiro-relatorios.js`
- `frontend/erp/js/financeiro-condicoes.js`
- `tests/financeiro/fin-ux-08-electron-preview.js`
- `tests/financeiro/fin-ux-08-multiempresa.test.js`
- `tests/financeiro/fin-int-12-leituras-receber.test.js`
- `tests/financeiro/contexto-empresarial-financeiro-p0.test.js`
- `tests/financeiro/fin-p1-2-consistencia.test.js`

## Testes e verificações

- `node --test --test-concurrency=1` sobre FIN-UX-08, FIN-INT-12, FIN-INT-13, FIN-P1.2, contexto empresarial P0 e MCF-01: **45 testes aprovados, 0 falhas**.
- Testes SQLite `:memory:` adicionais cobrem união e identidade dos recebíveis, filtros por cliente/período/status, isolamento por empresa autorizada, Contas a Pagar consolidado ignorando IDs empresariais enviados pelo cliente, e erro do Histórico sem retorno parcial.
- Preview Electron com dados exclusivamente sintéticos: **aprovado**. Verificou cabeçalho único, seleção “Todas” mantida na navegação, leitura e identificação da empresa em Contas a Receber, Dívidas por Cliente, Contas a Pagar e Histórico, roteamento de Relatórios e seleção de empresa local para nova despesa sem mudar o escopo global.
- Capturas em viewports CSS de 1440, 1024 e 768 px: sem overflow horizontal; os checks do Dashboard mantiveram cinco indicadores e dois gráficos lado a lado em 1440 px.
- `node --check` nos arquivos JavaScript de backend, frontend e testes alterados: **aprovado**.

## Evidências visuais

As capturas usam o harness Electron com dados sintéticos. A comparação antes/depois mostra a remoção do cabeçalho injetado antigo e a preservação do cabeçalho “Gestão Financeira”, filtros e abas:

- Antes: [1440 px](./SPRINT-FIN-UX-10-ANTES-1440.png), [1024 px](./SPRINT-FIN-UX-10-ANTES-1024.png), [768 px](./SPRINT-FIN-UX-10-ANTES-768.png)
- Depois: [1440 px](./SPRINT-FIN-UX-10-DEPOIS-1440.png), [1024 px](./SPRINT-FIN-UX-10-DEPOIS-1024.png), [768 px](./SPRINT-FIN-UX-10-DEPOIS-768.png)

## Limitações e itens não verificados

- A lista de Contas a Pagar mantém o limite do serviço (100 por padrão, até 500); a interface preexistente não oferece paginação. Não foi criada paginação nesta sprint.
- Condições de Pagamento continua sendo um cadastro compartilhado, sem separação ou unicidade por empresa, conforme o esquema/contrato atual.
- A tela de Contas a Receber ainda não implementa a criação de novos títulos; a sprint não ampliou esse fluxo.
- A captura registra o Dashboard e o cabeçalho comum; a navegação e os conteúdos das abas foram validados no mesmo preview, mas não foram geradas capturas individuais de cada aba.

Nenhum endpoint preexistente de empresa única foi removido ou teve sua semântica financeira alterada. Não foram executadas migrações, backfills, pagamentos, baixas, cancelamentos, devoluções ou operações fiscais.

## Segurança e dados

Todos os testes com dados foram executados em SQLite `:memory:` ou no harness Electron com fixtures sintéticas. Nenhum banco oficial ou de cliente foi acessado ou alterado, e nenhuma operação financeira real foi executada.

**FIN-UX-10 concluída; aguardando homologação do Tech Lead. Nenhuma outra sprint foi iniciada.**
