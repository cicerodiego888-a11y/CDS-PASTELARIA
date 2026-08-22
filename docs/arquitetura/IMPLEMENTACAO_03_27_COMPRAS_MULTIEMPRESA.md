# Implementação 03.27 — compras multiempresa (contexto)

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## 1. Fluxos auditados

| Fluxo | Arquivo / função | Rota | Operação | Porta | db | empresaId antes | req.empresaId | Body/query | COMPAT |
|---|---|---|---|---|---|---|---|---|---|
| Entrada | `processarItensCompra` → `creditarEstoqueItemCompra` | `POST /api/compras` | credita SF/SNF | `creditarSaldo` | TX da rota | `empresaIdDoReqOperacional` | middleware no router | body/user se anexo ausente | `COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA` |
| Cancelamento | `baixarEstoque` → `debitarEstoqueItemCompra` | `POST /api/compras/:id/cancelar` | debita SF/SNF | `debitarSaldo` | `BEGIN IMMEDIATE` | idem | idem | idem | `COMPAT_DEBITO_COMPRA_PRE_MULTIEMPRESA` |
| Devolução | handler devolver | `POST /api/compras/:id/devolver` | debita F-primeiro | `debitarSaldo` | TX da rota | idem | idem | idem | mesmo COMPAT de débito |
| Uso/consumo e NF avulsa | `entradaSimplificada` | `POST /api/compras` | não mexe estoque | — | — | — | — | — | n/a |
| Parse XML | `POST /parse-xml` | 410 | não mexe estoque | — | — | — | — | — | n/a |
| Classificar / MUC / resumo fiscal | POST auxiliares | — | não mexe estoque | — | — | — | — | — | n/a |
| Validação cancel/devolver | SELECT `produtos.estoque_atual` | mesmas rotas | leitura legado | — | — | — | — | — | n/a |
| Central de Entradas | motores/central-entradas | fora de `/compras` | não nesta sprint | — | — | — | — | — | n/a |

---

## 2. Fluxos realmente alterados

Entrada, cancelamento e devolução passam a usar `empresaIdDoReqCompra(req)` (`req.empresaId` apenas).  
Montadores da porta não leem mais `contexto`/`ctx`/objeto inteiro.

```
POST /api/compras
  → criarMiddlewareContextoEmpresa
  → processarItensCompra
  → creditarEstoqueItemCompra
  → estoqueSaldosPublico.creditarSaldo
  → produtos + dual-write 03.19
```

---

## 3. Fluxos já corretos

- Dual-write 03.19 dentro da porta (não recriado).
- `criarMiddlewareContextoEmpresa` já no router de compras.
- Ajax ERP (`core.js`) já envia `X-Empresa-Id`.
- Uma chamada de crédito; dois débitos (cancel + devolver).
- Mesmo `db` da transação do caller.

---

## 4. Fluxos descartados (não escrevem estoque)

Parse XML (410), classificação, simulação MUC, resumo fiscal, entrada simplificada (uso/consumo e NF avulsa), Central de Entradas, NF-e de devolução oficial, PUT chave, financeiro.

XML que vira compra real entra pelo mesmo `POST /api/compras` após a Central — não há segundo escritor.

---

## 5. Limitações restantes

Validação de cancelamento/devolução ainda lê `produtos.estoque_atual`. Alterar isso mudaria a regra de cancelamento.

Candidatos de outro domínio (não nesta sprint): inventário, ajuste administrativo, transferência (MTS), produção.

---

## Autoridade / COMPAT / isolamento

`req.empresaId` prevalece. Sem empresa: só `produtos`. A +10 e B +20 isolados. Rollback externo desfaz `produtos` + `estoque_empresa`.
