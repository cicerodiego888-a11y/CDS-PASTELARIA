# MBC-13 — Matriz final de prontidão

Classificação: **PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO**  
Decisão: **NO-GO** para produção.

| Área | Situação | Evidência | Dependência |
|------|----------|-----------|-------------|
| Provider | PRONTO | Código `OPEN_FINANCE_REAL` no `BankProviderRegistry`; implementa `IBankProvider` | Instituição oficial |
| Instituição | PENDENTE | `INSTITUICAO_OFICIAL = null` | Escolha da instituição |
| Documentação | BLOQUEADO | Sem URL oficial versionada | Contrato oficial |
| Ambiente | BLOQUEADO | Sem endpoint oficial SANDBOX/HML/PROD | Ambiente da instituição |
| Autenticação | BLOQUEADO | Sem método oficial | Documentação oficial |
| OAuth | BLOQUEADO | `OAUTH_OFICIAL = null`; fluxo MBC-06 genérico apenas | Protocolo oficial |
| Callback | PRONTO | State aleatório, TTL, uso único, vínculo empresa/conta/config (`ConsentimentoOpenFinanceService`) | URL de redirect oficial |
| Consentimento | HOMOLOGADO | Tabela + ciclo MBC-06 (MOCK) | Consentimento real do banco |
| Certificado | NÃO APLICÁVEL | Exigência oficial desconhecida (`CERTIFICADO_OFICIAL_EXIGIDO = null`) | Documentação oficial |
| SecretStore | PENDENTE | `ISecretStore` + AES local; **não** é cofre de produção | Vault/HSM/Secret Manager |
| Contas | HOMOLOGADO | Conta pertence à empresa; isolamento A/B | Conta real do provider |
| Saldo | HOMOLOGADO | `saldo_bancario` ≠ `saldo_conceitual`; sem ajuste automático | Mapper oficial do saldo |
| Extrato | HOMOLOGADO | Adapter → DTO → MBC-03; provider sem SQL | Schema oficial do extrato |
| Paginação | PRONTO | `{ transacoes, has_more, next_cursor }` no MBC-07 | Semântica oficial |
| Cursor | PENDENTE | Cursor opaco no núcleo; significado real desconhecido | Documentação oficial |
| Idempotência | HOMOLOGADO | `empresa_id + conta_bancaria_id + external_source + external_id` | `external_id` estável do banco |
| Rate limit | PENDENTE | `RATE_LIMIT_PROVIDER.status = PENDENTE`; `limite = null` | Documentação do provider |
| Retry | PRONTO | `retrySeguro` só TIMEOUT / INDISPONIBILIDADE / RATE_LIMIT | Política oficial da instituição |
| Erros | PRONTO | Categorias MBC + sanitização | Catálogo oficial de erros |
| Observabilidade | PRONTO | `observabilidadeMbc` + `sanitizarObjetoMbc` | — |
| Multiempresa | HOMOLOGADO | Contexto oficial; body/query sem autoridade | — |
| Sincronização | HOMOLOGADO | MBC-07; cursor após persistir página | Chamada real |
| Conciliação | HOMOLOGADO | Somente MBC-04 efetiva | — |
| Matching | HOMOLOGADO | MBC-08 só sugere; sem `INSERT conciliacao_bancaria` | — |
| Segurança | PRONTO | Flag + prontidão + SecretStore; sem token em UI/JSON | Cofre de produção |
| Produção | BLOQUEADO | Checklist incompleto; `producao_controlada = false` | Todos os itens obrigatórios |
| Rollback | PRONTO | `aplicarRollbackOperacaoReal`: para operações, não apaga histórico | Aprovação operacional |
