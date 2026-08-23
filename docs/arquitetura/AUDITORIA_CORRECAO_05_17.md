# Auditoria e correção — 05.17

## Caminho real — Empresas

| Item | Valor real |
|------|------------|
| Menu | Configurações Avançadas (`data-page="configuracoes-avancadas"`) → botão Empresas → `loadPage('empresas')` |
| JS carregado | `cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')` → `/erp/js/gestao-empresas-fiscal.js?v=` + `CDS_ERP_ASSET_VERSION` (0517) |
| HTML | nenhum arquivo próprio; `#page-content` do `frontend/erp/index.html` |
| GET lista | `/api/empresas` (`app.use('/api/empresas', verificarToken, empresasRoutes)`) |
| GET status | `/api/empresas/configuracao-fiscal/status` |
| GET/PUT fiscal | `/api/empresas/:empresaId/configuracao-fiscal` |
| POST certificado | `/api/fiscal/certificado/upload` (`exigirRecurso('fiscal')`) |

## Caminho real — PDV Universal

| Item | Valor real |
|------|------------|
| Menu | `href="/pdv-universal/"` + `urlPdvUniversalOficial()` |
| HTML | `frontend/pdv-universal/index.html` via `app.get(['/pdv-universal','/pdv-universal/'], verificarToken)` |
| Contexto | `GET /api/pdv-universal/contexto` |

## Problemas e correção

| Problema | Causa | Correção |
|----------|--------|----------|
| `/api/api/...` | `API_URL` já termina em `/api` e o path começava com `/api/` | `recursoSemPrefixoApi` + `urlAbsoluta`; `jsonFetch` sempre normaliza |
| Abas invisíveis | lazy cache do JS antigo; status 404 derrubava a tela | versionamento `cdsErpAsset`; troca de `?v=` recarrega o script; status falho só avisa |
| Edição após criar | envelope do ID não unificado | `resolverEmpresaId` aceita `id`, `empresa_id`, `data.id` |
| 409 como sessão | risco de tratar 409 como login | 409 `NENHUMA_EMPRESA_DISPONIVEL` nunca vira LOGIN |
