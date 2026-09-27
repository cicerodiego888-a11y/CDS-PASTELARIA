# AUD-MBC-05-FINAL — Auditoria Final do Núcleo MBC-05.x

## 1. STATUS FINAL

**APTO COM RESSALVAS**

| Métrica | Valor |
|--------|-------|
| Baseline | **825 PASS / 0 FAIL / 0 SKIP** |
| Resultado final | **829 PASS / 0 FAIL / 0 SKIP** |
| Delta | **+4** testes de regressão das correções A01/A02/A03 |
| CRITICAL | **0** |
| HIGH (abertos após correção) | **0** |
| HIGH corrigidos nesta auditoria | **2** (A01, A02) |
| MEDIUM | **2** (A04 aberto; A03 corrigido) |
| LOW | **3** |
| INFO | **5** |

**Data:** 2026-09-07  
**Escopo:** MBC-05 → MBC-05.4 (sem MCF, sem novas features de produto)

## 2. Objetivo

Determinar se o núcleo de Conciliação Bancária MBC-05.x está estável para **congelamento** como fundação do MCF.

## 3. Escopo

Auditado: fundação, valor disponível, matching determinístico, CR rico, saídas FINANCEIRO despesa; integração com TX, FINANCEIRO, CR, pagamentos CR, `conciliacao_bancaria`, MP, Itaú, multiempresa, frontend Contas Bancárias.

## 4. Arquitetura auditada

```text
TRANSACAO_BANCARIA
        ↓
valor disponível (ConciliacaoBancariaService)
        ↓
MotorMatchingBancarioService (GET matching — somente leitura)
        ↓
candidato / usuário
        ↓
ConciliacaoBancariaService.conciliar  ← autoridade
        ↓
conciliacao_bancaria
```

| Invariante | Status |
|------------|--------|
| GET `/matching` não grava conciliação | OK |
| Sugestões (`analisar*`) ≠ conciliação | OK (tabela `sugestao_conciliacao_bancaria`) |
| Aceite de sugestão chama `conciliar` | OK |
| Sem `if (provider === ITAU/MP)` no matching | OK |

## 5. Valor disponível TX

```text
valor_disponivel = max(0, valor_transacao − SUM(conciliacoes ativas status=conciliada))
```

Canceladas (`ativo=0`) não consomem. Estados derivados: não / parcialmente / conciliada. Validado em testes 05.1 + audit.

## 6. CR (MBC-05.3)

```text
valor_original      = valor_parcela
valor_pago          = SUM(pagamentos) ou (parcela − restante)
valor_restante      = contas_receber.valor_restante   // já líquido de baixas
valor_ja_conciliado = SUM(conciliacoes CONTAS_RECEBER)
valor_disponivel    = max(0, valor_restante − valor_ja_conciliado)
```

**Sem dupla contagem** parcela − pagamentos − conciliações.

## 7. Pagamentos CR

`CONTAS_RECEBER_PAGAMENTO`: `disponivel = valor_pago − ja_conciliado`, `permite_parcial=false`. Sem status cancelado dedicado na tabela de pagamentos.

## 8. Saídas FINANCEIRO (MBC-05.4)

**SOLUÇÃO PROVISÓRIA — não é AP definitiva.**

- Não existe tabela `contas_pagar`.
- Domínio: `financeiro.tipo = 'despesa'`, `rotulo_entidade = CONTAS_A_PAGAR`, origem `FINANCEIRO`.
- `valor_disponivel = valor − ja_conciliado`, `permite_parcial = true` (só despesa).
- **AP dedicada será responsabilidade do MCF.**

## 9. Matching

Determinístico: empresa, movimento, valor/disponibilidade, data (±2 dias), status. Sem IA/fuzzy/random/ML. Ordenação estável.

## 10. Valor sugerido

```text
valor_sugerido = MIN(disponivel_TX, disponivel_candidato)
```

## 11. Multiempresa

`empresa_id` em listagens elegíveis, matching, conciliar, desconciliar, resolverRegistro. Cross-empresa → 404/ausência. OK.

## 12. Concorrência

`withTx` + `BEGIN IMMEDIATE`; revalidação de disponível no write. Matching = fotografia.

## 13. Cancelamento

Soft-cancel libera disponível da TX e do alvo. Confirmado no teste de audit.

## 14. Múltiplos alvos

1 TX → N conciliações; 1 CR/despesa → N (quando `permite_parcial`). Soma ≤ disponíveis.

## 15. Idempotência

Índice único parcial `idx_conciliacao_bancaria_vinculo_ativo`  
`(empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id)` WHERE ativo+conciliada.

## 16. Mercado Pago

Matching provider-agnostic sobre `TRANSACAO_BANCARIA`. Sem alteração de OAuth/sync. Regressão verde.

## 17. Itaú

Idem; MOCK. Sem alteração mTLS/OAuth/SecretStore.

## 18. Frontend

Modal “Encontrar correspondências” → GET matching → Conciliar explícito via POST conciliação. Sem auto-conciliação.

## 19. API

| Endpoint | Papel |
|----------|--------|
| GET `.../transacoes/:id/matching` | Somente leitura |
| POST `.../conciliacoes` / `.../transacoes/:id/conciliacoes` | Grava |
| POST `.../desconciliar` / `cancelar` | Soft-cancel |
| GET `.../pendentes` | Listagem |
| POST analisar / aceitar sugestão | Sugestão → conciliar |

## 20. Banco

Tabelas: `transacao_bancaria`, `conciliacao_bancaria`, `sugestao_conciliacao_bancaria`, alvos externos. Índices de empresa/transação/vínculo ativo. Sem nova estrutura nesta auditoria.

## 21. Testes

```text
Baseline:  825 PASS / 0 FAIL / 0 SKIP
Final:     829 PASS / 0 FAIL / 0 SKIP
```

Arquivo novo: `tests/bancario/motor-bancario-05-audit-final.test.js` (4 casos A01/A02/A03/cancelamento).

## 22. Achados

### A01 — HIGH — **CORRIGIDO**
- **Arquivo:** `ConciliacaoBancariaService.js` (`listarRegistrosElegiveis` receita)
- **Problema:** Receita listava `valor_ja_conciliado=0` sempre → candidatos fantasma no matching.
- **Impacto:** UI/matching enganoso; write já rejeitava.
- **Correção:** Soma em lote das conciliações; exclui `disponivel <= 0`.

### A02 — HIGH — **CORRIGIDO**
- **Arquivo:** `MotorMatchingBancarioService.js` (`aceitarSugestao`)
- **Problema:** `permite_parcial` só via origem CR; AP despesa falhava no aceite de sugestão parcial.
- **Impacto:** Inconsistência GET matching vs Aceitar sugestão.
- **Correção:** `origemPermiteParcial(...) || atual.permite_parcial === true`.

### A03 — MEDIUM — **CORRIGIDO**
- Receita cancelada/estornada filtrada na listagem (alinhado a despesa/CR).

### A04 — MEDIUM — **ABERTO**
- Mesmo título econômico pode ser alvo como CR e como PAGAMENTO independentemente.
- **Impacto:** possível over-allocation entre origens (cada origem respeita seu teto).
- **Pendência:** regra de produto / MCF / UX — não inventar nesta auditoria.

### A05 — MEDIUM (doc) — **ABERTO / ACEITO**
- AP provisória sem `valor_restante`/pagamentos (MBC-05.4). MCF.

### A06 — LOW — **ABERTO**
- Aceite de sugestão: status ACEITA e `conciliar` não são um único transaction boundary (rollback no catch mitiga).

### A07 — LOW — **ABERTO**
- Drift documental MBC-05.2 (“FINANCEIRO sem parcial”) vs 05.4 despesa parcial.

### A08–A11 — INFO
- Invariantes positivos (GET read-only, índice vínculo, provider-agnostic, frontend explícito).

### A12 — LOW — **ABERTO**
- `LIMIT 100` por origem sem paginação/busca por janela de data da TX.

## 23. Correções realizadas

1. Listagem receita: `ja_conciliado` + filtro status + exclusão disponível 0.  
2. `aceitarSugestao` honra `permite_parcial` do candidato.  
3. Testes de regressão audit (+4).

**Comportamento relevante alterado:** matching de **receita** deixa de sugerir títulos já consumidos / cancelados (antes enganava; agora alinhado à autoridade de escrita).

## 24. Pendências

- A04 dual CR/pagamento  
- A05 AP definitiva (MCF)  
- A06 transação única no aceite  
- A07 docs 05.2  
- A12 limite 100  

## 25. Decisão de congelamento

**APTO COM RESSALVAS**

Núcleo estável para congelar MBC-05.x como fundação do MCF:

- 0 CRITICAL / 0 HIGH abertos após correções  
- Matching GET somente leitura; ConciliacaoBancariaService autoridade  
- Valor disponível TX/CR/despesa corretos nas fórmulas oficiais  
- Multiempresa e concorrência de escrita OK  
- MP/Itaú preservados; suite verde  

Ressalvas aceitas: AP provisória, A04, limites de listagem, polish de aceite/docs.

**Não implementar mais funcionalidades no MBC-05.x** — evolução financeira dedicada vai para o MCF.

## 26. Impacto no MCF

MCF deve fornecer Contas a Pagar real (`valor_restante`, pagamentos/baixas) e, se desejado, política única CR vs pagamento. MBC consumirá via origem/contrato sem reinventar ledger.

## 27. Próximos passos

1. Congelar MBC-05.x (tag/baseline 829).  
2. Iniciar MCF (AP dedicada + baixas).  
3. Opcional pós-congelamento: A04 UX, A06, A12, sync docs 05.2.

## Arquivos

**Criados:**  
- `docs/bancario/AUD-MBC-05-FINAL-RELATORIO.md`  
- `tests/bancario/motor-bancario-05-audit-final.test.js`

**Alterados (somente integridade):**  
- `backend/motores/bancario/services/ConciliacaoBancariaService.js`  
- `backend/motores/bancario/matching/MotorMatchingBancarioService.js`
