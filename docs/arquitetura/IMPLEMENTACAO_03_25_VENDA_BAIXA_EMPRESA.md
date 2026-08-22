# Implementação 03.25 — empresaId da venda até a baixa física

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Fluxo real

```
POST /api/vendas
  → criarMiddlewareContextoEmpresa  (req.empresaId)
  → VendaApplicationService.criarVenda
  → VendaPagamentoService.criarVenda
  → montarOpcoesBaixaEstoqueVenda(req)
  → reduzirEstoqueDistribuido(..., opcoesBaixaEstoque)
  → atualizarSaldoProdutoAposBaixa
  → debitarEstoqueItemVenda (02.6)
  → estoqueSaldosPublico.debitarSaldo
  → produtos + dual-write 03.19 em estoque_empresa
```

Única baixa: 02.6. Única porta: `estoqueSaldosPublico`. Sem nova porta.

---

## Onde o contexto se perdia

`reduzirEstoqueDistribuido` já recebia `opcoesBaixaEstoque`, mas `montarOpcoesBaixaEstoqueVenda` lia `empresaIdDoReqOperacional` (body/user se `req.empresaId` fosse nulo). `atualizarSaldoProdutoAposBaixa` ainda encaminhava `contexto`/`ctx`, que a porta podia usar como substituto.

Agora a baixa usa **somente** `req.empresaId` validado. Body/query não substituem.

---

## Sem / com empresa

Sem `req.empresaId`: COMPAT 02.6 (só `produtos`).  
Com empresa: dual-write 03.19 na empresa correta. A não altera B.

---

## Não alterado

Porta, dual-write, schema, reservas, identificação, disponibilidade, motores.
