# Microsprint P0.10 — Contenção do incidente SQLite e auditoria de transmissões fiscais

**Prioridade:** P0 — Central de Entradas  
**Data:** 18/10/2026  
**Tipo:** contenção do incidente de banco + barreira de cancelamento NFC-e + ciência + motor XML legado  
**Pré-requisitos:** P0.8, P0.9

Nesta etapa **não** houve SOAP real, DistDFe, `consChNFe`, 210210, cancelamento 110111 real, PFX de produção, commit, push, merge, restore, cópia de volta nem nova abertura do banco oficial. Homologação real **não** foi liberada.

**Impacto do incidente P0.9 (e do 05.72): IMPACTO INDETERMINADO.**

---

## 1. Incidente SQLite — comando, cadeia e evidências

### 1.1 Comando causador (P0.9)

```text
node tests/fiscal/fiscal-manifestacao-runtime.test.js
```

Executado **sem** `-r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js`. Naquele momento o arquivo também **não** chamava `isolarBancoTeste()` antes dos requires. O `package.json` ainda apontava o mesmo `node` sem preload.

Fonte do comando: transcrição da P0.9 (`compaction/segment_011.md`) e o próprio cabeçalho do teste, que documentava `node tests/fiscal/fiscal-manifestacao-runtime.test.js`.

### 1.2 Cadeia de imports que abriu `database.js`

```
tests/fiscal/fiscal-manifestacao-runtime.test.js
  └─ backend/services/fiscal/core  (FiscalWebServices / SoapTransport)
       └─ SoapTransport.send
            └─ fiscalSoapTelemetry.isLogDetalhadoAtivo()
                 └─ FiscalSoapTelemetryConfig.getFiscalConfigSyncFlags()
                      └─ warmFiscalTelemetryFlagsFromDb()
                           └─ require('../../../database')   ← boot do ERP
```

O transporte da suíte era `httpClient` mockado (HTTP 200 local). A telemetria SOAP, para ler `log_detalhado` / `modo_debug` no KV, fazia `require` **eager** de `database.js`. Sem `DB_DIR`, o fallback foi `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.

Cadeia paralela já documentada na P0.4 (incidente 05.72): `DfeAuditoriaService.js` linha 10, `require('../../database')` no topo. **Não** foi a cadeia desta execução.

### 1.3 Evidências disponíveis (sem nova abertura)

Stdout capturado na P0.9 (relatório `microsprint-p0-9-cobertura-soap-legado-regressao-relatorio.md` §5):

```text
BANCO OFICIAL EM USO:
C:\ProgramData\MercantilFiscal\dados\mercadao.db
[MIB] iniciado 712 produtos em memória
```

O mesmo relatório registra migrações visíveis no log: `05.40 TOTAL: 20`, `NÃO_CLASSIFICADAS: 2`, `05.38.D empresaId=2`. O transporte era mockado — **não** há evidência de SOAP SEFAZ nem de PFX nessa execução.

**Comprovado**

- O processo abriu o arquivo oficial (caminho impresso + MIB 712 ≠ banco vazio).
- `inicializarBanco()` rodou o suficiente para imprimir MIB e totais de migração.
- Não houve SOAP DistDFe / `consChNFe` / 210210 / 110111 reais nessa suíte (httpClient mockado).

**Não comprovado (hipótese até leitura autorizada)**

- Quantas linhas cada `UPDATE` de migração alterou (`changes` não está no log).
- Se `migrarRecalcularSaldosEstoque` recalculou ou saiu cedo por flag já `'1'`.
- Se `CREATE INDEX` / `ADD COLUMN` criaram objetos novos ou só tentaram o que já existia.
- Estado de NSU, cooldown, estoque, compras ou financeiro **depois** versus **antes**.
- Diff WAL (`mercadao.db-wal` / `-shm`).

**IMPACTO INDETERMINADO.** Não se declara o banco intacto.

### 1.4 Análise futura (não executada)

Somente leitura, autorizada por escrito, **sem** `backend/database.js`, **sem** preload/`isolarBancoTeste` (o guardião recusa o oficial inclusive em `OPEN_READONLY`). Procedimento: P0.5 §6 — copiar o trio SQLite/WAL/SHM para Temp, abrir a **cópia** com `OPEN_READONLY` + `PRAGMA query_only=ON`. Esta microsprint **não** executou esse procedimento.

---

## 2. Contenção aplicada nesta sprint

| Correção | Efeito |
|---|---|
| `FiscalSoapTelemetryConfig.warmFiscalTelemetryFlagsFromDb` | Não faz `require` de `database.js` se o módulo ainda não está em `require.cache`. Com `CDS_FORCAR_LOCAL=1` (testes) nunca aquece pelo banco. |
| `isolarBancoTeste` + preload em `test:fiscal-cancelamento-runtime` e `test:fiscal-manifestacao-runtime` | Suítes fiscais de runtime não repetem o vetor `node arquivo.test.js` sem isolamento. |
| Motor XML `lerConfigDeMapa` | KV `recuperacao_xml_ativa=true` marca `valorLegadoPersistido`; `ativa` efetiva = `false`. `iniciar()` não agenda ciclo. |

O `database.js` de produção **não** foi modificado. Nenhuma migration foi disparada contra o oficial nesta sprint.

---

## 3. Mapa dos pontos de transmissão fiscal

| Origem | Ponto efetivo | Evento / SOAP | Barreira |
|---|---|---|---|
| `POST /api/fiscal/notas/:id/cancelar` | `cancelarNfce` → `enviarCancelamento` → `SoapTransport.send` ou `enviarCancelamentoLegado` | 110111 | P0.10 no runtime e no legado **antes** de HTTP/PFX. DistDFe **não** cobre. |
| `PUT/POST /api/vendas/.../cancelar` | `VendaCancelamentoService` → `cancelarNfceAutorizadaVenda` → mesmo runtime | 110111 | Idem. Sem autorização de teste = `NOT_SENT`. |
| `cancelarNfe.js` / devolução NF-e | `enviarCancelamento` | 110111 | Mesmo limite SOAP. `empresaId` ausente = fail-closed. |
| DistDFe / sync / abrir Central | `executarEnvioConsultaDfe` | distNSU / consChNFe | P0.8 |
| Manifestação 210210 (e 210200/210220/210240) | `enviarManifestacao` / `enviarManifestacaoLegado` | RecepcaoEvento | P0.9 |
| `CentralManifestacaoScheduler` | `_enviarCiencia` → runtime | 210210 | Não injeta auth; SOAP bloqueado. Política MANUAL/AUTOMATICA **inalterada**. |
| Motor XML (KV legado `true`) | `iniciar()` / ciclo | consChNFe | **Não inicia.** SOAP permanece fail-closed se alguém forçar ciclo. |
| Autorização NFC-e de venda / status serviço | `SoapTransport` de outra operação | Autorização / Status | **Fora** desta barreira (operação distinta). |

Não foi criado endpoint de execução real. Autorização de produção **não existe**.

Efeito operacional desta etapa: cancelamento NFC-e real pela SEFAZ também fica bloqueado até existir autorização explícita futura — o mesmo freeze já aplicado a DistDFe/`consChNFe`/210210.

---

## 4. Ciência — fases do registro

| Fase | Evento | Quando |
|---|---|---|
| Intenção | `CIENCIA_SOLICITADA` | Antes do envelope/SOAP. Não prova envio. |
| Falha pré-envio | `MANIFESTACAO_REJEITADA` / `FALHA_PRE_ENVIO` | Envelope ou autorização. **Sem** `CIENCIA_ENVIADA`. |
| Envio iniciado / resposta | `CIENCIA_ENVIADA` | Só depois do runtime retornar sem bloqueio de autorização, ou throw de transporte. |
| Sucesso fiscal | `MANIFESTACAO_ACEITA` | cStat 135/573 (inalterado). |

Histórico de produção **não** foi reescrito. Eventos antigos `CIENCIA_ENVIADA` permanecem como estavam.

---

## 5. Arquivos alterados

| Arquivo | Papel |
|---|---|
| `backend/services/fiscal/core/FiscalSoapTelemetryConfig.js` | Contenção: não bootar `database.js` só para flags. |
| `backend/services/fiscal/autorizacaoTransmissaoSefaz.js` | Tipo `110111`; `anexarAutorizacaoTesteCancelamento`. |
| `backend/services/fiscal/cancelamentoRuntime.js` | Barreira antes de `transport.send`. |
| `backend/services/fiscal/cancelamentoLegado.js` | Barreira antes de httpClient/axios/PFX. |
| `backend/services/fiscal/cancelarNfce.js` | Propaga `empresaId` + autorização; bloqueio ≠ envio. |
| `backend/motores/central-entradas/config/centralEventosTipos.js` | `CIENCIA_SOLICITADA`. |
| `backend/motores/central-entradas/services/CentralManifestacaoDfeService.js` | Ciência só após SOAP iniciado. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlConfig.js` | KV `true` não liga o motor. |
| `backend/motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService.js` | `iniciar()` recusa legado. |
| Testes P0.8/P0.9/RC3.7.5, `fiscal-cancelamento-runtime`, helper de autorização, `package.json` | Isolamento + asserts alinhados. |
| `tests/central-entradas/microsprint-p0-10-incidente-sqlite-cancelamento-ciencia.test.js` | **Novo.** 14 casos. |

---

## 6. Testes e isolamento

Todos os comandos abaixo usaram `-r preloadIsolamentoBanco.js` (e/ou `isolarBancoTeste` no arquivo). Nenhum stdout aponta `C:\ProgramData\MercantilFiscal\dados`. O rótulo `BANCO OFICIAL EM USO` continua sendo o `DB_DIR` (Temp). MIB, quando `database.js` carregou: **0**.

| Comando | Resultado | Banco |
|---|---|---|
| P0.10 | **14 pass** | Temp `cds-preload-8I3kGt`, comprovado |
| cancelamento runtime | **18 ok** | preload; telemetria não bootou o oficial |
| manifestação runtime | **14 ok** | preload (httpClient mockado) |
| P0.8 | **13 pass** | Temp `cds-preload-RwODci`, MIB 0 |
| P0.9 | **15 pass** | Temp `cds-preload-iHpELu`, MIB 0 |
| RC3.7.5 motor XML | **8 ok** | Temp `cds-preload-YeIpaq` |
| 03-xml | **17 ok** | preload + stub `:memory:` |
| 05-seguranca | **28 ok** | Temp `cds-preload-QDiJIb` |

Nenhum assert desabilitado.

Não executados (isolamento de SOAP/PFX ou banco oficial não exigido / risco): `cancelamento-nfce-isolamento.test.js` (gera certificado de teste com node-forge; não era necessário para a barreira), leitura do oficial, DistDFe real.

---

## 7. Riscos remanescentes

1. **IMPACTO INDETERMINADO** do incidente P0.9 e do 05.72 no banco oficial — exige a leitura autorizada P0.5 §6.
2. Cancelamento NFC-e / NF-e / devolução **reais** ficam bloqueados sem autorização de teste (freeze intencional). Loja em produção não cancela na SEFAZ até existir autorização operacional futura.
3. Autorização NFC-e de venda e status serviço **não** entram nesta barreira.
4. `CIENCIA_SOLICITADA` é evento novo; telas que filtram só `CIENCIA_ENVIADA` continuam corretas, mas homologação assistida pode ver o tipo extra.
5. `executarCiclo({ forcar: true })` ainda existe para testes/rota explícita; SOAP real permanece barrado.
6. `node arquivo.test.js` **sem** `-r` em suítes fiscais que importam `DfeAuditoriaService` ainda pode abrir banco se `DB_DIR` não estiver definido — o preload npm e o skip da telemetria reduzem, não eliminam, esse vetor.

---

## 8. Confirmações

| Item | Estado |
|---|---|
| Nova abertura do banco oficial nesta sprint | **não** |
| Restore / overwrite / cópia de volta | **não** |
| SOAP DistDFe / consChNFe / 210210 / 110111 reais | **não** |
| PFX de produção | **não** |
| NSU / cooldown / estoque / compras / financeiro de produção | **não** alterados de propósito |
| Migrations contra o oficial | **não** |
| Git commit / push / merge | **não** |
| Homologação / recuperação de NF-e | **não** liberadas |
| Impacto do incidente | **IMPACTO INDETERMINADO** |

**Critério de aceite:** nenhuma transmissão real executada; cancelamento e manifestação têm barreiras verificadas nos testes isolados; o incidente está documentado sem alegar integridade do oficial.

Transmissão real permanece bloqueada por padrão.
