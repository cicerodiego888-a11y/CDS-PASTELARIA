# PEDIDO-PDV-INDEPENDENTES-01 — Produtos independentes sem pastel

## Causa raiz

A mensagem `O Pedido não contém pastéis ativos da categoria "Pastéis"; a venda não será composta.` vinha do hard-gate `PASTEL_ELEGIVEL_AUSENTE` em `PedidoPdvComposicaoService.prepararComposicaoPedidoPdv`, chamado por `POST /api/pedidos/:id/preparar-venda-pdv`.

Não era regra fiscal, ficha técnica nem F×NF: era exigência universal da composição pastel→residual→refrigerantes (Sprint 2.1), aplicada a todo pedido antes de qualquer handoff ao PDV.

## Dependência legítima preservada

A composição automática **só se aplica quando o pedido contém pelo menos um pastel elegível** (categoria `PASTEIS`, tipo produto, ativo, não-insumo):

1. Cota pastéis pelo preço vigente do cadastro.
2. Calcula residual = total do pedido − pastéis.
3. Busca combinação de refrigerantes (volumes MUC 200/300/500 ml) que cubra o residual (exato ou menor excedente + desconto global).

Essa regra permanece intacta (`modo: COMPOSICAO_PASTEL_REFRIGERANTE`).

## Correção

Sem pastel elegível: **passthrough** das linhas comerciais ativas do pedido (`modo: PASSTHROUGH`) — preços/quantidades originais, sem inventar pastel nem recompor refrigerantes do catálogo.

Bloqueios mantidos: pedido sem itens comerciais elegíveis (`PEDIDO_SEM_ITENS_ELEGIVEIS`); inconsistência de total; residual negativo / cobertura insuficiente quando há pastel.

## Arquivos

- `backend/services/vendas/PedidoPdvComposicaoService.js`
- `tests/vendas/pedido-pdv-composicao.test.js`

## Testes (`node --test tests/vendas/pedido-pdv-composicao.test.js`)

| # | Cenário | Resultado |
|---|---------|-----------|
| 1 | Somente refrigerante | PASSTHROUGH OK |
| 2 | Somente pastel (residual 0) | COMPOSICAO OK |
| 3 | Pastel + refrigerante fechando exato | ambos na venda |
| 4 | Independente sem volume/ficha | PASSTHROUGH OK |
| 5 | Insumo / inativo | `PEDIDO_SEM_ITENS_ELEGIVEIS` |
| 6 | Pastel com residual | composição residual preservada |

**19/19 pass** (inclui regressão Sprint 2.1). Sem F×NF, PDV Universal, SEFAZ ou DB oficial.
