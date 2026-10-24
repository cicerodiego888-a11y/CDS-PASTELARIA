# Microsprint P0.6 — Cobertura dos caminhos alternativos de acesso ao SQLite

**Prioridade:** P0 — Integridade dos dados  
**Data:** 18/10/2026  
**Dependência:** P0.5 — Blindagem de inicialização  
**Decisão final:** **APROVADA COM RESSALVAS**

Nesta microsprint **não** houve: commit/push/merge; abertura/consulta/migração/VACUUM/`integrity_check` do banco oficial; backup/reset/restauração reais de produção; `CDS_ALLOW_OFFICIAL_DB=1` em testes; SOAP/SEFAZ; PFX de produção; alteração de NSU/cooldown/filas; rodada ampla de testes; alteração dos gates fiscais P0.2–P0.4.

---

## 1. Matriz dos caminhos auditados (estática)

| Arquivo ou ponto de entrada | Driver/método | Origem do caminho | Pode alcançar oficial? | Barreira antes da abertura | Decisão |
|---|---|---|---|---|---|
| `backend/database.js` | `sqlite3.Database` | `DB_DIR` / ProgramData | Sim (produção) | `exigirAberturaDatabaseModule` (P0.5) | **PROTEGIDO** |
| `backend/lib/sqliteOfficialGuard.js` | wrap `Database` / verbose / cached | Argumento do caller | Sim se literal | Construtor + APIs backup/manutenção | **PROTEGIDO** |
| `backend/backup.js` | `fs.createReadStream` (+ require `database`) | Antes: `DB_DIR` ou `../dados`; agora `resolverCaminhoBancoOperacional` + `exigirCaminhosBackup` | Sim se path sensível | Sim — antes do stream | **PROTEGIDO COM CONDIÇÕES** (produção legítima fora de teste) |
| `backend/services/backupManual.js` | `fs.copyFileSync` (sem open SQLite) | Args `dbPath` / pasta | Sim se args oficiais | `exigirCaminhosBackup` antes de I/O | **PROTEGIDO** |
| `backend/rotas/backup.js` | via `backupManual` + `database` | Antes: hardcode `C:\projetos\MercantilFiscal\...`; agora `db.dbPath` + rejeição de body | Sim (legado removido da rota) | `rejeitarCaminhoClienteBanco` + `exigirCaminhosBackup` | **PROTEGIDO** |
| `backend/reset-users.js` | `sqlite3.Database` direto | Antes: `DB_DIR` ou `../dados`; agora só após `exigirScriptManutencaoDestrutiva` | Sim se apontar oficial | Bloqueio em teste; open só com script autorizado + `DB_DIR` temp | **BLOQUEADO POR SEGURANÇA** em teste |
| `backend/teste_usuarios.js` | `sqlite3.Database` | Antes: `./banco/mercadao.db`; agora resolução da barreira | Indireto | `exigirAberturaDatabaseModule` | **PROTEGIDO** |
| `backend/rotas/dashboard.js` → `listarHistoricoBackups` | FS listagem | Pasta derivada de `db.dbPath` | Se pasta sob oficial | `exigirCaminhosBackup` na listagem | **PROTEGIDO COM CONDIÇÕES** |
| Importação inicial (`fazerBackupManual`) | FS copy | `caminhoDb` do fluxo | Depende do caller | Herda barreira de `backupManual` | **PROTEGIDO COM CONDIÇÕES** |
| `tefBackupService.restaurarBackup` | FS + crypto (não SQLite .db) | Arquivo TEF | Não é mercadao.db | Fora do vetor SQLite de produção | **FORA DO ESCOPO COM JUSTIFICATIVA** |
| `better-sqlite3` | — | — | — | Não presente no `package.json` | **FORA DO ESCOPO COM JUSTIFICATIVA** |
| Demais `tests/**` com `sqlite3.Database` | Direto / `:memory:` | Variável | Só se literal oficial | Guard se preload/`isolar` ativo; senão risco residual | **NÃO VERIFICADO** (sem execução em massa) |
| Scripts ad-hoc `tmp-audit-*.js` | Direto | Próprio | Possível | Não alterados | **NÃO VERIFICADO** |

---

## 2. Arquivos alterados

| Arquivo | Justificativa |
|---|---|
| `backend/lib/sqliteOfficialGuard.js` | `caminhoEhProducaoSensivel` (oficial + legado MF); `exigirCaminhosBackup`; `exigirRestauracaoBanco`; `exigirScriptManutencaoDestrutiva`; `resolverCaminhoBancoOperacional`; `rejeitarCaminhoClienteBanco`; wrap do construtor cobre legado |
| `backend/services/backupManual.js` | Barreira antes de copy; validação de restauração; listagem valida pasta |
| `backend/backup.js` | Origem resolvida + `exigirCaminhosBackup` antes do stream |
| `backend/rotas/backup.js` | Remove hardcode legado; origem = `db.dbPath`; rejeita path do cliente |
| `backend/reset-users.js` | Bloqueia execução destrutiva em teste; open só após barreira |
| `backend/teste_usuarios.js` | Usa resolução segura da barreira |
| `tests/database/caminhos-alternativos-sqlite-p0-6.test.js` | Suíte 1–15 |
| `package.json` | `test:caminhos-alternativos-sqlite-p0-6` |
| Este relatório | Aceite |

---

## 3. Caminhos protegidos, bloqueados e não verificados

**Protegidos:** `database.js`, guard central, `backupManual`, rota `/backup`, `backup.js` (upload), `teste_usuarios.js`.

**Bloqueados em teste:** `reset-users.js` (destrutivo; exige `CDS_ALLOW_DESTRUCTIVE_DB_SCRIPT=1` + `DB_DIR` temp — **não** usado nesta sprint).

**Não verificados / ressalvas:** centenas de testes com `sqlite3` direto sem classificação executável; scripts `tmp-audit-*`; qualquer binário externo que abra o `.db` fora do Node.

---

## 4. Evidência de bloqueio antes da conexão / I/O

- Casos 5–6: `fazerBackupManual` com origem/destino oficial lança `CDS_BANCO_OFICIAL_BLOQUEADO` sem criar arquivos sob ProgramData.  
- Caso 8: subprocesso `reset-users.js` em `NODE_ENV=test` encerra sem `Conectado ao banco` / `Usuários deletados`.  
- Caso 4/14: `require('./backend/database')` sem `DB_DIR` sem `Conectado` / migração.  
- Caso 3: construtor `sqlite3.Database(oficial|legado)` lança antes do nativo.

---

## 5. Testes direcionados

```
node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/database/caminhos-alternativos-sqlite-p0-6.test.js
```

| Resultado | **15 ok, 0 falha(s)** |
|---|---|

Isolamento do pai: `BANCO DE TESTE: database.js não carregado` · `DB_DIR` = `%TEMP%\cds-preload-*`.

**Não** foram reexecutadas as suítes P0.1–P0.5 nem a bateria global (conforme escopo).

---

## 6. Confirmações

| Item | Status |
|---|---|
| Backup/reset/restauração reais de produção | **Não executados** |
| Acesso ao banco oficial nesta microsprint (suíte final) | **Não** |
| `CDS_ALLOW_OFFICIAL_DB=1` nos testes | **Não utilizado** |
| Commit / push / merge | **Não** |
| Gates fiscais P0.2–P0.4 | **Não modificados** |
| Rodada ampla de testes | **Não** |

---

## 7. Incidentes anteriores

P0.4 e abertura intermediária P0.5 permanecem **IMPACTO INDETERMINADO**.  
Esta sprint não abriu o oficial para investigar, não fez backup forense nem `integrity_check`. A proteção nova **não** prova integridade histórica dos dados.

---

## 8. Riscos remanescentes

1. Scripts/`sqlite3` fora do backend auditado sem preload.  
2. `CDS_ALLOW_DESTRUCTIVE_DB_SCRIPT=1` + `DB_DIR` temp permite reset em teste isolado — uso consciente.  
3. Produção continua podendo fazer backup do banco operacional (comportamento legítimo).  
4. Cobertura ≠ 100% do repositório de testes.  
5. Impacto de dados dos incidentes anteriores continua indeterminado até forense autorizada.

---

## 9. Critérios de aceite

| Critério | Status |
|---|---|
| Caminhos prioritários classificados estaticamente | **OK** |
| Backup/reset não alcançam oficial em teste | **OK** |
| Rotas não aceitam path arbitrário de banco | **OK** |
| Construtores diretos auditados protegidos/bloqueados | **OK** |
| Barreira antes de conexão/I/O | **OK** |
| Temp / `:memory:` permitidos | **OK** |
| Sem fallback sem config | **OK** |
| Suíte P0.6 isolada aprovada | **OK** (15/15) |
| Sem acesso oficial / sem rodada ampla | **OK** |
| Gates P0.2–P0.4 intactos | **OK** (não alterados) |
| Cobertura global 100% | **Não** → ressalva |

---

## 10. Decisão

**APROVADA COM RESSALVAS**

Os vetores prioritários (backup, reset, rota administrativa, construtor direto e legado `MercantilFiscal` em projetos) passam pela barreira central em contexto de teste. Limitações: scripts ad-hoc e testes não classificados fora do escopo executável desta sprint; impacto histórico dos incidentes permanece indeterminado.
