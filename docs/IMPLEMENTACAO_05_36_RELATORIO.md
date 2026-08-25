# IMPLEMENTAÇÃO 05.36 — Reaproveitamento da promoção comercial

**Classificação:** **ESTADO B** (código + testes automatizados)

---

## Mecanismo reutilizado

| Recurso | Caminho / contrato | Uso prévio |
|---------|-------------------|------------|
| **Consulta promoção ativa** | `GET /api/produtos/:id/promocao-ativa` | `frontend/pdv/js/pdv.js` → `buscarPromocaoAtivaProduto()` |
| **Regra de elegibilidade** | Inline no PDV legado (`adicionarItemNoCarrinho`) | Exclui venda por unidade e etiqueta de balança |
| **MotorPrecoAtacado** | `frontend/shared/js/motor-preco-atacado.js` | Segunda etapa após promoção (Sprint 05.35) |

Não existe motor separado de promoção — a vigência (`status`, `data_inicio`, `data_fim`) é filtrada pela API; o adaptador confia no retorno oficial.

---

## Regra oficial de precedência (PDV legado)

```
preço cadastro (preco_base)
    → promoção comercial (preco_promocional)
    → atacado (min entre preço pós-promo e preço da faixa)
    → subtotal do item
    → desconto manual (05.22)
    → acréscimo
    → total
```

Comentário no legado (`pdv.js` ~2993): *"calcula preco final considerando promoção primeiro, depois atacado (se mais vantajoso)"*.

---

## Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/pdv-universal/pdv-universal-promocao.js` | **Novo** — adaptador API + campos informativos |
| `frontend/pdv-universal/pdv-universal-preco-atacado.js` | `precoOriginal` vs `precoComercial` (paridade legado) |
| `frontend/pdv-universal/pdv-universal.js` | `recalcularPrecoComercialItem`; resumo `desconto_promocao` |
| `frontend/pdv-universal/index.html` | Script do adaptador |
| `tests/pdv-universal/promocao-comercial-05-36.test.js` | **Novo** — 13 casos |

---

## APIs reutilizadas

- `GET /api/produtos/:id/promocao-ativa` — promoção vigente (sem nova rota)
- `GET /api/produtos/:id/atacado` — inalterada (05.35)

---

## Campos no item (distintos do desconto manual)

- `preco_base` — preço cadastro
- `promocao_id`, `desconto_promocao` — promoção informativa
- `desconto_atacado`, `tipo_preco` — atacado (05.35)
- desconto/acréscimo operacional — Sprint 05.22 (inalterado)

---

## Testes executados

```text
node tests/pdv-universal/promocao-comercial-05-36.test.js
node tests/pdv-universal/preco-atacado-05-35.test.js
node tests/pdv-universal/quantidade-itens-05-26.test.js
node tests/pdv-universal/remocao-manual-item-05-27.test.js
node tests/pdv-universal/venda-peso-05-28.test.js
node tests/pdv-universal/desconto-acrescimo-05-22.test.js
```

---

## Não alterado

Backend vendas, MUV, VAS, motor fiscal, checkout, TEF, PIX, entrega, caixa, PDV legado, `MotorPrecoAtacado`, tabelas/rotas de promoção, `PDVUniversalCart`.

---

## Pendências reais

- Badge visual `PROMO` / `ATACADO` na linha do carrinho — opcional
- Promoção por empresa (API atual filtra só `produto_id`) — comportamento herdado do legado
- Validação manual em ambiente real (ESTADO A) — quando disponível
