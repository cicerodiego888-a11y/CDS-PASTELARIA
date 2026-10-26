# Sprint FIN-INT-02 — Relatório de entrega

**Tipo:** correção frontend Contas a Receber  
**Data:** 2026-10-26  
**Homologação:** pendente (Tech Lead)

## Defeitos confirmados antes da alteração

Inspeção no workspace (não só no relatório FIN-INT-01):

| ID | Local | Evidência |
|---|---|---|
| INT-01 | `preencherTabelaContasReceber` | Usava `conta.vencimento`; contrato `GET /api/financeiro/receber` devolve `dataVencimento` |
| INT-03 | `carregarContasReceber` | Em `catch`, HTML fixo “Erro ao carregar dados…” descartava `error.message` / status HTTP |
| INT-04 | tabela Contas a Receber | Interpolação de `cliente`, `descricao`, `documento`, `status`, `origem` via `innerHTML` sem escape; `onclick` com id dinâmico |

**INT-02 (fonte legado vs `contas_receber`) não foi corrigido**, conforme limite arquitetural da Sprint.

## Arquivos modificados

- `frontend/erp/js/financeiro-receber.js` — vencimento, erros, renderização segura da tabela Contas a Receber
- `tests/financeiro/fin-int-02-contas-receber.test.js` — testes focados (novo)
- `tests/financeiro/fin-ux-01-electron-preview.js` — fixture `dataVencimento` + asserção de erro alinhada
- `docs/financeiro/SPRINT-FIN-INT-02-DEPOIS.png` / `SPRINT-FIN-INT-02-ESTADO-VAZIO.png` — capturas sintéticas Electron
- `docs/financeiro/SPRINT-FIN-INT-02-RELATORIO.md`

Sem alterações em backend, SQL, MCF, MBC, outras abas ou banco.

## Correções implementadas

### A — Vencimento
- Célula usa `formatarData(conta.dataVencimento)` (ISO `YYYY-MM-DD` → `dd/mm/aaaa` local, sem `Date` UTC no path ISO).
- Ausência/nulo → `—`, sem quebrar a tabela.

### B — Mensagens de erro
- Tratamento explícito de HTTP 400 / 401 / 403 / 5xx e falha de rede.
- 400: mensagem segura da API ou orientação de empresa (`financeiroMensagemEmpresaObrigatoria`).
- 401 / 403: textos apropriados; detalhe da API só se passar filtro anti-vazamento (SQL, paths, tokens, HTML).
- Exibição via `textContent` em célula `role="alert"` (nunca `error.message` como HTML).

### C — Escape / renderização segura
- Tabela montada com `createElement` + `textContent` (padrão do Histórico).
- Status com classe whitelist (`status-aberto`, …, `status-outro`).
- Ações via `data-acao-receber` + `data-id` e listeners (sem `onclick` inline dinâmico).
- IDs numéricos validados antes de ligar ações.

Fonte de dados: permanece `GET /api/financeiro/receber` (legado `financeiro`).

## Testes executados

| Comando | Resultado |
|---|---|
| `node --check frontend\erp\js\financeiro-receber.js` | Aprovado |
| `node --check tests\financeiro\fin-int-02-contas-receber.test.js` | Aprovado |
| `node --test tests\financeiro\fin-int-02-contas-receber.test.js` | **5/5** aprovados |
| `node --test tests\financeiro\contexto-empresarial-financeiro-p0.test.js` | **6/6** aprovados |
| `node_modules\.bin\electron.cmd tests\financeiro\fin-ux-01-electron-preview.js` | Aprovado (API mockada; 2 linhas, 10 ações, filtros, `X-Empresa-Id`, erro/vazio) |

Cobertura dos testes focados: `dataVencimento` BR; nulo → `—`; XSS em cliente/descrição sem execução; 400/401/403/500; rede; headers `Authorization` / `X-Empresa-Id` e query de filtros.

Estes testes **não** são prova de integração operacional com backend autenticado.

## Confirmação de preservação

- Backend / contratos / SQL **não** alterados.
- Nenhuma união com `contas_receber` na lista.
- Sem pagamentos, cancelamentos, migrações ou escrita em banco.
- Outras abas (Dashboard, Dívidas, Pagar, etc.) não modificadas nesta Sprint (exceto o mesmo arquivo JS, funções de Dívidas intactas).

## Limitações

- INT-02 permanece aberto (fonte canônica da aba).
- Capturas Electron usam dados sintéticos.
- Validação visual/operacional com sessão real + empresa de teste não fez parte desta Sprint.

**Status:** entrega FIN-INT-02 concluída para revisão. Nenhuma outra Sprint iniciada.
