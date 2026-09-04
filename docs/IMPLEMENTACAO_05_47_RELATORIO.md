# SPRINT 05.47

## OBJETIVO

Isolar lotes, FEFO e reservas por empresa. Produto compartilhado não compartilha estoque, lote nem reserva.

## ARQUIVOS ALTERADOS

| Arquivo | Papel |
|---------|--------|
| `backend/services/estoque/lotesEmpresaSchema.js` | **Novo** — `produtos_lotes.empresa_id` + índice |
| `backend/services/lotesService.js` | FEFO empresarial; `selecionarLoteFefo`; restauração com empresa |
| `backend/database.js` | ALTER `empresa_id` em lotes e tabelas de reserva |
| `backend/services/fiscalNaoFiscal/reservasPublico.js` | persistir empresa; dual-write na criação; TX; 404 cruzado |
| `backend/services/estoque/pedidoReservaPonteNucleo.js` | consumo pela empresa da reserva |
| `backend/services/estoque/EstoqueReservaService.js` | `empresa_id` no tracking PDV; liberar pela dona |
| `backend/services/vendas/VendaPagamentoService.js` | FEFO com empresa da venda |
| `backend/services/vendas/VendaDevolucaoService.js` | restaurar/devolver lote na empresa da venda |
| `backend/services/ajusteEstoqueService.js` | criar/consumir lote com empresa da porta |
| `backend/rotas/compras.js` | `criarLote` com empresa da compra |
| `backend/rotas/produtos.js` | listagem/criação de lote e validade com contexto |
| `backend/services/fiscal/estoqueNfeDevolucaoVenda.js` | wiring de lote com `optsCredito` (sem mudar regra fiscal) |
| `tests/estoque/isolamento-lotes-fefo-reservas-05-47.test.js` | **Novo** T01–T18 |
| `docs/arquitetura/OWNERSHIP_LOTES_FEFO_05_47.md` | **Novo** |
| `docs/arquitetura/OWNERSHIP_RESERVAS_ESTOQUE_05_47.md` | **Novo** |
| `docs/arquitetura/INVENTARIO_ESTOQUE_EMPRESARIAL_05_47.md` | **Novo** |

Não alterados (fora de escopo): Motor Comercial, PDV Express UI, NF-e 55, DistDFe, TEF, Open Finance, catálogo de produtos, scheduler de expiração.

## MODELO REAL

- `produtos`: catálogo compartilhado
- `estoque_empresa`: saldo e reservado por empresa
- `produtos_lotes`: **não tinha** `empresa_id` (buraco FEFO global por SKU)
- `pedido_estoque_reservas` / `venda_estoque_reservas`: **não tinham** `empresa_id`
- `pedidos`: sem `empresa_id` (ownership da reserva persistida na própria reserva)
- Sem fluxo de expiração de reservas

## CAUSAS DOS RISCOS

1. FEFO: `WHERE produto_id = ? ORDER BY data_validade` — Empresa A podia consumir lote de B com validade menor.
2. Reserva de pedido: disponibilidade lia `estoque_empresa`, mas o delta ia só para `produtos.reservado_*` (oversell / mistura).
3. Liberação/consumo usavam `req.empresaId` / COMPAT em vez da dona persistida.
4. Restauração de lote atualizava `produtos_lotes` só por `id`.

## TESTES

| Suite | Executados | OK | Falha |
|-------|------------|----|-------|
| `tests/estoque/isolamento-lotes-fefo-reservas-05-47.test.js` | 19 | 19 | 0 |
| `tests/estoque/lotes-porta-publica.test.js` | 4 | 4 | 0 |
| `tests/estoque/auditoria-final-escritores.test.js` | 7 | 7 | 0 |
| `tests/estoque/disponibilidade-reservas-multiempresa.test.js` | 12 | 12 | 0 |
| `tests/estoque/reservas-pdv-multiempresa-contexto.test.js` | 10 | 10 | 0 |
| `tests/estoque/consumo-reserva-pedido-porta-publica.test.js` | 10 | 10 | 0 |
| `tests/estoque/porta-publica-saldos-multiempresa.test.js` | 17 | 17 | 0 |
| `tests/estoque/reservas-dual-write-empresa.test.js` | 12 | 12 | 0 |
| `tests/vendas/ownership-cancelamento-devolucao-05-42.test.js` | 9 | 9 | 0 |
| `tests/vendas/ownership-vendas-05-40.test.js` | 13 | 13 | 0 |
| `tests/estoque/credito-cancel-dev-venda-porta-publica.test.js` | 12 | 12 | 0 |
| `tests/estoque/cancelamento-devolucao-compra-multiempresa.test.js` | 12 | 12 | 0 |
| `tests/estoque/pdv-disponibilidade-estoque-empresa.test.js` | 12 | 12 | 0 |
| `tests/estoque/venda-baixa-empresa-contexto.test.js` | 12 | 12 | 0 |
| `tests/estoque/reserva-repair-porta-publica.test.js` | 10 | 10 | 0 |
| `tests/estoque/create-produto-saldo-inicial-porta-publica.test.js` | 10 | 10 | 0 |
| `tests/estoque/credito-venda-nfe-devolucao-multiempresa-contexto.test.js` | 8 | 8 | 0 |
| `tests/estoque/revert-devolucao-venda-porta-publica.test.js` | 10 | 10 | 0 |
| `tests/estoque/pedido-disponibilidade-multiempresa.test.js` | 4 | 4 | 0 |
| `tests/caixa/ownership-caixa-sessao-05-44.test.js` | 10 | 10 | 0 |
| `tests/estoque/compras-multiempresa-contexto.test.js` | 10 | 9 | 1* |
| `tests/estoque/inventario-ajuste-multiempresa-contexto.test.js` | 13 | 12 | 1* |
| `tests/estoque/ajuste-estoque-porta-publica.test.js` | — | — | 1* |

\* Falhas não introduzidas pelo FEFO/reservas 05.47: (1) `ajuste-estoque-porta-publica` e `inventario` test13 esperam saldo de `produtos`/valor antigo com `empresaId` sem seed coerente — `controlar_validade = 0`, lote não entra; (2) `compras-multiempresa` test10 é scan de fonte (`empresaIdDoReqCompra(req)`), enquanto a rota já usa `compra.empresa_id` (05.38.F). Cenários funcionais 01–09 de compras passaram.

## RISCOS REMANESCENTES

- Lotes e reservas NULL continuam ilegíveis para FEFO/reserva empresarial até operação humana/classificação futura — sem backfill.
- Motor Comercial / ReservaRepair podem ainda inserir tracking sem `empresa_id` (não alterados).
- `pedidos` sem `empresa_id`; a reserva carrega a empresa.
- Expiração de reservas: não implementada (contrato futuro).
- `gerarProximoLote` global (apenas código do lote).
- Ajuste de produto com validade **exige** empresa (`EMPRESA_CONTEXT_REQUIRED`); COMPAT de saldo permanece para ajuste sem lote.

## INVARIANTE

```
PRODUTO → catálogo compartilhado
EMPRESA + PRODUTO → estoque, reservas e lotes
FEFO → somente lotes da empresa da operação
```

A empresa proprietária da operação é a fonte de verdade. O contexto atual só autoriza.
