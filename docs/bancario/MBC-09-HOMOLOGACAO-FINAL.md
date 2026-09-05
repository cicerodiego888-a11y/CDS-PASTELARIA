# MBC-09 — Homologação final do Motor Bancário

STATUS: Motor homologado em MOCK. Arquitetura preparada para provider Open Finance real.

**Não declarar:** “Open Finance pronto para produção.”

## Fluxo oficial

```
EMPRESA
  → CONTA BANCÁRIA
  → INSTITUIÇÃO FINANCEIRA
  → CONFIGURAÇÃO DE INTEGRAÇÃO
  → CONSENTIMENTO OPEN FINANCE
  → PROVIDER (BankProviderRegistry → IBankProvider)
  → SALDO / EXTRATO
  → ADAPTER / DTO
  → TransacaoBancariaNormalizada
  → MBC-03 (transação bancária)
  → MBC-08 (sugestão)
  → USUÁRIO
  → MBC-04 (conciliação)
```

## Homologação por sprint

| Sprint | Resultado | Ressalva |
| --- | --- | --- |
| MBC-01 | Fundação e contexto | CODIGO permanece MBC-01 |
| MBC-02 | Instituições e contas | Sem credencial na conta |
| MBC-03 | Transações + idempotência | Chave oficial empresa+conta+source+external_id |
| MBC-04 | Conciliação manual | Único escritor de `conciliacao_bancaria` |
| MBC-05 | Provider + SecretStore | Sem cofre de produção |
| MBC-06 | Consentimento MOCK | Sem OAuth real |
| MBC-07 | Saldo/extrato/cursor | Sem instituição real |
| MBC-08 | Matching sugere | Vendas/compras não são origem |

## O que está pronto (MOCK)

- Multiempresa por contexto oficial
- Contas e instituições
- Persistência de transações com idempotência
- Conciliação manual
- Matching determinístico e sugestões
- Consentimento e sincronização no MOCK_OPEN_FINANCE
- Cursor avança só após persistir a página
- Sem conciliação automática

## O que está em MOCK

- Autorização (`/mock-autorizar`)
- Saldo e extrato determinísticos (10+10)
- Secret de consentimento (`OF_MOCK_REF`)

## O que não está pronto para produção

- Provider de instituição real
- OAuth/OIDC real
- SecretStore de produção (Vault/HSM)
- Homologação com banco
- Rate limit/retry/timeout reais de rede
- UI exercitada visualmente no navegador nesta sprint (pendência)

## Gap conhecido

`listarRegistrosElegiveis` limita 100 registros por tipo. Matching não varre milhares de linhas. Não foi alterado para evitar mudança de contrato do MBC-04.
