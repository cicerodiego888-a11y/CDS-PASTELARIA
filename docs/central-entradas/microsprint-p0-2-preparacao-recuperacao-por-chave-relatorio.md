# Microsprint P0.2 — Preparação segura da recuperação por chave (`consChNFe`)

**Prioridade:** P0 — Fiscal / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** auditoria do fluxo existente + preparação **offline**  
**Pré-requisitos:** P0 (cursor 656) e P0.1 (isolamento de testes)

Esta microsprint **não** recuperou documentos, **não** consultou a SEFAZ, **não** abriu PFX de produção, **não** enviou `210210` e **não** alterou NSU/cooldown de produção. Sem commit, push ou merge.

---

## 1. Fluxo existente encontrado

### 1.1 Arquivos inspecionados

| Arquivo | Responsabilidade real |
|---|---|
| `backend/services/fiscal/distribuicaoDFe.js` | `consultarNotaPorChave` (SOAP `consChNFe`) e `sincronizarDistribuicaoDFe` (`distNSU`) |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | `buscarPorChave` — exige `empresaId`, Gate, depois `consultarNotaPorChave` |
| `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js` | Fallback pós-ciência: `_consultarXmlCompletoPorChave` |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | Fila automática `consChNFe` para documentos já na Central |
| `backend/motores/central-entradas/services/CentralDfePersistenciaService.js` | Persistência DistDFe/`consulta_chave`; duplicidade por `(chave, empresa_id)` |
| `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js` | `buscarPorChave(chave, empresaId)` — sem SELECT global |
| `backend/motores/central-entradas/services/CentralNsuService.js` | Cursor DistDFe; **não** é chamado por `consultarNotaPorChave` |
| `backend/motores/central-entradas/services/NsuRecoveryService.js` | Só ramo 656 de DistDFe |
| `backend/motores/central-entradas/repositories/CentralNsuRepository.js` | `UNIQUE(cnpj, ambiente)` |
| `backend/motores/central-entradas/services/CentralSefazOperationalGate.js` | Gate compartilhado; 656 por contexto de empresa |
| `backend/motores/central-entradas/services/resolverContextoDocumentoCentral.js` | CNPJ/certificado da **empresa do documento**; fallback global só em EMPRESA_SIMPLES |
| `backend/motores/central-entradas/services/CentralConfiguracaoService.js` | `obterContextoOperacional` — CNPJ, ambiente, PFX |
| `backend/motores/central-entradas/utils/validarChaveNfe.js` | 44 dígitos (sem DV, até esta sprint) |
| `backend/services/fiscal/utils.js` | `modulo11` / `gerarChaveAcesso` |
| `backend/rotas/central-entradas.js` | `GET /buscar-chave` — **executa** consulta se a nota não estiver local |
| `backend/rotas/dfe.js` | `GET /consultar-chave` → HTTP 410 |
| `backend/motores/central-entradas/services/CentralConciliacaoNfeService.js` | Inventário A–E e `planejarConsChNFe` (`executaSefaz: false`) |

### 1.2 Mapa do fluxo atual de consulta por chave

```
GET /buscar-chave?chave=
  └─ empresaId obrigatório (X-Empresa-Id)
       └─ CentralSincronizacaoService.buscarPorChave
            ├─ validar 44 dígitos (sem DV)
            ├─ obterContextoOperacional({ empresaId })
            │     CNPJ + ambiente + caminho PFX da empresa
            ├─ Gate SEFAZ (mesmo Gate de distNSU)
            └─ distribuicaoDFe.consultarNotaPorChave
                 ├─ se sem contextoCentral → getFiscalConfig()  [fallback global — NÃO usar no futuro]
                 ├─ Gate novamente
                 ├─ executarEnvioConsultaDfe(tipoConsulta: consChNFe)  [mesmo transporte SOAP de distNSU]
                 ├─ persistirDocumentosRetorno(..., origem 'consulta_chave')
                 └─ NÃO chama aplicarRetornoDistDfe  → ult_nsu/max_nsu/cooldown intactos
```

Caminhos paralelos que **já enviam** `consChNFe` (não usados nesta sprint):

- `MotorRecuperacaoXmlService` — documentos já persistidos (resumo / XML indisponível).
- `CentralManifestacaoDfeService._consultarXmlCompletoPorChave` — após ciência, DistDFe sem PROC.

### 1.3 Respostas à auditoria (Fase A)

1. **Validação da chave:** `replace(/\D/g)` + 44 dígitos em `buscarPorChave` / `consultarNotaPorChave`. DV módulo 11 existia só em `gerarChaveAcesso`, **não** era conferido na consulta.
2. **CNPJ / empresaId / ambiente / certificado:** `obterContextoOperacional`. MULTIEMPRESA deve passar `empresaId` e `permitirFallbackGlobal: false`. CNPJ nas posições 7–20 da chave é o **emitente da NF-e (fornecedor)**, não o destinatário DistDFe.
3. **Quem envia:** `consultarNotaPorChave` via `executarEnvioConsultaDfe`.
4. **Validação e persistência:** `retornoDistSucesso` / cStat 138; `persistirDocumentosRetorno` + `CentralDfePersistenciaService`.
5. **Duplicidade:** `buscarPorChave(chave, empresaId)`; estados terminais / resumo repetido → `duplicado: true`, sem novo INSERT. Compra existente (`existeCompraComChave`) influencia status, não credita estoque na persistência DistDFe.
6. **Controles compartilhados:** Gate, telemetria e transporte SOAP comuns. Mutex DistDFe cobre a sincronização sequencial; `consChNFe` entra pelo mesmo Gate. Cooldown 656 de DistDFe **bloqueia** também `buscarPorChave` se o Gate estiver fechado.
7. **Cursor:** `consultarNotaPorChave` **não** altera `ult_nsu` / `max_nsu` / `cooldown_ate`. Só DistDFe 137/138 (após persistência) avança o cursor.
8. **Sem crédito automático:** persistir na Central não importa compra nem estoque. `GET /buscar-chave` com `novo` ainda pode enfileirar processamento (efeito colateral 05.74) — a preparação P0.2 **não** chama essa rota.

Não se assume correção só porque há testes: o DV não era validado; `consultarNotaPorChave` ainda tem fallback `getFiscalConfig` sem `contextoCentral`.

---

## 2. Arquivos criados ou alterados

| Arquivo | Ação |
|---|---|
| `backend/motores/central-entradas/services/CentralPreparacaoConsultaChaveService.js` | **Novo.** Plano offline por lista de chaves |
| `backend/motores/central-entradas/config/preparacaoConsultaChaveClassificacoes.js` | **Novo.** Enumerações |
| `backend/motores/central-entradas/utils/validarChaveNfe.js` | DV + decomposição; `validarChaveNfe()` 44 dígitos **inalterado** |
| `backend/services/fiscal/utils.js` | Exporta `modulo11` e `validarDigitoVerificadorChaveNfe` |
| `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js` | `buscarPorChaveExcetoEmpresa` (conflito, não fallback) |
| `tests/central-entradas/microsprint-p0-2-preparacao-conschnfe.test.js` | **Novo.** |
| `tests/central-entradas/conciliacao-recuperacao-nfe-ausentes.test.js` | Helper de isolamento |
| `package.json` | script `test:central-entradas-prep-chave` |

Nenhum executor, fila ou scheduler de `consChNFe` foi adicionado. Nenhuma rota HTTP nova. Alterações locais preexistentes preservadas.

---

## 3. O que foi implementado e o que foi reutilizado

### Implementado (só o que faltava)

Operação `preparar({ empresaId, chaves, cnpjEmpresaEsperado?, ambienteEsperado? })`:

- Normaliza 44 dígitos e rejeita malformação.
- Confere DV com o módulo 11 fiscal existente.
- Exige `empresaId`; **não** infere empresa/CNPJ globais.
- Resolve CNPJ e ambiente via `resolverIdentidadeFiscal` injetado (`permitirFallbackGlobal: false`).
- Compatibilidade chave × empresa × ambiente quando os dados existem (CNPJ/ambiente informados vs cadastro; chave já persistida em outra empresa).
- Existência local `(chave, empresa_id)` → não é documento novo.
- Classificações pedidas + evidências, motivo, ação futura **não executada**, `correlationId`.
- Snapshot de leitura do cursor; flags `nsuAlterado` / `cooldownAlterado` por comparação.
- Ausência local **não** é classificada como NF-e perdida na SEFAZ.

### Reutilizado

- `modulo11` / `gerarChaveAcesso` da Plataforma Fiscal.
- `buscarPorChave` por empresa (05.72).
- Máquina `DocumentoFiscalStatus`.
- `mascararCnpj` / `mascararChave` (sem segredos).
- Helper `isolarBancoTeste` (P0.1).
- Inventário A–E (`CentralConciliacaoNfeService`) permanece para outra pergunta (“para onde foi o documento?”). P0.2 responde “esta chave pode ir a um `consChNFe` futuro?”.

Não foi criado segundo motor DistDFe.

---

## 4. Contrato futuro de `consChNFe` (não habilitado)

Documentado em `contratoFuturoConsChNFe` no resultado da preparação (`habilitado: false`).

Quando houver autorização explícita, a execução deverá:

| Regra | Detalhe |
|---|---|
| Identidade | `empresaId` + CNPJ + ambiente + PFX **da mesma empresa**; sem `getFiscalConfig` global |
| Cliente | Reutilizar `consultarNotaPorChave` e `persistirDocumentosRetorno` |
| Controles | Gate, mutex, cooldown, rate limiter, circuit breaker — não contornar |
| Estados | solicitada ≠ enviada ≠ resposta ≠ persistido ≠ erro de persistência |
| Idempotência | repetir a chave não duplica nem credita estoque |
| Sucesso | só após persistência durável |
| Cursor | não alterar `ult_nsu` / `max_nsu` / `cooldown_ate` (já é o comportamento atual de `consultarNotaPorChave`) |
| Ciência | não enviar `210210` como efeito da recuperação por chave |

Pendência de código para essa etapa futura (fora desta sprint): remover o fallback `getFiscalConfig` em `consultarNotaPorChave` quando `contextoCentral` estiver ausente.

---

## 5. Resultados dos testes

Comandos na raiz do repositório. SOAP mock ou inexistente; sem PFX de produção.

| Comando | Resultado | Banco |
|---|---|---|
| `node --test tests/central-entradas/microsprint-p0-2-preparacao-conschnfe.test.js` | **17 pass, 0 fail** | helper Temp + NSU `:memory:`; **não** carrega `database.js` |
| `node --test tests/central-entradas/conciliacao-recuperacao-nfe-ausentes.test.js` | **17 pass, 0 fail** | `...\Temp\cds-conciliacao-nfe-Q60ZrQ\mercadao.db` |
| `node --test tests/central-entradas/microsprint-correcao-segura-cursor-656.test.js` | **15 pass, 0 fail** | `:memory:` + Temp `cds-cursor-656-*` |
| `npm run test:central-entradas` | **exit 0** | Temp `ce-sprint*` / `ce-rc1-*` / `ce-rc2-*` |

Nenhum teste desabilitado.

Cobertura P0.2: chave válida, malformada, DV inválido, empresa ausente, CNPJ ausente, ambiente ausente, incompatível, já existente, lote misto, Matriz/Filial 2/Filial 3, zero SOAP/PFX/210210/estoque, cursor e cooldown intactos, idempotência, falha de uma chave sem efeito nas outras.

---

## 6. Isolamento do banco

`isolarBancoTeste` na primeira linha executável. Guardião sqlite3 recusa `ProgramData\MercantilFiscal\dados`. P0.2 usa repositórios injetados + NSU `:memory:` — `database.js` **não** é carregado nesse arquivo. O log do guardião aponta `...\Temp\cds-prep-chave-*\mercadao.db` sem abrir o arquivo.

`npm run test:central-entradas` comprovou `BANCO DE TESTE COMPROVADO` em Temp (ex.: `ce-rc1-0YfpaU`). Zero ocorrências de `ProgramData\MercantilFiscal` nessa suíte.

---

## 7–9. Confirmações operacionais

| Controle | Situação |
|---|---|
| Chamada real à SEFAZ (`distNSU` / `consChNFe` / SOAP) | não executada |
| Certificado PFX de produção | não aberto (resolver de identidade injetado; `certificadoAberto: false`) |
| NSU / cooldown de produção | não lidos nem escritos |
| Banco oficial | não aberto |
| Manifestação 210210 | não enviada |
| Crédito de estoque / compra / financeiro | não criado |
| Git commit / push / merge | não executados |

---

## 10. Limitações e pendências para homologação futura

1. **Não recuperar ainda.** Falta lista de chaves do cliente (DANFE/XML) e autorização escrita para SOAP.
2. `consultarNotaPorChave` ainda aceita `getFiscalConfig` sem contexto — corrigir **antes** da execução real.
3. `GET /buscar-chave` continua sendo caminho de transmissão; a preparação P0.2 não o substitui nem o dispara.
4. `MotorRecuperacaoXmlService` e MIRX continuam podendo consultar SEFAZ em operação normal do produto — **não** foram acionados aqui e **não** devem ser ligados para o lote de outubro sem autorização.
5. Isolamento NSU continua por `(cnpj, ambiente)`, não `empresa_id`.
6. Chave ausente na Central **não** prova que a SEFAZ disponibilizou o XML no intervalo 28/09–17/10.
7. Certificado ausente na identidade → `PENDENTE_DE_REVISAO`, sem abrir o arquivo.
8. Outros testes da Central ainda sem o helper P0.1 não foram executados contra o banco oficial.

---

## Critérios de aceite

| Critério | Estado |
|---|---|
| Plano de reconciliação por chave funciona offline | Atendido |
| Empresa / CNPJ / ambiente obrigatórios e validados | Atendido |
| Duplicidade identificada sem crédito/importação | Atendido |
| Nenhuma chamada externa | Atendido |
| Cursor, cooldown e banco oficial intocados | Atendido |
| Testes em ambiente isolado | Atendido |
| Relatório com evidências | Atendido |

**Limite desta microsprint cumprido: preparar e validar offline. Não recuperar documentos.**
