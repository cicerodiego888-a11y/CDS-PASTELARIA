# Isolamento do JOIN Central no relatório de uso/consumo (Sprint 05.61)

**Status:** implementação (somente leitura do relatório)  
**Data:** 2026-08-29  
**Origem:** risco D da auditoria 05.60

## Risco D (05.60)

```
LEFT JOIN central_entradas_documentos d ON d.compra_id = c.id
```

Compra A (`empresa_id = A`) + documento B (`empresa_id = B`, `compra_id` = compra A) → relatório de A podia exibir `central_chave` / `central_documento_id` de B.

## JOIN novo

```
LEFT JOIN central_entradas_documentos d
       ON d.compra_id = c.id
      AND d.empresa_id = c.empresa_id
```

Filtro principal preservado: `AND c.empresa_id = ?`. Sem INNER JOIN. Sem COALESCE de ownership.

## Invariante

Relatório → `compras.empresa_id` (contexto autoriza). Documento só se `d.compra_id = c.id` **e** `d.empresa_id = c.empresa_id`.

| Caso | Resultado |
|------|-----------|
| Compra A + doc A | documento aparece |
| Compra A + doc B | compra aparece; campos Central NULL |
| Compra B + doc A | documento A não aparece |
| Compra A sem doc | linha da compra, Central NULL |
| Doc `compra_id` NULL | não vira linha do relatório |
| Compra `empresa_id` NULL | continua invisível; documento não resgata |

Sem UPDATE, backfill ou correção de vínculo.

## Subqueries financeiro / auditoria

Não alteradas. Semântica igual (por `compra_id`).

## Fora do escopo

`backend/utils/comprasEmpresaHelpers.js` — UPDATE de backfill via documento (não é este relatório). DistDFe, MIIP, demais JOINs da Central.

## Testes

`tests/compras/isolamento-join-central-05-61.test.js` T01–T08 + snapshot de não mutação. Extra: compra NULL não resgatada.
