# AUDITORIA — TRANSAÇÃO E FIFO (Sprint 02)

Arquivo: `backend/services/cozinha/CozinhaDespachoService.js`

---

## Mapa do fluxo transacional

| Etapa | Linhas (aprox.) | SQL / ação |
|---|---|---|
| Hash SHA-256 | 222–234 | **Fora** da TX (desvio vs. checklist literal) |
| `BEGIN IMMEDIATE` | 237 → `beginImmediate` 57–58 | `BEGIN IMMEDIATE` |
| `PRAGMA foreign_keys = ON` | 239 | |
| Consulta idempotency_key | 242–244 | `SELECT * FROM cozinha_idempotencia WHERE idempotency_key=?` |
| Replay / conflitos | 246–272 | commit antecipado no replay |
| INSERT `EM_ANDAMENTO` | 282–287 | claim |
| Validações de negócio | 311–500 | leituras + possível INSERT controle qty |
| Incremento FIFO | 503–515 | `UPDATE cozinha_unidades SET sequencia_atual = sequencia_atual + 1` |
| Criação da rodada | 524–538 | `INSERT INTO cozinha_rodadas` |
| Criação dos itens | 540–594 | `INSERT INTO cozinha_itens` (+ ingredientes) |
| Marca `CONCLUIDA` | 599–608 | `UPDATE cozinha_idempotencia … situacao='CONCLUIDA'` |
| `COMMIT` | 610 | |
| `ROLLBACK` | 612–614 → `rollback` 65–68 | em qualquer throw do `try` |

---

## FIFO — detalhes

```503:515:backend/services/cozinha/CozinhaDespachoService.js
    const seqUp = await run(db, `
      UPDATE cozinha_unidades
      SET sequencia_atual = sequencia_atual + 1,
          updated_at = datetime('now')
      WHERE id = ? AND empresa_id = ?
    `, [unidadeId, empresaId]);
    ...
    const sequenciaGlobal = Number(unidadeAtual.sequencia_atual);
```

- A atribuição ocorre **depois** de todas as validações de itens e **antes** do INSERT da rodada.
- Schema: `UNIQUE (unidade_id, sequencia_global)` em `cozinha_rodadas`.
- `BEGIN IMMEDIATE` obtém lock de escrita SQLite → dois writers na mesma DB serializam.

### Concorrência (duas requisições)

1. **Chaves diferentes, mesma unidade** — suite teste 7 + reprodução R1: sequências distintas `{1,2}`; `sequencia_atual=2`.
2. **Mesma chave** — reprodução R2: 1 rodada, `sequencia_atual=1`, ambos callers fulfilled (criação + replay do `resultado_json`). Race de INSERT UNIQUE cai no ramo `IDEMPOTENCY_CONCORRENTE` ou no replay pós-commit (L288–306).

---

## Falha após incremento FIFO

No caminho feliz de negócio, falhas de validação ocorrem **antes** do UPDATE da sequência. Portanto o suite oficial não exercita falha pós-FIFO por regra de domínio.

**Reprodução isolada R4** (trigger `AFTER UPDATE OF sequencia_atual`):

- Erro: `AUDIT_FORCE_FAIL_AFTER_FIFO`
- Após rollback: `sequencia_atual=0`, 0 rodadas, 0 itens, sem linha em `cozinha_idempotencia`

Conclusão: o `ROLLBACK` desfaz o incremento FIFO.

---

## Falha após criação parcial de itens

**Reprodução R5** (trigger no 2º `INSERT` de `cozinha_itens`):

- Após rollback: 0 rodadas, 0 itens, `sequencia_atual=0`

A rodada e o 1º item inseridos na mesma TX são desfeitos junto com o FIFO e o claim de idempotência.

---

## Ordem vs. especificação do adendo

Checklist exigia: BEGIN → normalizar → hash → consultar chave.

Implementação real: normalizar + hash → BEGIN → consultar chave.

A consulta da chave (ponto crítico para replay correto mesmo com pedido alterado) está corretamente **dentro** da TX e **antes** das validações de negócio.
