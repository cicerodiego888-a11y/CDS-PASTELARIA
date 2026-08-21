# Implementação 03.2 — Contexto empresarial + seletor

**Data:** 2026-08-14 · **Status:** implementada  
**Escopo:** empresas disponíveis, seleção da empresa corrente, `empresaId` na sessão  
**Fora de escopo:** `estoque_empresa`, JWT novo, `usuario_empresa`, permissões por usuário, migração de módulos operacionais, COMPAT

---

## 1. Auditoria de autenticação

O CDS já representa o usuário assim:

| Peça | Papel |
|---|---|
| `verificarToken` | JWT Bearer → `req.user` |
| JWT | `id`, `username`, `role`, `perfil`, `permissoes`, `terminal_id`, `caixa_sessao_id` |
| Frontend | `localStorage.token` + `localStorage.user` |
| `VendaContext.empresa` | campo preparado no body; **não** lido do JWT |

Não havia claim `empresaId` no token. **Não foi criado JWT novo nem `usuario_empresa`.**

Contexto empresarial da sessão:

1. Validação no servidor (`EmpresaService` + `empresaContexto`).
2. Persistência no cliente: `localStorage.cds_empresa_id` e `localStorage.cds_empresa`.
3. Propagação: header `X-Empresa-Id` (jQuery `ajaxSetup` + helper de fetch).
4. `req.empresaId` via middleware opcional `criarMiddlewareContextoEmpresa`.

---

## 2. Empresas disponíveis

`GET /api/empresas/contexto/disponiveis`

Nesta Sprint **não há vínculo usuário → empresa**. A lista é:

> todas as empresas **ativas** do cadastro oficial (03.1).

Autorização individual por usuário fica para a **03.3**.

Inativas **não** entram no seletor.

DTO: `id`, `cnpj`, `razao_social`, `nome_fantasia`.

---

## 3. Seleção

`POST /api/empresas/contexto`  
Body: `{ "empresaId": 1 }`

Valida existência e `ativo = 1`.

| Código | Quando |
|---|---|
| `EMPRESA_ID_OBRIGATORIO` | sem id |
| `EMPRESA_NAO_ENCONTRADA` | id inexistente |
| `EMPRESA_INATIVA` | inativa |

Não cria empresa. Não usa empresa `1`. Não usa `configuracoes.cnpj`.

`GET /api/empresas/contexto` — devolve o contexto da requisição (`X-Empresa-Id` / `req.empresaId`). Sem seleção: `{ empresaId: null, selecionada: false }`.

---

## 4. Onde fica o empresaId

| Camada | Onde |
|---|---|
| Oficial de resolução | `empresaContexto.resolverEmpresaId` / `resolverEmpresaIdDaRequisicao` / `validarEmpresaId` |
| HTTP | header `X-Empresa-Id` → `req.empresaId` |
| Sessão UI | `localStorage.cds_empresa_id` (+ JSON `cds_empresa` para exibição) |
| JWT | **não** (de propósito) |

Troca de empresa: novo `POST /contexto` + overwrite no `localStorage`. Próximas chamadas jQuery já enviam o header novo.

Logout limpa `cds_empresa_id` / `cds_empresa`.

---

## 5. Frontend

Componente mínimo no rodapé da sidebar (ERP e PDV):

- 0 ativas → “Nenhuma empresa ativa disponível.”
- 1 ativa → seleciona automaticamente o **contexto** (não cria empresa padrão)
- N ativas → `<select>` com nome fantasia (ou razão) + CNPJ formatado

Não altera o Design System. Estilo local em `style.css` (select compacto na sidebar).

---

## 6. Módulos ainda não migrados

Compras, vendas, estoque, financeiro, fiscal e motores **não** passaram a exigir `empresaId`. COMPAT das Sprints 02.x permanece. O header pode ser enviado; os módulos ignoram até optarem pelo contexto.

---

## 7. Limitações

- Qualquer usuário autenticado vê **todas** as empresas ativas.
- Sem isolamento de estoque (`produtos` continua único).
- Produto continua GLOBAL.
- Sem `estoque_empresa`.
