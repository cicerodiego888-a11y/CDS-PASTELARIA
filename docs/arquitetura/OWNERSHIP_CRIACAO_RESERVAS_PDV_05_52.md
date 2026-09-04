# OWNERSHIP CRIAÇÃO DE RESERVAS PDV — Sprint 05.52

**Status:** implementado  
**Data:** 2026-08-25  
**Escopo:** criação de `venda_estoque_reservas` pelo PDV / entrega.

## Caminho anterior

`montarOptsPortaReservaPdv` resolvia empresa de `req` / `fonte.empresaId` e, se ausente, devolvia:

```
modoLegadoSemEmpresa: true
motivoCompat: COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA
```

`reservarItem` usava esse `empresaId` (ou null) no INSERT — reserva persistida sem ownership explícito da venda.
AC
## Inventário

| Peça | Papel | Antes | Depois |
|------|-------|-------|--------|
| `montarOptsPortaReservaPdv` | helper porta PDV | COMPAT se sem empresa | exige `empresaId` → senão `EMPRESA_CONTEXT_REQUIRED` |
| `reservarItem` | cria tracking + delta | empresa do caller/COMPAT | `vendas.empresa_id` |
| `CriarVendaEntregaService` | caller criação | passa `empresaIdDoReqReservaPdv(req)` | inalterado; ownership vem da venda já INSERT com `empresa_id` |
| `MotorFinalizacaoVenda` / `FaturamentoService` | consumo/liberação via helper | passam `empresaId` do req | helper sem COMPAT; liberação 05.51 usa dona da linha |
| `liberarReservasDaVenda` | 05.51 | dona | inalterado nesta sprint |

## Fonte de empresa

```
vendas.empresa_id
  = venda_estoque_reservas.empresa_id
  = estoque_empresa.empresa_id
```

Caller (`empresaId`) só autoriza. Cruzado → `VENDA_NAO_ENCONTRADA` (404).  
Venda `empresa_id` NULL → `EMPRESA_OWNERSHIP_REQUIRED` antes de mutar.

## COMPAT

**Eliminado** neste fluxo de criação: fallback do helper operacional PDV.

**Mantido** (fora): F×NF genérico, crédito venda, ajuste, compras, Motor, Repair, MUV.  
Constante `MOTIVO_COMPAT_RESERVA_PDV` permanece **deprecated** no arquivo (string histórica).

## Produto compartilhado

Sem `empresa_id` em `produtos`. Isolamento via `estoque_empresa` + reserva com empresa da venda.
