# Microsprint P0.4 — Auditoria do incidente de banco e blindagem das suítes

**Prioridade:** P0 — Segurança operacional / Central de Entradas  
**Data:** 17/10/2026  
**Tipo:** auditoria do incidente 05.72 + prevenção  
**Pré-requisitos:** P0, P0.1, P0.2, P0.3

Esta microsprint **não** recuperou NF-e, **não** consultou a SEFAZ, **não** abriu PFX de produção e **não** tentou restaurar o banco oficial. Sem commit, push ou merge. Sem nova conexão de teste ao caminho `C:\ProgramData\MercantilFiscal\dados`.

**Impacto da primeira execução 05.72: indeterminado.** Há evidência de que `database.js` abriu o arquivo oficial e disparou inicialização/migrações. Não há evidência suficiente, sem ler o banco oficial, para afirmar que linhas de negócio foram alteradas nem para afirmar que nada persistiu.

---

## 1. Causa técnica do acesso acidental

### 1.1 Comando

```text
node tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js
```

Executado na microsprint P0.3 **antes** de existir `isolarBancoTeste()` nesse arquivo. Os asserts da suíte usam SQLite `:memory:` para `central_entradas_documentos`. O dano colateral veio do **import**, não dos `INSERT` da suíte.

### 1.2 Cadeia de importação

```
isolamento-buscar-chave-empresa-05-72.test.js
  └─ CentralSincronizacaoService.js          (require no topo)
       └─ distribuicaoDFe.js                 (require no topo)
            └─ DfeAuditoriaService.js        (require no topo)
                 └─ require('../../database')  ← conexão abre aqui
```

`DfeAuditoriaService.js` linha 10: `const db = require('../../database');` — **eager**, na importação.

`configService.js` também pode carregar `database.js`, mas só em `useDb()` (lazy). O caminho que disparou o incidente é o require eager da auditoria DistDFe.

### 1.3 Momento da conexão

`backend/database.js`, na carga do módulo, **antes** de qualquer função de teste:

1. `DB_DIR = process.env.DB_DIR || ProgramData\MercantilFiscal\dados`
2. `console.log('BANCO OFICIAL EM USO:', DB_PATH)` — o rótulo é fixo mesmo quando `DB_DIR` é Temp
3. `new sqlite3.Database(DB_PATH, …)`
4. `PRAGMA journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON`
5. `inicializarBanco()` → `criarTabelas()`, `criarTabelasMiip()`, `aplicarAlteracoesPosCriacao()`, migrações 05.38/05.40/05.41/05.49, seeds, MIB

Na primeira execução 05.72, `DB_DIR` **não** estava definido. O fallback foi o caminho oficial.

### 1.4 SQL de inicialização que o código dispara nessa carga

Não se leu o banco oficial nesta sprint. A lista abaixo é o que `inicializarBanco()` **pode** executar ao importar `database.js` (código atual):

| Família | Exemplos no código | Persistência possível |
|---|---|---|
| DDL `CREATE TABLE IF NOT EXISTS` | dezenas de tabelas (incluindo `central_entradas_*`, `compras`, `financeiro`, `produtos`) | nova tabela só se ainda não existisse |
| `ALTER TABLE … ADD COLUMN` | `aplicarAlteracaoSegura` / `garantirColunas*` | coluna nova se faltava; log `duplicate column name` = sem mudança |
| `CREATE INDEX IF NOT EXISTS` | vendas, pedidos, reservas, auditoria, eventos Central | índice novo se faltava |
| Migrações de `empresa_id` | 05.38.D/E/F.B, 05.40 vendas, 05.41 financeiro, 05.49 pedidos | `UPDATE` condicional; log mostra totais lidos |
| `compras_itens` | `recuperarQuantidadesFiscais*`, `corrigirQuantidadesFiscaisComprasItensLegacy` | `UPDATE` com filtro; linhas afetadas **não** estão no log |
| Recálculo de estoque | `migrarRecalcularSaldosEstoque` se flag `migracao_recalc_saldos_estoque_v1` ≠ `'1'` | `UPDATE` de saldos + grava a flag |
| MIB | carrega catálogo em memória | leitura; log `[MIB] iniciado N produtos` |
| Seed | admin, categorias despesa, PINPAD, `configuracoes` padrão | `INSERT` se ausente |

Os testes 05.72 em si (`INSERT` em `:memory:`) **não** escrevem no oficial.

---

## 2. Evidências da primeira execução

Fonte: stdout capturado na P0.3 (mesmo processo), reproduzido no relatório P0.3 §6.

Trechos observados:

```text
BANCO OFICIAL EM USO:
C:\ProgramData\MercantilFiscal\dados\mercadao.db
Conectado ao banco de dados SQLite
…
[MIB] iniciado 712 produtos em memória
[05.38.E] … ambiguos=2 …
[05.38.F.B] … ambiguos=1 …
[05.40] MIGRATION_VENDAS_EMPRESA_05_40 | TOTAL: 20 | … | NÃO_CLASSIFICADAS: 2
[05.41] MIGRATION_FINANCEIRO_EMPRESA_05_41 | TOTAL_FINANCEIRO: 21 | …
Correção quantidades fiscais legadas compras_itens concluída
OK 10/10
```

Interpretação segura:

- A conexão abriu o arquivo oficial (caminho impresso + 712 produtos MIB ≠ banco vazio).
- `inicializarBanco()` rodou até o fim visível do log (migrações 05.38–05.49, correção de `compras_itens`).
- Os 10 testes 05.72 passaram usando `:memory:` para documentos da suíte.

O que o log **não** prova:

- Quantas linhas cada `UPDATE` alterou (`changes` não foi impresso).
- Se `migrarRecalcularSaldosEstoque` recalculou ou saiu cedo por flag já `'1'` (a primeira execução 05.72 **não** imprimiu claramente `Recálculo saldos estoque concluído`; execuções isoladas posteriores em Temp vazio imprimem `(0 produtos)`).
- Se `CREATE INDEX` / `ADD COLUMN` criaram objetos novos ou só tentaram o que já existia (`duplicate column name` = sem mudança; `Alteração aplicada` em índice = o statement foi aceito, não o delta de dados).
- Estado do cursor NSU, cooldown, estoque numérico, compras ou financeiro **depois** versus **antes**.

**Conclusão de impacto: indeterminado.** Não se declara dano. Não se declara ausência de dano. Restauração **não** foi tentada.

---

## 3. Arquivos inspecionados e alterados

### Inspecionados (auditoria)

| Arquivo | Papel no incidente |
|---|---|
| `tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js` | Suíte; na 1ª execução sem helper |
| `backend/motores/central-entradas/services/CentralSincronizacaoService.js` | Puxa DistDFe no topo |
| `backend/services/fiscal/distribuicaoDFe.js` | Puxa `DfeAuditoriaService` no topo |
| `backend/services/fiscal/DfeAuditoriaService.js` | `require('../../database')` eager |
| `backend/database.js` | Abre SQLite e `inicializarBanco()` na importação |
| `backend/motores/central-entradas/repositories/dbHelpers.js` | `resolverDb` lazy (não foi o gatilho) |
| `backend/services/fiscal/configService.js` | `useDb()` lazy |
| stdout da 1ª execução 05.72 / relatório P0.3 | Única evidência de runtime |

`database.js` de produção **não** foi modificado.

### Alterados nesta sprint

| Arquivo | Ação |
|---|---|
| `tests/central-entradas/helpers/isolarBancoTeste.js` | Guardião sqlite3 no **require** do helper; recusa o caminho oficial **antes** de `new Database`; mensagem explícita |
| `tests/central-entradas/helpers/preloadIsolamentoBanco.js` | **Novo.** `node -r` para scripts npm |
| `tests/central-entradas/helpers/classificarIsolamentoTestes.js` | **Novo.** Classificação estática (só lê fonte) |
| `tests/central-entradas/microsprint-p0-4-guardiao-banco-oficial.test.js` | **Novo.** Recusa do caminho oficial + 0 suítes bloqueadas |
| `tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js` | Ordem: helper **antes** de `CentralSincronizacaoService`; assert estático |
| 40 suítes da Central | `isolarBancoTeste()` inserido antes dos requires de risco |
| `package.json` | `-r preloadIsolamentoBanco.js` nas suítes executadas |

---

## 4. Blindagem reutilizável

1. **Require do helper** instala o wrap de `sqlite3.Database` / `verbose()` / `cached.Database`. Qualquer `new Database(caminhoOficial)` lança  
   `GUARDIÃO DE TESTE recusou abrir o banco oficial antes da conexão`  
   **antes** de chamar o construtor nativo.
2. **`isolarBancoTeste(prefixo)`** define `DB_DIR` em Temp se ainda não houver, recusa `DB_DIR` oficial, recusa `database.js` já aberto no oficial, e comprova `db.dbPath` real (não só a env).
3. **Preload** `node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js` para os scripts npm desta sprint.
4. Produção inalterada: o wrap só existe se o teste carregar o helper.

`:memory:` continua permitido.

---

## 5. Classificação das suítes (`tests/central-entradas/*.test.js`)

Classificador: `classificarIsolamentoTestes.js` — somente `require()` na fonte, sem executar testes.

Após a blindagem (96 arquivos):

| Classe | Qtde |
|---|---|
| **ISOLADA COMPROVADA** | 55 |
| **SEM ACESSO AO BANCO** | 41 |
| **BLOQUEADA ATÉ ISOLAMENTO** | **0** |
| **NÃO VERIFICADA** | **0** |

### ISOLADA COMPROVADA (helper / stub / `DB_DIR` Temp **antes** do require de risco)

Inclui, entre outras: 05.72, P0.2, P0.3, cursor 656, sprint2/4/5/7/8/10, rc1, rc2, 03-xml, 04-gate, 05-seguranca, 06-multicnpj, e as 40 suítes que receberam o helper nesta sprint (rc3, rc4, rc33, rc336, rc375, ownership 05.55/05.56, 05.70, 05.73, 05.74, 05.76, 05.78, 05.79, xml-multicnpj, etc.).

### SEM ACESSO AO BANCO

Máquina de estados, UX (sprint9, rc40, rc75, …), MIRX unitário, classificador DF-e, portal, health DTO, P0.4 guardião (não importa `database.js`). Algumas já tinham helper por precaução (rc3751/rc3752).

### Suítes **executadas** nesta sprint

Todas **ISOLADA COMPROVADA** ou **SEM ACESSO AO BANCO**. Nenhuma suíte bloqueada foi executada para “descobrir” se acessava o oficial.

---

## 6. Testes e comandos exatos

| Comando | Resultado | Banco comprovado |
|---|---|---|
| `npm run test:central-entradas-guardiao-banco` | **6 pass, 0 fail** | `database.js` **não carregado**; construtor recusou o path oficial |
| `npm run test:central-entradas-05-72` | **10/10** | `...\Temp\cds-preload-*\mercadao.db` |
| `npm run test:central-entradas-identidade-chave` | **15 pass** | Temp `cds-preload-*` |
| `npm run test:central-entradas-prep-chave` | **17 pass** | Temp; prep não abre `database.js` |
| `npm run test:central-entradas-cursor-656` | **15 pass** | Temp `cds-preload-*` |
| `npm run test:central-entradas` | **exit 0** | Temp `cds-preload-*` em sprint2/4/5/7/8/10, rc1, rc2; maquina-estados/sprint9 sem banco |

Nenhum teste desabilitado. Zero ocorrências de `ProgramData\MercantilFiscal` nas suítes reexecutadas.

Guardião: `new sqlite3.Database(C:\ProgramData\MercantilFiscal\dados\mercadao.db)` lança antes da conexão. `sqlite3.Database.__cdsIsolamentoCtor === true`.

---

## 7. Confirmações

| Item | Estado |
|---|---|
| Nova conexão de teste ao banco oficial | não ocorreu (guardião + Temp comprovado) |
| SEFAZ / `distNSU` / `consChNFe` reais | não |
| PFX de produção | não |
| Manifestação 210210 | não |
| NSU / cooldown de produção | não alterados por esta sprint |
| Restauração do oficial | não tentada |
| Git commit / push / merge | não |

---

## 8. Pendências que dependem de investigação adicional

1. **Impacto da 1ª execução 05.72 permanece indeterminado.** Qualquer conclusão de “alterou X linhas” exige leitura autorizada e controlada do oficial (fora desta sprint).
2. `database.js` continua abrindo SQLite e migrando **no import**. Testes isolados sobrevivem; um `require` esquecido sem helper ainda seria perigoso **se** o guardião sqlite3 não estiver instalado nesse processo.
3. Scripts npm da Central que **não** foram atualizados com `-r preload` (rc3, rc4, 03, 04, 05, …) agora têm helper no próprio arquivo, mas o preload nos scripts restantes é recomendável.
4. O rótulo `BANCO OFICIAL EM USO` em `database.js` continua enganoso quando `DB_DIR` é Temp — já documentado na P0.1; não alterado aqui de propósito.
5. Recuperação das NF-e de outubro **não** começa nesta etapa.

---

## Critérios de aceite

| Critério | Estado |
|---|---|
| 05.72 isola antes de carregar `database.js` | Atendido (helper + preload + assert de ordem) |
| Suítes executadas isoladas ou sem acesso a banco | Atendido |
| Guardião recusa o caminho oficial antes da conexão | Atendido |
| Regressões passam sem testes desabilitados | Atendido |
| Incidente documentado sem conclusão não comprovada | Atendido (**impacto indeterminado**) |
| Nenhuma operação fiscal real nem alteração nova do oficial | Atendido |

**Limite cumprido: auditar e prevenir. Não recuperar documentos. Não restaurar o banco oficial.**
