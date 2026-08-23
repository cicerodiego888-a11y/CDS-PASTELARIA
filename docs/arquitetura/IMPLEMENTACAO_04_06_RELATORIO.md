# Relatório — Sprint 04.06
## Materialização das operações empresariais

**Data:** 2026-08-22 · **Status:** concluída (vendas reais + estoque + reservas; sem NFC-e)

### Decisão

Não chamar `VendaPagamentoService.criarVenda` (TX aninhada + novo recebimento). Orquestrar na TX do MUV e reutilizar a porta de baixa e a porta de reservado.

### Arquivos criados

- `backend/motores/muv/MaterializarOperacoesAtendimento.js`
- `tests/muv/materializacao-operacoes-multiempresa-04-06.test.js`
- `docs/arquitetura/IMPLEMENTACAO_04_06_MATERIALIZACAO_OPERACOES.md`
- `docs/arquitetura/IMPLEMENTACAO_04_06_RELATORIO.md`

### Arquivos alterados

- `backend/motores/muv/contratos.js` — `MATERIALIZANDO`, `CONSUMIDA`, fluxo 04.06
- `backend/motores/muv/atendimentoSchema.js` — `venda_id`, materialização, CHECK `CONSUMIDA`
- `backend/motores/muv/AtendimentoMultiempresaService.js` — `materializarAtendimento`
- `backend/services/vendas/VendaApplicationService.js` — wrapper MULTIEMPRESA
- `backend/motores/muv/index.js`

### Testes novos

`materializacao-operacoes-multiempresa-04-06` — **32/32**

### Regressão

| Suite | Resultado |
|---|---|
| motor-universal-vendas-04-01 | 10/10 |
| modo-operacao-venda-04-02 | 14/14 |
| atendimento-multiempresa-04-03 | 25/25 |
| reserva-atendimento-multiempresa-04-04 | 27/27 |
| pagamento-unificado-rateio-04-05 | 32/32 |
| orquestrador-pagamento | OK |
| dual-write 03.19 / reservas 03.20 | 15/15 + 12/12 |
| portas saldo / consulta | 17/17 + 12/12 |
| venda-baixa / compras | 12/12 + 12/12 |
| cancel/devolução/revert | 12/12 + 10/10 |
| pedido / MTS / expedição | 4/4 + 10/10 + 12/12 |
| muc-public-contract | 20/20 |

### Limitações

Sem NFC-e, XML, comprovante, TEF, UI. Sem coluna `empresa_id` em `vendas` (vínculo em `atendimento_operacoes.venda_id`).

### Próxima Sprint

**04.07** — NFC-e / documentos fiscais por empresa + comprovante unificado (não iniciada).
