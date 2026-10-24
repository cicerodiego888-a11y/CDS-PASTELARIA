# OF-01 — Auditoria técnica Open Finance Itaú

**Sprint:** OF-01  
**Data:** 17/10/2026  
**Prioridade:** P0  
**Status:** CONCLUÍDA — DIAGNÓSTICO NO-GO  
**Decisão:** **não declarar Open Finance Itaú em produção.**  
**Correções de código nesta sprint:** nenhuma (nenhum defeito comprovado no escopo exigiu alteração).

Este relatório não é evidência de conexão bancária real. Mocks, harness e adapters preparados **não** substituem acesso oficial, consentimento válido, homologação e operação assistida.

---

## 0. Conclusão executiva

O Motor Bancário próprio do CDS **está preservado e operacional** para o núcleo (contas, transações, idempotência, conciliação manual, matching, secrets, multiempresa). A preparação para um provider real existe. **A integração Open Finance Itaú não está concluída.**

Há **dois produtos distintos** no repositório e na documentação pública. Não podem ser tratados como o mesmo acesso:

| Produto | O que é | Estado no CDS |
|---------|---------|----------------|
| **Open Finance Brasil** (compartilhamento regulado, consentimento do titular, Diretório de Participantes) | APIs padronizadas BACEN (`accounts`, `balances`, `transactions`) entre instituições autorizadas | Adapter `OPEN_FINANCE_REAL` **preparado e bloqueado**. Ciclo de consentimento homologado só em **MOCK**. Instituição oficial = `null`. |
| **Itaú for Developers** (APIs do portal, Client Credentials + mTLS) | Integração server-to-server do correntista/parceiro PJ com o portal Itaú | Provider `ITAU` **preparado** (OAuth, mTLS, saldo/extrato configuráveis). **E2E real bloqueado** por credenciais, certificado e paths de produto não confirmados. `suportaAutorizacao = false` (não usa consentimento Open Finance). |

**CDS não pode, com o material atual, afirmar que “conecta no Open Finance do Itaú”.**

Motivos objetivos:

1. `INSTITUICAO_OFICIAL`, `DOCUMENTACAO_OFICIAL_URL`, `PRODUTO_OPEN_FINANCE_OFICIAL` e `OAUTH_OFICIAL` continuam `null` em `prontidaoOperacaoReal.js`.
2. O portal Itaú de Open Finance, na página pública consultada, descreve sobretudo a **Fase 1 (Open Data)** — dados abertos, sem login. Isso **não** é consulta de saldo/extrato da conta da Pastelaria.
3. Participar do Open Finance Brasil como receptora exige instituição **autorizada pelo Banco Central** e cadastro no Diretório. Entes não regulados só entram por **parceria** com instituição autorizada. CDS Sistemas / ERP da Pastelaria **não** comprovam essa autorização neste repositório.
4. O caminho já implementado (`ITAU`) é o do **portal de desenvolvedores** (Client Credentials), não o fluxo OAuth de consentimento Open Finance.
5. Paths oficiais de saldo/extrato Itaú **não** estão versionados: o adapter recusa operação com `ENDPOINT_NAO_CONFIGURADO` até `ITAU_PATH_SALDO` / `ITAU_PATH_EXTRATO` (ou URLs equivalentes) serem confirmados no portal.
6. Nenhuma chamada HTTP real a `sts.itau.com.br`, `api.itau.com.br` ou sandbox Itaú foi feita nesta sprint.

**GO/NO-GO de produção Open Finance Itaú: NO-GO.**

---

## 1. Arquivos e componentes examinados

### 1.1 Adapter Open Finance real

- `backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js`
- `backend/motores/bancario/providers/openfinance-real/OpenFinanceRealClient.js`
- `backend/motores/bancario/providers/openfinance-real/OpenFinanceRealMapper.js`
- `backend/motores/bancario/providers/openfinance-real/OpenFinanceRealConstants.js`
- `backend/motores/bancario/providers/openfinance-real/ambienteEndpoints.js`
- `backend/motores/bancario/providers/openfinance-real/Auth.js`
- `backend/motores/bancario/providers/openfinance-real/prontidaoOperacaoReal.js`
- `backend/motores/bancario/providers/openfinance-real/auditoriaProntidao.js`
- `backend/motores/bancario/providers/openfinance-real/retrySeguro.js`
- `backend/motores/bancario/providers/openfinance-real/rateLimitProvider.js`
- `backend/motores/bancario/providers/openfinance-real/operacaoAssistida.js`
- `backend/motores/bancario/providers/openfinance-real/rollbackOperacaoReal.js`
- `backend/motores/bancario/providers/openfinance-real/BankProvider.js`
- `backend/motores/bancario/providers/openfinance-real/Client.js`
- `backend/motores/bancario/providers/openfinance-real/Mapper.js`
- `backend/motores/bancario/providers/openfinance-real/Constants.js`
- `backend/motores/bancario/providers/openfinance-real/Errors.js`
- `backend/motores/bancario/providers/openfinance-real/Retry.js`

### 1.2 Consentimento, registry e núcleo

- `backend/motores/bancario/services/ConsentimentoOpenFinanceService.js`
- `backend/motores/bancario/providers/BankProviderRegistry.js`
- `backend/motores/bancario/providers/MockOpenFinanceProvider.js`
- `backend/motores/bancario/providers/MockBankProvider.js`
- `backend/motores/bancario/contracts/IBankProvider.js`
- `backend/motores/bancario/contracts/constantes.js`
- `backend/motores/bancario/contracts/sanitizarMbc.js`
- `backend/motores/bancario/contracts/TransacaoBancariaNormalizada.js`
- `backend/motores/bancario/contracts/SaldoBancarioNormalizado.js`
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/motores/bancario/services/SincronizacaoBancariaService.js`
- `backend/motores/bancario/services/TransacaoBancariaService.js`
- `backend/motores/bancario/services/ConciliacaoBancariaService.js`
- `backend/motores/bancario/matching/MotorMatchingBancarioService.js`
- `backend/motores/bancario/secrets/EncryptedLocalSecretStore.js`
- `backend/motores/bancario/secrets/MemorySecretStore.js`
- `backend/motores/bancario/version.js`

### 1.3 Provider Itaú (portal de desenvolvedores — não é Open Finance regulado)

- `backend/motores/bancario/providers/itau/ItauBankProvider.js`
- `backend/motores/bancario/providers/itau/ItauOAuthClient.js`
- `backend/motores/bancario/providers/itau/ItauApiClient.js`
- `backend/motores/bancario/providers/itau/ItauMapper.js`
- `backend/motores/bancario/providers/itau/ItauConstants.js`
- `backend/motores/bancario/providers/itau/ItauCertificadoUtil.js`
- `backend/motores/bancario/services/ItauCredenciaisService.js`
- `backend/motores/bancario/services/ItauOperacaoService.js`

### 1.4 Documentação interna

- `docs/bancario/MBC-10-PROVIDER-OPEN-FINANCE-REAL.md`
- `docs/bancario/MBC-06-OPEN-FINANCE-CONSENTIMENTO.md`
- `docs/bancario/MBC-11-AUTORIZACAO-REAL.md`
- `docs/bancario/MBC-13-CHECKLIST-PRODUCAO.md`
- `docs/bancario/MBC-13-MATRIZ-PRONTIDAO.md`
- `docs/bancario/MBC-13-RELATORIO.md`
- `docs/bancario/MBC-13-CHECKLIST-PROVIDER.md`
- `docs/bancario/MBC-ITAU-01-RELATORIO.md`
- `docs/bancario/MBC-ITAU-01.1-RELATORIO.md`
- `docs/bancario/MBC-ITAU-02-RELATORIO.md`
- `docs/bancario/MBC-ITAU-CONFIGURACAO.md`

### 1.5 Testes

36 suítes em `tests/bancario/motor-bancario-*.test.js`, incluindo `motor-bancario-06`, `07`, `10`, `11`, `12`, `13` e `motor-bancario-itau-01`, `itau-01-1`, `itau-02`.

### 1.6 Fontes oficiais consultadas (somente leitura de documentação pública)

Nenhuma chamada a API bancária, STS, sandbox de produto ou SEFAZ.

- [Itaú for Developers — Open Finance](https://devportal.itau.com.br/nossas-apis/openfinance) (consulta em 17/10/2026)
- [Itaú — Autenticação mTLS / OAuth](https://devportal.itau.com.br/autenticacao-documentacao)
- [Itaú — Como se conectar](https://devportal.itau.com.br/como-se-conectar-as-apis-itau)
- [Itaú — Primeira chamada](https://devportal.itau.com.br/como-fazer-a-primeira-chamada-a-uma-api)
- [Itaú — Credenciais e certificado](https://devportal.itau.com.br/guia-de-criacao-de-credencial-e-certificado)
- [Open Finance Brasil — Onboarding](https://openfinancebrasil.org.br/onboarding/)
- [Open Finance Brasil — API Accounts v2.5.1 (especificação pública)](https://raw.githubusercontent.com/OpenBanking-Brasil/all-services-repo/refs/heads/main/api_accounts_-_open_finance_brasil/2.5.1.yaml)
- [PRD API de Contas v2.5.0](https://openfinancebrasil.atlassian.net/wiki/spaces/OF/pages/1738965008/Documento+de+Requisito+do+Produto+PRD+-+API+de+Contas+v2.5.0)

Contrato técnico Itaú específico (Open Finance transacional da conta da Pastelaria, URLs de homologação Itaú OF, produto Account Statement contratado): **não disponível neste repositório.**

---

## 2. Distinção obrigatória (não misturar)

### 2.1 Open Finance Brasil

Fluxo regulado: consentimento do titular → autorização no banco transmissor → token associado a `consentId` `AUTHORISED` → APIs padronizadas (`/accounts`, `/balances`, `/transactions`) com permissions (`ACCOUNTS_READ`, `ACCOUNTS_BALANCES_READ`, `ACCOUNTS_TRANSACTIONS_READ`).

Quem participa: instituições autorizadas pelo Banco Central, cadastradas no Diretório, com certificados ICP-Brasil. Software house / ERP **não autorizado** não entra como TPP/receptora por conta própria.

O portal Itaú afirma explicitamente que instituições **não** autorizadas pelo BC **não** fazem parte do Open Finance, salvo **contrato de parceria** com instituição autorizada e consentimento prévio do cliente comum.

A página Itaú Open Finance consultada nesta data detalha a **1ª fase (Open Data)**: agências, canais, produtos e tarifas — **acesso público, sem parceiro**. Isso **não** entrega saldo nem extrato da conta corrente 7751 / ••••2762-8.

### 2.2 Itaú for Developers (já esboçado no MBC)

Fluxo server-to-server: Client ID + Client Secret → (produção) certificado dinâmico + mTLS → `POST` STS → Bearer → GET de produto.

Documentação Itaú pública confirma:

- Produção: OAuth 2.0 `client_credentials` + mTLS; token ~300 s; URL de token `https://sts.itau.com.br/api/oauth/token`; API `https://api.itau.com.br/{api}/{versao}/{recurso}`.
- Sandbox: **não** segue OAuth 2.0 e **não** tem mTLS (documentação de autenticação Itaú). Tokens de sandbox só chamam URL de sandbox.

O provider `ITAU` no CDS implementa esse modelo. **Não** implementa consentimento Open Finance (`ItauBankProvider.suportaAutorizacao === false`). O sync Itaú **dispensa** `consentimento_open_finance` de propósito (MBC-ITAU-02).

**Não se presume** que Account Statement / Extrato do portal Itaú seja a API Open Finance Brasil de contas. São produtos diferentes até o Itaú confirmar, por escrito, qual modalidade a CDS pode usar.

---

## 3. Estado de cada requisito

Legenda: **IMPLEMENTADO E TESTADO** · **IMPLEMENTADO PARCIALMENTE** · **MOCK** · **NÃO IMPLEMENTADO** · **BLOQUEADO POR DEPENDÊNCIA EXTERNA**.

Quando o item depende de confirmação Itaú/BACEN sem contrato no repositório, a coluna “OF Itaú real” usa **BLOQUEADO POR DEPENDÊNCIA EXTERNA** ou **PENDENTE DE CONFIRMAÇÃO** (ver seção 6).

| # | Requisito | Núcleo MBC / MOCK | `OPEN_FINANCE_REAL` | Provider `ITAU` (portal) | OF Itaú real (produção) |
|---|-----------|-------------------|---------------------|--------------------------|-------------------------|
| 1 | Consentimento e ciclo de autorização | **IMPLEMENTADO E TESTADO** (MBC-06: INICIADO → AGUARDANDO → AUTORIZADO / NEGADO / EXPIRADO / REVOGADO; state 32 bytes, TTL 10 min, uso único; empresa/conta no state) | **IMPLEMENTADO PARCIALMENTE**: contrato `iniciarAutorizacao` / callback / revogar; execução recusada sem instituição oficial. OAuth Mercado Pago reutiliza este provider (outro produto). | **NÃO IMPLEMENTADO** para OF (por desenho). Auth = Client Credentials. | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| 2 | Autenticação e tokens | **MOCK** no OF; SecretStore `mbc.of.consent.{id}` | Tokens só com transport/oficial; produção exige cofre. Sem protocolo OF Itaú. | **IMPLEMENTADO PARCIALMENTE**: OAuth CC + cache 300 s / margem 30 s + mTLS em produção; **não testado contra STS real**. | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| 3 | Configuração de endpoints | Ambientes SANDBOX / HOMOLOGACAO / PRODUCAO no modelo | URLs só via env `MBC_OF_REAL_*`; sem default de instituição. Separação sandbox≠prod validada. | Bases OAuth/API versionadas em `ITAU_ENDPOINTS`. Paths de saldo/extrato **sem default**. | **PENDENTE DE CONFIRMAÇÃO** (URLs OF Itaú e paths de produto) |
| 4 | Consulta de contas | **MOCK** (`MOCK_OPEN_FINANCE`) | Mapper genérico; HTTP recusado sem oficial | **NÃO IMPLEMENTADO** (`listarContas` → 501) | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| 5 | Consulta de saldos | **IMPLEMENTADO E TESTADO** no MOCK + DTO `SaldoBancarioNormalizado`; saldo bancário ≠ conceitual | Mapper genérico (`availableAmount` / `valor`); bloqueado sem oficial | **IMPLEMENTADO PARCIALMENTE**: consulta live se path/URL configurados; testes só MOCK | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** |
| 6 | Consulta e paginação de transações | **IMPLEMENTADO E TESTADO** (MBC-07: `{ transacoes, has_more, next_cursor }`) | Mapper genérico `data` / `links.next`; semântica OF Brasil usa `page`/`pageSize` — **não mapeada ao Itaú** | **IMPLEMENTADO PARCIALMENTE**: mapper CREDIT/DEBIT + cursor opaco; path obrigatório | **PENDENTE DE CONFIRMAÇÃO** (paginação oficial Itaú / OF) |
| 7 | Sincronização incremental e cursores | **IMPLEMENTADO E TESTADO** (checkpoint `sincronizacao_bancaria`; cursor só avança após persistir) | Mesmo núcleo; provider real não executa | Ramo Itaú no sync **sem** consentimento OF; cursor reutilizado | **BLOQUEADO POR DEPENDÊNCIA EXTERNA** (sem extrato real) |
| 8 | Idempotência / duplicidades | **IMPLEMENTADO E TESTADO** (`empresa_id + conta_bancaria_id + external_source + external_id`; 2ª = `JÁ EXISTENTE`) | `external_source = OPEN_FINANCE_REAL` | `external_source = ITAU`; comprovado em mock | Depende de `transactionId` estável oficial — **PENDENTE DE CONFIRMAÇÃO** |
| 9 | Retry, rate limit, indisponibilidade | **IMPLEMENTADO E TESTADO** no núcleo: retry só TIMEOUT / 429 / 5xx; sem retry de auth | `RATE_LIMIT_PROVIDER.status = PENDENTE`, `limite = null` | Classifica TLS vs OAuth vs timeout; sem catálogo oficial Itaú | **PENDENTE DE CONFIRMAÇÃO** |
| 10 | Segredos, logs, dados pessoais | **IMPLEMENTADO E TESTADO** (`sanitizarObjetoMbc`; tokens/PEM fora de JSON/UI; `rejectUnauthorized: true`) | Tokens em SecretStore conceitual | Client secret / cert / key no SecretStore; status só flags | Cofre de **produção** (Vault/HSM) = **NÃO IMPLEMENTADO**. SecretStore local cifrado = transitório |
| 11 | Isolamento empresa / conta | **IMPLEMENTADO E TESTADO** (contexto oficial; body/query `empresa_id` sem autoridade; consentimento.empresa_id = conta.empresa_id) | Idem | Config por conta; sync Itaú no contexto da conta | Sem evidência real multiempresa contra Itaú |
| 12 | Persistência, auditoria, conciliação | **IMPLEMENTADO E TESTADO**: `transacao_bancaria`, conciliação manual (MBC-04/05), matching só sugere (MBC-08). Origens: `FINANCEIRO` (despesas/compras no financeiro), `CONTAS_RECEBER`, `CONTAS_RECEBER_PAGAMENTO`. Sem auto-conciliação. | Não grava SQL no adapter | Reusa as mesmas tabelas | Conciliação com movimentos **reais** Itaú: **NÃO IMPLEMENTADO** (não há extrato real) |
| 13 | Testes, homologação, bloqueios de produção | **IMPLEMENTADO E TESTADO** (829 testes MBC nesta execução) | Feature flag + `providerRealPodeOperar` → recusa; `DECISAO_ATUAL = NO-GO` | Testes MOCK; E2E real bloqueado nos relatórios ITAU-01.1/02 | Checklist MBC-13 **todos os itens de produção desmarcados**. **PRODUÇÃO BLOQUEADA** |

### 3.1 Detalhe do ciclo de consentimento (item 1)

Implementação real no CDS (MOCK / núcleo):

- Tabela `consentimento_open_finance` + `consentimento_of_state`.
- Escopos internos: `CONTAS`, `SALDOS`, `TRANSACOES` — **não** são as permissions oficiais `ACCOUNTS_*`.
- Validade interna após autorização: **90 dias** (`CONSENT_VALIDITY_MS`). A validade oficial Open Finance Brasil **não** está confirmada neste código; não usar 90 dias como regra Itaú.
- Callback `GET /api/bancario/open-finance/callback`; empresa vem do state, nunca da URL.
- `AUTORIZADO` ≠ extrato sincronizado.

Provider Itaú: **não entra neste ciclo**.

### 3.2 Prontidão Open Finance real (código)

Em `prontidaoOperacaoReal.js` (valores atuais):

- `INSTITUICAO_OFICIAL = null`
- `DOCUMENTACAO_OFICIAL_URL = null`
- `PRODUTO_OPEN_FINANCE_OFICIAL = null`
- `OAUTH_OFICIAL = null`
- `CERTIFICADO_OFICIAL_EXIGIDO = null`
- `secretStoreProducaoDisponivel() = false`
- `producao_controlada = false`
- `operacao_assistida = false`

`oficialHabilitado` exige `MBC_OF_REAL_HABILITADO=1` **e** `MBC_OF_REAL_AUTH_URL` + `TOKEN_URL` + `API_URL`. Ligar a flag **sem** contrato oficial não habilita produção: a instituição continua nula e a decisão permanece NO-GO.

---

## 4. Fase B — Validação isolada

### 4.1 Isolamento do banco oficial (comprovado)

Banco oficial **não aberto e não modificado**.

| Item | Valor |
|------|--------|
| Caminho oficial | `C:\ProgramData\MercantilFiscal\dados\mercadao.db` |
| Antes (LastWriteTimeUtc) | `2026-10-17T15:01:29.1668489Z` |
| Antes (tamanho) | `46739456` bytes |
| Depois (LastWriteTimeUtc) | `2026-10-17T15:01:29.1668489Z` |
| Depois (tamanho) | `46739456` bytes |
| Diretório `dados` | inalterado (`2026-10-17T15:01:29.1738651Z`) |
| `DB_DIR` da execução | `C:\Users\cicer\AppData\Local\Temp\of01-mbc-db-5a3451b7-c869-4102-9aa5-8479755b016f` |
| `DB_DIR` é o oficial? | **não** |

Provas adicionais:

- Nenhum arquivo em `tests/bancario` referencia `C:\ProgramData\MercantilFiscal\dados`.
- 34 suítes abrem SQLite `:memory:`.
- `motor-bancario-15-1.test.js` usa arquivo em `os.tmpdir()` / `DB_DIR` temporário (não o oficial). A menção a `MercantilFiscal` nesse teste é **leitura de código-fonte** do fallback, não abertura do banco de produção.
- `motor-bancario-14-4-1`, `16-4` e `15-3` não abrem o banco oficial (fonte frontend / HTTP localhost).
- Variáveis `MBC_OF_REAL_*`, `ITAU_CLIENT_*`, `ITAU_PATH_*`, `ITAU_SALDO_URL`, `ITAU_EXTRATO_URL`, `ITAU_TLS_CA` **ausentes** no ambiente da execução.

### 4.2 Comando executado

```text
Node: v24.19.0
Cwd:  C:\projetos\CDS-SISTEMAS PASTELARIA
Env:  DB_DIR=<temp of01-mbc-db-...>
      CDS_FORCAR_LOCAL=1
      (sem credenciais Itaú/OF real)

node --test tests/bancario/motor-bancario-*.test.js
```

36 arquivos. Sem certificados de produção. Sem SEFAZ. Sem POST/GET a hosts Itaú.

### 4.3 Resultado real

```text
tests     829
suites     79
pass      829
fail        0
cancelled   0
skipped     0
todo        0
duration_ms 8786.7722
EXIT_CODE   0
```

Suítes relevantes (todas ✔):

- MBC-06 Open Finance e consentimento
- MBC-07 saldo / extrato / idempotência / paginação / cursor / erro / multiempresa
- MBC-10 adapter OF real (preparado)
- MBC-11 autorização real (não implementada contra instituição)
- MBC-12 / MBC-13 bloqueio de produção e NO-GO
- MBC-04 / 05 / 05.3 / 05.4 conciliação e matching (financeiro despesa, contas a receber)
- MBC-ITAU-01 / 01.1 / 02 (MOCK; o próprio `itau-02` declara que **não** é conexão real)

### 4.4 Cobertura do que a sprint pediu para validar

| Validação pedida | Resultado nesta execução |
|------------------|--------------------------|
| Consentimento simulado válido/inválido | Coberto por MBC-06 (aprovação, recusa, expiry, replay, state inválido) |
| Autorização ligada à empresa e conta corretas | Coberto (isolamento A/B; callback de outra empresa rejeitado) |
| Normalização de saldos e transações | Coberto MOCK OF + mapper Itaú MOCK |
| Paginação e sync incremental | Coberto MBC-07 (MOCK); Itaú-02 MOCK |
| Reexecução sem duplicar lançamentos | Coberto (`CRIADA` / `JÁ EXISTENTE`) |
| Recuperação de falhas e retry | Coberto MBC-07/09/10 (categorias retentáveis) |
| Separação entre empresas | Coberto em várias suítes |
| Conciliação vendas/recebimentos/despesas/compras | Núcleo: contas a receber + pagamentos + financeiro `despesa`. **Não** há conciliação contra extrato Itaú real. Matching **não** grava conciliação automática. |
| Tokens/dados sensíveis nos logs | Coberto (sanitizer; testes Itaú 01/01.1) |
| Regressão do Motor Bancário | 829/829 |

**Mocks não foram tratados como evidência de Open Finance real.**

Não foram inventados testes que presumissem endpoints Itaú OF, consentimento Itaú OF ou paths de Account Statement.

---

## 5. Fase C — Matriz oficial Itaú / Open Finance Brasil

Comparação **sem chamadas reais**. Onde a documentação Itaú específica da conta da Pastelaria não está no repositório, o item é **PENDENTE DE CONFIRMAÇÃO**.

| Tema | O que a documentação pública diz | O que o CDS faz hoje | Status |
|------|----------------------------------|----------------------|--------|
| Modalidade de acesso direto permitida à CDS | OF Brasil: só instituição autorizada BC, ou parceria com uma delas. Portal Itaú: correntista PJ deve falar com o gerente para APIs de produto. Fase 1 OF Itaú é Open Data público. | CDS tem adapter OF genérico + provider portal Itaú. **Nenhuma modalidade oficial está contratada no código.** | **PENDENTE DE CONFIRMAÇÃO** |
| Participação, cadastro, autorização regulatória | Diretório OF: comprovação de autorização BC para `cadastro@openfinancebrasil.org.br`; app + cert ICP-Brasil; roles (ex.: DADOS). | CDS não está cadastrado como participante neste repositório. | **PENDENTE DE CONFIRMAÇÃO** / bloqueio regulatório provável para TPP direto |
| APIs contas empresariais | OF Brasil API Accounts v2: contas depósito/poupança/pagamento pré-paga, PF e PJ no padrão, **mediante consentimento**. Itaú Open Data Fase 1: catálogo de produtos, **não** a conta 7751. Account Statement do portal: produto distinto, contratação **não comprovada** aqui. | `listarContas` Itaú = 501. OF real = mapper genérico bloqueado. | **PENDENTE DE CONFIRMAÇÃO** |
| OAuth / consentimento oficiais | OF: consentimento + token ligado a `consentId` AUTHORISED + permissions. Portal Itaú: `client_credentials` + mTLS em **produção**; sandbox **sem** OAuth 2.0 / sem mTLS (doc autenticação). | MBC-06 = fluxo genérico/MOCK. Itaú CDS = Client Credentials (inclusive sandbox JWT em `sandbox.devportal.itau.com.br/api/oauth/jwt`). | Sandbox JWT vs “sandbox sem OAuth 2.0”: **PENDENTE DE CONFIRMAÇÃO**. Não alterar código com base em suposição. |
| URLs homologação / produção OF Itaú | OF Brasil publica hosts **genéricos** na spec (`apih.banco.com.br/...` como exemplo de transmissor). **Host Itaú OF transacional da conta da Pastelaria não está neste repo.** Portal: `sts.itau.com.br`, `api.itau.com.br`, sandbox `sandbox.devportal.itau.com.br`. | Itaú CDS usa as bases do portal. OF real não tem URL. | URLs **de produto** saldo/extrato: **PENDENTE DE CONFIRMAÇÃO**. Não inventar path. |
| Certificados / credenciais / segurança | OF: ICP-Brasil + mTLS (`tls_client_auth`). Portal Itaú: certificado dinâmico 365 dias, Client ID/Secret, token 300 s, CA Itaú. | Validação PEM, par cert/key, mTLS `rejectUnauthorized: true`. Sem material real. | Credenciais reais: **NÃO CONFIGURADO** |
| Escopos contas / saldos / transações | OF: scope `accounts` + permissions `ACCOUNTS_READ`, `ACCOUNTS_BALANCES_READ`, `ACCOUNTS_TRANSACTIONS_READ`. | Escopos internos `CONTAS`/`SALDOS`/`TRANSACOES`. | **PENDENTE DE CONFIRMAÇÃO** (não equivalentes oficiais) |
| Paginação, limites, expiração, renovação | OF Accounts: `page`, `pageSize`, `fromBookingDate`, `toBookingDate`. Consentimento OF tem regras regulatórias próprias (não copiadas aqui). Portal Itaú: rate limit **não** documentado neste repo. | Cursor opaco MBC; validade consentimento 90 dias **interna**; rate limit `null`. | **PENDENTE DE CONFIRMAÇÃO** |
| Homologação e liberação produção | OF: onboarding Diretório + registro do software em cada transmissor. Portal Itaú: jornada de credencial → certificado → primeira chamada, após contratar produto com especialista. | Checklist MBC-13 incompleto; `producao_controlada = false`. | **BLOQUEADO** |

**Não se assume** que a API genérica Open Finance Brasil, o Open Data Itaú Fase 1, o OAuth Mercado Pago (`OPEN_FINANCE_REAL`) ou o Account Statement do portal sejam o mesmo produto.

---

## 6. Pendências que dependem do Itaú (e/ou da governança Open Finance)

1. **Qual modalidade a CDS pode usar** para a conta Itaú da Pastelaria (Filial 2 / CNPJ 38.204.469/0003-87, agência 7751):  
   - (A) parceria/portal Itaú for Developers (Client Credentials + produto Extrato/Saldo);  
   - (B) Open Finance Brasil via instituição receptora autorizada;  
   - (C) outra.  
   Sem essa resposta, **não iniciar sprint de implementação OF “real”**.
2. Comprovação de participação (autorização BC **ou** contrato de parceria Itaú).
3. Produto contratado no portal (nome oficial, versão, ambientes).
4. Client ID / Client Secret **oficiais** (nunca versionar).
5. Certificado dinâmico + private key + CA, se o produto exigir mTLS.
6. URLs oficiais de sandbox, homologação e produção **do produto escolhido**.
7. Paths oficiais de saldo, extrato e (se existir) listagem de contas.
8. Escopos/permissions oficiais.
9. Regras de paginação, rate limit, catálogo de erros, política de retry.
10. Validade e renovação de consentimento **se** a modalidade for Open Finance.
11. Redirect URI / Authorization Server **se** houver authorization code.
12. Processo de homologação Itaú e critério de go-live.
13. Confirmar se o sandbox do portal passou a exigir (ou continua sem) OAuth 2.0/mTLS — a doc pública diz que sandbox **não** segue OAuth 2.0.

Enquanto isso não vier por canal oficial Itaú, qualquer “conexão” no CDS permanece **preparação interna**.

---

## 7. Pendências técnicas (CDS, após o Itaú confirmar)

Não implementar agora. Só depois do item 1 da seção 6.

1. Escolher **um** produto e um código de provider. Hoje `OPEN_FINANCE_REAL` mistura adapter OF genérico + OAuth Mercado Pago; `ITAU` é portal. Renomear Mercado Pago **não** faz parte desta sprint (risco de regressão OAuth).
2. Preencher `MBC-13-CHECKLIST-PROVIDER.md` só com dados oficiais (segredos = CONFIGURADO / NÃO CONFIGURADO).
3. Mapear payload oficial → `SaldoBancarioNormalizado` / `TransacaoBancariaNormalizada` **sem** inventar campos.
4. Se a modalidade for Open Finance Brasil: ligar `ItauBankProvider` **ou** o adapter OF ao fluxo de consentimento oficial (hoje Itaú **não** usa consentimento). Não forçar Client Credentials a fingir consentimento de titular.
5. Configurar `ITAU_PATH_SALDO` / `ITAU_PATH_EXTRATO` **somente** com paths confirmados.
6. Cofre de produção (Vault/HSM/Secret Manager). `EncryptedLocalSecretStore` não é cofre de produção (`secretStoreProducaoDisponivel() === false`).
7. Operação assistida com evidência real + rollback operacional.
8. Homologação: `conexao/testar` → saldo-real → sync → conciliação manual de uma amostra.
9. `listarContas` Itaú (501) só se o produto oficial tiver esse recurso.

---

## 8. Defeitos comprovados e correções efetuadas

**Nenhum defeito funcional comprovado no escopo OF-01 exigiu alteração de código.**

Observações (não corrigidas de propósito):

| Observação | Por que não foi “consertado” agora |
|------------|-------------------------------------|
| `OPEN_FINANCE_REAL` também carrega OAuth Mercado Pago | Arquitetura pré-existente; reescrever o motor/provider viola a regra de não reescrever sem necessidade comprovada e arrisca MBC-14/15/16. |
| `version.js` ainda declara `SPRINT: 'MBC-05.4'` | Fora do escopo; não afeta o diagnóstico. Trabalho fiscal não commitado permanece intocado. |
| Sandbox Itaú no código usa URL JWT OAuth | Pode divergir da doc “sandbox sem OAuth 2.0”. **PENDENTE DE CONFIRMAÇÃO**, não invenção de fluxo novo. |
| Validade de consentimento 90 dias | Default interno MOCK/núcleo, não regra Itaú. |
| Rate limit `null` | Recusar inventar limite. |
| Paths saldo/extrato ausentes | Recusa explícita `ENDPOINT_NAO_CONFIGURADO` — comportamento correto. |

Não foi ativado provider real. Não foi enfraquecido teste. Não foi alterada conciliação. Não foram tocados os arquivos não commitados de outros sprints (fiscal, faturamento, vendas, PDV).

---

## 9. Evidências de segurança desta execução

- Sem certificado de produção.
- Sem transmissão SEFAZ.
- Sem operação bancária real.
- `rejectUnauthorized: true` permanece no client Itaú.
- Feature flags OF real **não** ligadas.
- Testes Itaú injetam `fetchImpl` mock (`https://mock.itau.test/...` no ITAU-02). URL de token sandbox no teste é **comparada** pelo mock, não chamada à rede Itaú.

**Confirmação: não houve conexão bancária real.**

---

## 10. Critérios objetivos para liberar a próxima sprint

A próxima sprint de **implementação** só deve começar se **todos** os critérios abaixo forem verdadeiros. Caso contrário, permanece auditoria/onboarding comercial, não código.

1. **Modalidade escrita pelo Itaú** (portal vs Open Finance Brasil vs parceria), com nome do produto e ambiente (sandbox/hml/prod).
2. **Acesso oficial**: Client ID de aplicação Itaú (ou credencial OF do Diretório) disponível fora do Git.
3. Se portal: produto de saldo/extrato **contratado/habilitado** e paths/URLs oficiais copiados do catálogo Itaú (não de memória).
4. Se Open Finance Brasil: comprovação de participação (autorização BC **ou** parceria) + Authorization Server + permissions.
5. Certificado exigido pelo produto escolhido emitido e validado **em homologação**, não em produção às cegas.
6. Um teste de conexão **real** (`POST /api/bancario/configuracoes/:id/conexao/testar`) com resultado autenticado registrado, ainda em sandbox/hml.
7. Núcleo MBC continua verde em SQLite isolado (regressão `tests/bancario`).
8. Checklist MBC-13 ainda **bloqueia produção** até operação assistida com saldo e pelo menos uma página de extrato reais, idempotentes, na conta certa da empresa certa.

Critério negativo: **mock verde ≠ integração Itaú concluída.**

---

## 11. Preservação do trabalho alheio

Esta sprint:

- não executou commit, push, merge nem Git destrutivo;
- não reescreveu o Motor Bancário;
- não introduziu provedor externo;
- não acessou o SQLite oficial;
- criou apenas este relatório em `docs/bancario/OF-01-AUDITORIA-ITAÚ.md`.

Alterações locais pré-existentes (fiscal, faturamento, vendas, PDV, testes de cancelamento NFC-e) **não foram modificadas**.

---

## 12. Critério de conclusão da OF-01

Atendido: diagnóstico reproduzível da prontidão do Motor Bancário próprio para Itaú/Open Finance.

**Não atendido (e não declarado):** integração Itaú em produção, Open Finance real, consentimento válido junto ao banco, conexão autorizada, testes de homologação Itaú.

Classificação vigente, alinhada à MBC-13 e reconfirmada em 17/10/2026:

**PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO.**  
**PRODUÇÃO BLOQUEADA.**  
**NO-GO.**
