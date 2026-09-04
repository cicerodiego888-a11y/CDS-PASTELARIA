# SPRINT 05.76

STATUS:  
CONCLUÍDA

TIPO:  
FECHAMENTO FINAL CENTRAL

PRODUÇÃO ALTERADA:  
SIM — `FiscalProvider.ultimaEntradaFiscal(empresaId)` + `collect` passa `context.empresaId`. GET `/saude` já estava isolado (não reaberto).

GET /SAUDE:  
Isolado por `resolverEmpresaParaCentral` + `empresa_id` no HealthRepository; `autoRecuperar: false`; sem SELECT global; confirmado T01–T04/T11/T12/T15

FiscalProvider.ultimaEntradaFiscal:  
Isolado: `WHERE empresa_id = ?` antes de `LIMIT 1`; sem empresa → sem SELECT

LEITORES AUDITADOS:  
8 (saúde HTTP, HealthScheduler, ultimaEntradaFiscal, listarFornecedoresNovos, Indicadores agregados, diagnóstico GET, DistDFe XML, fila 05.74)

LEITORES CORRIGIDOS:  
1 (`ultimaEntradaFiscal`; saúde já A)

SQL GLOBAIS REMOVIDOS:  
1 (`LIMIT 1` global de `central_entradas_documentos` no FiscalProvider)

CHAMADORES ALTERADOS:  
1 (`FiscalProvider.collect`)

TESTES:  
18/18 (`tests/central-entradas/fechamento-final-central-05-76.test.js`)

REGRESSÕES:  
05.76 18/18 · 05.75 saúde 12/12 · 05.75 PDV 12/12 · 05.74 12/12 · 05.73 10/10 · 05.72 10/10 · 05.71 T01–T10 · 05.70 T01–T12 · 05.69 T01–T08 · 05.68–05.56 · 05.55 16/16 · 05.54 12/12

CROSS-COMPANY:  
A/B/C isolados; mesma chave A/B não cruza

NULL:  
fora de saúde e de ultimaEntradaFiscal

FILA:  
05.74 intacta; GET `/saude` não processa; reprocessar diagnóstico com `empresaId` do contexto

RISCOS RESTANTES:  
listarFornecedoresNovos e dashboards internos; GET `/diagnostico` agregados; DistDFe/disco por chave; HealthScheduler global; `ultimaEntradaNaoFiscal` (compras)

BLOQUEIOS:  
nenhum para Bloco 3 no núcleo auditado (saúde + última NF monitoring)

05.73 T02: residual atualizado para `listarFornecedoresNovos` (ultimaEntradaFiscal deixou de ser D).
