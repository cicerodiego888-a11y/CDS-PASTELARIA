# Microsprint P0.5 — Blindagem de inicialização do banco SQLite

**Prioridade:** P0 — Segurança operacional e integridade dos dados  
**Data:** 18/10/2026  
**Dependência:** incidente de `require('./backend/database')` sem preload (P0.4)  
**Decisão final:** **APROVADA COM RESSALVAS**

Nesta microsprint **não** houve commit, push, merge, SOAP/SEFAZ, PFX de produção, alteração de NSU/cooldown/filas da Central, cópia/restore/VACUUM/`integrity_check` do banco oficial, nem consulta SQL ao arquivo oficial.

---

## 1. Resumo do incidente anterior (P0.4)

| Fato | Evidência |
|---|---|
| Agente executou `require('./backend/database')` sem preload | Relatório P0.4 §9; log de verificação |
| `DB_DIR` ausente → fallback `ProgramData\MercantilFiscal\dados` | Código pré-P0.5 em `database.js` linhas 11–17 |
| Abertura + `ensure`/migrações de schema no oficial | Log: `BANCO OFICIAL EM USO`, `Conectado…`, `Alteração aplicada…`, `Tabela … criada/verificada` |
| Intenção | Verificação de caminho do DB, não operação fiscal |
| Alteração prejudicial de dados de negócio | **Não comprovada** pelos artefatos disponíveis |
| Integridade pós-incidente | **Não mensurada** (proibido abrir o oficial nesta sprint) |

**Classificação do impacto do incidente P0.4:** `IMPACTO INDETERMINADO`  
(Ausência de prova de dano ≠ prova de ausência de alteração.)

---

## 2. Matriz de caminhos de inicialização auditados

| Origem | Caminho de inicialização | Banco escolhido | Proteção anterior à abertura (antes → depois P0.5) | Situação |
|---|---|---|---|---|
| `backend/database.js` (top-level) | `new sqlite3.Database(DB_PATH)` + `inicializarBanco()` | `DB_DIR` ou ProgramData | Só preload externo → **barreira interna** `exigirAberturaDatabaseModule` | **Protegido** em teste/verificação |
| `require('sqlite3').Database` / `.verbose()` / `.cached` | Construtor nativo | Argumento do caller | Guardião só se preload → **guard contextual + forçado em teste** | **Protegido** se guard instalado |
| `isolarBancoTeste` / preload `-r` | Define `DB_DIR` temp + wrap sqlite3 | `%TEMP%\cds-*` | Já existia (P0.11) → alinhado ao módulo central | **Protegido** |
| `node -e "require('./backend/database')"` | Eager open | Oficial se sem `DB_DIR` | Nenhuma → **detecta `-e` via `execArgv`** e bloqueia | **Protegido** (vetor do incidente) |
| `npm run test:*` com preload | Preload → temp → app | Temp | Preload antes do arquivo | **Protegido** (scripts auditados) |
| `npm run test:*` sem preload que carregue `database.js` | Eager open | Oficial se sem `DB_DIR` | Frágil → agora `npm_lifecycle_event`/`NODE_ENV=test` bloqueiam sem `DB_DIR` | **Parcial** (scripts não auditados) |
| `backend/server.js` / app normal | `require('./database')` | Oficial ou `DB_DIR` | N/A produção | **Preservado** |
| `backend/backup.js`, `reset-users.js`, rotas backup | Paths próprios / `DB_DIR` | Pode ser oficial | Fora da barreira de `database.js` | **Ressalva** — não reescritos |
| `tmp-audit-*.js` / scripts ad-hoc | `sqlite3.Database(path)` | Variável | Sem guard se não carregarem o módulo | **Ressalva** |
| Testes com `:memory:` direto | Construtor local | Memória | OK se guard instalado | **OK** |
| `test:banco-init-01` | Filhos com `DB_DIR` temp | Temp nos filhos | Pai sem preload; filhos com `DB_DIR` | **Não reexecutado**; risco residual no pai |

Não foi feita varredura executável de todos os ~500 `.test.js` do repositório (evita descoberta por execução).

---

## 3. Arquitetura da barreira

### Módulo central

`backend/lib/sqliteOfficialGuard.js`

- Identifica caminho oficial com normalização (`path.resolve`, separadores, case).
- `detectarContextoProtegido()` — `CDS_TEST_ISOLATION`, `CDS_BLOQUEAR_BANCO_OFICIAL`, `CDS_FORCAR_LOCAL`, `NODE_ENV=test`, `npm_lifecycle_event=test*`, flags `-e/--eval/-p` em **`process.execArgv`** (Windows/Node atual não as coloca em `argv`), paths `.test.js` / `tests/`, preload em `execArgv`.
- `exigirAberturaDatabaseModule()` — **antes** de mkdir/conexão/ensure: em contexto protegido exige `DB_DIR` não oficial; sem fallback.
- `instalarGuardiaoSqlite3()` — envolve `Database` / `verbose` / `cached`; em teste força recusa do oficial.
- Override autorizado: `CDS_ALLOW_OFFICIAL_DB=1`.

### Integração em `database.js`

Ordem real:

1. `exigirAberturaDatabaseModule()` — pode lançar `CDS_BANCO_OFICIAL_BLOQUEADO`
2. `instalarGuardiaoSqlite3()`
3. `require('sqlite3').verbose()`
4. `mkdir` apenas do `DB_DIR` aprovado
5. `new Database` + `inicializarBanco`

Log distingue `BANCO DE TESTE EM USO` vs `BANCO OFICIAL EM USO`.

### Helpers de teste

`isolarBancoTeste.js` e `preloadIsolamentoBanco.js` passam a definir `CDS_TEST_ISOLATION=1` e reutilizar o módulo central (uma única fonte de verdade para path oficial).

---

## 4. Evidência de bloqueio anterior à abertura

Subprocesso `node -e "require('./backend/database')"` **sem** `DB_DIR`:

- Exit ≠ 0  
- `code: CDS_BANCO_OFICIAL_BLOQUEADO`  
- Mensagem com `DB_DIR ausente — fallback para ProgramData recusado`  
- **Ausência** de: `Conectado ao banco de dados SQLite`, `Banco de dados pronto`, `Alteração aplicada`, `Tabela … criada`

Casos 1, 6, 10–11 da suíte P0.5 comprovam a ordem. Caso 7 com `DB_DIR` em `%TEMP%` imprime `BANCO DE TESTE EM USO` e completa `whenReady` só no temporário.

---

## 5. Scripts protegidos e ainda não classificados

### Corrigidos / confirmados com preload `-r`

| Script | Estado |
|---|---|
| `test:fiscal-certificado-p0-1` … `p0-4` | Preload (já) |
| `test:fiscal-certificado-empresa` | Preload (já) |
| `test:central-entradas-rc2` | Preload (já) |
| `test:central-entradas-guardiao-banco` | Preload (já) |
| `test:blindagem-banco-p0-5` | **Novo** |
| `test:gestao-fiscal-visual-05-15` | **Novo script npm** com preload |
| `test:isolamento-nfce-empresa-05-46` | **Novo script npm** com preload |

### Fora da cobertura completa desta sprint

- Demais scripts `package.json` sem preload que possam carregar `database.js`
- `test:banco-init-01` (não reexecutado)
- Scripts que abrem `sqlite3` direto sem passar por `database.js` / guard
- `backup.js` / `reset-users.js` / rotas de backup com paths próprios
- Lazy-load de serviços (require eager de `database.js` permanece; em teste sem isolamento agora **falha** em vez de abrir o oficial)

---

## 6. Comandos e resultados

| Comando | Isolamento | Resultado |
|---|---|---|
| `npm run test:blindagem-banco-p0-5` | preload → `%TEMP%\cds-preload-*` | **14 ok, 0 falha** |
| `npm run test:fiscal-certificado-p0-1` | preload; DB não carregado | **19 ok** |
| `npm run test:fiscal-certificado-p0-2` | idem | **19 ok** |
| `npm run test:fiscal-certificado-p0-3` | idem | **22 ok** |
| `npm run test:fiscal-certificado-p0-4` | preload → TEMP | **24 ok** |
| `npm run test:fiscal-certificado-empresa` | preload | **16 ok** |
| `npm run test:gestao-fiscal-visual-05-15` | preload | **18 ok** |
| `npm run test:isolamento-nfce-empresa-05-46` | preload → TEMP | **21/21** |
| `npm run test:central-entradas-rc2` | preload → TEMP | **9 passou** |
| `npm run test:central-entradas-guardiao-banco` | preload | **11 pass, 0 fail** |

Gates fiscais P0.2–P0.4: regressões verdes (sem alteração de política criptográfica).

---

## 7. Evidência de isolamento por suíte

- Pai da suíte P0.5: `BANCO DE TESTE: database.js não carregado` + `DB_DIR` em `%TEMP%`  
- Filhos bloqueados: sem conexão/migração  
- Filho permitido (caso 7): path sob `%TEMP%`  
- Certificados P0.1–P0.3: database.js não carregado  
- P0.4 / 05.46 / rc2: `BANCO DE TESTE EM USO` + `COMPROVADO` em TEMP  

---

## 8. Investigação não invasiva do incidente

Fontes usadas (somente artefatos já existentes / logs de sessão):

1. Relatório P0.4 §9 (incidente de verificação).  
2. Código pré-barreira de `database.js` (fallback ProgramData + open eager).  
3. Comportamento observado no primeiro run da suíte P0.5 caso 10 (antes do fix `execArgv`): o mesmo vetor `node -e` ainda abriu o oficial porque `-e` **não** aparece em `process.argv` neste Node/Windows — só em `process.execArgv`.  

### Conclusões factuais

- Houve **inicialização e rotinas de schema/ensure** no oficial no incidente P0.4.  
- Houve **segunda abertura** do oficial durante o desenvolvimento do teste P0.5 caso 10 (falha intermediária), antes da correção de detecção via `execArgv`.  
- Não há hash/baseline autorizado pré/pós para provar integridade de dados de negócio.  
- Não foi executada análise forense dos arquivos `.db`/`.wal`/`.shm`.

### Classificação

**IMPACTO INDETERMINADO** (incidente P0.4 e abertura intermediária na elaboração do P0.5).

Análise forense do arquivo oficial exige autorização específica em procedimento isolado — **não** realizada.

---

## 9. Riscos remanescentes

1. Scripts/`sqlite3` diretos que nunca carregam o guard.  
2. `CDS_ALLOW_OFFICIAL_DB=1` remove a proteção — uso deve ser consciente.  
3. Lazy-load de `database.js` não implementado (require ainda inicializa; em teste sem config agora bloqueia).  
4. Cobertura global de todos os scripts npm / testes fora do escopo auditado.  
5. Manutenção via `node -e` no oficial exige `CDS_ALLOW_OFFICIAL_DB=1` + `DB_DIR` (ou não usar `-e`).  
6. Aberturas intermediárias já ocorridas: impacto de dados indeterminado até auditoria autorizada.

---

## 10. Confirmações de processo

| Item | Status |
|---|---|
| Suítes finais sem abrir oficial | **OK** (TEMP / bloqueio) |
| Sem commit / push / merge | **OK** |
| Sem SEFAZ / PFX produção / NSU | **OK** |
| Gates P0.2–P0.4 intactos | **OK** (regressões) |
| Blindagem global de 100% dos caminhos do repo | **Não** — por isso **COM RESSALVAS** |

**Nota:** a abertura intermediária do oficial no 1º run do caso 10 (durante implementação) viola o desejo de “zero aberturas nesta microsprint”; está documentada. Após o fix `execArgv`, a sonda e a suíte completa passaram sem nova conexão (`PROBE`/`casos 1/6/10` sem `Conectado`).

---

## 11. Arquivos alterados

| Arquivo | Justificativa |
|---|---|
| `backend/lib/sqliteOfficialGuard.js` | **Novo** — barreira central |
| `backend/database.js` | Validação antes de mkdir/open/ensure; log correto |
| `tests/central-entradas/helpers/isolarBancoTeste.js` | Reutiliza barreira; flags de isolamento |
| `tests/central-entradas/helpers/preloadIsolamentoBanco.js` | Marca isolamento no início |
| `tests/database/blindagem-inicializacao-banco-p0-5.test.js` | Suíte negativa 1–15 |
| `package.json` | Scripts `test:blindagem-banco-p0-5`, gestao-fiscal, isolamento-05-46 |
| Este relatório | Evidência de aceite |

---

## 12. Critérios de aceite

| Critério | Status |
|---|---|
| Oficial protegido em contextos de teste cobertos | **OK** |
| Proteção antes de conexão/ensure/migração | **OK** |
| Sem `DB_DIR` em teste ≠ fallback produção | **OK** |
| Caminhos alternativos cobertos ou documentados | **OK com ressalvas** |
| Import sem isolamento não inicializa oficial | **OK** (bloqueia) |
| Scripts auditados com isolamento | **OK** |
| Testes negativos da barreira | **OK** (14/14) |
| Regressões P0.1–P0.4 / isolamento / rc2 | **OK** |
| Investigação distingue fatos vs incerteza | **OK** → IMPACTO INDETERMINADO |
| Gates fiscais intactos | **OK** |
| Zero abertura oficial nas suítes **finais** | **OK** |
| Zero abertura em todo o ciclo P0.5 (incl. iteração) | **Não** — abertura intermediária documentada |

---

## 13. Decisão

**APROVADA COM RESSALVAS**

A repetição do incidente `node -e require(database)` sem `DB_DIR` fica bloqueada na barreira central (incluindo detecção via `execArgv`). Scripts auditados e regressões fiscais permanecem verdes. Ressalvas: cobertura não global, scripts diretos `sqlite3`, impacto de dados dos incidentes **indeterminado**, e uma abertura intermediária durante o desenvolvimento do teste negativo antes do ajuste `execArgv`.
