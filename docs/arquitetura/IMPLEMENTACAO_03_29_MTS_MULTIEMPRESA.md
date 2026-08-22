# Implementação 03.29 — MTS / transferências multiempresa

**Status:** concluída (auditoria + testes; motor intacto) · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## 1. O que o MTS é de fato

Motor de Transferência de Saldos **Fiscal ↔ Não Fiscal no mesmo produto**.

Não é transferência entre empresas, filiais ou CNPJs. Origem/destino no contrato são tipos de saldo (`FISCAL` | `NAO_FISCAL`), não `empresaId`.

Não existe rota HTTP `/api/mts`. Único caller operacional: Motor Comercial (`executarConfirmacaoFiscal` → `mts.transferirSaldo`).

---

## 2. Fluxos auditados

| Fluxo | Origem | req.empresaId | Middleware | Até o service | Até a porta | db / TX | empresa origem/destino | Fallback |
|---|---|---|---|---|---|---|---|---|
| `MtsService.transferirSaldo` | API interna | n/a (não HTTP) | n/a | `params.empresaId` via `resolverEmpresaId(params)` | `debitarSaldo` + `creditarSaldo` (opts com `empresaId`) | `deps.db` ou default; TX da porta ou `jaEmTransacao` | **a mesma** empresa (F↔NF) | `COMPAT_CERTIFICADA_PRE_MULTIEMPRESA` se `modoLegadoSemEmpresa` |
| Motor Comercial | Pedido | lê `resolverEmpresaId(params)` | — | `empresaId: portaOpts.empresaId` | MTS + reservas | TX F×NF | mesma | COMPAT se params sem empresa |
| `PedidoOperacionalService` | `POST /api/pedidos` etc. | **não anexado** (router sem middleware) | nenhum | `confirmarPedidoFiscal` **sem empresaId** | COMPAT | db padrão | — | COMPAT certificado |
| `PedidoService.criarPedido` | `POST /api/faturamento/pedidos` | **não passa** | nenhum | idem | COMPAT | db padrão | — | COMPAT |
| Consulta auditoria | `consultarTransferencia` | n/a | n/a | SELECT `movimentos_transferencia_saldos` | não muta saldo | deps.db | n/a | n/a |
| Porta `transferirSaldoEntreTipos` | testes da porta | n/a | n/a | — | débito+crédito interno | opts.db | mesma empresa F↔NF | — |

MTS **não** usa `reservasPublico`. **Não** faz `UPDATE produtos`. Dual-write 03.19 fica na porta.

---

## 3. Regra de parada

O motor já recebe `empresaId` no contrato e entrega à porta. Body/query/user aninhados **não** substituem `params.empresaId`. Sem empresa + flag COMPAT: só `produtos`.

**Nenhuma alteração no motor, no Motor Comercial, nem em Pedido.** Mudar Pedido/Faturamento seria outro domínio (orquestração HTTP), fora desta sprint.

---

## 4. Ponto propositalmente não alterado

Pedido e Expedição confirmam estoque sem `empresaId`. Na prática, transferências disparadas por pedido hoje caem no COMPAT (somente `produtos`). Isolamento em `estoque_empresa` via MTS só ocorre quando o caller informa `empresaId` (contrato já suportado pelo Motor Comercial).

Candidato futuro (não 03.29): contexto HTTP de Pedido → `confirmarPedidoFiscal({ empresaId })`.
