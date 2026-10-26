# Sprint FIN-UX-07 — Relatório de entrega

## Diagnóstico inicial

A aba **Dashboard** do Financeiro vive em `frontend/erp/js/financeiro-dashboard.js` e consome exclusivamente:

| Operação | Rota |
|---|---|
| Resumo + listas + gráfico | `GET /api/financeiro/dashboard?dataInicio&dataFim` |

Período vem do cabeçalho compartilhado (`obterPeriodoFinanceiro`). Contexto empresarial via `headersFinanceiro` / `CdsEmpresaContexto.headersAuth` (`X-Empresa-Id`).

### Origem canônica de cada indicador (`resumo`)

| Indicador UI | Campo API | Origem no backend (sem alteração nesta Sprint) | Natureza |
|---|---|---|---|
| Total recebido | `resumo.totalRecebido` | `financeiro` receitas baixadas no período (**exclui** projeções MCF e overlap com CR canônico) **+** `contas_receber_pagamentos` no período | Movimentação do período |
| Total pago | `resumo.totalPago` | `financeiro` despesas históricas baixadas no período (**exclui** projeções MCF) **+** `contas_pagar_pagamentos` (MCF) no período | Movimentação do período |
| Total a receber | `resumo.totalReceber` | Pendências `financeiro` receita elegível **+** saldo `contas_receber` (`aberto`/`parcial`) | Saldo em aberto (filtro de vencimento CR quando período informado) |
| Total a pagar | `resumo.totalPagar` | Pendências `financeiro` despesa histórica **+** saldo `contas_pagar` MCF (`aberto`/`parcial`) | Saldo em aberto |
| Saldo do período | *(derivado só na UI)* | `totalRecebido − totalPago` (mesmos campos do contrato) | Movimentação do período |

### Listas e gráfico

| Bloco | Campo API | Fonte |
|---|---|---|
| Próximos recebimentos | `proximos_recebimentos` | Legado `financeiro` receita elegível + `contas_receber` (próximos 30 dias) |
| Próximos pagamentos | `proximos_pagamentos` | **Somente** `contas_pagar` MCF (`fonte: 'contas_pagar'`) |
| Alertas | `alertas` | Receber vencido (legado elegível + CR) + pagar vencido MCF |
| Comparativo | `grafico` | Espelha os quatro totais do `resumo` (não é série temporal) |

**Dupla contagem:** o backend já exclui projeções MCF de `financeiro` (`sqlExcluirProjecaoMcf`) e overlap de receber canônico. A UI **não** reprocessa nem soma fontes adicionais.

**Gap legado corrigido só na apresentação:** a UI antiga exibia 4 cards e **omitia** `totalPagar` já retornado pela API. A nova UI passa a exibir o card usando o mesmo campo.

## Arquivos alterados

- `frontend/erp/js/financeiro-dashboard.js` — redesign visual, estados, escape HTML, datas ISO locais, card `totalPagar`, separação AR/AP.
- `frontend/css/financeiro.css` — estilos `.financeiro-dashboard-*`.
- `tests/financeiro/fin-ux-07-electron-preview.js` — harness Electron (API mockada, capturas, responsividade CDP).
- `docs/financeiro/SPRINT-FIN-UX-07-ANTES.png`
- `docs/financeiro/SPRINT-FIN-UX-07-DEPOIS.png`
- `docs/financeiro/SPRINT-FIN-UX-07-ESTADO-VAZIO.png`
- `docs/financeiro/SPRINT-FIN-UX-07-RELATORIO.md`

Sem alterações em backend, MCF, MBC, Open Finance, PDV, Motor Fiscal, outras abas, `financeiro.html` ou banco.

## Decisões visuais

- Cabeçalho compacto com eyebrow `VISÃO GERAL · EMPRESA ATUAL`, título e nota explícita sobre MCF / não-duplicidade.
- Badge de período (somente leitura) alinhado ao filtro já existente no cabeçalho financeiro.
- Cinco KPIs comprovados pelo contrato, valores à direita; AR (azul) e AP (roxo) com tipografia de borda distinta.
- Blocos lado a lado: próximos recebimentos vs. próximos pagamentos; alertas e comparativo em barras (Chart.js) só com os totais do payload.
- Estados: carregamento, listas vazias, erro (mensagem via `textContent`, inclusive 400 de empresa).
- Datas `YYYY-MM-DD` como data local BR; valores `pt-BR`.

## Preservação das regras financeiras

- Nenhum cálculo de fonte alterado no backend.
- Sem nova soma de projeção legada `financeiro` aos títulos MCF.
- Regras de contas a pagar/receber intactas.
- Cabeçalhos com `X-Empresa-Id` preservados.
- Sem migração, backfill ou escrita em banco.

## Capturas

Dados **explicitamente sintéticos** (fixture do harness Electron). Resolução de captura **1783 × 959 px** (viewport lógico 1440 × 900 sob DPI Windows):

| Arquivo | Conteúdo |
|---|---|
| `SPRINT-FIN-UX-07-ANTES.png` | Layout legado (4 cards; sem Total a pagar) |
| `SPRINT-FIN-UX-07-DEPOIS.png` | Dashboard redesenhado com os 5 KPIs e blocos AR/AP |
| `SPRINT-FIN-UX-07-ESTADO-VAZIO.png` | KPIs zerados + listas vazias |

## Testes executados

| Comando | Resultado |
|---|---|
| `node_modules\.bin\electron.cmd tests\financeiro\fin-ux-07-electron-preview.js` | **Aprovado** — indicadores = fixture, saldo = recebido−pago, XSS escapado, `X-Empresa-Id`, período na query, listas AR/AP, vazio/erro/400 empresa, media queries 1440/1024/768 (CDP) sem overflow do documento |
| `node --check frontend\erp\js\financeiro-dashboard.js` | Aprovado |
| `node --check tests\financeiro\fin-ux-07-electron-preview.js` | Aprovado |
| `node --test tests\financeiro\contexto-empresarial-financeiro-p0.test.js` | Aprovado, **6/6** |

## Limitações

- Validação em Electron com API **mockada** e dados sintéticos; sem sessão autenticada contra backend real — não se afirma integração operacional.
- O gráfico é comparativo dos totais já calculados; não há série diária/mensal no contrato.
- Homologação do Tech Lead pendente.

**Status:** entrega FIN-UX-07 concluída para revisão. Nenhuma outra Sprint foi iniciada.
