# SPRINT 05.61

## OBJETIVO

Corrigir o risco D do JOIN Central no relatório de uso/consumo. Sem mutação de compra/documento.

## JOIN ANTERIOR

`LEFT JOIN central_entradas_documentos d ON d.compra_id = c.id`

## JOIN NOVO

```
LEFT JOIN central_entradas_documentos d
       ON d.compra_id = c.id
      AND d.empresa_id = c.empresa_id
```

Filtro `AND c.empresa_id = ?` preservado. Continua LEFT JOIN.

## ARQUIVO ALTERADO

| Arquivo | Papel |
|---------|--------|
| `backend/rotas/compras.js` | JOIN do `GET /relatorio/uso-consumo` |
| `tests/auditoria/ownership-uso-consumo-compras-05-60.test.js` | T10/SQL do relatório alinhados ao JOIN novo (risco D do relatório fechado) |

## ARQUIVOS CRIADOS

| Arquivo | Papel |
|---------|--------|
| `tests/compras/isolamento-join-central-05-61.test.js` | T01–T08 + não mutação + NULL |
| `docs/arquitetura/ISOLAMENTO_JOIN_CENTRAL_USO_CONSUMO_05_61.md` | contrato |
| este relatório | |

## OWNERSHIP

`compras.empresa_id`. Documento só se `d.empresa_id = c.empresa_id`. Sem COALESCE.

## CROSS-COMPANY

Compra A + doc B → compra no relatório de A; campos Central NULL. Vínculo persistido inalterado.

## NULL

Compra sem empresa continua fora da lista. Documento não resgata.

## TESTES 05.61

T01–T08 **8/8 OK**. Extra: compra NULL não resgatada.

## REGRESSÕES (2026-08-29)

| Suite | Resultado |
|-------|-----------|
| isolamento-join-central-05-61 | T01–T08 OK |
| ownership-uso-consumo-compras-05-60 | 10/10 (T10 atualizado para JOIN 05.61) |
| ownership-leitura-mutacao-05-59 | 10/10 |
| ownership-chave-nfe-05-58 | 10/10 |
| ownership-documento-compra-05-56 | 10/10 |
| ownership-documento-05-55 | 16/16 |
| modo-multiempresa-05-54 | 12/12 |
| central-entradas-multiempresa-05-38-e | 19/19 |
| compras-multiempresa-05-38-f-b | 16/16 |

Nenhuma falha mascarada.

## RISCOS RESTANTES

- Subqueries `financeiro` e `auditoria` sem `empresa_id` (05.60 classe C) — **não alteradas**.
- `comprasEmpresaHelpers.backfillComprasEmpresaId` usa documento por `compra_id` — **FORA DO ESCOPO** (não é o relatório).
- Outros JOINs da Central / DistDFe / MIIP — **FORA DO ESCOPO**.

## PRODUÇÃO ALTERADA

Somente o JOIN do relatório de uso/consumo.

OUTROS DOMÍNIOS: NÃO.
