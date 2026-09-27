# MBC-05.2 — Matching Determinístico + Valor Disponível

**STATUS:** CONCLUÍDO  

**Sprint:** MBC-05.2  
**Data:** 2026-09-07

## 1. Objetivo

Implementar matching determinístico assistido que respeita `valor_disponivel` (MBC-05.1).  
O matching **só sugere**; a conciliação existente permanece a autoridade final. Sem IA, auto-conciliação, scheduler ou webhook.

## 2. Auditoria inicial

| Item | Achado |
|------|--------|
| Matching | Já existia (`MotorMatchingBancarioService` / MBC-08) |
| ConciliacaoBancariaService | Autoridade de valor/empresa/alvo |
| Gap | Pre-filter e aceite exigiam `candidato.valor === tx.valor` (total) |
| Tabela paralela | **Não criada** — evoluiu matching existente |
| Entidades alvo | `FINANCEIRO`, `CONTAS_RECEBER`, `CONTAS_RECEBER_PAGAMENTO` |
| Vendas/compras / AP dedicada | **Não preparadas** — não inventadas nesta sprint |

## 3. Serviços reutilizados

- `ConciliacaoBancariaService` (`calcularValorDisponivel`, `listarRegistrosElegiveis`, `conciliar`, `obterStatusDaTransacao`)
- `MotorMatchingBancarioService` (**evoluído**; sem `MatchingDeterministicoService` paralelo)
- `MatchingScoreService`, `MatchingRepository`, `sugestao_conciliacao_bancaria`
- Rotas e UI de Contas Bancárias existentes

## 4. Regras determinísticas

- `empresa_id` obrigatório (contexto autenticado)
- Direção: entrada ↔ receita/CR; saída ↔ despesa
- Janela de data: `JANELA_DIAS_MATCHING = 2` (constante documentada)
- FINANCEIRO / PAGAMENTO: sem parcial no alvo → candidato com valor > disponível = **INCOMPATIVEL** (não listado)
- CONTAS_RECEBER: parcial permitido → `valor_sugerido = min(disp_tx, disp_candidato)`

## 5. Valor disponível

Reutilizado MBC-05.1:

`valor_disponivel = max(0, valor_tx − SUM(conciliações ativas))`

Estados: `nao_conciliada` / `parcialmente_conciliada` / `conciliada`.

## 6. Compatibilidade

| Classe | Regra |
|--------|--------|
| EXATA | disp_candidato === disp_tx |
| COMPATIVEL | candidato cabe inteiro no disponível da TX |
| PARCIAL | parte do candidato/TX (quando parcial permitido) |
| INCOMPATIVEL | não utilizável (excluído da lista) |

Motivos: `MESMA_EMPRESA`, `MESMO_TIPO_MOVIMENTO`, `VALOR_*`, `DATA_COMPATIVEL`.

## 7. Ordenação

1. Compatibilidade (EXATA → COMPATIVEL → PARCIAL)  
2. Melhor uso do disponível  
3. Proximidade de data  
4. `alvo_id` estável  

Reproduzível; sem randomização.

## 8. Endpoint

`GET /api/bancario/transacoes/:id/matching` — **somente leitura**.

Não grava sugestão nem conciliação.  
Confirmação: `POST .../conciliacoes` (já existente) ou aceite de sugestão MBC-08 (agora com `valor_sugerido` ≤ disponível).

## 9. Frontend

Contas Bancárias:

- Ação **Encontrar correspondências**
- Modal com valor / conciliado / disponível / estado / candidatos / motivos
- **Conciliar** chama endpoint de conciliação existente (revalida no backend)

## 10. Multiempresa / concorrência / segurança

- Candidatos só da mesma empresa  
- Valor do matching é informativo; gravação revalida disponível  
- Sem SecretStore / tokens / `empresa_id` confiado do body  

## 11. Testes / regressão

Arquivo: `tests/bancario/motor-bancario-05-2.test.js`

| Marco | PASS | FAIL | SKIP |
|-------|------|------|------|
| Baseline pós MBC-05.1 | **789** | 0 | 0 |
| Após MBC-05.2 | **804** | 0 | 0 |

Comando: `node --test tests/bancario/motor-bancario-*.test.js`

## 12. Limitações

- Sem vendas/compras/AP dedicada como candidatos  
- Analisar/persistir sugestões ainda prioriza score (GET matching lista todos utilizáveis)  
- Sem fuzzy / IA  

## 13. Próximos passos

**MBC-05.3** — enriquecer candidatos (CR parcial no GET com `valor_ja_conciliado` explícito) + matching no aceite de sugestão alinhado ao modal GET.
