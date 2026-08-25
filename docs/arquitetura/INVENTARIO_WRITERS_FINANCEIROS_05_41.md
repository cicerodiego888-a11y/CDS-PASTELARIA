# INVENTÁRIO DE WRITERS FINANCEIROS — Sprint 05.41

**Busca global:** `INSERT INTO financeiro` / `INSERT OR REPLACE` / `INSERT OR IGNORE` / `UPDATE financeiro` em `backend/` (produção).  
**INSERT OR REPLACE / IGNORE:** nenhum.

## Resumo

| Status | Qtd |
|--------|-----|
| SEGURO | 3 |
| CORRIGIDO | 5 |
| FORA_DE_ESCOPO | 2 |
| LEGADO | 0 |
| RISCO_ABERTO | 2 (os FORA_DE_ESCOPO de cancel/devolução) |

Total de INSERTs de produção auditados: **10** (em 8 arquivos).

---

## W1 — VENDA

### W1.a Venda a prazo

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/services/vendas/VendaPagamentoService.js` |
| Função | `inserirFinanceiroPrazo` (~1298) |
| Origem | PDV Express / ERP / PDV Universal — venda à prazo |
| empresa_id disponível? | Sim — `empresaIdVenda` (05.40 `exigirEmpresaDaOperacao`) |
| Fonte | `vendas.empresa_id` do mesmo fluxo |
| Grava empresa_id? | Sim |
| Risco | Baixo |
| Ação | CORRIGIDO — deixou de usar `req.empresaId \|\| null` |
| Status | **CORRIGIDO** |

### W1.b Venda à vista

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/services/vendas/VendaPagamentoService.js` |
| Função | INSERT após `buscarNomeCliente` (~1664) |
| Origem | mesma família W1 |
| empresa_id disponível? | Sim — `empresaIdVenda` |
| Fonte | contexto 05.40 |
| Grava empresa_id? | Sim |
| Risco | Baixo |
| Ação | CORRIGIDO — `empresaIdVenda` obrigatório |
| Status | **CORRIGIDO** |

---

## W2 — MUV / ATENDIMENTO

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/motores/muv/MaterializarOperacoesAtendimento.js` |
| Função | `persistirVendaOperacao` (~228) |
| Origem | Materialização de operação empresarial do atendimento |
| empresa_id disponível? | Sim — `operacao.empresaId` + `vendas.empresa_id` recém-persistido |
| Fonte | `resolverEmpresaDaOrigemFinanceira({ operacao, venda })` |
| Grava empresa_id? | Sim |
| Risco | Era o gap 05.39 (INSERT sem coluna). Prioridade obrigatória desta sprint. |
| Ação | CORRIGIDO — INSERT inclui `empresa_id`; falha com `EMPRESA_OWNERSHIP_REQUIRED` se origem sem empresa |
| Status | **CORRIGIDO** |

---

## W3 — ATENDIMENTO / ENTREGA (prestação)

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/services/entrega/MotorFinalizacaoVenda.js` |
| Função | `_finalizarPrestacaoInterno` (~447) |
| Origem | Prestação de contas da venda entrega |
| empresa_id disponível? | Sim — `venda.empresa_id`; caixa da sessão se presente |
| Fonte | `resolverEmpresaDaOrigemFinanceira({ venda, caixa })` |
| Grava empresa_id? | Sim |
| Risco | Divergência venda×caixa bloqueada (`FINANCEIRO_EMPRESA_DIVERGENTE`) |
| Ação | CORRIGIDO — INSERT passou a persistir `empresa_id` |
| Status | **CORRIGIDO** |

---

## W4 — RECEBIMENTO

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/rotas/contas_receber.js` |
| Função | pagar parcela (~185) |
| Origem | Baixa de parcela em contas a receber |
| empresa_id disponível? | Sim — middleware financeiro + `contas_receber.empresa_id` |
| Fonte | `empresaId` do contexto 05.38.D |
| Grava empresa_id? | Sim |
| Risco | Baixo |
| Ação | Nenhuma alteração de INSERT |
| Status | **SEGURO** |

---

## W5 — PAGAMENTO (parcial agrupado)

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/rotas/financeiro.js` |
| Função | `POST /receber/agrupado/:clienteId/pagamento-parcial` (~1607) |
| Origem | Recebimento parcial de duplicatas |
| empresa_id disponível? | Sim — contexto + `vendas.empresa_id` da conta |
| Fonte | `resolverEmpresaDaOrigemFinanceira({ venda, empresaId })` |
| Grava empresa_id? | Sim |
| Risco | INSERT anterior omitia a coluna |
| Ação | CORRIGIDO — coluna, filtro de contas e UPDATE com `empresa_id` |
| Status | **CORRIGIDO** |

---

## W6 — LANÇAMENTO MANUAL / CAIXA OPERACIONAL

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/rotas/financeiro.js` |
| Função | `inserirMovimentacao` / `POST /` (~198) |
| Origem | Lançamento manual no ERP |
| empresa_id disponível? | Sim — `req.empresaId` do middleware (não lê query) |
| Fonte | Contrato + `X-Empresa-Id` |
| Grava empresa_id? | Sim — rejeita se inválido (`FINANCEIRO_EMPRESA_OBRIGATORIA`) |
| Risco | Baixo |
| Ação | Nenhuma alteração de INSERT |
| Status | **SEGURO** |

---

## W7 — COMPRA / IMPORTAÇÃO

### W7.a Financeiro da compra

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/rotas/compras.js` |
| Função | geração de parcelas (~302) |
| Origem | Compra (XML ou manual) |
| empresa_id disponível? | Sim — `compra.empresa_id` |
| Fonte | ownership da compra (05.38.F) |
| Grava empresa_id? | Sim |
| Risco | Baixo |
| Ação | Nenhuma |
| Status | **SEGURO** |

### W7.b Crédito de devolução de compra

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/rotas/compras.js` |
| Função | devolução de itens da compra (~1058) |
| Origem | Devolução de compra (não é devolução de venda) |
| empresa_id disponível? | Sim — `empresaCompraId` já validado |
| Fonte | `compras.empresa_id` |
| Grava empresa_id? | Sim |
| Risco | Usava `req.empresaId \|\| null` |
| Ação | CORRIGIDO — persiste `empresaCompraId` |
| Status | **CORRIGIDO** |

---

## W8 — OUTROS (fora de escopo 05.41)

### W8.a Estorno de cancelamento de venda

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/services/vendas/VendaCancelamentoService.js` |
| Função | cancelar venda (~117) |
| Origem | Cancelamento de venda |
| empresa_id disponível? | Parcial — venda pode ter `empresa_id` (05.40) |
| Fonte | não persistida neste INSERT |
| Grava empresa_id? | **Não** |
| Risco | Novo estorno de cancelamento ainda pode nascer sem ownership |
| Ação | Não alterado (proibido nesta sprint) |
| Status | **FORA_DE_ESCOPO** / risco residual → Sprint 05.42 |

### W8.b Estorno de devolução de venda

| Campo | Valor |
|-------|--------|
| Arquivo | `backend/services/vendas/VendaFinanceiroService.js` |
| Função | estorno parcial (~327) |
| Origem | Devolução de venda |
| empresa_id disponível? | `opcoes.empresaId \|\| null` |
| Fonte | opção do chamador; pode ser NULL |
| Grava empresa_id? | Condicional |
| Risco | Devolução nova pode gravar NULL |
| Ação | Não alterado (proibido nesta sprint) |
| Status | **FORA_DE_ESCOPO** / risco residual → Sprint 05.42 |

---

## UPDATEs auditados

| Arquivo | Operação | Troca empresa_id? | Status |
|---------|----------|-------------------|--------|
| `rotas/financeiro.js` PUT | edição admin | Não (SET sem `empresa_id`) | SEGURO |
| `rotas/financeiro.js` baixar | status/baixa | Não; `WHERE empresa_id = ?` | SEGURO |
| `rotas/financeiro.js` pagamento-parcial | baixa parcela | Não; `WHERE id AND empresa_id` | CORRIGIDO |
| `rotas/contas_receber.js` | baixa parcela | Não | SEGURO |
| `utils/financeiroEmpresaHelpers.js` | backfill 05.38.D / 05.41 | Sim, só NULL → evidência | LEGADO/MIGRATION |
| `database.js` garantirColunasFinanceiro | origem/status/vencimento | Não toca empresa_id | SEGURO |
| `VendaFinanceiroService.js` | reduzir pendente / cancel | Fora de escopo | FORA_DE_ESCOPO |
| `rotas/compras.js` | vínculo compra | Não auditado como troca de ownership | SEGURO |

---

## Writers desconhecidos

Nenhum INSERT de produção adicional foi encontrado além dos listados. Testes/fixtures não são writers operacionais.
