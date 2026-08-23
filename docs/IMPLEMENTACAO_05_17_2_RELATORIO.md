# Relatório — Sprint 05.17.2

## ESTADO B

**IMPLEMENTAÇÃO TÉCNICA CONCLUÍDA**  
**VALIDAÇÃO VISUAL PENDENTE**

Não é “SPRINT 100% CONCLUÍDA”.

### 1–5. Caminhos e assets

Empresas: `loadPage('empresas')` → `gestao-empresas-fiscal.js?v=05172` → `#page-content`.  
PDV: `/pdv-universal/`.  
Endpoints: `/api/empresas`, status, config fiscal, upload certificado, contexto Universal.

### 6–8. Problemas / causa / correção

| Problema | Causa | Correção |
|----------|--------|----------|
| Código ≠ tela | lazy cache JS antigo | `CDS_ERP_ASSET_VERSION` 05172 + troca de script |
| /api/api | API_URL + /api | `normalizarApiUrl` |
| Sem abas após criar | detalhe destruído / id | `resolverEmpresaId` + abrir edição |
| Status derruba tela | catch global | aviso, abas ficam |
| Upload sem id | sessão vazia | bloqueio explícito |

### 9. Testes automatizados

`tests/erp/auditoria-execucao-real-05-17-2.test.js` + regressão 05.11–05.17.1 e núcleos Universal/04.09 (ver execução da sessão).

### 10. Validação HTTP

Não executada com sessão real.

### 11. Validação visual

**VALIDAÇÃO VISUAL NÃO EXECUTADA — PENDENTE.**

### 12. Pendências

Reabrir o ERP e percorrer o checklist da seção 19 da sprint (CNPJ válido, 3 abas, CSC, PFX, PDV Universal).
