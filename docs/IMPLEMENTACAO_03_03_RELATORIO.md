# SPRINT 03.03 — Fundação operacional de produtos e ficha técnica

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — classificação `produtos.tipo_operacional`; tabelas `ficha_tecnica` / `ficha_tecnica_itens`; PDV e venda recusam insumo; cadastro ERP com ficha. Sem baixa automática de ficha na venda. PDV Universal não alterado.

PDV OFICIAL:  
PDV NORMAL

PDV UNIVERSAL:  
CONGELADO

PRODUTO:  
Catálogo compartilhado (`produtos`). Coluna `tipo_operacional` (`COMERCIAL` default | `INSUMO`). Sem `produto_empresa`.

INSUMO:  
Mesmo cadastro; `INSUMO` fora do PDV (listagem, MIB origem pdv, MIP identificar, `VendaPagamentoService`).

FICHA TÉCNICA:  
Compartilhada (sem `empresa_id`). Cabeçalho só em comercial ativo. Itens: só insumos, quantidade > 0, unidade conhecida no Motor de Unidades. Sem aninhamento.

UNIDADES:  
`MotorUnidadesMedida` + `isUnidadeComercialConhecida` (não cai em UN para unidade inválida).

CONVERSÕES:  
`MotorConversao` reutilizado; sem conversor novo; sem consumo na venda.

CATÁLOGO:  
Um `produto.id` para todas as empresas.

ESTOQUE:  
`estoque_empresa.empresa_id` preservado.

MULTIEMPRESA:  
Contexto autoriza operação empresarial. Ficha não é ownership por CNPJ. Sem fallback empresa 1 / primeira empresa / COMPAT nos arquivos novos.

FRONTEND:  
ERP: tipo operacional + card de ficha no cadastro existente. PDV: `somente_vendaveis=1`.

BACKEND:  
`FichaTecnicaService`, rotas `GET /catalogo/insumos` e `GET|PUT /:id/ficha-tecnica`. Núcleo de venda: só bloqueio de insumo, sem `FichaTecnicaService`.

TESTES:  
25/25 (`tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js`)

REGRESSÕES:  
03.02 28/28 · 03.01 20/20 · 05.53 10/10 · 05.54 12/12 · 05.55 16/16 · 05.56 10/10 · 05.59 10/10 · 05.64 8/8 · 05.70 12/12 · 05.72 10/10 · 05.74 12/12 · 05.75 PDV Universal 12/12 · 05.76 18/18 · produto-embalagens 14/14 · motor conversão 15/15 · PDV PLU 17/17

FALHAS:  
nenhuma (após execução desta sprint)

RISCOS:  
1. `GET /produtos` sem `somente_vendaveis` (ERP) lista insumos — intencional.  
2. Ficha compartilhada: alterar receita vale para todas as lojas.  
3. Baixa de ficha, cubas e produção ficam para sprints seguintes.  
4. Schema no boot do banco oficial (coluna/tabelas novas).

PRÓXIMA SPRINT:  
Consumo da ficha técnica na venda (baixa de insumos), sem segundo motor; cubas em sprint própria.
