# Relatório — Implementação 03.9
## Lotes → contexto / porta existente

**Data:** 2026-08-21 · **Status:** concluída — **sem migração** (critério de parada)

---

## 1. Escritor encontrado

`backend/services/lotesService.js`

Métodos vivos: rastreio em `produtos_lotes` / `venda_lotes`.

Único `UPDATE produtos`: `atualizarEstoqueConsolidado` (`estoque_atual = somaLotes`).
**Sem caller** no backend. Não toca SF/SNF/reservado.

---

## 2. SQL anterior

Vivos: nenhum SQL de saldo/reserva em `produtos`.

Latente (não chamado):

```sql
UPDATE produtos SET estoque_atual = ? WHERE id = ?
```

---

## 3. Porta utilizada

Nenhuma. A porta pública **não** tem SET absoluto de `estoque_atual`
independente de F/NF. Migrar inventaria distribuição.

---

## 4. empresaId / COMPAT

Não criados. `COMPAT_LOTES_PRE_MULTIEMPRESA` não foi necessário.

---

## 5. db / transação

`lotesService` usa `db` global. Sem BEGIN próprio. Sem mudança.

---

## 6. Testes executados

`node tests/estoque/lotes-porta-publica.test.js`

| # | Cenário |
|---|---|
| 01 | Métodos vivos só rastreiam lotes |
| 02 | Consolidado não é escritor operacional da porta (sem callers) |
| 03 | Não inventou porta / COMPAT / estoque_empresa |
| 04 | Fluxos 03.8 / 03.7 / 03.6 / 03.5 / motores intactos |

### Regressão

| Suite | Resultado |
|---|---|
| `lotes-porta-publica.test.js` | **4/4 OK** (auditoria — sem migração) |
| `create-produto-saldo-inicial-porta-publica.test.js` | **10/10 OK** |
| `reserva-repair-porta-publica.test.js` | **10/10 OK** |
| `consumo-reserva-pedido-porta-publica.test.js` | **10/10 OK** |
| `revert-devolucao-venda-porta-publica.test.js` | **10/10 OK** |
| `mts-v1.test.js` | **9/9 OK** (homologado) |
| `muc-public-contract.test.js` | **20/20 OK** |

---

## 7. Arquivos alterados

Nenhum arquivo de produção.

**Criados**

- `tests/estoque/lotes-porta-publica.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_9_LOTES.md`
- `docs/arquitetura/IMPLEMENTACAO_03_9_RELATORIO.md` (este)

---

## 8. Escritores fora do escopo (só documentados)

Compras, vendas, ajuste, CREATE 03.8, Repair 03.7, consumo 03.6, revert 03.5,
baixa 02.6, reservas PDV 02.7 — intactos. Lotes nesses fluxos é rastreio;
o saldo já passou pela porta do caller.

---

## 9. Conclusão

O módulo **não era um escritor pendente**. Sem código artificial.
**Não** avançar para `estoque_empresa`.
