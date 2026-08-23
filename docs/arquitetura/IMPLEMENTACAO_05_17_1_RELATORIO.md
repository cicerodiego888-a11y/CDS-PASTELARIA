# Relatório — Sprint 05.17.1

## IMPLEMENTAÇÃO TÉCNICA CONCLUÍDA — VALIDAÇÃO VISUAL MANUAL PENDENTE

Não afirmar 100% concluída.

### 1. Causa real

JS antigo no lazy-load do ERP + `API_URL` + `/api` duplicado + tela de nova empresa sem abrir edição quando o detalhe era destruído.

### 2. Arquivo real

`/erp/js/gestao-empresas-fiscal.js?v=05171` (`CDS_ERP_ASSET_VERSION`). Um único JS no repo.

### 3. Rotas reais

`GET/POST /api/empresas`, `GET /api/empresas/configuracao-fiscal/status`, `GET/PUT /api/empresas/:empresaId/configuracao-fiscal`, `POST /api/fiscal/certificado/upload`, `GET /pdv-universal/`.

### 4. URLs

Antes: `http://localhost:3001/api` + `/api/empresas/...` → `/api/api/...`  
Depois: `normalizarApiUrl` → `/api/empresas/...` uma vez.

### 5–8. Fluxos

Criar → `resolverEmpresaId` → edição com 3 abas independentes do status. Upload com `empresa_id` da sessão. PDV: `/pdv-universal/`, 409 tratado.

### 9. Testes

`tests/erp/validacao-assistida-empresas-05-17-1.test.js`  
`tests/pdv-universal/validacao-acesso-real-05-17-1.test.js`

### 10. Validação manual

**Pendente.** Sem browser autenticado nesta sessão.

### 11. Pendências

Clicar no ERP recarregado: criar CNPJ válido, 3 abas, CSC, PFX; PDV Universal pelo menu.
