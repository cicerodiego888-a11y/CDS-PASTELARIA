# MCF-02.5 — Plano de proteção para migração controlada

**Escopo:** validação técnica e preparação de migração controlada em ambiente de **teste/desenvolvimento**.  
**Backfill operacional:** **NÃO AUTORIZADO** sem autorização expressa e específica do Tech Lead.

## Premissa do ambiente atual

O banco utilizado neste projeto é **exclusivamente de teste e desenvolvimento**.  
Não há dados reais de clientes a preservar ou restaurar.

Consequências para a validação MCF-02.5:

- A comprovação exigida é sobre **cópia isolada SQLite com dados de teste controlados**.
- Backup/restauração referem-se **somente** ao arquivo de ensaio (`*.backup.sqlite` da fixture).
- **Não** se exige comprovação de recuperação de dados reais, produção ou base de cliente para aprovar a validação técnica.

## 1. Parâmetros obrigatórios (anti-execução acidental)

Toda execução deve receber **explicitamente**:

| Parâmetro | Regra |
|-----------|--------|
| `empresaId` | Inteiro > 0; lote rejeitado se divergir |
| `loteId` | String do lote preparado; obrigatório em `executarLote` |
| `ambienteId` | Prefixo `MCF-02.4-ENSAIO-` ou `MCF-02.5-ENSAIO-` |
| `permitirEscritaIsolada` | Deve ser `true` literal |
| `caminhoDb` | Caminho da cópia isolada; recusa padrões `mercadao.db`, `producao`, `cliente`, etc. |

Configuração genérica ou implícita de “empresa ativa” **não** autoriza escrita.

## 2. Backup e validação (cópia isolada de teste)

1. Gerar backup file-level da cópia isolada **antes** de `prepararLote` (ex.: `*.backup.sqlite`).
2. Validar backup: abrir em SQLite, `SELECT COUNT(*)` em `contas_pagar`, `financeiro`, `contas_pagar_pagamentos` e comparar com a origem do ensaio.
3. Registrar caminhos/metadados em `AMBIENTE.json` / evidência do lote.
4. Só então capturar fingerprint e preparar lote.

## 3. Restauração da fixture de ensaio

Aplicável à **cópia isolada de teste**, não a produção/cliente:

1. Parar qualquer executor apontando para a cópia.
2. Substituir o arquivo SQLite pelo backup validado da fixture.
3. Reabrir DB e conferir contagens (+ fingerprint, se o backup for pré-lote).
4. Registrar na evidência do ensaio.

## 4. Critérios de abortar (lote)

Abortar imediatamente se:

- fingerprint instável na preparação;
- `empresaId` / `loteId` / `ambienteId` ausentes ou divergentes;
- item pendente some ou muda de ação no dry-run;
- ambiguidade na revalidação;
- tentativa de `DELETE` em financeiro sem marcador `[MCF_PROJECAO_SINTETICA]`;
- saldo ou pagamentos MCF alterados no `vincular`;
- violação UNIQUE em compat;
- caminho/ambiente operacional detectado.

## 5. Identidade sintética vs histórica

| Tipo | Identidade | Remoção |
|------|------------|---------|
| Projeção sintética MCF | `origem=mcf_compatibilidade` + `referencia_tipo=contas_pagar_mcf` + observacao contém `[MCF_PROJECAO_SINTETICA]` | Permitida **somente** se comprovada e ≠ financeiro legado |
| Histórico vinculado | observacao contém `[MCF_HISTORICO_VINCULADO]` (após UPDATE de identidade) | **Proibida** |
| Histórico elegível | origem ≠ projeção sintética | **Proibida** exclusão; só UPDATE de identidade de vínculo |

Caminho preferencial `criar_titulo`: `omitirProjecao=true` → sem DELETE intermediário.

## 6. Atomicidade

Em uma única `BEGIN IMMEDIATE` … `COMMIT` por item:

1. criar título (`omitirProjecao`) **ou** localizar título para vincular;
2. inserir compat;
3. atualizar identidade do legado;
4. gravar status `ok` do item + auditoria.

Falha em qualquer passo → `ROLLBACK` → item `erro` → lote `abortado`.

## 7. Interrupção / retomada / replay

- Interrupção controlada: status `interrupido`; pendentes permanecem.
- Retomada: processa só `pendente` do **mesmo** `loteId` + `empresaId`.
- Replay com item `ok` + mesmo `payload_hash`: no-op idempotente.
- Payload divergente: conflito e abort.

## 8. Evidências obrigatórias (antes / depois de cada lote)

**Antes**

- Relatório pré-migração (`gerarRelatorioPreMigracao`) com fingerprint
- Snapshot de indicadores (títulos, pagamentos, vínculos, legado)
- Abertura/consulta do DB de ensaio e do backup da fixture

**Depois**

- Snapshot comparativo (`compararSnapshots`) — pagamentos MCF inalterados
- Dry-run pós: `vincular=0` e `criar_titulo=0` no universo migrado
- Confirmação de ausência de órfãos após falha simulada
- Export de evidência (`EVIDENCIA-PRE-MIG.json`)

## 9. Reconciliação após falha (ensaio)

1. Não “compensar” com deletes em massa.
2. Se a TX fez rollback correto: corrigir causa, novo dry-run, **novo lote**.
3. Se a fixture ficou inconsistente: restaurar o `*.backup.sqlite` do ensaio.
4. Amostragem de vínculos e títulos criados nos dados de teste.

## 10. Autorização

Qualquer backfill fora de `MCF-02.*-ENSAIO-*` exige **autorização expressa e específica** do Tech Lead (empresa, lote, janela, responsável).
