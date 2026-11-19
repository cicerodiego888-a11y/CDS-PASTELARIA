# RELATÓRIO — DIAGNÓSTICO FK-01  
## Integridade do schema Cozinha / 2.082 violações de FK

**Data:** 2026-11-17  
**Etapa:** Diagnóstico somente leitura (sem remediação)  
**Autorização:** cópia consistente em diretório temporário  

---

## 1. Banco de origem identificado

| Item | Valor |
|------|--------|
| **Caminho** | `C:\ProgramData\MercantilFiscal\dados\mercadao.db` |
| Tamanho (origem) | 29.904.896 bytes |
| mtime observado | 2026-11-17 (durante diagnóstico) |
| **Classificação** | **BANCO OFICIAL (ProgramData)** |

### Configuração que seleciona esse banco

1. `npm start` → Electron (`package.json`: `electron.cmd .`).
2. `electron.js` define `process.env.DB_DIR` para  
   `ProgramData\MercantilFiscal\dados` (padrão, sem `--cds-forcar-local`).
3. `backend/database.js` chama `exigirAberturaDatabaseModule()`  
   (`backend/lib/sqliteOfficialGuard.js`): fora de contexto de teste, usa `DB_DIR` ou o diretório oficial ProgramData e abre `mercadao.db`.

**Fato:** o processo que apresentou o 503 do KDS estava no banco oficial, não em Temp/teste.

---

## 2. Cópia temporária

| Item | Valor |
|------|--------|
| Diretório | `%TEMP%\cds-cozinha-fk-diagnostico`  
| | (`C:\Users\cicer\AppData\Local\Temp\cds-cozinha-fk-diagnostico`) |
| Arquivo | `mercadao-copia-diagnostico.db` |
| Método | API Backup SQLite (`node-sqlite3` `backup` + `step(-1)`), origem `OPEN_READONLY` |
| Tamanho cópia | 29.904.896 bytes (igual à origem) |

O banco de origem **não** recebeu UPDATE/DELETE/INSERT/migração nesta etapa.  
Dados brutos: `Agent/DIAGNOSTICO-FK-01-DADOS.json`.

---

## 3. Estado do schema Cozinha (na cópia)

| Item | Valor |
|------|--------|
| `cozinha_schema_meta.schema_version` | **`2`** |
| Versão alvo no código | **3** (`COZINHA_SCHEMA_VERSION`) |
| Tabelas `cozinha_*` presentes | 15 (inclui impressão S06: estações/fila) |
| Linhas em tabelas Cozinha | **todas 0**, exceto `cozinha_schema_meta` = 1 |
| Violações FK em `cozinha_*` | **0** |

**Fato:** o domínio Cozinha está vazio e meta ainda em **v2**. A migração v2→v3 **não concluiu** no oficial.

---

## 4. Total de violações

| Escopo | Quantidade |
|--------|-----------:|
| `PRAGMA foreign_key_check` (cópia atual) | **2082** |
| Em tabelas `cozinha_*` | **0** |
| Em outras tabelas do ERP | **2082** |

O número **bate exatamente** com a mensagem do runtime:  
`[COZINHA] foreign_key_check encontrou 2082 violação(ões).`

---

## 5. Quantidade por tabela (filha → pai)

| # | Tabela filha | Violações | Tabela pai |
|--:|--------------|----------:|------------|
| 1 | `produto_unidades` | 712 | `produtos` |
| 2 | `produtos_ajustes_estoque` | 702 | `produtos` |
| 3 | `produto_identificadores` | 217 | `produtos` |
| 4 | `produtos_preco_historico` | 159 | `produtos` |
| 5 | `miip_decisoes` | 90 | `produtos` |
| 6 | `estoque_movimentos` | 55 | `produtos` |
| 7 | `produto_embalagens` | 43 | `produtos` |
| 8 | `vendas_itens` | 24 | `produtos` |
| 9 | `tipo_comercial_canais` | 16 | `canais_venda` |
| 10 | `auditoria` | 15 | `usuarios` |
| 11 | `producoes_itens` | 10 | `produtos` |
| 12 | `produto_imagens` | 9 | `produtos` |
| 13 | `consignacoes_itens` | 7 | `produtos` |
| 14 | `fichas_tecnicas_itens` | 6 | `produtos` |
| 15 | `producoes` | 5 | `produtos` |
| 16 | `fichas_tecnicas` | 3 | `produtos` |
| 17 | `produto_atacado` | 2 | `produtos` |
| 18 | `compras_itens` | 2 | `produtos` |
| 19 | `miip_associacoes` | 2 | `produtos` |
| 20 | `estoque_movimentacoes` | 2 | `produtos` |
| 21 | `configuracao_comercial` | 1 | `canais_venda` |
| | **Total** | **2082** | |

---

## 6. Relações afetadas (amostra de FKs)

Exemplo declarado em `produto_unidades`:

- `produto_unidades.produto_id` → `produtos.id` (`ON DELETE CASCADE`, `fkid=0`)

Padrão dominante: **filhos de `produtos` com `produto_id` órfão**.

Minorias:

- `tipo_comercial_canais.canal_venda_id` → `canais_venda`
- `configuracao_comercial` → `canais_venda`
- `auditoria.usuario_id` → `usuarios`

---

## 7. Amostra de registros órfãos (cópia)

### Contexto de `produtos` (fato)

- `COUNT(*)` produtos = **22**
- IDs existentes: **747 … 783**
- Não há produtos com id 1, 2, 3, … (faixa legada ausente)

### `produto_unidades` (712 órfãos)

Exemplo `rowid=1`:

| Campo | Valor |
|-------|--------|
| id | 1 |
| produto_id | **1** (não existe em `produtos`) |
| unidade | UN |
| created_at | 2026-09-05 02:09:29 |

`produto_id` órfãos amostrados: 1–15 (e demais até completar 712).

### `vendas_itens`

Exemplo: `produto_id=553` — fora da faixa atual 747–783 → órfão.

### `auditoria`

Exemplo: `usuario_id=2` / usuário de teste `rc4320_…` — pai `usuarios` ausente.

### `tipo_comercial_canais`

Exemplo: `canal_venda_id=1` — pai `canais_venda` ausente (nessa cópia).

### Cozinha

Nenhuma linha órfã em `cozinha_*` (tabelas vazias).

---

## 8. Correlação com migrações Cozinha / Sprints

### Fatos

1. Meta Cozinha = **v2**; código exige **v3**.
2. Em `cozinhaSchema.js`, a migração **v2→v3** chama  
   `pragmaForeignKeyCheckOk(db)` → `PRAGMA foreign_key_check` **no banco inteiro** (não só `cozinha_*`), **antes** de gravar meta v3 (`~L474–477`).
3. Com 2082 violações legadas de ERP, essa checagem **falha**, `marcarCozinhaOperacional(false)`, e o gate HTTP devolve 503 `COZINHA_NAO_OPERACIONAL`.
4. Tabelas Cozinha (S01–S06) **existem**, mas **sem dados** e **sem violações próprias**.
5. Backups históricos (cópia → Temp), mesma contagem:

| Backup | Data | Violações | Em `cozinha_*` |
|--------|------|----------:|---------------:|
| `backup_pdv_2026-11-15_11-35-47.db` | 15/11/2026 | 2082 | 0 |
| `backup_pdv_2026-11-16_07-31-15.db` | 16/11/2026 | 2082 | 0 |
| Cópia do oficial atual | 17/11/2026 | 2082 | 0 |

### Hipóteses (não comprovadas como causa única)

| Hipótese | Base | Status |
|----------|------|--------|
| Violações **já existiam antes da Sprint 06** | Mesmo total 2082 em 15/11 e 16/11 | **Fortemente suportada** (fato numérico idêntico) |
| S06/S07 **criaram** as 2082 FKs | Contagem estável + zero FKs em `cozinha_*` | **Não suportada** |
| Origem: exclusão/troca de cadastro de `produtos` sem limpar filhos | IDs filhos baixos vs produtos só 747–783 | **Hipótese plausível** (padrão clássico de órfãos) |
| Bloqueio do KDS = efeito colateral da checagem **global** na migração Cozinha v2→v3 | Código + meta ainda v2 + log 2082 | **Fato mecanicista** |

---

## 9. Classificação das violações

| Classe | Descrição | Qtd |
|--------|-----------|----:|
| A — Órfãos `* → produtos` | Filhos com `produto_id` inexistente | ~2050 |
| B — Órfãos → `canais_venda` | `tipo_comercial_canais`, `configuracao_comercial` | 17 |
| C — Órfãos → `usuarios` | `auditoria` | 15 |
| D — Domínio Cozinha | Tabelas `cozinha_*` | **0** |

---

## 10. Recomendação de remediação (**não executar agora**)

Ordem sugerida para autorização futura do Tech Lead:

1. **Separar problemas:**  
   - Integridade legada ERP (`produtos` / canais / usuários) ≠ integridade do domínio Cozinha (hoje limpa e vazia).

2. **Destravar Cozinha (opções a decidir pelo TL):**  
   - **A)** Restringir o `foreign_key_check` da migração v2→v3 às tabelas `cozinha_*` (ou após smoke só do domínio), **ou**  
   - **B)** Remediação controlada dos órfãos ERP (política por tabela: apagar filho órfão vs recriar pai), **ou**  
   - **C)** Ambos (A para destravar operação Cozinha; B como dívida de dados).

3. **Não** desabilitar `PRAGMA foreign_keys` em produção como “solução”.

4. Após Cozinha `operacional: true` e meta v3: validar `GET /api/cozinha/status` e o Painel KDS.

5. UX opcional S07-1: backoff no poll quando `COZINHA_NAO_OPERACIONAL`.

---

## 11. Restrições respeitadas

- Sem correção/exclusão/UPDATE/INSERT no oficial  
- Sem migração / alteração de schema / FK  
- Sem mudança S07-0, S07-1, S06, PDV  
- Sem impressão / fiscal  
- Sem novo boot do sistema para investigar (apenas backup RO + análise na cópia)

---

## Veredito

As **2.082** violações são **órfãos legados do ERP** (quase todas → `produtos`), **já presentes em 15–16/11/2026**, **zero em Cozinha**.  
Elas **bloqueiam** a migração Cozinha **v2→v3** porque o check FK é **global**, mantendo o módulo não operacional e o KDS em HTTP 503.

**PARAR. Não implementar correções sem nova autorização do Tech Lead.**
