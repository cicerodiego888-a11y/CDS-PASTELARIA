# SPRINT MUC-03

STATUS:  
CONCLUÍDA

TIPO:  
CONFIGURAÇÃO DE PRODUTO (não auditoria; não novo motor)

MUC:  
MUC-02 permanece a autoridade de cálculo. MUC-03 persiste a regra no cadastro.

CAMPOS:  
`produtos.utiliza_conversao` (default 0), `produtos.unidade_estoque`, relações em `muc_produto_relacoes`. Apresentações continuam em `produto_embalagens`. Sem `empresa_id` na configuração.

API:  
GET/PUT `/api/produtos/:id/conversao`; POST `.../conversao/simular`; DELETE `.../conversao/relacoes/:relacaoId`; POST/PUT produto persiste a config.

UI:  
Painel Conversão / estoque na tela de produtos (`produto-embalagens.js` + `saveProduto`). Sem tela “Cadastro de MUC”. Simular não movimenta estoque.

VALIDAÇÃO:  
Caminho obrigatório quando flag SIM; fator ≤ 0, unidade vazia, origem=destino, CAIXA gravada como SI, KG→ML sem regra e caminho inexistente são rejeitados. Exclusão de relação necessária bloqueada.

COMPRAS:  
`processarItemCompra` lê relações só com flag SIM. Quantidade de estoque = MUC.

ESTOQUE:  
Registra quantidade convertida por `empresa_id`. Catálogo compartilhado.

COMPATIBILIDADE:  
Produto antigo sem config (`utiliza_conversao = 0`) segue o comportamento MUC-02/legado. Sem migração automática de `fator_conversao`.

TESTES:  
muc-03 29/29 (T01–T25 + Coca/água/laranja + UI). muc-01 13/13; muc-02 25/25; public 20/20; rc1 17/17; rc2 18/18; rc431 29/29; rc842 13/13; 03.01–03.04 e 03.07–03.09 OK; produto-embalagens 14/14; rc43112 9/9; estoque-empresa-schema 8/8.

P0:  
Nenhum.

P1:  
Ficha técnica ainda não exige a nova config (MUC-04). Importação inicial continua com fator próprio.

P2:  
Formação de preço ainda no MotorUM.

NÃO IMPLEMENTADO (escopo):  
Pastel Especial, ficha dinâmica, MIS, Central, Open Finance, iFood, Açaíteria, cubas, PDV Universal.

CONCLUSÃO:  
Cadastro → configurar conversão → simular → comprar → MUC → estoque da empresa. Pronto para avaliar MUC-04 (ficha / consumo).

PRÓXIMA SPRINT:  
MUC-04 — não iniciada automaticamente.
