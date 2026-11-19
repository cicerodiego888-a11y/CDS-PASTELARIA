# RELATÓRIO — Correção final pós-auditoria S07-2

**Data:** 2026-11-17  
**Status:** ENTREGUE PARA NOVA AUDITORIA DO TECH LEAD  
**Escopo:** persistência obrigatória, validação do retorno Electron, rollback integral, investigação `cozinha_notificacoes`

---

## 1. Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/erp/js/cozinha-kds.js` | Persistência obrigatória; validação `success` do Electron; rollback integral |
| `tests/cozinha/sprint07-s07-2-sessao-unidade-kds.test.js` | Novos testes + harness HTTP sem corrida de schema |

### Entregáveis
- `Agent/DIFF-CORRECAO-FINAL-S07-2.patch`
- `Agent/LOG-CORRECAO-FINAL-S07-2.txt`
- `Agent/RELATORIO-CORRECAO-FINAL-S07-2.md` (este)

### Não alterados
- Sprint 06 / impressão
- S07-0 contrato
- Login / PDV / schema oficial / banco oficial
- Backend de emissão JWT S07-2

---

## 2. Correções aplicadas

### 2.1 Persistência obrigatória
`confirmarUnidade()` exige `typeof deps.aoAtualizarSessao === 'function'`.  
Caso contrário: erro `SESSAO_PERSISTENCIA_OBRIGATORIA`, modo `selecao`, sem painel/polling.

### 2.2 Contrato Electron e validação

**Contrato real** (`electron-cozinha-impressao.js`, canal `cozinha-impressao:sessao-autenticada`):

```js
// Sucesso
{ success: true, sessao: { empresaId, unidadeId }, contexto }

// Falha — Promise RESOLVE (não rejeita)
{ success: false, codigo: '<CODIGO>', erro: '<mensagem>' }
```

Códigos observados no main (via `estabelecerSessaoApartirDoToken` / IPC):
- `IMPRESSAO_IPC_REMETENTE_INVALIDO`
- `IMPRESSAO_SESSAO_TOKEN_OBRIGATORIO` / `_EXPIRADO` / `_INVALIDO`
- `IMPRESSAO_SESSAO_SEM_UNIDADE` / `_UNIDADE_INEXISTENTE` / `_UNIDADE_INATIVA`
- `IMPRESSAO_SESSAO_EMPRESA_INVALIDA` / `_EMPRESA_DIVERGENTE`
- `IMPRESSAO_SESSAO_ERRO` (catch genérico)
- `DB_INDISPONIVEL`

**Evidência de validação:** `interpretarRetornoEstabelecerSessao(retorno)` exige `success === true`.  
Resolve com `success: false` → falha explícita + rollback. Rejeição da Promise também tratada.

Não se altera o mecanismo de impressão S06 — apenas se consome o retorno da sessão.

### 2.3 Rollback do localStorage
1. Snapshot anterior (`token`/`user`) é **obrigatório**; falha na leitura → `SESSAO_PERSISTENCIA_FALHA` (sem gravar).
2. Falha ao gravar token → rollback + erro (preserva `cause`).
3. Falha ao gravar user após token → rollback integral (impede token novo + user antigo).
4. Falha Electron após gravação → rollback; se rollback falhar → `SESSAO_ROLLBACK_FALHA`.

---

## 3. Investigação — `SQLITE_ERROR: no such table: main.cozinha_notificacoes`

### Origem
Em `backend/utils/cozinhaSchema.js`:
1. `recriarSchemaVazioSeNecessario` faz `DROP TABLE` de todas as `TABELAS_COZINHA` (inclui `cozinha_notificacoes`).
2. `criarTabelasCozinha` recria a tabela e em seguida `CREATE UNIQUE INDEX ... ON cozinha_notificacoes(...)`.
3. `database.js` chama `garantirSchemaCozinha` no boot assíncrono; testes HTTP também chamavam `garantirSchemaCozinha` cedo.

### Sequência da falha
Duas execuções concorrentes de `garantirSchemaCozinha` no **mesmo** arquivo SQLite:
- A: cria tabela + inicia índices  
- B: DROP da tabela (recreate v0→v3)  
- A: `CREATE INDEX ON cozinha_notificacoes` → `SQLITE_ERROR: no such table: main.cozinha_notificacoes`  
- Boot registra `FALHA_SCHEMA` e `marcarCozinhaOperacional(false, err)` (não oculta).

### Natureza
Problema de **corrida de inicialização/teste** (dupla garantia no mesmo DB), não de ausência permanente da tabela no schema v3.  
`CREATE TABLE IF NOT EXISTS cozinha_notificacoes` existe e é criado corretamente em execução **sequencial**.

### Tratamento nesta correção
- Harness HTTP S07-2: espera `cozinha_notificacoes` + status estabilizado; `garantirSchemaCozinha` sequencial com retry; **não** chama `marcarCozinhaOperacional(true)` se a garantia falhar.
- Testes dedicados: criação sequencial OK; simulação DROP+INDEX falha e operacional=false; evidência da sequência no código-fonte.
- **Não** se declara Cozinha operacional enquanto a falha persiste.
- **Não** se alterou Sprint 06 nem schema oficial.

---

## 4. Testes

| Grupo | Resultado |
|-------|-----------|
| S07-2 completo (42) | PASS |
| S07-1 regressão (10) | PASS |

Novos / reforçados:
- Persistência ausente
- Electron `success: false`
- Falha gravação token / user
- Rollback preserva anteriores
- Schema `cozinha_notificacoes` + operacional=false em falha

Isolamento: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`.

---

## 5. Diff

`Agent/DIFF-CORRECAO-FINAL-S07-2.patch` (contra cópia do pacote de auditoria S07-2).

---

**Parar e aguardar nova auditoria do Tech Lead.**  
Sem S07-3. Sem migração/homologação/reinício do ambiente oficial.
