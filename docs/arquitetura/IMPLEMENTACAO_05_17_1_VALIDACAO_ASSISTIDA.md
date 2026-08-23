# Sprint 05.17.1 — validação assistida

## Caminho real Empresas

1. Clique **Empresas** em Configurações Avançadas → `loadPage('empresas')` (`cds-centro-configuracoes.js`).
2. `app.js` `case 'empresas'` → `carregarScriptsPaginaErp` → `cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')` → **`/erp/js/gestao-empresas-fiscal.js?v=05171`**.
3. Único arquivo no repositório: `frontend/erp/js/gestao-empresas-fiscal.js`.
4. `loadGestaoEmpresasFiscal()` pinta `#page-content` (`frontend/erp/index.html`).
5. APIs via `normalizarApiUrl`: `/api/empresas`, `/api/empresas/configuracao-fiscal/status`, `/api/empresas/:id/configuracao-fiscal`, `/api/fiscal/certificado/upload`.

Não há segundo HTML de empresas. O shell substitui `#page-content` só em `loadPage` / `pintarShell`.

## PDV Universal

Menu `href="/pdv-universal/"`. Contexto `GET /api/pdv-universal/contexto` com Bearer. 409 não é logout.
