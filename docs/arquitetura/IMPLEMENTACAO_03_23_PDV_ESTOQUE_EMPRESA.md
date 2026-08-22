# Implementação 03.23 — PDV identificação com estoque por empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Fluxo real encontrado

O PDV identifica produto por:

1. `POST /api/produtos/identificar` (também `GET`)
2. `PdvProdutoIdentificacaoService.identificar` → MIP (`ProdutoIdentidadeService`)
3. Frontend: `frontend/pdv/js/pdv.js` (`identificarProdutoViaMip`) e `frontend/shared/js/pdvBuscaProduto.js`

O catálogo MIP devolve dados comerciais (`id`, `codigo`, `nome`, `preco_venda`, …) **sem** os 5 saldos. O carrinho combinava o id MIP com o cache de `GET /api/produtos`.

Não foi criado endpoint novo.

---

## Como `req.empresaId` chega

- Router `produtos.js` já usa o middleware opcional 03.19 (`criarMiddlewareContextoEmpresa`).
- O `fetch` do PDV passou a enviar `X-Empresa-Id` via `CdsEmpresaContexto.headersJson()`.
- Overlay usa **somente** `req.empresaId`. Body/query não substituem o contexto.

---

## Comportamento

| Contexto | Saldos |
|---|---|
| Sem `req.empresaId` | Payload MIP inalterado (legado; catálogo sem saldos) |
| Com empresa + registro | 5 campos de `estoque_empresa` |
| Com empresa + sem registro | 5 campos = 0; **não** copia `produtos` |

Nome, preço, código, barras, PLU e demais dados comerciais continuam globais em `produtos`.

---

## Isolamento / fallback

Empresa A (SF=10) e B (SF=25) no mesmo produto: cada PDV vê só o próprio saldo. Sem fallback silencioso para o saldo legado.

---

## Não alterado

Porta pública, dual-write 03.19/03.20, GET `/:id` (03.21), listagem (03.22), writers, baixa, reservas 02.7, motores, schema.
