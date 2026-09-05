# IMPLEMENTAÇÃO MBC-08

STATUS: CONCLUÍDA COM RESSALVAS

Matching homologado sobre candidatos oficiais do MBC-04. Vendas/compras não entram como origem (limitação da arquitetura, sem tabelas artificiais).

## Arquitetura / Matching / Score

Motor de matching no MBC. Sugestão ≠ conciliação. Pesos e limiares centralizados. Sem IA.

## Candidatos / Sugestões / Idempotência

FINANCEIRO, CONTAS_RECEBER, CONTAS_RECEBER_PAGAMENTO. Tabela `sugestao_conciliacao_bancaria`. Única PENDENTE por transação+tipo+registro.

## Aceite / MBC-04

Aceite chama `ConciliacaoBancariaService.conciliar`. Sem INSERT direto. Recusa só muda status da sugestão.

## Multiempresa / APIs / UI / Segurança / Concorrência

Contexto oficial. Rotas de análise/sugestão. UI em pt-BR. Sem token. Aceite concorrente: uma vence.

## Testes / regressão

- MBC-08: 53/53 (T01–T60 cobertos)
- MBC-01 a MBC-07: verdes
- Financeiro 05.38.D 20/20 · 05.41 14/14 · Caixa 05.38.C 17/17 · Vendas 05.40 13/13 · Compras 05.64 OK

## Próxima sprint

MBC-09 — Homologação Final + preparação para provider real.
