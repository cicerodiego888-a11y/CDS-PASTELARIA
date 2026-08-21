# Implementação 03.5 — Revert de estoque da NF-e de devolução de venda → Porta Pública

**Status:** concluída · **Data:** 2026-08-15  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Auditoria prévia (obrigatória)

A Sprint **não** estava implementada: não havia `IMPLEMENTACAO_03_5_*`, nem
`tests/estoque/revert-devolucao-venda-porta-publica.test.js`. O mutador ainda
fazia `UPDATE produtos` direto.

### Mutador encontrado

| Campo | Descoberta |
|---|---|
| Arquivo | `backend/services/fiscal/estoqueNfeDevolucaoVenda.js` |
| Método | `reverterEstoqueNfeDevolucaoVenda(nfeDevolucaoId)` |
| Caller | `controleSaldoDevolucaoVenda.cancelarNfeDevolucaoVenda` (quando `estoque_retornado = 1`) |
| Caller indireto | `nfeDevolucaoLifecycleVenda.cancelarNfeDevolucaoOficial` → cancelar local |
| `db` | `require('../../database')` (global). Caller **não** abria `BEGIN` |
| `empresaId` | **ausente** no mutador e no caller |
| Transação | nenhuma no fluxo de cancelamento |

### SQL anterior

```sql
UPDATE produtos SET
  saldo_fiscal = CASE
    WHEN COALESCE(saldo_fiscal, 0) - ? < 0 THEN 0
    ELSE COALESCE(saldo_fiscal, 0) - ?
  END,
  estoque_atual = CASE
    WHEN COALESCE(estoque_atual, 0) - ? < 0 THEN 0
    ELSE COALESCE(estoque_atual, 0) - ?
  END
WHERE id = ?
```

- Quantidade: `item.quantidade` da NF-e (sem F/NF).
- Só debitava `saldo_fiscal` + `estoque_atual`.
- **Não** tocava `saldo_nao_fiscal`.
- Floor em 0 (podia quebrar `EA = SF + SNF`).

### Origem das quantidades (autorização × revert)

`retornarEstoqueNfeDevolucaoVenda` (autorizar NF-e) **já** credita F/NF via
`devolverSaldosDistribuidos` → porta pública (Sprint 02.5), usando
`resolverQuantidadesVendaItem` + fator da quantidade da NF-e.

O revert legado **não** usava essa distribuição: cancelar uma devolução mista
só desfazia o fiscal.

### Sinal da operação

O texto da Sprint cita `creditarSaldo()`. A auditoria do mutador e a
`AUDITORIA_FINAL_FUNDACAO_MULTIEMPRESA` mostram o contrário:

- Autorizar NF-e de devolução de venda → **crédito** (já na porta, 02.5)
- Cancelar essa NF-e → **débito** (este mutador)

Usar `creditarSaldo` no revert duplicaria o estoque. A porta obrigatória
permanece `estoqueSaldosPublico`; o método correto deste escritor é
`debitarSaldo`.

---

## Fluxo novo

```
Cancelar NF-e de devolução de venda
        ↓
itens com estoque_retornado = 1
        ↓
quantidade fiscal / não fiscal (mesma fórmula da autorização)
        ↓
estoqueSaldosPublico.debitarSaldo (FISCAL e/ou NAO_FISCAL)
        ↓
produtos  (storage transitório)
        ↓
estoque_retornado = 0
```

- Sem `UPDATE` de saldo neste fluxo.
- Sem nova porta (`revertEstoqueService2` / `portaNfeDevolucao` não criados).
- Reservas (`reservado_fiscal` / `reservado_nao_fiscal`) não alteradas.

---

## Classificação fiscal / não fiscal

Preservada a distribuição **já determinada** em `retornarEstoqueNfeDevolucaoVenda`:

1. `quantidade_fiscal` / `quantidade_nao_fiscal` do item da venda
2. `resolverQuantidadesVendaItem` (sem nova regra)
3. Fator `qtd_nfe / total_origem`

Não recalcula Motor Fiscal, Motor Não Fiscal, MTS nem MUC.

---

## empresaId

| Prioridade | Fonte |
|---|---|
| 1 | `opcoes.empresaId` / `empresa_id` explícito |
| 2 | `opcoes.contexto` / `opcoes.ctx` |
| 3 | Ausência → `COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA` |
| 4 | `exigirEmpresa: true` → `EMPRESA_OBRIGATORIA` |

Sem `empresaId = 1`, sem `configuracoes.cnpj`, sem fallback silencioso.

O HTTP/lifecycle de cancelamento ainda não envia empresa → COMPAT explícita
(mesmo padrão 02.5 no retorno NF-e).

---

## Transação

O caller não abre `BEGIN`. O revert **não** abre transação própria.
Se o caller injetar `db` já em transação, o débito usa esse mesmo `db`.

```
BEGIN
  revert (porta)
ROLLBACK
→ saldo original
```

---

## Sem débito / crédito duplicado

Uma passagem pela porta por item com `estoque_retornado = 1`.
Segunda chamada não encontra itens (flag já zerada).
O revert **não** chama `creditarSaldo`.

---

## Testes

`tests/estoque/revert-devolucao-venda-porta-publica.test.js` — 01–10.

---

## Limitações

1. Storage ainda em `produtos`.
2. COMPAT necessário até o cancelamento NF-e receber `empresaId`.
3. Porta recusa saldo negativo (`SALDO_INSUFICIENTE`) — o SQL legado fazia floor em 0.
4. `retornarEstoqueNfeDevolucaoVenda`, reservas, CREATE produto e lotes **não** migrados aqui.
5. `estoque_empresa` **não** criada.

---

## Próxima etapa

**03.6** — `consumirReservasPedidoNaVenda`.

Não implementada nesta Sprint.
