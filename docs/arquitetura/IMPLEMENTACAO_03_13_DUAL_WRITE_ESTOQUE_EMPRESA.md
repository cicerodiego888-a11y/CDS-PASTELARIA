# Implementação 03.13 — primeiro dual-write controlado

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Fluxo escolhido

**CREATE de produto / saldo inicial** (Sprint 03.8).

| Item | Valor |
|---|---|
| Arquivo | `backend/services/ajusteEstoqueService.js` |
| Método | `aplicarSaldoInicialCreateProduto` |
| Quando | após INSERT zerado no `POST /` de `rotas/produtos.js`, se SF ou SNF > 0 |
| Escrita hoje | `estoqueSaldosPublico.creditarSaldo` → `produtos` |
| empresaId | `opts` / `req` / body / user; senão `COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA` |
| db | injetável (mesmo do caller) |
| Transação | sem BEGIN próprio |

**Por quê:** único escritor pequeno, isolado, já na porta, fora de compra/venda/PDV/reserva.

---

## Antes / depois

Antes:

```
CREATE saldo inicial → porta pública → produtos
```

Depois:

```
CREATE saldo inicial → porta pública → produtos
                      + EstoqueEmpresaService → estoque_empresa  (só com empresaId)
```

`produtos` continua storage oficial. Nenhuma leitura operacional usa `estoque_empresa`.

---

## estoque_empresa

Via `EstoqueEmpresaService.aplicarEfeitoSaldo`:

1. se não existe → `criarRegistro` em **zero**
2. aplica somente o crédito da operação atual

Sem copiar saldo de `produtos`. Sem backfill.

Sem `empresaId` (COMPAT): **não** grava `estoque_empresa`. Não inventa empresa 1 / CNPJ.

---

## O que NÃO foi feito

Compra, venda, PDV, reservas, motores, Repair, lotes, TEF, porta pública, backfill.
