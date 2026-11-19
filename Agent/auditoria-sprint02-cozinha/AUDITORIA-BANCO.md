# AUDITORIA — BANCO E INTEGRIDADE (Sprint 02)

**Fonte DDL:** `backend/utils/cozinhaSchema.js` (COZINHA_SCHEMA_VERSION = 2).  
**Atenção:** esta auditoria **não** executou migração no banco oficial. DDL abaixo é o contrato do código.

Cópias: `codigo/cozinhaSchema.js`.

---

## Tabelas usadas pelo despacho

| Tabela | Uso no despacho |
|---|---|
| `cozinha_unidades` | Unidade ativa + `sequencia_atual` (FIFO) |
| `cozinha_comandas` | Validação e FK dos itens |
| `cozinha_rodadas` | Uma por operação bem-sucedida |
| `cozinha_itens` | Itens da rodada |
| `cozinha_item_ingredientes` | Snapshots de personalização |
| `cozinha_pedido_item_controle` | Teto de despacho (millis) |
| `cozinha_autorizacoes_qty` | Soma ATIVA no teto (tabela lida; API de autorização fora da S02) |
| `cozinha_idempotencia` | Claim + resultado |
| `mesas` / `mesa_atendimentos` | ERP existente |
| `pedidos` / `pedidos_itens` / `pedido_item_ingredientes` / `produtos` | ERP existente |

---

## Controle de sequência

```sql
-- cozinha_unidades
sequencia_atual INTEGER NOT NULL DEFAULT 0 CHECK (sequencia_atual >= 0)
UNIQUE (id, empresa_id)
UNIQUE (empresa_id, codigo)
```

Rodada:

```sql
sequencia_global INTEGER NOT NULL CHECK (sequencia_global > 0)
UNIQUE (unidade_id, sequencia_global)  -- ux_cozinha_rodadas_unidade_sequencia
UNIQUE (atendimento_id, numero_rodada)
UNIQUE (idempotency_key_despacho) WHERE NOT NULL
FK (unidade_id, empresa_id) → cozinha_unidades(id, empresa_id)
```

---

## Relação rodada ↔ comanda ↔ item

```
cozinha_rodadas (1) ──< cozinha_itens (N)
                           ├─ comanda_id → cozinha_comandas (FK composta empresa)
                           ├─ rodada_id  → cozinha_rodadas
                           └─ unidade_id → cozinha_unidades
cozinha_itens (1) ──< cozinha_item_ingredientes (N)
```

Regra de negócio: N comandas podem aparecer na mesma rodada; cada **item** guarda seu próprio `comanda_id`.

---

## Campos de quantidade (INTEGER millis)

| Tabela | Campos |
|---|---|
| `cozinha_itens` | `qty_solicitada_millis`, `qty_preparada_millis`, `qty_cancelada_millis` (+ CHECK soma ≤ solicitada) |
| `cozinha_pedido_item_controle` | `qty_referencia_despacho_millis`, `qty_referencia_inicial_millis` |
| `cozinha_autorizacoes_qty` | `qty_autorizada_millis` |
| `cozinha_item_ingredientes` | `quantidade_snapshot_millis`, `preco_adicional_snapshot_millis` |

ERP `pedidos_itens.quantidade` e `pedido_item_ingredientes.quantidade_snapshot` permanecem REAL no schema legado; a Cozinha converte na borda via `cozinhaQuantidade.js`.

---

## Idempotência central

```sql
CREATE TABLE cozinha_idempotencia (
  idempotency_key TEXT NOT NULL,           -- UNIQUE global
  tipo_operacao TEXT NOT NULL CHECK (... DESPACHO_LOTE ...),
  contexto TEXT,
  payload_hash TEXT NOT NULL,
  situacao TEXT CHECK (EM_ANDAMENTO|CONCLUIDA|FALHA_VALIDACAO),
  resultado_http_status INTEGER,
  resultado_json TEXT,
  recurso_tipo TEXT,
  recurso_id INTEGER,
  ...
);
```

Não há `empresa_id` na tabela; isolamento semântico via hash/`contexto` JSON.

---

## Índices / FKs relevantes ao despacho

- `ux_cozinha_unidades_id_empresa`
- `ux_cozinha_comandas_id_empresa` + `ux_cozinha_comandas_atendimento_numero`
- `ux_cozinha_rodadas_unidade_sequencia`
- `ux_cozinha_rodadas_atendimento_numero`
- `ux_cozinha_rodadas_idempotency`
- `ux_cozinha_itens_id_empresa` + FKs compostas rodada/comanda/unidade
- `ux_cozinha_pedido_item_controle_item` (UNIQUE `pedido_item_id`)
- `ux_cozinha_idempotencia_key`

---

## Divergências schema ↔ serviço (observadas)

1. Situação `FALHA_VALIDACAO` existe no CHECK da tabela, mas o serviço **não** grava esse estado — falhas fazem ROLLBACK do claim.
2. `mesas.ativo` lido no SELECT do serviço, não usado na regra.
3. Autorizações/reduções: schema pronto; sem endpoint Sprint 02.
4. `cozinha_item_ingredientes` sem `empresa_id` (isolamento via item) — alinhado ao schema.
5. Hash calculado fora da TX (vide auditoria de transação).

DDL integral: ver arquivo copiado `codigo/cozinhaSchema.js` (funções `criarTabelasCozinha`).
