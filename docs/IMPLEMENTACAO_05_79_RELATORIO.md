# SPRINT 05.79

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — Central de Entradas (lista “todas as empresas” + layout da tabela). Sem DistDFe, fila, PDV, ficha.

PROBLEMA:  
“Todas as empresas” mostrava só a empresa do contexto. A lista de documentos estava ilegível (status, olho e valor sobrepostos).

CAUSA:  
Rota GET sempre forçava `filtros.empresaId = ctx.empresaId`. Linhas da tabela usavam CSS de card/grid (`central-rc40-doc-row`).

CONTRATO “TODAS”:  
`escopo=todas` → `empresa_id IN` das empresas do `usuario_empresas` (ativas). Sem SELECT global, sem N GETs, sem NULL, sem empresa 1.

LAYOUT:  
Tabela com colunas alinhadas; linha `central-0577-doc-row`; CSS força `table-row` / `table-cell`.

EMPRESA A / B:  
Vista única continua isolada. Vista todas (autorizadas A+B): A e B; não C; não NULL.

TROCA DE CONTEXTO AO ABRIR:  
Na vista todas, o detalhe alinha o header à empresa do documento.

TESTES:  
`tests/central-entradas/todas-empresas-inbox-05-79.test.js`

PDV UNIVERSAL:  
Não alterado.
