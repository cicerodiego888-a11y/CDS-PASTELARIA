# RELATÓRIO — S07-2 Gestão administrativa de unidades de cozinha

**Data:** 2026-11-17  
**Status:** IMPLEMENTADO (banco temporário / sem cadastro no oficial)  
**S07-3:** não iniciado

---

## Objetivo

Cadastro administrativo mínimo de `cozinha_unidades` no ERP, preservando regras S07-2 do KDS.

---

## Rotas novas

| Método | Rota | Função |
|--------|------|--------|
| `GET` | `/api/cozinha/unidades` | Lista unidades da empresa (ativas e inativas) |
| `POST` | `/api/cozinha/unidades` | Cadastra `{ codigo, ativo? }` |
| `PATCH` | `/api/cozinha/unidades/:id` | Altera `{ ativo }` |

**Inalteradas:** `GET /unidades-disponiveis`, `POST /sessao/unidade`, painel KDS e demais rotas S06/S07.

### Regras aplicadas
- `empresa_id` somente do contexto autenticado (`X-Empresa-Id` / middleware).
- `empresa_id` no body é **ignorado** (não autoriza).
- Somente `isAdminOperacional` (role `admin` ou perfil `ADMIN`/`SUPER_ADMIN`).
- Código obrigatório e único por empresa → `409 CODIGO_DUPLICADO`.
- Unidade de outra empresa no PATCH → `403 UNIDADE_EMPRESA_ISOLAMENTO`.
- Sem coluna `nome`.

---

## Frontend

**Menu:** Administração → **Gestão de Cozinhas** → **Unidades**  
(`data-page="cozinha-unidades"`, breadcrumb Configurações › Gestão de Cozinhas › Unidades)

Funcionalidades:
- Listagem (ID, código, empresa, situação)
- Nova Unidade (código + ativo)
- Ativar / Inativar
- Feedback sucesso/erro
- ACL: somente admin operacional

---

## Arquivos

| Arquivo | Papel |
|---------|--------|
| `backend/services/cozinha/CozinhaUnidadeCadastroService.js` | Serviço CRUD mínimo |
| `backend/rotas/cozinha.js` | Rotas GET/POST/PATCH `/unidades` |
| `frontend/erp/js/cozinha-unidades.js` | Tela administrativa |
| `frontend/erp/index.html` | Menu |
| `frontend/erp/js/app.js` | Lazy load + `loadPage` |
| `frontend/shared/js/access-control.js` | ACL página |
| `tests/cozinha/sprint07-s07-2-gestao-unidades-admin.test.js` | Testes |

---

## Testes (isolamento obrigatório)

Flags: `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_TEST_ISOLATION=1`, `CDS_FORCAR_LOCAL=1`

| Suite | Resultado |
|-------|-----------|
| `sprint07-s07-2-gestao-unidades-admin.test.js` | **18/18 PASS** |
| `sprint07-s07-2-sessao-unidade-kds.test.js` | **47/47 PASS** |
| `sprint07-s07-1-painel-kds-ui.test.js` | **10/10 PASS** |

Cobertura da gestão:
- Isolamento entre empresas
- Bloqueio de operador sem autorização
- Código duplicado rejeitado
- PATCH em unidade de outra empresa bloqueado
- Unidade inativa some da seleção KDS
- Admin continua vendo ativas no KDS
- Operador continua limitado a vínculos

**Nenhum cadastro no banco oficial nesta etapa.**

---

## Evidências

- Diff: `Agent/DIFF-GESTAO-UNIDADES-S07-2.patch`
- Log gestão: `Agent/LOG-GESTAO-UNIDADES-S07-2.txt`
- Log regressão S07-2: `Agent/LOG-REGRESSAO-S07-2-APOS-GESTAO.txt`
- Log regressão S07-1: `Agent/LOG-REGRESSAO-S07-1-APOS-GESTAO.txt`
- HTML evidência: `Agent/EVIDENCIA-TELA-COZINHA-UNIDADES.html`
- Screenshot: `Agent/EVIDENCIA-TELA-COZINHA-UNIDADES.png`

---

## Fora de escopo (respeitado)

- PDV Universal / Sprint 06 / operações fiscais  
- Coluna `nome`  
- Vínculos operador↔unidade (UI)  
- Insert no banco oficial  
- S07-3  
