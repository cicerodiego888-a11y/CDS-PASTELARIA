# SPRINT 05.50

## OBJETIVO

Eliminar o fallback COMPAT residual em `montarOptsPortaConsumoReservaPedido`. Consumo de reserva originada de pedido não descobre nem inventa empresa.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/estoque/pedidoReservaPonteNucleo.js` | Helper exige `empresaId`; consume valida pedido/venda/reserva antes de mutar |
| `tests/estoque/consumo-reserva-pedido-porta-publica.test.js` | Contrato novo do helper; seed de reserva com `empresa_id` |
| `tests/estoque/consumo-reserva-pedido-sem-compat-05-50.test.js` | **Novo** T01–T10 |
| `docs/arquitetura/ELIMINACAO_COMPAT_CONSUMO_RESERVAS_PEDIDO_05_50.md` | Contrato e inventário |
| `docs/arquitetura/RISCOS_ENCONTRADOS_05_50.md` | Riscos fora de escopo |
| este relatório | |

Não alterados: schema, Motor Comercial, Repair, NF-e, DistDFe, FEFO, PDV (fora pedido→reserva→venda), `FaturamentoService` / `VendaPagamentoService` (já passavam empresa; wiring mantido).

## MODELO

```
pedido.empresa_id = reserva.empresa_id = venda.empresa_id = estoque_empresa.empresa_id
```

Fonte da porta: **somente** `pedidos.empresa_id`.

## COMO ERA

Helper montava COMPAT se chamado sem empresa. Consume do pedido já evitava isso no caminho principal, mas o helper não era determinístico.

Divergência reserva×pedido era ignorada (`continue`). Reserva NULL usava a porta do pedido.

## COMO FICOU

Helper: empresa explícita ou `EMPRESA_CONTEXT_REQUIRED`.  
Consume: validações → porta → mutação.  
Caller cruzado: `PEDIDO_NAO_ENCONTRADO` (404).

## COMPAT

- **Eliminado** neste domínio: `COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA` e objeto legado do helper.
- **Mantido** fora do recorte: F×NF/MTS, crédito de venda, PDV `venda_estoque_reservas`, ajuste, compras.

## TESTES (2026-08-25)

| Suite | Resultado |
|-------|-----------|
| `consumo-reserva-pedido-sem-compat-05-50` | 10/10 OK |
| `consumo-reserva-pedido-porta-publica` | 10/10 OK |
| `isolamento-lotes-fefo-reservas-05-47` | 19/19 OK |
| `ownership-pedido-reserva-05-49` | 10 testes OK |
| `reservas-pdv-multiempresa-contexto` | 10/10 OK |
| `disponibilidade-reservas-multiempresa` | 12/12 OK |
| `reserva-repair-porta-publica` | 10/10 OK |
| `venda-baixa-empresa-contexto` | 12/12 OK |
| `rc412-ponte-reserva-pedido-nucleo` | não concluído neste ambiente: o `require` de `FaturamentoService` inicializa o banco oficial e o processo permanece no bootstrap; não é mutação do helper |

## INVARIANTE DESTA SPRINT

Consumo de reserva originada de pedido nunca monta COMPAT. Empresa da porta = `pedidos.empresa_id`, após validar reserva e venda quando existirem.
