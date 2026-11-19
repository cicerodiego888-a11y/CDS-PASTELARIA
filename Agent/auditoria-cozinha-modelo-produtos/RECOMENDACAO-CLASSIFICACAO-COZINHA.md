# RECOMENDAÇÃO — Classificação PASTEL / BEBIDA / OUTRO

**Status:** proposta para decisão do Product Owner. **Não implementada.**

## O que já existe (não inventar de novo)

| Sinal existente | Onde | O que distingue |
|---|---|---|
| `tipo_operacional` / snapshot | `produtos` / `pedidos_itens` | COMERCIAL vs INSUMO |
| `comercializavel` | `produtos` | INSUMO vendável no Pedido (bebidas tipicamente) |
| Categoria `Refrigerantes` | `categorias.nome` | Usada para **ocultar** COMERCIAL copo; não classifica Cozinha sozinha |
| `permite_personalizacao_ingredientes` + ficha | produto/ficha | Forte indício de “preparação com montagem” (pastel) |
| `pedido_item_ingredientes` | pedido | Item personalizado (quase sempre pastel/montável) |
| Volume (`utiliza_volume`) | produto | Embalagem/volume; não = BEBIDA |

**Conclusão factual:** não há hoje um campo PASTEL|BEBIDA|OUTRO. Há **sinais compostos** suficientes para uma política **candidata**, mas não para certeza operacional sem regra de negócio aprovada.

## O que está ausente de verdade
- Enum/campo de preparação na Cozinha independente de COMERCIAL/INSUMO.
- Garantia de que todo INSUMO comercializável é bebida (o SQL não restringe categoria).
- Garantia de que todo COMERCIAL com ficha é pastel.

## Política segura (ordem sugerida ao PO)

### Opção A — Sem novo campo (somente regras sobre sinais existentes)
Heurística **documentada e testável**, aplicada no despacho (ou em leitura):

1. Se `classificacao_operacional_snapshot` / snapshot explícito já for PASTEL|BEBIDA|OUTRO → respeitar (hoje não ocorre no ERP).
2. Se item é **INSUMO** (`snapshot` ou catálogo) **e** produto `comercializavel=1` → candidato **BEBIDA**.
3. Se item é **COMERCIAL** com personalização (`personalizacao_ingredientes_snapshot=1`) ou `utiliza_ficha_tecnica=1` → candidato **PASTEL**.
4. Demais → **OUTRO**.

**Riscos:** INSUMO comercializável que não é bebida; COMERCIAL simples vendido no Pedido classificado OUTRO (aceitável); COMERCIAL “copo” legado raro se filtrado na busca.

### Opção B — Campo explícito no cadastro (só se A for insuficiente)
Só após o PO comprovar falhas da Opção A em operação real:  
ex. `produtos.tipo_preparacao_cozinha` ∈ {PASTEL, BEBIDA, OUTRO} espelhado em snapshot no pedido.  
**Não recomendar criação antes** de tentar A — alinhado à regra da auditoria.

### O que **não** fazer
- Mapear `COMERCIAL → PASTEL` (já rejeitado na correção Sprint 02).
- Inferir só pelo nome (“Coca”, “Pastel”).
- Alterar Pedido/PDV/ficha para “consertar” a Cozinha.
- Tratar categoria Refrigerantes como única fonte (a busca de insumos comercializáveis **não** filtra por ela).

## Como a Cozinha reutiliza o Pedido hoje
Despacho já copia item + ingredientes. A classificação pode ser:
- calculada na leitura/despacho a partir dos sinais (Opção A), ou
- gravada no snapshot do item no momento do pedido (melhor consistência se Opção B).

## Decisão pendente
Aguardando Product Owner + revisão técnica. Nenhuma Sprint 03 / implementação nesta entrega.
