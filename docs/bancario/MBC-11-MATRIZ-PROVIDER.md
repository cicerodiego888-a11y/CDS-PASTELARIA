# MBC-11 — Matriz de compatibilidade

**PROVIDER:** não identificado  
**INSTITUIÇÃO:** não identificada  
**DOCUMENTAÇÃO OFICIAL:** ausente  
**URLS OFICIAIS:** ausentes

Mapa: requisito do provider → adapter → `IBankProvider`.

| Recurso | Provider | MBC | Status |
|---|---|---|---|
| Autorização | Desconhecido | `iniciarAutorizacao` | PENDENTE |
| Consentimento | Desconhecido | `ConsentimentoOpenFinanceService` | PENDENTE |
| Callback | Desconhecido | `processarCallback` + state MBC-06 | PENDENTE |
| Contas | Desconhecido | `listarContas` + mapper | PENDENTE |
| Saldo | Desconhecido | `consultarSaldo` → MBC-07 | PENDENTE |
| Extrato | Desconhecido | `listarTransacoes` → MBC-03 | PENDENTE |
| Paginação | Desconhecido | `has_more` / `next_cursor` | PENDENTE |
| Cursor | Desconhecido | cursor opaco no adapter | PENDENTE |
| Revogação | Desconhecido | `revogarAutorizacao` | PENDENTE |
| Refresh | Desconhecido | SecretStore (sem política oficial) | PENDENTE |
| Rate limit | Desconhecido | 429 + `retrySeguro` | PENDENTE |
| Timeout | Desconhecido | 15s (não universal) | PENDENTE |
| Certificados / mTLS | Desconhecido | não implementado | NÃO SUPORTADO |
| Escopos oficiais | Desconhecido | CONTAS/SALDOS/TRANSACOES genéricos | PENDENTE |

Nenhum item é COMPATÍVEL: não há contrato oficial para comparar.
