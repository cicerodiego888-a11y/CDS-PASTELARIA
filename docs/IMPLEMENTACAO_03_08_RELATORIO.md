# SPRINT 03.08

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — estorno proporcional de insumos na devolução de venda. Sem Central, PDV Universal, MUV, cubas, NFC-e extra.

FLUXO DE DEVOLUÇÃO:  
`POST /api/vendas/:id/devolver` → `VendaDevolucaoService.devolverParcial`. Rotas NFe de devolução não entram no estorno da ficha.

PONTO DE INTEGRAÇÃO:  
Após INSERT `vendas_devolucoes` e crédito comercial, na mesma `BEGIN IMMEDIATE`: `estornarConsumoFichaTecnicaDaDevolucao`.

CÁLCULO PROPORCIONAL:  
`snapshot × quantidade_devolvida / quantidade_vendida` (soma de `vendas_itens` do produto). `round3`.

SNAPSHOT:  
`venda_ficha_consumo_itens`. Sem reler ficha vigente.

QUANTIDADE VENDIDA:  
`SUM(vendas_itens.quantidade)` do `produto_id` na venda.

QUANTIDADE DEVOLVIDA:  
`splitDevolucao.qtdTotal` da linha devolvida.

LIMITE DE ESTORNO:  
Acumulado em `venda_ficha_consumo_estornos` ≤ snapshot por produto×insumo.

IDEMPOTÊNCIA:  
`venda_devolucao_id` (PK de `vendas_devolucoes`).

DEVOLUÇÕES SUCESSIVAS:  
Somam até o snapshot; o excedente é cortado.

EMPRESA:  
`vendas.empresa_id` (`montarOpcoesRetornoEstoqueDaVenda`).

MULTIEMPRESA:  
Devolver A não altera estoque B.

CROSS-COMPANY:  
`exigirOperacaoReversaoDaVenda` + `FICHA_CONSUMO_EMPRESA_DIVERGENTE`.

TRANSAÇÃO:  
`BEGIN IMMEDIATE` existente.

ROLLBACK:  
Falha em qualquer insumo desfaz devolução e créditos.

UNIDADES:  
As do snapshot (ex. L já convertido).

TESTES:  
25/25 (`tests/pastelaria/estorno-ficha-devolucao-03-08.test.js`)

REGRESSÕES:  
03.01–03.07 · 05.40 · 05.42 · 05.53–05.56 · 05.59 · 05.64 · 05.70 · 05.72 · 05.74–05.77 · 05.80. Sem suíte 05.81 no repositório.

RISCOS RESTANTES:  
Split F/NF não persistido no consumo. NFe de devolução fiscal isolada. Dual-write de saldo.
