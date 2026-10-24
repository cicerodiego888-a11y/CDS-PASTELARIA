# Microsprint 2.6 — Recuperação segura da Central de Entradas

**Prioridade:** P0  
**Prazo do projeto:** 25/10/2026  
**Data desta execução:** 17/10/2026  
**Resultado:** correção comprovada implementada. Documentos presos em `XML_COMPLETO` (alias de `EM_PROCESSAMENTO`) com `parseJson`/`miipResumoJson` passam a retomar só as etapas pendentes.

---

## 1. Baseline Git (antes de implementar)

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| HEAD subject | `implemetação Diversas` |

Alterações **preexistentes preservadas** (não tocadas nesta microsprint):

- `backend/rotas/fiscal.js`, serviços fiscais/vendas/faturamento, frontends de vendas/fiscal
- `tests/fiscal/*` (claim-worker, isolamento NFC-e, runtime)
- `docs/bancario/OF-01-AUDITORIA-ITAÚ.md`

Não houve commit, push, merge nem comando Git destrutivo.

### Auditoria: a 2.6 já tinha sido executada?

Não. Não existia relatório, suíte `microsprint-26-*` nem regra `PROCESSAMENTO_INCOMPLETO` no `HEAD`. A implementação abaixo é a primeira desta microsprint.

---

## 2. Isolamento (comprovado)

| Controle | Evidência |
|---|---|
| Banco oficial | Nenhum comando desta microsprint abriu `C:\ProgramData\MercantilFiscal\dados` |
| Banco de teste | `DB_DIR` exclusivo em `%TEMP%\ms26-*` + `CDS_FORCAR_LOCAL=1` |
| Suítes 2.6 e 05.74 | SQLite `:memory:` para o documento sob teste |
| SEFAZ / certificado de produção | não utilizados; parser e MIIP injetados por mock |
| Banner `BANCO OFICIAL EM USO` | quando `database.js` carregou, o caminho foi o `.db` **temporário** |
| Grep `MercantilFiscal` nos logs das 11 suítes de regressão | **0 ocorrências** (`NO_MF`) |

Se o isolamento não pudesse ser comprovado, a microsprint seria interrompida. Aqui o isolamento foi comprovado pelos `DB_DIR` temporários e pela ausência do caminho oficial nos logs.

---

## 3. Causa raiz (com evidência no `HEAD`)

O progresso de **64% não é só visual**. É o estado honesto da UI de 14 etapas quando o XML está completo e o parser já rodou, mas o status canônico **não avançou**.

### 3.1 Por que a transição para o estado seguinte falha

Pipeline oficial: `localizar → parse → miip → persistir → status`.

A persistência de `parse_json` / `miip_resumo_json` ocorre **antes** de `transicionar(EM_PROCESSAMENTO → EM_REVISAO|PRONTA_IMPORTACAO)`.

Se essa transição lança (crash, I/O, validação, processo morto), o `catch` devolve `sucesso: false` com `etapaAtual: 'status'`. O documento permanece `XML_COMPLETO` (alias de `EM_PROCESSAMENTO` e `SINCRONIZADA`) **com parse e MIIP já gravados**.

Reprodução na suíte 2.6 (`1+2`): mock de transição que falha só no avanço pós-pipeline. Resultado:

- `sucesso: false`
- mensagem original `Transição simulada falhou: XML_COMPLETO → …`
- `parse_json` e `miip_resumo_json` persistidos
- `status` ainda `XML_COMPLETO`
- histórico: `Falha original no pipeline (status): …`

### 3.2 Qual exceção original é gerada

A exceção é a da **etapa `status`** (`DocumentoTransitionService.transicionar` / falha equivalente), não a do parser nem a do MIIP.

Antes, o `catch` não destacava a falha original no histórico de retomada. Agora registra:

`Falha original no pipeline (${etapaAtual}): ${mensagemOriginal}`

e **não** mascara essa exceção.

### 3.3 Por que a recuperação retornava cedo quando já existia `parseJson`

No `HEAD`, `CentralProcessamentoService.processar`:

```javascript
if (documento.parseJson && !opcoes.forcarReprocessamento) {
  return ProcessamentoResultadoDTO.create({
    sucesso: true,
    reutilizado: true,
    // … todas as etapas como concluida: true
    mensagem: 'Processamento já existente — resultado reutilizado'
  });
}
```

Qualquer `parseJson` truthy era tratado como **pipeline concluído**, mesmo com status ainda `XML_COMPLETO`. Retry, HealthMonitor e clique do operador saíam sem avançar o status.

### 3.4 Por que documentos presos não entravam na lista de recuperação

`listarPendentesProcessamento` no `HEAD`:

```sql
WHERE status = ?          -- SINCRONIZADA ≡ XML_COMPLETO
  AND empresa_id = ?
  AND (parse_json IS NULL OR parse_json = '')
```

O caso preso é exatamente `parse_json NOT NULL`. A fila automática da Central **excluía** os documentos que mais precisavam de retomada.

`PARADO_ETAPA` no Health só disparava após **6 h** e chamava `processar`, que caía no early-return acima.

### 3.5 O que já estava persistido antes da falha

| Campo | Persistido? |
|---|---|
| `xml` | sim |
| `parse_json` | sim (após etapa parse) |
| `miip_resumo_json` / `miip_sessao_id` | sim, se MIIP concluiu |
| `status` | **não avança** — permanece `XML_COMPLETO` |
| evento `PARSER_CONCLUIDO` | pode existir (passo UI `parser`) |
| passos UI `produtos` / `miip` | dependem de `posMiip`, que só olha aliases de revisão/compra |

### 3.6 Por que a UI mostra 64%

`frontend/erp/js/central-entradas-ux.js` tem 14 etapas. Com XML completo e status ainda `XML_COMPLETO`:

1. localizado, 2. res_nfe, 3. manif_enviada, 4. manif_ok,  
5. xml_solicitado, 6. xml_sefaz, 7. xml_baixado, 8. xml_validado, 9. parser  

`9 / 14 ≈ 64%`.

`posParser` / `posMiip` só consideram `AGUARDANDO_REVISAO`, `REVISADA`, `PRONTA_PARA_COMPRA`, `EM_COMPRA`, `GRAVADA`. Com status canônico `XML_COMPLETO`, MIIP não aparece como concluído **mesmo com `miip_resumo_json` no banco**. O percentual descreve o atraso de status; não foi alterado artificialmente.

---

## 4. Correção aplicada (somente o defeito comprovado)

### 4.1 Checkpoint, não “parse = concluído”

`processar` só reutiliza como concluído se:

- `parseJson` válido **e**
- status já está em `EM_REVISAO` / `PRONTA_IMPORTACAO` / `EM_IMPORTACAO` / `IMPORTADA` / `FINALIZADA`

Caso contrário, com XML/`parse` e status `XML_COMPLETO`, retoma o pipeline.

### 4.2 Pular só o que já está válido

| Situação | parse | MIIP | persistir | status |
|---|---|---|---|---|
| parse+MIIP válidos, status incompleto | pula | pula | pula | executa |
| parse válido, MIIP ausente/inválido | pula | executa | executa | executa |
| nada persistido | executa | executa | executa | executa |

`miipValido` exige objeto com `resumo`, `resultados` ou `operacaoId` — JSON vazio/`null` não conta.

### 4.3 Persistência e máquina de estados

- Não marca concluído um documento com processamento parcial.
- A máquina de estados não foi reescrita: `XML_COMPLETO → EM_PROCESSAMENTO` é no-op canônico (`a === n`); o avanço real continua `XML_COMPLETO → EM_REVISAO|PRONTA_IMPORTACAO`.
- Histórico guarda a exceção original da etapa que falhou.
- Lock por `documentoId` (fila em memória) para concorrência; após reinício o lock some e o checkpoint no banco permite retomar.
- `empresaId` obrigatório; `listarPendentesProcessamento` continua `AND empresa_id = ?` sem `COALESCE` / fallback global.

### 4.4 Fila e Health

- Fila: todos os `XML_COMPLETO` da empresa (com ou sem parse).
- Nova regra `PROCESSAMENTO_INCOMPLETO`: auto-recuperável, `acaoInterna: processar_pendentes`, **sem esperar 6 h**.

### 4.5 T08 (05.74)

O teste antigo esperava `reutilizado: true` só porque havia `parseJson` — exatamente o defeito. Foi atualizado para retomar com mocks (parser que falha se reexecutado) e **continuar** afirmando isolamento B. Schema `:memory:` ganhou colunas usadas na persistência real (`miip_*`, `updated_at`, …). Isolamento A/B não foi enfraquecido.

---

## 5. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/services/CentralProcessamentoService.js` | checkpoint, skip parse/MIIP, lock, exceção original, deps injetáveis |
| `backend/motores/central-entradas/contracts/ProcessamentoResultadoDTO.js` | `recuperado`, `etapasPuladas` |
| `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js` | fila inclui incompletos; exige `empresaId` |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | comentário da fila |
| `backend/motores/central-entradas/health/HealthRules.js` | `PROCESSAMENTO_INCOMPLETO` |
| `tests/central-entradas/isolamento-fila-processamento-05-74.test.js` | T08 + schema |
| `tests/central-entradas/microsprint-26-recuperacao-processamento.test.js` | suíte obrigatória (nova) |
| `docs/central-entradas/microsprint-2-6-recuperacao-processamento-relatorio.md` | este relatório |

`git diff --stat` (arquivos rastreados desta microsprint):

```
CentralEntradasOrchestrator.js                 |   4 +-
ProcessamentoResultadoDTO.js                   |   4 +
HealthRules.js                                 |  19 ++
CentralDocumentosRepository.js                 |   4 +-
CentralProcessamentoService.js                 | 254 ++++++++++++++++-----
isolamento-fila-processamento-05-74.test.js    |  28 ++-
6 files changed, 254 insertions(+), 59 deletions(-)
```

---

## 6. Comandos executados

```text
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
git log -1 --oneline
git show HEAD:backend/motores/central-entradas/services/CentralProcessamentoService.js
git show HEAD:backend/motores/central-entradas/repositories/CentralDocumentosRepository.js
git diff --stat -- backend/motores/central-entradas tests/central-entradas

# Isolamento por suíte
DB_DIR=%TEMP%\ms26-*   CDS_FORCAR_LOCAL=1

node --test tests/central-entradas/microsprint-26-recuperacao-processamento.test.js
node tests/central-entradas/isolamento-fila-processamento-05-74.test.js
node tests/central-entradas/maquina-estados.test.js
node tests/central-entradas/central-entradas-sprint2.test.js
… sprint4, sprint5, sprint7, sprint8, sprint9, sprint10 …
node tests/central-entradas/rc1-consolidacao.test.js
node tests/central-entradas/rc2-diagnostico.test.js
node tests/central-entradas/rc346-health-monitor.test.js
```

Node: `v24.19.0`. Sem `npm test` global, sem SEFAZ, sem commit.

---

## 7. Testes obrigatórios

### 7.1 Suíte Microsprint 2.6 — **10/10 pass**

`tests/central-entradas/microsprint-26-recuperacao-processamento.test.js`

| # | Caso | Resultado |
|---|---|---|
| 1 | 64% = 9/14 com XML completo e status `XML_COMPLETO` | pass |
| 1+2 | Preso em `XML_COMPLETO` após falha real na transição | pass |
| 3+4 | Recuperação com parser+MIIP persistidos **não** reexecuta | pass (`parseCalls=0`, `miipCalls=0`) |
| 5 | `parseJson` existe, MIIP incompleto → só MIIP | pass |
| 6 | Persistência parcial permanece `XML_COMPLETO` e entra na fila | pass |
| 7 | Idempotência, concorrência (`Promise.all`) e reinício (`reutilizado` após avanço) | pass |
| 8 | Histórico/eventos: falha original + mensagem de retomada | pass |
| 9 | `empresaId` obrigatório; isolamento A/B | pass |
| Health | `PROCESSAMENTO_INCOMPLETO` auto-recuperável sem 6 h | pass |
| Extra | Não considera concluído só porque `parseJson` existe | pass |

Duração final: ~9,5 s. `EXIT_26=0`.

### 7.2 Isolamento 05.74 — **12/12 pass**

`EXIT_0574=0`. T08 retoma A sem mutar B; T01–T07 e T09–T12 preservam MULTIEMPRESA.

### 7.3 Regressão `test:central-entradas` (rc1 + nove relacionadas)

Cada suíte com `DB_DIR` próprio. `MercantilFiscal`: 0 hits.

| Suíte | Exit | Contagem | Nota |
|---|---|---|---|
| `maquina-estados.test.js` | 0 | 11/0 | ok |
| `central-entradas-sprint2.test.js` | 1 | 5/3 | pré-existente CE-05/CE-06 |
| `central-entradas-sprint4.test.js` | 1 | 3/2 | pré-existente |
| `central-entradas-sprint5.test.js` | 1 | 3/4 | `EMPRESA_CENTRAL_AUSENTE` (05.74) |
| `central-entradas-sprint7.test.js` | 1 | 10/1 | pré-existente |
| `central-entradas-sprint8.test.js` | 0 | 8/0 | ok |
| `central-entradas-sprint9.test.js` | 1 | 6/1 | pré-existente |
| `central-entradas-sprint10.test.js` | 1 | 4/3 | pré-existente |
| **`rc1-consolidacao.test.js`** | 1 | 5/4 | ver §7.4 |
| `rc2-diagnostico.test.js` | 0 | 9/0 | ok |

Extra Health: `rc346-health-monitor.test.js` exit 1 em `SEM_PARSER` — **já documentado na 05.75** (`HealthRules` compara o literal `'SINCRONIZADA'` ao status canônico `XML_COMPLETO`). Não foi enfraquecido. A regra nova `PROCESSAMENTO_INCOMPLETO` é adicional.

### 7.4 rc1 — falhas não introduzidas pela 2.6

| Teste rc1 | Mensagem | Origem |
|---|---|---|
| transição inválida | `The validation function is expected to return "true"` / FK | aliases RC3.7.1 + `inserir` sem empresa |
| reutiliza parse existente | `MULTIEMPRESA exige empresa explícita para processar` | 05.74 |
| bridge não reexecuta Parser/MIIP | idem | 05.74 |
| listarPendentes sem parse | `MULTIEMPRESA exige empresa explícita para listar pendências` | 05.74 |

Os testes da 2.6 cobrem o comportamento correto **com** `empresaId`. Não se removeu a obrigatoriedade de empresa para fazer o rc1 passar.

---

## 8. Evidências de recuperação

1. **Defeito reproduzido:** parse+MIIP gravados, status `XML_COMPLETO`, `sucesso: false`, etapa `status`, histórico com a mensagem original.
2. **Retomada:** segunda `processar` com `recuperado: true`, `etapasPuladas` contendo `parse` e `miip`, zero chamadas a parser/MIIP, status `PRONTA_IMPORTACAO`.
3. **MIIP incompleto:** só a etapa MIIP reexecuta.
4. **Concorrência:** duas `processar` simultâneas no mesmo id; um único avanço de status.
5. **Reinício:** terceira chamada após status avançado → `reutilizado: true`.
6. **MULTIEMPRESA:** sem `empresaId` lança `EMPRESA_CENTRAL_AUSENTE`; processar A não altera B.
7. **Fila:** documento com parse incompleto **entra** em `listarPendentesProcessamento(empresaId)`.

---

## 9. Limitações restantes

1. **UI `posParser`/`posMiip`** ainda usam aliases pré-RC3.7.1. Documento **preso** em `XML_COMPLETO` continua em ~64% (honesto). Após a recuperação o backend grava `EM_REVISAO` / `PRONTA_IMPORTACAO`; a UI pode atrasar os passos MIIP/compra até alinhar os aliases. **Não** se alterou a fórmula de percentual nesta microsprint.
2. **`SEM_PARSER` no Health** continua comparando `'SINCRONIZADA'` literal — falha pré-existente da rc346; fora do escopo da retomada de parse persistido.
3. **Lock de concorrência** é por processo (Map em memória). Após restart a segurança vem do checkpoint no SQLite, não do Map.
4. **Linhas legado** com o texto `EM_PROCESSAMENTO` não migrado: a fila SQL usa o canônico `XML_COMPLETO` (`DocumentoFiscalStatus.SINCRONIZADA`).
5. Suítes rc1/sprint2/4/5/7/9/10/rc346 **já falhavam** na CE-05/CE-06 (empresa obrigatória / aliases). Não foram reescritas para obter aprovação.

---

## 10. Critérios de conclusão

| Critério | Status |
|---|---|
| Defeito reproduzido e explicado | sim (§3, teste 1+2) |
| Recuperação sem duplicar etapas concluídas | sim (testes 3+4, 5, extra) |
| Estados persistidos coerentes | sim (`XML_COMPLETO` na falha; `PRONTA_IMPORTACAO`/`EM_REVISAO` na retomada) |
| Testes obrigatórios da 2.6 e 05.74 | 10/10 e 12/12 |
| Banco oficial e SEFAZ intocados | sim (§2) |
| Work fiscal/vendas preexistente preservado | sim |
| Commit/push | **não executados** |

**Microsprint 2.6 concluída** no código e nos testes isolados. Integração em ambiente real fica para homologação operacional, sem uso de certificado de produção nesta execução.
