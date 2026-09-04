# ELIMINAÇÃO DO COMPAT NO CONSUMO DE RESERVAS DE PEDIDO — Sprint 05.50

**Status:** implementado  
**Data:** 2026-08-25  
**Escopo:** apenas consumo de reserva originada de PEDIDO (`pedidoReservaPonteNucleo`).

Esta sprint **não** consolida a cadeia multiempresa inteira. Remove o fallback COMPAT residual do helper de consumo pedido → venda.

## Contrato anterior (05.49)

`consumirReservasPedidoNaVenda` já lia `pedidos.empresa_id` e passava essa empresa à porta com `exigirEmpresa: true`.

O helper `montarOptsPortaConsumoReservaPedido` ainda podia:

1. descobrir empresa em `opts` / `contexto` / `ctx` / `req` / header;
2. se nada viesse, devolver objeto COMPAT:

```
modoLegadoSemEmpresa: true
motivoCompat: COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA
legado: true
```

O caminho operacional de faturamento **não** usava esse COMPAT como dono. O helper, se chamado direto sem empresa, ainda era capaz de montar operação legado.

## Onde o COMPAT podia ocorrer

| Local | Classe (Fase 1) | Notas |
|-------|-----------------|-------|
| `montarOptsPortaConsumoReservaPedido` sem `empresaId` | A (helper compartilhado) | único ponto que emitia COMPAT neste domínio |
| `consumirReservasPedidoNaVenda` | A | operacional; já forçava empresa do pedido |
| `consumirReservasPedidoNaVendaCb` | A | wrapper; delega ao async |
| `FaturamentoService` | A | passa `empresaId` do pedido |
| `VendaPagamentoService` | A | passa `empresaId` da baixa |
| testes `consumo-reserva-pedido-porta-publica` | B | cobria COMPAT explícito do helper |
| `rc412-ponte-reserva-pedido-nucleo` | B | chama consume com `{ db }` (empresa vem do pedido) |
| `isolamento-lotes-fefo-reservas-05-47` t10 | A | passa `empresaId` da dona |
| Motor Comercial / PDV `venda_estoque_reservas` | C | fora deste domínio |

## Novo contrato obrigatório

```
montarOptsPortaConsumoReservaPedido({ empresaId, db, ... })
```

- `empresaId` (ou `empresa_id`) explícito e válido.
- Sem empresa: `EMPRESA_CONTEXT_REQUIRED`.
- Não retorna objeto COMPAT.
- Não preenche empresa.
- Não lê req / header / JWT / usuário / empresa 1 / última empresa.

Cadeia operacional:

```
1. localizar pedido
2. ownership do pedido (NULL → EMPRESA_OWNERSHIP_REQUIRED; inexistente → PEDIDO_NAO_ENCONTRADO)
3. pedidos.empresa_id = fonte da porta
4. se opts.empresaId informado → exigirPedidoDaEmpresa (cruzado → 404)
5. se venda existir → pedido.empresa_id = venda.empresa_id senão OPERACAO_EMPRESA_DIVERGENTE
6. localizar reservas ATIVAS
7. cada reserva: exigirReservaDaMesmaEmpresa
   (NULL → EMPRESA_OWNERSHIP_REQUIRED; diverge → RESERVA_EMPRESA_DIVERGENTE)
8. porta com empresaId = pedido.empresa_id
9. mutação (liberar reservado + status CONSUMIDA)
```

Nenhuma mutação de estoque/tracking antes das validações 1–7.

## Inventário de chamadores

| Chamador | Classe | Tratamento 05.50 |
|----------|--------|------------------|
| `consumirReservasPedidoNaVenda` | A | resolve empresa pelo pedido persistido; valida venda/reserva; chama helper com essa empresa |
| `consumirReservasPedidoNaVendaCb` | A | extra.empresaId, se houver, confrontado com o pedido (404 cruzado) |
| `FaturamentoService` (pós-gerar venda) | A | já envia `empresaId` do pedido; inalterado estruturalmente |
| `VendaPagamentoService.consumirReservaPedidoAposBaixa` | A | já envia `empresaId` da baixa; inalterado estruturalmente |
| testes porta pública / rc412 / 05.47 t10 | B | adaptados ao contrato (reserva com `empresa_id`; helper sem COMPAT) |
| Motor Comercial | C | não chama o helper de consumo |
| ReservaRepair | C | porta própria (05.49) |
| PDV `EstoqueConsumoReserva` | C | `venda_estoque_reservas`; não tocado |

Código morto: nenhum identificador além dos wrappers exportados.

## Fluxos alterados

- Helper de opções da porta de consumo de reserva de pedido.
- Validações de cadeia pedido × venda × reserva **antes** de `liberarQuantidadeReservada`.
- Divergência de reserva: deixa de ser `continue` silencioso; passa a erro explícito.

## Fluxos não alterados

- Schema de vendas / reservas / pedidos.
- Motor Comercial (criação de reserva).
- ReservaRepair.
- NF-e 55, DistDFe, FEFO, PDV reservas de venda, ajuste, compras.
- Constante global `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` em outros domínios.
- `obterCreditoReservaPedido` (leitura de crédito; fora do consumo).

## Fonte de verdade

`pedidos.empresa_id` é a empresa passada à porta. Caller `empresaId` só autoriza (404 se cruzado). Reserva e venda devem coincidir; não substituem o pedido.

## Resultado do scan (domínio)

Arquivos:

- `backend/services/estoque/pedidoReservaPonteNucleo.js`
- trechos de chamada em `FaturamentoService.js` e `VendaPagamentoService.js`

Não há:

- `COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA`
- `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` neste helper
- `empresaId || COMPAT...` / `empresaId ?? COMPAT...`
- `resolverEmpresaIdDaRequisicao` no helper de consumo

COMPAT permanece em F×NF/MTS, crédito de venda, PDV, etc., **fora** deste recorte.

## Riscos fora do escopo

Ver `docs/arquitetura/RISCOS_ENCONTRADOS_05_50.md`.
