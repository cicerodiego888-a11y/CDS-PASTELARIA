# Implementação 03.4 — Contexto empresarial obrigatório

**Data:** 2026-08-15 · **Status:** implementada  
**Escopo:** exigir `empresaId` real nas operações **novas** da Fase Empresas  
**Fora de escopo:** módulos operacionais, estoque, JWT, login, remoção de COMPAT, `estoque_empresa`

---

## 1. Operações escolhidas

Somente APIs criadas na Fase Empresas (03.1–03.3). Nenhum módulo operacional.

| Operação | Obrigatório? | Motivo |
|---|---|---|
| `PUT /api/empresas/:id` (alteração) | **sim** | mutação do cadastro da empresa **selecionada** |
| `GET /api/auth/usuarios/:id/empresas` | **sim** | admin opera dentro de um contexto autorizado |
| `POST /api/auth/usuarios/:id/empresas` | **sim** | só vincula à empresa do contexto |
| `PATCH /api/auth/usuarios/:id/empresas/:empresaId` | **sim** | alvo = contexto |
| `DELETE /api/auth/usuarios/:id/empresas/:empresaId` | **sim** | alvo = contexto |
| `POST /api/empresas` (criar) | não | bootstrap do cadastro (primeira empresa) |
| `GET /api/empresas` e `GET /:id` | não | consulta 03.1; sem UI operacional nova |
| `PATCH .../ativar` e `.../inativar` | não | empresa inativa **não pode** ser contexto; ativar o próprio alvo quebraria a regra |
| `GET /contexto/disponiveis` | não | ocorre **antes** da seleção |
| `POST /contexto` | não | **é** a seleção (`empresaId` no body) |
| `GET /contexto` | não | consulta 03.2 (`selecionada: false` se vazio) |

**Por que estas:** validam o fluxo completo (login → vínculo → seleção → header → `req.empresaId` → operação) sem tocar em compras, vendas, estoque ou motores.

**Por que não ativar/inativar:** o middleware recusa empresa inativa. Ativar exigiria contexto de **outra** empresa e abriria mutação sem vínculo com o alvo. Fica para sprint posterior, se necessário.

---

## 2. Como o empresaId chega

Não há resolver novo. Continua `empresaContexto`:

```
X-Empresa-Id  →  resolverEmpresaIdDaRequisicao
              →  validarEmpresaId (existe + ativa)
              →  exigirEmpresaAutorizada (vínculo)
              →  req.empresaId
              →  operação usa req.empresaId
```

O header **não** autoriza. `localStorage` **não** autoriza.

A operação de alteração **não** usa `:id` solto: depois da validação, `atualizarEmpresa(req.empresaId, ...)`.

Vínculo: `empresaId` do body/params deve ser **igual** a `req.empresaId`. Header A não vincula à empresa B.

---

## 3. Middleware

Reutilizado `criarMiddlewareContextoEmpresa`.

| Modo | Comportamento |
|---|---|
| padrão (03.2/03.3) | sem header → `req.empresaId = null` (COMPAT) |
| `{ obrigatorio: true }` (03.4) | sem header → `EMPRESA_OBRIGATORIA` |

Não foi criado middleware paralelo. `validarEmpresaId` permanece sem vínculo (02.x / porta pública).

---

## 4. Validações e erros

| Código | HTTP | Quando |
|---|---|---|
| `EMPRESA_OBRIGATORIA` | 400 | operação nova sem contexto |
| `EMPRESA_NAO_ENCONTRADA` | 404 | id inexistente |
| `EMPRESA_INATIVA` | 400 | empresa inativa |
| `EMPRESA_NAO_AUTORIZADA` | 403 | sem vínculo, sem usuário, ou alvo ≠ contexto |

Sem empresa `1`, sem CNPJ de `configuracoes`, sem fallback silencioso.

---

## 5. COMPAT mantida

| Fluxo | Regra |
|---|---|
| **Novo** (PUT empresa, admin de vínculo) | exige `empresaId` + vínculo |
| **Legado** (02.x, porta pública, MTS, MUC, Motor Comercial) | `COMPAT_*` / `modoLegadoSemEmpresa` |

O middleware **opcional** continua nas rotas de consulta de contexto. A porta pública **não** recebeu `obrigatorio: true`.

---

## 6. Frontend

Nenhuma tela nova. `core.js` já envia `X-Empresa-Id` após a seleção. Para alterar a empresa B, o usuário troca o seletor para B e só então o `PUT` é aceito.

---

## 7. Limitações

- O CDS **não** ficou inteiro multiempresa obrigatório.
- Primeiro vínculo de um admin ainda depende de um contexto já autorizado (seed / serviço) **ou** de outro admin já vinculado. `POST /empresas` (criar) permanece sem contexto para não bloquear o cadastro inicial.
- `GET /api/empresas` ainda lista o cadastro para usuário autenticado (herança 03.1).
- Sem `ADMIN vê todas`.
- Produto continua GLOBAL. Estoque continua em `produtos`.

---

## 8. Próxima etapa

03.5 — migração dos escritores restantes (NFe revert, consumo de reservas, Repair, CREATE produto, lotes), **antes** de `estoque_empresa`.
