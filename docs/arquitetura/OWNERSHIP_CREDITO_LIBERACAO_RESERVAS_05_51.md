# OWNERSHIP CRÉDITO / LIBERAÇÃO DE RESERVAS — Sprint 05.51

**Status:** implementado  
**Data:** 2026-08-25  
**Escopo:** liberação, cancelamento e crédito de reservado originados de reserva persistida.

## Caminho anterior

### Pedido (`liberarReservasPedido`)

1. `resolverContextoEmpresa(opts)` — podia abrir COMPAT.
2. Linhas ATIVAS do pedido.
3. Se contexto empresa ≠ `reserva.empresa_id` → `continue` silencioso.
4. Se `reserva.empresa_id` NULL → ainda mutava `produtos.reservado_*` e marcava CANCELADA (sem espelho empresarial).
5. Com dona → delta em `produtos` + `estoque_empresa` da dona.

### PDV venda (`liberarReservasDaVenda` / `consumirReservasDaVenda`)

- Liberação: preferia dona quando existia; NULL caía no fallback COMPAT da porta PDV.
- Consumo: `montarOptsPortaReservaPdv(opcoes)` — empresa do **caller**, não da linha persistida.

### Cancelamento unitário

`cancelarReservaPedidoDaEmpresa` já usava dona + 404 cruzado (05.47). Mantido.

## Inventário de funções

| Função | Arquivo | Chamadores | Fonte antes | Tabelas | Classe | Depois |
|--------|---------|------------|-------------|---------|--------|--------|
| `liberarReservasPedido` | `reservasPublico.js` | MotorComercial, PedidoService/Operacional | ctx/COMPAT + dona parcial | `pedido_estoque_reservas`, `produtos`, `estoque_empresa` | D → A | `reserva.empresa_id` |
| `cancelarReservaPedidoDaEmpresa` | `reservasPublico.js` | APIs/testes | dona + lookup empresa | idem | A | inalterado |
| `obterReservaPedidoDaEmpresa` | `reservasPublico.js` | cancelar | id+empresa | leitura | B | inalterado |
| `liberarQuantidadeReservada` | `reservasPublico.js` | ponte, PDV, Repair | opts da porta | reservado | C | porta; caller passa dona |
| `liberarReservasDaVenda` | `EstoqueReservaService.js` | MotorFinalizacao, faturamento | dona ou COMPAT | `venda_estoque_reservas`, reservado | D → A | só dona |
| `consumirReservasDaVenda` | `EstoqueConsumoReserva.js` | Faturamento | opts PDV | venda reservas + baixa | D → A | liberação com dona |
| `creditarDisponibilidadeComReservaPedido` | `pedidoReservaPonteNucleo.js` | pagamento | N/A (cálculo) | nenhuma | E | fora (não muta) |
| Repair `handlerLiberarReserva` | `ReservaRepairService.js` | repair | ownership 05.49 | tracking + porta | C/E | não alterado nesta sprint |
| MUV liberação | `AtendimentoMultiempresaService.js` | MUV | próprio | — | E | fora do escopo |

## Fonte de empresa

**Antes:** mistura de `resolverContextoEmpresa` / `montarOptsPortaReservaPdv` / dona parcial.

**Depois (reserva persistida):**

```
empresaId = reserva.empresa_id
```

Contexto (`opts.empresaId`) só autoriza. Divergência → `RESERVA_EMPRESA_DIVERGENTE`.  
Lookup cruzado por id → `RESERVA_NAO_ENCONTRADA` (404).

## COMPAT eliminado neste caminho

- `liberarReservasPedido` não chama mais `resolverContextoEmpresa` nem monta legado.
- `liberarReservasDaVenda` / `consumirReservasDaVenda` não usam COMPAT quando há linha de reserva; exigem `empresa_id` na linha.

## COMPAT mantido (fora do escopo)

- Criação PDV sem empresa (`montarOptsPortaReservaPdv` ainda pode COMPAT na **criação**).
- `liberarQuantidadeReservada` / `ajustarReservado` genéricos quando o caller não tem reserva (porta F×NF).
- Débito/crédito de venda, ajuste, compras, MTS.
- Constante `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` global.

## Acesso cruzado

| Operação | Resultado |
|----------|-----------|
| `cancelarReservaPedidoDaEmpresa(idA, empresaB)` | 404 `RESERVA_NAO_ENCONTRADA` |
| `obterReservaPedidoDaEmpresa(idA, empresaB)` | 404 |
| `liberarReservasPedido(pedidoA, { empresaId: B })` | `RESERVA_EMPRESA_DIVERGENTE` |
| `liberarReservasDaVenda` com caller B e linhas A | `RESERVA_EMPRESA_DIVERGENTE` |

Sem efeito colateral em estoque/status.

## Reservas legadas NULL

Qualquer liberação/cancelamento/consumo com `empresa_id IS NULL`:

→ `EMPRESA_OWNERSHIP_REQUIRED` **antes** de mutar.

Não infere pedido, venda, usuário, COMPAT ou empresa 1.

## Operações que alteram estoque/reservado

1. Delta negativo em `produtos.reservado_*` (`_aplicarDeltaReservado`).
2. Espelho em `estoque_empresa` (`espelharReservadoEmEstoqueEmpresa` / `aplicarEfeitoReservado`) com **dona**.
3. Status `CANCELADA` / `CONSUMIDA` no tracking.

Saldo físico (`saldo_*` / `estoque_atual`) **não** é alterado pela liberação pura; consumo PDV ainda baixa via `reduzirEstoqueDistribuido` (fora do ownership de reserva, mas passa `empresaId: dona` no opts).

## Riscos fora do escopo

Ver `docs/arquitetura/RISCOS_ENCONTRADOS_05_51.md`.
