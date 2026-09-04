# OWNERSHIP DE LOTES E FEFO — Sprint 05.47

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** `estoque_empresa` (03.11+), `vendas.empresa_id` (05.40), cancelamento/devolução (05.42)

## Modelo real encontrado

O catálogo (`produtos`) é compartilhado. O estoque operacional é empresarial (`estoque_empresa`).

A tabela `produtos_lotes` **não possuía** `empresa_id`. DDL original:

- `produto_id`, `lote`, `quantidade_inicial`, `quantidade_atual`
- `data_validade`, `data_entrada`, `origem`, `compra_id`, `ativo`

Não existe unicidade `(produto_id, lote)`. Duas empresas podem ter o mesmo SKU e o mesmo código de lote.

`venda_lotes` liga `venda_item_id` → `produto_lote_id`. Ownership da venda: `vendas.empresa_id` (05.40). Ownership do lote era só o id global.

Não há `ALTER` legado de `empresa_id` em lotes antes desta sprint. Origens de lote: compra, ajuste, estoque inicial. `compra_id` não cobre todas as origens — **coluna `empresa_id` no lote é necessária**.

## Fonte de ownership

```
EMPRESA DA OPERAÇÃO (persistida)
   ↓
LOTE (produtos_lotes.empresa_id)
   ↓
FEFO daquela empresa
```

| Recurso | Fonte | Não é fonte |
|---------|--------|-------------|
| Lote novo | `empresaId` explícito na criação (compra, ajuste, estoque inicial, venda) | `req.empresaId` em operação posterior, usuário, COMPAT, última empresa |
| FEFO | `empresaId` da operação (venda: `opcoes.empresaId` da venda) | SKU sozinho |
| Restauração | empresa da venda/origem + `produtos_lotes.empresa_id` do lote consumido | contexto HTTP atual |

Lote com `empresa_id` NULL = legado. Não recebe empresa inventada.

## Queries antes / depois

**Antes (inseguro):**

```sql
SELECT ...
FROM produtos_lotes pl
WHERE pl.produto_id = ?
  AND pl.ativo = 1
  AND pl.quantidade_atual > 0
ORDER BY pl.data_validade ASC
```

**Depois (contrato operacional):**

```sql
SELECT ...
FROM produtos_lotes pl
WHERE pl.empresa_id = ?
  AND pl.produto_id = ?
  AND pl.ativo = 1
  AND pl.quantidade_atual > 0
ORDER BY pl.data_validade ASC, pl.id ASC
```

Empate FEFO: validade, depois `id`. Sem ordem implícita.

## Contrato `selecionarLoteFefo`

```
selecionarLoteFefo({ empresaId, produtoId, quantidade, db })
```

Sem `empresaId`: `EMPRESA_CONTEXT_REQUIRED`.

Proibido: `selecionarLoteFefo({ produtoId })` em operação empresarial.

Consumo (`consumirLotesFEFO`) e restauração (`restaurarLotesVenda`) exigem a mesma empresa. UPDATE:

```sql
UPDATE produtos_lotes
SET quantidade_atual = quantidade_atual - ?
WHERE id = ? AND empresa_id = ?
```

## Regra FEFO empresarial

```
EMPRESA
  ↓
PRODUTO (catálogo compartilhado)
  ↓
LOTES DAQUELA EMPRESA (empresa_id NOT NULL)
  ↓
MENOR VALIDADE, depois menor id
  ↓
CONSUMO
```

Lotes com `empresa_id` NULL **não entram** no FEFO empresarial.

## Tratamento de legado

- Sem backfill.
- Sem COMPAT / usuário / primeira empresa cadastrada.
- Operação que precise do lote legado: `EMPRESA_OWNERSHIP_REQUIRED` (restauração) ou “não há lotes disponíveis” (FEFO não encontra linha).
- Acesso cruzado: `LOTE_NAO_ENCONTRADO` (404), nunca 403.

## Pontos fora do escopo

- `gerarProximoLote` permanece sequência nominal global `LT%` (nome, não saldo) — classe C.
- `atualizarEstoqueConsolidado` continua sem caller operacional — classe E.
- `buscarLotesVencendo` / dashboard: filtra por `req.empresaId` quando há contexto; sem contexto não consome lote.
- NF-e 55, Motor Comercial, TEF, expiração de reservas, scheduler.
- Transformação / ficha técnica: não chamam FEFO hoje.
