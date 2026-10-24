# Auditoria de consumo da SEFAZ ao abrir a Central de Entradas

**Prioridade:** P0  
**Data:** 17/10/2026  
**Prazo do projeto:** 25/10/2026  
**Tipo:** auditoria com interceptação do ponto de envio DistDFe; correção só do que foi comprovado  
**Estado:** evidência reproduzível em teste isolado; DistDFe real **não** executado

Esta sprint **não** consultou a SEFAZ, **não** usou certificado de produção, **não** abriu o banco oficial `C:\ProgramData\MercantilFiscal\dados`, **não** alterou `empresas.cnpj`, **não** resetou NSU e **não** enviou manifestação 210210.

---

## 1. Branch, HEAD e estado inicial do Git

| Item | Valor |
|---|---|
| Branch | `fix/p0-lentidao-cancelamento-nfce` |
| HEAD | `124a23b75a7f849b5ae64acc6e9f959262fc4eb6` |
| Subject | `implemetação Diversas` |
| Autor HEAD | Cicero Diego |
| Data HEAD | 2026-09-27 19:59:28 -0300 |

Worktree preservado (fiscal/vendas/faturamento, OF-01, microsprints 2.6–2.8, correção de sync/CNPJ/recuperação). Sem stash, commit, push, merge, `reset` ou `clean`.

---

## 2. Fluxo real de chamadas (frontend → DistDFe)

### 2.1 Abertura inicial

`frontend/erp/js/app.js` chama `loadCentralEntradas()` uma vez ao entrar na tela.

`loadCentralEntradas()` monta o HTML, faz `bindEventosCentralEntradas()` (com `.off('.centralEntradas')` — cliques não se acumulam), inicia tickers e, **depois** de metadados + empresa + período, dispara:

```text
Promise.all([
  sincronizarAoAbrirCentralSuave(),   // único POST DistDFe desta pintura
  carregarDashboardCentral(),         // GET local
  carregarDocumentosCentral()         // GET local
])
```

Há **uma** ocorrência de `POST /api/central-entradas/sincronizar-ao-abrir` no frontend.

Cadeia backend:

1. `rotas/central-entradas.js` → `sincronizarAoAbrir()`
2. Se `sync_ao_abrir === false` → retorno ignorado **sem** DistDFe
3. Senão `executarSincronizacao({ origem: abrir_central })`
4. `CentralSyncExecucaoService.executar()`
   - emite `CONSULTA_SOLICITADA`
   - Gate (656/593/circuit breaker)
   - cooldown por CNPJ (`COOLDOWN_EXPLICITO` / `FILA_ESGOTADA`)
   - mutex `comLockDistDfe` (uma DistDFe por processo)
   - `CentralSincronizacaoService.sincronizar()` (1 CNPJ em EMPRESA_SIMPLES; N CNPJs em MULTIEMPRESA)
5. `sincronizarDistribuicaoDFe` → `executarEnvioConsultaDfe` → `enviarDistribuicaoDfe` (**ponto de envio**)
6. Persistência; NSU só avança se o lote persistir

### 2.2 Evento `sincronizar-ao-abrir`

É o único caminho DistDFe da **abertura**. Origem oficial: `ORIGENS.ABRIR_CENTRAL` (`abrir_central`).

Default de configuração: `syncAoAbrir` é verdadeiro quando a chave não está `false` (`CentralConfigService.obterResumo`). Abrir a Central **solicita** DistDFe por desenho, não por cadastro de CNPJ.

### 2.3 Reabertura / sair e voltar

Cada nova `loadCentralEntradas()` (menu, hash, troca de tela e retorno) dispara **outro** POST. Não há debounce de sessão. O servidor decide se o SOAP sai: cooldown, Gate ou mutex.

### 2.4 Timers e listeners

| Mecanismo | Intervalo | DistDFe? |
|---|---|---|
| `iniciarTickerSincronizacao` | 60 s | Não — só redesenha o cabeçalho |
| `iniciarAutomacaoCentral` status | 30 s | Não — GET status |
| notificações | 45 s | Não |
| UX live | 1 s | Não |
| soft refresh documentos | 20 s | Não — GET local |
| `cds-empresa-contexto-alterado` | evento | Não — recarrega formulário de config |

Nenhum ticker chega a `enviarDistribuicaoDfe`.

### 2.5 Scheduler vs abertura

`CentralEntradasFlags._syncAutomatica` inicia **desligado**. O background (`CentralSyncBackgroundService`), se ligado na config, agenda o primeiro ciclo ~3 s após o start do processo, origem `background`, e também passa por `executar()` + mutex.

Abertura e scheduler **não** compartilham o POST do frontend. No processo, o mutex impede dois SOAP simultâneos. Não impede duas **solicitações**.

### 2.6 Quantas vezes cada caminho chega ao envio

Contagem no ponto `executarEnvioConsultaDfe` (não na quantidade de funções JS invocadas):

| Caminho | `CONSULTA_SOLICITADA` | SOAP (`CONSULTA_EXECUTADA`) |
|---|---|---|
| 1 abertura, Gate/cooldown livres | 1 | 1 por empresa alvo |
| 1 abertura, cooldown ativo | 1 | 0 |
| 1 abertura, Gate bloqueado | 1 | 0 |
| 1 abertura, mutex ocupado | 1 | 0 (`ENFILEIRADA` / `SYNC_EM_ANDAMENTO`) |
| 3 reaberturas sem cooldown | 3 | 3 |
| 3 reaberturas após cooldown | 1 + 2 bloqueadas | 1 |
| 2 `executar(abrir_central)` concorrentes | 2 | 1 |
| Botão manual (`/sincronizar`) | 1 | 0 ou 1 (mesmas regras) |
| Scheduler | 1 por ciclo | 0 ou 1 |
| Tickers da tela | 0 | 0 |
| `sync_ao_abrir` desligado | 0 (rota retorna antes) | 0 |

MULTIEMPRESA: um POST de abertura percorre **todas** as empresas ativas. Isso não é duplicata do mesmo CNPJ; é o contrato do modo. Teste 8: 2 empresas → 2 envios; cooldown só em A → terceiro envio só de B.

---

## 3. Duplicidade — o que foi reproduzido e o que não foi

### 3.1 Uma única pintura da tela

**Não reproduzido.** Uma `loadCentralEntradas()` gera um POST. Tickers e `bindEventos` não somam DistDFe.

### 3.2 Reabrir a tela

**Reproduzido como solicitação repetida, não como SOAP duplicado se o cooldown estiver ativo.** Sem cooldown, cada reabertura envia de novo — comportamento de `sync_ao_abrir`, não um bug de double-bind.

### 3.3 Evento de abertura repetido / reentrância

**Reproduzido.** Não havia guarda no frontend: dois `loadCentralEntradas()` rápidos geravam dois POST. O mutex do processo garantia **um** SOAP. Faltava proteção de reentrância na UI.

### 3.4 Abrir com sync já em andamento

**Reproduzido.** Segunda execução retorna `SYNC_EM_ANDAMENTO`, `consultaExecutada: false`, zero SOAP.

### 3.5 Abrir sem olhar cooldown / Gate

A abertura **não** ignora cooldown nem Gate. Os dois são avaliados **antes** de `enviarDistribuicaoDfe`. O defeito era outro: o Gate devolvia `sucesso: true` no bloqueio, e a rota de `sync_ao_abrir` desligado também. A UI de abertura só avisava se `sucesso === false`, então o bloqueio podia parecer “nada aconteceu / ok”.

### 3.6 UI “sincronização concluída” sem consulta

**Reproduzido no contrato JSON, não no toast de sucesso da abertura.**

- Abertura: não mostra “Nenhuma nota nova” no sucesso; só warning se `sucesso === false`.
- Gate 656/593: `sucesso: true` no objeto do Gate → abertura **silenciosa** (enganosa por omissão).
- `sync_ao_abrir` desligado: `sucesso: true` na rota.
- Botão manual já distinguia `consultaExecutada === false`.
- `executarSincronizacao` disparava `processarCandidatos` (210210) se `resultado.sucesso`, **sem** exigir consulta executada. Com Gate `sucesso: true` no bloqueio, abrir a Central **poderia** mandar ciência sem DistDFe.

### 3.7 Relação com NF-e ausentes no mês vigente

Não se atribui ao cadastro de CNPJ sem evidência. O CNPJ oficial continua em `empresas.cnpj`.

Comprovação desta sprint:

- Se a abertura cair em cooldown/Gate, **zero SOAP** — a tela não busca lote novo; notas do mês não “entram” por abrir a Central.
- Se a abertura executar DistDFe, é **uma** consulta `distNSU` a partir do `ultNSU` corrente — não varre o mês e não recupera NSU já consumido.

A ausência de notas no filtro do mês vigente **não** foi corrigida aqui. Causas já tratadas em sprints anteriores (consulta ignorada como sucesso, persistência + NSU, `data_emissao`, CNPJ emitente) permanecem o caminho certo. Esta auditoria **não** declara redução de consumo em produção nem correção de NF-e ausentes.

---

## 4. Causa raiz e correções (somente o comprovado)

### 4.1 Causa raiz

1. `sync_ao_abrir` default verdadeiro → toda abertura **solicita** DistDFe (desenho).
2. Mutex já serializava o SOAP; o frontend **não** serializava o POST.
3. Bloqueio do Gate / flag desligada / mutex usavam `sucesso: true` ou omitiam `consultaExecutada: false`.
4. Ciência 210210 podia seguir um “sucesso” sem DistDFe.

Não foi causa: cadastro de empresa, CNPJ global, tickers, `dfe_auditoria` sozinha.

### 4.2 O que **não** foi feito

- Não desligar `sync_ao_abrir` nem o scheduler.
- Não remover Gate, fila, rate limiter, cooldown ou circuit breaker.
- Não alterar origem do CNPJ (`empresas.cnpj`).
- Não resetar/avançar NSU.
- Não enviar 210210 novo; apenas **deixar de disparar** ciência quando a DistDFe não rodou.
- Sem commit/push/merge.

### 4.3 Correções aplicadas

| Arquivo | Correção |
|---|---|
| `observability/SefazConsultaTrace.js` | Rastro em memória: `CONSULTA_SOLICITADA`, `BLOQUEADA_GATE`, `BLOQUEADA_COOLDOWN`, `ENFILEIRADA`, `CONSULTA_EXECUTADA`, `RESPOSTA_RECEBIDA`, `PERSISTENCIA_CONCLUIDA`, `PERSISTENCIA_FALHOU`. Sem senha/PFX/XML. Independente de `dfe_auditoria`. |
| `centralEventosTipos.js` | Mesmos tipos no catálogo de eventos. |
| `CentralSyncExecucaoService.js` | Emite o rastro; Gate bloqueado vira `sucesso: false` + `consultaExecutada: false`; mutex idem; `ENFILEIRADA` se `SYNC_EM_ANDAMENTO`. |
| `CentralSincronizacaoService.js` | Cooldown/Gate por empresa emitem o rastro; `origemConsulta` segue até o DistDFe. |
| `distribuicaoDFe.js` | `CONSULTA_EXECUTADA` no ponto de envio; `RESPOSTA_RECEBIDA`; persistência ok/falha. |
| `CentralEntradasOrchestrator.js` | `processarCandidatos` só se `sucesso && !ignorado && consultaExecutada !== false`. |
| `rotas/central-entradas.js` | Flag desligada: `sucesso: false`, `consultaExecutada: false`, `codigo: SYNC_AO_ABRIR_DESABILITADO`. |
| `frontend/erp/js/central-entradas.js` | Guarda `syncAoAbrirEmVoo` / `sincronizando`; aviso se ignorado; silêncio só se a flag estiver desligada. |
| `tests/.../rc333-hardening.test.js` | Mutex isolado de I/O do Gate (`ignorarBloqueio656`), corrida pré-existente documentada na CE-05. |

`ENFILEIRADA` no mutex significa **rejeitada** (`enfileiradaEfetiva: false`). O processo **não** enfileira DistDFe para retry; a fila DistDFe é o loop `ultNSU`/`maxNSU` dentro de uma execução já autorizada.

---

## 5. Testes executados

Isolados: `DB_DIR` temporário, `:memory:` / mocks, `enviarDistribuicaoDfe` interceptado, **zero** SOAP real.

Arquivo: `tests/central-entradas/auditoria-consumo-abertura-central.test.js`

| # | Cenário | Resultado |
|---|---|---|
| 1 | Abrir uma vez | 1 solicitação, 1 envio |
| 2 | Sair e voltar / cooldown | 3 envios sem cooldown; 1 envio + 2 `BLOQUEADA_COOLDOWN` com cooldown |
| 3 | Evento de abertura concorrente | 2 solicitações, 1 envio, 1 `ENFILEIRADA` |
| 4 | Já em andamento | 0 envio, `consultaExecutada: false` |
| 5 | Cooldown | 0 envio, `AGUARDAR_JANELA_DFE` |
| 6 | Gate 656 | 0 envio, `sucesso: false` (não herda `sucesso: true` do Gate) |
| 7 | Abertura vs manual vs scheduler | 1 solicitação e 1 envio por origem |
| 8 | Duas empresas | 2 envios; cooldown de A não envia por B |
| 9 | Persistência falha | 1 SOAP, `PERSISTENCIA_FALHOU`, `aplicarRetornoDistDfe` não chamado |
| 10 | Bloqueio ≠ concluída | 0 ciência 210210; rota desabilitada sem `sucesso: true`; UI com reentrância |

Regressão na mesma rodada (temp DB / mocks):

- `auditoria-consumo-abertura-central.test.js`
- `nfe-nao-localizada-sync.test.js`
- `rc333-hardening.test.js`

**24/24 pass** (conjunto). `recuperacao-segura-nfe-ausentes.test.js` e `microsprint-cnpj-emitente.test.js` também rodaram na bateria anterior sem falha atribuída a esta sprint.

O rastro **não** grava certificado/senha; o teste 1 asserta a ausência do segredo no JSON dos eventos.

---

## 6. Números desta auditoria (teste, não produção)

Ambiente de prova, uma empresa, Gate liberado, cooldown off, mock de `enviarDistribuicaoDfe`:

| Métrica | Valor |
|---|---|
| Solicitações por abertura | 1 |
| Consultas efetivamente enviadas por abertura | 1 |
| Consultas enviadas com Gate/cooldown/mutex | 0 |
| Solicitações concorrentes / envios | 2 / 1 |
| Tickers → SOAP | 0 |

**Não há medição de produção.** Sem autorização, não se lê `dfe_auditoria` oficial nem se dispara DistDFe real para contar 656/137 do mês vigente.

---

## 7. Limitações que dependem de homologação operacional

1. Quantas aberturas o operador faz por hora no PDV/ERP real, e se o cooldown de 1 h está vigente no CNPJ oficial.
2. Se `sync_automatica_habilitada` está ligada no banco da loja (default de flag em código: off).
3. MULTIEMPRESA em produção: 1 abertura × N empresas ativas = N SOAP se nenhuma estiver em cooldown.
4. Primeiro ciclo do scheduler (~3 s) coincidindo com a primeira abertura do dia — mutex cobre o SOAP duplo; as duas solicitações aparecem no rastro.
5. Homologação assistida com certificado de homologação (não produção) para confirmar cStat 137/138/656 reais.
6. UI no browser: reentrância verificada por leitura do JS + testes; não houve sessão logada no ERP nesta sprint.

Para homologar consumo real, com autorização: DistDFe de homologação **ou** leitura (sem UPDATE) de `central_entradas_nsu.cooldown_ate` + eventos `CONSULTA_EXECUTADA` do rastro / `dfe_auditoria` **depois** de uma abertura controlada.

---

## 8. Critério de aceite

| Exigência | Atendido |
|---|---|
| Evidência se abrir a Central consome SEFAZ | Sim: consome **se** `sync_ao_abrir` e Gate/cooldown/mutex liberarem |
| Quantas consultas | 1 SOAP por empresa alvo por execução liberada; 0 se bloqueada |
| Por qual caminho | `sincronizarAoAbrirCentralSuave` → `POST /sincronizar-ao-abrir` → `origem=abrir_central` → `executarEnvioConsultaDfe` |
| Não declarar redução de consumo em produção | Não declarado |
| Não declarar NF-e do mês corrigidas | Não declarado |
| Sem SEFAZ real, sem banco oficial, sem commit | Cumprido |
