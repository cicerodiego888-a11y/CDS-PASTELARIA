# IMPLEMENTAÇÃO MBC-09

STATUS: CONCLUÍDA COM RESSALVAS

Motor Bancário homologado em MOCK. Arquitetura preparada para provider Open Finance real.  
Não é “Open Finance pronto para produção”.

## Auditoria

MBC-01 a MBC-08. Contrato único `IBankProvider`. `BankProviderRegistry` autoridade. Chave de idempotência inalterada. MBC-04 único INSERT em `conciliacao_bancaria`. Matching só sugere. Provider não executa SQL.

## Gaps fechados

- Categorias de erro do provider
- Adapter `adaptarTransacaoDoProvider`
- Sanitização de `state` / `authorization_code`
- Evento operacional sem secrets
- Modos de falha MOCK (timeout, rate limit, indisponível, cursor)

Sem retry agressivo. Sem provider real. Sem alteração em Financeiro/Vendas/Compras/Caixa/PDV/MIS/MUC.

## Testes / regressão

- MBC-09: 85/85
- MBC-01 a MBC-08: 258/258
- Carga: 500 transações + 1000 elegíveis; persistência ~800 ms neste ambiente; sem duplicidade na regravação da chave
- Financeiro 05.38.D 20/20 · 05.41 14/14 · Caixa 05.38.C 17/17 · Vendas 05.40 13/13 · Compras 05.64 OK

## Homologação visual

Não exercitada no navegador nesta sessão (sem ferramenta de browser). UI coberta por testes de fonte (pt-BR, limpeza na troca de empresa, sem edição de extrato).

## Próxima sprint

MBC-10 — Provider Open Finance Real
