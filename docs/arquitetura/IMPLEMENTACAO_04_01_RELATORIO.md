# Relatório — Sprint 04.01
## Arquitetura oficial do Motor Universal de Vendas

**Data:** 2026-08-21 · **Status:** concluída (auditoria + contratos; sem orquestração)

### Decisão

**Entidade universal: ATENDIMENTO** (não VENDA_MESTRE).

`vendas` permanece o documento fiscal/financeiro/caixa por empresa. O atendimento é o checkout único do cliente.

Modos: `EMPRESA_UNICA` (default) e `MULTIEMPRESA`. Operação empresarial exige `empresaId` validado.

### Arquivos auditados (principais)

- `VendaApplicationService.js`, `VendaPagamentoService.js`, `VendaOrigin.js`, `VendaContext.js`, `VendaContract.js`
- `rotas/vendas.js`, `CriarVendaEntregaService.js`, `EstoqueReservaService.js`
- `FaturamentoService.js`, `PedidoOperacionalService.js`, Motor Comercial, MTS
- `estoqueSaldosPublico.js`, `reservasPublico.js`, `database.js` (vendas*)
- `OrquestradorPagamento.js`, `configuracaoService.js`

### Arquivos criados

- `backend/motores/muv/contratos.js`
- `backend/motores/muv/index.js`
- `docs/arquitetura/ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md`
- `docs/arquitetura/MAPA_TRANSICAO_MOTOR_UNIVERSAL_VENDAS.md`
- `docs/arquitetura/IMPLEMENTACAO_04_01_RELATORIO.md`
- `tests/arquitetura/motor-universal-vendas-04-01.test.js`

### Arquivos alterados

Nenhum fluxo de produção (PDV, TEF, fiscal, MTS, Motor Comercial, estoque).

### Testes

`tests/arquitetura/motor-universal-vendas-04-01.test.js`

### Limitações

- Modo ainda não está no `configuracaoService`.
- Sem tabela de atendimento.
- `vendas` sem `empresa_id`.
- TEF/caixa/fiscal multiempresa só contratados.

### Riscos

Ver §12 da arquitetura v1. O maior: isolamento de estoque já existe; o documento `vendas` ainda é global.

### Próxima Sprint recomendada

**04.02** — ligar `modo_operacao_venda` na configuração da instalação (default `EMPRESA_UNICA`) e resolver o modo na porta `VendaApplicationService` sem mudar o comportamento do PDV.

**04.02 não iniciada.**
