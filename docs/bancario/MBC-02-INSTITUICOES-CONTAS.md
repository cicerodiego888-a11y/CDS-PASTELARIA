# MBC-02 — Instituições financeiras e contas bancárias

STATUS: implementado sobre a fundação MBC-01. Sem Open Finance, extrato, transação ou conciliação.

## Persistência

- `instituicao_financeira` — catálogo compartilhado, **sem** `empresa_id`, **sem** credenciais.
- `conta_bancaria` — `empresa_id` obrigatório. Uma conta = uma empresa.

Índice único parcial: no máximo uma conta com `principal = 1` por empresa.

## APIs (`/api/bancario`)

Instituições: GET/POST `/instituicoes`, GET/PUT/DELETE `/instituicoes/:id`

Contas: GET/POST `/contas`, GET/PUT `/contas/:id`, PATCH ativar/desativar/principal, DELETE `/contas/:id`

Empresa da conta vem do contexto autorizado (`BancarioEmpresaContextoService`). `empresa_id` no body é ignorado.

## Regras

- Tipos: CORRENTE, POUPANCA, PAGAMENTO, OUTRA.
- Instituição inativa não vincula nova conta.
- Desativar zera `principal`. Não promove outra conta automaticamente.
- Exclusão de instituição com conta: 409.
- Exclusão de conta com `transacao_bancaria` futura: 409.

## UI

Financeiro → **Contas Bancárias**. Recarrega em `cds-empresa-contexto-alterado`.
