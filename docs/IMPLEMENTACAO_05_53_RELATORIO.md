# SPRINT 05.53

## OBJETIVO

Garantir que a baixa física no consumo de reserva PDV use somente `reserva.empresa_id`. COMPAT e caller não decidem o estoque.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/estoque/EstoqueConsumoReserva.js` | Validação venda×reserva; opts limpos para baixa |
| `tests/estoque/consumo-fisico-reserva-pdv-sem-compat-05-53.test.js` | **Novo** T01–T10 |
| `docs/arquitetura/OWNERSHIP_CONSUMO_FISICO_RESERVA_PDV_05_53.md` | contrato |
| este relatório | |

Não alterados: schema, Motor, Repair, criação/liberação (05.51–05.52), `debitoEstoqueVendaViaPorta` genérico.

## COMO ERA

`{ ...opcoes, empresaId: dona }` — dona já era setada, mas flags COMPAT do caller podiam vazar; venda×reserva não era validada.

## COMO FICOU

Opts limpos (`exigirEmpresa: true`, `empresaId = reserva.empresa_id`). Divergência venda/reserva → `OPERACAO_EMPRESA_DIVERGENTE` antes da mutação.

## TESTES (2026-08-25)

| Suite | Resultado |
|-------|-----------|
| `consumo-fisico-reserva-pdv-sem-compat-05-53` | 10/10 OK |
| `reservas-pdv-multiempresa-contexto` | 10/10 OK |
| `criacao-reserva-pdv-sem-compat-05-52` | 10/10 OK |
| `credito-liberacao-reserva-empresa-05-51` | 10/10 OK |
| `consumo-reserva-pedido-sem-compat-05-50` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica` | 10/10 OK |
| `ownership-pedido-reserva-05-49` | 10 OK |
| `isolamento-lotes-fefo-reservas-05-47` | 19/19 OK |

## INVARIANTE

```
RESERVA.empresa_id → única fonte → baixa física em ESTOQUE_EMPRESA
```

Venda deve coincidir. Caller autoriza. COMPAT não participa.
