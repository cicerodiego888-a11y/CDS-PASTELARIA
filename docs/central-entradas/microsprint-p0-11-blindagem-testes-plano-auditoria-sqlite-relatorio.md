# Microsprint P0.11 — Blindagem global de testes e preparação da auditoria SQLite

**Prioridade:** P0 — Central de Entradas  
**Data:** 18/10/2026  
**Tipo:** isolamento de execução de testes + procedimento (não executado) de leitura autorizada  
**Pré-requisitos:** P0.8, P0.9, P0.10

Nesta etapa **não** houve SOAP real, DistDFe, `consChNFe`, 210210, 110111, PFX de produção, commit, push, merge, restore, cópia do banco oficial, abertura do original nem WAL/SHM. Homologação real **não** foi liberada.

**Impacto do incidente P0.9 (e do 05.72): IMPACTO INDETERMINADO.**

---

## 1. Inventário e cobertura de isolamento

Escopo classificado por leitura estática de fonte (não executa testes, não carrega `database.js`): `tests/central-entradas` + `tests/fiscal`.

| Classe | Qtde | Significado |
|---|---|---|
| ISOLADA COMPROVADA | 78 | `isolarBancoTeste()` é a primeira ação executável antes do require de risco |
| SEM ACESSO AO BANCO | 47 | Sem require de `database.js`, DistDFe, sqlite3, core SOAP, repositórios ou persistência |
| MEMORIA_OU_TEMP | 0 | Neste escopo, ninguém depende só de `:memory:`/tmpdir sem o helper |
| BLOQUEADA ATÉ ISOLAMENTO | 0 | Nenhum arquivo do escopo permanece com require de risco sem isolamento prévio |
| NÃO VERIFICADA | 0 | Nenhum padrão ambíguo no escopo |

Total do escopo: **125** arquivos `.test.js`.

Isto **não** é cobertura global do repositório. Existem ~490 outros `.test.js` fora de `tests/fiscal` e `tests/central-entradas`. Eles **não** foram classificados como protegidos e **não** foram executados nesta sprint.

### 1.1 Scripts protegidos (ISOLADA COMPROVADA) — fiscal

| Arquivo | Vetor coberto |
|---|---|
| `tests/fiscal/fiscal-dfe-runtime.test.js` | `distribuicaoDFe` → `DfeAuditoriaService` → `database.js` |
| `tests/fiscal/distdfe-blindagem-05-43.test.js` | idem DistDFe eager |
| `tests/fiscal/rc36e-dfe-observabilidade.test.js` | `DfeAuditoriaService` eager |
| `tests/fiscal/fiscal-manifestacao-runtime.test.js` | `fiscal/core` / telemetria SOAP (incidente P0.9) |
| `tests/fiscal/fiscal-cancelamento-runtime.test.js` | `fiscal/core` + cancelamento 110111 |
| `tests/fiscal/cancelamento-nfce-isolamento.test.js` | `sqlite3.verbose()` + `cancelarNfce` |
| `tests/fiscal/fiscal-platform.test.js` | `fiscal/core` |
| `tests/fiscal/soap-transport.test.js` | `SoapTransport` |
| `tests/fiscal/fiscal-status-runtime.test.js` | `fiscal/core` |
| `tests/fiscal/fiscal-consulta-runtime.test.js` | `fiscal/core` |
| `tests/fiscal/fiscal-autorizacao-runtime.test.js` | `fiscal/core` |
| `tests/fiscal/fiscal-telemetria-rc6.6.test.js` | `FiscalSoapTelemetry` / `SoapTransport` |
| `tests/fiscal/url-resolver.test.js` | `fiscal/core` |
| `tests/fiscal/webservice-registry.test.js` | `fiscal/core` |
| `tests/fiscal/configuracao-fiscal-empresa-real-05-18-3.test.js` | sqlite3 + `configService` / `emissor` |
| `tests/fiscal/isolamento-nfce-empresa-05-46.test.js` | sqlite3 + `cancelarNfce` / `emissor` |
| `tests/fiscal/validacao-operacional-multiempresa-05-18-4.test.js` | sqlite3 + `configService` / `emissor` |

Central: 61 suítes já isoladas (P0.4) + `isolamento-saude-empresa-05-75` e `isolamento-xml-devolucao-empresa-05-71` (sqlite3 sem helper; corrigidas nesta sprint).

### 1.2 Scripts sem dependência de SQLite (SEM ACESSO AO BANCO) — fiscal

`aposentadoria-plataforma-fiscal-05-80`, `danfe-itens-venda`, `fiscal-qrcode`, `hotfix-consumo-exclusivo-motor`, `hotfix-visao-comercial-pos-nfe`, `print-rc10-layout`, `rc71021-icmstot-modelo-totais`, `rc7104-estabilizacao-nfce`.

### 1.3 Scripts bloqueados / não executados

| Item | Motivo |
|---|---|
| `npm run test:banco-init-01` / `tests/database/banco-init-01.test.js` | Fora do escopo fiscal+Central; o pai usa `sqlite3` e o filho faz `require('./backend/database')`. **Não executado.** |
| `tests/fiscal/cancelamento-nfce-isolamento.test.js` | Isolado no arquivo; **não executado** (gera certificado `node-forge`; não estava na regressão obrigatória). |
| `configuracao-fiscal-empresa-real-05-18-3`, `isolamento-nfce-empresa-05-46`, `validacao-operacional-multiempresa-05-18-4` | Isolados; **não executados** nesta sprint. |
| `distdfe-blindagem-05-43`, `rc36e-dfe-observabilidade` | Isolados no arquivo; cadeia coberta pelo classificador e pela invocação direta de `fiscal-dfe-runtime`; suítes completas **não** reexecutadas. |
| Demais `tests/**` fora fiscal+Central | **NÃO VERIFICADOS.** Não executados. |

Nenhum script desprotegido do escopo foi executado.

### 1.4 Proteção npm **e** invocação direta

`package.json` passou a usar `-r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js` nos scripts fiscais de risco (`test:fiscal-platform`, `webservice-registry`, `url-resolver`, `soap-transport`, `fiscal-status-runtime`, `fiscal-dfe-runtime`, `fiscal-consulta-runtime`, `fiscal-autorizacao-runtime`, `fiscal-telemetria`, além dos já protegidos de manifestação/cancelamento e `test:dfe-observabilidade-rc3.6.e`).

Isso **não** basta: `node tests/fiscal/ARQUIVO.test.js` não herda o `-r`. Cada arquivo de risco agora chama `isolarBancoTeste()` como primeira linha executável.

Script novo: `test:central-entradas-p0-11`.

`database.js` de produção **não** foi alterado.

---

## 2. Cadeia de imports potencialmente perigosa

### 2.1 DistDFe / auditoria (eager `database.js`)

```
tests/fiscal/fiscal-dfe-runtime.test.js
  └─ backend/services/fiscal/distribuicaoDFe
       └─ backend/services/fiscal/DfeAuditoriaService.js  (require('../../database') no load)
            └─ backend/database.js
                 └─ new sqlite3.Database(DB_DIR || ProgramData\...\mercadao.db)
```

A mesma cadeia vale para `distdfe-blindagem-05-43.test.js` e `rc36e-dfe-observabilidade.test.js`.

### 2.2 Telemetria SOAP (incidente P0.9)

```
tests/fiscal/fiscal-manifestacao-runtime.test.js
  └─ backend/services/fiscal/core
       └─ SoapTransport.send
            └─ FiscalSoapTelemetryConfig.warmFiscalTelemetryFlagsFromDb
                 └─ require('../../../database')   ← P0.10: skip se CDS_FORCAR_LOCAL ou módulo ausente do cache
```

### 2.3 sqlite3 capturado antes do wrap

```
tests/fiscal/cancelamento-nfce-isolamento.test.js  (antes desta sprint)
  └─ sqlite3.verbose()     ← sem wrap
  └─ cancelarNfce / require.resolve(database)
  └─ TMP_DIR criado depois
```

Agora `isolarBancoTeste()` corre **antes** de `sqlite3.verbose()`.

### 2.4 Log enganoso

`database.js` sempre imprime `BANCO OFICIAL EM USO:` com o caminho de `DB_DIR`. Nas suítes desta sprint o caminho foi `C:\Users\cicer\AppData\Local\Temp\cds-preload-*\mercadao.db` (ou `cds-fiscal-*`). O rótulo **não** prova uso do ProgramData.

---

## 3. Testes executados e resultados

Isolamento comprovado por `-r preloadIsolamentoBanco.js` e/ou `isolarBancoTeste()` in-file. Saídas com `ISOLAMENTO DE TESTE ATIVO: ...\Temp\cds-*`.

| Suíte | Resultado | Isolamento |
|---|---|---|
| P0.11 `microsprint-p0-11-...test.js` | **10/10** | Temp `cds-preload-xF4GOx` (reexecução após correção de assert) |
| P0.4 guardião | **11/11** | Temp `cds-preload-yUjHJR` |
| P0.8 bloqueio transmissões | **13/13** | Temp `cds-preload-SsX7vh` |
| P0.9 cobertura SOAP/legado | **15/15** | Temp `cds-preload-0C0KeQ` |
| P0.10 incidente/cancelamento/ciência | **14/14** | Temp `cds-preload-IlPGee` |
| `fiscal-cancelamento-runtime` | **18 ok / 0 falha** | Temp `cds-preload-GTGml8` |
| `fiscal-manifestacao-runtime` | **14 ok / 0 falha** | Temp `cds-preload-hdfFfr` |
| `npm run test:central-entradas` | **10 arquivos, 82 ok / 0 falha** | Temp `cds-preload-*` (hiGeYq … h3TAip) |

`test:central-entradas`: maquina-estados 11, sprint2 8, sprint4 5, sprint5 7, sprint7 11, sprint8 8, sprint9 7, sprint10 7, rc1 9, rc2 9.

### 3.1 Invocação direta (sem `-r` do npm)

| Comando | Resultado |
|---|---|
| `node tests/fiscal/fiscal-dfe-runtime.test.js` | passou; `ISOLAMENTO DE TESTE ATIVO: ...\cds-fiscal-dfe-rt-*`; sem ProgramData |
| `node tests/fiscal/fiscal-manifestacao-runtime.test.js` | passou; `ISOLAMENTO DE TESTE ATIVO: ...\cds-fiscal-manif-rt-*`; sem ProgramData |

### 3.2 Sondas fail-closed (sem abrir o oficial)

| Sonda | Resultado |
|---|---|
| `sondaExigirIsolamentoSemDbDir.js` (sem `DB_DIR`) | exit ≠ 0; `MENSAGEM_RECUSA`; **não** chega a `DfeAuditoriaService` |
| `sondaRecusaSqliteOficial.js` | exit 0; `SONDA_RECUSOU_ANTES_DO_SQLITE`; `new sqlite3.Database(oficial)` recusado antes do ctor nativo |

Nenhuma sonda imprimiu `Conectado ao banco de dados SQLite` nem `[MIB] iniciado 712`.

Nenhum assert foi desabilitado.

---

## 4. Falhas e scripts bloqueados

A primeira execução da P0.11 falhou 1/10 por assert incorreto: `recusarSeOficial(caminhoOficialPadrao())` exigia que o caminho oficial **não** contivesse ProgramData. Corrigido para reconhecer o oficial e recusar só o `DB_DIR` da suíte. Reexecução **10/10**.

Scripts **bloqueados** (não improvisados contra o oficial):

- `test:banco-init-01`
- demais testes fora fiscal+Central
- suítes fiscais isoladas mas fora da regressão obrigatória (certificado forge / multiempresa operacional)

---

## 5. Procedimento futuro de leitura autorizada (não executado)

Somente após **autorização escrita**. Esta sprint **não** criou a cópia e **não** abriu o original.

O guardião de teste recusa o caminho oficial inclusive em `OPEN_READONLY`. Por isso a análise **não** pode usar `preloadIsolamentoBanco.js`, `isolarBancoTeste`, `backend/database.js`, migrations, seeds ou serviços da aplicação.

### 5.1 Arquivos necessários para cópia consistente

No diretório `C:\ProgramData\MercantilFiscal\dados\`, copiar o trio SQLite quando existir:

1. `mercadao.db`
2. `mercadao.db-wal` (se presente)
3. `mercadao.db-shm` (se presente)

Copiar os três **juntos**, para o mesmo instante, para uma pasta **temporária nova**. Não truncar WAL. Não executar `PRAGMA wal_checkpoint` no original. Não substituir o original pela cópia.

### 5.2 Identidade e integridade da cópia sem abrir o original

Ainda no original **fechado** (somente metadados de filesystem):

- tamanho em bytes de `.db`, `-wal`, `-shm`
- timestamps `mtime`/`ctime`
- hash (SHA-256) de cada arquivo copiado, calculado **sobre a cópia** depois da transferência, comparado com hash do original obtido por leitura binária de arquivo (não via SQLite)

Se o ERP estiver rodando, a cópia pode ficar inconsistente. Registrar se o processo da aplicação estava ativo. Em dúvida, não concluir.

### 5.3 Trabalhar somente na cópia temporária

Abrir **apenas** os arquivos da pasta Temp. Nunca `sqlite3 C:\ProgramData\...`. Nunca apontar `DB_DIR` para ProgramData.

### 5.4 Abertura somente leitura

Usar o driver `sqlite3` nativo (ou CLI `sqlite3.exe`), **sem** `backend/database.js`:

```text
filename = <temp>\mercadao.db
mode     = OPEN_READONLY
depois   = PRAGMA query_only=ON;
           PRAGMA journal_mode;     -- só consulta
```

Não `PRAGMA wal_checkpoint`. Não `INSERT`/`UPDATE`/`DELETE`/`CREATE`. Não `inicializarBanco()`.

### 5.5 Comparar só evidências disponíveis

Distinguir:

| Comprovado | Indeterminado |
|---|---|
| Logs já capturados (P0.9: caminho oficial, MIB 712, `05.40 TOTAL: 20`, `NÃO_CLASSIFICADAS: 2`) | `changes` de cada `UPDATE` de migração |
| O processo da P0.9 abriu o arquivo oficial | Estado **antes** do incidente |
| Transporte da suíte P0.9 era HTTP mockado (sem SOAP real) | Diff WAL vs. imagem pré-incidente (não existe baseline nesta sprint) |

Uma cópia isolada **não** permite concluir o estado histórico anterior sem evidência de comparação (backup, hash prévio, dump anterior). Ausência de baseline ⇒ impacto permanece indeterminado mesmo após a leitura.

### 5.6 O que esta sprint não faz

Não cria a cópia. Não abre o original. Não infere que o banco está intacto. Não usa a aplicação para “inspecionar”.

---

## 6. Riscos remanescentes

1. **IMPACTO INDETERMINADO** no banco oficial até a leitura autorizada da §5 com evidência de comparação.
2. Testes **fora** de `tests/fiscal` e `tests/central-entradas` continuam NÃO VERIFICADOS (não declarar cobertura global).
3. `database.js` continua imprimindo `BANCO OFICIAL EM USO` para qualquer `DB_DIR`; o rótulo não é evidência de ProgramData.
4. `test:fiscal-qrcode` e `test:danfe-itens-venda` não têm `-r` (SEM ACESSO AO BANCO). Se passarem a importar `core`/DistDFe, o classificador da P0.11 deve falhar até isolar.
5. Cancelamento/manifestação reais seguem barrados sem autorização de teste (P0.8–P0.10).
6. O wrap do sqlite3 recusa o oficial; por isso a auditoria futura **não** pode usar os helpers de teste contra o original.

---

## 7. Confirmações

| Item | Estado |
|---|---|
| Abertura do banco oficial nesta sprint | **não** |
| Abertura de WAL/SHM oficiais | **não** |
| Cópia do oficial | **não** criada |
| Restore / overwrite | **não** |
| SOAP DistDFe / consChNFe / 210210 / 110111 reais | **não** |
| PFX de produção | **não** |
| NSU / cooldown / estoque / compras / financeiro de produção | **não** alterados de propósito |
| Migrations / seeds contra o oficial | **não** |
| Alteração de `backend/database.js` | **não** |
| Git commit / push / merge | **não** |
| Homologação / recuperação de NF-e | **não** liberadas |
| Impacto do incidente | **IMPACTO INDETERMINADO** |

**Critério de aceite:** invocações diretas conhecidas dos vetores DistDFe/telemetria não abrem o oficial; nenhum teste desprotegido do escopo foi executado; suítes relevantes passaram com isolamento comprovado; nenhuma transmissão fiscal real ocorreu; o impacto permanece indeterminado.

Transmissão real permanece bloqueada por padrão. Auditoria do banco oficial **não** foi executada.
