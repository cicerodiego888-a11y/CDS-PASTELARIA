# IMPLEMENTAÇÃO 05.35 — Reaproveitamento do motor de preço atacado

**Classificação:** **ESTADO B** (código + testes automatizados)

---

## Motor reutilizado

| Recurso | Caminho | Uso prévio |
|---------|---------|------------|
| **MotorPrecoAtacado** | `frontend/shared/js/motor-preco-atacado.js` | PDV legado (`pdv/index.html`), ERP produtos/compras |
| **Faixas atacado** | `GET /api/produtos/:id/atacado` | `pdv.js` → `obterPrecoAtacado()` |

Funções delegadas: `calcularLinhaAtacadoFaixa`, `calcularLinhaPrecoUnitarioInformado`, `arredondarMoeda`.

---

## Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/pdv-universal/pdv-universal-preco-atacado.js` | **Novo** — adaptador entrada/saída + cache faixas |
| `frontend/pdv-universal/pdv-universal.js` | Recálculo após add/qty; resumo informativo atacado |
| `frontend/pdv-universal/index.html` | Scripts `motor-preco-atacado.js` + adaptador |
| `tests/pdv-universal/preco-atacado-05-35.test.js` | **Novo** — 12 casos |

`PDVUniversalCart` **não alterado** — recálculo via mutação do item retornado por `localizar()`.

---

## Regras reutilizadas

- Maior faixa atendida (`quantidade_minima` ≤ qty)
- `venda_atacado === 1` no produto/item
- Preço base preservado em `preco_base`; `desconto_atacado` informativo (não desconto manual)
- Identidade `produto_id + empresa_id` intacta
- Ordem: preço comercial → subtotal → desconto manual (05.22) → acréscimo → total

---

## Testes executados

```text
node tests/pdv-universal/preco-atacado-05-35.test.js  → 12/12
node tests/pdv-universal/quantidade-itens-05-26.test.js
node tests/pdv-universal/remocao-manual-item-05-27.test.js
node tests/pdv-universal/venda-peso-05-28.test.js
node tests/pdv-universal/desconto-acrescimo-05-22.test.js
```

---

## Não alterado

Backend vendas, MUV, VAS, motor fiscal, checkout, TEF, PIX, entrega, caixa, PDV legado, novas rotas, novo motor de precificação.

---

## Pendências

- Promoção comercial (legado aplica promo antes de atacado) — fora desta sprint
- Badge visual `ATACADO` na linha do carrinho — opcional
