# Sprint CE-PASTELARIA-02 — Correção do bloqueio ou falha na busca de NF-e

**Tipo:** correção mínima / UX operacional + liberação admin  
**Data:** 18–19/10/2026  
**Veredito:** **CORRIGIDO (causa local demonstrada)** — busca real na SEFAZ **não** revalidada nesta sprint

---

## 1. Objetivo

Identificar e corrigir por que a Central de Entradas da Pastelaria não consegue localizar/receber NF-e de terceiros, trabalhando exclusivamente na Central de Entradas, sem restaurar o fluxo do ZIP CDS Sistemas e sem remover a barreira de autorização explícita.

---

## 2. Fluxo real mapeado (clique → transmissão)

| Etapa | Componente | Comportamento Pastelaria |
|---|---|---|
| 1 | Botão “Sincronizar” / sync cabeçalho | `sincronizarCentralEntradas()` |
| 2 | Gate UX 656 (timer local) | Pode abortar cedo com mensagem de cooldown |
| 3 | Status operação real | `GET /operacao-fiscal-real/status` |
| 4 | Se operação real **desabilitada** | Abre painel; **não** chama `/sincronizar` |
| 5 | Se operação real **ativa** | Encaminha para `consultarDfeRealCentral()` |
| 6 | Pré-voo local | Bloqueia se `preVoo.ok === false` (FILA, cooldown, cert, etc.) |
| 7 | Confirmação UI | `confirm()` produção |
| 8 | HTTP | `POST /operacao-fiscal-real/consultar-dfe` (confirmações booleanas; auth emitida no servidor) |
| 9 | Serviço | `CentralOperacaoFiscalRealService` → autorização OPERACAO_REAL → sync DistDFe |
| 10 | Runtime | `distribuicaoDfeRuntime.enviarDistribuicaoDfe` exige `avaliarAutorizacaoTransmissao` |
| 11 | Persistência | NSU/docs via pipeline DistDFe existente (não alterado nesta sprint) |

**Diferença vs CDS Sistemas (ZIP):** no CDS, `sincronizarCentralEntradas()` ia direto a `/central-entradas/sincronizar`. Na Pastelaria, com operação real ativa, o botão **não** usa mais esse endpoint — exige o caminho OPERACAO_REAL. Isso **não** foi revertido.

---

## 3. Onde a operação parava (causa raiz comprovada)

### 3.1 Código / etapa / mensagem

| Campo | Valor |
|---|---|
| Código | `FILA_ESGOTADA` |
| Etapa HTTP/pré-voo | `cooldown` (mapeamento estável P0.9.3; semântica sticky, sem timer) |
| Condição | `ultNSU = maxNSU` + `ultimo_cstat ∈ {137,138,656}` após expirar `cooldown_ate` do 656 |
| SOAP | **Não iniciado** (`consultaExecutada: false`) |
| `proximaConsultaEm` | `null` (não há “liberação automática por relógio”) |

Reproduzido em teste isolado (`it 1`): pré-voo `ok: false` com `FILA_ESGOTADA`; `emitirAutorizacaoConsultaReal` rejeita com o mesmo código; nenhuma transmissão.

### 3.2 Amplificador de UX (falha de percepção)

`classificarMensagemBloqueioFiscalCentral` tratava o bloqueio de etapa `cooldown` com `proximaConsultaEm` nulo como:

> “Consulta em cooldown SEFAZ. Aguarde a liberação.”

Na sticky FILA isso é **falso**: esperar a 1 h (ou qualquer timer) **não** libera a busca. O operador via “busca não funciona” sem ver o motivo real nem caminho admin.

### 3.3 Lacuna operacional pós CE-ENCERRAMENTO-01

O serviço `liberarFilaEsgotadaAutorizada` existia no `CentralNsuService`, mas **não** havia:

- método de fachada em `CentralOperacaoFiscalRealService`;
- rota HTTP admin;
- botão/handler na UI.

Sem liberação auditada, a sticky FILA deixava a Central permanentemente incapaz de nova DistDFe após o 656 com cursor no topo.

### 3.4 Hipóteses descartadas (com evidência desta sprint)

| Hipótese | Resultado |
|---|---|
| 1. Operação fiscal real desabilitada | Não é a causa do bloqueio pós-656: status pode estar **ativa** e ainda assim FILA bloqueia |
| 2. Pré-voo reprovado | **Sim** — por `FILA_ESGOTADA` |
| 3. Empresa/identidade incorreta | Não demonstrado nos testes desta sprint; fluxo usa contexto por `empresaId` |
| 4. Autorização ausente no body | Esperado e mantido; auth é servidor-side |
| 5. Cooldown/FILA | **Sim** — sticky FILA (não só cooldown 1 h) |
| 6. Falha antes do transporte | Sim — pré-voo / emissão de auth |
| 7–8. SEFAZ sem docs / persistência | Não alcançados nesta falha (transporte não inicia) |

**Não** se removeu a autorização explícita para “igualar” o ZIP CDS.

---

## 4. Correção mínima aplicada

1. **UI:** classificação explícita de `FILA_ESGOTADA` (mensagem, painel de status, title do botão Consultar).
2. **UI:** botão “Liberar fila esgotada” (admin) + `liberarFilaEsgotadaCentral()`.
3. **Backend:** `CentralOperacaoFiscalRealService.liberarFilaEsgotada` — admin + confirmação; sem SOAP; sem alterar NSU; **não** contorna cooldown 656 ainda ativo.
4. **Rota:** `POST /operacao-fiscal-real/liberar-fila-esgotada` (rejeita auth/token no body).
5. **Orquestração:** wrappers em `CentralEntradasOrchestrator` / `CentralEntradasService`.

Após liberação local (`ultimo_cstat = FILA_LIBERADA_OP`), o pré-voo pode ficar `ok` e o operador deve chamar **Consultar DF-e (produção)** com confirmação — ainda sujeito à barreira de runtime e à SEFAZ real.

---

## 5. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `frontend/erp/js/central-entradas.js` | Mensagem FILA; painel; botão; `liberarFilaEsgotadaCentral`; handler click |
| `backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js` | `liberarFilaEsgotada` |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | Wrapper |
| `backend/motores/central-entradas/CentralEntradasService.js` | Wrapper |
| `backend/rotas/central-entradas.js` | Rota `liberar-fila-esgotada` |
| `tests/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe.test.js` | Reprodução + regressão |
| `docs/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe-relatorio.md` | Este relatório |

Módulos fora da Central de Entradas: **não** alterados para esta correção (barreira em `distribuicaoDfeRuntime` apenas **verificada** nos testes).

---

## 6. Testes executados

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test \
  tests/central-entradas/sprint-ce-pastelaria-02-correcao-busca-nfe.test.js
```

| # | Caso | Resultado |
|---|---|---|
| 0 | Isolamento / recusa banco oficial | PASS |
| 1 | Reprodução FILA sticky bloqueia pré-voo/auth | PASS |
| 2 | UI FILA ≠ “Aguarde a liberação” | PASS |
| 3 | Liberação sem SOAP / NSU preservado / pré-voo OK | PASS |
| 4 | Admin + confirmação; cooldown 656 não contornado | PASS |
| 5 | Rota/orquestração presentes | PASS |
| 6 | Sync cabeçalho → consulta real (fluxo Pastelaria mantido) | PASS |
| 7 | Sticky FILA + barreira runtime preservadas | PASS |

**8/8 pass.** Sem consulta SEFAZ real. Sem acesso/mutação ao banco oficial. Sem alteração de NSU/cooldown/flags/autorizações de produção.

---

## 7. Riscos residuais

1. **Busca real na SEFAZ não validada** nesta sprint — só o bloqueio local e a liberação local.
2. Após liberação, a SEFAZ pode ainda responder **656** / **137** / sem documentos; sticky FILA pode voltar a aplicar.
3. Liberação é **admin + auditada**; operador sem perfil adequado continua bloqueado (intencional).
4. Se a operação real estiver desabilitada, o sync do cabeçalho continua sem DistDFe (comportamento P0.8+ mantido).
5. `proximaConsultaEm: null` em FILA sticky permanece — a UI agora explica isso; não inventa horário falso.

---

## 8. Aceite

| Critério | Status |
|---|---|
| Falha original reproduzida | Sim — `FILA_ESGOTADA` sticky + mensagem UI enganosa |
| Causa demonstrada | Sim — pré-voo / emissão auth; transporte não inicia |
| Teste de regressão aprovado | Sim — liberação local + UI + rota |
| Sticky FILA preservada | Sim |
| Barreira runtime preservada | Sim |
| Autorização explícita mantida | Sim |
| Busca SEFAZ real validada | **Não** — exige operação real especificamente autorizada fora desta sprint |

**Veredito de aceite da sprint:** correção da causa local **aprovada**; não declarar DistDFe de produção validada.
