# Implementação 03.26 — reservas PDV multiempresa (contexto)

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Fluxo real (auditoria)

```
Criar reserva (PDV entrega)
  POST /api/vendas  (tipo_venda = ENTREGA)
    → criarMiddlewareContextoEmpresa  (req.empresaId)
    → VendaPagamentoService.criarVenda
    → CriarVendaEntregaService.criarVendaEntrega
    → EstoqueReservaService.reservarItem
    → reservasPublico.reservarQuantidade
    → produtos + dual-write 03.20 em estoque_empresa

Liberar reserva (cancelar entrega)
  DELETE /api/vendas/:id/entrega
    → criarMiddlewareContextoEmpresa  (req.empresaId)
    → EntregaController.cancelarEntrega
    → MotorFinalizacaoVenda.cancelarEntregaMotor
    → liberarReservasDaVenda
    → reservasPublico.liberarQuantidadeReservada

Consumir reserva (prestação)
  POST /api/vendas/:id/prestacao
    → criarMiddlewareContextoEmpresa
    → MotorFinalizacaoVenda.finalizarPrestacao
    → consumirReservasDaVenda
    → reservasPublico.liberarQuantidadeReservada
    (baixa física permanece 02.6 / 03.25 — fora desta sprint)
```

Única porta de reserva: `reservasPublico`. Sem nova porta. Sem recriar dual-write 03.20.

---

## Onde o contexto se perdia

1. `pdv-venda-entrega.js` — `POST /vendas` sem `X-Empresa-Id`.
2. `CriarVendaEntregaService` — `empresaId` vinha de body/user, ignorando `req.empresaId`.
3. `rotas/entregas.js` — prestação/cancelamento montados fora de `vendas.js`, sem middleware de empresa.
4. `cancelarEntregaMotor` — recebia só `contextoAuditoria` (sem `empresaId`).
5. `montarOptsPortaReservaPdv` — podia ler body/query/`contexto`/`ctx` via `extrairEmpresaIdDeReq`.

---

## Autoridade

`req.empresaId` validado. Body, query, `contexto`, `ctx` e CNPJ não substituem.

Sem `req.empresaId`: COMPAT (`COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA`) — só `produtos`. Sem empresa 1. Sem CNPJ.

---

## Isolamento

Empresa A reserva 3 → `estoque_empresa[A].reservado_* += 3`. Empresa B intacta.  
Empresa A libera 3 → somente A decrementa.

---

## Não alterado

Cálculo de reserva, dual-write 03.20, baixa 02.6, venda 03.25, `estoqueSaldosPublico`, ReservaRepairService, consumo de pedido 03.6, motores, MTS, MUC, lotes, backfill, leitura, CREATE de produto.
