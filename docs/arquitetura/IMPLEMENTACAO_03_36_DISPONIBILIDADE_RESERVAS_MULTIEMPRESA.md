# Implementação 03.36 — Disponibilidade multiempresa nas reservas

**Data:** 2026-08-21

## Auditoria

| Item | Encontrado |
|---|---|
| Método | `reservasPublico.consultarDisponibilidade(produtoIdOrParams, opts)` |
| Internos | `mesclarOptsEmpresa`, `resolverContextoEmpresa`, `produtoControlaEstoque`, `calcularEstoqueProduto` |
| Wrapper Pedido | `consultarDisponibilidadeParaPedido` → o mesmo método |
| Caller operacional | `MotorComercial.analisarDisponibilidadeFiscal` via `optsPortaSaldos` |
| Retorno | `saldo_*`, `reservado_*`, `disponivel_*`, `estoque_atual`, `empresa_id`, `legado` |
| Fórmula | `disponivel = max(0, saldo − reservado)` (`EstoqueDisponivelService`) |
| `empresaId` no Pedido | Já chega (03.30). Motor Comercial e Pedido **não** foram alterados. |

## Comportamento

| Contexto | Origem | Sem registro |
|---|---|---|
| Sem `opts.empresaId` | `produtos` | n/a (COMPAT) |
| Com `opts.empresaId` | `estoque_empresa` | disponibilidade zero |

`empresaId` só de `opts.empresaId`. Body/query/contexto/`empresa_id` não substituem.

`controla_estoque = 0` permanece virtual (metadado do produto). Overlay isolado vale quando o produto controla estoque.

Writers de reserva (`_aplicarDeltaReservado`) continuam incrementais em `produtos` + dual-write 03.20.

## Pedido

```
Pedido → Motor Comercial → consultarDisponibilidade → estoque_empresa
                         → MTS → consultarSaldo → estoque_empresa
```

Mesma origem quando há `empresaId`. Empresa B (disp=3) pedindo 5 é bloqueada; A (disp=8) passa. `produtos` = 100 não autoriza.

## Relação com 03.35

03.35 isolou `consultarSaldo`. 03.36 isolou a disponibilidade usada **antes** do MTS. As duas decisões ficam coerentes.

## Testes

- `disponibilidade-reservas-multiempresa.test.js` — 12/12
- `pedido-disponibilidade-multiempresa.test.js` — 4/4

## Limitações

Dashboard, MIB e relatórios ainda leem `produtos`. Storage oficial da **escrita** continua `produtos`.

Sprint **03.37 não iniciada**.
