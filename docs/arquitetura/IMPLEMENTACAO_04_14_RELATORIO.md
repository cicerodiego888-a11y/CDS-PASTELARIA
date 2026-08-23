# Relatório — Sprint 04.14

## Auditoria de Prontidão para o PDV Universal

### 1. Decisão final

**B — PRONTO COM PENDÊNCIAS NÃO BLOQUEADORAS**

### 2. Resumo executivo

A fundação 04.01–04.13 permite iniciar a Fase 05 sem reescrever motores, estoque, pagamento ou fiscal. EMPRESA_UNICA permanece no fluxo atual (`POST /api/vendas`). MULTIEMPRESA tem o ciclo completo **em serviços**; faltam wrappers HTTP nas etapas intermediárias — isso é trabalho de fachada nas sprints 05.06–05.08, não lacuna de regra de negócio.

### 3. Mapa dos contratos existentes

ATENDIMENTO → operações por `empresaId` persistido → materialização de venda por empresa → NFC-e por empresa → um comprovante unificado. Sem VENDA_MESTRE.

### 4. Modo de operação

`modo_operacao_venda` em `configuracaoService`. Valor inválido bloqueado. MULTIEMPRESA não cai no legado. Consulta/alteração administrativa via `/api/configuracoes-avancadas` (SuperAdmin).

### 5. Empresas e contexto operacional

`GET /api/empresas`, `?ativo=`, contexto disponível/selecionado. Dados suficientes para seletor.

### 6. Produtos e identificação automática

Catálogo compartilhado. Empresa do saldo **não** nasce do produto: o item MUV exige `empresaId`. A 05.04 implementa a escolha visual.

### 7. Estoque e disponibilidade

`consultarDisponibilidade` + `estoque_empresa`. Sem linha isolada → 0. Outra empresa não autoriza.

### 8. Carrinho universal

Contrato de itens MUV + agrupamento no backend. EMPRESA_UNICA usa o contrato de venda atual.

### 9. Checkout EMPRESA_UNICA

Reutilizável. `vendaId`, pagamento, DANFE. Sem atendimento oculto.

### 10. Checkout MULTIEMPRESA

Serviços: criar, reservar, pagar, materializar, fiscalizar, comprovante, imprimir. HTTP hoje: criar (via vendas) + comprovante + imprimir.

### 11. Pagamento e rateio

04.05. Frontend informa formas, valores e estratégia.

### 12. Fiscalização

Por empresa, status e retry no serviço. UI acompanha via comprovante.

### 13. Comprovante

GET oficial JSON/TEXT/HTML. Um comprovante A/B/C.

### 14. Impressão

POST imprimir PREVIEW/BROWSER/THERMAL preparado. Sem auto-print.

### 15. Matriz de prontidão da Fase 05

Ver `AUDITORIA_PRONTIDAO_PDV_UNIVERSAL_04_14.md`. Nenhum BLOQUEADO.

### 16. Bloqueadores

Nenhum.

### 17. Pendências não bloqueadoras

GET leve do modo; HTTP do ciclo MULTIEMPRESA; regra visual de `empresaId` no carrinho; ESC/POS real.

### 18. Alterações realizadas

Nenhuma alteração de produção foi realizada.

Arquivos desta sprint: auditoria, relatório, teste 04.14, menção no roadmap da V1.

### 19. Testes

`tests/muv/auditoria-prontidao-pdv-universal-04-14.test.js` — 18 casos de contrato.

### 20. Regressão

04.01–04.14: **OK**. Críticos: MUC, VendaApplicationService, OrquestradorPagamento, TEF fluxo, dual-write 03.19, reservas, consulta de saldo, Pedido/MTS, Expedição, compras, venda baixa, cancelamento/devolução/revert: **OK**. Nenhuma falha introduzida pela 04.14.

### 21. DECISÃO SOBRE A FASE 05

**A Sprint 05.01 pode começar? SIM.**

A FASE 05 — PDV UNIVERSAL está oficialmente apta para início.

Primeira sprint: **05.01 — FUNDAÇÃO DO PDV UNIVERSAL**.

Não criar outra sprint de auditoria de fundação.
