# IMPLEMENTAÇÃO MBC-16.4

SPRINT: MBC-16.4

## 1. STATUS

**CONCLUÍDA COM RESSALVAS**

## 2. CLASSIFICAÇÃO

**UI OPERACIONAL IMPLEMENTADA — HOMOLOGAÇÃO E2E REAL PENDENTE**

Não declarar: “INTEGRAÇÃO MERCADO PAGO HOMOLOGADA E2E” sem evidência real.

## 3. OBJETIVO

Fechar a experiência operacional da integração Mercado Pago:

Configurar → Autorizar → Sincronizar agora → Consultar extrato

Reutilizando MBC-15 / 16.1 / 16.2 / 16.3 e a UI do MBC-14.4.1.

## 4. UI IMPLEMENTADA

Aba **Operação** em Contas Bancárias → Integração bancária:

- Status da integração (credenciais / OAuth)
- Última sincronização (data/hora amigável)
- Status (Não executada / Sincronizando / Concluída / Erro / Processando)
- Contadores: recebidas / criadas / já existentes / rejeitadas
- Continuidade em linguagem amigável
- Botão **Sincronizar agora**
- Extrato com filtros de período/direção
- Diagnóstico técnico recolhido (inclui “Testar leitura”)

Hierarquia Empresa → Conta → Integração preservada.

## 5. OPERAÇÃO

- Botão desabilitado sem OAuth AUTORIZADO
- Durante sync: texto “Sincronizando…” + botão disabled
- 409: “Esta conta já está sendo sincronizada.”
- PROCESSANDO: mensagem informativa (não como erro genérico)
- Erros 401/403/429/timeout mapeados para mensagens funcionais

## 6. SINCRONIZAÇÃO

API oficial:

`POST /api/bancario/contas/:id/sincronizar`

Status:

`GET /api/bancario/contas/:id/sincronizacao`

Sem endpoint paralelo.

## 7. EXTRATO

Fonte: `GET /api/bancario/contas/:id/extrato` → `transacao_bancaria`

Colunas: data, descrição, referência, entrada, saída, status.

Sem `raw_reference` / tokens.

## 8. SALDO

- **Saldo real do Mercado Pago:** “Saldo real indisponível neste fluxo.”
- **Saldo conceitual (MBC):** calculado pelas movimentações do CDS

Sem card de saldo MP inventado.

## 9. MULTIEMPRESA

Contexto `CdsEmpresaContexto` + limpeza de painel ao trocar empresa.

## 10. SEGURANÇA

Sem `access_token` / `refresh_token` / `client_secret` no frontend.

## 11. TESTES

| Tipo | Suite | Resultado |
|------|-------|-----------|
| A) MOCK/UI | `motor-bancario-16-4.test.js` | **8/8 pass** |
| B) Harness backend | MBC-01…16.4 | **pass** |
| C) E2E real Mercado Pago | — | **não executado** |

## 12. REGRESSÕES

| Suite | Resultado |
|-------|-----------|
| MBC-01 … MBC-16.4 (`tests/bancario/*.test.js`) | **696/696 pass** |
| Financeiro / Caixa / Vendas / Compras | **5/5 pass** |

## 13. HOMOLOGAÇÃO MOCK

UI e contratos cobertos por testes de fonte/fluxo offline.

## 14. HOMOLOGAÇÃO E2E REAL

**PENDENTE** — ambiente/credenciais Mercado Pago reais não executados neste sprint.

## 15. EVIDÊNCIAS

Sem evidência E2E real (sem tokens/secrets registrados).

## 16. LIMITAÇÕES

- Sem scheduler / webhook / refresh automático
- Saldo síncrono oficial MP indisponível
- Sem UI de dashboard bancário
- Homologação E2E real ainda necessária

## 17. PRÓXIMO MARCO

Homologação E2E real com credenciais válidas + eventual refinamentos operacionais (polling de PROCESSANDO se o produto exigir).
