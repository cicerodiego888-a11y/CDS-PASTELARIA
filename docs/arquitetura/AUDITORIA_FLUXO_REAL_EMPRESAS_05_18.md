# AUDITORIA — CAMINHO REAL EMPRESAS (Sprint 05.18)

Prova no código. Não é hipótese de cache.

## CAMINHO_REAL_EMPRESAS

```
ERP (frontend/erp/index.html)
  → menu Configurações Avançadas
      <a data-page="configuracoes-avancadas">
  → loadPage('configuracoes-avancadas')
      frontend/erp/js/app.js
  → /erp/js/cds-centro-configuracoes.js
  → botão #btnAbrirGestaoEmpresas
      loadPage('empresas')
  → CDS_ERP_PAGE_SCRIPTS.empresas
      cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')
      → /erp/js/gestao-empresas-fiscal.js?v=<CDS_ERP_ASSET_VERSION>
  → case 'empresas': loadGestaoEmpresasFiscal()
  → container #page-content
```

Não existe `data-page="empresas"` na sidebar. Empresas não é item de Administração.

Não existe HTML estático de empresas. A tela é montada em JS.

## Módulo oficial

Arquivo único no ERP:

`frontend/erp/js/gestao-empresas-fiscal.js`

Diagnóstico:

- `window.__CDS_EMPRESAS_MODULE_VERSION` = `05.18`
- log `[CDS EMPRESAS]` com versão, arquivo e origem (`?v=` de `CDS_ERP_ASSET_VERSION`)

Cache busting usa **uma** constante em `app.js` (`CDS_ERP_ASSET_VERSION`, valor atual `05172`). Não há sequência 0515/0516/0517/0518 como correção.

`carregarScriptErpLazy` recarrega o script se o `?v=` mudar; se for o mesmo, reutiliza.

## APIs oficiais (backend/rotas/empresas.js e fiscal.js)

| Ação | Rota |
|---|---|
| Lista | `GET /api/empresas` |
| Criar | `POST /api/empresas` → DTO `EmpresaService` com campo `id` (201) |
| Detalhe | `GET /api/empresas/:id` |
| Dados gerais | `PUT /api/empresas/:id` |
| Status fiscal | `GET /api/empresas/configuracao-fiscal/status` |
| Fiscal GET/PUT | `/api/empresas/:empresaId/configuracao-fiscal` |
| Certificado | `POST /api/fiscal/certificado/upload` + `empresa_id` no FormData |

`resolverEmpresaId` aceita apenas: número, `id`, `empresa_id`, `empresaId`, `data.id`, `data.empresa_id`.

## Plataforma Fiscal (paralela, não substitui Empresas)

`frontend/erp/js/fiscal.js` grava perfil **global** (`GET/PUT /api/fiscal/config`) e upload sem `empresa_id` (arquivo `certificado.pfx`). Ver auditoria global 05.18.

## Central de Entradas

Não alterada. Não há `empresa_id` no motor `central-entradas` nesta auditoria. Fluxo destino→contexto permanece documentado, sem implementação nesta sprint.

## Arquivos que tocam Empresas / fiscal / certificado no frontend

- `frontend/erp/js/gestao-empresas-fiscal.js` — tela oficial
- `frontend/erp/js/app.js` — loadPage + lazy
- `frontend/erp/js/cds-centro-configuracoes.js` — atalho
- `frontend/erp/js/fiscal.js` — plataforma global/legada
- `frontend/erp/index.html` — menu avançadas + `#page-content`
- `frontend/shared/js/core.js` — índice de busca do centro (keywords)

Não há segundo `gestao-empresas-fiscal.js`.
