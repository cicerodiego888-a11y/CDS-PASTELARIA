# SPRINT 03.06.1 — Contexto fiscal / db por empresa (Central)

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — transporte da conexão SQLite + loader `getFiscalConfig({ empresaId, db })`. Sem schema novo. Sem motor fiscal novo.

CAUSA:  
`obterContextoOperacional` enviava `db: this._db` nulo para `empresasConfiguracaoFiscal`. A conexão SQLite não era transportada. Configuração fiscal por empresa já existia.

FONTE empresaId:  
`listarAlvosSincronizacaoCentral` → `alvo.empresaId` → `_sincronizarEmpresa`

FONTE db:  
Conexão SQLite do ERP (`database.js` / `mercadao.db`). Ordem: `opcoes.db` da iteração → `this._db` → `resolverDb` (repositórios da Central). Fiscal: `empresas_configuracao_fiscal WHERE empresa_id = ?`

EMPRESA A:  
empresaId 1 · CNPJ 38204469000115 · db = conexão `mercadao.db` · config = linha empresa_id=1

EMPRESA B:  
empresaId 2 · CNPJ 38204469000387 · db = a mesma conexão · config = linha empresa_id=2

EMPRESA C:  
empresaId 3 · CNPJ 38204469000204 · db = a mesma conexão · config = linha empresa_id=3

Arquivo corrigido:  
`backend/motores/central-entradas/services/CentralConfiguracaoService.js`  
também: `CentralSincronizacaoService.js`, `CentralSyncExecucaoService.js`, `CentralEntradasOrchestrator.js`

Ponto em que o db era perdido:  
alvo tinha empresaId; o serviço fiscal recebia `null`.

CROSS-COMPANY:  
PASSOU (T05–T08, T16: A→dbA, B→dbB, C→dbC)

FALLBACK:  
NÃO EXISTE

TESTES:  
16/16 (`tests/central-entradas/contexto-fiscal-db-multiempresa-03-06-1.test.js`)

REGRESSÕES:  
Prioridade: 05.54 12/12 · 05.76 18/18 · 03.01 20/20 · 03.02 28/28 · 03.04 35/35.  
Também: 03.03 25/25 · 03.05 16/16 · 05.55 16/16 · 05.56–05.69 (lote Central 05.x desta conversa, OK) · 05.70 12/12 · 05.71 T01–T10 OK · 05.72 10/10 · 05.73 10/10 · 05.74 12/12 · 05.75 12/12.  
Sprint desta entrega: 16/16 `contexto-fiscal-db-multiempresa-03-06-1.test.js`.

RISCOS RESTANTES:  
SEFAZ/certificado em disco por empresa; recarregar o processo Node da Central após o deploy. Ativação MULTIEMPRESA permanece documentada em `AUDITORIA_ATIVACAO_MULTIEMPRESA_CENTRAL_03_06_1.md`.
