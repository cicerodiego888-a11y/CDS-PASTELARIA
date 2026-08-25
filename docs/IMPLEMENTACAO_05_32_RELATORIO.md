# IMPLEMENTAÇÃO 05.32 — meta.peso da identificação no carrinho Universal

**Tipo:** implementação cirúrgica (Auditoria A1 — P1.4)  
**Classificação:** **ESTADO B** (código + testes automatizados; sem validação manual com MIP real)

---

## 1. Arquivos alterados

| Arquivo | Alteração |
|---------|-----------|
| `frontend/pdv-universal/pdv-universal-identificacao.js` | `resolverQuantidadeOperacional`, `parseMetaPeso`, `produtoEhFracionado`; fluxo MIP e etiqueta usam prioridade unificada |
| `tests/pdv-universal/meta-peso-identificacao-05-32.test.js` | **Novo** — 8 casos |

`pdv-universal.js` e `PDVUniversalCart` **não alterados** — já consomem `resolucao.quantidade`.

---

## 2. Origem existente reutilizada

- **`POST /api/produtos/identificar`** — campo `meta.peso` já retornado pelo MIP/backend
- **`arredQtd3`** — mesma precisão de 3 casas da Sprint 05.28 (já presente no adaptador)
- **Flags fracionado** — `produto_fracionado` / `produto_pesavel` / `vendido_por_peso` (regra do cart 05.28, replicada localmente sem alterar o cart)

---

## 3. Regra de prioridade da quantidade

```
1. quantidade da etiqueta de balança (ETIQUETA_*)
        ↓ se não houver
2. meta.peso (produto fracionado/pesável, > 0, numérico válido)
        ↓ se não aplicável
3. quantidade = 1
```

`meta.quantidadeOrigem` indica `ETIQUETA_*`, `META_PESO` ou omitido quando padrão.

---

## 4. Testes executados

```text
node tests/pdv-universal/meta-peso-identificacao-05-32.test.js  → 8/8
node tests/pdv-universal/venda-peso-05-28.test.js               → (regressão)
node tests/pdv-universal/busca-identificacao-05-21.test.js      → (regressão)
node tests/pdv-universal/etiqueta-balanca-integracao.test.js     → (regressão)
```

---

## 5. O que não foi alterado

- Backend / `POST /api/produtos/identificar`
- Parser de etiqueta / motor equipamentos
- `PDVUniversalCart`, checkout, TEF, PIX
- MUV, VAS, motor fiscal, PDV legado
- Novos endpoints ou campos de produto
