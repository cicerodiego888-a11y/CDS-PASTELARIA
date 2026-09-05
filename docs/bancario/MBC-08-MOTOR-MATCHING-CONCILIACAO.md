# MBC-08 — Motor de matching e sugestões

O matching **sugere**. O MBC-04 **concilia**. Nenhuma conciliação automática.

## Arquitetura

```
Transação bancária → filtros (empresa, valor, data, direção)
  → score → sugestão PENDENTE → usuário aceita → ConciliacaoBancariaService
```

Candidatos oficiais (já usados no MBC-04):

- CONTAS_RECEBER
- FINANCEIRO
- CONTAS_RECEBER_PAGAMENTO

**Limitação:** vendas e compras não são origem de conciliação no MBC-04. Não foram inventadas tabelas para esta sprint.

## APIs

- `POST /api/bancario/contas/:id/analisar-conciliacoes`
- `POST /api/bancario/transacoes/:id/analisar-conciliacao`
- `GET /api/bancario/conciliacoes/sugestoes`
- `GET /api/bancario/conciliacoes/sugestoes/:id`
- `POST .../aceitar` → MBC-04
- `POST .../recusar`

## UI

Contas Bancárias → Transações → Conciliações sugeridas. Múltiplos candidatos exigem escolha. Troca de empresa limpa o painel.
