# IMPLEMENTAÇÃO MBC-16.2

SPRINT: MBC-16.2

## 1. STATUS

**CONCLUÍDA COM RESSALVAS**

## 2. CLASSIFICAÇÃO

**PERSISTÊNCIA DO PROVIDER REAL IMPLEMENTADA — HOMOLOGAÇÃO REAL PENDENTE**

Não declarar: “Mercado Pago homologado.”  
Não declarar: “integração de produção concluída.”

## 3. OBJETIVO

Persistir as movimentações normalizadas pelo MBC-16.1 no núcleo oficial do MBC-03 (`TransacaoBancariaService` → `transacao_bancaria`), sem segunda arquitetura de extrato.

## 4. ARQUITETURA

- Provider / Client / Mapper: reutilizados do MBC-16.1
- OAuth / SecretStore: reutilizados do MBC-15 (`mbc.oauth.mercadopago.{configId}`)
- Persistência: somente via `TransacaoBancariaService.registrar` (MBC-03)
- Orquestração: `MercadoPagoPersistenciaService.persistirLote` + flag `persistir` em `consultarLeituraReal`
- `external_source` oficial do mapper: `MERCADO_PAGO_SETTLEMENT_REPORT`
- Provider de configuração continua: `OPEN_FINANCE_REAL`

## 5. FLUXO IMPLEMENTADO

```
Settlement Report (CSV)
  → MercadoPagoApiClient (MBC-16.1)
  → MercadoPagoAccountMoneyMapper
  → TransacaoBancariaNormalizada
  → MercadoPagoPersistenciaService
  → TransacaoBancariaService.registrar (MBC-03)
  → transacao_bancaria
```

Provider/client **não** executam `INSERT INTO transacao_bancaria`.

## 6. MAPEAMENTO

| Campo MBC | Origem |
|-----------|--------|
| `external_id` | `SOURCE_ID` |
| `valor` | `ABS(SETTLEMENT_NET_AMOUNT)` |
| `direcao` | sinal do líquido (+ entrada / − saída) |
| `descricao` | tipo + referência (contrato MBC-16.1) |
| `referencia_externa` | `EXTERNAL_REFERENCE` |
| `data_transacao` / `data_processamento` | datas do relatório |
| `saldo_apos_transacao` | sempre `null` quando não disponível |
| `external_source` | `MERCADO_PAGO_SETTLEMENT_REPORT` |

Moeda não-BRL: rejeitada (sem conversão).  
Valor 0: rejeitado pelo contrato existente do MBC-03 (`VALOR_INVALIDO`).

## 7. PERSISTÊNCIA

API evoluída (sem endpoint paralelo):

`POST /api/bancario/configuracoes/:id/provider/testar-leitura`

Body opcional: `{ "persistir": true }`

Resposta inclui `persistencia: { recebidas, criadas, ja_existentes, rejeitadas, ids_criados }`.

Sem `persistir` (padrão): comportamento MBC-16.1 intacto (`persistiu: false`).

## 8. IDEMPOTÊNCIA

Chave oficial MBC-03:

`empresa_id + conta_bancaria_id + external_source + external_id`

1ª importação → `CRIADA`  
2ª importação → `JA_EXISTENTE` (sem duplicata)

## 9. MULTIEMPRESA

- `empresa_id` derivado da conta / contexto — body não transfere propriedade
- Configuração de outra empresa bloqueada no contexto
- Conta de outra empresa não recebe registro no contexto errado

## 10. SEGURANÇA

- Token somente via SecretStore
- Sem token em resposta, logs de API, `raw_reference` ou DTO
- `raw_reference` sanitizado pelo MBC-03

## 11. FINANCEIRO

Importação **não** cria:

- financeiro
- contas a receber / pagar
- venda / compra
- caixa

## 12. CONCILIAÇÃO

- MBC-04 / MBC-08 **não** alterados
- Sem conciliação automática
- Sem matching automático na importação

## 13. TESTES

Suite: `tests/bancario/motor-bancario-16-2.test.js` — **8/8 pass**

Cobertura: T01–T36 (persistência, idempotência, bloqueios, multiempresa, segurança, fronteira financeira).

Duplicidade real: 10 criadas → 2ª importação 0 criadas / 10 já existentes → 10 linhas finais.

## 14. REGRESSÃO

| Suite | Resultado |
|-------|-----------|
| MBC-01 … MBC-16.2 (`tests/bancario/*.test.js`) | **677/677 pass** |
| Financeiro 05.38.D / 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64 | **5/5 pass** |

## 15. AUDITORIA DO BANCO

- Nenhuma tabela nova específica Mercado Pago
- Linhas apenas em `transacao_bancaria`
- Sem credenciais em tabelas funcionais
- Provider/client/mapper/PersistenciaService sem `INSERT INTO transacao_bancaria` (só MBC-03)

## 16. HOMOLOGAÇÃO REAL

**Pendente.** Requer ambiente/credenciais válidos e execução real do settlement report.

## 17. LIMITAÇÕES

- Sem cursor / paginação definitiva (MBC-16.3)
- Sem scheduler / sync contínua
- Sem saldo real síncrono
- Relatório assíncrono pode retornar `PROCESSANDO`

## 18. PRÓXIMO MARCO

**MBC-16.3** — sincronização real, páginas/cursor, continuidade após falha, operação contínua.
