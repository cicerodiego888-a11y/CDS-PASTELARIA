# MCF-01 — Fundação do Motor Financeiro

## 1. STATUS

**CONCLUÍDO**

| Métrica | Valor |
|--------|-------|
| Baseline MBC | **829 PASS / 0 FAIL / 0 SKIP** (congelado) |
| AP dedicada | **SIM** — `contas_pagar` + `contas_pagar_pagamentos` |
| FINANCEIRO legado | **Preservado** (UI Contas a Pagar continua nele) |
| MBC | **Intacto** (sem alteração de matching/conciliação) |

## 2. Auditoria do financeiro atual

### O que existe e funciona
- `financeiro`: ledger + Contas a Pagar UI (`tipo=despesa`)
- `contas_receber` + `contas_receber_pagamentos`: CR com `valor_parcela`/`valor_restante`
- `fornecedores`: catálogo global (sem `empresa_id`)
- Compras geram parcelas em `financeiro`
- Baixa em `/api/financeiro/pagar/:id/baixar` altera status; **não** reduz valor

### Legado / gaps
- Sem tabela `contas_pagar` real (fantasma em `validateInsertAlignment`)
- Sem `valor_restante` em despesa
- Baixa parcial sem histórico de pagamento persistido
- MBC trata AP provisória como `FINANCEIRO` despesa

### Reutilizável
- Padrão CR (`valor` original + `valor_restante` + N pagamentos)
- Middleware `FinanceiroEmpresaContextoService`
- Convenção monetária `DECIMAL(10,2)` + `round2`
- Entidade `fornecedores`

### Não duplicar
- UI/API `/api/financeiro/contas-pagar*`
- Matching MBC sobre `FINANCEIRO`

## 3–7. Mapas (resumo)

| Entidade | Tabela | Papel |
|----------|--------|--------|
| Ledger / AP UI | `financeiro` | Legado compatível |
| CR | `contas_receber` | Título a receber |
| Pagamentos CR | `contas_receber_pagamentos` | Baixas CR |
| **AP MCF** | **`contas_pagar`** | Título a pagar (fundação) |
| **Pagamentos AP** | **`contas_pagar_pagamentos`** | Baixas AP |
| Fornecedor | `fornecedores` | FK opcional |

Serviços/APIs legadas: `backend/rotas/financeiro.js`, `frontend/erp/js/financeiro-pagar.js`.  
Novas: `ContasPagarService`, `GET/POST /api/contas-pagar`.

## 8. Relação FINANCEIRO × MCF

```text
FINANCEIRO          → registros históricos e UI Contas a Pagar atual (legado)
CONTAS_A_PAGAR MCF  → títulos operacionais canônicos após cutover aprovado
```

Durante a transição **não** há dual-write automático.  
Criar AP MCF **não** grava em `financeiro`.

Tornar o MCF canônico **não** autoriza apagar nem sobrescrever lançamentos históricos de `financeiro`. Na futura transição, os registros de origem devem permanecer rastreáveis; uma obrigação já registrada no legado não pode ser recriada no MCF como uma segunda obrigação ativa. A estratégia de reconciliação/importação de saldos legados ainda precisa definir uma identidade estável de origem, vínculo entre os registros e regra para impedir dupla contabilização. Isso é uma recomendação de migração, não um comportamento já implementado.

## 9. Relação CR × AP

AP espelha CR:

| CR | AP |
|----|----|
| `valor_parcela` | `valor_original` |
| `valor_restante` | `valor_restante` |
| `aberto/parcial/pago|recebido` | `aberto/parcial/quitada/cancelada` |
| `contas_receber_pagamentos` | `contas_pagar_pagamentos` |

## 10. Arquitetura proposta

```text
MCF
 ├── contas_pagar
 ├── contas_pagar_pagamentos
 ├── estados (aberto|parcial|quitada|cancelada)
 └── futuro → integração MBC (origem CONTAS_PAGAR)

MBC (congelado)
 └── continua conciliando FINANCEIRO despesa até sprint de integração
```

## 11–14. Entidade AP / valores / estados

**Fórmula:**
```text
valor_restante_inicial = valor_original
após baixa: valor_restante = valor_restante − valor_pago (somente pagamentos efetivos)
0 <= valor_restante <= valor_original
```

**Estados:** `aberto` | `parcial` | `quitada` | `cancelada`  
Baixa em cancelada/quitada → rejeitada. Baixa > restante → rejeitada.

## 15. Pagamentos

Tabela `contas_pagar_pagamentos` + `POST /:id/baixar` (fundação mínima).  
Não gera lançamento em `financeiro` nesta sprint.

## 16–17. Multiempresa / Fornecedor

- `empresa_id` obrigatório (contexto middleware; não confiar no body)
- `fornecedor_id` opcional; valida existência; sem criar fornecedor novo

## 18–20. Banco / APIs / Frontend

Schema: `backend/motores/mcf/schema/mcfSchema.js` (via `database.js`).

APIs:
- `GET /api/contas-pagar`
- `POST /api/contas-pagar`
- `GET /api/contas-pagar/:id`
- `GET /api/contas-pagar/:id/pagamentos`
- `POST /api/contas-pagar/:id/baixar`

Frontend: **não** migrado — Contas a Pagar continua em `/api/financeiro/*`.

## 21–22. Testes / Regressão

- `tests/financeiro/mcf-01.test.js` → **13 PASS / 0 FAIL / 0 SKIP** (validação do incremento Sprint 03)
- MBC: `motor-bancario-*.test.js` → **829 PASS / 0 FAIL / 0 SKIP** (intacto)

## 23–24. Arquivos

**Criados:**
- `backend/motores/mcf/contracts/constantesMcf.js`
- `backend/motores/mcf/schema/mcfSchema.js`
- `backend/motores/mcf/services/ContasPagarService.js`
- `backend/motores/mcf/version.js`
- `backend/rotas/contas_pagar.js`
- `tests/financeiro/mcf-01.test.js`
- `docs/financeiro/MCF-01-RELATORIO.md`

**Alterados:**
- `backend/database.js` (garantir schema MCF)
- `backend/server.js` (montar `/api/contas-pagar`)

## 25. Limitações

- UI Contas a Pagar ainda no legado
- Sem dual-write compras → MCF
- Sem integração MBC (`ORIGEM_FINANCEIRA.CONTAS_PAGAR`)
- Sem cancelamento via API dedicado
- Fornecedor global (sem empresa_id)

## 26–28. Dependências / impacto MBC / próximos passos

**MCF-02 (recomendado):** migrar os consumidores de Contas a Pagar para a fonte canônica aprovada, sem gravações paralelas independentes; preservar os lançamentos históricos de `financeiro`, reconciliar saldos legados sem criar obrigações duplicadas e tratar cancelamento e parcelamento.
**MCF-03 / MBC-xx:** origem `CONTAS_PAGAR` no matching (após freeze consciente do MBC).

O MCF **não** está pronto — esta é somente a **fundação MCF-01**.

## 29. Sprint 03 — incremento 1: identidade de parcelas de compra

**Status do incremento:** implementado e validado em SQLite isolado. Isso não conclui a Sprint 03 nem integra a criação de compras ao MCF.

- `contas_pagar` agora armazena `numero_parcela` e `total_parcelas`; o schema existente recebe essas colunas de forma aditiva.
- Um índice único parcial protege a identidade `(empresa_id, referencia_tipo, referencia_id, numero_parcela)` para parcelas de compra.
- `ContasPagarService.criar` exige empresa, compra de origem e parcela válida; uma repetição com dados equivalentes retorna o título existente, enquanto uma divergência retorna conflito. Títulos MCF antigos de compra sem número de parcela bloqueiam a geração ambígua e exigem reconciliação.
- `POST /api/contas-pagar` encaminha os campos da parcela; criação nova responde `201`, repetição idempotente `200` e conflito `409`.
- O escritor de compras em `backend/rotas/compras.js` continua criando obrigações na tabela legada `financeiro`. Não foi conectado ao MCF, não há dual-write habilitado e nenhuma migração persistente foi executada. A transição depende da migração coordenada dos consumidores e fluxos de baixa legados.
- A futura canonicidade do MCF não implica exclusão do histórico de `financeiro`. Na migração, é necessário manter a ligação auditável com cada origem legada e impedir que a mesma obrigação conte simultaneamente como título legado e MCF; o mecanismo de reconciliação/importação permanece pendente e não foi implementado neste incremento.

**Validação executada:**

- `node --test tests/financeiro/mcf-01.test.js` — **13 PASS / 0 FAIL**; inclui upgrade do schema legado em memória, chave de parcela, replay, conflito, isolamento por empresa e encaminhamento/status da API.
- `node --test tests/compras/rc852-parcelamento-simplificado.test.js tests/compras/rc4314-fluxo-financeiro-central.test.js` — **16 PASS / 0 FAIL**; regressão do fluxo de compras legado.
- Os testes MCF usam SQLite `:memory:`. Não foram acessados bancos persistentes, Electron, MBC completo ou dados reais.

**Risco residual:** se uma base já tiver linhas MCF com números de parcela duplicados, a criação do índice único falhará explicitamente; essa base deverá ser reconciliada antes de habilitar a migração. A integração do escritor de compras não deve avançar até que telas, relatórios, baixas, cancelamento e consumidores de `financeiro` tenham plano de migração e testes coordenados.

## 30. MCF-02 — entrega incremental de Contas a Pagar

**Status:** parcialmente implementado; o MCF-02 e a Sprint 03 continuam abertos.

### Comportamento já conectado

- `backend/rotas/compras.js` cria títulos MCF por parcela na transação existente da compra; falha na geração reverte compra, títulos, pagamentos e projeções.
- A tela operacional de Contas a Pagar (`frontend/erp/js/financeiro-pagar.js`) lista e consulta títulos pela API `/api/contas-pagar`, cria despesas parceladas em uma única requisição idempotente, registra pagamentos parciais/totais no MCF e oferece cancelamento controlado em vez de editar ou excluir títulos.
- O relatório de Contas a Pagar (`frontend/erp/js/financeiro-relatorios.js`) consulta os títulos MCF.
- `contas_pagar` e `contas_pagar_pagamentos` são as fontes operacionais canônicas. O pagamento valida o saldo dentro de transação; o cancelamento mantém pagamentos existentes e registra o saldo residual cancelado.

### Projeção de compatibilidade e histórico

Cada novo título MCF também gera, na mesma transação, uma linha vinculada de compatibilidade em `financeiro`, registrada em `contas_pagar_financeiro_compat`. Essa projeção existe para manter consumidores legados, especialmente o matching MBC atual, que ainda consulta `financeiro`; não é uma segunda obrigação independente e não deve ser somada com o título MCF. Os pagamentos do título atualizam o status da projeção vinculada. O matching do MBC não foi alterado.

Lançamentos históricos de `financeiro` não foram apagados, alterados ou importados automaticamente. Ainda não existe reconciliação automática dos registros anteriores ao cutover; portanto, eles não são convertidos em títulos MCF por este incremento. A tabela de vínculo cobre as projeções criadas pelo MCF, não resolve por si só eventuais duplicidades históricas preexistentes.

### Consumidores e pendências

- O dashboard e o histórico financeiro ainda leem `financeiro`; novos itens MCF aparecem por meio da projeção compatível, mas os consumidores ainda não consultam diretamente a fonte MCF nem possuem testes abrangentes desta integração.
- As rotas legadas de `/api/financeiro/*` continuam montadas. A tela principal e o relatório de Contas a Pagar foram migrados, mas ainda é necessário identificar e bloquear/migrar escritores e consumidores legados ativos sem interromper os demais tipos de lançamento.
- A conciliação bancária continua baseada em `financeiro`; nenhuma alteração de matching ou integração direta do MBC com MCF foi feita.
- Não foi realizado backfill nem reconciliação de títulos anteriores; eventual migração exige critérios verificáveis, preservação de vínculos e prevenção de dupla contabilização.

### Validação deste incremento

- `node --check` nos arquivos JavaScript alterados: concluído sem erros.
- Suíte Node focada (`mcf-01`, `mcf-02-compras` e regressões de compra): **21 testes passaram, 0 falharam**.
- Testes específicos das regressões RC4.31 e RC8.5.2: **16 verificações passaram, 0 falharam**.
- Os cenários usaram SQLite `:memory:`. Não foram executados testes de UI no Electron, migrações persistentes, operações financeiras reais ou integração abrangente com dashboard, relatórios, permissões e MBC.
