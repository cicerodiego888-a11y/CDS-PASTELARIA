# SPRINT 05.45

## OBJETIVO

Eliminar leituras globais de caixa/sessão no dashboard e nas consultas operacionais. Toda leitura empresarial parte de `empresaId` e só usa sessão pertencente a `caixa_sessoes.empresa_id`.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/utils/caixaSessaoHelpers.js` | Helpers de leitura: sessão por ID, movimentação por ID, listagem/soma com JOIN |
| `backend/monitoring/providers/CaixaProvider.js` | Sessão ativa e totais filtrados pela empresa; sem fallback `caixa` global |
| `backend/monitoring/MonitoringContext.js` | Propaga `empresaId`, headers e user para o provider |
| `backend/monitoring/MonitoringEngine.js` | Cache key inclui empresa |
| `backend/rotas/caixa.js` | GET sessão/movimentação por ID (404 cruzado); listagem de movimentações com JOIN |
| `backend/services/caixa/CaixaEmpresaContextoService.js` | HTTP 404 para `CAIXA_SESSAO_NAO_ENCONTRADA` / `CAIXA_MOVIMENTACAO_NAO_ENCONTRADA` |
| `tests/caixa/isolamento-dashboard-caixa-05-45.test.js` | **Novo** (T01–T14) |
| `docs/arquitetura/ISOLAMENTO_LEITURAS_CAIXA_05_45.md` | **Novo** |
| `docs/IMPLEMENTACAO_05_45_RELATORIO.md` | **Novo** |

Não alterados: Motor Comercial, TEF, regras fiscais, NFC-e, lotes, reservas, writers financeiros, cadastro `rotas/caixas.js` (E), `usuarioRelatorioService` (D residual), `CaixaWidget.js` (sem SQL).

Não foi criada coluna `empresa_id` nova.

## CAUSA DO RISCO

A 05.44 isolou abertura, PDV e histórico. O `CaixaProvider` (dashboard de monitoramento) ainda fazia:

```
SELECT * FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1
SELECT * FROM caixa WHERE status = 'aberto' ORDER BY id DESC LIMIT 1
```

O contexto de monitoramento não carregava `empresaId`. Empresa A no dashboard podia receber a sessão mais nova do sistema (Empresa B).

## CORREÇÃO

1. `CaixaProvider` exige empresa (contexto ou contrato operacional). Sem empresa → indicadores vazios, sem LIMIT 1 global.
2. Sessão ativa só via `obterSessaoAtivaDaEmpresa` (`WHERE empresa_id = ?`).
3. Vendas e movimentações do dashboard com JOIN em `caixa_sessoes.empresa_id`.
4. Acesso por `sessaoId` / `movimentacaoId` valida ownership; cruzado = 404.
5. Legado `empresa_id IS NULL` não aparece em leitura empresarial.

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/caixa/isolamento-dashboard-caixa-05-45.test.js` | 14 | 14 | 0 |
| `tests/caixa/ownership-caixa-sessao-05-44.test.js` | 10 | 10 | 0 |
| `tests/caixa/caixa-multiempresa-05-38-c.test.js` | 17 | 17 | 0 |
| `tests/vendas/ownership-vendas-05-40.test.js` | 13 | 13 | 0 |
| `tests/pdv-universal/caixa-operacional-05-23.test.js` | 8 | 8 | 0 |
| `tests/pdv-universal/caixa-operacional-acoes-05-33.test.js` | 12 | 12 | 0 |
| `tests/vendas/entrega-caixa-turno-fk.test.js` | 3 | 3 | 0 |
| `tests/monitoring/monitoring-engine-m2.test.js` | 5 | 5 | 0 |
| `tests/monitoring/monitoring-engine-m1.test.js` | 10 | 9 | 1* |
| **Total desta verificação** | **92** | **91** | **1*** |

\* M1: `UI não contém SQL` — assert pré-existente `modoFiscalAtivo` no frontend de monitoring. Não é leitura de caixa; arquivo de UI não foi tocado nesta sprint.

## RISCOS REMANESCENTES

- Relatório por `operador_id` (`usuarioRelatorioService`) fora do dashboard.
- Cadastro administrativo `caixas` sem `empresa_id`.
- Script morto `backend/teste_cancelar.js` com LIMIT 1 global.
- Tabelas filhas de caixa sem coluna própria (isolamento via sessão).
