# MBC-06 — Open Finance + Consentimento

Arquitetura e ciclo de consentimento homologados em **MOCK**. Isto **não** é Open Finance pronto para produção.

## 1. Arquitetura

```
EMPRESA → CONTA_BANCARIA → CONFIG_INTEGRACAO_BANCARIA
  → CONSENTIMENTO_OPEN_FINANCE → PROVIDER → AUTORIZAÇÃO → CALLBACK → AUTORIZADO
```

Provider é comunicação técnica. Consentimento é a autorização do titular. Instituição financeira continua sendo entidade de negócio (MBC-02), distinta do provider.

Não há tabela `conexao_bancaria`: o consentimento operacional é o vínculo.

## 2. Consentimento

Tabela `consentimento_open_finance`. `empresa_id` obrigatório e igual a `conta_bancaria.empresa_id`. Instituição = instituição da conta. Sem credenciais na tabela.

Histórico: vários registros por conta. No máximo um operacional (`INICIADO` / `AGUARDANDO_AUTORIZACAO` / `AUTORIZADO`) por conta + provider (índice único parcial).

## 3. Estados

`INICIADO`, `AGUARDANDO_AUTORIZACAO`, `AUTORIZADO`, `EXPIRADO`, `REVOGADO`, `NEGADO`, `ERRO`.

`AUTORIZADO` significa consentimento válido, **não** extrato sincronizado.

## 4. Provider

`IBankProvider` ganhou `iniciarAutorizacao`, `processarCallback`, `revogarAutorizacao` e `suportaAutorizacao`. O MOCK genérico (MBC-05) permanece sem autorização.

`MOCK_OPEN_FINANCE` simula redirect interno, aprovação, recusa, expiração e revogação. Sem HTTP externo. Sem banco real. Sem saldo/extrato.

## 5. Registry

`BankProviderRegistry` registra `MOCK` e `MOCK_OPEN_FINANCE`. Sem `if provider ===` espalhado.

## 6. State

`consentimento_of_state` com `crypto.randomBytes(32)`. Associado a empresa, conta, config, consentimento e usuário. TTL curto (10 minutos). Consumido após callback válido. Replay rejeitado. State desconhecido ou expirado: HTTP 400 `"Autorização inválida."` sem vazar conta/empresa.

## 7. Callback

`GET /api/bancario/open-finance/callback`. Empresa vem do state persistido, nunca de `empresa_id` na URL. Contexto de outra empresa rejeita. `access_denied` → `NEGADO`.

## 8. Secrets

Tokens futuros usam `ISecretStore` (MBC-05), chave `mbc.of.consent.{id}`. Não entram em JSON, log, URL, frontend nem na tabela de consentimento. Sem `MBC_SECRET_STORE_KEY` não há persistência cifrada de produção.

## 9. Expiração / 10. Revogação / 11. Renovação

Ao consultar, `AUTORIZADO` com `expira_em` no passado vira `EXPIRADO`. Revogar: `AUTORIZADO` ou `AGUARDANDO_AUTORIZACAO` → `REVOGADO`. Renovar: histórico permanece; novo ID. `exigirConsentimentoAutorizado()` existe para MBC-07 e **não** dispara sync.

## 12. Multiempresa

Isolamento por contexto oficial. Body/query `empresa_id` não é autoridade.

## 13. APIs

- `GET/POST /api/bancario/open-finance/consentimentos`
- `GET /api/bancario/open-finance/consentimentos/:id`
- `POST .../:id/revogar` e `.../:id/renovar`
- Sem DELETE

## 14. UI

Financeiro → Contas Bancárias → Integração → Open Finance. Autorizar / Revogar / Renovar. Textos em pt-BR. Troca de empresa limpa contas, integrações e consentimentos.

## 15. Segurança

Sem senha bancária, sem token no frontend/localStorage. State não troca empresa/conta. Sem provider real obrigatório.

## 16. Mock

URL interna `/api/bancario/open-finance/mock-autorizar`. Aprovar/recusar. Sem credenciais.

## 17. O que NÃO foi implementado

Saldo, extrato, importação, conciliação automática, matching, IA, OFX, scraping, PIX/TEF, pagamentos Open Finance, alteração de financeiro/vendas/compras/caixa/MIS/MUC/PDV.

## 18–22. Testes, regressões, limitações, riscos, MBC-07

Ver `IMPLEMENTACAO_MBC_06_RELATORIO.md`. Próxima sprint: **MBC-07 — Sincronização de Saldo e Extrato**.
