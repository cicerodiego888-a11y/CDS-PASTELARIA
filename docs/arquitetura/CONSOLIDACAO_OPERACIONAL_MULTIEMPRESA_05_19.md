# Consolidação operacional — multiempresa (05.19)

## Um caminho

```
Configurações Avançadas
  → #btnAbrirGestaoEmpresas
  → loadPage('empresas')
  → cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')
  → ?v=0519 (CDS_ERP_ASSET_VERSION)
  → loadGestaoEmpresasFiscal()
  → #page-content
```

Sem `data-page="empresas"` na sidebar. Sem HTML paralelo de empresas.

## Um módulo / uma versão

Arquivo: `frontend/erp/js/gestao-empresas-fiscal.js`  
Versão de produto: `05.19`  
Cache: só `CDS_ERP_ASSET_VERSION = '0519'` em `app.js`. Fallback do módulo lê a mesma constante.

## Fluxo criar → editar

POST `/api/empresas` → DTO com `id` → `resolverEmpresaId` → `abrirDetalhe`.  
Falha de status fiscal: aviso + TENTAR NOVAMENTE; três áreas permanecem.

## API

Toda chamada do módulo passa por `urlAbsoluta` / `normalizarApiUrl`. Recurso sem prefixo `/api` quando `API_URL` já termina em `/api`.

## PDV Universal

Rota oficial `/pdv-universal/`. 409 `NENHUMA_EMPRESA_DISPONIVEL` → CADASTRAR, não LOGIN.
