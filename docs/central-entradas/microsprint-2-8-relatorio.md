# Microsprint 2.8 — Alinhamento dos testes legados da Central de Entradas

**Prioridade:** P0  
**Prazo do projeto:** 25/10/2026  
**Tipo:** correção de testes, fixtures e compatibilidade com contratos canônicos  
**Data:** 17/10/2026  
**Resultado:** suítes legadas alinhadas ao contrato `empresaId` (05.74) e aos estados RC3.7.1, **sem** fallback global e **sem** reimplementar a recuperação 2.6. `npm run test:central-entradas` passou. Isto **não** é homologação operacional.

---

## 1. Branch e HEAD (antes da execução)

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Subject | `implemetação Diversas` |

## 2. Git inicial e work preexistente preservado

Não commitado **antes** desta microsprint (preservado):

- 2.6 / 2.7: `CentralProcessamentoService`, repositório, HealthRules `SEM_PARSER`, UX `posParser`/`posMiip`, suítes `microsprint-26` e `microsprint-27`, relatórios 2.6 e 2.7
- Fiscal/vendas/faturamento e `tests/fiscal/*`
- `docs/bancario/OF-01-AUDITORIA-ITAÚ.md`

Não houve `git reset`, `checkout` destrutivo, `clean`, commit, push ou merge.

A recuperação 2.6 **não foi reimplementada**. `SEM_PARSER` canônico e o progresso UI da 2.7 **não foram revertidos**.

---

## 3. Causa individual de cada falha investigada

Baseline reproduzido na 2.7 (mesma branch/HEAD de trabalho): rc1 5/4, sprint2 5/3, sprint4 3/2, sprint5 3/4, sprint7 10/1, sprint9 6/1, sprint10 4/3.

| Suíte | Falha | Causa comprovada | Classe |
|---|---|---|---|
| RC1 / Sprint 5 / Sprint 10 | `EMPRESA_CENTRAL_AUSENTE` | Teste chamava `processar` / upload / fila **sem** `empresaId`; fixture sem `empresa_id`. Contrato 05.74 correto. | TEST_CONFIG |
| RC1 | transição `SINCRONIZADA`→`GRAVADA` esperada inválida | Ambos canônicos: `XML_COMPLETO`→`IMPORTADA`, **permitida** em RC3.7.1. `transicionar(1,…)` ainda gerava FK. | TEST_STALE |
| Sprint 2 | PATCH `EM_PROCESSAMENTO` | Alias de `XML_COMPLETO` (no-op); histórico não grava `atual === novo`. | TEST_STALE |
| Sprint 2 | PATCH `GRAVADA` “inválido” | `XML_COMPLETO`→`IMPORTADA` é válida. | TEST_STALE |
| Sprint 2 | filtro `EM_PROCESSAMENTO` | Status persistido é `XML_COMPLETO`. | TEST_STALE |
| Sprint 4 | duplicata `false !== true` | `UNIQUE(chave, empresa_id)` no SQLite **não colide** com `empresa_id NULL`; `buscarPorChave` sem empresa retorna `null`. | TEST_CONFIG |
| Sprint 4 | `buscarPorChave` sem empresa | Contrato 05.70/05.74: sem `empresaId` não há lookup global. | TEST_CONFIG |
| Sprint 7 | `scoreGeral >= 90` com `GRAVADA` | `GRAVADA` e `DUPLICADA` são a **mesma** chave canônica `IMPORTADA`; o mapa sobrescrevia 100 com 25. Defeito funcional de aliases, não da fórmula. | PROD_ALIAS + TEST |
| Sprint 9 | `'offline' !== 'sincronizando'` | Node 24 expõe `navigator` nativo; `global.navigator = …` não substitui o descritor. | TEST_ENV |

---

## 4. Arquivos modificados e justificativa

| Arquivo | Justificativa |
|---|---|
| `tests/central-entradas/helpers/empresaTesteCentral.js` | Fixture explícita de empresa; **não** é fallback de produção |
| `tests/central-entradas/rc1-consolidacao.test.js` | `empresaId` nas chamadas; transição inválida `XML_COMPLETO`→`NOVA`; isolamento A/B |
| `tests/central-entradas/central-entradas-sprint2.test.js` | Transição real `XML_COMPLETO`→`EM_REVISAO`; inválida `→ NOVA` |
| `tests/central-entradas/central-entradas-sprint4.test.js` | Persistência com `empresaId`; prova UNIQUE no DDL e no INSERT |
| `tests/central-entradas/central-entradas-sprint5.test.js` | Pipeline e compras com `empresaId` / `empresaIdContexto` |
| `tests/central-entradas/central-entradas-sprint10.test.js` | Upload com `empresaId` |
| `tests/central-entradas/central-entradas-sprint7.test.js` | Score em `IMPORTADA` / `EM_REVISAO` |
| `tests/central-entradas/central-entradas-sprint9.test.js` | Mock determinístico de `navigator` via `defineProperty` + restore |
| `backend/motores/central-entradas/services/CentralScoreDocumentoService.js` | Chaves **canônicas únicas** no mapa de status (colisão GRAVADA/DUPLICADA). Pesos inalterados |

Não foram alterados: `CentralProcessamentoService` (2.6), HealthRules `SEM_PARSER` (2.7), UX progresso (2.7), máquina de estados, unicidade de produção, fiscal/vendas.

---

## 5. Correções aplicadas (testes e fixtures)

- Empresa de teste criada com `INSERT` explícito em `empresas`; o id é passado em **todas** as operações que o contrato exige.
- Documentos inseridos com `empresa_id` da empresa do teste.
- `buscarPorChave(chave, empresaId)` e `listarPendentesProcessamento(limite, empresaId)`.
- RC1: sem `empresaId` a fila **continua** lançando `EMPRESA_CENTRAL_AUSENTE`; processar A não altera documento B da empresa B.
- Transição inválida comprovada: `XML_COMPLETO` → `NOVA` (`validarTransicao.valido === false`).
- Sprint 4: segundo `persistirDocumentoDfe` com o mesmo par chave+empresa retorna `duplicado`; `sqlite_master` contém `UNIQUE(chave, empresa_id)`; INSERT SQL duplicado falha com UNIQUE.
- Sprint 9: mock isolado, restaurado no `finally`; sem variável global persistente.
- Score: mapa passou a usar `IMPORTADA`, `PRONTA_IMPORTACAO`, `EM_IMPORTACAO`, `EM_REVISAO`, `XML_COMPLETO`, etc., sem duas entradas no mesmo valor canônico.

---

## 6. Testes executados (comandos reais)

Isolamento: `DB_DIR=%TEMP%\ms28-*`, `CDS_FORCAR_LOCAL=1`. Node `v24.19.0`.

| Comando | Exit | Resultado |
|---|---|---|
| `node tests/central-entradas/central-entradas-sprint2.test.js` | 0 | 8/0 |
| `node tests/central-entradas/central-entradas-sprint4.test.js` | 0 | 5/0 |
| `node tests/central-entradas/central-entradas-sprint5.test.js` | 0 | 7/0 |
| `node tests/central-entradas/central-entradas-sprint7.test.js` | 0 | 11/0 |
| `node tests/central-entradas/central-entradas-sprint9.test.js` | 0 | 7/0 |
| `node tests/central-entradas/central-entradas-sprint10.test.js` | 0 | 7/0 |
| `npm run test:central-entradas-rc1` ≡ `node tests/central-entradas/rc1-consolidacao.test.js` | 0 | 9/0 |
| `node tests/central-entradas/maquina-estados.test.js` | 0 | 11/0 |
| `node tests/central-entradas/central-entradas-sprint8.test.js` | 0 | 8/0 |
| `node tests/central-entradas/rc2-diagnostico.test.js` | 0 | 9/0 |
| `node tests/central-entradas/rc346-health-monitor.test.js` | 0 | RC3.4.6 OK |
| `node --test tests/central-entradas/microsprint-26-recuperacao-processamento.test.js` | 0 | 10/10 |
| `node --test tests/central-entradas/microsprint-27-estabilizacao.test.js` | 0 | 5/5 |
| `node tests/central-entradas/isolamento-fila-processamento-05-74.test.js` | 0 | 12/12 |
| `npm run test:central-entradas` | 0 | consolidado verde |

Grep `MercantilFiscal` nos logs: **0** (`NO_MF`). Logs `SEFAZ_GATE` no sprint8 são **stubs de teste**, sem transmissão real.

---

## 7. Antes / depois (baseline reproduzido na 2.7)

| Suíte | Antes (2.7) | Depois (2.8) |
|---|---|---|
| sprint2 | 5/3 | **8/0** |
| sprint4 | 3/2 | **5/0** |
| sprint5 | 3/4 | **7/0** |
| sprint7 | 10/1 | **11/0** |
| sprint9 | 6/1 | **7/0** |
| sprint10 | 4/3 | **7/0** |
| rc1 | 5/4 | **9/0** |
| `test:central-entradas` | falhava | **exit 0** |
| 2.6 / 2.7 / 05.74 / rc346 / máquina / sprint8 / rc2 | já verdes | **permanecem verdes** |

---

## 8. Falhas residuais

Nenhuma nas suítes deste escopo.

Ruído de schema (`duplicate column tef_*`, `DELETE sem WHERE` em `mib_kg_edges`) já existia no boot do `database.js` em banco temporário vazio; **não** é falha das assertions.

---

## 9. Isolamento do banco

- `DB_DIR` exclusivo em `%TEMP%\ms28-*`
- Suítes 2.6 / 2.7 / 05.74 em `:memory:` para o documento sob teste
- Nenhum comando abriu `C:\ProgramData\MercantilFiscal\dados`

## 10. SEFAZ e certificados

Não houve consulta, manifestação, transmissão nem uso de certificado de produção. Parser/MIIP das suítes rc1/sprint5/10 usam fixture XML local.

## 11. Git

Sem commit, push ou merge.

## 12. Riscos e próxima etapa

1. Testes verdes **não** homologam o fluxo real (entrada → processamento → revisão → importação → estoque).
2. O mapa de score agora pontua `IMPORTADA` como 100; o estado legado “duplicada” não tem nota própria porque RC3.7.1 o unificou a `IMPORTADA`.
3. Outras suítes fora de `test:central-entradas` (rc3, rc31, rc4, …) não foram reescritas nesta microsprint.
4. Integração bancária real continua bloqueada (OF-01 / Itaú).

**Recomendação:** homologação operacional controlada da Central (entrada, processamento, revisão, importação, isolamento multiempresa e estoque) em ambiente de teste, depois ficha técnica para 25/10/2026.

**Microsprint 2.8 concluída** no escopo de testes e no defeito comprovado de chaves de score. Sem alegação de homologação completa.
