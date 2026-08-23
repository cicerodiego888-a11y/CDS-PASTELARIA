# Relatório — Sprint 04.05
## Pagamento unificado + rateio empresarial

**Data:** 2026-08-22 · **Status:** concluída (núcleo financeiro; sem vendas)

### Decisão

`confirmarPagamentoAtendimento` no `AtendimentoMultiempresaService`. Reusa a tolerância oficial de `validarSomaPagamentosVenda` e o contrato `validarDistribuicaoPagamento`. Não chama `OrquestradorPagamento` nem TEF. Não cria `ReservaAtendimentoService` / motor paralelo.

Status novos alinhados ao pedido da sprint: `PAGAMENTO_PROCESSANDO`, `PAGO`. `AGUARDANDO_PAGAMENTO` / `CONCLUIDO` permanecem para etapas futuras.

### Arquivos criados

- `tests/muv/pagamento-unificado-rateio-04-05.test.js`
- `docs/arquitetura/IMPLEMENTACAO_04_05_PAGAMENTO_UNIFICADO_RATEIO.md`
- `docs/arquitetura/IMPLEMENTACAO_04_05_RELATORIO.md`

### Arquivos alterados

- `backend/motores/muv/contratos.js` — status, formas, rateio em centavos
- `backend/motores/muv/atendimentoSchema.js` — `atendimento_pagamentos`, `atendimento_pagamento_rateios`
- `backend/motores/muv/AtendimentoMultiempresaService.js` — `confirmarPagamentoAtendimento`
- `backend/motores/muv/index.js` — comentário

### Schema

`atendimento_pagamentos` (forma, valor_centavos, valor, status, idempotency_key, payload_hash)  
`atendimento_pagamento_rateios` (pagamento, operação, empresa_id, valor_centavos, estrategia)

### Testes novos

`pagamento-unificado-rateio-04-05` — **32/32**

### Regressão

| Suite | Resultado |
|---|---|
| motor-universal-vendas-04-01 | 10/10 |
| modo-operacao-venda-04-02 | 14/14 |
| atendimento-multiempresa-04-03 | 25/25 |
| reserva-atendimento-multiempresa-04-04 | 27/27 |
| orquestrador-pagamento | OK |
| venda-mista-pagamento-integral | 13/13 |
| tef-fluxo-pagamento | OK |
| reservas-dual-write-empresa | 12/12 |
| dual-write-porta-publica-empresa-03-19 | 15/15 |
| porta-publica-saldos-multiempresa | 17/17 |
| consulta-saldo-porta-multiempresa | 12/12 |
| reservas-pdv-multiempresa-contexto | 10/10 |
| pedido-disponibilidade-multiempresa | 4/4 |
| pedido-mts-disponibilidade-multiempresa | 5/5 |
| mts-multiempresa-contexto | 10/10 |
| pedido-expedicao-multiempresa-contexto | 12/12 |
| venda-baixa-empresa-contexto | 12/12 |
| compras-multiempresa-contexto | 12/12 |
| credito-cancel-dev-venda-porta-publica | 12/12 |
| revert-devolucao-venda-porta-publica | 10/10 |
| muc-public-contract | 20/20 |

`tests/tef/tef.test.js` falha por `MODULE_NOT_FOUND` pré-existente (não é regressão desta sprint).

### Limitações

Sem vendas A/B/C, baixa definitiva, consumo de reserva, caixa, TEF real, NFC-e, XML, comprovante, UI.

### Próxima Sprint

**04.06** — materializar vendas A/B/C a partir do atendimento `PAGO` (ainda sem comprovante unificado, salvo decisão).
