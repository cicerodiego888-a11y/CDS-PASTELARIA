# SPRINT MUC-04

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
Sim — consumo da ficha e validação de unidade no cadastro da ficha. Snapshot, cancelamento, devolução, Central, MIS, PDV Universal, fiscal: não reconstruídos.

MUC:  
Única autoridade de conversão da ficha/consumo via `obterMuc(db).converterQuantidade`. Encadeamento MUC-03 (ex. UN→G→KG). SI (ML→L, G→KG) sem MotorUM.

FICHA:  
Estrutura 03.03 preservada. Unidade do item obrigatória (sem fallback para unidade do comercial). INSUMO continua o único componente.

CONSUMO:  
`FichaTecnicaConsumoService` carrega config MUC-03 (cache por insumo na venda). Destino = `unidade_estoque` se flag SIM. Porta `debitarEstoqueItemVenda` + `exigirEmpresa: true`. Transação da venda inalterada.

MOTORUM:  
Não é mais autoridade da ficha/consumo. Permanece: formação de preço, catálogo UC, `converterQuantidadeEntreUnidades` (wrapper MUC) para outros testes/consumidores. Cadastro da ficha ainda referencia o módulo como catálogo (03.03 T13).

LEGADO:  
`motorConversaoUnidades.js` DEPRECADO; custo/F-NF na compra. Sem novo consumidor nesta sprint.

SNAPSHOT:  
`quantidade` + unidade de estoque e `quantidade_ficha` + `unidade_ficha`. Estorno 03.07/03.08 usa snapshot.

MULTIEMPRESA:  
Ficha e regra compartilhadas; débito por `venda.empresa_id`.

TESTES:  
`tests/muc/muc-04-ficha-consumo.test.js` 29/29 (T01–T30, T15+T28 juntos). Laranja 20 UN → 3 KG; queijo 80 G → 0,08 KG.

REGRESSÕES:  
muc-01 13/13; muc-02 25/25; muc-03 29/29; 03.01 20/20; 03.02 OK; 03.03 25/25; 03.04 35/35; 03.05 16/16; 03.07–03.08 fail 0; 03.09 14/14; rc43112 9/9. Testes de 03.xx não foram alterados para mascarar regressão.

P0:  
Nenhum.

P1:  
MotorUM ainda no cadastro da ficha como catálogo de códigos (não converte quantidade).

P2:  
Unificar `round3` da ficha com o contrato 1e9 do MUC; MUC-05 limpeza dos wrappers restantes.

RISCOS:  
Produto com flag SIM sem unidade de estoque bloqueia consumo (`PRODUTO_SEM_UNIDADE_ESTOQUE`). Dual-write de estoque (03.09).

ARQUIVOS ALTERADOS:  
`backend/services/produtos/FichaTecnicaConsumoService.js`  
`backend/services/produtos/FichaTecnicaService.js`  
`backend/services/unidades/MotorUnidadesMedida.js`

ARQUIVOS CRIADOS:  
`tests/muc/muc-04-ficha-consumo.test.js`  
`docs/arquitetura/MUC_04_FICHA_CONSUMO.md`  
`docs/IMPLEMENTACAO_MUC_04_RELATORIO.md`

CONCLUSÃO:  
Cadastro → MUC-03 → ficha (quantidade+unidade) → MUC → estoque da empresa. Pronto para avaliar MUC-05 (limpeza). Pastel Especial / 42 ingredientes fora de escopo.

PRÓXIMA SPRINT:  
MUC-05 — não iniciada automaticamente.
