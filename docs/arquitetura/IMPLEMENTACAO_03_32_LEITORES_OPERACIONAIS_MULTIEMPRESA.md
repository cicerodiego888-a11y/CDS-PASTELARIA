# Implementação 03.32 — Leitores operacionais restantes → estoque multiempresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Auditoria

Busca no backend por `SELECT` em `produtos` de `saldo_fiscal`, `saldo_nao_fiscal`, `estoque_atual`, `reservado_fiscal`, `reservado_nao_fiscal`.

Já cobertos (03.21–03.24): GET produto, listagem, identificação PDV, disponibilidade de venda no PDV (`VendaPagamentoService`).

## Leitor operacional migrado

`CriarVendaEntregaService.criarVendaEntrega` — `POST /api/vendas` com `tipo_venda=ENTREGA`.

Mesmo ponto de decisão da 03.24: `calcularEstoqueProduto` + Motor F×NF. Overlay via `aplicarSaldosDisponibilidadeVenda` com **somente** `req.empresaId`.

```
req.empresaId
  → aplicarSaldosDisponibilidadeVenda
  → EstoqueEmpresaService.consultarSaldoParaEmpresa
  → calcularEstoqueProduto
```

| Contexto | Origem |
|---|---|
| Sem `req.empresaId` | `produtos` (legado) |
| Com empresa + registro | 5 campos de `estoque_empresa` |
| Com empresa + sem registro | zeros; **não** copia `produtos` |

Fórmulas inalteradas: `estoqueAtual = SF+SNF`, `DF = SF−RF`, `DNF = SNF−RNF`.

## Não migrado

Dashboard, relatórios, CIP, MIB, GET `/codigo/:codigo`, vencimentos, promoções, validação de cancel/devolução de compra (domínio 03.27), `consultarSaldo` da porta (storage oficial `produtos`), Motor Comercial, ReservaRepair, certificações.

Sprint 03.33 **não iniciada**.
