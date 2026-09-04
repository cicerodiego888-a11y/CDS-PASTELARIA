# OWNERSHIP DE RESERVAS E ESTOQUE EMPRESARIAL — Sprint 05.47

**Status:** implementado  
**Data:** 2026-08-25  
**Dependência:** `consultarDisponibilidade` com `estoque_empresa` (03.36), dual-write de reservado (03.20)

## Fonte de verdade da empresa da reserva

Prioridade:

1. `pedido_estoque_reservas.empresa_id` / `venda_estoque_reservas.empresa_id` persistidos na criação
2. Empresa da venda (`vendas.empresa_id`) no consumo/liberação de reserva de PDV, se a linha ainda for NULL
3. Empresa explícita na criação

Não é fonte de verdade após criada:

- `req.empresaId`
- empresa do usuário
- COMPAT
- última empresa utilizada

O contexto atual **autoriza**. Não redefine a dona.

## Fluxo de criação

```
PEDIDO / OPERAÇÃO
  ↓
resolver empresa proprietária (explícita)
  ↓
BEGIN IMMEDIATE (mecanismo já existente)
  ↓
consultar estoque_empresa (disponivel = max(0, saldo − reservado))
  ↓
reprocesso: se já existe ATIVA mesmo pedido+produto+empresa → retornar (sem somar)
  ↓
validar disponibilidade daquela empresa
  ↓
delta em produtos.reservado_* + espelho em estoque_empresa
  ↓
INSERT tracking com empresa_id
  ↓
COMMIT
```

## Disponibilidade

Com `empresaId`:

```
disponivel = saldo_da_empresa − reservado_da_empresa
```

Sem registro em `estoque_empresa` → zero. Sem fallback para `produtos`.

Nunca:

- estoque global − reservas da empresa
- estoque da empresa − reservas globais

`consultarDisponibilidadeParaPedido` credita apenas reservas ATIVAS do próprio pedido **na mesma empresa**.

## Consumo

```
RESERVA (linha persistida)
  ↓
empresa_id da reserva
  ↓
liberarQuantidadeReservada naquela empresa
  ↓
status CONSUMIDA
```

`pedidoReservaPonteNucleo.consumirReservasPedidoNaVenda` não usa o contexto HTTP para escolher o estoque. Linha sem `empresa_id` permanece COMPAT de tracking legado (não inventa dona).

## Liberação / cancelamento

```
RESERVA
  ↓
empresa proprietária persistida
  ↓
estoque_empresa correspondente
  ↓
decrementar reservado
```

`cancelarReservaPedidoDaEmpresa(reservaId, empresaId)`:

- outra empresa → `RESERVA_NAO_ENCONTRADA` (404)
- sem efeito colateral

## Oversell

A checagem de disponibilidade ocorre **dentro** de `BEGIN IMMEDIATE` (`executarComTxOuReutilizar`). SQLite serializa writers na mesma conexão/arquivo. Não foi criada infra nova de lock.

Reprocessamento da mesma reserva ATIVA (mesmo pedido + produto + empresa) não duplica `reservado_*`.

## FLUXO FUTURO — EXPIRAÇÃO DE RESERVAS

Não existe coluna de prazo nem scheduler nesta sprint.

Contrato obrigatório quando for implementado:

```
expirarReserva(reserva)
  → usar reserva.empresa_id / origem persistida
  → nunca contexto atual
  → nunca COMPAT / usuário / última empresa
```

Não inventar expiração agora.

## Pedidos

A tabela `pedidos` **não** tem `empresa_id`. Ownership da reserva de pedido é a coluna persistida na própria reserva no momento da criação.
