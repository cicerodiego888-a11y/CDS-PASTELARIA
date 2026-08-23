# Auditoria de execução real — 05.17.2

## Empresas

| AÇÃO | ARQUIVO | FUNÇÃO | URL REAL | RESULTADO |
|------|---------|--------|----------|-----------|
| Clique Empresas | cds-centro-configuracoes.js | `loadPage('empresas')` | — | troca de página |
| Roteamento | app.js | `case 'empresas'` | `/erp/js/gestao-empresas-fiscal.js?v=05172` | lazy load único |
| Render | gestao-empresas-fiscal.js | `loadGestaoEmpresasFiscal` | `#page-content` | lista + detalhe |
| Lista | rotas/empresas.js | GET | `/api/empresas` | JSON array `{id,...}` |
| Status | rotas/empresas.js | GET | `/api/empresas/configuracao-fiscal/status` | falha não apaga edição |
| Fiscal | rotas/empresas.js | GET/PUT | `/api/empresas/:id/configuracao-fiscal` | DTO 04.09 |
| Certificado | rotas/fiscal.js | POST | `/api/fiscal/certificado/upload` | `empresa_id` obrigatório |

HTML próprio: **não existe**. Inserção em `frontend/erp/index.html` `#page-content`.

JS concorrente: **um arquivo** `frontend/erp/js/gestao-empresas-fiscal.js`.

Versão: `CDS_ERP_ASSET_VERSION` = `05172`. Identificador `window.__CDS_EMPRESAS_MODULE_VERSION` = `05.17.2`.

## PDV Universal

| AÇÃO | ARQUIVO | FUNÇÃO | URL REAL |
|------|---------|--------|----------|
| Menu | erp/index.html | href | `/pdv-universal/` |
| Página | server.js | sendFile | `frontend/pdv-universal/index.html` |
| Contexto | pdv-universal.js | GET | `/api/pdv-universal/contexto` + Bearer |

## HTTP

Não executado com token nesta sessão (servidor/login não disponíveis ao agente). URLs normalizadas em teste Node.

## Visual

**VALIDAÇÃO VISUAL NÃO EXECUTADA — PENDENTE.**
