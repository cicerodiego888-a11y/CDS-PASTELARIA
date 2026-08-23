# Relatório — Sprint 05.18

Gestão de empresas e configuração fiscal multiempresa no caminho real do ERP.

## ESTADO

**ESTADO B — IMPLEMENTAÇÃO TÉCNICA CONCLUÍDA — VALIDAÇÃO MANUAL BLOQUEADA POR AUSÊNCIA DE AMBIENTE**

Não declarar Sprint 100% concluída. Checklist visual permanece PENDENTE.

## 1. IMPLEMENTAÇÃO TÉCNICA

- Um módulo: `frontend/erp/js/gestao-empresas-fiscal.js` (`__CDS_EMPRESAS_MODULE_VERSION = 05.18`).
- Nova empresa: só dados gerais até existir `empresa_id`.
- `POST /api/empresas` → `resolverEmpresaId` → `abrirDetalhe`.
- Edição sempre com três abas no HTML: Dados Gerais, Configuração Fiscal, Certificado Digital.
- Fiscal: GET/PUT `/api/empresas/:id/configuracao-fiscal`. Campos visíveis: ambiente, UF, série, numeração, ID CSC, CSC/TOKEN CSC, `ws_autorizacao`.
- Segredos não vêm no GET; campo vazio não entra no PUT parcial.
- Certificado: `POST /api/fiscal/certificado/upload` com `empresa_id` da tela (`empresaIdDaEdicao`).
- Falha de status fiscal: aviso + TENTAR NOVAMENTE; abas permanecem.
- Sem novo motor fiscal, sem tabela nova, sem endpoints alternativos.
- MUV, PDV Universal, VendaApplication e `/api/vendas` não alterados nesta sprint.
- Central de Entradas / MIIP / SEFAZ não alterados.

## 2. TESTES AUTOMATIZADOS

Criados:

- `tests/empresas/gestao-empresas-fluxo-visual-05-18.test.js`
- `tests/empresas/isolamento-fiscal-multiempresa-05-18.test.js`

Regressão desta sessão (OK): 05.18 visual 12/12, isolamento A/B 3/3, 05.11 23/23, 05.15 18/18, 04.09 26/26, 05.16, 05.17, 05.17.2, PDV Universal 05.01–05.10, MUV 04.03, `venda-application-service`. MUV/VAS/`/api/vendas` sem alteração de código.

## 3. VALIDAÇÃO EM EXECUÇÃO REAL

Não executada no browser autenticado (ERP aberto, clique no menu, CNPJ salvo, upload PFX).

## 4. ITENS PENDENTES

- Checklist visual (todos PENDENTES).
- Callers de `getFiscalConfig()` sem `empresaId` (NF-e devolução, DFe, cancelamento) — documentados, fora do escopo de código desta sprint.
- Upload global da Plataforma Fiscal permanece por compatibilidade EMPRESA_UNICA.

## Documentos

- `docs/arquitetura/AUDITORIA_FLUXO_REAL_EMPRESAS_05_18.md`
- `docs/arquitetura/AUDITORIA_CONFIGURACAO_FISCAL_GLOBAL_05_18.md`
- `docs/CHECKLIST_VALIDACAO_VISUAL_05_18.md`
