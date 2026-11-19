# Evidência S07-3E — Fluxo, idempotência e isolamento

## Fluxo técnico

```
POST /api/pedidos
  → EntradaPedido (canal EQUIPE)
  → PedidoOperacional.criar (TX comercial + resolução S07-3D)
  → COMMIT comercial
  → CozinhaDespachoPedidoService.despacharPedidoResolvido
       gate: cozinha_resolucao_status = RESOLVIDO
       unidade = unidade_cozinha_destino_id persistida (nunca do body)
       valida empresa/unidade ativa
       UNIQUE claim em cozinha_pedido_despachos(empresa_id, pedido_id)
       garante cozinha_comandas do pedido
       → CozinhaDespachoService.despacharLote (estrutura KDS existente)
       → cozinha_rodadas + cozinha_itens
  → painel KDS filtra por empresa_id + unidade_id
```

Despacho ocorre **após** o COMMIT comercial: falha de despacho não cancela o pedido.

## Idempotência (persistência)

| Camada | Mecanismo |
|--------|-----------|
| `cozinha_pedido_despachos` | `UNIQUE(empresa_id, pedido_id)` + `UNIQUE(idempotency_key)` |
| Chave estável | `s07-3e:despacho:empresa:{id}:pedido:{id}` |
| `cozinha_idempotencia` | herdada de `despacharLote` |
| Snapshot pedido | `cozinha_despacho_status` / `rodada_id` / `codigo` |

Reprocessamento: status `FALHA`/`BLOQUEADO` pode ser reivindicado; `CONCLUIDO` retorna `repetida` sem nova rodada.

## Isolamento

- Empresa só do contexto autenticado.
- Destino só da resolução S07-3D persistida.
- Body `empresa_id` / `unidade_*` / `destino` ignorados.
- Itens KDS só na `unidade_id` da rodada (painel por unidade).

## S06

- Nenhum arquivo S06 modificado.
- `despacharLote` continua enfileirando jobs existentes (sem estação → `IMPRESSAO_SEM_ESTACAO`; sem impressão física automática).
- `CozinhaDespachoPedidoService` não importa fila/worker/drivers.

## Migration (não aplicada no oficial)

`backend/migrations/s07-3e-pedido-despacho-kds.sql`
