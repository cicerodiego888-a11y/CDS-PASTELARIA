# REGRAS DE TRANSIÇÃO — Sprint 05

## Item (`cozinha_itens.estado_preparacao`)

| De | Para | Operação | Condição |
|---|---|---|---|
| AGUARDANDO | EM_PREPARACAO | `iniciarPreparacao` | Rodada válida; integridade OK; não cancelado |
| EM_PREPARACAO | EM_PREPARACAO | `iniciarPreparacao` | Idempotente / já em preparação (`ja_em_preparacao`) |
| EM_PREPARACAO | PRONTO | `marcarItemPronto` | Integridade OK |
| AGUARDANDO | PRONTO | — | **Proibido** (`TRANSICAO_INVALIDA`) |
| PRONTO | EM_PREPARACAO | — | **Proibido** |
| * | CANCELADO | fora de S05 | Cancelamento não implementado nesta sprint |

## Rodada (derivada)

Após cada op, `sincronizarEstadoRodada` avalia bloqueadores:

- Com PASTEL ativo: só pastéis PRONTO → rodada `PRONTA`.
- Sem PASTEL: OUTROs PRONTO → rodada `PRONTA`.
- BEBIDA nunca bloqueia.

Item PRONTO **não** implica retirada pelo garçom nem entrega ao cliente.

## Bebida

- Múltiplas entregas permitidas; histórico em `cozinha_bebida_entregas`.
- Soma `qty_entregue_millis` ≤ `qty_solicitada_millis − qty_cancelada_millis`.
- Não exige pastéis prontos.
- Não altera estoque, financeiro, venda ou fiscal.

## Pré-condições comuns (S05)

1. Empresa do item/rodada = empresa da sessão.  
2. Item.rodada_id = rodada.id.  
3. Item.unidade_id = rodada.unidade_id.  
4. Se `unidade_id` informado na request → igual ao item.  
5. Comanda do item existe na empresa.  
6. Comanda.atendimento_id = rodada.atendimento_id.  
7. Rodada não `CANCELADA`.
