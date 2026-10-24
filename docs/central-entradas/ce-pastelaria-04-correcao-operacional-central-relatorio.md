# CE-PASTELARIA-04 — Correção operacional da Central de Entradas

**Tipo:** correção operacional (sem SEFAZ · sem banco oficial)  
**Data:** 18–19/10/2026  
**Referência:** CE-PASTELARIA-03  
**Veredito:** **APROVADO COM RESSALVAS**

---

## 1. Proteções respeitadas

- [x] Sem DistDFe / consChNFe / 210210 / SOAP  
- [x] Sem abrir/alterar banco oficial de produção  
- [x] Sem mutar NSU, cooldown, flags, certificados ou OPERACAO_REAL em produção  
- [x] Sem liberar FILA em produção  
- [x] Sem `database.js` de produção / migrações no oficial  
- [x] Sem restaurar `/sincronizar` do CDS Sistemas como caminho real  
- [x] Sem remover OPERACAO_REAL  
- [x] Sem commit / push / merge / reset  

---

## 2. Etapa A — Mapa dos caminhos até SOAP DistDFe

| # | Origem | Empresa-alvo | Auth | Decisão centralizada | Cooldown/FILA | Lock | Ponto SOAP | Tratamento erro / unlock |
|---|---|---|---|---|---|---|---|---|
| 1 | UI → `consultarDfeReal` → `POST …/consultar-dfe` | `empresaId` explícito | OPERACAO_REAL emitida + viva | Sim | Sim | mutex + file lock | `distribuicaoDFe` → `distribuicaoDfeRuntime` | fail-closed; finally libera lock |
| 2 | `POST /sincronizar` / sync manual | alvos multiempresa | **Agora obrigatória na decisão** (sem auth → bloqueio) | Sim | Sim | Sim | Só se decisão PRONTO **e** barreira SOAP aceitar | não transmite sem auth |
| 3 | BACKGROUND (`CentralSyncBackgroundService`) | todas as ativas (plano) | **Auth obrigatória na decisão** (BACKGROUND não recebe OPERACAO_REAL) | Sim | Sim | Sim | **Bloqueado antes do SOAP** | log `BLOQUEADO_AUTH`; ciclo reagenda |
| 4 | `sincronizarAoAbrir` | idem | Idem sync | Sim | Sim | Sim | Bloqueado sem auth | idem |
| 5 | Diagnóstico / probe DistDFe | opcional | Exige `forcarProbeDistDfe` + auth (já restrito) | Sim (quando consulta) | Sim | — | Só com flags explícitas de teste | fail-closed |
| 6 | MIRX / Motor recuperação XML | por documento | `autorizaTransmissaoSefaz=false` | N/A transmissão | — | — | **Não transmite** (auth negada) | eventos de bloqueio |
| 7 | Liberar FILA (admin) | empresa explícita | OPERACAO_REAL ativada + admin | N/A (local) | não contorna cooldown 656 | — | **Nunca SOAP** | evento auditável obrigatório |
| 8 | Manifestação 210210 | documento | fluxo próprio (fora DistDFe) | Gate próprio | — | — | SOAP manifesto (não DistDFe) | fora do escopo DistDFe |

### Risco residual documentado (antes → depois)

| Caminho | Risco antes | Depois CE-04 |
|---|---|---|
| BACKGROUND com `permitirSemAutorizacao` | Decisão liberava; SOAP era a última barreira. Histórico comprovou SOAP 656 via `background`. | Decisão **exige auth**; BACKGROUND sem OPERACAO_REAL **não chega ao SOAP**. |
| `/sincronizar` / abrir_central | Mesmo padrão permissivo na decisão | Auth obrigatória na decisão (`permitirSemAutorizacao: false`) |
| Liberação FILA | Só log operacional; sem evento em `central_entradas_eventos` | Evento `FILA_ESGOTADA_LIBERACAO_OP` obrigatório; falha do evento reverte marcador |

---

## 3. Arquivos e funções modificados

| Arquivo | Mudança |
|---|---|
| `CentralConsultaDistDfeDecisaoService.js` | BACKGROUND / abrir_central / CONSULTA_DFE_REAL ignoram `permitirSemAutorizacao`; valida `empresaId` da auth; `diagnosticarEmpresa` usa `somenteDiagnostico` |
| `CentralSincronizacaoService.js` | Sempre `verificarAutorizacao: true` e `permitirSemAutorizacao: false` |
| `CentralSyncBackgroundService.js` | Documenta fail-closed; log quando sync bloqueada sem auth |
| `centralEventosTipos.js` | Tipo `FILA_ESGOTADA_LIBERACAO_OP` |
| `centralEventosEmitter.js` | `emitirEventoObrigatorio` (não engole erro) |
| `CentralEventosRepository.js` | `buscarPorTipoECorrelationId` |
| `CentralNsuService.js` | Liberação emite evento; rollback se evento falhar; idempotência por correlação / já liberada |
| `CentralOperacaoFiscalRealService.js` | Propaga `correlationId`, `cnpj`, `ambiente`, `eventoId` na liberação |
| `procedures/preparacaoRecuperacaoNfe4456.js` | **Novo** — checklist mockável (sem SOAP) |
| Testes CE-02 / P0.14 / ENC / auditoria | Inject de emitter mock para não abrir DB default |

**Migrações:** nenhuma necessária — evento usa tabela `central_entradas_eventos` existente (`detalhe_json`).

---

## 4. Antes / depois da proteção

### BACKGROUND / sync automático

- **Antes:** decisão com `permitirSemAutorizacao: true` (exceto CONSULTA_DFE_REAL); transmissão dependia só da barreira SOAP.  
- **Depois:** decisão bloqueia com `AUTORIZACAO_AUSENTE` sem modo de auth; `forcar` / `ignorarCooldown` continuam sem bypass; FILA/cooldown preservados.

### Liberação FILA

- **Antes:** atualiza `ultimo_cstat=FILA_LIBERADA_OP` + log; sem linha em `central_entradas_eventos`.  
- **Depois:** persiste `FILA_ESGOTADA_LIBERACAO_OP` com empresa, CNPJ, ambiente, usuário, motivo, estados, correlação; falha do evento → rollback do cStat; mesma correlação não duplica.

---

## 5. Testes executados

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/ce-pastelaria-04-correcao-operacional-central.test.js
→ 17/17 pass

node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/ce-pastelaria-03-investigacao-nfe-4456.test.js
→ 12/12 pass

node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/sprint-final-ce-encerramento-01.test.js
→ 18/18 pass

node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe.test.js \
  tests/central-entradas/microsprint-p0-14-correcao-fila-esgotada-656.test.js
→ 23/23 pass

node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/microsprint-p0-11-normalizacao-cooldown-consulta-controlada.test.js
→ 15/15 pass
```

| # | Caso CE-04 | Resultado |
|---|---|---|
| 1 | BACKGROUND sem auth | PASS |
| 2 | BACKGROUND + cooldown | PASS |
| 3 | BACKGROUND + FILA | PASS |
| 4 | abrir_central + FILA | PASS |
| 5 | forcar/ignorarCooldown sem bypass (fonte) | PASS |
| 6 | NSU indisponível fail-closed | PASS |
| 7 | Concorrência mutex | PASS |
| 8 | Liberação sem SOAP | PASS |
| 9 | Evento com empresa/correlação | PASS |
| 10 | Falha evento reverte | PASS |
| 11 | Anti-duplicata correlação | PASS |
| 12 | Isolamento emp. 1/2/3 | PASS |
| 13 | Persistência por empresa | PASS |
| 14 | Sem retry 656 | PASS |
| 15 | Regressão + procedimento 4456 | PASS |
| 16 | Mapa BACKGROUND/sync | PASS |

Sem SEFAZ. Sem alteração do banco oficial.

---

## 6. Etapa D — Integridade multiempresa (síntese)

Comprovado por testes/código:

- Decisão exige `empresaId` + CNPJ + ambiente.  
- Auth com `empresaId` divergente → `AUTORIZACAO_AUSENTE`.  
- Persistência / busca por `(chave, empresa_id)`.  
- NSU/cooldown/FILA/mutex por CNPJ+ambiente.  
- Evento de liberação grava `empresaId` + CNPJ no detalhe.  
- Chave de acesso **não** substitui contexto da empresa.

---

## 7. Procedimento futuro — recuperação NF-e 4456

Módulo: `backend/motores/central-entradas/procedures/preparacaoRecuperacaoNfe4456.js`  
Chave: `23261031255007000188550010000044561664976903` · Empresa **3** · CNPJ `38204469000204`

Checklist (só após autorização humana explícita):

1. Confirmar empresa 3 / CNPJ / ambiente / certificado.  
2. Confirmar fim do cooldown explícito 656.  
3. Confirmar estado da FILA (liberar localmente se sticky — **gera evento**, sem SOAP).  
4. Confirmar BACKGROUND sem auth (pós CE-04 não transmite) e ausência de CONSULTA_DFE_REAL concorrente.  
5. Pré-voo OPERACAO_REAL completo.  
6. Autorização explícita UI + **uma** DistDFe.  
7. Interromper em 656 / 137 / erro — **sem retry**.  
8. Se chave ausente no lote → encerrar; eventual `consChNFe` só com autorização **separada**.  
9. Se documento vier → comprovar XML + `empresa_id=3`.

**Esta sprint não executou o procedimento real.**

---

## 8. Pendências e riscos residuais (ressalvas)

1. **Manifestação 210210 / MIRX** — não são DistDFe; permanecem com suas barreiras; fora do escopo de transmissão DistDFe desta sprint.  
2. **Probe diagnóstico** — ainda existe caminho de código com `forcarProbeDistDfe`; exige auth explícita; não usado pela UI operacional.  
3. **Alguns testes de regressão** ainda puxam `database.js` via grafo de requires (ambiente isolado temp) — não alteram o oficial; ruído SQLITE_BUSY só em execução paralela agressiva.  
4. **Produção ainda pode ter FILA/cooldown ativos** na empresa 3 — não foram alterados nesta sprint.  
5. Recuperação da 4456 permanece **pendente de autorização** operacional futura.

---

## 9. Confirmações finais

| Item | Status |
|---|---|
| Consulta real SEFAZ nesta sprint | **Não executada** |
| Banco oficial alterado | **Não** |
| Correção BACKGROUND / decisão | **Aplicada** |
| Evento liberação FILA | **Aplicado** |
| Procedimento 4456 | **Documentado + testado com mocks** |
| Próxima DistDFe / consChNFe | **Aguardando revisão deste relatório** |

**Não iniciar nova sprint nem transmissão fiscal real sem revisão explícita.**
