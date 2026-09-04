# Isolamento financeiro nas leituras de compras (Sprint 05.64)

**Status:** implementação (somente leitura)  
**Data:** 2026-08-29  
**Origem:** riscos D da auditoria 05.63

## Regra

```
financeiro.empresa_id = compras.empresa_id
```

Contexto autoriza a consulta da compra. Dono do financeiro lido é a **compra persistida**, não o header.

## GET `/api/compras`

```
COUNT(*) FROM financeiro f
 WHERE f.compra_id = c.id
   AND f.status = 'pendente'
   AND f.empresa_id = c.empresa_id
```

Filtro `WHERE c.empresa_id = ?` preservado.

## GET `/api/compras/:id`

Após `exigirCompraParaMutacaoOpaca`:

```
SELECT * FROM financeiro
 WHERE compra_id = ?
   AND empresa_id = ?
```

Parâmetros: `[id, compra.empresa_id]` — **não** `ctxEmp.empresaId` como dono da linha financeira.

## Cenários

| Caso | Lista `parcelas_pendentes` | Detalhe `financeiro[]` |
|------|----------------------------|-------------------------|
| Compra A + fin A | conta | inclui |
| Compra A + fin B no mesmo `compra_id` | não conta B | não inclui B |
| Fin `empresa_id` NULL | não conta | não inclui |
| Sem COALESCE / backfill | — | — |

Linhas inconsistentes **permanecem no banco**.

## Não alterado

Relatório uso/consumo (05.62), writers de financeiro, Central, estoque, fiscal, schema.
