# SPRINT 05.41

## OBJETIVO

Eliminar gaps de ownership nos writers que criam ou materializam registros financeiros. Toda operação financeira empresarial nova deve persistir `financeiro.empresa_id` explícito, fluindo da origem (em especial `vendas.empresa_id` da 05.40). Sem inferência silenciosa, empresa 1, último caixa ou config global.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/database.js` | Encadeia migration 05.41 após 05.40 |
| `backend/utils/financeiroEmpresaHelpers.js` | Backfill confiável + `idx_financeiro_empresa_id` |
| `backend/services/financeiro/FinanceiroEmpresaContextoService.js` | `resolverEmpresaDaOrigemFinanceira`, `exigirLancamentoDaEmpresa`, `EMPRESA_OWNERSHIP_REQUIRED` |
| `backend/motores/muv/MaterializarOperacoesAtendimento.js` | INSERT financeiro com `empresa_id` |
| `backend/services/vendas/VendaPagamentoService.js` | INSERT usa `empresaIdVenda` (não `\|\| null`) |
| `backend/services/entrega/MotorFinalizacaoVenda.js` | INSERT com `empresa_id` da venda/caixa |
| `backend/rotas/financeiro.js` | Pagamento parcial, GET 404 cruzado, filtros de listagem/relatório |
| `backend/rotas/compras.js` | Devolução de compra persiste `empresaCompraId` |
| `tests/financeiro/ownership-financeiro-05-41.test.js` | **Novo** |
| `docs/arquitetura/OWNERSHIP_FINANCEIRO_05_41.md` | **Novo** |
| `docs/arquitetura/INVENTARIO_WRITERS_FINANCEIROS_05_41.md` | **Novo** |

Não alterados (fora de escopo): `VendaCancelamentoService.js`, `VendaFinanceiroService.js` (estorno devolução), NFC-e, caixa, reservas, lotes, DistDFe.

## ESTRUTURA FINANCEIRO

Classificação: **A — `financeiro` já possui `empresa_id`** (Sprint 05.38.D).

- Coluna duplicada: **não**
- Migration de coluna: desnecessária (helper garante ALTER só se faltar em DB antigo)
- Índice novo: `idx_financeiro_empresa_id`
- Índice pré-existente: `idx_financeiro_empresa_status`

## MIGRATIONS

`migrarOwnershipFinanceiro0541` em `financeiroEmpresaHelpers.js`, disparada em `inicializarBanco` **depois** de `migrarEmpresaIdVendas` (05.40).

Backfill somente com evidência:

1. `vendas.empresa_id`
2. `atendimento_operacoes.empresa_id` (MUV)
3. `caixa_sessoes.empresa_id`
4. `compras.empresa_id`

Restante: `NULL` (`LEGADO_SEM_OWNERSHIP`). Não usa empresa operacional.

Log: `[05.41] MIGRATION_FINANCEIRO_EMPRESA_05_41 | TOTAL_FINANCEIRO=… | CLASSIFICADO_VIA_VENDA=… | … | LEGADO_SEM_OWNERSHIP=…`

A classificação no banco oficial ocorre na inicialização. Nos testes isolados: TOTAL 5 / VENDA 1 / MUV 1 / CAIXA 1 / OUTRA 1 / LEGADO 1.

## WRITERS

| Writer | Arquivo | Status |
|--------|---------|--------|
| W1 prazo / à vista | `VendaPagamentoService.js` | CORRIGIDO |
| W2 MUV | `MaterializarOperacoesAtendimento.js` | CORRIGIDO |
| W3 prestação entrega | `MotorFinalizacaoVenda.js` | CORRIGIDO |
| W4 recebimento parcela | `contas_receber.js` | SEGURO |
| W5 pagamento parcial | `rotas/financeiro.js` | CORRIGIDO |
| W6 lançamento manual | `rotas/financeiro.js` | SEGURO |
| W7.a compra | `rotas/compras.js` | SEGURO |
| W7.b devolução compra | `rotas/compras.js` | CORRIGIDO |
| W8.a cancelamento venda | `VendaCancelamentoService.js` | FORA_DE_ESCOPO |
| W8.b devolução venda | `VendaFinanceiroService.js` | FORA_DE_ESCOPO |

Inventário: `docs/arquitetura/INVENTARIO_WRITERS_FINANCEIROS_05_41.md`

## LEITURAS

- `GET /` , resumo, dashboard, receber/pagar: `empresa_id = ?` (exclui NULL)
- `GET /proximos-vencimentos`, relatórios resumo/receber/fluxo/inadimplência: filtro aplicado
- Dívida agrupada / extrato / pagamento parcial: `contas_receber.empresa_id`
- `GET /:id`, baixar receber/pagar: outra empresa ou NULL → **404** `FINANCEIRO_NAO_ENCONTRADO`
- `query.empresa_id` não é fonte de autorização

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/financeiro/ownership-financeiro-05-41.test.js` | 14 | 14 | 0 |
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | 20 | 20 | 0 |
| `tests/vendas/ownership-vendas-05-40.test.js` | 13 | 13 | 0 |
| `tests/muv/materializacao-operacoes-multiempresa-04-06.test.js` | 32 | 32 | 0 |
| `tests/muv/fiscal-atendimento-multiempresa-04-07.test.js` | 30 | 30 | 0 |
| `tests/muv/contexto-fiscal-multiempresa-04-08.test.js` | 30 | 30 | 0 |
| `tests/muv/comprovante-unificado-atendimento-04-10.test.js` | 34 | 34 | 0 |
| **Total desta verificação** | **173** | **173** | **0** |

Cobertura 05.41: empresas A/B, listagem isolada, 404 cruzado, materializar sem ownership, coerência venda/caixa, legado NULL oculto, writers com `empresa_id`, backfill confiável (venda/MUV/caixa/compra/NULL).

## GAPS (não ocultados)

- Estorno de **cancelamento de venda** ainda INSERT sem `empresa_id` → 05.42
- Estorno de **devolução de venda** pode gravar `empresa_id` NULL → 05.42
- Backfill 05.38.D histórico pode ter preenchido NULL com empresa operacional; 05.41 **não reclassifica** esses registros
- `consultarRecebimentosVendaSplit` lê `venda_recebimentos` (não `financeiro`); isolamento de vendas já é 05.40

## CRITÉRIOS DE ACEITE

- [x] estrutura financeira auditada
- [x] `financeiro.empresa_id` validado (já existia)
- [x] índice `idx_financeiro_empresa_id`
- [x] backfill só com fontes confiáveis; resto NULL
- [x] MaterializarOperacoesAtendimento corrigido
- [x] INSERTs operacionais auditados e classificados
- [x] novos lançamentos empresariais exigem empresa_id
- [x] leituras filtram empresa; cruzado 404
- [x] coerência venda/caixa validada no resolver
- [x] legado NULL fora da listagem operacional
- [x] testes de isolamento
- [x] relatório final
