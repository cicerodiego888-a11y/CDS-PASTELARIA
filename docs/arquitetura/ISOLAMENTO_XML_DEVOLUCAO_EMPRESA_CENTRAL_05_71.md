# Isolamento do XML de devolução da Central (Sprint 05.71)

**Status:** implementação  
**Data:** 2026-08-29

## 1. Lookup encontrado

`carregarXmlNfeCompraOrigem` em `espelharTributosNfeDevolucaoCompra.js` (chamado por `espelharTributosNfeDevolucaoCompra`).

Consulta global (05.70.1):

```sql
WHERE REPLACE(chave, ' ', '') = ? AND xml IS NOT NULL AND length(trim(xml)) > 100
LIMIT 1
```

## 2. Chamadores

| Chamador | Tipo | empresaId |
|----------|------|-----------|
| `nfeDevolucaoCompra.prepararNfeDevolucaoCompra` | produção | `compra.empresa_id` (`SELECT c.*`) |
| `nfeDevolucaoCompra` emitir | produção | `compra.empresa_id` |
| `espelharTributosNfeDevolucaoVenda` | produção (venda) | **não** usa o lookup de compra/Central |
| `tests/faturamento/rc2-espelhamento-fiscal-devolucao.test.js` | teste | não chama `carregarXmlNfeCompraOrigem` |
| 05.69 auditoria | teste estático | atualizado |

## 3. Origem do empresaId

1. `opts.empresaId` / `empresa_id`
2. `compra.empresa_id` se o objeto compra for passado

Callers de produção: empresa **persistida da compra**. Contexto HTTP só autoriza nas rotas (05.66). Sem empresa → `EMPRESA_OWNERSHIP_REQUIRED`, sem SELECT global.

## 4–5. Consulta

Anterior: só chave.  
Nova: `REPLACE(chave, ' ', '') = ? AND empresa_id = ?` (normalização intacta).  
Lookup por `compra_id` também exige `empresa_id`.

## 6–9. Comportamento

A+X → XML A. B+X → XML B. NULL+X → não é A nem B. Cruzado: B não lê A.

## 10. UPDATE

Este fluxo **só lê** XML. Não há UPDATE em `central_entradas_documentos`. T09 confirma que o XML de A permanece igual após lookup de B.

## 11. Testes

`tests/central-entradas/isolamento-xml-devolucao-empresa-05-71.test.js` T01–T10.

## 12. Riscos restantes

- Fallback `notas_recebidas_dfe` / `notas_recebidas` / disco ainda por chave (fora da tabela Central).
- Compra com `empresa_id` NULL bloqueia o lookup Central (`EMPRESA_OWNERSHIP_REQUIRED`).
- GET `/buscar-chave` (05.70.2).
