# SPRINT 05.51

## OBJETIVO

Isolar crédito/liberação/cancelamento de reservas pela dona persistida (`reserva.empresa_id`). COMPAT não decide ownership nesse fluxo.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/fiscalNaoFiscal/reservasPublico.js` | `liberarReservasPedido` exige dona; sem `resolverContextoEmpresa` |
| `backend/services/estoque/EstoqueReservaService.js` | `liberarReservasDaVenda` usa só `reserva.empresa_id` |
| `backend/services/estoque/EstoqueConsumoReserva.js` | consumo PDV libera reservado com dona |
| `tests/estoque/credito-liberacao-reserva-empresa-05-51.test.js` | **Novo** T01–T10 |
| `docs/arquitetura/OWNERSHIP_CREDITO_LIBERACAO_RESERVAS_05_51.md` | contrato |
| `docs/arquitetura/RISCOS_ENCONTRADOS_05_51.md` | riscos fora |
| este relatório | |

## RISCO CORRIGIDO

Liberação podia mutar com COMPAT ou sem `empresa_id`; consumo PDV usava empresa do caller na porta, não da linha.

## TESTES (2026-08-25)

| Suite | Resultado |
|-------|-----------|
| `credito-liberacao-reserva-empresa-05-51` | 10/10 OK |
| `isolamento-lotes-fefo-reservas-05-47` | 19/19 OK |
| `ownership-pedido-reserva-05-49` | 10 OK |
| `consumo-reserva-pedido-sem-compat-05-50` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica` | 10/10 OK |
| `reservas-pdv-multiempresa-contexto` | 10/10 OK |
| `reserva-repair-porta-publica` | 10/10 OK |

## INVARIANTE

Uma reserva persistida só libera, credita ou altera reservado na empresa de `reserva.empresa_id`. O contexto autoriza; COMPAT não é dono.
