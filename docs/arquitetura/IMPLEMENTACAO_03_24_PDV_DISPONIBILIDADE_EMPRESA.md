# Implementação 03.24 — disponibilidade de estoque PDV por empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Ponto real de validação

Não é um motor novo. A decisão de “pode vender?” no PDV ocorre em duas camadas:

1. **UX do carrinho** — `validarEstoqueVenda` / `pdvValidarEstoqueVenda` em `frontend/pdv/js/pdv.js` (saldos já isolados pela 03.23).
2. **Autoridade no backend** — `VendaPagamentoService`:
   - `preCalcularDistribuicao` (`POST /api/vendas/pre-calcular-distribuicao`)
   - `criarVenda` (`POST /api/vendas`)

Ambos carregavam SF/SNF/EA/RF/RNF de `produtos` e alimentavam `calcularEstoqueProduto` + `saldosParaDistribuicaoVenda` + Motor F×NF.

---

## Saldos considerados

Fórmula existente (`calcularEstoqueProduto`):

- `disponivel_fiscal = max(0, SF − RF)`
- `disponivel_nao_fiscal = max(0, SNF − RNF)`
- `disponivel_total = DF + DNF`

Reservas **não** foram migradas; a regra atual foi preservada. Só a origem dos cinco campos muda.

---

## Origem

| Contexto | Origem |
|---|---|
| Sem `req.empresaId` | `produtos` (legado) |
| Com empresa + registro | `estoque_empresa` via `consultarSaldoParaEmpresa` |
| Com empresa + sem registro | zeros explícitos; venda indisponível |

Sem fallback para o saldo legado. Sem escrita nesta validação.

---

## Isolamento

Empresa A (SF=10) permite qty 5. Empresa B (SF=3) bloqueia qty 5. Uma não usa o saldo da outra.

---

## Não alterado

Porta pública, dual-write, baixa 02.6, reservas 02.7, GET produtos, identificação 03.23, motores, schema.
