# MUC-06 — Consolidação do preview e pré-fill da compra

**Status:** CONCLUÍDA  
**Autoridade de quantidade:** `obterMuc(db).converterQuantidade`

---

## 1. Fluxo anterior

```
UI → muc.simular (multiplicador sem unidades)
     ou motor-quantidade-compra.js (emb × fator)
Pré-fill → obterQuantidadeConvertida (legado)
Persistência → processarItemCompra → MUC
```

Preview e persistência podiam divergir em SI/encadeamento.

---

## 2. Fluxo novo

```
Usuário informa quantidade + origem + destino
        ↓
POST /api/compras/simular-conversao-muc
        ↓
simularConversaoCompraPreview → obterMuc().converterQuantidade
        ↓
Preview (caminho real do MUC)
        ↓
processarItemCompra (mesmas unidades/relações)
        ↓
quantidadeEstoque
        ↓
legado: custo / F/NF (recebe quantidade já convertida)
```

---

## 3. Endpoint de preview

`POST /api/compras/simular-conversao-muc`

Implementação: `backend/services/compras/simularConversaoCompraPreview.js`  
A rota **não** calcula. **Não** chama `muc.simular` sem unidades.

---

## 4. Parâmetros

Campos novos (preferenciais) e aliases compatíveis:

| Oficial | Alias aceitos |
|---------|----------------|
| `produtoId` | `produto_id` |
| `quantidade` | `quantidadeCompra`, `quantidade_embalagens`, `quantidade_comercial` |
| `unidadeOrigem` | `unidade_origem`, `unidadeCompra`, `compra_em` |
| `unidadeDestino` | `unidade_destino`, `unidadeEstoque`, `unidade` |
| `relacoes` | — |
| `quantidadePorApresentacao` | `quantidade_por_embalagem` (só vira relação origem→UN se origem for embalagem) |
| `valorTotal` | `valor_total_embalagem` (custo, não conversão) |

Sem origem **e** destino: `UNIDADES_NAO_INFORMADAS`.  
Não substitui por `qtd × fator`.

Produto com `utiliza_conversao = 0`: só identidade se origem == destino. Sem relação artificial UN→UN.

---

## 5. Retorno

```json
{
  "success": true,
  "resultado": {
    "sucesso": true,
    "quantidade": 12,
    "unidadeOrigem": "CAIXA",
    "unidadeDestino": "ML",
    "quantidadeConvertida": 288000,
    "quantidadeEstoque": 288000,
    "unidade": "ML",
    "caminho": [{ "de": "CAIXA", "para": "UN", "fator": 12 }, ...],
    "caminhoTexto": "12 CAIXA → 144 UN → 288000 ML",
    "fatorTotal": 24000,
    "custoUnitario": 0
  }
}
```

Erro:

```json
{
  "success": false,
  "codigo": "UNIDADES_NAO_INFORMADAS",
  "error": "...",
  "mensagem": "..."
}
```

Códigos: `UNIDADES_NAO_INFORMADAS`, `QUANTIDADE_INVALIDA`, `UNIDADE_INVALIDA`, `PRODUTO_INEXISTENTE`, `CONVERSAO_NAO_DISPONIVEL`, `CONVERSAO_INVALIDA`, `CONVERSAO_CICLO`.

---

## 6. Pré-fill

`processarItensCompra` **não** preenche `quantidade_convertida` / `peso_total_compra` via `obterQuantidadeConvertida`.  
A quantidade oficial nasce em `processarItemCompra` → `resultadoMuc.quantidadeEstoque`.

---

## 7. MotorConversaoCalculo

1. `converterQuantidade` → `qtdMuc`  
2. Item legado recebe `quantidade_convertida = qtdMuc`  
3. F/NF e custo usam essa quantidade  
O legado **não** recalcula a quantidade oficial.

---

## 8. Frontend

- `compra-muc-client.js` envia origem/destino/`produtoId`; propaga `codigo` de erro.  
- `compras.js` exibe `caminhoTexto` do MUC; sem fallback silencioso.  
- `motor-quantidade-compra.js` só lê `quantidade_convertida` já calculada. Não multiplica embalagem.

---

## 9. Funções legadas mantidas

- `obterQuantidadeConvertida` (backend) — consumidores de custo/F/NF/testes rc43119  
- `simularConversaoEmbalagem` — helper de custo de `muc.simular` (contrato RC2.1)  
- `resolverCustoUnitario*`, `calcularSubtotalFinanceiroItemCompra`, `resolverQuantidadesCompraItem`  
- `muc.simular()` sem unidades — API pública RC2.1 (não é o preview da compra)

---

## 10. Funções sem consumidores no fluxo oficial de compra

- Pré-fill por `obterQuantidadeConvertida` na rota — **removido**  
- Multiplicador no `motor-quantidade-compra.js` — **removido**  
`obterQuantidadeConvertida` no lib permanece (candidato futuro, ainda tem testes/custo).

---

## 11. Testes

`tests/muc/muc-06-preview-compra.test.js` — T01–T12 + wiring.

---

## 12. Riscos

- Cliente antigo que chamava o endpoint só com `quantidade_embalagens` × fator recebe erro explícito (esperado).  
- `muc.simular()` público continua com multiplicador (compat RC1); a UI de compra não usa mais esse caminho.  
- Importação inicial **não** alterada.
