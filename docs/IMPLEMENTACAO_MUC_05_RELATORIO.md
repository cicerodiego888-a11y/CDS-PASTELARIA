# SPRINT MUC-05

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
Não — auditoria e documentação. Nenhuma remoção. Nenhuma migração de fluxo operacional. Contrato MUC RC2.1 intacto. Ficha, consumo, cancelamento, devolução, estoque, venda, fiscal, Central, PDV Universal e MIS não alterados.

MUC:  
Permanece autoridade única de conversão de quantidade nos fluxos oficiais (`obterMuc(db).converterQuantidade` / `processarItemCompra`).

MOTORUM:  
Mantido por função: preço, catálogo UC, XML uCom. `converterQuantidadeEntreUnidades` já delega ao MUC (wrapper D). `FATOR_UNIDADE_BASE` e `listarUnidadesComerciais` candidatos à remoção — não removidos.

LEGADO (`motorConversaoUnidades.js`):  
Mantido para custo, subtotal e rateio F/NF. Não é autoridade de quantidade na persistência da compra.

IMPORTAÇÃO:  
`fator_conversao` próprio permanece (D). Não migrado para não quebrar o fluxo.

TESTES:  
`node --test` MUC: 100/100 (RC1, RC2, contrato público, auditoria-01, MUC-02/03/04, rc431-build).  
03.03 25 OK · 03.04 35 OK · 03.05 16/16 · 03.06–03.08 fail 0 (69 no lote node:test).  
Nenhum teste novo. Nenhum teste alterado para mascarar resultado.

P0:  
Nenhum caminho paralelo capaz de divergir estoque em venda/ficha/cancelamento/devolução.

P1:  
Importação inicial e preview de compra ainda multiplicam fora do MUC.

P2:  
Constantes/API mortas no MotorUM; oráculo 03.05 T09 ainda menciona MotorUM (passa pelo comentário).

ARQUIVOS CRIADOS:  
`docs/muc/MUC-05-AUDITORIA-CAMINHOS-PARALELOS.md`  
`docs/muc/MUC-05-MATRIZ-CONSUMIDORES.md`  
`docs/IMPLEMENTACAO_MUC_05_RELATORIO.md`

CONCLUSÃO:  
Correção arquitetural (mapa + classificação) concluída. Limpeza visual adiada de propósito. Pronto para MUC-06 (preview/pré-fill compra + wrappers de teste) e MUC-07 (importação).
