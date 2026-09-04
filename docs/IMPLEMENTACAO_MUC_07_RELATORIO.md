# SPRINT MUC-07

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
Sim — resolução de estoque inicial da importação. Compra, preview MUC-06, ficha, consumo, cancelamento, devolução, fiscal, Central, PDV, schema fiscal: não alterados.

FLUXO:  
`calcularEstoqueInicial` orquestra `resolverEstoqueInicialImportacao`. MUC se origem+destino existirem. Fator só como compatibilidade, nunca após o MUC.

IMPORTAÇÃO:  
`fator_conversao` mantido. Arquivos só com quantidade×fator inalterados.

MULTIEMPRESA:  
`empresaId` do contexto preservado.

TESTES:  
MUC RC1/RC2/contrato/01–04/06/07: 125/125. MUC-07: 12/12.  
Importação V1.0.3 (calcularEstoqueInicial / TINTA / ADAPT): OK.  
Integração no banco oficial: falha pré-existente `reservado_fiscal` (fora de escopo).

ARQUIVOS:  
`backend/services/importacao-inicial-produtos/resolverEstoqueInicialImportacao.js` (novo)  
`backend/services/importacao-inicial-produtos/helpers.js`  
`backend/services/importacao-inicial-produtos/validator.js`  
`backend/services/importacao-inicial-produtos/quantidadeUpdater.js`  
`backend/services/importacao-inicial-produtos/index.js`  
`docs/muc/MUC-07-IMPORTACAO-INICIAL.md`

CONCLUSÃO:  
Importação nova com unidades → MUC. Legado sem unidades → fator. Sem dupla conversão. Pronto para limpeza residual se necessário.
