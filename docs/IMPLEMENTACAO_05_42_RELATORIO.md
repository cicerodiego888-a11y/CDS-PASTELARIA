# SPRINT 05.42

## OBJETIVO

Garantir que cancelamento e devolução de venda usem exclusivamente `vendas.empresa_id` como ownership. Fechar os riscos 05.39 deixados fora de 05.40/05.41.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/vendas/VendaEmpresaContextoService.js` | `resolverEmpresaDaVenda`, `exigirOperacaoReversaoDaVenda` |
| `backend/services/vendas/creditoEstoqueVendaViaPorta.js` | `montarOpcoesRetornoEstoqueDaVenda` (empresa da venda, não do req) |
| `backend/services/vendas/VendaCancelamentoService.js` | Ownership antes de efeitos; estoque da venda; INSERT financeiro com `empresa_id` |
| `backend/services/vendas/VendaDevolucaoService.js` | Ownership antes do BEGIN; estoque da venda |
| `backend/services/vendas/VendaFinanceiroService.js` | Estorno de devolução via `resolverEmpresaDaOrigemFinanceira({ venda })` |
| `backend/rotas/vendas.js` | `anexarEmpresaVenda` em cancelar/devolver |
| `tests/vendas/ownership-cancelamento-devolucao-05-42.test.js` | **Novo** |
| `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js` | Wiring do helper novo |
| `docs/arquitetura/OWNERSHIP_CANCELAMENTO_DEVOLUCAO_05_42.md` | **Novo** |

Não alterados (fora de escopo): Motor Comercial, PDV Express, NFC-e (apenas gated por ownership), lotes/FEFO, reservas, DistDFe, caixa LIMIT 1, regras fiscais.

## WRITERS CORRIGIDOS

| Writer | Antes | Depois |
|--------|--------|--------|
| `cancelarVendaPut` / `Post` | `SELECT id=?`; estoque `req.empresaId`/COMPAT; INSERT financeiro sem `empresa_id` | Ownership da venda; estoque `venda.empresa_id`; INSERT com `empresa_id` |
| `devolverParcial` | `SELECT id=?`; estoque do req | Ownership da venda; estoque `venda.empresa_id` |
| `recalcularFinanceiroDevolucaoVenda` | `opcoes.empresaId \|\| null` | `resolverEmpresaDaOrigemFinanceira({ venda })` |

## PONTOS DE ESTOQUE AUDITADOS

- Cancelamento total PUT: `devolverEstoqueItensVenda` → `creditarEstoqueItemVenda`
- Cancelamento total POST: idem
- Devolução parcial: `devolverEstoqueParcialItem` → `devolverSaldosDistribuidos` → mesma porta
- Lotes/FEFO: **não alterados** (fora de escopo)

## PONTOS FINANCEIROS AUDITADOS

- PUT cancelamento: INSERT estorno com `empresa_id`
- POST cancelamento: apenas `cancelarFinanceiroVenda` (UPDATE por `venda_id`; sem INSERT novo — regra contábil inalterada)
- Devolução: INSERT estorno com `empresa_id` da venda; bloqueio se venda sem ownership **antes** dos UPDATEs

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/vendas/ownership-cancelamento-devolucao-05-42.test.js` | 9 | 9 | 0 |
| `tests/vendas/ownership-vendas-05-40.test.js` | 13 | 13 | 0 |
| `tests/financeiro/ownership-financeiro-05-41.test.js` | 14 | 14 | 0 |
| `tests/financeiro/financeiro-multiempresa-05-38-d.test.js` | 20 | 20 | 0 |
| `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js` | 12 | 12 | 0 |
| `tests/estoque/credito-venda-nfe-devolucao-multiempresa-contexto.test.js` | 8 | 8 | 0 |
| `tests/estoque/revert-devolucao-venda-porta-publica.test.js` | 10 | 10 | 0 |
| **Total desta verificação** | **86** | **86** | **0** |

## RISCOS REMANESCENTES (reais, fora de escopo)

- NFC-e de cancelamento/devolução fiscal continua com as regras fiscais já existentes; esta sprint só impede executá-las sem ownership da venda
- Restauração de lotes FEFO permanece global (não tocada)
- POST `/cancelar/:id` não gera o INSERT de estorno que o PUT gera (comportamento pré-existente)
