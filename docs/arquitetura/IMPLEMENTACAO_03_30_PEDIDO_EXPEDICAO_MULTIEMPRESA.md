# Implementação 03.30 — Pedido / Expedição → Motor Comercial (contexto)

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## 1. Fluxo real encontrado

```
HTTP (X-Empresa-Id)
  → criarMiddlewareContextoEmpresa  (antes ausente nesses routers)
  → empresaIdDoReqPedido(req)       (só req.empresaId)
  → PedidoOperacionalService / PedidoService
  → Motor Comercial (já aceitava params.empresaId — 03.29)
  → MTS (intacto)
  → estoqueSaldosPublico + dual-write 03.19
```

MTS continua Fiscal ↔ Não Fiscal no **mesmo** produto/empresa.

---

## 2. Onde empresaId se perdia

Routers de `/api/pedidos` e `/api/faturamento` **não** tinham middleware de empresa.  
Services chamavam `confirmarPedidoFiscal` / `analisarDisponibilidadeFiscal` / `liberarReservasDoPedido` **sem** `empresaId`.  
O Motor Comercial caía em `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA`. O MTS recebia `empresaId` vazio.

---

## 3. Escritores alterados

| Fluxo | Rota | Service | Motor Comercial |
|---|---|---|---|
| Criar pedido | POST `/api/pedidos` | `criar` | análise + confirmar + liberar (erro) |
| Atualizar | PUT `/api/pedidos/:id` | `atualizar` | análise + confirmar |
| Cancelar | POST `/api/pedidos/:id/cancelar` | `cancelar` | liberar reservas |
| Duplicar | POST `/:id/duplicar` | `duplicar` → `criar` | mesmo criar |
| Converter orçamento | POST `/:id/converter` | `converterParaPedido` | confirmar + liberar (erro) |
| Enviar expedição | POST `/:id/enviar-faturamento` | `enviarParaFaturamento` | confirmar |
| Criar fila Expedição | POST `/api/faturamento/pedidos` | `PedidoService.criarPedido` | análise + confirmar + liberar (erro) |

---

## 4. Descartados

GET listagens. `POST /faturar` (Núcleo/venda, sem Motor Comercial). Emissão NF-e. Orçamento puro (não confirma estoque). MTS. Motor Comercial. Porta. Dual-write.

---

## 5. Autoridade / COMPAT

`empresaIdDoReqPedido(req)` = somente `req.empresaId`. Sem empresa: COMPAT já existente no Motor Comercial / MTS. Sem empresa 1. Sem CNPJ.

ERP já envia `X-Empresa-Id` via `ajaxSetup`.
