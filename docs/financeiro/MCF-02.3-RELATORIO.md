# MCF-02.3 — Relatório de entrega

**Sprint:** MCF-02.3 — Validação dry-run + simulação da reconciliação histórica  
**Persistência:** nenhuma (sem backfill)  
**Aguardando:** aprovação expressa do Tech Lead

---

## 1. O que foi entregue

| Artefato | Função |
|----------|--------|
| `ContasPagarReconciliacaoHistoricaSimulacaoService.js` | Simula estado pós-ações sem escrever |
| `GET /api/contas-pagar/reconciliacao-historica/simulacao` | Endpoint admin somente leitura |
| Dry-run enriquecido | `cobertura`, `fingerprint` para estabilidade |
| `tests/financeiro/mcf-02.3-validacao-simulacao.test.js` | Fixture representativa + provas |
| `MCF-02.3-PLANO-MIGRACAO.md` | Plano futuro (idempotência, interrupção, auditoria) |
| Este relatório | Resultados e riscos |

---

## 2. Validação do dry-run (ambiente isolado SQLite)

Fixture com: match compra/parcela, divergência, ambiguidade, pago/parcial/cancelado, sem identidade, criar título, títulos MCF aberto/parcial/quitado, projeções, empresa B isolada.

**Comprovado nos testes:**

- Totais por ação batem com quantidade de itens
- Cobertura: `candidatos_elegiveis` + projeções ⊂ despesas totais
- Fingerprint estável em execuções repetidas
- Sem escritas (`db.run` instrumentado)
- Empresa B não vaza no dry-run de A

---

## 3. Correspondências

| Caso | Resultado esperado | Teste |
|------|--------------------|-------|
| Compra+parcela 1:1 sem divergência | `vincular` / alta | ✔ |
| Valor/vencimento divergente | `revisao_manual` | ✔ |
| 2 legados → 1 título | `revisao_manual` (não auto) | ✔ |
| Pago/parcial sem evidência de saldo | `revisao_manual`; `saldo_conhecido=null` | ✔ |
| Cancelado sem MCF | `ignorar` | ✔ |
| Ambiguidade com N candidatos | nunca `vincular` | ✔ |

---

## 4. Simulação (sem persistir)

A simulação produz:

- listas `vinculados`, `criar_titulo`, `ignorados`, `revisao_manual` com `estado_esperado`
- vincular: **não** altera saldo MCF; **não** cria pagamento; preserva pagamentos existentes
- criar_titulo: propõe `aberto` com valor original; **sem** pagamento sintético
- revisao_manual: `aprovacao_automatica=false`
- `total_a_pagar_simulado_sem_dupla_contagem` e flags anti-duplicidade
- Contagens de `contas_pagar` / `financeiro` / `compat` **inalteradas** após a simulação

---

## 5. Indicadores

`capturarIndicadoresAtuais`:

- Saldo confirmado = Σ `contas_pagar.valor_restante` (aberto/parcial)
- Legado histórico aberto **sem** projeções
- `total_a_pagar_sem_dupla_contagem` = MCF + legado (sem projeção)
- Projeções contabilizadas à parte (não somadas ao total)

Cenário numérico do teste: aberto 100 + parcial restante 150 + histórico 70 → **320**; pagamentos 80; quitado/cancelado separados.

---

## 6. Testes executados

```bash
node --test tests/financeiro/mcf-02.3-validacao-simulacao.test.js
# + regressão recomendada:
node --test tests/financeiro/mcf-02.3-validacao-simulacao.test.js \
  tests/financeiro/mcf-02.2-interface-dry-run.test.js \
  tests/financeiro/mcf-02.1-fechamento-operacional.test.js
```

**Não validado:** integração Electron real; matching MBC (intocado).

---

## 7. Riscos residuais

- Histórico `parcial`/`pago` permanece em revisão até haver evidência de pagamentos
- Dashboard ainda pode incluir valor de despesas históricas abertas até o backfill aprovado
- Fingerprint muda se a origem mudar entre dry-run e migração — plano exige abortar lote

---

## 8. Próximo passo

Somente após **aprovação expressa do Tech Lead**: implementar backfill conforme `MCF-02.3-PLANO-MIGRACAO.md` (ainda não autorizado).
