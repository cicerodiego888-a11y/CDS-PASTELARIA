# IMPLEMENTAÇÃO MBC-07

STATUS: CONCLUÍDA COM RESSALVAS

Sincronização de saldo e extrato homologada em MOCK. Sem provider real. Sem SecretStore de produção garantido (ressalva MBC-05).

## Arquitetura

Provider → DTO → Motor → MBC-03. Tabela `sincronizacao_bancaria` guarda estado, cursor e saldo informado. Sem tokens.

## Saldo / Extrato / Cursor / Paginação / Idempotência

Dois saldos. Extrato via MBC-03. Cursor só avança após persistência da página. MOCK: 10+10 transações determinísticas; terceira página opcional. Idempotência MBC-03.

## Consentimento / Concorrência / Multiempresa

`exigirConsentimentoAutorizado()`. Uma execução `SINCRONIZANDO` por conta (409). Isolamento por contexto.

## APIs / UI / Segurança

Rotas de sincronizar, estado, saldo bancário e extrato. UI em Integração → Open Finance → Sincronização / Extrato. Sem token em JSON/log/URL/frontend.

## Não implementado

Matching, conciliação automática, financeiro/vendas/compras/caixa/PDV, provider real.

## Testes / regressão

- MBC-07: 50/50
- MBC-01 a MBC-06: verdes
- Financeiro 05.38.D 20/20 · 05.41 14/14 · Caixa 05.38.C 17/17 · Vendas 05.40 13/13 · Compras 05.64 OK

## Riscos

MOCK ≠ banco real. Cursor de provider real pode ter semântica diferente.

## Próxima sprint

MBC-08 — Motor de Matching e Sugestões de Conciliação Bancária.
