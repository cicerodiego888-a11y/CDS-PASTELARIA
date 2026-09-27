# IMPLEMENTAÇÃO MBC-16.1

SPRINT: MBC-16.1

STATUS: **CONCLUÍDA COM RESSALVAS**

Classificação: **CLIENT REAL IMPLEMENTADO — HOMOLOGAÇÃO REAL PENDENTE**

Não declarar sincronização real concluída.  
Não declarar saldo síncrono oficial disponível.  
Nenhuma transação foi persistida nesta sprint.

## Documentação oficial consultada

- Base: `https://api.mercadopago.com`
- Autenticação: `Authorization: Bearer <ACCESS_TOKEN>`
- Relatório **Dinheiro em conta / Account money** (settlement_report):
  - Config: `GET/POST/PUT /v1/account/settlement_report/config`
  - Gerar: `POST /v1/account/settlement_report` (`begin_date`, `end_date`) → HTTP 202
  - Listar: `GET /v1/account/settlement_report/list`
  - Download: `GET /v1/account/settlement_report/:file_name` (CSV)
- Fonte: documentação Mercado Pago Developers — Reports / Account money / API

## Endpoints oficiais utilizados

| Método | Path | Uso |
|--------|------|-----|
| GET/POST/PUT | `/v1/account/settlement_report/config` | garantir colunas |
| POST | `/v1/account/settlement_report` | solicitar relatório |
| GET | `/v1/account/settlement_report/list` | status / arquivo |
| GET | `/v1/account/settlement_report/:file_name` | download CSV |

**Não inventados:** `/balance`, `/transactions`.

## Saldo

`SALDO_REAL_NAO_DISPONIVEL_NESTA_OPERACAO`

A documentação oficial do fluxo Dinheiro em conta descreve **movimentações** via relatório assíncrono. Não há endpoint síncrono oficial confirmado de saldo disponível para este OAuth nesta sprint. Saldo **não** foi inventado.

## Movimentações — decisões de mapeamento

| Campo MBC | Campo oficial | Decisão |
|-----------|---------------|---------|
| `external_id` | `SOURCE_ID` | Identificador da operação nos sistemas MP |
| `referencia` | `EXTERNAL_REFERENCE` | Não substitui SOURCE_ID |
| `valor` | `|SETTLEMENT_NET_AMOUNT|` | Impacto líquido no dinheiro em conta (docs) |
| `direcao` | sinal de `SETTLEMENT_NET_AMOUNT` (+ entrada / − saída), reforço por `TRANSACTION_TYPE` | Semântica do impacto líquido |
| `data_transacao` | `TRANSACTION_DATE` (fallback `SETTLEMENT_DATE`) | |
| `raw_reference` | JSON técnico sem secrets | Sem token/secret |

## Arquivos

- `backend/motores/bancario/providers/mercadopago/MercadoPagoApiClient.js`
- `backend/motores/bancario/providers/mercadopago/MercadoPagoAccountMoneyMapper.js`
- `backend/motores/bancario/services/MercadoPagoLeituraService.js`
- `backend/motores/bancario/providers/openfinance-real/Client.js` / `Mapper.js` (evolução)
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/rotas/bancario.js` → `POST .../provider/testar-leitura`
- `frontend/erp/...` → botão técnico “Testar leitura”
- `tests/bancario/motor-bancario-16-1.test.js`
- `docs/bancario/MBC-16.1-RELATORIO.md`

## API CDS

`POST /api/bancario/configuracoes/:id/provider/testar-leitura`

- JWT + empresa
- Não aceita/retorna token
- `persistiu: false`
- Pode retornar `status_leitura: PROCESSANDO` (relatório assíncrono)

## Testes

| Suite | Resultado |
|-------|-----------|
| MBC-16.1 | **7/7 pass** |
| MBC-01 … MBC-15 + 16.1 | **pass / 0 fail** (regressão completa) |
| Financeiro 05.38.D / 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64 | **pass** |

## Homologação real

Pendente (requer OAuth MBC-15 homologado + chamada real ao Mercado Pago).

## Limitações

- Relatório assíncrono (não é sync definitiva)
- Sem persistência em `transacao_bancaria`
- Sem alteração MBC-03/04/08
- Sem job/scheduler
- Saldo síncrono não disponível neste contrato

## Próximo passo

MBC-16.2/16.3 — persistência idempotente das movimentações normalizadas.

## Status final

**CONCLUÍDA COM RESSALVAS** — client HTTP + mapper + leitura sem persistência; homologação real pendente.
