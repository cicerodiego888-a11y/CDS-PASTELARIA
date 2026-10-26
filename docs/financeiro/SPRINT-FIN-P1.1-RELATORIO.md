# Sprint FIN-P1.1 — Auditoria de indicadores e superfícies financeiras

**Status:** relatório de auditoria de código; não representa aprovação funcional da Sprint FIN-P1.1.  
**Data da inspeção:** 25/10/2026.  
**Escopo:** fontes e cálculos de Dashboard, Resumo, Histórico, Contas a Pagar, Contas a Receber e Relatórios; filtros de data; vendas canceladas; pagamentos parciais; projeções MCF; isolamento multiempresa; renderização do Histórico.  
**Limites respeitados:** nenhum código de produção nem banco/dado persistente ou operacional foi alterado; nenhum backfill foi executado; o matching MBC não foi modificado. Os testes usaram SQLite em memória e diretório temporário.

## 1. Como interpretar este relatório

- **Implementado/observado:** comportamento presente no código inspecionado, sem implicar que todos os caminhos estejam consistentes.
- **Testado nesta execução:** somente os comandos e resultados registrados na seção 7.
- **Pendente/não comprovado:** não houve teste ou consulta de dados que permita afirmar o resultado em runtime.
- As divergências abaixo são **divergências de fonte ou regra comprovadas pelo código**. Não foram calculadas diferenças monetárias contra uma base operacional.

O arquivo específico de relatório FIN-P1.1 não existia no inventário de `docs/financeiro/`; este documento o cria. Foram consultados os relatórios MCF-01 e MCF-02.4/02.5. As evidências de ensaio pré-migração descritas nesses documentos pertencem aos respectivos escopos isolados e não são tratadas aqui como validação dos indicadores FIN-P1.1.

## 2. Mapa de fontes por superfície

| Superfície | Consumidor e fonte observada | Regras encontradas | Divergência ou limite |
|---|---|---|---|
| Dashboard geral | `GET /api/dashboard/resumo`, em `backend/rotas/dashboard.js`; vendas consultadas em `vendas`/`vendas_itens`, recebíveis em `contas_receber` e `financeiro`, Contas a Pagar em `contas_pagar`. | Vendas excluem canceladas com `FILTRO_VENDA_VALIDA`; recebíveis excluem vendas canceladas em ambas as consultas; AP soma `valor_restante` de títulos MCF abertos/parciais. | O indicador de recebíveis soma duas fontes independentes. O código não prova que não exista sobreposição entre títulos de `contas_receber` e pendências de `financeiro`; não foi feita reconciliação de dados. |
| Dashboard do Financeiro | `GET /api/financeiro/dashboard`, consumido por `frontend/erp/js/financeiro-dashboard.js`; usa `financeiro`, `contas_pagar` e `contas_pagar_pagamentos`. | Exclui projeções MCF das consultas do legado. Total pago adiciona pagamentos MCF por `data_pagamento`; saldo AP aberto usa `valor_restante` MCF. Próximos pagamentos e alertas AP também vêm do MCF. | Recebíveis, próximos recebimentos, alertas e gráfico continuam usando `financeiro`, não `contas_receber`. As consultas de pendências/alertas do Financeiro não aplicam os helpers de exclusão de venda cancelada que existem em outras rotas. |
| Resumo financeiro | `GET /api/financeiro/resumo`, em `backend/rotas/financeiro.js`, lê `financeiro`. | Exclui projeções MCF e linhas ligadas a venda cancelada. Calcula recebidos/pagos somente pelos status `recebido`/`pago`; pendências somente por status exatamente `pendente`. | Não consulta `contas_pagar` nem pagamentos MCF. Títulos MCF e status `parcial` não compõem os campos correspondentes deste resumo. |
| Resumo dos Relatórios | `GET /api/financeiro/relatorios/resumo`; agrega `financeiro` e retorna `venda_recebimentos` separadamente. | Exclui projeções MCF. Filtra datas por `data_movimento`. Soma por status e entrega separadamente recebimentos fiscais/não fiscais. | Não inclui contas ou pagamentos MCF. O agrupamento classifica como pendente todo status diferente de `recebido` para receita e de `pago` para despesa, inclusive status de cancelamento se ainda estiverem presentes nas linhas selecionadas. |
| Histórico Financeiro | `GET /api/financeiro`, consumido por `frontend/erp/js/financeiro-historico.js`; consulta lançamentos de `financeiro`. | Filtra por empresa, data de movimento, tipo, status e busca; exclui projeções de compatibilidade MCF. | A consulta não aplica `sqlExcluirFinanceiroVendaCancelada`, ao contrário de Resumo e Contas a Receber. Assim, linhas relacionadas a venda cancelada não são excluídas por essa consulta de Histórico. A interface também insere campos retornados pela API em HTML sem escape. |
| Contas a Pagar — operação | `frontend/erp/js/financeiro-pagar.js` chama `/api/contas-pagar`; fonte operacional `contas_pagar`, pagamentos em `contas_pagar_pagamentos`. | Lista saldo restante e original; paga títulos abertos/parciais; criação parcelada usa lote idempotente; cancelamento é operação própria. | As rotas legadas `/api/financeiro/pagar`, `/api/financeiro/contas-pagar` e `/api/financeiro/relatorios/pagar` continuam existindo e leem `financeiro`, excluindo as projeções MCF. Consumidores externos à tela migrada podem, portanto, consultar somente o legado. |
| Contas a Receber — operação | `frontend/erp/js/financeiro-receber.js` consulta `/api/financeiro/receber`; `buildReceberQueryFilters` lê `financeiro`. Telas agrupadas e pagamentos parciais consultam `contas_receber` e `contas_receber_pagamentos`. | A baixa agrupada/parcial atualiza saldo/status em `contas_receber`, grava pagamento e mantém um lançamento correspondente em `financeiro`; filtros da listagem excluem vendas canceladas. | A tela de listagem simples lê o ledger, enquanto agrupamento e histórico de pagamento usam tabelas CR. Não há comprovação aqui de equivalência em todas as linhas e estados. A compatibilidade precisa ser tratada como projeção/integração, não como duas entradas recebidas. |
| Relatório de Contas a Receber | `GET /api/financeiro/relatorios/receber`, no frontend `financeiro-relatorios.js`; lê `financeiro` com join de `vendas`. | Exclui vendas canceladas, calcula apresentação fiscal/não fiscal a partir de campos da venda e filtra por vencimento ou data de movimento. | Não lê diretamente `contas_receber` nem seu saldo restante; valores/status são derivados do lançamento financeiro. |
| Relatório de Contas a Pagar | A tela atual chama `/api/contas-pagar` e adapta títulos MCF para o componente de relatório. | Consulta fonte MCF; o intervalo é passado à API e aplicado sobre vencimento. | O endpoint legado `/api/financeiro/relatorios/pagar` segue disponível e não representa a fonte canônica MCF. |
| Fluxo e inadimplência | `/api/financeiro/relatorios/fluxo` e `/api/financeiro/relatorios/inadimplencia` usam `financeiro`. | Fluxo separa valores do ledger de recebimentos de venda; inadimplência usa vencimento para atraso e data de movimento no filtro do intervalo. | Fluxo exclui projeções MCF, mas não agrega pagamentos MCF. Inadimplência não exclui projeções MCF nem aplica os filtros de venda cancelada usados em outras consultas. |

## 3. Divergências comprovadas e causas-raiz

### 3.1 Indicadores com diferentes fontes canônicas

1. **AP não é uniforme em todas as superfícies.** A tela atual, o relatório atual, o Dashboard Financeiro e o Dashboard geral usam `contas_pagar`; Resumo, Relatórios de Resumo/Fluxo/Inadimplência e endpoints legados ainda usam `financeiro`, às vezes excluindo projeções MCF.  
   **Causa-raiz:** migração gradual, com consultas próprias por endpoint e sem uma camada única de leitura de indicadores.

2. **Recebíveis têm leituras concorrentes.** Há telas/fluxos que leem `financeiro` e outros que leem `contas_receber` e `contas_receber_pagamentos`. O Dashboard geral soma pendências dos dois domínios.  
   **Causa-raiz:** coexistência do ledger legado e do domínio de títulos/parcelas; não foi executado batimento de registros para provar ausência de sobreposição.

3. **Recebimentos de venda têm representações distintas.** O Financeiro registra baixas na movimentação e nas parcelas CR; o Resumo de Relatórios expõe `venda_recebimentos` em um bloco próprio; outras somas usam linhas de `financeiro`.  
   **Causa-raiz:** os indicadores não compartilham uma regra única que declare qual registro representa obrigação, liquidação e entrada efetiva. Os campos de recebimentos separados não devem ser somados automaticamente a receitas do ledger.

4. **“Resumo” não designa um único cálculo.** `/api/financeiro/resumo`, `/api/financeiro/relatorios/resumo`, `/api/financeiro/dashboard` e `/api/dashboard/resumo` selecionam tabelas, status e períodos diferentes.  
   **Causa-raiz:** rotas distintas preservam objetivos e gerações anteriores sem contrato uniforme de métrica.

### 3.2 Status, vendas canceladas e saldo

- A regra comum `FILTRO_VENDA_VALIDA` reconhece venda cancelada por `cancelada = 1` ou `status = 'cancelada'`. `sqlExcluirContaVendaCancelada` e `sqlExcluirFinanceiroVendaCancelada` aplicam essa regra em consultas específicas de Dashboard geral, resumo financeiro, recebíveis e relatório de receber.
- A exclusão **não está aplicada uniformemente**: o endpoint de Histórico, as pendências/alertas de recebimento do Dashboard Financeiro e a inadimplência não usam os helpers de venda cancelada.
- O resumo simples considera recebíveis pendentes apenas se `status = 'pendente'`, embora outros fluxos reconheçam `parcial` e os títulos CR tenham `valor_restante`. O dashboard geral, em contrapartida, soma saldo restante de `contas_receber` em `aberto`/`parcial`.
- O relatório `relatorios/resumo` classifica estados diferentes de `recebido`/`pago` como pendentes. Isso pode incluir estados cancelados ainda presentes no ledger.
- Para AP, a regra MCF usa `valor_restante` em `aberto`/`parcial`; pagamento parcial reduz o restante e não deve ser somado novamente com o registro de compatibilidade.

**Causa-raiz:** consultas SQL têm predicados de status locais, não uma função compartilhada para saldo aberto, liquidação e cancelamento.

### 3.3 Projeções de compatibilidade MCF

- O serviço MCF associa a linha de compatibilidade em `financeiro` ao título por `contas_pagar_financeiro_compat`. O MCF permanece a fonte canônica.
- `sqlExcluirProjecaoMcf` exclui linhas identificadas por origem `mcf_compatibilidade` ou referência `contas_pagar_mcf` em diversas consultas legadas.
- Dashboard geral e Dashboard Financeiro buscam AP diretamente em `contas_pagar`, sem somar a projeção.
- A listagem e o relatório operacionais atuais de AP consultam o MCF.
- Há superfícies, como inadimplência, que não excluem a projeção; como o status da projeção acompanha o título, ela pode ser interpretada como despesa pendente por essa consulta. Isso é risco de consulta comprovado pelo SQL, não contagem duplicada medida em dados.

**Causa-raiz:** filtro de projeção foi aplicado seletivamente durante a transição. Nenhum backfill foi executado nesta auditoria; lançamentos históricos permanecem preservados.

### 3.4 Filtros de datas

As telas constroem intervalos, mas os endpoints aplicam critérios diferentes:

- Dashboard geral de vendas: `date(v.data_venda)` no intervalo.
- Dashboard Financeiro e `/api/financeiro/resumo`: `COALESCE(vencimento, data_movimento)` para movimentos históricos; pagamentos MCF usam `data_pagamento`.
- Histórico: `date(data_movimento)`.
- Relatórios Resumo e Fluxo: `data_movimento`; o bloco `venda_recebimentos` usa a data da venda.
- Contas a Pagar MCF e relatório atual: `data_vencimento`.
- Receber e relatórios de receber: `COALESCE(vencimento, data_movimento)`.
- Inadimplência: intervalo em `data_movimento`, atraso calculado por `vencimento`.

Em vários endpoints, o filtro é aplicado somente quando **ambos** `dataInicio` e `dataFim` são fornecidos; um limite isolado é ignorado. Algumas comparações usam `date(...)`, outras comparação de texto/`BETWEEN`. Portanto, períodos iguais na interface não garantem o mesmo conjunto de registros.

**Causa-raiz:** falta de contrato comum que especifique data de competência, vencimento ou liquidação para cada indicador.

## 4. Renderização e eventos no Histórico

**Observado em `frontend/erp/js/financeiro-historico.js`:**

- `preencherTabelaHistorico` concatena `tipo`, `descricao`, `documento`, `pessoa_nome`, `status` e `forma_pagamento` diretamente em `tbody.innerHTML`. Esses campos vêm da API e não são escapados como texto.
- `status` também é interpolado no atributo `class`. Conteúdo HTML não confiável pode, portanto, alterar o DOM; o risco é de injeção de HTML/script e deve ser corrigido com escape contextual ou construção de nós via `textContent`/APIs DOM seguras.
- O caminho de erro interpola `error.message` em `innerHTML`, igualmente sem escape.
- O botão “Filtrar” usa `onclick` inline estático. Não foi encontrado handler inline construído com valores dinâmicos da resposta nesta tela; isso não mitiga a injeção dos campos de dados.
- Não há teste automatizado de segurança do renderer do Histórico nos testes executados nesta auditoria.

**Conclusão:** renderização insegura comprovada por inspeção estática; exploração em navegador não foi executada. A correção permanece pendente e não foi aplicada neste incremento documental.

## 5. Contexto MULTIEMPRESA

### Evidência de implementação

- `backend/rotas/financeiro.js` instala `middlewareResolverEmpresaFinanceiro` no router. O middleware resolve `req.empresaId`; no modo MULTIEMPRESA aceita contexto da requisição (`X-Empresa-Id`), valida empresa e, quando há usuário identificado, chama `UsuarioEmpresaService.exigirEmpresaAutorizada`.
- As consultas operacionais inspecionadas usam `req.empresaId` como parâmetro ou filtro `empresa_id`; a resolução não usa livremente uma empresa arbitrária do body.
- O frontend usa o helper central de headers para enviar token e contexto de empresa. `financeiro.js` bloqueia a abertura de abas sem empresa selecionada e recarrega a aba após o evento `cds-empresa-contexto-alterado`.
- O serviço MCF recebe `req.empresaId` e filtra títulos/pagamentos por empresa.

### Evidência de testes

Os testes executados nesta tarefa cobriram ausência de contexto, troca entre empresas, acesso não autorizado, consulta cruzada e ownership. Resultados exatos na seção 7.

### Limites

- Os testes não equivalem a uma revisão exaustiva de cada endpoint e papel de autorização.
- Alguns catálogos relacionados (por exemplo, cliente/fornecedor) são consultados por identificador global; o isolamento financeiro deve continuar sendo garantido pelas relações e títulos empresariais, e o acesso a metadados de cadastro global não foi auditado integralmente.
- A confirmação de isolamento aqui é baseada nos caminhos e testes listados; não houve consulta a banco persistente.

## 6. Arquivos e funções relevantes

### Fontes backend

- `backend/rotas/dashboard.js`: `GET /resumo`; agregações de venda, contas a receber e contas a pagar.
- `backend/rotas/financeiro.js`: `GET /`, `/resumo`, `/dashboard`, `/receber`, `/contas-receber`, `/contas-pagar`, `/relatorios/*`, baixa de recebimentos e rotas legadas de AP.
- `backend/services/reportFiscalHelpers.js`: `FILTRO_VENDA_VALIDA`.
- `backend/services/vendas/VendaFinanceiroService.js`: `sqlExcluirContaVendaCancelada`, `sqlExcluirFinanceiroVendaCancelada`.
- `backend/services/financeiro/FinanceiroEmpresaContextoService.js`: resolução de empresa e middleware financeiro.
- `backend/motores/mcf/services/ContasPagarService.js`: fonte e saldo canônicos de AP.
- `backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard.js`: identificação/exclusão de projeções MCF.

### Fontes frontend

- `frontend/erp/js/financeiro.js`: seleção de abas, período, contexto da empresa e refresh.
- `frontend/erp/js/financeiro-dashboard.js`: dashboard financeiro e renderização de cartões/listas.
- `frontend/erp/js/financeiro-historico.js`: listagem e renderização insegura do Histórico.
- `frontend/erp/js/financeiro-pagar.js`: UI operacional AP MCF.
- `frontend/erp/js/financeiro-receber.js`: listagem e fluxos agrupados de recebíveis.
- `frontend/erp/js/financeiro-relatorios.js`: seletores e chamadas de relatório.

## 7. Testes executados nesta atualização

Comando executado:

```text
node --test tests/financeiro/contexto-empresarial-financeiro-p0.test.js tests/financeiro/financeiro-multiempresa-05-38-d.test.js tests/financeiro/ownership-financeiro-05-41.test.js tests/financeiro/sprint-2-3-1-recebimentos-integrados.test.js tests/financeiro/mcf-01.test.js tests/financeiro/mcf-02-compras.test.js
```

Resultado observado pelo Node: **28 testes passaram, 0 falharam, 0 cancelados, 0 ignorados**.

| Arquivo | Evidência observada |
|---|---|
| `tests/financeiro/contexto-empresarial-financeiro-p0.test.js` | Contexto ausente rejeitado; troca A→B e isolamento; acesso não autorizado rejeitado. |
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | O runner imprimiu **20/20 cenários 05.38.D OK**, incluindo consultas isoladas, operações cruzadas bloqueadas, empresa inativa e contexto ausente. Usa SQLite em memória e diretório temporário. |
| `tests/financeiro/ownership-financeiro-05-41.test.js` | O runner imprimiu **14/14 OK**, incluindo ownership, não exposição de registro de outra empresa e regressões relacionadas. |
| `tests/financeiro/sprint-2-3-1-recebimentos-integrados.test.js` | Resultado impresso: **OK** para componentes, repetição, saldo obsoleto e rollback. Uma mensagem de conflito “A parcela mudou durante o pagamento” foi emitida durante o teste; a suíte terminou aprovada, sem falhas. |
| `tests/financeiro/mcf-01.test.js` | Suite MCF concluída; cobre projeção vinculada, pagamentos, cancelamento, lote idempotente e isolamento conforme os casos incluídos. |
| `tests/financeiro/mcf-02-compras.test.js` | Criação de títulos de compra por parcela e rollback em SQLite isolado. |

Esses testes comprovam somente os cenários que executam. Eles não testam a equivalência monetária entre Dashboard, Resumo e Relatórios, não cobrem todos os endpoints/UI em Electron, não validam o renderer contra XSS e não substituem a suíte completa do MBC.

## 8. Falhas, regressões, bloqueios e limitações

- **Falhas nos testes executados:** nenhuma.
- **Mensagem esperada observada:** o teste de recebimento parcial registra erro 409 quando detecta saldo/parcela obsoleta; o runner termina com sucesso.
- **Divergências de indicadores:** comprovadas nas fontes SQL e descritas na seção 3; valores reais de divergência não foram medidos.
- **Segurança do Histórico:** risco de injeção HTML comprovado por inspeção; correção e teste de regressão pendentes.
- **Cobertura insuficiente:** sem testes de contrato para comparar todos os indicadores e filtros entre as quatro superfícies de Dashboard/Resumo e Relatórios.
- **Compatibilidade MCF:** AP está canônica e a projeção vinculada é filtrada em consultas específicas; leitores restantes precisam ser inventariados/migrados ou explicitamente tratados como histórico. A projeção não deve ser somada com o título MCF.
- **Contas a Receber:** diferentes superfícies leem `financeiro` e `contas_receber`; reconciliação de títulos, pagamentos e eventuais projeções não foi executada.
- **MBC:** não alterado. Os testes executados não constituem execução integral ou aprovação do matching MBC.
- **Dados:** nenhuma base persistente ou de cliente foi aberta para comparação; nenhum backfill foi executado.
- **Testes bloqueados/não executados:** teste visual/Electron, auditoria dinâmica de XSS, reconciliação de métricas com fixture comum e suíte completa MBC. Não há evidência nesta execução para declarar esses itens aprovados.

## 9. Próximas verificações recomendadas

1. Definir contrato de cada indicador: fonte, estados incluídos, data de competência e regra de arredondamento.
2. Criar fixture financeira única que exercite venda cancelada, recebível aberto/parcial, pagamento em data diferente do vencimento, título MCF e projeção vinculada; comparar APIs e totais sem usar dados reais.
3. Corrigir o renderer do Histórico usando texto DOM seguro/escape contextual e adicionar teste que injete HTML em todos os campos renderizados, inclusive mensagem de erro.
4. Unificar as exclusões de venda cancelada e projeções compatíveis em todos os leitores, após testes de não regressão.
5. Concluir a convergência de Contas a Receber e dos relatórios para fontes canônicas, sem somar pagamentos/recebimentos duplicados.
6. Manter o MBC intocado até uma etapa explícita de integração e validação dedicada.

## 10. Conclusão

Esta entrega é uma **auditoria documental baseada no código e nos testes listados**, não uma aprovação global de FIN-P1.1. O MCF continua como fonte canônica de Contas a Pagar; as projeções de compatibilidade não devem ser contadas novamente. As diferenças entre indicadores têm causas identificáveis na seleção de fonte, status, cancelamento e data. Ainda faltam reconciliação com fixture comum, correção/teste de segurança do Histórico e validação abrangente de consumidores.
