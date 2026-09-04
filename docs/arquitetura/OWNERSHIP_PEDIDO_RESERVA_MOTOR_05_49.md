# OWNERSHIP PEDIDO → RESERVA → MOTOR / REPAIR — Sprint 05.49

**Status:** implementado  
**Data:** 2026-08-25

## Motor Comercial

Pedido existente:

```
empresaId = pedidos.empresa_id
```

COMPAT **não** é fonte de ownership neste fluxo. `optsPortaSaldos` exige empresa resolvida; sem ela: `EMPRESA_CONTEXT_REQUIRED`.

Pré-criação (análise sem `pedidoId`): exige empresa explícita do caller (`exigirEmpresaDaCriacao`). Sem fallback `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA`.

Caller com `empresaId` diferente de `pedidos.empresa_id`:

```
PEDIDO_EMPRESA_DIVERGENTE
```

antes de consultar saldo, transferir F×NF ou criar reserva.

Reserva criada pelo Motor: `reserva.empresa_id` deve igualar `pedido.empresa_id`. Divergência:

```
RESERVA_EMPRESA_DIVERGENTE
```

`carregarPedido` não trata coluna ausente (`venda_id`) como “pedido inexistente”: tenta SELECT reduzido. Tabela inexistente → não encontrado.

## ReservaRepair

`montarOptsPortaReservaRepair` **não** cai em COMPAT. Sem empresa resolvida: `EMPRESA_OWNERSHIP_REQUIRED`.

`executarPlano` com alvo (`pedido_id` / `reserva_id`) ou `dryRun: false` avalia ownership **antes** da mutação.

Pedido existente: dona = `pedidos.empresa_id`.  
Reserva órfã (pedido inexistente): dona = `reserva.empresa_id`. Sem dona → `EMPRESA_OWNERSHIP_REQUIRED` (não inventa).  
Alvo inexistente: o handler original reporta `RESERVA_INEXISTENTE` / códigos de domínio — ownership não substitui esses códigos.

`handlerCriarReserva`: exige `pedidos.empresa_id` **antes** do delta de reservado; INSERT inclui `empresa_id`.

`MOTIVO_COMPAT_RESERVA_REPAIR` permanece no arquivo como constante **deprecated** (string histórica). Não é mais fallback.

Pedido legado NULL: dry-run e `dryRun: false` classificam `EMPRESA_OWNERSHIP_REQUIRED` sem mutar estoque.

## Consumo pedido → venda

`consumirReservasPedidoNaVenda` carrega `pedidos.empresa_id`, exige ownership e passa essa empresa à porta (`exigirEmpresa: true`).

O helper `montarOptsPortaConsumoReservaPedido` ainda pode emitir COMPAT se chamado **sem** empresa e **sem** passar pelo consume-from-pedido. O caminho operacional de faturamento **não** usa mais esse COMPAT como dono.

Cadeia, quando aplicável:

```
pedido.empresa_id = reserva.empresa_id = venda.empresa_id = estoque_empresa.empresa_id
```

Divergência na cadeia: `OPERACAO_EMPRESA_DIVERGENTE` / `RESERVA_EMPRESA_DIVERGENTE` **antes** da transação efetiva. Não corrige automaticamente registros inconsistentes.

## Cancelamento / liberação

Empresa da operação = `pedidos.empresa_id`.  
Liberação usa `reserva.empresa_id` e valida igualdade com o pedido.  
Contexto B sobre pedido A: 404 `PEDIDO_NAO_ENCONTRADO` antes de qualquer efeito.

## Tracking

`auditoria_pedido_estoque_fiscal` **não** tem `empresa_id`. É log de auditoria, não writer de estoque. Sem migration extra nesta sprint.
