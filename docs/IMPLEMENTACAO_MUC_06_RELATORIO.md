# SPRINT MUC-06

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
Sim — preview HTTP da compra, pré-fill da persistência, UI de compras, `MotorConversaoCalculo` (F/NF recebe qtd MUC). Importação, ficha, consumo, cancelamento, devolução, fiscal, Central, PDV Universal, MIS: não alterados.

PREVIEW:  
`POST /api/compras/simular-conversao-muc` → `simularConversaoCompraPreview` → `obterMuc(db).converterQuantidade`. Exige origem e destino. Sem multiplicador silencioso.

PRE-FILL:  
Rota de compra não pré-preenche quantidade pelo legado. Oficial = `processarItemCompra`.

PERSISTÊNCIA:  
Continua MUC. Preview e persistência comparados no T12.

FRONTEND:  
Cliente envia unidades; exibe `caminhoTexto` do MUC. `motor-quantidade-compra.js` não converte.

LEGADO:  
Custo/F/NF mantidos. `obterQuantidadeConvertida` e `simularConversaoEmbalagem` permanecem fora do preview oficial.

IMPORTAÇÃO:  
NÃO ALTERADA.

TESTES:  
MUC RC1/RC2/contrato/01–04 + MUC-06 + rc431-build: 114/114.  
MUC-06 preview: 14/14. rc43112 9/9. rc43119 14/14. motor-conversao-unidades 15/15.  
03.04–03.08 fail 0. Oráculos de quantidade agora usam `obterMuc().converterQuantidade`.  
Importação: arquivos não alterados. Testes unitários de fator OK; falhas de schema `reservado_fiscal` no banco oficial são pré-existentes.

ARQUIVOS:  
`backend/services/compras/simularConversaoCompraPreview.js` (novo)  
`backend/rotas/compras.js`  
`backend/motores/muc/core/MotorConversaoCalculo.js`  
`frontend/erp/js/compras.js`  
`frontend/erp/js/compra-muc-client.js`  
`frontend/shared/js/motor-quantidade-compra.js`  
`docs/muc/MUC-06-CONSOLIDACAO-COMPRA.md`

CONCLUSÃO:  
Na compra, preview = pré-fill = persistência = MUC. Próximo: MUC-07 (importação inicial).
