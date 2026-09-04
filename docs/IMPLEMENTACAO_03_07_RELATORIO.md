# SPRINT 03.07

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — estorno de insumos no cancelamento da venda. Sem DistDFe, Central, PDV Universal, MUV, cubas, devolução proporcional, NFC-e extra.

PONTO DO CANCELAMENTO:  
`VendaCancelamentoService.devolverEstoqueEEstornarFichaDaVenda` (PUT e POST), após ownership, dentro de `BEGIN IMMEDIATE`, depois do crédito comercial e **antes** do `UPDATE` para `cancelada`.

MECANISMO DE ESTORNO:  
`FichaTecnicaConsumoService.estornarConsumoFichaTecnicaDaVenda` → `creditarEstoqueItemVenda` (`exigirEmpresa: true`, origem `estorno_ficha_tecnica_cancelamento`).

SNAPSHOT:  
`venda_ficha_consumo_itens.quantidade` / `unidade` / `insumo_id`. Sem reler ficha vigente.

EMPRESA:  
`vendas.empresa_id` via `montarOpcoesRetornoEstoqueDaVenda`. Divergência no cabeçalho → bloqueio.

TRANSAÇÃO:  
Mesma `BEGIN IMMEDIATE` do cancelamento. Falha → `ROLLBACK`.

IDEMPOTÊNCIA:  
`venda_ficha_consumo.estornado_em` + recusa PUT/POST de venda já cancelada.

ROLLBACK:  
Crédito parcial de insumos desfeito com a transação; venda permanece concluída.

MULTIEMPRESA:  
Estorno A não altera estoque B.

CROSS-COMPANY:  
`exigirOperacaoReversaoDaVenda` + `FICHA_CONSUMO_EMPRESA_DIVERGENTE`. Sem mutação.

SEM FICHA:  
No-op (`sem_consumo`). Cancelamento existente preservado.

FICHA ALTERADA:  
Estorna o snapshot (ex. 200 g), não a ficha atual.

TESTES:  
20/20 (`tests/pastelaria/estorno-ficha-cancelamento-03-07.test.js`)

REGRESSÕES:  
03.01 · 03.02 · 03.03 · 03.04 · 03.05 · 03.06 (T08/T17/T18/T22 alinhados) · 05.40 · 05.42 · crédito cancel/dev · 05.53 · 05.54 · 05.55 · 05.56 · 05.59 · 05.64 · 05.70 · 05.72 · 05.74 · 05.75 · 05.76 · 05.77 · 05.80. Sem suíte 05.81 no repositório.

RISCOS RESTANTES:  
Devolução sem estorno de ficha (03.08). Split F/NF do consumo não persistido. NFC-e de cancel fora do BEGIN.
