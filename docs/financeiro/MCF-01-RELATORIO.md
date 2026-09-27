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
FINANCEIRO          → razão / UI Contas a Pagar atual (legado)
CONTAS_A_PAGAR MCF  → título operacional com restante/pagamentos
```

Durante a transição **não** há dual-write automático.  
Criar AP MCF **não** grava em `financeiro`.

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

- `tests/financeiro/mcf-01.test.js` → **10 PASS / 0 FAIL / 0 SKIP**
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

**MCF-02 (recomendado):** migrar UI Contas a Pagar; dual-write opcional; cancelamento; parcelamento.  
**MCF-03 / MBC-xx:** origem `CONTAS_PAGAR` no matching (após freeze consciente do MBC).

O MCF **não** está pronto — esta é somente a **fundação MCF-01**.
