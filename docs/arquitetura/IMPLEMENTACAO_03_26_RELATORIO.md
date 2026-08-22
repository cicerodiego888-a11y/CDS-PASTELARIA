# Relatório — Implementação 03.26
## Reservas PDV multiempresa (propagação de req.empresaId)

**Data:** 2026-08-21 · **Status:** concluída

---

## Fluxo real / callers

| Caller | Reserva PDV? |
|---|---|
| `POST /api/vendas` ENTREGA → `reservarItem` | criar |
| `DELETE /api/vendas/:id/entrega` → `liberarReservasDaVenda` | liberar/cancelar |
| `POST /api/vendas/:id/prestacao` → `consumirReservasDaVenda` | liberar reservado (consumo) |

---

## Origem do empresaId

`req.empresaId` (middleware 03.19).  
`montarOptsPortaReservaPdv` / `empresaIdDoReqReservaPdv` não leem mais body/query/`extrairEmpresaIdDeReq`.

---

## Ponto perdido

Body/user preenchiam a reserva quando o header existia. Prestação/cancelamento não anexavam contexto. O PDV de entrega não enviava `X-Empresa-Id`.

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `EstoqueReservaService.js` | `req.empresaId` único; sem body/query/ctx |
| `CriarVendaEntregaService.js` | `empresaIdDoReqReservaPdv(req)` |
| `rotas/entregas.js` | middleware nas rotas de prestação/cancel |
| `EntregaController.js` / `EntregaService.js` / `MotorFinalizacaoVenda.js` | `req` até a liberação |
| `pdv-venda-entrega.js` / `pdv-prestacao-entrega.js` | header `X-Empresa-Id` |

Não alterados: porta, dual-write 03.20, 03.25, motores.

---

## Com / sem empresa / body

Sem empresa: COMPAT.  
Com empresa: dual-write 03.20 na empresa do contexto.  
Header A + body B: reserva em A.

---

## Testes / regressão

`reservas-pdv-multiempresa-contexto.test.js`: 10/10 OK.

| Suite | Resultado |
|---|---|
| `reservas-pdv-multiempresa-contexto.test.js` | 10/10 OK |
| `reservas-pdv-porta-publica.test.js` (02.7) | 11/11 OK |
| `reservas-dual-write-empresa.test.js` (03.20) | 12/12 OK |
| `venda-baixa-empresa-contexto.test.js` (03.25) | 12/12 OK |
| `porta-publica-saldos-multiempresa.test.js` | 17/17 OK |
| `mts-v1.test.js` | homologado |
| `muc-public-contract.test.js` | 20/20 OK |

---

Não iniciar 03.27.
