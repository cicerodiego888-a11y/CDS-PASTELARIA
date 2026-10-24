# Microsprint P0.5 — Blindagem global dos scripts de teste e plano de verificação somente leitura

**Prioridade:** P0 — Segurança operacional / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** preload npm global + revisão do guardião + procedimento futuro (não executado)  
**Pré-requisitos:** P0, P0.1, P0.2, P0.3, P0.4

Esta microsprint **não** abriu o banco oficial, **não** consultou a SEFAZ, **não** abriu PFX de produção, **não** alterou NSU/cooldown/estoque/compras/financeiro e **não** iniciou recuperação de NF-e. Sem commit, push ou merge. Sem migrations no caminho `C:\ProgramData\MercantilFiscal\dados`. Sem `require` de `backend/database.js` apontando para o oficial.

**Impacto da primeira execução 05.72 permanece indeterminado.** Esta sprint apenas impede repetição em scripts npm da Central e documenta como investigar depois, em modo somente leitura.

---

## 1. O que o `-r` resolve — e o que não resolve

O preload Node:

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js [--test] <arquivo>
```

executa `preloadIsolamentoBanco.js` **antes** do arquivo de teste. `require.main` continua sendo o teste. O helper define `DB_DIR` em Temp e instala o wrap de `sqlite3` **antes** de qualquer import de risco (`DfeAuditoriaService` → `database.js`).

O `-r` do `package.json` **não** protege:

| Forma | Protegida pelo npm `-r`? |
|---|---|
| `npm run test:central-entradas-…` | sim |
| `node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js arquivo.test.js` | sim |
| `node arquivo.test.js` (sem `-r`) | **não** — só é aceitável se o arquivo chama `isolarBancoTeste()` **antes** de qualquer require de risco |
| `node -e "require('./arquivo.test.js')"` | **não usar** — quebra `require.main === module` e não é o preload |
| processo filho `spawn(node, ['-e', sonda])` sem `-r` no filho | **não** — o filho precisa de `DB_DIR` próprio ou do mesmo `-r` |

Não se envolveu o teste com `require(arquivo)`. Essa forma foi descartada na P0.4.

---

## 2. Scripts auditados e alterados

Auditoria: todos os `scripts` de `package.json` que invocam `tests/central-entradas/`. Cada invocação `node` (inclusive as encadeadas com `&&` em `test:central-entradas-03` e `test:central-integridade`) recebeu o preload se ainda não o tinha.

### 2.1 Já tinham `-r` (P0.4) — inalterados na lógica, apenas revalidados

- `test:central-entradas-cursor-656`
- `test:central-entradas-prep-chave`
- `test:central-entradas-identidade-chave`
- `test:central-entradas-05-72`
- `test:central-entradas` (cada `node` da cadeia)

### 2.2 Receberam `-r` nesta sprint (54 scripts da pasta Central)

Inclui, entre outros: `test:central-entradas-estados`, `guardiao-banco`, `03`, `04`, `05`, `06`, `rc3`, `rc4`, `rc4.1`, `rc4.3`, `rc4.3.1`, `rc31`, `rc3.3`, `rc3.3.3`, `rc3.4`, `rc3.4.6.1`, `rc3.4.8`, `rc3.4.9`, `rc3.4.9a`, `rc3.5.0`, `rc3.5.1`, `rc3.6.0`, `rc3.6.1`, `rc3.6.h`, `rc3.7.1`, `rc3.7.5`, `rc3.7.5.1–3`, `rc3.7.6` e `.6.1–.6.5`, `rc4.0`, `rc6.1–rc6.5`, `rc1`, `rc2`, sprints 4/5/7/8/9/10, `xml-multicnpj-01/02`, `central-xml-02`, `contexto-empresa`, e os `node` internos de `test:central-integridade`.

Assert estático no guardião: **zero** partes `node … tests/central-entradas/` sem `preloadIsolamentoBanco.js`.

### 2.3 Adjacentes (mesmo vetor `database.js`, fora da pasta Central)

| Script | Ação | Executado? |
|---|---|---|
| `test:dfe-observabilidade-rc3.6.e` | preload adicionado — `DfeAuditoriaService` faz `require('../../database')` eager (mesmo vetor do incidente 05.72) | sim, após isolamento comprovado |
| `test:central-homologacao-rc4318` | preload adicionado para recusar o oficial se alguém rodar o npm | **não** — e2e; isolamento SEFAZ/certificado **não** comprovado |
| `test:banco-init-01` | **sem** preload Central; isola por processo filho com `DB_DIR` Temp | **não** executado |
| `test:dfe-retorno-parser` | parser; não importa `database.js` | **não** executado (fora do escopo) |
| `seed:central-entradas` | não é teste; escreveria dados | **não** executado |

`backend/database.js` de produção **não** foi modificado. O guardião existe só no processo de teste.

---

## 3. Forma segura de executar cada grupo

### 3.1 Preferida (npm)

```text
npm run test:central-entradas-guardiao-banco
npm run test:central-entradas-05-72
npm run test:central-entradas-identidade-chave
npm run test:central-entradas-prep-chave
npm run test:central-entradas-cursor-656
npm run test:central-entradas
npm run test:central-entradas-03
npm run test:central-entradas-04
npm run test:central-entradas-05
npm run test:central-entradas-rc3
npm run test:central-entradas-rc4
```

Qualquer outro `test:central-entradas-*` / `test:central-xml-*` / `test:contexto-empresa` / `test:central-integridade` agora passa pelo mesmo `-r`.

### 3.2 Equivalente direto com `node` (obrigatório o `-r`)

```text
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/central-entradas/<arquivo>.test.js
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test tests/central-entradas/<arquivo>.test.js
```

### 3.3 Ainda executável só com comando específico (não herda o npm)

1. **Arquivo da Central sem `-r`:** somente se a primeira linha executável for `isolarBancoTeste(...)` (P0.4). Preferir sempre o comando da §3.2.
2. **`test:banco-init-01`:** `node tests/database/banco-init-01.test.js` — o pai define Temp e o filho recebe `DB_DIR`. Não usar o preload da Central nesse filho sem revisar o `spawnSync`.
3. **Homologação e2e:** `npm run test:central-homologacao-rc4318` agora aponta Temp, mas **não** é verificação operacional real e **não** foi executada aqui.
4. **Investigação futura do oficial:** **não** usar preload nem `isolarBancoTeste` — eles recusam o caminho oficial inclusive em `OPEN_READONLY`. Ver §6.

---

## 4. Guardião sqlite3

`isolarBancoTeste.js` (no `require` do helper / preload) envolve:

- `sqlite3.Database`
- `sqlite3.verbose().Database`
- `sqlite3.cached.Database` (quando a API existe)

O wrap chama `recusarOficial(filename)` **antes** de `new DatabaseOrig(...)`. Inclui `OPEN_READONLY` do caminho oficial. `:memory:` e arquivos sob o `DB_DIR` Temp continuam permitidos.

Testes adicionados nesta sprint (arquivo `microsprint-p0-4-guardiao-banco-oficial.test.js`):

| Caso | Resultado |
|---|---|
| `sqlite3.Database` (sem verbose) recusa o oficial | pass |
| `sqlite3.verbose().Database` recusa o oficial | pass |
| `sqlite3.cached.Database` recusa o oficial | pass (API presente) |
| `OPEN_READONLY` do oficial recusado | pass |
| `:memory:` + arquivo no Temp permitidos | pass |
| `cached.Database(':memory:')` permitido | pass |
| scripts npm da Central incluem preload | pass (lista vazia de omissões) |
| 05.72 isola antes de `CentralSincronizacaoService` | pass |
| classificação estática: 0 BLOQUEADA | pass (`isoladas=55` `sem-banco=41` `total=96`) |
| `database.js` não carregado nesta suíte | pass |

Nenhum teste desabilitado. Inicialização de produção (`database.js`) **não** foi alterada para acomodar testes.

---

## 5. Testes executados (isolamento comprovado)

Nenhum stdout das suítes abaixo contém `C:\ProgramData\MercantilFiscal\dados`. O rótulo `BANCO OFICIAL EM USO` de `database.js` é fixo e **enganoso**; o caminho impresso ao lado é o comprovante real.

| Comando | Resultado | Banco comprovado |
|---|---|---|
| `npm run test:central-entradas-guardiao-banco` | **11 pass, 0 fail** | `database.js` **não carregado**; construtor recusou o path oficial |
| `npm run test:central-entradas-05-72` | **10/10** | `C:\Users\cicer\AppData\Local\Temp\cds-preload-CfHc7Y\mercadao.db` — MIB **0** produtos |
| `npm run test:central-entradas-identidade-chave` | **15 pass** | `...\Temp\cds-preload-qqN4nh\mercadao.db` |
| `npm run test:central-entradas-prep-chave` | **17 pass** | `...\Temp\cds-preload-3nOegX\mercadao.db` (prep não abre `database.js`) |
| `npm run test:central-entradas-cursor-656` | **15 pass** | `...\Temp\cds-preload-L7dNkJ\mercadao.db` |
| `npm run test:central-entradas` | **exit 0** (sprint2/4/5/7/8/9/10, rc1, rc2, máquina de estados) | Temp `cds-preload-*` em cada processo (`EooSLh`, `WqzKF2`, `4n5cbu`, `qfguT2`, `M3UgTS`, `9AplxM`, `Cr5TNH`, `YgB0sQ`) |
| `npm run test:central-entradas-03` | **17 + 12 ok, 0 falha** | preload Temp; SOAP mock; sem ProgramData |
| `npm run test:central-entradas-04` | **21 ok, 0 falha** | preload Temp; SOAP mock |
| `npm run test:central-entradas-05` | **28 ok, 0 falha** | `DB_DIR` `...\Temp\cds-preload-7ZiVO8` |
| `npm run test:dfe-observabilidade-rc3.6.e` | **6/6** | `...\Temp\cds-preload-GS5Q7V\mercadao.db` — mesmo vetor eager da 05.72, agora em Temp, MIB **0** |

### 5.1 RC3 / RC4 — isolamento comprovado; asserts legados

| Comando | Isolamento | Asserts |
|---|---|---|
| `npm run test:central-entradas-rc3` | `...\Temp\cds-preload-C4CYX1\mercadao.db` | 10 ok, **1 falha** (`EM_PROCESSAMENTO` → `REVISADA`) |
| `npm run test:central-entradas-rc4` | `...\Temp\cds-preload-kAZjLa\mercadao.db` | 13 ok, **1 falha** (`EMPRESA_OPERACIONAL_AUSENTE` vs esperado `CERTIFICADO`) |

As duas falhas **não** foram desabilitadas. Não foram “corrigidas” nesta sprint: a de RC3 é máquina de estados; a de RC4 é o fail-closed de identidade (P0.3) num Temp vazio. Isolamento do oficial está comprovado pelo caminho Temp. Fora do critério de aceite desta microsprint alterar a suíte RC3/RC4.

**Não executados (isolamento operacional não comprovado ou fora do escopo):** `test:central-homologacao-rc4318`, `test:banco-init-01`, `seed:central-entradas`, `test:dfe-retorno-parser`.

---

## 6. Procedimento futuro — leitura autorizada do banco oficial

**Não executado nesta microsprint.** Não existe script npm para este procedimento de propósito: um `npm run` acidental voltaria a ser o incidente.

### 6.1 Pré-condições (todas obrigatórias)

1. Autorização **escrita** do operador (nome, data, objetivo: “incidente 05.72 — leitura”).
2. Variáveis de ambiente no processo (exemplo; o processo aborta se faltarem):
   - `CDS_AUTORIZAR_LEITURA_BANCO_OFICIAL=1`
   - `CDS_CONFIRMACAO_OPERADOR=<nome e data>`
3. **Não** importar `backend/database.js`.
4. **Não** carregar `preloadIsolamentoBanco.js` nem `isolarBancoTeste` — o guardião de teste recusa o oficial até em `OPEN_READONLY`.
5. **Não** chamar `inicializarBanco()`, migrations, seeds, MIB `swap`, recálculo de estoque.
6. **Não** DistDFe, `consChNFe`, PFX, 210210, avanço de NSU.
7. Aplicação de produção **fechada** ou pelo menos sem escrita concorrente no mesmo arquivo, se possível.

### 6.2 Abertura (somente leitura)

Preferência: **cópia de arquivo** (leitura do oficial pelo SO) para um diretório Temp de investigação, depois abrir **a cópia**. Motivo: `OPEN_READONLY` num SQLite em WAL ainda pode criar/atualizar `-shm` no diretório original.

Se a cópia for autorizada:

1. Copiar `mercadao.db`. Se existirem `mercadao.db-wal` / `mercadao.db-shm`, copiar o trio **ou** documentar que páginas não checkpointadas podem faltar na cópia só do `.db`.
2. Abrir a cópia:

```js
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(caminhoCopia, sqlite3.OPEN_READONLY);
db.exec('PRAGMA query_only = ON');
```

Se a cópia **não** for autorizada: `new sqlite3.Database(caminhoOficial, sqlite3.OPEN_READONLY)` + `PRAGMA query_only=ON`, registrando o risco de `-shm`.

Confirmar imediatamente:

```sql
PRAGMA query_only;     -- deve ser 1
PRAGMA journal_mode;
```

Proibido no mesmo processo: `BEGIN IMMEDIATE` / `EXCLUSIVE`, `UPDATE`, `INSERT`, `DELETE`, `REPLACE`, `DROP`, `ALTER`, `CREATE` (exceto se `query_only` já recusar — mesmo assim não emitir), `VACUUM`, `WAL checkpoint`, `PRAGMA user_version =`.

### 6.3 Consultas previstas (todas `SELECT` / `PRAGMA` de leitura)

Registrar **SQL + resultado** (ou erro) num arquivo datado, por exemplo `docs/central-entradas/leitura-autorizada-0572-AAAA-MM-DD.md`. Mascarar CNPJ e chave.

1. `PRAGMA query_only;` `PRAGMA journal_mode;` `PRAGMA page_count;` `PRAGMA page_size;`
2. `SELECT name, type FROM sqlite_master WHERE name LIKE '%central_entradas%' OR name LIKE 'compras%' OR name LIKE 'financeiro%' OR name LIKE 'produtos%' OR name LIKE '%estoque%' ORDER BY type, name;`
3. Flags de migração (não inferir data da escrita):  
   `SELECT chave, valor FROM configuracoes WHERE chave IN ('migracao_recalc_saldos_estoque_v1') OR chave LIKE '%migracao%' OR chave LIKE '%05.38%' OR chave LIKE '%05.40%' OR chave LIKE '%05.41%' OR chave LIKE '%05.49%';`
4. Contagens atuais (estado **presente**, não delta):  
   `SELECT COUNT(*) FROM produtos;`  
   `SELECT COUNT(*) FROM empresas;`  
   `SELECT COUNT(*) FROM central_entradas_documentos;`  
   `SELECT COUNT(*) FROM compras_itens;`  
   `SELECT COUNT(*) FROM financeiro;`  
   `SELECT COUNT(*) FROM estoque_empresa;` — se a tabela existir.
5. Cursor NSU / cooldown (**presente**):  
   `SELECT empresa_id, ambiente, ult_nsu, max_nsu, cooldown_ate, ultimo_cstat FROM central_entradas_nsu;` — mascarar identificadores fiscais.
6. Colunas novas vs código (`PRAGMA table_info(...)`) só para cruzar com o log `ALTER TABLE` da primeira 05.72 — presença de coluna **não** prova que a 05.72 a criou.
7. Metadados de arquivo (mtime/size de `.db` / `-wal` / `-shm`) — estado presente do filesystem.

Não consultar XML completo nem senhas. Não exportar o banco.

### 6.4 Comparação permitida

Somente com evidências **já preservadas**:

- stdout da primeira 05.72 (relatório P0.3 §6 / P0.4 §2): caminho oficial, MIB 712, totais das migrações 05.38–05.49, “Correção quantidades fiscais legadas compras_itens concluída”.
- Código atual de `inicializarBanco()` (o que **pode** ter rodado).

**Não** inventar snapshot anterior. Não usar o estado do Temp das suítes isoladas como “antes”.

### 6.5 Classificação obrigatória do laudo futuro

| Classe | Significado |
|---|---|
| **Fato** | Observado no log da 1ª 05.72 ou lido agora com SQL registrado |
| **Indício** | Compatível com o código (ex.: flag `migracao_recalc_saldos_estoque_v1 = '1'` hoje) mas não prova a autoria da 05.72 |
| **Indeterminável** | Delta de linhas, NSU/cooldown **durante** a 05.72, recálculo de estoque com `changes` não impresso, “nada persistiu” |

Uma leitura do estado atual **revela o presente**. **Não prova** o que mudou na primeira execução 05.72. Sem backup/snapshot prévio, o impacto permanece **indeterminado**.

`tmp-audit-xml-indisp.js` **não** é este procedimento: não tem autorização, não liga `query_only`, não registra o protocolo. Não executá-lo como substituto.

---

## 7. Limitações históricas do incidente 05.72 (reafirmadas)

**Fatos (log P0.3, sem nova leitura):**

- O processo abriu `C:\ProgramData\MercantilFiscal\dados\mercadao.db`.
- `inicializarBanco()` correu até o trecho visível (05.38–05.49, correção `compras_itens`, MIB 712).
- Os 10 testes 05.72 usaram `:memory:` para documentos da suíte.

**Indícios (código, sem prova de `changes`):**

- `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN` / `CREATE INDEX IF NOT EXISTS` podem ter sido no-ops.
- `UPDATE` de ownership 05.38/05.40/05.41/05.49 e de `compras_itens` **podem** ter alterado linhas; o log não imprime `changes`.
- Recálculo de estoque: a 1ª execução **não** imprimiu claramente `Recálculo saldos estoque concluído (0 produtos)`; execuções isoladas posteriores em Temp vazio imprimem `(0 produtos)`.

**Indeterminável sem a leitura autorizada — e mesmo com ela, em grande parte:**

- Quantas linhas cada `UPDATE` alterou.
- Se o recálculo de estoque rodou de verdade ou saiu pela flag já `'1'`.
- Estado do NSU/cooldown **antes** vs **depois**.
- Qualquer restauração (não tentada; não tentável com segurança a partir só do estado atual).

---

## 8. Confirmações desta sprint

| Item | Estado |
|---|---|
| Banco oficial aberto / consultado | **não** |
| `database.js` / migrations no caminho ProgramData | **não** |
| SEFAZ / DistDFe / `consChNFe` reais | **não** |
| PFX de produção | **não** |
| NSU, cooldown, estoque, compras, financeiro de produção | **não** alterados |
| Recuperação de NF-e | **não** iniciada |
| Procedimento §6 executado | **não** |
| Git commit / push / merge / comandos destrutivos | **não** |
| Testes desabilitados | **não** |
| Scripts npm da Central executáveis sem `-r` | **não** (assert no guardião) |
| `node arquivo.test.js` sem `-r` | continua possível; só seguro com helper no topo do arquivo — documentado, não “resolvido” pelo `package.json` |

---

## Critérios de aceite

| Critério | Estado |
|---|---|
| Scripts da Central que podem carregar `database.js` exigem proteção comprovada no npm | Atendido (`-r` + assert estático) |
| Guardião recusa `Database` / `verbose()` / `cached.Database` / `OPEN_READONLY` do oficial antes do nativo | Atendido |
| `:memory:` e Temp continuam permitidos | Atendido |
| Produção (`database.js`) não alterada por problema exclusivo de teste | Atendido |
| Suítes obrigatórias isoladas executadas com caminho Temp registrado | Atendido |
| Plano de investigação 05.72 somente leitura, sem `database.js`, sem migrations, com fatos/indícios/indeterminável | Atendido (**não executado**) |
| Banco oficial não aberto nesta sprint | Atendido |

**Limite cumprido: blindar execução npm e documentar leitura futura. Não investigar o arquivo oficial agora. Não recuperar NF-e.**
