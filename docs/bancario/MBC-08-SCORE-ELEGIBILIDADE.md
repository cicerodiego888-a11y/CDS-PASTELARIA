# MBC-08 — Score e elegibilidade

Pesos (não alteráveis pelo frontend):

| Critério | Pontos |
|---|---|
| Valor exato | 40 |
| Data compatível | até 25 (mesmo dia 25, 1 dia 15, 2 dias 8) |
| Identificador | 25 |
| Descrição | até 10 |

Janela de data: 2 dias (`JANELA_DIAS_MATCHING`).

Classificação:

- 90–100 ALTA
- 75–89 MÉDIA
- 60–74 BAIXA
- &lt; 60 não sugerir

Pré-filtro: mesma empresa, valor exato, data na janela, direção compatível. Só então compara descrição.

Transação `conciliada`, `ignorada` ou `divergente` (ativa) não gera sugestão operacional.

Aceite revalida valor/elegibilidade. Candidato alterado → EXPIRADA + 409.
