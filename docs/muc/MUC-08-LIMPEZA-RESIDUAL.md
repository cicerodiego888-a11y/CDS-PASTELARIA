# MUC-08 — Limpeza residual, consolidação e fechamento

**Status:** CONCLUÍDA  
**Motor:** MUC RC3.0 — CONSOLIDADO  
**Regra:** remover somente C (sem consumidores). Depreciar D. Manter B. Não alterar regras homologadas.

## 1. Objetivo

Fechar o ciclo MUC-01 a MUC-07: auditar wrappers residuais, eliminar código morto comprovado, documentar compatibilidades e declarar RC3.0 **somente** na ausência de conversor operacional concorrente.

## 2. Itens auditados

`obterQuantidadeConvertida`, `simularConversaoEmbalagem`, `converterQuantidadeEntreUnidades`, `converterQuantidade`, `processarItemCompra` / `processarItensCompra`, `calcularEstoqueInicial`, `fator_conversao` / `fatorConversao`, `FATOR_UNIDADE_BASE`, `listarUnidadesComerciais`, `exigeQuantidadePorEmbalagem`, `MotorUnidadesMedida`, `motorConversaoUnidades`, `motor-quantidade-compra`, `unidade_origem`/`destino`/`compra`/`estoque`, `quantidadeEstoque`, fórmulas `*1000`/`/1000` (contexto), `if (unidade === 'KG'|…)` / `switch (unidade)`.

## 3. Itens removidos (C)

| Item | Motivo |
|------|--------|
| `FATOR_UNIDADE_BASE` | Constante SI morta; catálogo vive em `unidadesSi.js` |
| `listarUnidadesComerciais` | Sem require, import, frontend ou teste |
| `converterQuantidadeEntreUnidades` | Wrapper só usado por testes; oráculos migrados para `obterMuc().converterQuantidade` |
| Export de `exigeQuantidadePorEmbalagem` | Função permanece interna na formação de preço |
| Import não usado `obterQuantidadeConvertida` em `compras.js` | Rota não chamava a função |

## 4. Itens mantidos (B)

MotorUM: UC, XML uCom, formação de preço, `calcularCompraEmbalagem`, `exigeQuantidadePorEmbalagem` interno.  
`motorConversaoUnidades.js`: custo, subtotal, F/NF, rateio, leitura de `quantidade_convertida`.  
`fator_conversao` / `resolverFatorConversao`: importação legado.  
Frontend `motor-quantidade-compra.js`: lê `quantidade_convertida` (sem converter).  
Cancelamento/devolução: snapshot. Toledo `/1000`: protocolo de etiqueta.

## 5. Itens depreciados (D)

| Item | Destino oficial |
|------|-----------------|
| `obterQuantidadeConvertida` | Lê item para custo/F-NF; estoque = MUC |
| `simularConversaoEmbalagem` | Custo de `muc.simular()` sem unidades (RC2.1) |
| `muc.simular()` sem unidades | Multiplicador público; preview de compra usa `converterQuantidade` |

## 6. Justificativas

Não se removeu `obterQuantidadeConvertida` nem `simularConversaoEmbalagem`: têm consumidores reais (custo, testes RC4.31.19, `MotorConversao.simularConversao`). Remover quebraria compatibilidade sem ganho de autoridade (já não são o caminho oficial de estoque).

## 7. Consumidores

Ver [MUC-08-MATRIZ-FINAL.md](./MUC-08-MATRIZ-FINAL.md).

## 8. Conversões fora do MUC encontradas

- `obterQuantidadeConvertida`: fallback `emb × qtdPorEmb` se o item **não** traz `quantidade_convertida` (compatibilidade de item antigo / custo).
- `simularConversaoEmbalagem`: `qtd × fator` para custo da simulação pública.
- Importação: `quantidade × fator_conversao` quando **não** há unidades suficientes (MUC-07, D).
- Etiqueta Toledo: `payload / 1000` (gramas do protocolo).
- Arredondamentos `* 1000 / 1000` (3 casas) em estoque/ficha — não são conversão SI.

## 9. Conversões fora do MUC eliminadas

Wrapper `MotorUM.converterQuantidadeEntreUnidades` (já delegava ao MUC; testes passaram a usar o oráculo oficial). Nenhum fluxo de estoque foi alterado.

## 10. Compatibilidades preservadas

`fator_conversao` no XLSX/banco; `muc.simular()` RC2.1; 7 métodos públicos; DTO/eventos 1.0.0.

## 11. Testes

`tests/muc/muc-08-fechamento.test.js` — SI, encadeamento, compra preview=persistência, importação A–E, pós-limpeza, frontend.

## 12. Resultado final

**MUC RC3.0 — CONSOLIDADO.** Autoridade única de conversão de quantidade. Sem conversor operacional concorrente conhecido.
