# Implementação 03.17 — primeiro consumidor real de leitura por empresa

**Status:** encerrada sem migração · **Data:** 2026-08-21  
**Conclusão:** `NENHUM_CONSUMIDOR_SEGURO_ENCONTRADO`

---

## Storage oficial (inalterado)

- Porta pública `estoqueSaldosPublico` → `produtos`
- `estoque_empresa` continua estrutura paralela em migração
- Nenhum writer alterado

---

## Auditoria dos candidatos

| Candidato | Lê hoje | empresaId | Por que não migrar |
|---|---|---|---|
| `estoqueSaldosPublico.consultarSaldo` callers (ajuste, compra, venda, NF-e, MTS) | porta → `produtos` | às vezes + COMPAT | Writer ou fluxo proibido |
| `backend/rotas/produtos.js` GET `/:id` e listagens | SQL `produtos` + `normalizarProdutoResposta` | opcional / COMPAT | Cadastro operacional; empresaId **não confiável** |
| `GET /vencimentos/alertas` | SQL `produtos` | ausente | Lista global; sem empresa |
| `backend/rotas/dashboard.js` estoque mínimo | SQL `produtos` | ausente | Painel operacional; sem empresa |
| `MonitoringAlertService` estoque negativo/crítico | `COUNT` em `produtos` | ausente | Diagnóstico global; sem `produtoId`+`empresaId` |
| CIP `MotorAdapters` / Forecast | `estoque_atual` em `produtos` | ausente | Motor; sem empresa |
| `reportFiscalHelpers` | expressões fiscais / ranking | N/A | Agregado fiscal; não é saldo produto+empresa |
| `ReservaRepairService` / reservas / PDV | `produtos` | COMPAT | Proibido |
| Certification / homologação | `produtos` | N/A | Não é consumidor de produção estável |

**Regra aplicada:** sem `empresaId` explícito e confiável → não migrar.  
Não inventar fallback `null → produtos` no service.  
Não criar endpoint só para justificar a Sprint.

---

## Comportamento se houvesse registro

Não aplicável. Nenhum consumidor de produção passou a chamar `consultarSaldoParaEmpresa`.

`null` na 03.16 continua significando “não existe estoque isolado para a empresa”, não “usar legado”.

---

## Arquivos de produção

Nenhum.
