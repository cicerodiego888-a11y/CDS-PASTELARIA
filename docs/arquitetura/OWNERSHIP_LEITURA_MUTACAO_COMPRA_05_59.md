# Ownership leitura e mutação da compra — Sprint 05.59

**Status:** implementado  
**Data:** 2026-08-29  
**Escopo:** `GET /api/compras/:id`, `POST /:id/cancelar`, `POST /:id/devolver`.  
Não altera `POST /` (criação), Central, nem `PUT /:id/chave-nfe-fornecedor` (05.58).

## Risco 05.57

Load por ID + `exigirCompraDaEmpresa` → **403** `COMPRA_EMPRESA_INCOMPATIVEL`. O caller confirmava que a compra existia em outra empresa.

## 05.58

O PUT da chave já respondia **404** `COMPRA_NAO_ENCONTRADA` via `exigirCompraParaMutacaoOpaca`.

## Padronização 05.59

GET, cancelar e devolver usam o **mesmo** wrapper:

| Situação | Código | HTTP |
|----------|--------|------|
| Mesma empresa | segue o fluxo | 200 / efeito da operação |
| Outra empresa | `COMPRA_NAO_ENCONTRADA` | 404 |
| ID inexistente (nessas rotas) | `COMPRA_NAO_ENCONTRADA` | 404 |
| `empresa_id` NULL | `EMPRESA_OWNERSHIP_REQUIRED` | 409 |

Corpo de erro: `{ error, code }` — sem fornecedor, chave, empresa da compra, status ou valores.

## Fonte

`compras.empresa_id` determina. `req.empresaId` autoriza. Sem COMPAT, sem contexto como dono no NULL. GET em EMPRESA_SIMPLES **não** trata legado NULL como da empresa operacional (`permitirLegadoSimples` removido nestas rotas).

## Helper

`exigirCompraDaEmpresa` (403 interno) permanece.  
`exigirCompraParaMutacaoOpaca` remapeia para 404/409.  
`carregarCompraAutorizada` / `jsonErroCompraOpaca` para GET e respostas HTTP.

PUT chave: inexistente continua `COMPRA_AUSENTE` (05.58).
