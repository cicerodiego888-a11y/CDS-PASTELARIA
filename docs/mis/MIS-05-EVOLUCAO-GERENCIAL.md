# MIS-05 — Evolução gerencial

STATUS: implementado (evolução do MIS-04, sem segundo produto)

## O que mudou

O `GET /api/mis/resumo` continua sendo a única API de tela.

Novos campos na resposta (compatíveis com 04.02):

- `evolucao`: série diária completa do período (`data`, `faturamento`, `total_vendas`). Dias sem venda vêm com zero.
- `comparacao`: `{ habilitada: false }` por padrão. Com `?comparar=1`, compara faturamento, nº de vendas e ticket médio com o período imediatamente anterior de mesma duração.

## Regras preservadas

- Empresa só pelo contexto autorizado (`resolverEmpresaIdParaMis`).
- Query `empresa_id` ignorada.
- Sem “todas as empresas”.
- Ranking: `rankingProdutosPorEmpresa` / `vendas_itens.quantidade` / máximo 10 / sem MUC.
- Estoque crítico: `estoque_empresa`, mínimo configurado > 0.
- Receber: saldo em aberto (aberto/parcial), fora do período de vendas.
- Compras: `data_compra`.
- NFC-e: JOIN venda, `COALESCE(created_at, data_venda)`.
- `modo_fiscal` nas consultas de venda (totais, série e comparação).

## Período anterior

Exemplo: 01/09–03/09 → 29/08–31/08.

Variação: `((atual - anterior) / anterior) × 100`.

- anterior = 0 e atual = 0 → `sem_variacao` (sem NaN/Infinity)
- anterior = 0 e atual ≠ 0 → `sem_base`

## Frontend

Checkbox **Comparar com período anterior** (desligado por padrão).

Gráfico Chart.js já vendido no ERP + tabela textual da série.

Troca de empresa: limpa a tela, loading, recarrega todos os blocos (`cds-empresa-contexto-alterado`).
