# SPRINT MUC-08

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
Sim — remoção de APIs mortas no MotorUM e import morto em compras.js. Sem mudança funcional de compra, importação, ficha, consumo, cancelamento, devolução, fiscal, Central ou PDV.

FLUXO:  
Auditoria → classificação A/B/C/D → remoção só de C → depreciação de D → testes → RC3.0.

REMOVIDOS:  
`FATOR_UNIDADE_BASE`, `listarUnidadesComerciais`, `converterQuantidadeEntreUnidades`, export de `exigeQuantidadePorEmbalagem`, import não usado de `obterQuantidadeConvertida` em `compras.js`.

MANTIDOS / DEPRECIADOS:  
`obterQuantidadeConvertida`, `simularConversaoEmbalagem`, `fator_conversao`, MotorUM (preço/UC/XML), `motorConversaoUnidades` (custo/F-NF).

TESTES:  
`tests/muc/muc-08-fechamento.test.js`. Oráculos SI/encadeamento usam MUC. Suíte de certificação RC1/RC2/contrato alinhada a VERSAO RC3.0.

RC3.0:  
CONSOLIDADO. Contrato DTO 1.0.0 e 7 métodos públicos preservados.

ARQUIVOS:  
`backend/services/unidades/MotorUnidadesMedida.js`  
`backend/lib/motorConversaoUnidades.js`  
`backend/motores/muc/version.js`  
`backend/rotas/compras.js`  
`docs/muc/MUC-08-LIMPEZA-RESIDUAL.md`  
`docs/muc/MUC-08-MATRIZ-FINAL.md`

CONCLUSÃO:  
MUC é autoridade única de conversão de quantidade. Não abrir nova sprint MUC só para “melhorar”.
