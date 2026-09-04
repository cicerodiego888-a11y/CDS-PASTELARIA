# SPRINT 05.75 — Isolamento PDV Universal

Nota de numeração: o isolamento GET `/saude` da Central (mesmo número 05.75) permanece em `docs/IMPLEMENTACAO_05_75_SAUDE_CENTRAL_RELATORIO.md` e `docs/arquitetura/ISOLAMENTO_SAUDE_CENTRAL_EMPRESA_05_75.md`.

STATUS:  
CONCLUÍDA

PRODUÇÃO ALTERADA:  
SIM — apenas comentários `STATUS: CONGELADO` em `rotas/pdv-universal.js`, `PDVUniversalApplicationService.js`, `pdv-universal.js` e `pdv-acesso-oficial.js`. Nenhuma rota, tabela, venda, pagamento ou navegação alterada.

PDV UNIVERSAL:  
CONGELADO

PDV OFICIAL:  
PDV NORMAL (`/pdv`, `frontend/pdv`)

CHAMADORES ENCONTRADOS:  
6 produção (`server.js`, `erp/index.html`, `pdv/index.html`, `dashboard-command.js`, `pdv-acesso-oficial.js`, `core.js`) + 33 testes em `tests/pdv-universal/` + 6 testes externos que `require` o módulo

DEPENDÊNCIAS:  
26 arquivos exclusivos (A) + núcleo compartilhado (VAS, reservas, MUV, caixa, TEF shared, atacado, comprovante)

ROTAS:  
11 (GET HTML `/pdv-universal` + 10 endpoints `/api/pdv-universal/*`)

SERVICES:  
5 exclusivos (`ApplicationService`, Context, Disponibilidade, VendaAdapter, AtendimentoAdapter) + 2 adaptadores de modo

DEPENDÊNCIAS COMPARTILHADAS:  
VAS/`POST /api/vendas`, `reservasPublico`, MUV, `/api/caixa`, `tefFluxoPagamento.js`, `motor-preco-atacado.js`, `muv-comprovante-client.js`, contrato/`X-Empresa-Id`

DEPENDÊNCIAS NORMAL → UNIVERSAL:  
1 navegação HTML (`frontend/pdv/index.html` → `/pdv-universal/`). Zero `require`/`import` em `frontend/pdv/js`. ERP dashboard também abre Universal (não é o JS do Normal).

ROTAS REMOVIDAS:  
0

TABELAS REMOVIDAS:  
0

FUNCIONALIDADES REMOVIDAS:  
0

TESTES:  
12/12 (`tests/auditoria/isolamento-pdv-universal-05-75.test.js`)

REGRESSÕES:  
isolamento-pdv-universal-05-75 12/12  
fundacao-pdv-universal-05-01 15/15  
contexto-operacional-05-02 25/25  
tela-principal-05-03 15/15  
ativacao-visual-acesso-05-12 19/19  
validacao-acesso-real-05-17-1 8/8  
checkout-empresa-unica-05-05 18/18  
checkout-multiempresa-05-06 25/25  
pdv-processando-timeout-venda 6/6  
pdv-foto-produto-miniatura OK  
rc141515-busca-plu-exata-v1 17/17  
modo-operacional-global-05-38-b 17/17  

Não executada a suíte completa de 33 arquivos `tests/pdv-universal/` nesta passada (amostra de fundação, contexto, tela, acesso, checkout EU/ME). TEF/caixa/estoque/fiscal específicos do Universal não reexecutados além do núcleo acima; código TEF/caixa não foi alterado.

RISCOS:  
- Dashboard ERP (`abrirModuloDashboard('pdv')`) ainda navega para Universal  
- Menu do PDV Normal ainda tem atalho Universal  
- Testes 05.12/05.17 fixam `/pdv-universal/` como destino “oficial” de abertura  
- Nomenclatura antiga “PDV legado” = PDV Normal atual  
- `smart-dashboard` / monitoring usam `/pdv` (inconsistente com dashboard-command)

BLOQUEIOS PARA REMOÇÃO FUTURA:  
chamadores HTTP e menus ainda ativos; testes de navegação; checkout Universal ainda é caminho de produção; dependência VAS/MUV; nova auditoria obrigatória antes da sprint de remoção definitiva
