# Sprint final CE-ENCERRAMENTO-01 — Correção definitiva e estabilização da Central de Entradas

**Tipo:** estabilização / fail-closed  
**Data:** 18–19/10/2026  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Baseline e estado real do workspace

Workspace já continha P0.9–P0.14 (decisão unificada, primeira DistDFe real, forense 656, fail-closed parcial com janela 24 h).

**Baseline alterada nesta sprint (não restaurar ZIP por cima):**

| Área | Estado pré-sprint | Estado pós-sprint |
|---|---|---|
| FILA pós-656 | Timer 24 h após `data_sincronizacao` | **Sticky** — sem liberação por timer |
| Reavaliação | Automática após 24 h | Cursor (`ult≠max`) **ou** `liberarFilaEsgotadaAutorizada` |
| Mutex | Só in-process | In-process + **lock file** por CNPJ/ambiente |
| Transporte DistDFe | Auth só em `sincronizarDistribuicaoDFe` | Auth também em `enviarDistribuicaoDfe` (runtime) |
| Probe | Fail-closed Gate + decisão (P0.14) | Mantido + auth no transporte |
| Auditoria `empresa_id` | Frequentemente null | Preenchido nos registros DistDFe; eventos via `detalhe_json` |
| CorrelationId sync | Gerava SYNC-* novo | Usa `deps.correlationId` da orquestração quando presente |

---

## 2. ZIP × workspace

Não foi aplicado ZIP. Implementações P0.11–P0.14 no workspace foram preservadas e estendidas. Relatórios antigos que descrevem FILA só com 137/138 ou janela 1 h/24 h estão **desatualizados** em relação a este encerramento.

---

## 3. Causa local corrigida

A P0.12/P0.13 mostraram: após 656 com `ult=max`, expirar `cooldown_ate` (1 h) gerava `PRONTO_PARA_CONSULTA` e nova DistDFe indevida.

P0.14 incluiu 656 na FILA, mas ainda liberava após **24 h** — incompatível com “não liberar por timer”.

**Correção final:** FILA_ESGOTADA **sticky** enquanto `ultNSU=maxNSU` e `ultimo_cstat ∈ {137,138,656}`. Cooldown 656 (1 h) permanece prioridade. Sem SOAP implícito para “testar” a fila.

---

## 4. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `CentralNsuService.js` | FILA sticky; `liberarFilaEsgotadaAutorizada`; mensagens |
| `CentralConsultaDistDfeDecisaoService.js` | Códigos FILA/inconsistência; mutex com escopo; aviso PRONTO |
| `SefazTransmissaoMutex.js` | Lock file interprocesso por CNPJ+ambiente |
| `distribuicaoDfeRuntime.js` | Barreira `avaliarAutorizacaoTransmissao` no transporte |
| `distribuicaoDFe.js` | Escopo mutex; `empresa_id` auditoria; correlation unificado |
| `CentralDiagnosticoService.js` | Auth no probe SOAP |
| `CentralOperacaoFiscalRealService.js` | Pré-voo com código FILA (já P0.14, mantido) |
| `CentralSincronizacaoService.js` / `CentralSyncExecucaoService.js` | Compat códigos / eventos com empresaId |
| `centralEventosEmitter.js` | `empresaId`/`correlationId` no detalhe |
| `docs/.../migrations/ce-encerramento-01-eventos-empresa-id.sql` | Migração **preparada**, não executada |
| Testes P0.9/P0.11/P0.14/auditoria + `sprint-final-ce-encerramento-01.test.js` | Aceite isolado |

Módulos comerciais/PDV/TEF/estoque/financeiro/NFC-e saída: **não alterados**.

---

## 5. Fluxos de transmissão auditados

| Caminho | Decisão centralizada | Auth transporte | Mutex |
|---|---|---|---|
| Consulta real OPERACAO_REAL | Sim | Sim (sync + runtime) | Sim + file |
| Sync orquestrado / BACKGROUND / abrir Central | Sim | Sim | Sim + file |
| Probe diagnóstico (`forcarProbeDistDfe`) | Sim + Gate fail-closed | Sim | Sim |
| Runtime direto / legado via runtime | — | **Obrigatória** | via caller |
| Recuperação XML | Não autoriza DistDFe (`ativa=false`) | N/A | Gate/cooldown se tentar |
| MIRX / manifestação | Auth própria; DistDFe via sync com barreira | Sim | Sim |

---

## 6. Regra final 656 / fila esgotada

1. **656:** preserva NSU; `maxNSU=0` remoto não redefine cursor; `cooldown_ate` +1 h (`COOLDOWN_EXPLICITO`).
2. Após expirar cooldown, se ainda `ult=max` e cStat 656 → **`FILA_ESGOTADA` sticky**.
3. **137** com `ult=max` → FILA sticky.
4. **138** com `ult<max` → não FILA; com `ult=max` (após persistência OK) → FILA sticky.
5. Persistência incompleta → NSU **não** avança (já existente).
6. `forcar` / `ignorarCooldown` **não** liberam.

---

## 7. Estratégia de reavaliação

| Mecanismo | Envia SOAP? | Altera NSU? |
|---|---|---|
| Avanço legítimo `ult≠max` (apply 137/138 após DistDFe autorizada prévia) | Não por si só | Apenas via apply válido |
| `liberarFilaEsgotadaAutorizada` (`confirmacaoLiberacaoFila` + auth) | **Não** | **Não** — grava `ultimo_cstat=FILA_LIBERADA_OP` |
| Timer / forcar / fallback | Proibidos | — |

Procedimento futuro para DistDFe real: autorização OPERACAO_REAL específica **após** liberação operacional (se sticky) **e** cooldown 656 expirado — sem sondagem automática.

---

## 8. Concorrência entre processos

`SefazTransmissaoMutex`:

- Lock in-process por chave `tipo__cnpj__ambiente` (ou global).
- Lock file exclusivo (`wx`) em `CDS_SEFAZ_LOCK_DIR` / `FISCAL_DIR/sefaz-locks` / temp isolado.
- Falha de filesystem → **fail-closed** (`MUTEX_INTERPROCESSO_INDISPONIVEL`).
- Teste isolado: duas instâncias, mesma chave → segunda bloqueada.

---

## 9. Rastreabilidade e auditoria

- `dfe_auditoria`: `empresa_id` preenchido nos registros DistDFe (consulta, NSU, resumo, ZIP/parser/persistência).
- Eventos: `empresaId`/`correlationId`/`ambiente` no `detalhe_json` (CREATE atual sem coluna `empresa_id`).
- Migração preparada: `docs/central-entradas/migrations/ce-encerramento-01-eventos-empresa-id.sql` — **não executada** em produção nesta sprint.
- CorrelationId da orquestração reutilizado na sync quando informado.
- Sem certificados/tokens/CNPJ completo em mensagens de bloqueio.

---

## 10. Testes executados (resultados reais)

Execução isolada (preload + `DB_DIR` temp; sem SOAP; sem oficial):

| Suíte | Resultado |
|---|---|
| `sprint-final-ce-encerramento-01.test.js` | **18/18 OK** |
| `microsprint-p0-14-correcao-fila-esgotada-656.test.js` | **14/14 OK** |
| `microsprint-auditoria-cooldown-distdfe.test.js` | **12/12 OK** |
| `microsprint-p0-11-...` + `nfe-nao-localizada-sync` | **24/24 OK** |
| `microsprint-p0-9-3-diagnostico-http-422-...` | **14/14 OK** |
| `microsprint-p0-9-cobertura-soap-legado-regressao` | **15/15 OK** |

**Total contabilizado nesta sprint:** 97 testes OK nas suítes acima (execução por arquivo para evitar contaminação de `DB_DIR`/schema entre processos Node compartilhados).

---

## 11. Testes não executados

- DistDFe/consChNFe/manifestação reais (proibidos).
- Suíte comercial completa (fora do escopo; módulos não alterados).
- Migração de `central_entradas_eventos.empresa_id` em banco oficial (só preparada).
- Multi-arquivo no mesmo processo Node: flaky por boot `database.js` compartilhado — validado arquivo a arquivo.

---

## 12. Confirmações de proteção

- Nenhuma operação fiscal remota nesta sprint.
- Nenhuma escrita no banco oficial; NSU/cooldown/flags de produção intactos.
- Sem `CDS_ALLOW_OFFICIAL_DB=1`, sem Electron/`server.js` para validar.
- Sem commit/push/merge.

---

## 13. Riscos residuais e impedimentos

1. Coluna `empresa_id` em `central_entradas_eventos` ainda depende de migração futura (hoje só `detalhe_json`).
2. Lock file depende de filesystem gravável; se falhar, transmissão é bloqueada (fail-closed) — pode exigir ajuste de `CDS_SEFAZ_LOCK_DIR` em deploy.
3. Mutex não cobre cliente SEFAZ externo ao CDS.
4. Liberação operacional `FILA_LIBERADA_OP` exige disciplina operacional — UI/rota administrativa ainda pode ser exposta em sprint futura (API de liberação não foi adicionada nesta entrega; método de serviço existe).
5. Esta sprint **não prova** aceitação SEFAZ de futura DistDFe.

**Não é impedimento de segurança de transmissão:** caminhos conhecidos passam por decisão + auth + mutex.

---

## 14. Decisão de encerramento

### **APROVADO COM RESSALVAS**

Ressalvas: migração de coluna de eventos pendente de aplicação controlada; liberação operacional ainda sem rota HTTP dedicada; prova SEFAZ futura exige autorização específica.

A Central de Entradas fica **segura, previsível e verificável** para retomada dos demais módulos do CDS, **sem novas consultas de produção nesta sprint**.

---

## Referências

- P0.11–P0.14 em `docs/central-entradas/`
- Teste mestre: `tests/central-entradas/sprint-final-ce-encerramento-01.test.js`
