# Implementação 03.31 — Auditoria de fechamento dos escritores operacionais

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Objetivo

Fechar o mapa dos escritores operacionais de estoque antes da transição gradual de leitura/operação de `produtos` para `estoque_empresa` (03.32 — **não iniciada**).

Classificar cada ocorrência. Corrigir somente Classe B do mesmo domínio. Não inventar produção, conversão ou contexto.

---

## Auditoria sistemática

Busca no backend por `estoqueSaldosPublico`, `reservasPublico`, `creditarSaldo`, `debitarSaldo`, `reservarQuantidade`, `liberarQuantidadeReservada`, colunas de saldo/reserva, `UPDATE`/`INSERT` em `produtos`, e callers indiretos (Motor Comercial, MTS, ajuste, portas de compra/venda, CREATE).

Domínios procurados e **inexistentes** como escritor de estoque:

- produção / ficha técnica / consumo de insumos
- transformação (débito de um produto + crédito de outro)
- conversão MUC gravando saldo (MUC só calcula fator; crédito de compra já estava na porta)
- Central de Entradas gravando saldo

---

## Domínio Classe B corrigido

Único domínio pendente com contexto HTTP disponível e perda antes da porta:

**retorno de estoque de venda** (cancelamento, devolução administrativa, autorização e cancelamento de NF-e de devolução).

```
req.empresaId
  → rotas/vendas.js
  → montarOpcoesRetornoEstoqueVenda / emitirNFeDevolucaoVenda / cancelarNfeDevolucaoOficial
  → creditarEstoqueItemVenda | retornarEstoqueNfeDevolucaoVenda | reverterEstoqueNfeDevolucaoVenda
  → estoqueSaldosPublico
  → produtos + dual-write 03.19
```

Antes: `empresaIdDoReqOperacional` lia body/user; NF-e autorizada chamava `devolverSaldosDistribuidos` sem `empresaId`; revert lia `contexto`/`ctx`.

---

## Sem / com empresa

Sem `req.empresaId`: COMPAT 02.5 / 03.5 (só `produtos`).  
Com empresa: dual-write na empresa correta. A não altera B.

Não se inventou empresa 1. Não se usou CNPJ.

---

## Porta

Única porta de saldo: `estoqueSaldosPublico`. Dual-write permanece dentro da porta (03.19). Sem porta nova. Sem SQL direto novo.

---

## Produção / transformação

Não há fluxo real. Nada foi criado.

---

## Não alterado

MTS, Motor Comercial, Motor Fiscal/Não Fiscal, regras F/NF, PDV, compras, baixa de venda 03.25, reservas 03.26, schema `estoque_empresa`, backfill, dual-write, leitura oficial.
