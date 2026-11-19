# REGRESSÃO E ESCOPO — Sprint 02

Inspeção em 2026-11-16 via `git status` / `git diff --name-only` na working tree.

---

## Arquivos alterados / novos relacionados à Cozinha

| Arquivo | Origem |
|---|---|
| `backend/server.js` | Modificado (+ require + `app.use('/api/cozinha', …)`) — Sprint 02 |
| `backend/rotas/cozinha.js` | **Novo** — Sprint 02 |
| `backend/services/cozinha/CozinhaDespachoService.js` | **Novo** — Sprint 02 |
| `backend/services/cozinha/cozinhaIdempotenciaHash.js` | Novo no git (fundação S01 + ajuste hash S02) |
| `backend/services/cozinha/cozinhaQuantidade.js` | Novo no git — Sprint 01 |
| `backend/utils/cozinhaSchema.js` | Novo no git — Sprint 01 |
| `backend/database.js` | Modificado — wiring schema Cozinha (**Sprint 01**, não despacho) |
| `tests/cozinha/*` | Novos — S01 + S02 |

Nenhuma alteração em módulos fora dessa lista foi necessária para o despacho.

---

## Confirmação de intocados (inspeção)

| Módulo / arquivo | Status no diff da working tree |
|---|---|
| PDV (`frontend/pdv`, rotas/serviços PDV de fechamento) | **Sem alteração listada** para esta Sprint |
| `PedidoPdvComposicaoService.js` | **Intocado** (não aparece em `git status` modificado) |
| `FichaTecnicaService.js` (`backend/services/produtos/FichaTecnicaService.js`) | **Intocado** |
| Estoque (`backend/services/estoque`, rotas estoque) | **Intocado** |
| Fiscal (`backend/rotas/fiscal.js` e afins) | **Intocado** |
| TEF (`backend/rotas/tef.js` / services) | **Intocado** |
| PIX (`backend/rotas/pix.js` / services) | **Intocado** |

`git status --short` filtrado para esses caminhos não retornou modificações pendentes atribuíveis à Sprint 02.

---

## Limites respeitados

- Sem tela KDS / impressão / SSE / Android / bebidas / retirada / entrega mesa.
- Sem movimentação de estoque ou ficha técnica no serviço de despacho.
- Sem operações fiscais / TEF / PIX.
- Testes apenas em banco temporário.
- Sprint 03 **não** iniciada nesta auditoria nem na implementação S02 auditada.

---

## Nota sobre `backend/database.js`

Há diff pendente em `database.js` relativo ao **init do schema Cozinha (Sprint 01)** (`garantirSchemaCozinha`, flag operacional). Não faz parte da lógica de despacho FIFO da Sprint 02, mas permanece no working tree. Diff completo de despacho S02: `DIFF-SPRINT02.patch` (foco server + serviço + rota + hash + testes S02).
