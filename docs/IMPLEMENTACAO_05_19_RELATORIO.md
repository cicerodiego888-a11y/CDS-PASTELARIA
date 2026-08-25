# Relatório — Sprint 05.19

## STATUS DA SPRINT:

**ESTADO B — IMPLEMENTAÇÃO CONSOLIDADA, VALIDAÇÃO REAL PENDENTE**

Não 100% concluída.

--------------------------------

## MÓDULO OFICIAL

Arquivo: `frontend/erp/js/gestao-empresas-fiscal.js`  
Versão: `05.19`  
Loader: `app.js` `CDS_ERP_PAGE_SCRIPTS.empresas` + `cdsErpAsset` (`?v=0519`)

--------------------------------

## FLUXO DE EMPRESA

Criar: POST `/api/empresas`  
ID retornado: `id` (resolver aceita também `empresa_id`, `data.id`)  
Edição automática: `abrirDetalhe(novaId)`

--------------------------------

## ABAS

Dados Gerais: sim  
Configuração Fiscal: sim (URLs homo/prod)  
Certificado Digital: sim (.pfx, senha, upload com `empresa_id`)

--------------------------------

## API

/api/api: **Ausente** (normalização oficial)  
Status Fiscal: GET `/api/empresas/configuracao-fiscal/status`  
Fiscal por empresa: GET/PUT `/api/empresas/:id/configuracao-fiscal`  
Upload certificado: POST `/api/fiscal/certificado/upload`

--------------------------------

## ISOLAMENTO

Empresa A ≠ Empresa B: comprovado em testes de persistência.

--------------------------------

## PDV UNIVERSAL

Rota: `/pdv-universal/`  
Contexto: 409 sem logout  
Regressão: não alterado nesta sprint

--------------------------------

## TESTES

`consolidacao-operacional-multiempresa-05-19` 6/6. Regressão: 05.18 visual, 05.17.1, 05.17.2, 05.11, 04.09, PDV Universal 05.01, VAS — OK.

--------------------------------

## VALIDAÇÃO REAL

HTTP autenticado: não (401 sem credencial do operador)  
UI/Electron: não controlada pelo agente  

--------------------------------

## PENDÊNCIAS REAIS

Percurso visual no Electron já logado e GET/PUT autenticados A/B.
