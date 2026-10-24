# Microsprint P0.8 — Bloqueio central de transmissões SEFAZ sem autorização

**Prioridade:** P0 — Central de Entradas  
**Data:** 18/10/2026  
**Tipo:** barreira SOAP + motor XML desligado por padrão + persistência durável  
**Pré-requisitos:** P0–P0.7

Nesta etapa **não** houve SOAP real, PFX de produção, abertura do banco oficial, alteração de NSU/cooldown/estoque/compras/financeiro, commit, push ou merge. Recuperação de NF-e **não** foi executada.

**Estado final:** transmissão DistDFe/`consChNFe` continua bloqueada por padrão. Homologação real continua a exigir autorização e plano posteriores.

---

## 1. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` | **Novo.** Barreira: só `TESTE_ISOLADO` + token `CDS_SEFAZ_AUTH_TESTE_ISOLADO_P08`. Env/KV/`producao` não autorizam. |
| `backend/services/fiscal/SefazTransmissaoMutex.js` | **Novo.** Mutex de processo DistDFe + `consChNFe` (ALS reentrante no mesmo contexto). |
| `backend/services/fiscal/distribuicaoDFe.js` | `exigirAutorizacaoTransmissao` imediatamente antes do envio; mutex; `consultarNotaPorChave` não devolve recuperação concluída com persistência incompleta. |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | `GET`/`buscarPorChave` só leitura local. DistDFe recebe `empresaId` + autorização explícita (ausente em produção). |
| `backend/motores/central-entradas/services/CentralSyncExecucaoService.js` | `comLockDistDfe` usa o mutex compartilhado. |
| `backend/motores/central-entradas/services/CentralDiagnosticoService.js` | Probe DistDFe bloqueado sem autorização. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig.js` | Default `ativa: false`; ausente/inválido/ambíguo = desligado. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | `iniciar()` não sobe o scheduler sem flag explícita `true` (`forcar` não liga o motor). |
| `backend/motores/central-entradas/repositories/CentralConfiguracaoRepository.js` | Seed `recuperacao_xml_ativa=false`. |
| `backend/rotas/central-entradas.js` | Códigos de autorização no GET `/buscar-chave`. |
| Testes P0.2/P0.3/P0.8, cursor 656, recuperação segura, RC3.7.5 + `package.json` | Autorização de teste explícita nas suítes que exercitam SOAP mockado. |

---

## 2. Mapa dos pontos de transmissão

Caminhos que **chegavam** a DistDFe/`consChNFe` (auditoria P0.7 + P0.8):

| Origem | Serviço | SOAP | Barreira P0.8 |
|---|---|---|---|
| `GET /api/central-entradas/buscar-chave` | `buscarPorChave` | `consChNFe` | **Não chama SOAP.** Lookup `(chave, empresa_id)` local. `consultaExecutada: false`. |
| `POST /sincronizar` | `CentralSyncExecucaoService` → DistDFe | `distNSU` | Autorização no envio. Produção: `TRANSMISSAO_SEFAZ_NAO_AUTORIZADA`. |
| `POST /sincronizar-ao-abrir` | origem `ABRIR_CENTRAL` | `distNSU` | Idem. Abertura da Central não transmite. |
| `POST /diagnostico/acoes/sincronizar` | DistDFe | `distNSU` | Idem. |
| Diagnóstico `testarConexaoSefaz` | `enviarDistribuicaoDfe` direto | DistDFe | Autorização antes do probe. |
| `POST /recuperacao-xml/executar` + scheduler | `MotorRecuperacaoXmlService` | `consChNFe` | Motor default off; ciclo real cai na barreira de `consultarNotaPorChave`. |
| Chamada direta a `consultarNotaPorChave` / `sincronizarDistribuicaoDFe` | Plataforma Fiscal | DistDFe / `consChNFe` | Mesma barreira no `executarEnvioConsultaDfe`. |
| `GET /api/dfe/consultar-chave` | — | — | Continua HTTP 410. |

Não foi criado endpoint de execução real. Autorização de produção **não existe** nesta etapa.

---

## 3. Barreiras implementadas

1. **Limite SOAP** — `executarEnvioConsultaDfe` exige `autorizacaoTransmissaoSefaz` com `empresaId` da operação e tipo (`distNSU`/`consChNFe`). Sem isso o mock/transporte **não é chamado**.
2. **GET nunca transmite** — `buscarPorChave` não invoca `consultarNotaPorChave`. Identidade MULTIEMPRESA permanece (empresa, CNPJ, ambiente, certificado configurado) sem SOAP.
3. **Abertura da Central** — `sincronizar-ao-abrir` ainda pode disparar DistDFe no serviço, mas o envio recusa sem autorização explícita de teste.
4. **Motor XML** — default e seed `false`. `lerConfigDeMapa({})` → `ativa: false`. `iniciar({ forcar: true })` **não** liga. Scheduler não contorna a barreira (ciclo com `consultarNotaPorChave` real falha fechado).
5. **Persistência** — estados: `NAO_EXECUTADA`, `SEM_DOCUMENTO`, `RESPOSTA_RECEBIDA`, `PERSISTENCIA_PENDENTE`, `RECUPERACAO_CONCLUIDA`, `JA_EXISTE_LOCALMENTE`. `sucesso` de recuperação só com persistência completa; SQLITE_BUSY → `PERSISTENCIA_DFE_INCOMPLETA`. Idempotência `(chave, empresa_id)` preservada. Sem crédito de estoque nesta correção.
6. **Concorrência** — DistDFe e `consChNFe` compartilham `SefazTransmissaoMutex`. Bloqueio por mutex = `consultaExecutada: false`. Gate, cooldown, 656 e NSU não foram rebobinados.

Autorização de teste: objeto em memória, token `CDS_SEFAZ_AUTH_TESTE_ISOLADO_P08`, `producao: false`. `process.env`, KV `recuperacao_xml_ativa` e `modo: PRODUCAO` **não** autorizam.

---

## 4. Testes e isolamento

Todas as suítes abaixo usaram `-r preloadIsolamentoBanco.js`. Nenhum stdout aponta `C:\ProgramData\MercantilFiscal\dados`. O rótulo `BANCO OFICIAL EM USO` continua sendo o `DB_DIR` (pasta Temp). MIB, quando `database.js` carregou: **0** produtos.

| Comando | Resultado | Banco |
|---|---|---|
| P0.8 `microsprint-p0-8-bloqueio-transmissoes-sefaz.test.js` | **13 pass** | Temp `cds-preload-5pTNlD` |
| identidade-chave (P0.3) | **15 pass** | Temp `cds-preload-U9TBN7` |
| prep-chave (P0.2) | **17 pass** | Temp `cds-preload-ASGnwN` |
| cursor 656 | **15 pass** | Temp (preload) |
| recuperação após falha de persistência | **13 pass** | Temp `cds-recup-nfe-1jcDcv` |
| `npm run test:central-entradas` | **exit 0** (todas as fatias `0 falhou`) | Temp `cds-preload-*` |
| RC3 | **12 ok** | Temp `cds-preload-joVane` |
| RC4 | **16 ok** | Temp `cds-preload-OI294e` |

Nenhum assert desabilitado. SOAP real, PFX e banco oficial não usados.

---

## 5. Riscos remanescentes

1. Loja com `recuperacao_xml_ativa=true` já gravado: `INSERT OR IGNORE` não reescreve. O scheduler **pode** acordar, mas cada `consChNFe` real cai na barreira. Desligar o KV continua operacional (fora desta sprint).
2. Manifestação **210210** usa outro transporte SOAP; não entrou nesta barreira DistDFe/`consChNFe`.
3. Suítes antigas 03/04/05, cooldown DistDFe, conciliação e `nfe-nao-localizada` ainda chamam DistDFe mockado **sem** autorização de teste. Se forem executadas, falham fechadas (esperado) até receberem `anexarAutorizacaoTesteSefaz`.
4. Não há fluxo operacional de produção para DistDFe/`consChNFe` até existir autorização explícita futura (intencional).
5. Impacto histórico 05.72 no oficial continua indeterminado (P0.5).

---

## 6. Confirmações

| Item | Estado |
|---|---|
| SOAP DistDFe / `consChNFe` / 210210 reais | não |
| PFX de produção | não |
| Banco oficial `C:\ProgramData\MercantilFiscal\dados` | não aberto |
| NSU / cooldown / estoque / compras / financeiro de produção | não alterados |
| Fallback global MULTIEMPRESA | não reintroduzido |
| Endpoint de execução real | **não criado** |
| Git commit / push / merge | não |
| Recuperação de NF-e | não executada |

**Critério de aceite:** nenhum caminho não autorizado alcança SOAP DistDFe/`consChNFe`; persistência incompleta não é recuperação concluída; suítes obrigatórias passaram.

Transmissão real permanece bloqueada por padrão.
