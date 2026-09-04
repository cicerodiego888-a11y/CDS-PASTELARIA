# SPRINT 05.77

STATUS:  
CONCLUÍDA (com bloqueio de consolidação documental “todas as empresas” — ver abaixo)

PRODUÇÃO ALTERADA:  
SIM — somente frontend (JS/CSS/HTML da Central + docs/testes)

FOCO:  
NOVA UI DA CENTRAL

BACKEND:  
NÃO ALTERADO

ENDPOINTS:  
PRESERVADOS (nenhum endpoint novo)

MULTIEMPRESA:  
Seletor + chips a partir de `listarDisponiveis()` (1 lista). Empresa específica → `CdsEmpresaContexto.selecionar` + reload. Sem HTTP por empresa para KPIs. Sem empresa fixa (1 / primeira / última) como ownership. Compacto a partir de 6 empresas.

PRÉ-VISUALIZAÇÃO NF-E:  
Preservada em `renderPainelLateralCentral` (`#centralEntradasPainelLateral`)

PAINEL DE DETALHES:  
Mesmo painel; título DETALHE DA NF-E; fechar local; largura ~380px desktop; empilha &lt;1200px

ABAS:  
Resumo, Produtos, Timeline, XML, Histórico (e mapeamentos já existentes miip/itens/compra)

AÇÕES:  
IDs e regras existentes (Sincronizar, Solicitar XML, Revisar MIIP, Importar compra, paginação)

TESTES:  
26/26 (`tests/central-entradas/nova-central-ui-05-77.test.js` — T01–T25 + anti-açaí)

REGRESSÕES:  
05.76–05.54 e 03.01–03.05: passaram (`node --test` exit 0).  
RC4.0.0 (`rc40-ux-workflow-first.test.js`): 4 falhas pré-existentes (rótulos Importada vs Importado; strings Prontos para Importar / Aguardando XML no JS da página). Não foram alterados para passar; 05.77 não mudou `central-entradas-ux.js` nem os títulos dos KPIs de fila.

RISCOS:  
- “Todas as empresas” **não** consolida a inbox (backend não expõe esse contrato na rota GET `/`). UI documenta o fato; não há merge no cliente.  
- Contagens nos chips de empresas que **não** estão no `X-Empresa-Id` não são buscadas (evita N consultas).  
- `garantirEmpresaAtivaParaCentral` ainda usa a primeira **permitida** se o contexto da sessão for inválido (já existia; não é dono do documento).

BLOQUEIO:  
Consolidação real de documentos com “Todas as empresas” exigiria contrato HTTP (ex. `empresaId=todas` na rota da Central, com autorização). **Não implementado** nesta sprint.

ALTERADO:

- `frontend/css/central-entradas-05-77.css` (novo)
- `frontend/erp/index.html` (link CSS)
- `frontend/erp/js/central-entradas.js` (layout, empresas, tabela, handlers; mesmos fetches)
- `tests/central-entradas/nova-central-ui-05-77.test.js` (novo)
- `docs/arquitetura/NOVA_CENTRAL_ENTRADAS_UI_05_77.md` (novo)
- este relatório

NÃO ALTERADO:

- DistDFe, MIIP, Compras, Estoque, Financeiro, Fiscal, MonitoringEngine, Health, PDV Universal, Açaíteria
- `empresa_id` / `X-Empresa-Id` / `resolverEmpresaParaCentral` / `buscarPorChave`
