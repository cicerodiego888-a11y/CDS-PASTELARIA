# INVENTÁRIO COMPAT — PEDIDO / MOTOR / REPAIR — Sprint 05.49

**Data:** 2026-08-25

Classificação neste domínio:

- **A** — ownership persistido (`pedidos.empresa_id` / reserva da mesma empresa)
- **B** — load por ID + validação (404 cruzado, divergência 409)
- **C** — COMPAT residual (fora do fluxo PEDIDO → RESERVA, ou helper não usado como dono)
- **D** — risco residual documentado
- **E** — fora do escopo

## Fluxo PEDIDO → RESERVA (objetivo desta sprint)

| Peça | Antes (05.48) | Depois (05.49) | Classe |
|------|---------------|----------------|--------|
| `pedidos.empresa_id` | ausente | coluna + índice + backfill 1:1 | A |
| Motor `optsPortaSaldos` | COMPAT se sem empresa | exige empresa do pedido/criação | A |
| Motor pedido existente | COMPAT podia decidir estoque | `pedidos.empresa_id` | A |
| Motor pré-criação | COMPAT | `EMPRESA_CONTEXT_REQUIRED` | A |
| Repair `montarOptsPortaReservaRepair` | COMPAT legado | `EMPRESA_OWNERSHIP_REQUIRED` | A |
| Repair INSERT tracking | sem `empresa_id` | persiste `empresa_id` do pedido (órfã: da reserva) | A |
| Consume `consumirReservasPedidoNaVenda` | COMPAT se caller sem empresa | dona = `pedidos.empresa_id` | A |
| Listagem pedidos sem `empresaId` | risco de cruzamento | `1=0` (vazio) | A |
| Pedido legado NULL | COMPAT podia operar | bloqueio sem mutação | B |

## COMPAT eliminado neste fluxo

- `MotorComercialService`: `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` **não** aparece mais no arquivo; `optsPortaSaldos` não monta modo legado.
- `ReservaRepairService`: fallback `motivoCompat \|\| MOTIVO_COMPAT_RESERVA_REPAIR` removido da montagem da porta.
- Repair não insere `pedido_estoque_reservas` sem `empresa_id` quando há dona persistida.

## COMPAT mantido (justificado — fora de PEDIDO → RESERVA como fonte de dono)

| Ocorrência | Motivo | Classe |
|------------|--------|--------|
| Porta F×NF / MTS quando o **caller** opta `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` | saldo/reserva sem pedido; testes 03.35 COMPAT legado | C |
| Débito/crédito de venda (`COMPAT_CREDITO_VENDA_...`) | fluxo venda 05.40/05.42, não pedido | C |
| PDV reservas / consumo PDV | `venda_estoque_reservas`; empresa da venda/linha | C |
| Ajuste de estoque / compras | writers próprios | C |
| `montarOptsPortaConsumoReservaPedido` helper | ainda devolve COMPAT se chamado sem empresa; **consume-from-pedido não usa** | C |
| `MOTIVO_COMPAT_RESERVA_REPAIR` string deprecated no Repair | constante histórica; não é fallback | C |
| `gerarProximoLote` / catálogo `produtos` | E / C já 05.47 | E/C |

## Riscos residuais (não inventar dono)

| Item | Classe | Nota |
|------|--------|------|
| Pedido `empresa_id` NULL | D | operações mutáveis falham; listagem não o mostra no filtro empresarial |
| Reserva órfã NULL | D | Repair com efeito bloqueia; dry-run classifica |
| `auditoria_pedido_estoque_fiscal` sem `empresa_id` | E | log, não writer de saldo |
| Vendas / financeiro / caixa NULL no acervo vivo | E | 05.40–05.45; fora desta sprint |
| NF-e 55 `getFiscalConfig()` global | E | fora do escopo |
| Expiração/scheduler de reservas | E | fluxo inexistente |

## Produto compartilhado

Intencional: `produtos` sem `empresa_id`. Isolation = `estoque_empresa` + reserva/pedido com empresa.
