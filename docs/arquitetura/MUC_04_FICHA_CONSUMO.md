# MUC-04 — Ficha técnica e consumo integrados ao MUC

**Status:** evolui 03.03/03.04; não reconstrói a ficha.  
**Autoridade de conversão:** `obterMuc(db).converterQuantidade`.  
**Autoridade de movimentação:** `debitarEstoqueItemVenda` / crédito de estorno, com `empresa_id` da venda.

---

## Arquitetura

```
Ficha técnica          (insumo, quantidade_ficha, unidade_ficha)
        ↓
Venda                  (quantidade vendida × ficha)
        ↓
MUC                    (origem → destino, relações MUC-03 se flag SIM)
        ↓
quantidade + unidade estoque
        ↓
Estoque da empresa     (venda.empresa_id)
        ↓
Snapshot               (venda_ficha_consumo / itens)
```

Ficha não converte. MotorUM não converte. Estoque não converte. Venda não converte.

---

## Fluxo na venda

Preservado: `POST /api/vendas` → `VendaPagamentoService` → `consumirFichaTecnicaDaVendaCb` na mesma transação (BEGIN…COMMIT; falha → ROLLBACK).

1. Valida venda e baixa o comercial.
2. Calcula consumo via MUC (cache de config por insumo na mesma venda).
3. Valida saldo agregado; se um insumo faltar, nenhum é debitado.
4. Debita insumos (`exigirEmpresa: true`).
5. Grava snapshot.

Ficha inativa ou produto sem ficha: venda normal, sem consumo.

---

## MUC

`converterQuantidade({ quantidade, unidadeOrigem, unidadeDestino, relacoes })`.

- Destino: `unidade_estoque` se `utiliza_conversao = 1`; senão `produtos.unidade`.
- Relações/apresentações: só com flag SIM (MUC-03, `ProdutoConversaoConfigService.montarRelacoesMuc`).
- Flag NÃO + unidades diferentes: só o grafo SI do MUC (ex. G→KG, ML→L). Sem fallback MotorUM.
- UN→UN: identidade; `caminho` vazio. Sem aresta persistida.

Resultado do MUC é a quantidade final. `round3` só no débito/snapshot (contrato 03.04). Não aplicar `/1000` na ficha.

---

## Ficha

Cadastro exige **unidade explícita** por item (`quantidade` + `unidade`). Catálogo compartilhado, sem `empresa_id`.

Validação de código de unidade: MUC (`unidadesSi`); `MotorUnidadesMedida` permanece no cadastro só como catálogo comercial (03.03 T13), não como conversor.

INSUMO continua o único tipo consumível (03.03). COMERCIAL não vira insumo.

---

## Snapshot, cancelamento, devolução

Inalterados funcionalmente (03.07 / 03.08).

Snapshot guarda `quantidade` + `unidade` (estoque) e `quantidade_ficha` + `unidade_ficha`. Cancelamento/devolução usam o snapshot, nunca a ficha vigente.

---

## Multiempresa

Mesma ficha, mesma regra MUC-03. Débito em `venda.empresa_id`. Empresa A não baixa B.

---

## Erros

`CONVERSAO_NAO_DISPONIVEL`, `CONVERSAO_INVALIDA`, `UNIDADE_INVALIDA`, `PRODUTO_SEM_UNIDADE_ESTOQUE`, `FICHA_INSUMO_INATIVO`, `SALDO_INSUFICIENTE`, `INSUMO_NAO_VENDAVEL` (venda). Sem estimar.

---

## MotorUM e legado

| Módulo | Papel após MUC-04 |
|---|---|
| `MotorUnidadesMedida` | Preço, UC, flags de embalagem. `converterQuantidadeEntreUnidades` ainda delega ao MUC para outros consumidores. **Não** é autoridade da ficha/consumo. |
| `motorConversaoUnidades.js` | DEPRECADO. Custo/F-NF no pipeline de compra. Sem novo consumidor. |

---

## Exemplos

- 300 ML, estoque L → 0,3 L
- 80 G queijo, estoque KG → 0,08 KG
- 20 UN laranja, 1 UN = 150 G, estoque KG → 3 KG
- 2 UN / estoque UN → 2 UN
