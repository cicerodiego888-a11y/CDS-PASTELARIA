# SPRINT 05.80

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — somente UI do Centro de Configurações (e aviso na tela NFC-e). Sem schema, DistDFe, Central, PDV ou motor fiscal.

INTERFACE APOSENTADA:  
Plataforma Fiscal

INTERFACE OFICIAL:  
Empresas → Configuração Fiscal → Certificado Digital

MENU:  
Categoria `plataformaFiscal` removida de `CATEGORIAS` em `cds-centro-configuracoes.js`. Demais categorias preservadas.

REDIRECIONAMENTOS:  
Aba morta / `plataforma` → Empresa. Deep-link `fiscal` + âncora Manifestação → Diagnóstico. Botão Diagnóstico e aviso NFC-e → `loadPage('empresas')`. Sem redirecionar para configuração global.

FISCAL.JS:  
Preservado. `carregarFiscalConfig` permanece (sem container na UI). NFC-e operacional intacta. Banner aponta para Empresas.

API /api/fiscal/config:  
PRESERVADA

CONFIGURAÇÃO GLOBAL:  
PRESERVADA POR COMPATIBILIDADE

CONFIGURAÇÃO EMPRESARIAL:  
PRESERVADA

NFC-e:  
PRESERVADA

CENTRAL:  
NÃO ALTERADA

PDV:  
NÃO ALTERADO

TESTES:  
12/12 (`tests/fiscal/aposentadoria-plataforma-fiscal-05-80.test.js`)

REGRESSÕES:  
05.76, 05.77, 05.78, 03.01–03.05, sprint 3.9 Centro, RC4.3 Manifestação.

REFERÊNCIAS LEGÍTIMAS RESTANTES:  
Ver `docs/arquitetura/APOSENTADORIA_PLATAFORMA_FISCAL_05_80.md` §13.

RISCOS:  
Painel executivo ainda lê `GET /api/fiscal/config` (legado interno). Consumidores globais de `getFiscalConfig()` não foram migrados (proibido nesta sprint).

PRÓXIMO PASSO:  
Auditoria futura dos consumidores internos de `getFiscalConfig()` sem `empresaId`, se ainda existirem após esta aposentadoria visual.
