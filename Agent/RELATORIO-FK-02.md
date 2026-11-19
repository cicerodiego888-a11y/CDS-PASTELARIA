# RELATÓRIO — FK-02  
## Isolamento da validação de integridade do domínio Cozinha

**Data:** 2026-11-17  
**Escopo:** somente validação FK da migração Cozinha v2→v3  
**Status:** ENTREGUE PARA AUDITORIA DO TECH LEAD  

---

## 1. Arquivos criados e alterados

| Arquivo | Ação |
|---------|------|
| `backend/utils/cozinhaSchema.js` | Alterado — FK check por tabela do domínio |
| `tests/cozinha/fk02-isolamento-fk-check-cozinha.test.js` | Criado — cenários A–E |
| `Agent/RELATORIO-FK-02.md` | Criado — este relatório |
| `Agent/LOG-FK-02.txt` | Criado — log dos testes |

### Não alterados (confirmado)

- Sprint 06 (worker/fila/Electron impressão)
- PDV
- S07-0 (`CozinhaKdsPainelService`, rota painel)
- S07-1 (`cozinha-kds.js` / CSS) — sem mudança nesta entrega FK-02
- Login / autenticação
- Banco oficial (não aberto)

---

## 2. Diff da implementação

### Lista controlada

```javascript
const TABELAS_COZINHA_FK_CHECK = TABELAS_COZINHA;
// = cozinha_item_ingredientes, cozinha_bebida_entregas, cozinha_impressao_fila,
//   cozinha_notificacoes, cozinha_eventos_outbox, cozinha_itens, cozinha_rodadas,
//   cozinha_estacoes_impressao, cozinha_comandas, cozinha_autorizacoes_qty,
//   cozinha_reducoes_teto, cozinha_pedido_item_controle, cozinha_idempotencia,
//   cozinha_unidades
```

Revisão prévia do schema real: FKs declaradas são **entre** tabelas Cozinha (compostas `id, empresa_id`). Não há FKs Cozinha→`produtos`/`empresas` no DDL atual; o check por tabela ainda cobre **qualquer** FK declarada na tabela filha (cenário D prova detecção Cozinha→ERP quando a FK existe).

### Antes

```javascript
async function pragmaForeignKeyCheckOk(db) {
  const rows = await dbAll(db, `PRAGMA foreign_key_check`); // banco inteiro
  ...
}
```

### Depois

```javascript
function exigirTabelaCozinhaFkCheck(nome) { /* whitelist + regex */ }

async function verificarForeignKeysDominioCozinha(db) {
  const violacoes = [];
  for (const tabelaBruta of TABELAS_COZINHA_FK_CHECK) {
    const tabela = exigirTabelaCozinhaFkCheck(tabelaBruta);
    // existe? → PRAGMA foreign_key_check(tabela)
    ...
  }
  return violacoes;
}

async function pragmaForeignKeyCheckOk(db) {
  const rows = await verificarForeignKeysDominioCozinha(db);
  if (rows.length > 0) {
    throw erro COZINHA_FK_CHECK_FALHOU; // mensagem: domínio Cozinha
  }
}
```

- Identificadores **somente** da lista interna (anti-injeção).
- `PRAGMA foreign_keys` **não** desabilitado como “solução”.
- Gate operacional / meta v3 **após** validação intactos.
- Órfãos ERP **não** são apagados nem “corrigidos”.

---

## 3. Testes e resultados

### Ambiente

```
CDS_BLOQUEAR_BANCO_OFICIAL=1
CDS_TEST_ISOLATION=1
CDS_FORCAR_LOCAL=1
DB_DIR = %TEMP%\cds-cozinha-fk02-*
```

### FK-02 (`tests/cozinha/fk02-isolamento-fk-check-cozinha.test.js`)

| Testes | PASS | FAIL | SKIP |
|-------:|-----:|-----:|-----:|
| 7 | 7 | 0 | 0 |

### Regressão S04A (`sprint04a-upgrade-schema-v2-v3.test.js`)

| Testes | PASS | FAIL |
|-------:|-----:|-----:|
| 15 | 15 | 0 |

Log: `Agent/LOG-FK-02.txt`

---

## 4. Evidências dos cinco cenários

| Cenário | Resultado |
|---------|-----------|
| **A** legado ERP | Órfãos `produto_unidades`/`produtos_ajustes_estoque` permanecem; check global ainda falha; migração v2→v3 **conclui**; registros legado **intactos** |
| **B** Cozinha válida | Domínio populado; `verificarForeignKeysDominioCozinha` = 0; migra para v3 |
| **C** violação interna | `cozinha_itens` → rodada inexistente; `COZINHA_FK_CHECK_FALHOU`; meta **permanece 2** |
| **D** ref. externa | `cozinha_unidades.empresa_id` → `empresas` órfão; detectado; migração **bloqueada**; meta **2** |
| **E** regressão | Gate operacional + ensure; lista FK estável; S04A 15/15 |

---

## 5. Isolamento de bancos

- Testes usam `fs.mkdtempSync(...cds-cozinha-fk02-)` + `CDS_BLOQUEAR_BANCO_OFICIAL=1`.
- Sem `CDS_ALLOW_OFFICIAL_DB`.
- **Não** foi executada migração no `ProgramData\MercantilFiscal\dados\mercadao.db`.
- **Não** foi reiniciado o ambiente oficial para homologação.

---

## 6. Critérios de aprovação

| Critério | Status |
|----------|--------|
| 1. Legado ERP não bloqueia Cozinha indevidamente | OK (A) |
| 2. Violações Cozinha continuam bloqueando | OK (C) |
| 3. Refs Cozinha→ERP protegidas quando declaradas | OK (D) |
| 4. Meta v3 só após validação OK | OK (A/B vs C/D) |
| 5. Registros de negócio intactos | OK (A snapshots) |
| 6. Testes em banco temporário | OK |

---

## 7. Observações para o TL

1. Esta entrega **desbloqueia a lógica** da migração em bancos com órfãos ERP; **não** aplica a migração no oficial.
2. Homologação no oficial exige **nova autorização** (reinício/ensure no ProgramData).
3. Após ensure bem-sucedido no oficial, o KDS deixa de receber 503 por `COZINHA_NAO_OPERACIONAL` **desde que** a boot conclua `operacional: true`.
4. Dívida FK-01 (2.082 órfãos ERP) permanece — fora do escopo FK-02.

---

## Veredito

**FK-02 implementada e testada. Parar. Aguardar auditoria do Tech Lead.**  
Não iniciar S07-2. Não migrar o banco oficial sem nova autorização.
