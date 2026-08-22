# Relatório — Sprint 04.03
## Atendimento multiempresa + operações empresariais

**Data:** 2026-08-21 · **Status:** concluída (núcleo persistente; sem pagamento)

### Decisão

O modo `MULTIEMPRESA` deixa de devolver `MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO` e passa a persistir um **ATENDIMENTO** com N **operações empresariais** e itens, validando estoque em `estoque_empresa`. Status máximo: `VALIDADO`. Não cria `vendas` e não chama `VendaPagamentoService`.

`EMPRESA_UNICA` permanece no fluxo atual, sem atendimento oculto.

### Arquivos criados

- `backend/motores/muv/atendimentoSchema.js`
- `backend/motores/muv/AtendimentoMultiempresaService.js`
- `tests/muv/atendimento-multiempresa-04-03.test.js`
- `docs/arquitetura/IMPLEMENTACAO_04_03_ATENDIMENTO_MULTIEMPRESA.md`
- `docs/arquitetura/IMPLEMENTACAO_04_03_RELATORIO.md`

### Arquivos alterados

- `backend/motores/muv/contratos.js` — status, validação de itens, agrupamento, centavos
- `backend/motores/muv/index.js` — schema + serviço (lazy)
- `backend/database.js` — bootstrap do schema
- `backend/services/vendas/VendaApplicationService.js` — executor MULTIEMPRESA
- `tests/muv/modo-operacao-venda-04-02.test.js` — MULTIEMPRESA não cai no legado (sem exigir NAO_IMPLEMENTADO)
- `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js` — fixture com `estoque_empresa` (leitura 03.35)
- `tests/estoque/revert-devolucao-venda-porta-publica.test.js` — mesmo fixture

### Schema

`atendimentos`, `atendimento_operacoes`, `atendimento_operacao_itens`

### Fluxo real

Validar → agrupar → estoque por empresa → TX única → preview `VALIDADO` / `venda_concluida: false` / `pagamento_pendente: true`.

### EMPRESA_UNICA

Inalterado: PDV/Faturamento/NF avulsa → `VendaPagamentoService`.

### MULTIEMPRESA

Atendimento persistido. Sem pagamento. Sem venda. Sem queda no legado.

### Atomicidade

`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` total.

### Testes novos

`tests/muv/atendimento-multiempresa-04-03.test.js` — **25/25**

### Regressão

| Suite | Resultado |
|---|---|
| motor-universal-vendas-04-01 | 10/10 |
| modo-operacao-venda-04-02 | 14/14 |
| VendaApplicationService + multi-origem + faturamento 3.1 + MUC | 24/24 |
| porta-publica-saldos-multiempresa | 17/17 |
| consulta-saldo-porta-multiempresa | 12/12 |
| reservas-dual-write-empresa | 12/12 |
| reservas-pdv-multiempresa-contexto | 10/10 |
| mts-multiempresa-contexto | 10/10 |
| pedido-expedicao-multiempresa-contexto | 12/12 |
| pedido-disponibilidade-multiempresa | 4/4 |
| pedido-mts-disponibilidade-multiempresa | 5/5 |
| compras-multiempresa-contexto | 12/12 |
| venda-baixa-empresa-contexto | 12/12 |
| credito-cancel-dev-venda-porta-publica | 12/12 |
| revert-devolucao-venda-porta-publica | 10/10 |

### Limitações

Sem reserva, sem pagamento, sem `vendas`, sem UI. Dois previews podem concorrer no mesmo saldo.

### Próxima Sprint

**04.04** — reserva / preparação de pagamento. **Não iniciada.**
