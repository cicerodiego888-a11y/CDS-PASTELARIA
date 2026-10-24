# Microsprint P0.7 — Auditoria final e plano de recuperação controlada de NF-e

**Prioridade:** P0 — Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** auditoria de código + testes isolados + plano offline  
**Pré-requisitos:** P0–P0.6

**Decisão técnica: BLOQUEADO** para homologação autorizada de recuperação por chave.

Esta microsprint **não** consultou a SEFAZ, **não** abriu PFX de produção, **não** abriu o banco oficial, **não** alterou NSU/cooldown/estoque/compras/financeiro e **não** iniciou recuperação. Sem commit, push ou merge.

A preparação offline e o fail-closed de identidade estão prontos. A execução real **ainda pode ser acionada sem autorização explícita**. Por isso a homologação controlada **não** começa agora.

---

## 1. Arquivos inspecionados

| Arquivo | Papel |
|---|---|
| `backend/motores/central-entradas/services/CentralPreparacaoConsultaChaveService.js` | Plano offline; `executaSefaz: false`; `habilitado: false` |
| `backend/motores/central-entradas/config/preparacaoConsultaChaveClassificacoes.js` | Classificações locais |
| `backend/motores/central-entradas/utils/validarChaveNfe.js` | 44 dígitos + DV |
| `backend/services/fiscal/identidadeConsultaChave.js` | Fail-closed MULTIEMPRESA |
| `backend/services/fiscal/distribuicaoDFe.js` | `consultarNotaPorChave` + `persistirDocumentosRetorno` |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | `buscarPorChave` → identidade + Gate + SOAP |
| `backend/motores/central-entradas/CentralEntradasOrchestrator.js` | `buscarPorChave`; se `novo`, processa parser/MIIP |
| `backend/rotas/central-entradas.js` | Rotas que podem transmitir |
| `backend/rotas/dfe.js` | `GET /consultar-chave` → HTTP 410 |
| `backend/motores/central-entradas/services/CentralSefazOperationalGate.js` | Gate / cooldown / 656 |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | Mutex DistDFe (`sincronizar`) |
| `backend/motores/central-entradas/services/CentralDfePersistenciaService.js` | Idempotência `(chave, empresa_id)` |
| `backend/services/fiscal/pendenciasPersistenciaDfe.js` | `ERRO_BANCO` com chave; NSU DistDFe |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | `consChNFe` automático da fila |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig.js` | Default `ativa: true` |
| `frontend/erp/js/central-entradas.js` | `GET /buscar-chave` e `POST /sincronizar-ao-abrir` |
| Relatórios P0.2–P0.6, auditoria 28/09–17/10, conciliação | Fontes locais de evidência (não o banco oficial) |

---

## 2. Fluxo real identificado

### 2.1 Preparação (não transmite)

```
CentralPreparacaoConsultaChaveService.preparar()
  → validarChaveNfeCompleta (44 + DV)
  → empresaId obrigatório
  → identidade (permitirFallbackGlobal: false)
  → repositório local (mesma empresa / outra empresa / compra)
  → classificação  ·  executaSefaz: false
```

Não há rota HTTP para este serviço. Contrato futuro no retorno: `habilitado: false`, `exigeAutorizacao: true`.

### 2.2 Rotas que podem transmitir SOAP

| Rota | Método | O que faz | Acidental? |
|---|---|---|---|
| `/api/central-entradas/buscar-chave?chave=` | **GET** | Identidade → Gate → **`consultarNotaPorChave` (consChNFe)** se a nota não estiver local | **Sim** — busca na UI |
| `/api/central-entradas/sincronizar` | POST | DistDFe `distNSU` | Manual / diagnóstico |
| `/api/central-entradas/sincronizar-ao-abrir` | POST | DistDFe se `syncAoAbrir` | **Abertura da Central** |
| `/api/central-entradas/diagnostico/acoes/sincronizar` | POST | DistDFe | Diagnóstico |
| Motor XML (`recuperacao_xml_ativa`, default **true**) | scheduler | **consChNFe** nos docs `XML_INDISPONIVEL` / `RESUMO_RECEBIDO` | **Sim** — processo vivo |
| `/api/dfe/consultar-chave` | GET | **410** — desativado | Não |

```
GET /buscar-chave
  → resolverEmpresaParaCentral (X-Empresa-Id)
  → buscarPorChave
       → obterContextoOperacional
       → resolverIdentidadeConsultaChave  (fail-closed MULTIEMPRESA)
       → Gate
       → consultarNotaPorChave            ← SOAP consChNFe
       → persistirDocumentosRetorno (origem consulta_chave)
       → se novo: processarDocumentosPendentes (parser/MIIP)
```

Não existe flag `CDS_AUTORIZAR_CONSULTA_CHAVE` nem POST dedicado. O critério 3 (**execução exige decisão explícita e não pode ser GET nem abertura**) **não está atendido**.

### 2.3 Conferência dos oito pontos

| # | Exigência | Situação |
|---|---|---|
| 1 | Prep valida 44 dígitos, DV, empresa, CNPJ, ambiente | **Atendido** |
| 2 | Prep não SOAP / NSU / cooldown / estoque / compras | **Atendido** (`executaSefaz: false`; snapshot de cursor) |
| 3 | Execução futura só com autorização; não GET nem abrir Central | **Não atendido** — GET `/buscar-chave` + motor XML default on + sync ao abrir |
| 4 | MULTIEMPRESA sem identidade alheia nem `getFiscalConfig` global | **Atendido** no código de identidade (`permitirFallbackGlobalConsultaChave` só EMPRESA_SIMPLES explícito) |
| 5 | Gate / identidade / cooldown / mutex → consulta não executada | **Parcial** — identidade e Gate bloqueiam antes do SOAP (`consultaExecutada: false` / throw). Mutex DistDFe (`CentralSyncExecucaoService`) **não** envolve `consultarNotaPorChave` |
| 6 | Resposta ≠ recuperada até XML+metadados persistidos | **Parcial** — DistDFe recusa avanço de NSU se `errosPersistencia`. `consultarNotaPorChave` devolve `sucesso: true` mesmo com `errosPersistencia` na persistência |
| 7 | Falha de persistência não avança cursor nem mente “concluído” | **Atendido no DistDFe**; **risco no consChNFe** (item 6) |
| 8 | Repetir não duplica documento nem crédito de estoque | **Atendido** — `UNIQUE(chave, empresa_id)`; compra existente → `IMPORTADA` duplicada sem segundo crédito (teste isolado) |

---

## 3. Testes isolados

Todas as suítes abaixo usam `-r preloadIsolamentoBanco.js` (npm ou `node -r`). Nenhum stdout contém `C:\ProgramData\MercantilFiscal\dados`. MIB, quando `database.js` carregou: **0** produtos.

| Comando | Resultado | Banco comprovado |
|---|---|---|
| `npm run test:central-entradas-identidade-chave` | **15 pass** | `...\Temp\cds-preload-vktHGH\mercadao.db` |
| `npm run test:central-entradas-prep-chave` | **17 pass** | `...\Temp\cds-preload-I3arn9\mercadao.db` (prep não abre `database.js`) |
| `npm run test:central-entradas-cursor-656` | **15 pass** | `...\Temp\cds-preload-GWIcbn\mercadao.db` |
| `node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test tests/central-entradas/recuperacao-segura-nfe-ausentes.test.js` | **13 pass** | `...\Temp\cds-recup-nfe-utIfil\mercadao.db` — SQLITE_BUSY **não** avança NSU; retry fecha pendência; DistDFe repetido não duplica |
| `npm run test:central-entradas` | **exit 0** | Temp `cds-preload-*` (`LDplY8`, `9K2Kdc`, `Fd4jk4`, `ShTEI0`, `szUyQf`, `q4mhQo`, `17ODXe`, `USAqWa`) |
| `npm run test:central-entradas-rc3` | **12 ok** | `...\Temp\cds-preload-Yl6wH6\mercadao.db` |
| `npm run test:central-entradas-rc4` | **16 ok** | `...\Temp\cds-preload-mt97cY\mercadao.db` |

Nenhum teste desabilitado. Homologação e2e, seed e leitura do oficial **não** executados.

---

## 4. Lista offline de chaves

**Inventário de produção desta sprint: vazio de propósito.** O banco oficial não foi aberto. Não há chaves, `empresa_id` nem NSU atuais para classificar.

Fontes locais usadas (documentos já preservados, **sem** nova leitura SQLite):

| Fonte | O que prova | O que não prova |
|---|---|---|
| Auditoria 28/09–17/10 | Inbox local com **0** chaves AAMM `2610` naquela leitura | Que a SEFAZ não emitiu outubro |
| Mesma auditoria | Pulos de NSU em 656 (`AUTO_SYNC`) sem lote | Que cada NSU pulado continha NF-e |
| Conciliação (fixtures isolados) | Classificador A–E funciona em Temp | Estado da loja |
| Relatórios XML reais | Algumas chaves **setembro** já vistas (ex. `232609…520828`, `232609…1315265`) | Candidatas de outubro |

### 4.1 Candidatas a recuperação (produção)

**Nenhuma chave ELEGIVEL_PARA_ANALISE.** Falta lista do operador (DANFE/XML de outubro).

Não se inventou chave a partir de intervalo de NSU.

### 4.2 Classificação das evidências existentes (não consultar)

| Evidência | Empresa | Chave | Origem | Local (na auditoria prévia) | Validação estrutural | Identidade para consulta futura | Classe P0.7 |
|---|---|---|---|---|---|---|---|
| Outubro AAMM `2610` na inbox | Matriz / F2 / F3 | — | auditoria 28/09–17/10 | Ausente (0 docs) | — | A da empresa dona do DANFE | sem chave → não classificar como elegível |
| NSUs pulados (Matriz 128–195 etc.) | por CNPJ do cursor | **desconhecida** | `AUTO_SYNC` 656 | Não há ZIP/PARSER | — | — | **não presumir NF-e**; sem chave = irrecuperável por DistDFe |
| NF 520828 | dest. `38204469…0001-15` (relatório) | `23260908606343000106550080005208281025774244` | XML-REAL-01 | Ciência 135 persistida | 44 dígitos (documento histórico) | empresa do destinatário no cadastro | **JA_EXISTE_LOCALMENTE** (não tratar como nova) |
| NF 1315265 | — | `23260907196033002141550090013152651839613616` | AUDIT-01 | Citada como persistida | 44 dígitos (documento histórico) | conferir `empresa_id` na leitura autorizada futura | **JA_EXISTE_LOCALMENTE** até prova em contrário |
| Fixture teste `352610…00011` | 11 (só teste) | sintética | suíte isolada | Temp | DV de fixture | não é loja | ignorar na operação |
| DANFE outubro do cliente | a informar | a informar | operador | desconhecido | prep quando houver chave | empresaId + CNPJ + ambiente + PFX **dessa** empresa | só então `ELEGIVEL_PARA_ANALISE` |

Mapeamento prep → rótulos pedidos: `ELEGIVEL_PARA_CONSULTA` → `ELEGIVEL_PARA_ANALISE`; `DOCUMENTO_JA_EXISTE` → `JA_EXISTE_LOCALMENTE`; CNPJ/ambiente incompletos → `IDENTIDADE_INCOMPLETA`; `CHAVE_INVALIDA`; `CHAVE_INCOMPATIVEL_COM_EMPRESA` → `CONFLITO_EMPRESA`.

---

## 5. Riscos remanescentes

1. **GET `/buscar-chave` transmite consChNFe** se identidade e Gate passarem.
2. **Motor XML default `ativa: true`** reconsulta consChNFe sozinho.
3. **Abertura da Central** pode DistDFe (`sincronizar-ao-abrir`).
4. **Mutex DistDFe não cobre consChNFe** — possível SOAP paralelo com sync.
5. **`consultarNotaPorChave` pode devolver `sucesso: true` com persistência incompleta.**
6. **Sem chaves de outubro do cliente**, DistDFe no cursor atual não recupera NSUs pulados.
7. **Impacto 05.72** no oficial continua indeterminado (P0.5); leitura autorizada ainda não executada.
8. PFX de produção **não** foi verificado nesta sprint (de propósito).

---

## 6. O que um plano operacional futuro precisa (não executado)

1. Autorização escrita (operador, data, lista de chaves, empresaId).
2. Desligar motor XML e sync-ao-abrir durante a janela, ou garantir Gate/cooldown que bloqueie DistDFe paralelo.
3. Substituir GET de recuperação por **POST** com confirmação (não implementar aqui).
4. Rodar só `CentralPreparacaoConsultaChaveService` nas chaves do cliente (offline).
5. Executar `consultarNotaPorChave` uma chave por vez, identidade da **mesma** empresa, sem rewind de NSU, sem 210210.
6. Sucesso = linha em `central_entradas_documentos` com XML + `COUNT(chave, empresa_id)=1`. Recusa se `errosPersistencia`.
7. Não creditar estoque automaticamente; parser/MIIP só depois da persistência durável.

---

## 7. Decisão

**BLOQUEADO.**

Justificativa: os blocos de preparação, identidade MULTIEMPRESA, Gate e persistência DistDFe estão testados em Temp. A homologação controlada de **recuperação por chave** exige que o SOAP `consChNFe` **não** saia por GET, pela abertura da tela nem pelo scheduler XML. Isso ainda acontece. Não há lista operacional de chaves ausentes de outubro. Consulta à SEFAZ continua a exigir autorização e plano separados.

**Não executar homologação real nem recuperação de NF-e nesta etapa.**

---

## Confirmações

| Item | Estado |
|---|---|
| Banco oficial | não aberto |
| SOAP DistDFe / consChNFe / 210210 reais | não |
| PFX de produção | não |
| NSU / cooldown / estoque / compras / financeiro | não alterados |
| Fallback global MULTIEMPRESA | não reintroduzido |
| Git commit / push / merge | não |
