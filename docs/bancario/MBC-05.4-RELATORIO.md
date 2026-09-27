# MBC-05.4 — Auditoria + Matching Determinístico de Saídas / Contas a Pagar

## 1. STATUS

**CONCLUÍDO COM RESSALVAS**

| Métrica | Valor |
|--------|-------|
| Baseline antes | **815 PASS / 0 FAIL / 0 SKIP** |
| Existência de AP dedicada (tabela) | **NÃO** (`contas_pagar` inexistente no schema) |
| AP de domínio | **SIM** — `financeiro` com `tipo='despesa'` |
| Matching de saídas | **Implementado** sobre `ORIGEM_FINANCEIRA.FINANCEIRO` |
| Testes novos | **10** (`motor-bancario-05-4.test.js`) |
| Total final | **825 PASS / 0 FAIL / 0 SKIP** |

**Sprint:** MBC-05.4  
**Data:** 2026-09-07

## 2. Baseline

815 PASS · 0 FAIL · 0 SKIP (pós MBC-05.3).

## 3. Auditoria de AP

Pesquisado: tabelas, `database.js`, migrations/`ALTER`, rotas financeiro, frontend Contas a Pagar, docs 05.38.D, MBC-01/05, testes.

## 4. Tabelas encontradas

| Tabela | Papel |
|--------|--------|
| `financeiro` | Ledger + **Contas a Pagar** (`tipo=despesa`) + receitas |
| `contas_receber` / `contas_receber_pagamentos` | CR (entrada) |
| `fornecedores` | Join opcional por `pessoa_nome` na UI pagar |
| `compras` | Origem de lançamentos; **não** alvo direto de matching |
| `contas_pagar` | **Não existe** no `database.js` (fantasma em `validateInsertAlignment` / stubs de teste) |

Colunas relevantes em `financeiro` (via CREATE + ALTER):  
`id`, `empresa_id`, `tipo`, `valor`, `data_movimento`, `status`, `vencimento`, `pessoa_nome`, `pessoa_id`, `documento`, `origem`, `compra_id`, `baixado_em`, parcelas, etc.

**Ausente:** `valor_restante`, tabela de pagamentos/baixas de AP.

## 5. Serviços encontrados

- UI/API: `GET /financeiro/pagar`, `/contas-pagar` → `buildPagarQueryFilters` sobre `financeiro` despesa
- Baixa: `POST /financeiro/pagar/:id/baixar` (atualiza `status`; **não** persiste valor pago parcial)
- MBC: `ConciliacaoBancariaService` + `MotorMatchingBancarioService` (já conciliavam `FINANCEIRO` despesa)

## 6. Estrutura financeira encontrada

Contas a Pagar no ERP = lançamento `financeiro` despesa com status (`pendente`/`parcial`/`pago`/`recebido`/…), vencimento e fornecedor (`pessoa_nome`).

## 7. Existência ou não de AP dedicada

- **Tabela dedicada:** não.
- **Entidade de domínio conciliável:** sim (`FINANCEIRO` + `tipo=despesa`).
- **Decisão:** não criar `contas_pagar`; enriquecer matching de saída sobre a estrutura real.

## 8. Fórmula de disponibilidade

```text
valor_original      = financeiro.valor
valor_pago          = valor se status ∈ {pago, recebido};
                      null se status=parcial (valor não persistido);
                      0 caso contrário
valor_ja_conciliado = SUM(conciliacao_bancaria ativa
                         WHERE origem='FINANCEIRO' AND registro_id=id)
valor_disponivel    = max(0, valor_original − valor_ja_conciliado)
valor_sugerido      = min(disponível_TX, disponível_AP)
```

Não há `valor_restante` nem pagamentos AP — **não** se subtrai “pagamento financeiro” de novo (evita inventar dupla contagem).

`permite_parcial = true` apenas para **despesa** (AP). Receita permanece integral.

## 9. Pagamentos

Sem tabela de pagamentos AP. Baixa parcial não grava montante — `valor_pago`/`quantidade_pagamentos` ficam `null` quando aplicável.

## 10. Conciliações

Soma ativa em lote (`IN` + `GROUP BY`). Disponível 0 → candidato excluído. Soft-cancel libera.

## 11. Matching

Reutilizado `MotorMatchingBancarioService` + `GET .../matching`.  
Débito/SAÍDA → candidatos `FINANCEIRO` despesa (`rotulo_entidade: CONTAS_A_PAGAR`).  
Crédito não lista AP. Data: `vencimento` se existir, senão `data_movimento`. Exclui `cancelado`/`estornado`.

## 12. Endpoint

`GET /api/bancario/transacoes/:id/matching` — somente leitura. Sem endpoint AP dedicado.

## 13. Frontend

Modal existente: card **CONTAS A PAGAR** para candidatos despesa / `rotulo_entidade`.

## 14. Multiempresa

Filtro `empresa_id` na listagem e nas conciliações.

## 15. Concorrência

Matching = fotografia; gravação revalida elegível no `ConciliacaoBancariaService`.

## 16. Testes

`tests/bancario/motor-bancario-05-4.test.js`

## 17. Regressão

`node --test tests/bancario/motor-bancario-*.test.js` → **825 PASS / 0 FAIL / 0 SKIP** (+10 vs baseline 815).  
Mercado Pago e Itaú MOCK sem alteração de provider.

## 18. Arquivos criados

- `tests/bancario/motor-bancario-05-4.test.js`
- `docs/bancario/MBC-05.4-RELATORIO.md`

## 19. Arquivos alterados

- `backend/motores/bancario/services/ConciliacaoBancariaService.js`
- `backend/motores/bancario/matching/MotorMatchingBancarioService.js`
- `backend/motores/bancario/matching/contracts/CandidatoConciliacao.js`
- `backend/motores/bancario/version.js`
- `frontend/erp/js/contas-bancarias.js`
- `tests/bancario/motor-bancario-04-hardening.test.js`

## 20. Limitações (ressalvas)

1. Sem tabela `contas_pagar` dedicada.
2. Sem `valor_restante` / ledger de pagamentos AP.
3. Status `parcial` sem valor pago persistido.
4. Origem permanece `FINANCEIRO` (não inventar `CONTAS_A_PAGAR` como origem paralela).
5. Compras/vendas não são alvos diretos.

## 21. Dependências

Matching de AP “rica” como CR depende do **MCF** (ou evolução do financeiro) fornecer: valor restante real e/ou tabela de baixas/pagamentos AP.

## 22. Impacto no MCF

Recomendação: formalizar Contas a Pagar (tabela ou contrato) com `valor_restante` e pagamentos, espelhando CR — aí o MBC pode alinhar DTO/semântica sem gambiarra.

## 23. Próximos passos

- MCF: entidade AP com restante/pagamentos.
- MBC: quando MCF existir, mapear origem dedicada sem quebrar `FINANCEIRO`.
- Opcional: enriquecer receitas `FINANCEIRO` com soma de conciliações (simetria).
