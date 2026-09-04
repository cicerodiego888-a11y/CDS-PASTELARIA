# MIS 04.02 — Produto mínimo

**Status:** CONCLUÍDA  
**Bloco:** 04 — MIS  
**Escopo:** primeira tela gerencial da **empresa do contexto operacional**. Sem consolidação. Sem Bloco 6.

## 1. Objetivo

Responder, para a empresa atual e o período escolhido:

- quanto vendeu, quantas vendas, ticket médio;
- quanto comprou;
- quanto tem a receber (saldo em aberto);
- quantas NFC-e e valor associado;
- quais produtos mais vendem;
- se há estoque crítico.

## 2. Tela

Menu **Painel → MIS** (`frontend/erp/pages/mis.html` + `frontend/erp/js/mis.js`).  
O Dashboard permanece. Atalhos Hoje / 7 dias / 30 dias / Este mês apenas preenchem datas e chamam `GET /api/mis/resumo`.

## 3. API

`GET /api/mis/resumo?inicio=YYYY-MM-DD&fim=YYYY-MM-DD&modo_fiscal=0|1`

Permissão: `relatorios` (igual ao dashboard).  
O backend ignora `empresa_id` de query; usa `resolverEmpresaIdParaMis`.

## 4–5. Indicadores e origem

| Bloco | Service | Data / regra |
|-------|---------|----------------|
| Vendas | `faturamentoPorEmpresa` | `vendas.data_venda` |
| Compras | `comprasPorEmpresa` | `compras.data_compra` |
| Receber | `financeiroReceberPorEmpresa` | saldo `aberto`/`parcial` (não é faturamento) |
| Fiscal | `fiscalNfcePorEmpresa` | `COALESCE(nfce.created_at, venda.data_venda)` |
| Ranking | `rankingProdutosPorEmpresa` | `vendas_itens.quantidade` persistida (sem MUC) |
| Estoque | `estoqueCriticoPorEmpresa` | `estoque_empresa` vs `produtos.estoque_minimo` |

Orquestração: `MisResumoService.obterResumoMis` via `Promise.all`. Sem SQL na rota.

## 6. Contexto empresarial

EMPRESA_SIMPLES → `empresa_operacional_id`.  
MULTIEMPRESA → `req.empresaId` / `X-Empresa-Id`.  
Autorização: `UsuarioEmpresaService.exigirEmpresaAutorizada`.  
Sem “todas as empresas”, empresa 1 ou primeira empresa.

## 7. Período

Filtro `date(...) BETWEEN inicio AND fim` nas entidades com data. Contas a receber **não** usam o período (saldo em aberto).

## 8. Regras

- Números primeiro; sem gráficos nesta versão.
- Modo fiscal: mesma expressão já usada pelo `MisIndicadoresService`.
- Sem DRE, margem, fluxo de caixa, Monitoring Engine, MUC.

## 9. Limitações

- NFC-e apenas (sem NF-e/SPED).
- Ranking = quantidade gravada, não reconvertida.
- Estoque crítico exige `estoque_minimo > 0`.
- Contas a receber = estoque de títulos, não “recebido no período”.

## 10. Testes

`tests/mis/mis-04-02-produto.test.js` (T01–T15 + isolamento + empty state).
