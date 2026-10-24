# Microsprint P0.9 — Cobertura SOAP 210210, configuração legada e regressão

**Prioridade:** P0 — Central de Entradas  
**Data:** 18/10/2026  
**Tipo:** barreira SOAP na manifestação 210210 + tratamento de KV legado + regressão das suítes antigas  
**Pré-requisitos:** P0.8

Nesta etapa **não** houve SOAP real DistDFe/`consChNFe`/210210, PFX de produção, alteração de NSU/cooldown/estoque/compras/financeiro de produção, commit, push, merge nem endpoint de transmissão real. Homologação real **não** foi liberada.

**Decisão final: PRONTO PARA NOVA AUDITORIA.**

---

## 1. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` | Tipos 210210/210200/210220/210240; `anexarAutorizacaoTesteManifestacao`; DistDFe não cobre manifestação. |
| `backend/services/fiscal/manifestacaoRuntime.js` | `exigirAutorizacaoTransmissao` antes de `transport.send` e do fallback legado. |
| `backend/services/fiscal/manifestacaoLegado.js` | Mesma barreira antes de `httpClient`/axios/PFX. |
| `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js` | Propaga `empresaId` + autorização ao runtime; bloqueio de autorização ≠ rejeição SEFAZ. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig.js` | KV `true` marca `valorLegadoPersistido`; `autorizaTransmissaoSefaz` sempre `false`. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | Legado `true` não autoriza SOAP; bloqueio por autorização ≠ consulta executada. |
| `tests/central-entradas/helpers/autorizacaoTesteSefaz.js` | Reexporta autorização de manifestação. |
| `tests/central-entradas/microsprint-p0-9-cobertura-soap-legado-regressao.test.js` | **Novo.** 15 casos isolados. |
| `tests/central-entradas/central-entradas-03-xml.test.js` | Autorização explícita só no DistDFe/`consChNFe` mockado. |
| `tests/central-entradas/central-entradas-04-gate.test.js` | Idem. |
| `tests/central-entradas/central-entradas-05-seguranca.test.js` | Idem. |
| `tests/central-entradas/microsprint-auditoria-cooldown-distdfe.test.js` | Idem. |
| `tests/central-entradas/conciliacao-recuperacao-nfe-ausentes.test.js` | Idem. |
| `tests/central-entradas/nfe-nao-localizada-sync.test.js` | Idem. |
| `tests/fiscal/fiscal-manifestacao-runtime.test.js` | Autorização de teste + preload de isolamento. |
| `package.json` | Scripts `test:central-entradas-p0-9` e preload no runtime de manifestação. |

03-periodo não exercita transporte SOAP; não recebeu autorização.

---

## 2. Mapa dos pontos de transmissão 210210

| Origem | Caminho | SOAP | Barreira P0.9 |
|---|---|---|---|
| `CentralManifestacaoDfeService._enviarCiencia` | `enviarManifestacao` (runtime) | `NFeRecepcaoEvento4` / 210210 | Autorização no runtime **antes** de `transport.send`. Produção: `TRANSMISSAO_SEFAZ_NAO_AUTORIZADA`. |
| Fallback da plataforma | `enviarManifestacaoLegado` | axios / `httpClient` | Mesma exigência; sem auth não carrega PFX. |
| `POST /api/central-entradas/.../processar` | Orchestrator → `_enviarCiencia` | 210210 | Cai na barreira do runtime. Sem auth = não executada. |
| `CentralManifestacaoScheduler` | `processarCandidatos` | 210210 | Scheduler **não** injeta autorização. SOAP bloqueado. Política MANUAL/AUTOMATICA inalterada. |
| `MotorRecuperacaoXmlService` | consChNFe + possível ciência | DistDFe/`consChNFe` (P0.8) + 210210 | KV legado não autoriza; ciclo real falha fechado. |
| Chamada direta a `enviarManifestacao` / `enviarManifestacaoLegado` | Plataforma Fiscal | 210210 e irmãos | Fail-closed. |
| Testes 03/04/05 | mock de `_enviarManifestacao` no serviço | **não** chegam ao SOAP | Sem autorização 210210 (transporte não exercitado). DistDFe mockado recebe auth explícita. |

Eventos 210200/210220/210240 usam o mesmo transporte e a mesma barreira, com tipo distinto. Autorização DistDFe (`distNSU`/`consChNFe`) **não** cobre 210210.

Não foi criado endpoint de execução real. Autorização de produção **não existe**.

---

## 3. Barreiras implementadas

1. **Limite SOAP 210210** — `enviarManifestacao` exige `TESTE_ISOLADO` + token `CDS_SEFAZ_AUTH_TESTE_ISOLADO_P08` + `empresaId` da operação + tipo `210210` (ou 210200/210220/210240). Sem isso o mock/transporte **não é chamado**.
2. **Legado** — `enviarManifestacaoLegado` recusa sem a mesma autorização, antes de HTTP e de `carregarCertificadoPfx`.
3. **Motor XML legado** — `recuperacao_xml_ativa=true` (KV persistido) **não** autoriza SOAP. `autorizaTransmissaoSefaz` é sempre `false`. O scheduler ainda pode acordar se o KV for `true` (`INSERT OR IGNORE` não reescreve loja), mas cada `consChNFe`/210210 real cai na barreira.
4. **Sem implícito** — `process.env`, KV, `modo: PRODUCAO` e autorização DistDFe não liberam 210210.
5. **Regressão** — suítes 03/04/05, cooldown, conciliação e `nfe-nao-localizada` anexam autorização **somente** quando exercitam DistDFe/`consChNFe` mockado. Expectativas de Gate/cooldown/656 permanecem.

---

## 4. Testes e isolamento

Todas as suítes obrigatórias usaram `-r preloadIsolamentoBanco.js` (ou `isolarBancoTeste` no próprio arquivo). Nenhum stdout dessas suítes aponta `C:\ProgramData\MercantilFiscal\dados`. O rótulo `BANCO OFICIAL EM USO` continua sendo o `DB_DIR` (pasta Temp). MIB, quando `database.js` carregou nessas suítes: **0** produtos.

| Comando | Resultado | Banco |
|---|---|---|
| P0.9 | **15 pass** | Temp `cds-preload-PgNRe7` |
| P0.8 | **13 pass** | Temp `cds-preload-GzxEzX` |
| 03-xml | **17 ok** | Temp (preload) |
| 03-periodo | **12 ok** | Temp |
| 04-gate | **21 ok** (T19 falhou 1× na 1ª execução; corrigido o Motor a tratar rejeição 632 como consulta executada) | Temp |
| 05-seguranca | **28 ok** | Temp |
| cooldown DistDFe | **12 pass** | Temp `cds-preload-6iVg26` |
| conciliação | **17 pass** | Temp `cds-preload-SenXDH` |
| `nfe-nao-localizada` | **9 pass** | Temp `cds-nfe-ausente-QLoBAk` |
| identidade-chave (P0.3) | **15 pass** | Temp `cds-preload-M4Qsid` |
| prep-chave (P0.2) | **17 pass** | Temp `cds-preload-yl28rA` |
| cursor 656 | **15 pass** | Temp `cds-preload-10rPyR` |
| recuperação após falha de persistência | **13 pass** | Temp `cds-recup-nfe-aGAcnc` |
| RC3 | **12 ok** | Temp `cds-preload-F16wrm` |
| RC4 | **16 ok** | Temp `cds-preload-wXfgUG` |
| RC3.7.5 motor XML | **8 ok** | Temp `cds-preload-m8Gb4t` |
| `npm run test:central-entradas` | **exit 0** (todas as fatias `0 falhou`) | Temp `cds-preload-*` |
| fiscal-manifestacao-runtime (reexecução isolada) | **14 ok** | Temp `cds-preload-vQjSje`, MIB 0 |

Nenhum assert desabilitado.

---

## 5. Incidente de isolamento (fiscal-manifestacao-runtime)

A **primeira** execução de `tests/fiscal/fiscal-manifestacao-runtime.test.js` foi feita **sem** preload. O stdout mostrou:

```
BANCO OFICIAL EM USO:
C:\ProgramData\MercantilFiscal\dados\mercadao.db
[MIB] iniciado 712 produtos em memória
```

O transporte da suíte é `httpClient` mockado (HTTP 200 local, sem SOAP SEFAZ e sem PFX). Mesmo assim o `database.js` abriu o caminho oficial e rodou o boot/schema.

Correção imediata: `isolarBancoTeste` no arquivo + `node -r preloadIsolamentoBanco.js` no script npm. Reexecução: Temp `cds-preload-vQjSje`, MIB 0.

Impacto no oficial dessa abertura **não foi auditado nesta microsprint**. Não houve SOAP. Não se afirma ausência de escrita de schema.

---

## 6. Riscos remanescentes

1. Loja com `recuperacao_xml_ativa=true` já gravado: o scheduler **pode** acordar; cada transmissão real continua bloqueada. Desligar o KV permanece operacional (fora desta sprint).
2. `CentralManifestacaoScheduler` continua podendo iniciar com o backend; a política de manifestação não foi alterada. Sem autorização, 210210 não sai.
3. Evento `CIENCIA_ENVIADA` ainda é gravado **antes** da chamada ao runtime. Se a barreira recusar, o registro operacional fica órfão. Não foi movido para não alterar a regra de negócio da ciência.
4. Incidente do item 5 (abertura do banco oficial na primeira execução do runtime de manifestação).
5. Impacto histórico 05.72 no oficial continua indeterminado (P0.5).
6. Cancelamento NFC-e / autorização de venda / status serviço **não** entram nesta barreira (operações distintas).

---

## 7. Confirmações

| Item | Estado |
|---|---|
| SOAP DistDFe / `consChNFe` / 210210 reais | não (httpClient/transporte mockados) |
| PFX de produção | não carregado nas suítes isoladas |
| Banco oficial nas suítes obrigatórias | não aberto (Temp) |
| Primeira execução fiscal-manifestacao-runtime | **abriu o oficial** (incidente; reexecução isolada em Temp) |
| NSU / cooldown / estoque / compras / financeiro de produção | não alterados de propósito; incidente do item 5 não auditado |
| Fallback global MULTIEMPRESA | não reintroduzido |
| Endpoint de execução real | **não criado** |
| Git commit / push / merge | não |
| Homologação / recuperação de NF-e | **não** liberadas |

**Critério de aceite de código:** 210210 bloqueada no ponto de transmissão sem autorização; KV legado `true` não autoriza SOAP; suítes antigas não dependem de autorização implícita; suítes isoladas obrigatórias passaram.

Transmissão real permanece bloqueada por padrão. Homologação real **não** foi autorizada.
