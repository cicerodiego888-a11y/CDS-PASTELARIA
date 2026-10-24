# Microsprint P0.6 — Correção dos asserts legados RC3 e RC4

**Prioridade:** P0 — regressão de testes / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** alinhar testes ao contrato vigente (aliases RC3.7.1 + fail-closed de identidade)  
**Pré-requisitos:** P0.3, P0.4, P0.5

Esta microsprint **não** alterou a máquina de estados, **não** relaxou o fail-closed MULTIEMPRESA, **não** abriu o banco oficial, **não** chamou SEFAZ e **não** iniciou recuperação de NF-e. Sem commit, push ou merge.

---

## 1. RC3 — máquina de estados

### Causa da falha

O teste legado esperava:

```text
podeTransicionar(EM_PROCESSAMENTO, REVISADA) === false
```

Após RC3.7.1 esses nomes **não são estados persistidos distintos**:

| Alias legado | Valor canônico |
|---|---|
| `EM_PROCESSAMENTO` | `XML_COMPLETO` |
| `REVISADA` / `PRONTA_PARA_COMPRA` | `PRONTA_IMPORTACAO` |

`TRANSICOES_PERMITIDAS[XML_COMPLETO]` inclui `PRONTA_IMPORTACAO`. Portanto `EM_PROCESSAMENTO → REVISADA` é o mesmo salto que o fluxo feliz do próprio RC3 já exigia (`EM_PROCESSAMENTO → PRONTA_PARA_COMPRA`). Os dois asserts se contradiziam.

Não é regressão da implementação: a máquina vigente permite o atalho `XML_COMPLETO → PRONTA_IMPORTACAO` (sem passar por `EM_REVISAO` quando não há pendência MIIP). O caminho canônico `XML_COMPLETO → EM_REVISAO → PRONTA_IMPORTACAO` continua válido.

### Correção

Somente o teste. `MaquinaEstadosDocumento.js` **não** foi alterado.

1. Assert de aliases: `EM_PROCESSAMENTO → REVISADA` é permitida **porque** é `XML_COMPLETO → PRONTA_IMPORTACAO`.
2. O “não vai direto” foi reposicionado no ponto que ainda é bloqueado: `RESUMO_RECEBIDO` / `AGUARDANDO_XML_COMPLETO` **não** vai para `REVISADA` / `PRONTA_PARA_COMPRA` (XML incompleto não entra em revisão/importação).

Nenhuma validação de estado foi afrouxada.

---

## 2. RC4 — identidade fiscal

### Causa da falha

`sincronizar()` chama `listarAlvosSincronizacaoCentral` **antes** de `obterContextoOperacional` (certificado).

No Temp vazio o modo resolvido é `EMPRESA_SIMPLES` sem `empresa_operacional` → lança `EMPRESA_OPERACIONAL_AUSENTE`. O teste legado injetava só `{ cnpj }` em `getFiscalConfig` e esperava `CERTIFICADO`, sem empresa válida.

Ordem vigente (fail-closed):

1. Contrato / alvos de sincronização (empresa operacional ou lista MULTIEMPRESA).
2. `obterContextoOperacional({ empresaId, permitirFallbackGlobal })`.
3. Certificado / CNPJ / arquivo PFX / URL.

Empresa ausente **não** chega ao certificado. MULTIEMPRESA **não** usa `getFiscalConfig` global (`permitirFallbackGlobal: false`).

### Correção

Somente fixtures do teste. Serviços fiscais **não** foram alterados. Fallback global MULTIEMPRESA **não** foi reintroduzido.

| Caso | Fixture | Código esperado |
|---|---|---|
| Identidade ausente | `EMPRESA_SIMPLES` + `empresa_operacional: null` + lista vazia; `getFiscalConfig` até com PFX fake | `EMPRESA_OPERACIONAL_AUSENTE` |
| MULTIEMPRESA sem empresas | contrato MULTIEMPRESA + `listarEmpresas: []`; mesmo PFX fake no global | `EMPRESA_CENTRAL_AUSENTE` |
| Avaliar certificado | MULTIEMPRESA + uma empresa ativa `{ id: 1, cnpj }`; `getFiscalConfig` só com CNPJ (sem PFX) | `CERTIFICADO` |

O caso de certificado só corre **depois** de existir empresa válida. O PFX fake nos casos de identidade ausente prova que o certificado global **não** é consultado.

`process.exit(0)` no sucesso: o `atualizar()` da suíte liga o motor de recuperação XML (timer), que prendia o event loop quando todos os asserts passavam. Não altera regra fiscal.

---

## 3. Arquivos alterados

| Arquivo | Ação |
|---|---|
| `tests/central-entradas/rc3-integridade.test.js` | asserts da máquina alinhados ao RC3.7.1; isolamento comprovado no fim |
| `tests/central-entradas/rc4-configuracao.test.js` | fixtures de identidade + certificado; dois casos fail-closed novos |

Produção (`MaquinaEstadosDocumento`, `CentralSincronizacaoService`, `CentralConfiguracaoService`, `database.js`) **não** modificada nesta sprint.

---

## 4. Testes e isolamento

Todos via npm com `-r preloadIsolamentoBanco.js`. Nenhum stdout contém `C:\ProgramData\MercantilFiscal\dados`. MIB das suítes que abrem `database.js`: **0** produtos (Temp vazio).

| Comando | Resultado | Banco comprovado |
|---|---|---|
| `npm run test:central-entradas-rc3` | **12 ok, 0 falha** | `...\Temp\cds-preload-52Shgi\mercadao.db` |
| `npm run test:central-entradas-rc4` | **16 ok, 0 falhou** | `...\Temp\cds-preload-htGaxP\mercadao.db` |
| `npm run test:central-entradas` | **exit 0** | Temp `cds-preload-*` por processo (`1tXlbc`, `aSMAeP`, `qLNpsX`, `yXNkKf`, `17xLC2`, `VVfzxi`, `qF63T3`, `4XolXa`) |
| `npm run test:central-entradas-identidade-chave` | **15 pass** | `...\Temp\cds-preload-ZP0IS4\mercadao.db` |
| `npm run test:central-entradas-prep-chave` | **17 pass** | `...\Temp\cds-preload-T5bwyU\mercadao.db` |
| `npm run test:central-entradas-cursor-656` | **15 pass** | `...\Temp\cds-preload-wSVAIP\mercadao.db` |

Nenhum teste desabilitado. Homologação e2e, seed e `banco-init-01` **não** executados.

---

## 5. Confirmações

| Item | Estado |
|---|---|
| Banco oficial | não aberto |
| Migrations em ProgramData | não |
| SOAP / DistDFe / consChNFe / 210210 reais | não |
| PFX de produção | não |
| NSU / cooldown / estoque / compras / financeiro de produção | não alterados |
| Fail-closed MULTIEMPRESA | preservado |
| Máquina de estados de produção | inalterada |
| Git commit / push / merge | não |

---

## Critérios de aceite

| Critério | Estado |
|---|---|
| RC3 e RC4 passam sem desabilitar asserts | Atendido |
| Fail-closed de identidade preservado | Atendido |
| Sem relaxar transições da máquina | Atendido |
| Sem acessar o banco oficial | Atendido |
| Identidade / P0.2 / cursor 656 / `test:central-entradas` verdes | Atendido |
