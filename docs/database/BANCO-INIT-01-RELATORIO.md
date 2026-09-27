# SPRINT BANCO-INIT-01 — Correção da inicialização de banco vazio

Data: 27/09/2026

## Status

**CONCLUÍDO.** Uma instalação nova (sem arquivo de banco, arquivo vazio ou parcialmente criado) agora inicializa por completo. A reinicialização de um banco existente não altera nenhum dado. Todos os testes rodaram em pastas temporárias (`DB_DIR`); o banco oficial não foi aberto.

## Causa raiz

`backend/database.js` inicializa o banco por dois caminhos:

1. `inicializarBanco()`, chamado no callback de abertura da conexão. Ele roda `criarTabelas()`, que cria `configuracoes` **por último** ("criar por último").
2. Um bloco `db.serialize(() => { ... })` no **nível do módulo** (tabelas de caixa, equipamentos, auditoria, pedidos e NF-e). Esse bloco é enfileirado assim que o arquivo é carregado e executa **antes** de `criarTabelas()`.

Esse segundo bloco grava em `configuracoes` com dois `INSERT OR IGNORE` sem callback (`equipamentos_ativo` e `produto_identidade_enabled`). Num banco sem a tabela, o sqlite3 emite um evento `error` sem tratamento no `Statement`, e o Node **encerra o processo** com `SQLITE_ERROR: no such table: configuracoes`. Em banco existente isso nunca aparecia porque a tabela já existia.

Nenhum outro acesso a `configuracoes` ocorre antes da criação. Todos os demais (`aplicarAlteracoesPosCriacao`, `inserirConfiguracoesPadrao`, `migrarUrlsFiscalProducao`, `recuperarItemFiscalComprasItens`, `migrarRecalcularSaldosEstoque`) estão em `inicializarBanco()`, depois de `criarTabelas()`, no mesmo `serialize`.

### Segundo defeito encontrado pelo teste de idempotência

A semeadura de `configuracoes_validade` usava `INSERT OR IGNORE`, mas a tabela não tem restrição `UNIQUE`: o `OR IGNORE` nunca ignorava nada, e **cada abertura do sistema gravava mais uma linha padrão**. O `lotesService` só usa a primeira linha (`SELECT ... LIMIT 1` / `UPDATE ... WHERE id = 1`), então as cópias extras não tinham efeito funcional, mas a inicialização não era idempotente.

## Correção (somente inicialização)

Arquivo alterado: `backend/database.js`.

1. O SQL de criação de `configuracoes` virou uma constante única (`SQL_CRIAR_TABELA_CONFIGURACOES`), **com o mesmo schema de antes** (`CREATE TABLE IF NOT EXISTS`).
2. Essa constante roda no **início** do bloco `serialize` do nível do módulo, antes dos `INSERT`s, e continua sendo usada no mesmo ponto de `criarTabelas()`.
3. A linha padrão de `configuracoes_validade` só é inserida quando a tabela está vazia (`INSERT ... SELECT 30, 0, 1 WHERE NOT EXISTS (SELECT 1 FROM configuracoes_validade)`). Os valores padrão são os mesmos.

Não houve `DROP`, `DELETE`, recriação de tabela nem reset. Linhas duplicadas de `configuracoes_validade` que já existam em bancos de clientes **não** são apagadas (restrição da sprint); apenas deixam de ser criadas novas.

Outros arquivos:

- `tests/database/banco-init-01.test.js` (novo)
- `package.json` (script `test:banco-init-01`)

Não foram alterados: Central, Fiscal, MIIP, MUC, Estoque, Financeiro, PDV, TEF, MBC ou qualquer regra de negócio.

## Ordem de inicialização

**Antes (banco vazio):**

1. Carregar módulo → enfileira o bloco `serialize` do módulo: cria `caixas`… `equipamentos_mgv6_exports`, seeds de drivers → `INSERT INTO configuracoes` → **tabela inexistente → processo encerrado**.
2. (não chegava a rodar) `inicializarBanco()` → `criarTabelas()` → … → `CREATE TABLE configuracoes` → migrações → seeds.

**Depois:**

1. Carregar módulo → bloco `serialize` do módulo: **`CREATE TABLE IF NOT EXISTS configuracoes`** → tabelas de caixa/equipamentos/pedidos/NF-e → `INSERT OR IGNORE INTO configuracoes` (ok).
2. `inicializarBanco()` → `criarTabelas()` (o `CREATE` de `configuracoes` é no-op) → `criarTabelasMiip()` → `aplicarAlteracoesPosCriacao()` → migrações empresa_id → `inserirConfiguracoesPadrao()` → `migrarUrlsFiscalProducao()` → seeds (TEF catálogo, admin, categorias) → recuperações de compras_itens.
3. Os dois ramos sinalizam prontidão (`whenReady`) como antes.

Em banco existente, a ordem efetiva é a mesma de antes: o `CREATE TABLE IF NOT EXISTS` adicional não faz nada.

## Testes executados

### TESTES AUTOMATIZADOS — `npm run test:banco-init-01` — 6/6

Cada cenário carrega o `database.js` real num processo filho com `DB_DIR` temporário, espera `whenReady` + 4 s (migrações assíncronas) e fecha a conexão.

| Cenário | Verificação | Antes da correção | Depois |
|---|---|---|---|
| Banco inexistente | cria pasta, arquivo, tabelas-chave (`configuracoes`, `usuarios`, `empresas`, `central_entradas_config`, `caixas`, `equipamentos_drivers`, `pedidos`, `nfe_notas`), seeds de configuração e admin inicial | FALHA (processo encerrado) | OK |
| Banco SQLite vazio (0 bytes) | idem | FALHA | OK |
| Parcial sem `configuracoes` (com `caixas` e driver editado pelo cliente) | estrutura completa; linha de caixa e driver editado preservados | FALHA | OK |
| Parcial só com `configuracoes` (valores do cliente) | `nome_empresa`, `equipamentos_ativo`, `fiscal_ambiente` do cliente preservados | OK | OK |
| Banco existente | dump completo de **todas** as tabelas idêntico antes/depois da reinicialização (empresas, configurações alteradas, chave própria, `central_entradas_config`, caixa, 2 linhas de validade) | FALHA (processo encerrado) | OK |
| 2ª e 3ª inicialização | `sqlite_master` e dump completo idênticos; sem configuração duplicada; 1 SUPER_ADMIN; 1 linha de validade | FALHA; depois da 1ª correção falhou por `configuracoes_validade: 1 → 2 linhas` | OK |

### BANCO VAZIO

- Primeira inicialização em pasta nova: processo termina com sucesso e sinaliza prontidão.
- Log da 1ª inicialização: restam 7 linhas `Erro ao adicionar coluna tef_*: duplicate column name`. São **cosméticas e pré-existentes**: o `PRAGMA table_info(venda_pagamentos)` roda antes do `CREATE TABLE venda_pagamentos`, que já inclui essas colunas; as colunas ficam corretas. Não foi alterado por ser código de pagamento/TEF (fora do escopo).
- Segunda inicialização: nenhuma linha de erro.

### BANCO EXISTENTE

- Reinicialização não altera nenhuma linha de nenhuma tabela (comparação por dump integral).
- Empresas, configurações do cliente, `central_entradas_config`, usuários e caixa permanecem iguais.
- Linhas antigas duplicadas de `configuracoes_validade` permanecem; a linha 1 (usada pelo sistema) mantém o valor do cliente.

### REGRESSÃO

Executada em banco temporário **novo e sem pré-criação** (o cenário que antes quebrava): 90 suítes.

- **Central de Entradas (78):** 49 passam. As mesmas 29 falhas pré-existentes já registradas no CENTRAL-ENTRADAS-03 continuam, com a **mesma quantidade de falhas dentro de cada suíte** que a execução de referência com o `database.js` original (0 de 29 com diferença).
- **Outros módulos que carregam `database.js` (12):** compras 05-38-F-B, caixa 05-38-C, MUV 04-11 e 04-02, modo operacional 05-38-B, pastelaria 03-06-1, central 05-38-E, financeiro 05-38-D, MCF-01, bancário 15-1, configurações sprint39 — **passam**. `faturamento/sprint313-central-vendas-faturadas` falha (2 ok, 8 falhas, "Módulo Expedição desabilitado"), **idêntico** com o `database.js` original → pré-existente, não relacionada (o banco novo vem com o módulo Expedição desabilitado).
- Nenhum log da regressão contém `no such table: configuracoes`.

## Confirmação sobre dados existentes

- A correção só acrescenta um `CREATE TABLE IF NOT EXISTS` (no-op em banco existente) e restringe um seed a "tabela vazia".
- Nenhum `UPDATE`, `DELETE`, `DROP` ou `ALTER` novo foi introduzido.
- O teste "banco existente" comprova que um dump integral de todas as tabelas é idêntico antes e depois da reinicialização.
- O banco oficial (`C:\ProgramData\MercantilFiscal\dados\mercadao.db`) não foi aberto nesta sprint: todos os processos rodaram com `DB_DIR` temporário.

## Observações / próximos passos

- Bancos de clientes podem ter linhas duplicadas em `configuracoes_validade` (uma por abertura do sistema). São inofensivas; uma limpeza exigiria uma migração de dados própria, que está fora desta sprint.
- Os avisos `duplicate column tef_*` na primeira instalação podem ser eliminados com a mesma técnica (verificar a tabela depois do `CREATE`), em sprint que permita tocar nesse trecho.
- As suítes antigas da Central continuam sem definir `DB_DIR` e, sem ele, abrem o banco oficial.
