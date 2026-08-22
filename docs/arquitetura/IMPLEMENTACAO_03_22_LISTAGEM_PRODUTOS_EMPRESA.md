# Implementação 03.22 — listagem de produtos por empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Rota

`GET /api/produtos`

`req.empresaId` do middleware opcional 03.19.

---

## Sem empresa

Consulta legada: `SELECT p.*` … `ORDER BY p.id DESC`. Filtro `modo_fiscal` inalterado.

---

## Com empresa

`LEFT JOIN estoque_empresa` em `produto_id` + `empresa_id`.  
SF, SNF, EA, RF e RNF vêm de `COALESCE(..., 0)`. Cadastro continua em `produtos`. Uma consulta, sem N+1.

---

## Sem registro

Cinco campos = 0. Não copia o saldo legado.

---

## Isolamento / filtros

A e B isoladas. `filtroFiscal` e `ORDER BY p.id DESC` preservados.

---

## Storage legado

Porta, PDV, GET `/:id` (03.21) e writers intactos. `produtos` permanece storage oficial dos demais fluxos.
