# Sprint FIN-UX-06 — Relatório de entrega

## Diagnóstico inicial

A tela **Dívidas por Cliente** (aba `duplicata`) vive em `frontend/erp/js/financeiro-receber.js`.

### Fonte canônica confirmada

A listagem e o detalhe **não** usam `financeiro` como fonte principal. O backend agrega:

- `clientes` + `contas_receber` (status `aberto` / `parcial`)
- detalhe: também `vendas`, `vendas_itens`, `produtos`
- filtro obrigatório `cr.empresa_id = ?` via `req.empresaId` (MULTIEMPRESA)
- exclusão de vendas canceladas (`sqlExcluirContaVendaCancelada`)

Pagamentos parciais e extrato usam as rotas agrupadas existentes; o histórico de baixa permanece no fluxo de `contas_receber` / pagamento parcial da API.

### Contratos preservados

| Operação | Rota |
|---|---|
| Lista agrupada | `GET /api/financeiro/receber/agrupado?cliente&status&dataInicio&dataFim` |
| Detalhe do cliente | `GET /api/financeiro/receber/agrupado/:clienteId` |
| Extrato | `GET /api/financeiro/receber/agrupado/:clienteId/extrato` |
| Pagamento parcial | `POST /api/financeiro/receber/agrupado/:clienteId/pagamento-parcial` |

Campos da lista exibidos (conforme contrato já usado pela UI): cliente, CPF/telefone, vendas, títulos, **total em aberto** (`total_divida` = soma de `valor_restante`), vencidas, a vencer.  
No detalhe, o resumo existente permanece: total da dívida, já pago, saldo atual, vendas e parcelas em aberto — sem inventar indicadores além do payload.

## Arquivos alterados

- `frontend/erp/js/financeiro-receber.js` — redesign da lista/detalhe de dívidas, estados, escape HTML, datas ISO locais; Contas a Receber fora do escopo visual desta Sprint permanece funcional.
- `frontend/css/financeiro.css` — estilos `.financeiro-duplicata-*`.
- `tests/financeiro/fin-ux-06-electron-preview.js` — harness Electron (API mockada, capturas, responsividade).
- `docs/financeiro/SPRINT-FIN-UX-06-ANTES.png`
- `docs/financeiro/SPRINT-FIN-UX-06-DEPOIS.png`
- `docs/financeiro/SPRINT-FIN-UX-06-ESTADO-VAZIO.png`
- `docs/financeiro/SPRINT-FIN-UX-06-RELATORIO.md`

Sem alterações em backend, MCF, MBC, Open Finance, PDV, Motor Fiscal, `financeiro.html` ou banco original.

## Decisões visuais

- Cabeçalho compacto com eyebrow `CONTAS A RECEBER · AGRUPADO`, título e descrição explícita da fonte.
- Filtros existentes reorganizados (busca prioritária + situação + vencimento + Filtrar).
- Tabela compacta, valores/números à direita, destaque para quantidade vencida > 0.
- Detalhe: resumo com total / pago / saldo (campos já retornados), vendas em cartões compactos, produtos/parcelas sob demanda.
- Estados separados: carregamento, vazio, erro (mensagem via `textContent`).
- Ações via listeners/`data-*` (sem `onclick` com dados dinâmicos).
- Datas `YYYY-MM-DD` formatadas como data local (sem deslocamento UTC).

## Preservação das regras financeiras

- Fonte e cálculos do backend inalterados.
- Sem soma dupla entre `financeiro` e `contas_receber`.
- Pagamento parcial, extrato e histórico de títulos preservados.
- Cabeçalhos `__headersFin()` / `X-Empresa-Id` mantidos.
- Sem backfill, migração ou escrita em dados persistentes nesta Sprint.

## Capturas

Mesma resolução **1783 × 959 px** (viewport 1440 × 900):

| Arquivo | Conteúdo |
|---|---|
| `SPRINT-FIN-UX-06-ANTES.png` | Lista legada Bootstrap |
| `SPRINT-FIN-UX-06-DEPOIS.png` | Lista redesenhada |
| `SPRINT-FIN-UX-06-ESTADO-VAZIO.png` | Sem dívidas para os filtros |

## Testes executados

| Comando | Resultado |
|---|---|
| `node_modules\.bin\electron.cmd tests\financeiro\fin-ux-06-electron-preview.js` | **Aprovado** — agrupamento, filtros/query, `X-Empresa-Id`, escape XSS, detalhe com pago/saldo, vazio/erro, 1440/1024/768 sem overflow do documento |
| `node --check frontend\erp\js\financeiro-receber.js` | Aprovado |
| `node --check tests\financeiro\fin-ux-06-electron-preview.js` | Aprovado |
| `node --test tests\financeiro\contexto-empresarial-financeiro-p0.test.js` | Aprovado, **6/6** |

## Limitações

- Validação em Electron com API mockada e dados sintéticos; sem sessão autenticada contra backend real.
- O campo `total_pago` da **lista** continua existindo na API, mas a UI de lista não o destaca: sob o `WHERE` de títulos abertos/parciais ele não representa o histórico completo de recebidos do cliente. O detalhe continua mostrando pago/saldo a partir do payload de detalhe.
- Homologação do Tech Lead pendente.

**Status:** entrega FIN-UX-06 concluída para revisão. Nenhuma outra Sprint foi iniciada.
