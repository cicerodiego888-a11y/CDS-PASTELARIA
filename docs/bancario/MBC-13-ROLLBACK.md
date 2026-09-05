# MBC-13 — Rollback operacional

Rollback significa **parar novas operações**, não apagar histórico.

## Ações

1. Manter `MBC_OPEN_FINANCE_REAL_ENABLED=false`.
2. Recusar operação real via `providerRealPodeOperar()` / `exigirOperacaoReal()`.
3. Impedir novas sincronizações do provider real.
4. Preservar `transacao_bancaria` já importadas.
5. Preservar consentimentos e states consumidos.
6. Preservar `conciliacao_bancaria` e sugestões.
7. Não reverter lançamentos financeiros.
8. Não alterar vendas, compras ou caixa.

## Proibido no rollback

- DELETE de transações bancárias
- DELETE de consentimentos
- DELETE de conciliações
- “desfazer” financeiro automaticamente
- promover SANDBOX/HML a PRODUÇÃO

## Função

`aplicarRollbackOperacaoReal()` devolve o plano: `novas_operacoes = BLOQUEADAS`, `historico_apagado = false`.
