# SPRINT 05.78

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — Central de Entradas (indicadores + rotas + troca de contexto na UI). Sem DistDFe, fila 05.74, persistência, PDV, ficha.

PROBLEMA:  
Empresa selecionada na Nova Central mudava pendentes, mas valor/NF-e do mês e do ano (e a inteligência operacional) somavam todas as empresas.

CAUSA:  
`GET /indicadores-fiscais` e `GET /inteligencia` sem `resolverEmpresaParaCentral`. `obterAgregadoEntradasPorEmissao` e trechos de `obterMetricasOperacionais` sem `WHERE empresa_id = ?`. Frontend não invalidava estado nem descartava resposta atrasada.

INDICADORES CORRIGIDOS:  
Valor do mês, valor do ano, NF-e do mês, NF-e do ano; métricas de tempo médio / MIIP / compras do dia quando `empresaId` é passado; filas de `/operacional` e `/inteligencia`.

ENDPOINTS:  
`GET /indicadores-fiscais`, `GET /inteligencia`, `GET /operacional` — passam a exigir contexto como o dashboard.

SERVICES:  
`IndicadoresFiscaisService`, `CentralOperacionalDashboardService`, `CentralEntradasOrchestrator.obterInteligenciaOperacional`.

QUERIES:  
`central_entradas_documentos` com `AND empresa_id = ?` (sem COALESCE de ownership).

EMPRESA A:  
Somente documentos/indicadores A.

EMPRESA B:  
Somente B.

NULL:  
Não atribuído à empresa selecionada.

TODAS AS EMPRESAS:  
Contrato 05.77 preservado (sem consolidação nova).

TROCA DE CONTEXTO:  
`selecionar` + invalidar + recarregar dashboard e lista.

CONCORRÊNCIA:  
`contextoSeq` descarta resposta da empresa anterior.

TESTES:  
11/11 (`tests/central-entradas/correcao-contexto-multiempresa-05-78.test.js`) cobrindo T01–T25 agrupados.

REGRESSÕES:  
executar 05.78, 05.77, 05.76–05.54, 03.01–03.05.

ARQUIVOS ALTERADOS:  
- `backend/services/IndicadoresFiscaisService.js`  
- `backend/motores/central-entradas/repositories/CentralDocumentosRepository.js`  
- `backend/motores/central-entradas/services/CentralOperacionalDashboardService.js`  
- `backend/motores/central-entradas/CentralEntradasOrchestrator.js`  
- `backend/rotas/central-entradas.js`  
- `frontend/erp/js/central-entradas.js`  
- testes e docs 05.78

RISCOS RESTANTES:  
Alertas/atenção ainda usam leitores globais (05.73). Telemetria SEFAZ/NSU não é documental. `obterResumo` do monitoring sem empresa continua agregado (fora da UI da Central).
