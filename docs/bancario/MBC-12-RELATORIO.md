# MBC-12 — Relatório

STATUS: **CONCLUÍDA COM RESSALVAS**

Classificação: **PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO**

**AGUARDANDO PROVIDER REAL / AMBIENTE OFICIAL**

Não houve chamada real por ausência de contrato oficial e/ou ambiente oficial.

O MOCK permanece o ambiente de testes. Nenhuma API hipotética foi inventada. O núcleo MBC (contexto, conta, consentimento, transação, idempotência, sincronização, conciliação, matching) não foi adaptado a um contrato fictício.

## Itens

| Item | Situação |
|---|---|
| Provider | PENDENTE |
| Instituição | PENDENTE |
| Ambiente | PENDENTE |
| Documentação | BLOQUEADO |
| OAuth | BLOQUEADO |
| Certificado | NÃO APLICÁVEL |
| SecretStore | PENDENTE (local/cifrado; sem Vault/HSM) |
| Contas | BLOQUEADO (reais) |
| Saldo | BLOQUEADO (real) |
| Extrato | BLOQUEADO (real) |
| Paginação | PENDENTE (contrato oficial) |
| Idempotência | HOMOLOGADO (chave MBC; harness) |
| Retry | BLOQUEADO (sem política oficial da instituição) |
| Erros | PENDENTE (categorias MBC; sem catálogo oficial) |
| Multiempresa | HOMOLOGADO |
| Conciliação | HOMOLOGADO (manual; sem auto) |
| Produção | BLOQUEADO |

## Controles entregues

- `providerRealPodeOperar()` / `exigirOperacaoReal()`
- Feature flag `MBC_OPEN_FINANCE_REAL_ENABLED` (padrão false)
- `ambienteEndpointValido()` → 409
- Adapter em `providers/openfinance-real/` atrás de `IBankProvider` + `BankProviderRegistry`
- `OPERACAO_ASSISTIDA` (registro sanitizado; execução real bloqueada)
- UI pt-BR com estado BLOQUEADO e mensagem oficial de recusa

## Testes

- MBC-12: 39/39
- MBC-01 a MBC-12: 520/520
- Financeiro 05.38.D 20/20 · 05.41 14/14 · Caixa 05.38.C 17/17 · Vendas 05.40 13/13 · Compras 05.64 OK

Evidência de operação assistida real: **não existe** (sem instituição/ambiente oficial).

Documentos: `MBC-12-PROVIDER-REAL.md`, `MBC-12-MATRIZ-COMPATIBILIDADE.md`, `IMPLEMENTACAO_MBC_12_RELATORIO.md`.
