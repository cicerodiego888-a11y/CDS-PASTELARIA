# AUTH-403-01 — Diagnóstico dos HTTP 403 (Electron)

**Data:** 2026-10-26  
**Tipo:** investigação somente leitura (sem correção)  
**Estado final:** **CONCLUÍDA** (mapa de gates comprovado; causa runtime ainda depende do corpo HTTP observado)

Nenhuma alteração de produção foi realizada nesta sprint. Único artefato criado: este relatório.

---

## 1. Endpoints analisados

| # | Método e caminho |
|---|---|
| 1 | `GET /api/configuracoes/modo_dashboard_fiscal` |
| 2 | `GET /api/central-entradas/servico/status` |
| 3 | `GET /api/central-entradas/notificacoes` |
| 4 | `GET /api/central-entradas/feature-flags` |
| 5 | `GET /api/central-entradas/metadados` |

Nenhum destes caminhos está na allowlist pública (`apiPublicPaths.js`). Todos passam pelo gate global `/api`.

---

## 2. Middlewares e gates identificados (ordem)

### 2.1 Gate global (todos os `/api/*` protegidos)

Montagem em `backend/server.js`:

```text
app.use('/api', apiAuthLicencaGate)
```

`apiAuthLicencaGate` (`backend/middleware/apiAuthLicencaGate.js`):

1. Se path público → `next()`
2. Senão → `verificarToken` → em sucesso → `licencaMiddleware`

### 2.2 Montagem específica

| Prefixo | Middlewares adicionais no mount |
|---|---|
| `/api/configuracoes` | `verificarToken` (2ª vez) + `configuracoesRoutes` |
| `/api/central-entradas` | `verificarToken` (2ª vez) + **`exigirRecurso('fiscal')`** + `centralEntradasRoutes` |

### 2.3 Handlers dos cinco endpoints

Leitura estática dos handlers:

| Endpoint | Handler | Emite 403? |
|---|---|---|
| `GET /configuracoes/:chave` (`modo_dashboard_fiscal`) | `rotas/configuracoes.js` → SELECT por chave | **Não** (200 com row ou row nula; 500 em erro SQL) |
| `GET /central-entradas/servico/status` | `obterStatusServico()` | **Não** (200 / 500) |
| `GET /central-entradas/notificacoes` | `listarNotificacoes(...)` | **Não** (200 / 500) |
| `GET /central-entradas/feature-flags` | `obterFeatureFlagsPublicas()` | **Não** (200) |
| `GET /central-entradas/metadados` | `obterMetadados()` | **Não** (200 / 500) |

**Fato:** qualquer 403 nestes cinco GETs, se ocorrer, **não** nasce da lógica de negócio do handler; nasce dos gates anteriores (ou do error handler CORS).

---

## 3. Origens possíveis de HTTP 403 (contratos previstos)

### A — Autenticação JWT (`backend/middleware/auth.js` → `verificarToken`)

| Condição | Status | Corpo (contrato) |
|---|---|---|
| Token ausente | **401** | `{ error: 'Acesso negado', code: 'SESSAO_INVALIDA' }` |
| Token presente mas inválido/expirado (`jwt.verify` falha) | **403** | `{ error: 'Token inválido ou expirado', code: 'SESSAO_INVALIDA' }` |

### B — Licença comercial (`backend/middleware/licencaMiddleware.js`)

Após auth OK, `verificarLicenca()`:

| Motivo | Status | Corpo (contrato) |
|---|---|---|
| `DATA_ALTERADA` | 403 | `{ erro: 'DATA_ALTERADA', mensagem: ... }` |
| `VENCIDA` (fora da allowlist de graça PDV / regras) | 403 | `{ erro: 'LICENCA_VENCIDA', mensagem: ... }` |
| Demais inválidas / ausente | 403 | `{ erro: 'LICENCA_AUSENTE', ... }` (ou código passado a `responderLicencaInvalida`) |

**Diferencial importante (fato de código):** com licença `VENCIDA` **em tolerância PDV**, `PDV_GRACE_PREFIXES` inclui `/api/configuracoes`, mas **não** inclui `/api/central-entradas`. Nesse cenário:

- `modo_dashboard_fiscal` pode passar o gate de licença;
- os quatro endpoints de central-entradas podem receber `LICENCA_VENCIDA`.

### C — Recurso de implantação fiscal (`exigirRecurso('fiscal')`)

`validarRecursoImplantacao.js` → `responderModuloNaoLicenciado`:

```json
{ "erro": "MODULO_NAO_LICENCIADO", "mensagem": "Módulo Fiscal não contratado.", "modulo": "fiscal" }
```

Aplica-se **somente** a `/api/central-entradas/*` (e demais mounts com `fiscal`), **não** a `/api/configuracoes/modo_dashboard_fiscal`.

`recursoHabilitado('fiscal')` exige implantação fiscal (`ERP_FISCAL` / `ERP_MULTICAIXA`) **e** (NF-e ou NFC-e) habilitados (`configuracaoService.getRecursos`).

### D — CORS (menos provável no Electron local)

Error handler em `server.js`: mensagem contendo `CORS` → `{ error: 'Origem não permitida pelo CORS' }` com status 403.

### E — Descarta dos handlers listados

Os cinco handlers não chamam `res.status(403)`.

---

## 4. Origem comprovada vs não comprovada (por endpoint)

| Endpoint | Origem 403 **comprovada em runtime**? | Origens **plausíveis** pelo código |
|---|---|---|
| `modo_dashboard_fiscal` | **Não** (sem captura Network/logs desta ocorrência) | A (JWT inválido), B (licença), D (CORS) — **não** C |
| `central-entradas/*` (4 rotas) | **Não** | A, B, **C**, D |

**Não se declara uma única causa raiz de produção** nesta sprint: não houve observação direta do status+corpo das respostas do Electron, nem execução de chamadas reais (proibido).

---

## 5. Evidências concretas encontradas

1. Montagem Express e ordem Auth → Licença → recurso (`server.js`, `apiAuthLicencaGate.js`) — lidas no repositório.
2. Contratos JSON de 403 em `auth.js`, `errosLicenciamento.js`, `licencaMiddleware.js`, `validarRecursoImplantacao.js`.
3. Handlers dos cinco endpoints sem `status(403)`.
4. Allowlist de graça PDV sem `/api/central-entradas` (`licencaMiddleware.js` `PDV_GRACE_PREFIXES`).
5. Cliente ERP chama esses paths com `Authorization: Bearer ${localStorage.token}` (`frontend/shared/js/core.js`, `frontend/erp/js/central-entradas.js` → `centralEntradasFetch`).
6. Frontend já distingue 403 de sessão vs licença/módulo (`isErroSessaoExpirada` / `notificarErroLicenciamento` em `core.js`) pelo campo `body.erro` / mensagem de token.
7. Testes de contrato (somente leitura de arquivos de teste, sem suíte ampla): `tests/seguranca/hotfix-rc1-licenciamento.test.js` documenta `MODULO_NAO_LICENCIADO`, `LICENCA_VENCIDA` e presença do gate.
8. Instrumentação de bloqueio de licença: `licencaService.gravarLog(...)` em vencida/data alterada — **não** foi possível inspecionar esses logs nesta sprint sem acessar ambiente/cliente. Auth JWT **não** grava log estruturado do motivo além da resposta JSON. **Não há** correlation id obrigatório nesses 403 de gate.

---

## 6. Fatos × hipóteses × indisponível

### Fatos

- Os 403 destes endpoints, se ocorrerem, saem dos gates (JWT / licença / módulo fiscal / CORS), não dos handlers.
- Central Entradas exige recurso `fiscal` além de auth+licença; configurações F12 não.
- Token ausente gera 401; token inválido gera 403 `SESSAO_INVALIDA`.
- Em tolerância pós-vencimento, o diferencial configuracoes vs central-entradas é esperado pelo código.

### Hipóteses (não comprovadas sem Network)

| Hipótese | Como falsificar/confirmar |
|---|---|
| H1 — JWT inválido/expirado | Corpo com `code: 'SESSAO_INVALIDA'` nos **cinco** endpoints |
| H2 — Módulo fiscal desabilitado | Só central-entradas 403 com `erro: 'MODULO_NAO_LICENCIADO'`; `modo_dashboard_fiscal` 200 |
| H3 — Licença vencida em graça PDV | `modo_dashboard_fiscal` 200; central com `erro: 'LICENCA_VENCIDA'` |
| H4 — Licença ausente / vencida fora da graça / data alterada | Todos 403 com `LICENCA_AUSENTE` / `LICENCA_VENCIDA` / `DATA_ALTERADA` |
| H5 — CORS | Corpo `Origem não permitida pelo CORS` |

### Indisponível nesta etapa

- Corpos HTTP reais do Electron.
- Logs de `licencaService.gravarLog` do ambiente afetado.
- Estado real de implantação (`tipoImplantacao`, flags NF-e/NFC-e) e validade da licença no cliente.
- Conteúdo do JWT (não deve ser colado no relatório; basta saber se a API o aceita).

---

## 7. Dados a capturar no Network (Electron)

Para **cada** um dos cinco requests, registrar:

1. URL completa e método.
2. **Status HTTP**.
3. **Corpo JSON completo** (sem headers de Authorization / cookies).
4. Campos discriminantes: `erro`, `code`, `codigo`, `mensagem`, `error`, `modulo`.
5. Se existir: header de correlação / `x-request-id` (hoje os gates listados **não** o exigem).
6. Momento relativo (todos 403 juntos vs só central).
7. Se `modo_dashboard_fiscal` foi 200 ou 403 na mesma sessão.

Matriz de decisão rápida:

```text
cinco × SESSAO_INVALIDA          → H1 (reautenticar / token)
só central × MODULO_NAO_LICENCIADO → H2 (habilitar fiscal / implantação)
config 200 + central LICENCA_VENCIDA → H3 (renovar assinatura; graça PDV)
todos × LICENCA_* / DATA_ALTERADA → H4
CORS message                     → H5
```

---

## 8. Recomendação da menor correção (sprint posterior — não executar agora)

Aguardar a captura do §7. A menor correção **depende** do discriminante:

| Se Network confirmar | Menor correção candidata (autorizar depois) |
|---|---|
| H1 | Corrigir persistência/envio do Bearer no Electron / renovação de sessão — **sem** enfraquecer JWT |
| H2 | Ajustar implantação/flags do módulo fiscal **ou** revisar se endpoints de metadados/flags/status deveriam exigir `fiscal` (decisão de produto) |
| H3/H4 | Fluxo de Assinatura / renovação; eventual inclusão consciente de paths na graça PDV **somente** se PO autorizar |
| H5 | Origens CORS do shell Electron |

**Não** recomendado a priori: remover `exigirRecurso`, bypass de licença, desabilitar auth, alterar polling/cooldown.

Melhoria opcional de observabilidade (sprint própria): logar nos gates o `erro`/`code` + path + user id (sem token) para dispensar captura manual futura.

---

## 9. Arquivos inspecionados e alterados

### Inspecionados (leitura)

- `backend/server.js`
- `backend/middleware/apiAuthLicencaGate.js`
- `backend/middleware/apiPublicPaths.js`
- `backend/middleware/auth.js`
- `backend/middleware/licencaMiddleware.js`
- `backend/middleware/validarRecursoImplantacao.js`
- `backend/middleware/errosLicenciamento.js`
- `backend/rotas/configuracoes.js`
- `backend/rotas/central-entradas.js` (handlers metadados / feature-flags / servico/status / notificacoes)
- `backend/services/configuracaoService.js` (trecho `getRecursos` / `recursoHabilitado` / fiscal)
- `frontend/shared/js/core.js` (chamada F12 + tratamento 403)
- `frontend/erp/js/central-entradas.js` (`centralEntradasFetch` + callers)
- `tests/seguranca/hotfix-rc1-licenciamento.test.js` (contrato, sem execução de suíte ampla)

### Alterados

- **Somente** `docs/arquitetura/AUTH-403-01-RELATORIO.md` (este arquivo).

### Confirmação

**Nenhuma alteração de produção, autenticação, JWT, licença, CSRF, autorização de módulos, cooldown, polling, schema, banco ou dependências foi realizada.**

---

## 10. Encerramento

| Item | Valor |
|---|---|
| Estado | **CONCLUÍDA** |
| Causa runtime única | **Não comprovada** (falta corpo HTTP) |
| O que está comprovado | Pipeline de gates e contratos de 403; handlers sem 403; diferencial fiscal/graça PDV |
| Bloqueio residual | Captura Network Electron (§7) |
| Próxima ação | Operador/QA captura Network → Tech Lead autoriza sprint de correção mínima alinhada à hipótese confirmada |

**Não iniciar correção dos 403 sem nova autorização.**
