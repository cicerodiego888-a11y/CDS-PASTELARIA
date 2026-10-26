# Sprint FIN-INT-01 — Relatório de auditoria de integração real

**Tipo:** diagnóstico somente leitura  
**Data:** 2026-10-26  
**Executor:** Cursor / agente VS Code  
**Homologação:** pendente (Tech Lead)

## 1. Resumo executivo

A integração **estática** e os testes **focados em SQLite isolado / mocks** confirmam que o Financeiro envia `Authorization` + `X-Empresa-Id` via `CdsEmpresaContexto` / `headersFinanceiro`, que o shell ERP aguarda `CdsEmpresaContexto.inicializar()` antes de `loadPage`, e que o backend MULTIEMPRESA exige empresa nas rotas `/api/financeiro/*` e `/api/contas-pagar/*`. O Dashboard (contrato) exclui projeções MCF e agrega fontes documentadas; Contas a Pagar UI consome MCF canônico.

**Não houve validação integrada Electron + backend autenticado** nesta Sprint: não havia API local escutando, nem `.env`/credenciais de teste disponíveis. Por isso **a integração real não está aprovada**.

Achados relevantes (somente documentação; **sem correção**):

| ID | Severidade | Achado |
|---|---|---|
| INT-01 | **P1** | Aba Contas a Receber lê `conta.vencimento`, mas a API devolve `dataVencimento` — vencimento tende a não renderizar. |
| INT-02 | **P1** | Aba Contas a Receber lista apenas `financeiro` (legado); **não** lista `contas_receber`. Dashboard/Dívidas usam CR — risco de divergência entre abas. |
| INT-03 | **P1** | Em erro HTTP na lista de Contas a Receber, a UI descarta `error.message` e mostra texto genérico (inclui 400 de empresa). |
| INT-04 | **P2** | Lista Contas a Receber injeta `cliente`/`descricao`/etc. sem escape HTML (Dívidas já escapa). |
| INT-05 | **P2** | Tratamento de 400/401/403 inconsistente entre abas (Dashboard/Pagar/Relatórios/Histórico melhores que Receber). |
| INT-06 | **P3** | Condições de Pagamento são contrato **global** (sem `empresa_id`); header `X-Empresa-Id` é enviado mas ignorado no backend. |
| INT-07 | **P3** | Próximos recebimentos do Dashboard vindos de CR podem chegar sem `descricao`/`cliente` no contrato — UI usa fallback genérico. |

## 2. Ambiente efetivamente utilizado

| Item | Situação |
|---|---|
| Workspace | `C:\projetos\CDS-SISTEMAS PASTELARIA` |
| Backend HTTP local (3000/3333/outros) | **Indisponível** (timeouts; sem listener nas portas comuns) |
| Arquivo `.env` / credenciais de teste | **Ausente** |
| Electron autenticado + empresa de teste | **Não executado** (bloqueio de ambiente seguro) |
| Testes | Node `--check` + `contexto-empresarial-financeiro-p0` + `fin-p1-2-consistencia` (SQLite `:memory:`) |
| Harnesses FIN-UX Electron | **Não reexecutados** como prova de integração real (são API mockada) |

**Bloqueio Etapa B:** sem sessão autenticada nem empresa de teste autorizada, a validação integrada foi interrompida. Não foram usadas credenciais de terceiros nem dados de clientes.

## 3. Áreas verificadas (individualmente)

### 3.1 Dashboard Financeiro

| Aspecto | Evidência |
|---|---|
| Arquivo | `frontend/erp/js/financeiro-dashboard.js` |
| Endpoint | `GET /api/financeiro/dashboard?dataInicio&dataFim` |
| Headers | `__headersFin()` → `headersFinanceiro` / `CdsEmpresaContexto.headersAuth` |
| Empresa | Gate em `carregarAbaAtiva()` + tratamento 400/403 na carga |
| Estático | OK — KPIs mapeados a `resumo.*`; gráfico espelha totais |
| Backend real | **Não verificado** |
| Mock prévio | FIN-UX-07 (fora desta Sprint como prova real) |

Consistência (código backend, sem escrita): `totalRecebido`/`totalPago` = movimentação período; `totalReceber`/`totalPagar` = saldos; `sqlExcluirProjecaoMcf` nas consultas de `financeiro`; AP aberta/pagamentos via `contas_pagar` (+ histórico legado pendente). Confirmado também pelo teste `fin-p1-2` em memória.

### 3.2 Contas a Pagar

| Aspecto | Evidência |
|---|---|
| Arquivo | `frontend/erp/js/financeiro-pagar.js` |
| Endpoints leitura | `GET /api/contas-pagar`, `GET /api/contas-pagar/:id/detalhes`, dry-run reconciliacao |
| Escrita (não exercitada) | lote, baixar, cancelar |
| Fonte | MCF `contas_pagar` (eyebrow/UI e rotas dedicadas) |
| HTTP | `mensagemErroMcfPagar` trata 401/403/409 |
| Backend real | **Não verificado** |

### 3.3 Contas a Receber

| Aspecto | Evidência |
|---|---|
| Arquivo | `frontend/erp/js/financeiro-receber.js` (`renderContasReceber`) |
| Endpoint lista | `GET /api/financeiro/receber?...` |
| Fonte backend | SQL em `financeiro` tipo receita (`buildReceberQueryFilters`) — **sem** união com `contas_receber` |
| Campos UI vs API | UI usa `conta.vencimento`; API mapeia `dataVencimento` (**INT-01**) |
| Erros | Linha de tabela genérica; não propaga mensagem (**INT-03**) |
| Escape | Ausente na tabela (**INT-04**) |
| Backend real | **Não verificado** |

### 3.4 Dívidas por Cliente

| Aspecto | Evidência |
|---|---|
| Arquivo | mesmo `financeiro-receber.js` (`renderDuplicataClientes`) |
| Endpoints | `GET .../receber/agrupado`, detalhe, extrato; POST pagamento-parcial (não exercitado) |
| Fonte | `contas_receber` (+ vendas no detalhe) |
| Escape / estados | Presentes (FIN-UX-06) |
| Backend real | **Não verificado** |

### 3.5 Histórico Financeiro

| Aspecto | Evidência |
|---|---|
| Arquivo | `frontend/erp/js/financeiro-historico.js` |
| Endpoint | `GET /api/financeiro?dataInicio&dataFim&busca&tipo&status` |
| Contrato | Array JSON (não envelope `success`) |
| HTTP | 401 específico; demais via `!res.ok` |
| Backend | Rota com `sqlExcluirProjecaoMcf`; teste P1.2 confirma exclusão de projeções/canceladas em memória |
| Backend real | **Não verificado** |

### 3.6 Relatórios

| Aspecto | Evidência |
|---|---|
| Arquivo | `frontend/erp/js/financeiro-relatorios.js` |
| Endpoints | `/api/financeiro/relatorios/resumo\|receber\|fluxo\|inadimplencia`; pagar via `GET /api/contas-pagar`; dry-run histórico |
| HTTP | 401/403 + validação de formato |
| Backend real | **Não verificado** |

### 3.7 Condições de Pagamento

| Aspecto | Evidência |
|---|---|
| Arquivo | `frontend/erp/js/financeiro-condicoes.js` |
| Endpoints | `GET/POST/PUT/DELETE /api/condicoes-pagamento` |
| Escopo empresa | **Global** — router sem `FinanceiroEmpresaContextoService` / sem filtro `empresa_id` (**INT-06**) |
| Backend real | **Não verificado** |

## 4. Endpoints e contratos observados

### Exigem contexto empresarial (middleware financeiro / contas-pagar)

- `/api/financeiro/*` — `router.use(middlewareResolverEmpresaFinanceiro)` em `backend/rotas/financeiro.js`
- `/api/contas-pagar/*` — `req.empresaId` nas rotas MCF

Sem `X-Empresa-Id` em MULTIEMPRESA → **400** (prova: teste P0).

### Contrato global

- `/api/condicoes-pagamento` — cadastro compartilhado; não isola por empresa.

### Orquestração de abas

- `frontend/erp/js/financeiro.js`: `headersFinanceiro`, `carregarAbaAtiva`, gate `financeiroTemEmpresaSelecionada()`, listener `cds-empresa-contexto-alterado` recarrega a aba ativa (preserva contexto ao trocar empresa; troca de aba reutiliza o mesmo header helper).

### Inicialização

- `inicializarShellModulo` (`core.js`): após auth, **await** `CdsEmpresaContexto.inicializar()` e só então `loadPage` → `initFinanceiro()`.

## 5. Autenticação e `X-Empresa-Id`

| Camada | Situação estática / teste |
|---|---|
| Token | `Authorization: Bearer` via `localStorage` em `headersAuth` |
| Empresa | `X-Empresa-Id` só se houver seleção persistida (sem fallback inventado) |
| jQuery | `anexarHeaderXhr` no `ajaxSetup` |
| fetch Financeiro | Todas as sete áreas usam `__headersFin` / `headersFinanceiro` |
| Prova automática | P0: 6/6 aprovados (frontend + HTTP isolado) |

Sessão Electron real: **não observada**.

## 6. Testes executados

| Comando | Resultado |
|---|---|
| `node --check` nos 7 JS financeiros + `cds-empresa-contexto.js` | Aprovado (exit 0) |
| `node --test tests/financeiro/contexto-empresarial-financeiro-p0.test.js` | **6/6** aprovados |
| `node --test tests/financeiro/fin-p1-2-consistencia.test.js` | **4/4** aprovados (inclui dashboard: exclusão de projeção/cancelados e isolamento A/B em `:memory:`) |

Não executados (efeito de escrita financeira, migração ou suíte ampla): MCF-02.x ensaio/migração, POSTs de baixa/pagamento, suíte completa do repositório, Electron app com login.

## 7. Falhas reproduzidas

### INT-01 — Vencimento Contas a Receber (estático)

1. Abrir código `preencherTabelaContasReceber` → `formatarData(conta.vencimento)`.
2. Conferir resposta de `GET /api/financeiro/receber` → campo `dataVencimento`.
3. Conclusão: propriedade inexistente no payload; coluna de vencimento não usa o campo canônico da API.

**Evidência:** `financeiro-receber.js` ~L858; `financeiro.js` rota ~L1455–1460.

### INT-02 — Fonte divergente Contas a Receber vs Dashboard/Dívidas (estático)

1. `/api/financeiro/receber` → `FROM financeiro f` (`buildReceberQueryFilters`).
2. Dashboard `totalReceber` / alertas / próximos → também `contas_receber`.
3. Dívidas → `contas_receber` agrupado.
4. Conclusão: a aba “Contas a Receber” não apresenta o mesmo universo canônico das outras telas.

### INT-03 — Erro genérico Contas a Receber (estático)

1. Em `carregarContasReceber`, `catch` grava HTML fixo “Erro ao carregar dados. Tente novamente.” ignorando `error.message`.

Demais falhas de integração **runtime** (rede, 401 em sessão, renderização Electron): **não reproduzidas** por falta de ambiente autenticado.

## 8. Itens não verificados e motivos

| Item | Motivo |
|---|---|
| Requisições reais das 7 abas no Electron | Sem backend local + sem sessão/empresa de teste |
| Console Electron / Network panel | Mesmo bloqueio |
| Filtros com resposta real | Mesmo bloqueio |
| Troca de aba sob sessão viva | Mesmo bloqueio (há evidência estática do listener de empresa) |
| Pagamentos parciais / baixas | Escrita financeira — proibida nesta Sprint |
| SEFAZ / PDV / MBC / Open Finance | Fora de escopo |
| Declaração “integração aprovada” | Vedada sem backend autenticado |

## 9. Classificação P0–P3

| ID | Prioridade | Justificativa |
|---|---|---|
| INT-01 | **P1** | Quebra de apresentação de dado crítico (vencimento) por desalinhamento contrato↔UI; não é perda de dinheiro no banco, mas impede operação correta na aba. |
| INT-02 | **P1** | Divergência de fonte entre abas do mesmo módulo: usuário pode tomar decisão com lista incompleta/desatualizada vs Dashboard/Dívidas. Elevável a P0 se o negócio já considerar CR 100% canônico em produção. |
| INT-03 | **P1** | Impede diagnóstico de 400 empresa / 403 / 500 na própria aba. |
| INT-04 | **P2** | XSS refletido se descrições/clientes contiverem HTML; Dívidas já mitigou. |
| INT-05 | **P2** | UX inconsistente de erros; não altera cálculo. |
| INT-06 | **P3** | Comportamento de cadastro global provavelmente intencional; documentar expectativa multiempresa. |
| INT-07 | **P3** | Fallback de UI aceitável; melhoria de contrato CR→dashboard. |

Nenhum **P0** de vazamento multiempresa ou dupla contagem MCF no Dashboard foi comprovado nos testes isolados; o risco P0 operacional permanece **não validado em ambiente real**.

## 10. Confirmação de não alteração

Nesta Sprint FIN-INT-01:

- **Não** foram alterados arquivos de implementação (frontend/backend) pelo executor da auditoria.
- **Não** foram executadas migrações, backfill ou escritas no banco original/clientes.
- **Não** foram registrados pagamentos, cancelamentos ou obrigações.
- Único artefato produzido: este relatório `docs/financeiro/SPRINT-FIN-INT-01-RELATORIO.md`.

(Alterações pré-existentes no working tree de Sprints anteriores permanecem intocadas por esta auditoria.)

## 11. Recomendação técnica (próxima Sprint — não iniciada)

Sugestão para autorização futura do Tech Lead (**FIN-INT-02** ou corretiva pontual):

1. Disponibilizar ambiente seguro (Electron + backend local + usuário/empresa de teste) e repetir Etapa B com captura de Network.
2. Corrigir mapeamento `dataVencimento` e mensagens de erro na aba Contas a Receber.
3. Decidir explicitamente a fonte canônica da aba Contas a Receber (legado vs `contas_receber` vs união documentada) e alinhar UI/contrato — **sem** misturar projeções MCF.
4. Uniformizar tratamento 400/401/403/500 nas sete abas.
5. Avaliar escape HTML residual na lista de Contas a Receber.

**Status:** FIN-INT-01 concluída para homologação. Nenhuma correção e nenhuma Sprint seguinte foram iniciadas.
