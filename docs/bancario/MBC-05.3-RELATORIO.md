# MBC-05.3 — Matching Contas a Receber + Valor Disponível Rico

## 1. STATUS

**CONCLUÍDO**

| Métrica | Valor |
|--------|-------|
| Baseline antes | **804 PASS / 0 FAIL / 0 SKIP** |
| Testes novos (arquivo 05-3) | **11** (`it`) |
| Total final suite `motor-bancario-*.test.js` | **815 PASS / 0 FAIL / 0 SKIP** |
| Delta | **+11** |

**Sprint:** MBC-05.3  
**Data:** 2026-09-07

## 2. Baseline antes da sprint

804 PASS · 0 FAIL · 0 SKIP (pós MBC-05.2).

## 3. Auditoria inicial

Auditado antes/durante a implementação:

- `MotorMatchingBancarioService`, `MatchingScoreService`, contratos matching
- `ConciliacaoBancariaService`, `MotorBancarioService`
- `conciliacao_bancaria`, `contas_receber`, `contas_receber_pagamentos`
- Frontend Contas Bancárias (modal matching MBC-05.2)
- Testes MBC-05 / 05.1 / 05.2

**Não inventados campos.** Sem tabela paralela.

## 4. Estrutura real de Contas a Receber

Tabela `contas_receber` — colunas usadas:

- `valor_parcela` → `valor_original`
- `valor_restante` → base financeira após baixas
- `data_vencimento` → data de matching (`data_tipo: vencimento`)
- `status` (default `aberto`)
- `numero_parcela` / `total_parcelas` → descrição
- `empresa_id`

**Não existe** coluna `valor_pago` no título.

## 5. Estrutura real de pagamentos

Tabela `contas_receber_pagamentos`:

- `conta_receber_id`, `valor_pago`, `data_pagamento`
- Sem `empresa_id` (escopo via título)
- Sem status cancelado/estornado dedicado encontrado nesta camada

## 6. Relação entre pagamentos e conciliações

| Ação | Efeito em `valor_restante` | Efeito em `conciliacao_bancaria` |
|------|----------------------------|----------------------------------|
| Pagamento / baixa financeira | Reduz `valor_restante` | — |
| Conciliação bancária no título CR | **Não** altera `valor_restante` | Soma `valor_conciliado` ativo |

Portanto pagamento e conciliação **não** são consumos independentes a subtrair juntos da parcela.

## 7. Fórmula real de valor disponível

```text
valor_original      = valor_parcela
valor_pago          = SUM(pagamentos.valor_pago)
                      // fallback: max(0, parcela − restante) se não houver linhas
valor_restante      = contas_receber.valor_restante
valor_ja_conciliado = SUM(conciliacao_bancaria ativa
                         WHERE origem_financeira = 'CONTAS_RECEBER'
                           AND registro_financeiro_id = cr.id)
valor_disponivel    = max(0, valor_restante − valor_ja_conciliado)
valor_sugerido      = min(valor_disponivel_transacao, valor_disponivel_cr)
```

**Prova de integridade (T06):** parcela 1000, restante 700 (pago 300), conciliação bancária 200 → disponível **500** (não 1000−300−200=500 por coincidência de aritmética errada — a regra é restante−já_conciliado).

Alvo `CONTAS_RECEBER_PAGAMENTO`:

```text
valor_disponivel = max(0, valor_pago − SUM(conciliações ativas do pagamento))
permite_parcial  = false
```

## 8. Pagamentos parciais

Múltiplos pagamentos agregados em lote (`COUNT`/`SUM`).  
Disponibilidade do título usa `valor_restante` (já líquido), não `parcela − SUM(pagamentos)` de novo.

## 9. Pagamentos cancelados/estornados

Não há status de pagamento cancelado/estornado nesta camada.  
Títulos com `status` `cancelado`/`estornado` são excluídos do matching.

## 10. Conciliações existentes

Soma ativa em `conciliacao_bancaria` reduz `valor_disponivel` do CR.  
CR com `valor_disponivel = 0` não entra na lista.

## 11. Critérios de matching

Mantidos do MBC-05.2: empresa, direção crédito→CR, valor, data (vencimento ± `JANELA_DIAS_MATCHING`), ordenação determinística, classes EXATA / COMPATÍVEL / PARCIAL.

## 12. DTO final (candidato CR)

Campos expostos quando disponíveis:

`tipo_alvo`, `alvo_id`, `descricao`, `valor_original`, `valor_pago`, `valor_restante`, `valor_ja_conciliado`, `valor_disponivel`, `valor_sugerido`, `status`, `data`/`data_tipo`, `compatibilidade`, `motivos`, `quantidade_pagamentos`, `pagamentos: { quantidade, valor_total }`.

## 13. Endpoint

`GET /api/bancario/transacoes/:id/matching` — **somente leitura** (sem gravação de sugestões).

Conciliação continua via endpoint/serviço existente.

## 14. Frontend

Modal existente (`abrirMatching`) enriquecido para `CONTAS_RECEBER`: original, pago, já conciliado, disponível, sugestão, status, pagamentos, compatibilidade, motivos, botão Conciliar.

## 15. Multiempresa

Filtro por `empresa_id` na listagem de CRs e na soma de conciliações. Teste T10.

## 16. Concorrência

Matching = fotografia. Gravação revalida em `ConciliacaoBancariaService` (T11).

## 17. Performance

Agregações em lote (`IN (...)` + `GROUP BY`) para conciliações e pagamentos — evita N+1.

## 18. Testes

Arquivo: `tests/bancario/motor-bancario-05-3.test.js` (11 casos cobrindo integral, parcial, total, pagamentos, integridade, limites, crédito/débito, multiempresa, data, multiplicidade, read-only, concorrência, cancelamento, MP/Itaú).

## 19. Regressão

`node --test tests/bancario/motor-bancario-*.test.js` → **815 PASS / 0 FAIL / 0 SKIP**.

Providers Mercado Pago e Itaú MOCK não alterados; matching provider-agnostic.

## 20. Arquivos criados

- `tests/bancario/motor-bancario-05-3.test.js`
- `docs/bancario/MBC-05.3-RELATORIO.md`

## 21. Arquivos alterados

- `backend/motores/bancario/services/ConciliacaoBancariaService.js`
- `backend/motores/bancario/matching/MotorMatchingBancarioService.js`
- `backend/motores/bancario/matching/MatchingScoreService.js`
- `backend/motores/bancario/matching/contracts/CandidatoConciliacao.js`
- `backend/motores/bancario/matching/contracts/constantesMatching.js`
- `backend/motores/bancario/version.js` (`SPRINT = MBC-05.3`)
- `frontend/erp/js/contas-bancarias.js`

## 22. Limitações

- Vendas / compras / contas a pagar dedicada: fora de escopo.
- Sem status de pagamento cancelado/estornado no modelo auditado.
- Inferência de `valor_pago` quando não há linhas em `contas_receber_pagamentos`.
- Status textuais do ERP (`pago` vs `recebido`) — elegibilidade numérica prevalece.
- Transação 800 com CR disponível 600: após conciliar 600 a TX fica `parcialmente_conciliada` (resto 200); o CR sai do matching (disponível 0).

## 23. Próximos passos

**MBC-05.4** — matching de saídas / contas a pagar quando entidade dedicada existir; ou unificar semântica de status CR no ERP.
