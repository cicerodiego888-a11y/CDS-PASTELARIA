# Mapa de transição — Motor Universal de Vendas

**Sprint 04.01** · não executar as fases seguintes nesta Sprint.

## Estado atual (legado vivo)

```
Canal PDV / Faturamento / Entrega
        → VendaApplicationService
        → VendaPagamentoService.criarVenda
        → 1 linha em `vendas`
```

Estoque isolado já existe (`estoque_empresa` + portas). A **venda** ainda é um documento único, sem `empresa_id`.

## Destino

```
Canal
        → VendaApplicationService
        → Motor Universal (modo)
              EMPRESA_UNICA → 1 operação → criarVenda atual
              MULTIEMPRESA  → N operações na mesma TX → N criarVenda
        → ATENDIMENTO agrupa as vendas
```

## Fases

| Fase | Objetivo | Quebra PDV? | Depende de |
|---|---|---|---|
| 04.01 | Contratos + auditoria | não | — |
| 04.02 | `modo_operacao_venda` na config (default UNICA) | não | 04.01 |
| 04.03 | Schema ATENDIMENTO (vazio, sem migrar) | não | 04.02 |
| 04.04 | UNICA: atendimento 1:1 transparente | não | 04.03 |
| 04.05 | MULTIEMPRESA: split por empresaId + rollback total | só com modo ligado | 04.04, Fundação 03.xx |
| 04.06 | Pagamento POR_ITEM | modo MULTI | 04.05 |
| 04.07 | `empresa_id` em vendas novas + caixa/fiscal por operação | modo MULTI | 04.06 |

## Regras de coexistência

- `POST /api/vendas` não some.
- Default sempre `EMPRESA_UNICA` até o administrador mudar.
- COMPAT de estoque sem header permanece.
- Nenhuma venda antiga é reescrita.

## Critério para ligar MULTIEMPRESA

Só depois de: split atômico, distribuição de pagamento fechada, cada operação com `empresaId` na porta de estoque, e fiscal/caixa definidos por operação.
