# MCF-02.3 — Plano de migração futura (Contas a Pagar histórico)

**Status:** documentação apenas. **Nenhum backfill** nesta etapa.  
**Pré-requisito:** aprovação expressa do Tech Lead após validação do dry-run e da simulação.

## 1. Pré-condições

1. Dry-run estável (`fingerprint` idêntico em duas execuções consecutivas sem mudança na origem).
2. Simulação com `reconciliacao_totais.batimento_quantidade = true`.
3. Itens `revisao_manual` resolvidos manualmente ou excluídos do lote.
4. Backup do banco (ou snapshot) e janela de manutenção comunicada.
5. Ambiente com MCF schema atual (`contas_pagar`, `contas_pagar_pagamentos`, `contas_pagar_financeiro_compat`).
6. Matching MBC **não** faz parte desta migração.

## 2. Escopo por ação

| Ação dry-run | Persistência futura | Regras |
|--------------|---------------------|--------|
| `vincular` | INSERT em `contas_pagar_financeiro_compat` (ou UPDATE controlado do legado para origem projeção) | 1:1; UNIQUE impede duplicidade; **não** alterar `valor_restante` MCF; **não** criar pagamento |
| `criar_titulo` | INSERT `contas_pagar` + projeção/vínculo | Status inicial `aberto`; `valor_restante = valor_original` salvo evidência explícita de pagamentos; **sem** pagamento sintético só por status legado |
| `ignorar` | Nenhuma | Registrar em log/auditoria de lote |
| `revisao_manual` | Fora do lote automático | Exige operador |

## 3. Transações e idempotência

- Processar em **lotes por empresa**, cada item (ou micro-lote) em `BEGIN IMMEDIATE` … `COMMIT`.
- Chave de idempotência por item, estável entre reinícios:
  - Vincular: `hist:vincular:emp:{empresaId}:fin:{financeiroId}:cp:{contaPagarId}`
  - Criar: `hist:criar:emp:{empresaId}:fin:{financeiroId}`
- Tabela sugerida (futura): `contas_pagar_migracao_historica` com `idempotency_key UNIQUE`, `status` (`pendente|ok|erro|pulado`), `payload_hash`, `executed_at`.
- Reexecução: se chave já `ok` com mesmo `payload_hash` → no-op; se hash divergir → falha `OPERACAO_CONFLITANTE` e pausa do lote.

## 4. Auditoria

Para cada item persistido:

- `modulo=financeiro`, `acao=migracao_historica_vincular|criar|ignorar`
- Detalhes: `financeiro_id`, `conta_pagar_id`, `empresa_id`, `criterio`, `confianca`, `dry_run_fingerprint`, `lote_id`

## 5. Conflitos

| Situação | Tratamento |
|----------|------------|
| UNIQUE violado em compat | Abortar item; marcar `erro`; não continuar cego |
| Título MCF cancelado/quitado no meio do lote | Reavaliar item → `revisao_manual` |
| Financeiro já vinculado | No-op idempotente |
| Ambiguidade detectada na revalidação pré-escrita | Pular para revisão; **nunca** auto-aprovar |

## 6. Interrupção e reinício

1. Lote grava progresso por `idempotency_key` **antes** do COMMIT do efeito (ou no mesmo TX).
2. Reinício carrega chaves `ok` e **não** reprocessa.
3. Itens `erro` entram em fila de retry/manual.
4. Após lote completo: reexecutar dry-run; candidatos restantes devem ser só `revisao_manual`/`ignorar` ou vazios.
5. Indicador pós-migração: `total_a_pagar = Σ MCF.valor_restante (aberto/parcial)` **sem** somar projeções nem legado já vinculado.

## 7. Recuperação de falhas

- Rollback da TX do item corrente.
- Não “compensar” com deletes em massa.
- Relatório de falhas exportável (CSV) com causa.
- Se fingerprint da origem mudou após início do lote → **abortar lote** e exigir novo dry-run/simulação.

## 8. Reconciliação posterior

1. Dry-run pós-migração (esperado: 0 `vincular`/`criar_titulo` automáticos no universo migrado).
2. Comparar `indicadores_antes` da simulação com indicadores pós (saldo MCF, pagamentos, vínculos).
3. Amostragem manual de N títulos vinculados e N criados.
4. Confirmar dashboard/relatórios sem dupla contagem.

## 9. Explicitamente fora de escopo até nova autorização

- Backfill em produção sem aprovação Tech Lead
- Pagamentos sintéticos sem evidência documental
- Alteração de matching MBC
- Remoção de APIs/tabelas legadas com consumidores ativos
