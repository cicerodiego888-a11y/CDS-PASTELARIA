# Microsprint 2.7 — Estabilização da Central de Entradas e regressão

**Prioridade:** P0  
**Prazo do projeto:** 25/10/2026  
**Data desta execução:** 17/10/2026  
**Resultado:** recuperação 2.6 revalidada; dois defeitos comprovados e mínimos corrigidos (`SEM_PARSER` canônico e progresso UI pós-recuperação); falhas CE-05/06 e 05.74 classificadas com evidência; **nenhuma regressão nova**.

---

## 1. Auditoria inicial

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Relatório 2.6 | `docs/central-entradas/microsprint-2-6-recuperacao-processamento-relatorio.md` (lido) |

A correção 2.6 **já estava correta** e **não foi reimplementada**. Checkpoint: `parseJson` sozinho não conclui o pipeline; parser/MIIP válidos são pulados; `empresaId` obrigatório; fila inclui incompletos; lock por documento.

Work preexistente **não tocado:** fiscal/vendas/faturamento, `tests/fiscal/*`, `docs/bancario/OF-01-AUDITORIA-ITAÚ.md`.

Sem commit, push, merge ou Git destrutivo.

---

## 2. Isolamento

| Controle | Evidência |
|---|---|
| Banco oficial | nenhum comando abriu `C:\ProgramData\MercantilFiscal\dados` |
| `DB_DIR` | `%TEMP%\ms27-*` exclusivo por suíte + `CDS_FORCAR_LOCAL=1` |
| 2.6 / 2.7 / 05.74 | SQLite `:memory:` nas asserções de documento |
| Banner `BANCO OFICIAL EM USO` | apontou para o `.db` **temporário** |
| Grep `MercantilFiscal` nos logs de regressão | **0** (`NO_MF` em todas as suítes) |
| SEFAZ / certificado de produção | não utilizados |

---

## 3. Auditoria da correção 2.6 (Fase 2)

Reexecução: `microsprint-26-recuperacao-processamento.test.js` → **10/10**.  
`isolamento-fila-processamento-05-74.test.js` → **12/12**.

| # | Cenário | Evidência |
|---|---|---|
| 1 | Parser+MIIP concluídos, status não avançado | 2.6 testes 3+4 e extra; 2.7 retomada só de status |
| 2 | Parser ok, MIIP incompleto | 2.6 teste 5 (`parseCalls=0`, `miipCalls=1`) |
| 3 | Falha na transição | 2.6 testes 1+2 (`etapaAtual=status`, `XML_COMPLETO` persistido) |
| 4 | Reexecução após “reinício” | 2.6 teste 7, terceira chamada `reutilizado: true` |
| 5 | Duas recuperações concorrentes | 2.6 teste 7 `Promise.all` |
| 6 | Exceção original no histórico | 2.6 teste 8 `Falha original no pipeline (status)` |
| 7 | Sem duplicar parser/MIIP | 2.6 3+4; 2.7 revisão já pronta |
| 8 | `empresaId` obrigatório | 2.6 teste 9; 2.7 sem fallback/`COALESCE` |
| 9 | Já em revisão/importação | 2.7 `reutilizado: true`, zero parse/MIIP |
| 10 | Status × histórico × progresso | 2.6: 64% em `XML_COMPLETO` (honesto). 2.7: `posMiip` reconhece `EM_REVISAO`/`PRONTA_IMPORTACAO` **sem** incluir `XML_COMPLETO` |

---

## 4. Defeitos comprovados corrigidos nesta microsprint

Alterações **mínimas e separadas**. Sem fallback global de empresa. Sem remover `empresaId`.

### 4.1 Health `SEM_PARSER` comparava o literal `'SINCRONIZADA'`

**Reprodução:** `rc346-health-monitor` / `testSemParser` com `status: DocumentoFiscalStatus.SINCRONIZADA` (= `'XML_COMPLETO'`). A regra usava `['SINCRONIZADA'].includes(status)` → nunca disparava.

**Causa:** after RC3.7.1 o canônico é `XML_COMPLETO`. Documentos sem parser não entravam em auto-recuperação.

**Correção:** `status === DocumentoFiscalStatus.XML_COMPLETO \|\| status === 'SINCRONIZADA'` (canônico + legado).

**Resultado:** `rc346-health-monitor.test.js` passou a **OK** (antes exit 1).

### 4.2 Progresso UI ignorava status canônico pós-recuperação

**Reprodução:** `posParser`/`posMiip` só tinham aliases `AGUARDANDO_REVISAO`…`GRAVADA`. Após a 2.6 o banco grava `EM_REVISAO` / `PRONTA_IMPORTACAO`. A barra podia permanecer em 64% mesmo com status avançado.

**Correção:** incluir canônicos `EM_REVISAO`, `PRONTA_IMPORTACAO`, `EM_IMPORTACAO`, `IMPORTADA` (e compra/finalizado equivalentes). **Não** se adicionou `XML_COMPLETO` — o 64% do documento preso continua honesto.

---

## 5. Falhas CE-05/06 e 05.74 — classificação com evidência

Nenhuma destas é regressão da 2.6 (mesmas suítes/contagens da CE-06, mesmas mensagens de `EMPRESA_CENTRAL_AUSENTE` do 05.74).

`EMPRESA_CENTRAL_AUSENTE` **não é defeito funcional**. É o contrato MULTIEMPRESA/05.74: o chamador (teste) não passa `empresaId` e o fixture insere documento **sem** `empresa_id`. O código recusa fallback global — comportamento correto, reafirmado no teste 2.7.

### 5.1 Por suíte

| Suíte | Resultado | Falha | Mensagem / estado temp | Classe | Causa comprovada |
|---|---|---|---|---|---|
| `maquina-estados` | 11/0 **ok** | — | — | — | — |
| `sprint8` | 8/0 **ok** | — | — | — | — |
| `rc2-diagnostico` | 9/0 **ok** | — | — | — | — |
| `05.74` | 12/12 **ok** | — | `:memory:` A/B | — | isolamento preservado |
| `rc346` | **OK** (era fail) | `SEM_PARSER` | status canônico | **corrigido** | §4.1 |
| `sprint2` | 5/3 | PATCH válido | `null !== 'XML_COMPLETO'` no histórico | TEST_STALE / RC3.7.1 | `SINCRONIZADA`→`EM_PROCESSAMENTO` é no-op canônico; `transicionar` não grava histórico se `atual === novo` |
| `sprint2` | | PATCH inválido | `assert.ok(erroCapturado)` falso | TEST_STALE / RC3.7.1 | `GRAVADA`=`IMPORTADA`; `XML_COMPLETO`→`IMPORTADA` **é permitida** |
| `sprint2` | | filtro status | `0 !== 1` | TEST_STALE / RC3.7.1 | filtro `EM_PROCESSAMENTO` não casa linha `XML_COMPLETO` |
| `sprint4` | 3/2 | duplicata DF-e | `false !== true` | TEST_CONFIG / 05.70 | persistência sem `empresaId`; `UNIQUE(chave, empresa_id)` no SQLite **não** colide com `NULL` |
| `sprint4` | | obter XML | `assert.ok(doc)` falso | TEST_CONFIG | `buscarPorChave` sem empresa / identidade nula |
| `sprint5` | 3/4 | processarDocumento | `EMPRESA_CENTRAL_AUSENTE` | TEST_CONFIG / 05.74 | `processarDocumento(id)` sem `empresaId`; insert sem `empresa_id` |
| `sprint5` | | payload / vincular | `Documento sem empresa_id — operação bloqueada` | TEST_CONFIG / 05.74 | encadeamento do anterior; **não** há fallback |
| `sprint5` | | concluirRevisao | `Apenas administradores…` | TEST_CONFIG | `alterarStatus` sem perfil admin após pipeline que não rodou |
| `sprint7` | 10/1 | score GRAVADA | `scoreGeral >= 90` falso | TEST_STALE / RC3.7.1 | teste manda alias `GRAVADA`; score opera no canônico `IMPORTADA` |
| `sprint9` | 6/1 | estado serviço | `'offline' !== 'sincronizando'` | TEST_ENV | `global.navigator` no Node não simula `onLine` de forma estável |
| `sprint10` | 4/3 | upload | `importados 0 !== 1` | TEST_CONFIG / 05.74 | upload sem contexto `empresaId` |
| `rc1` | 5/4 | transição inválida | predicate `statusCode===400` falso + FK | TEST_STALE / RC3.7.1 | `SINCRONIZADA`→`GRAVADA` agora é `XML_COMPLETO`→`IMPORTADA` (válida); `transicionar(1,…)` sem documento |
| `rc1` | | reutiliza parse / bridge / fila | `EMPRESA_CENTRAL_AUSENTE` | TEST_CONFIG / 05.74 | `processar(doc.id)` e `listarPendentesProcessamento(10)` sem empresa |

### 5.2 O que não foi alterado (escopo)

- Não se inseriu fallback `empresa_operacional` / `COALESCE`.
- Não se removeu validação de `empresaId`.
- Não se reescreveu rc1/sprint2/4/5/10 só para “passarem”.

Esses testes legado **não exercitam** a recuperação 2.6 porque param no gate de empresa. A cobertura real está nas suítes 2.6, 2.7 e 05.74.

---

## 6. Regressão geral (`test:central-entradas`)

Cada suíte com `DB_DIR` próprio. Node `v24.19.0`.

| Suíte | Exit | Pass/Fail | Tipo |
|---|---|---|---|
| `maquina-estados.test.js` | 0 | 11/0 | aprovada |
| `central-entradas-sprint2.test.js` | 1 | 5/3 | reproduzida (CE-06) |
| `central-entradas-sprint4.test.js` | 1 | 3/2 | reproduzida (CE-06) |
| `central-entradas-sprint5.test.js` | 1 | 3/4 | reproduzida (05.74) |
| `central-entradas-sprint7.test.js` | 1 | 10/1 | reproduzida (CE-06) |
| `central-entradas-sprint8.test.js` | 0 | 8/0 | aprovada |
| `central-entradas-sprint9.test.js` | 1 | 6/1 | reproduzida (CE-06 / ambiente) |
| `central-entradas-sprint10.test.js` | 1 | 4/3 | reproduzida (CE-06) |
| `rc1-consolidacao.test.js` | 1 | 5/4 | reproduzida (05.74 + RC3.7.1) |
| `rc2-diagnostico.test.js` | 0 | 9/0 | aprovada |
| `isolamento-fila-processamento-05-74.test.js` | 0 | 12/12 | aprovada |
| `rc346-health-monitor.test.js` | 0 | OK | **era fail; corrigida** |
| `microsprint-26-…` | 0 | 10/10 | aprovada |
| `microsprint-27-…` | 0 | 5/5 | aprovada |

**Novas regressões:** nenhuma.  
**Bloqueados por ambiente:** sprint9 (`navigator`).  
**Banco oficial / SEFAZ:** intocados.

---

## 7. Arquivos alterados nesta microsprint

| Arquivo | Motivo |
|---|---|
| `backend/motores/central-entradas/health/HealthRules.js` | `SEM_PARSER` canônico |
| `frontend/erp/js/central-entradas-ux.js` | `posParser`/`posMiip` com status RC3.7.1 |
| `tests/central-entradas/microsprint-27-estabilizacao.test.js` | suíte 2.7 (nova) |
| `docs/central-entradas/microsprint-2-7-relatorio.md` | este relatório |

Arquivos da 2.6 permanecem como na 2.6 (não reescritos).

---

## 8. Comandos

```text
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short

DB_DIR=%TEMP%\ms27-*  CDS_FORCAR_LOCAL=1

node --test tests/central-entradas/microsprint-26-recuperacao-processamento.test.js
node --test tests/central-entradas/microsprint-27-estabilizacao.test.js
node tests/central-entradas/isolamento-fila-processamento-05-74.test.js
node tests/central-entradas/rc346-health-monitor.test.js
node tests/central-entradas/maquina-estados.test.js
node tests/central-entradas/central-entradas-sprint{2,4,5,7,8,9,10}.test.js
node tests/central-entradas/rc1-consolidacao.test.js
node tests/central-entradas/rc2-diagnostico.test.js
```

---

## 9. Riscos restantes e microsprint proposta

1. **Suítes legado sem `empresaId`** (rc1, sprint5, sprint10, sprint4) — não cobrem processamento real. Não são defeito de produção.
2. **Aliases RC3.7.1** em sprint2 (PATCH no-op) e sprint7 (score `GRAVADA`).
3. **Lock de concorrência** continua por processo (Map); após restart vale o checkpoint SQLite.
4. **UI** ainda usa aliases em outros pontos (badges, labels). Só o progresso de 14 etapas foi alinhado ao canônico, porque era o item 10 da Fase 2.

### Proposta — Microsprint 2.8 (fora deste escopo)

**Alinhar suítes legado ao contrato 05.74 + aliases RC3.7.1**, sem fallback global:

- fixtures com `empresaId` explícito de empresa de teste;
- `processar(id, { empresaId })` e `listarPendentesProcessamento(limite, empresaId)`;
- transições de teste usando pares **realmente** inválidos (`XML_COMPLETO` → `NOVA`, não `GRAVADA`);
- score/filtro usando canônicos `IMPORTADA` / `XML_COMPLETO`.

Não misturar isso com recuperação 2.6.

---

## 10. Critério de conclusão

| Critério | Status |
|---|---|
| Recuperação 2.6 validada (10 cenários) | sim |
| Falhas restantes classificadas com evidência | sim (§5) |
| Nenhuma regressão nova | sim |
| Banco oficial e SEFAZ intocados | sim |
| Sem fallback global / sem remover `empresaId` | sim |

**Microsprint 2.7 concluída.** Commit/push não executados.
