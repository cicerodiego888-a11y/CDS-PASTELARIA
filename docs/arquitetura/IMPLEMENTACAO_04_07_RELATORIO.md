# Relatório — Sprint 04.07
## Documentos fiscais por empresa + comprovante unificado

**Data:** 2026-08-22 · **Status:** concluída (orquestração + referências + contrato; sem impressão física)

### Decisão

Não criar motor fiscal paralelo. `FiscalizarAtendimentoService` chama `emissor.emitirPorVendaId(vendaId)` por operação materializada. XML permanece em `nfce_notas`. Resultados parciais são estado válido. Retry não reemite autorizado.

### Arquivos criados

- `backend/motores/muv/FiscalizarAtendimentoService.js`
- `tests/muv/fiscal-atendimento-multiempresa-04-07.test.js`
- `docs/arquitetura/IMPLEMENTACAO_04_07_FISCAL_ATENDIMENTO_MULTIEMPRESA.md`
- `docs/arquitetura/IMPLEMENTACAO_04_07_RELATORIO.md`

### Arquivos alterados

- `backend/motores/muv/contratos.js` — status fiscais e fluxo 04.07
- `backend/motores/muv/atendimentoSchema.js` — `atendimento_operacao_documentos`
- `backend/motores/muv/AtendimentoMultiempresaService.js` — reexporta fiscalizar/comprovante
- `backend/motores/muv/index.js`
- `backend/services/vendas/VendaApplicationService.js` — wrapper MULTIEMPRESA
- `docs/arquitetura/ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md` — 04.07 concluída; 04.08+ residual

### Testes novos

`fiscal-atendimento-multiempresa-04-07` — **30/30**

### Regressão

| Suite | Resultado |
|---|---|
| motor-universal-vendas-04-01 | 10/10 |
| modo-operacao-venda-04-02 | 14/14 |
| atendimento-multiempresa-04-03 | 25/25 |
| reserva-atendimento-multiempresa-04-04 | 27/27 |
| pagamento-unificado-rateio-04-05 | 32/32 |
| materializacao-operacoes-multiempresa-04-06 | 32/32 |
| fiscal-atendimento-multiempresa-04-07 | 30/30 |
| muc-public-contract | 20/20 |
| rc7104-estabilizacao-nfce | OK |
| orquestrador-pagamento | OK |
| tef-fluxo-pagamento | 13/13 |
| dual-write 03.19 / reservas 03.20 | 15/15 + 12/12 |
| portas saldo / consulta | 17/17 + 12/12 |
| venda-baixa / compras | 12/12 + 12/12 |
| cancel/devolução/revert | 12/12 + 10/10 |
| pedido / MTS / expedição | 5/5 + 10/10 + 12/12 |
| fiscal-platform | 14 ok, 1 falha pré-existente (`FiscalWebServices` 26 !== 24); sem dependência do MUV |

### Limitações restantes (não 04.08)

- Impressão física do comprovante
- Colunas fiscais em `vendas_itens` na materialização 04.06
- Config SEFAZ por empresa (emissor usa config global)
- Cancelamento fiscal multiempresa
- TEF/PIX/caixa visuais multiempresa
- UI de modo / novo PDV

### Próxima Sprint

**04.08** — não iniciada.
