# SPRINT 05.52

## OBJETIVO

Eliminar COMPAT na criação de reservas persistidas do PDV. Ownership = `vendas.empresa_id`.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/estoque/EstoqueReservaService.js` | Helper sem COMPAT; `reservarItem` lê venda |
| `tests/estoque/reservas-pdv-multiempresa-contexto.test.js` | Seed de vendas; T06/T07 sem COMPAT |
| `tests/estoque/criacao-reserva-pdv-sem-compat-05-52.test.js` | **Novo** T01–T10 |
| `docs/arquitetura/OWNERSHIP_CRIACAO_RESERVAS_PDV_05_52.md` | contrato |
| este relatório | |

Não alterados: Motor Comercial, Repair, schema, F×NF genérico, MUV, NF-e, `CriarVendaEntregaService` (já persiste `empresa_id` na venda).

## COMO ERA

Helper montava COMPAT; INSERT podia ficar com `empresa_id` NULL.

## COMO FICOU

1. Carregar venda  
2. Exigir `vendas.empresa_id`  
3. Autorizar caller (cruzado → 404)  
4. Porta e INSERT com a mesma empresa  

## TESTES (2026-08-25)

| Suite | Resultado |
|-------|-----------|
| `criacao-reserva-pdv-sem-compat-05-52` | 10/10 OK |
| `reservas-pdv-multiempresa-contexto` | 10/10 OK |
| `credito-liberacao-reserva-empresa-05-51` | 10/10 OK |
| `consumo-reserva-pedido-sem-compat-05-50` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica` | 10/10 OK |
| `ownership-pedido-reserva-05-49` | 10 OK |
| `isolamento-lotes-fefo-reservas-05-47` | 19/19 OK |

## INVARIANTE

```
VENDA.empresa_id = RESERVA_PDV.empresa_id = ESTOQUE_EMPRESA.empresa_id
```

Contexto autoriza. Venda determina. COMPAT não define ownership.
