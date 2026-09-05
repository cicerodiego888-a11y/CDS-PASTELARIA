# IMPLEMENTAÇÃO MBC-06

STATUS: CONCLUÍDA COM RESSALVAS

Arquitetura e ciclo de consentimento Open Finance implementados e homologados em MOCK.

**Não declarar Open Finance pronto para produção.** Sem provider real homologado, sem SecretStore de produção garantido, sem callback HTTPS de instituição real.

## Arquitetura

Empresa → conta → `config_integracao_bancaria` → `consentimento_open_finance` → `MOCK_OPEN_FINANCE` → autorização → callback → `AUTORIZADO`. Sem tabela de conexão paralela.

## Consentimento

Entidade oficial com `empresa_id` obrigatório, conta, instituição da conta, provider, escopos (`CONTAS`, `SALDOS`, `TRANSACOES` — somente registrados), identificador externo distinto de `external_id` de transação. Sem credenciais. Histórico preservado. Um operacional ativo por conta+provider.

## Provider / Registry

Contrato `IBankProvider` evoluiu com autorização. MOCK MBC-05 intacto. Registry registra `MOCK` e `MOCK_OPEN_FINANCE`.

## State / Callback

State criptográfico, expirável, de uso único. Callback protegido. Empresa do state, não da query. Mensagem genérica em falha.

## Secrets

Reuso do ISecretStore MBC-05. Referência `mbc.of.consent.{id}`. Sem token em JSON/log/URL/frontend.

Ressalva MBC-05: sem `MBC_SECRET_STORE_KEY` não existe armazenamento persistente seguro.

## Multiempresa / APIs / UI

Contexto oficial. APIs de listagem, início, revogação e renovação. UI Open Finance em Contas Bancárias → Integração.

## Segurança

Sem senha bancária. Sem provider real. State não permite troca de empresa/conta.

## Mock

Fluxo interno de aprovar/negar. Sem HTTP externo. Sem sync.

## Não implementado

Saldo, extrato, transações importadas, conciliação automática, PIX/TEF, Open Finance Payments, alteração de financeiro/vendas/compras/caixa/MIS/MUC/PDV.

## Testes / regressão

- MBC-06: 30/30 (`motor-bancario-06.test.js`, critérios T01–T44)
- MBC-01: 11/11 · MBC-02: 22/22 · MBC-03: 31/31 · MBC-04: 33/33 · MBC-05: 30/30
- Financeiro 05.38.D 20/20 · 05.41 14/14 · Caixa 05.38.C 17/17 · Vendas 05.40 13/13 · Compras 05.64 OK

## Riscos / pendências

MOCK ≠ banco real. Callback de produção, HTTPS e SecretStore de produção pendentes. Homologação visual.

## Recomendação

MBC-07 — Sincronização de Saldo e Extrato Bancário.
