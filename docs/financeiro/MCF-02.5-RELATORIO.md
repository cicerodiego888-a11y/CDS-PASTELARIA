# MCF-02.5 — Relatório de verificação final pré-migração

## Veredito

**APROVADO** — validação técnica em SQLite isolado com dados de teste controlados.

| Campo | Valor |
|-------|--------|
| Resultado | **aprovado** |
| Escopo | Fixture `tests/fixtures/mcf-02.5-ensaio/` + suites Node |
| Dados reais / cliente | **Não aplicável** (ambiente só teste/dev) |
| Restauração de produção | **Não exigida** para esta validação |
| Backfill operacional | **NÃO AUTORIZADO** |

---

## Premissa corrigida

O banco do projeto é exclusivamente de teste e desenvolvimento.  
A validação MCF-02.5 **não** depende de comprovação de recuperação de dados reais.  
Backup/restauração documentados referem-se **somente** à cópia isolada de ensaio.

---

## Evidências objetivas

### Abertura e consulta

| Item | Resultado |
|------|-----------|
| `ensaio-pre-mig.sqlite` | Abre e consulta |
| `ensaio-pre-mig.backup.sqlite` | Abre; contagens batem com origem |
| Antes | `contas_pagar=3`, `financeiro=6`, `pagamentos=1` |

Fonte: `tests/fixtures/mcf-02.5-ensaio/EVIDENCIA-PRE-MIG.json`

### Indicadores (antes → depois)

| Indicador | Antes | Depois |
|-----------|-------|--------|
| Pagamentos MCF (qtd / valor) | 1 / 100 | 1 / 100 |
| Títulos MCF | 3 | 4 |
| Vínculos compat | 1 | 3 |
| Financeiro (linhas) | 6 | 6 |
| Dry-run `vincular` | 1 | 0 |
| Dry-run `criar_titulo` | 1 | 0 |
| Revisão manual | 2 | 2 |
| Possíveis duplicidades compat | 0 | 0 |
| Comparação snapshots | — | `aprovado: true`, divergências `[]` |

Delta esperado: `+1` título (criar), `+2` vínculos (vincular+criar), saldo MCF `+200` (título criado sem pagamento sintético).

### Cenários executados

| Cenário | Resultado |
|---------|-----------|
| Falha simulada `titulo_criado` | `abortado`; contagens preservadas; sem órfãos |
| Interrupção após 1 item | `interrupido`; 2 pendentes |
| Retomada | `concluido` |
| Replay idempotente | 0 processados |
| Identidade histórico vs sintético | Histórico não removível |
| Falha `compat_inserido` | Rollback; lote abortado bloqueia retomada cega |

### Testes executados

```bash
node --test ^
  tests/financeiro/mcf-02.5-validacao-sqlite-isolado.test.js ^
  tests/financeiro/mcf-02.5-verificacao-pre-migracao.test.js ^
  tests/financeiro/mcf-02.4-ensaio-migracao.test.js
```

| Suite | Pass |
|-------|------|
| MCF-02.5 — Validação SQLite isolado | 3/3 |
| MCF-02.5 — Verificação final pré-migração | 5/5 |
| MCF-02.4 — Ensaio cópia isolada | 4/4 |
| **Total** | **12/12** |

Falhas: **nenhuma**.

---

## Controles confirmados

- Marcadores `[MCF_PROJECAO_SINTETICA]` / `[MCF_HISTORICO_VINCULADO]`
- `omitirProjecao` no caminho `criar_titulo`
- TX por item + ganchos de falha
- Parâmetros explícitos `empresaId` + `loteId` + `ambienteId` + `permitirEscritaIsolada`
- Relatório pré-migração somente leitura (`gerarRelatorioPreMigracao`)

---

## Artefatos

| Arquivo | Papel |
|---------|--------|
| `docs/financeiro/MCF-02.5-PLANO-PROTECAO.md` | Plano (premissa teste/dev) |
| `docs/financeiro/MCF-02.5-RELATORIO.md` | Este relatório |
| `tests/financeiro/mcf-02.5-validacao-sqlite-isolado.test.js` | Validação em arquivo isolado |
| `tests/financeiro/mcf-02.5-verificacao-pre-migracao.test.js` | Controles unitários |
| `tests/fixtures/mcf-02.5-ensaio/EVIDENCIA-PRE-MIG.json` | Evidência objetiva |
| `tests/fixtures/mcf-02.5-ensaio/AMBIENTE.json` | Metadados da cópia |

---

## Ressalvas (não impeditivas)

1. Ensaios Node/SQLite **não** substituem validação futura em Electron, se exigida pelo Tech Lead.
2. Matching MBC **não** foi alterado nem revalidado nesta sprint.
3. Itens `revisao_manual` permanecem fora do automático (comportamento intencional).

Essas ressalvas **não** rebaixam o veredito técnico do escopo isolado atual.

---

## Próximo passo (bloqueado)

Backfill operacional somente com **autorização expressa e específica** do Tech Lead (empresa, lote, janela, responsável).
