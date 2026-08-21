# Implementação 03.3 — Vínculo usuário ↔ empresa + contexto

**Data:** 2026-08-14 · **Status:** implementada  
**Escopo:** autorização explícita usuário → empresa sobre o contexto da 03.2  
**Fora de escopo:** `estoque_empresa`, `produto_empresa`, JWT novo, login, motores, migração operacional, COMPAT

---

## 1. Auditoria prévia

Pesquisado: `usuarios`, `usuario_id`, `usuarioId`, `user_id`, `permissoes`, `perfil`, `role`, relações usuário/empresa/CNPJ.

| Achado | Conclusão |
|---|---|
| Tabela `usuarios` | existe; login/JWT inalterados |
| `role` / `perfil` / `permissoes` | administração de usuários (`exigirAdmin`) |
| Tabela `usuario_empresas` | **não existia** |
| `produto_empresa` / `estoque_empresa` | **não existem** (e não foram criadas) |

Não havia estrutura equivalente. A tabela `usuario_empresas` foi criada **uma vez**.

### Regra de administrador

`exigirAdmin` (já existente) trata `role === 'admin'` **ou** `perfil` `ADMIN` / `SUPER_ADMIN` para **gestão de usuários**.

Essa regra **não** significa “ADMIN vê todas as empresas”.

**Não foi inventada exceção global `ADMIN vê todas`.** Administrador gerencia vínculos; o seletor continua exigindo vínculo ativo + empresa ativa. Se o admin não tiver vínculo, o seletor fica vazio.

---

## 2. Tabela de vínculo

`usuario_empresas`

| Campo | Regra |
|---|---|
| `id` | PK |
| `usuario_id` | obrigatório, FK `usuarios(id)` |
| `empresa_id` | obrigatório, FK `empresas(id)` |
| `ativo` | 1 = vigente; 0 = revogado (histórico preservado) |
| `created_at` / `updated_at` | auditoria |

Único por (`usuario_id`, `empresa_id`). Reativar vínculo inativo não duplica linha.

Schema: `backend/services/empresas/usuarioEmpresasSchema.js`  
Bootstrap: `database.js` após `empresas`.

Não há `produto_empresa`. Não há `estoque_empresa`.

---

## 3. Regras de autorização

O usuário só pode selecionar empresa que:

1. tenha vínculo ativo em `usuario_empresas`;
2. exista na tabela `empresas`;
3. esteja `ativo = 1`.

| Situação | Resultado |
|---|---|
| usuário sem vínculo | não seleciona; lista vazia |
| vínculo + empresa inativa | não aparece / `EMPRESA_INATIVA` |
| vínculo inativo + empresa ativa | `EMPRESA_NAO_AUTORIZADA` |
| vínculo ativo + empresa ativa | pode selecionar |

Serviço: `UsuarioEmpresaService` (`exigirEmpresaAutorizada`, `listarEmpresasPermitidas`).

O contexto oficial continua `empresaContexto` (`resolverEmpresaIdDaRequisicao`, `req.empresaId`). O vínculo é **camada de autorização**, não um segundo contexto.

---

## 4. Empresas disponíveis

`GET /api/empresas/contexto/disponiveis`

Retorna somente empresas **ativas e vinculadas** ao `req.user` autenticado.

Não retorna o cadastro completo. `empresaId` enviado pelo frontend **não** prova autorização.

---

## 5. Seleção e troca

`POST /api/empresas/contexto` — body `{ empresaId }`

Fluxo: usuário autenticado → vínculo → empresa existe → empresa ativa → `empresaId` autorizado.

| Código | HTTP | Quando |
|---|---|---|
| `EMPRESA_NAO_AUTORIZADA` | 403 | sem vínculo ativo (inclui header sem usuário) |
| `EMPRESA_NAO_ENCONTRADA` | 404 | id inexistente |
| `EMPRESA_INATIVA` | 400 | empresa inativa |
| `EMPRESA_ID_OBRIGATORIO` | 400 | sem id |
| `USUARIO_OBRIGATORIO` | 400 | lista/seleção sem usuário |

Troca: novo `POST` validado. Só após resposta positiva o frontend grava `localStorage`. Rejeição **não** altera o contexto local.

---

## 6. Segurança

`X-Empresa-Id` é **solicitação de contexto**, não autorização.

O backend valida sempre:

```
req.user.id + empresaId → usuario_empresas (ativo) → empresas (ativa)
```

Não confiar em `localStorage.cds_empresa_id` nem somente no header.

O middleware `criarMiddlewareContextoEmpresa` (rotas de contexto) aplica a mesma regra quando o header está presente. `validarEmpresaId` **não** consulta vínculo — permanece compatível com testes 02.x / porta pública.

---

## 7. Administração do vínculo

Padrão já existente: `exigirAdmin` em `/api/auth/usuarios`.

| Método | Rota | Efeito |
|---|---|---|
| GET | `/api/auth/usuarios/:id/empresas` | lista vínculos (inclui inativos) |
| POST | `/api/auth/usuarios/:id/empresas` | cria ou reativa |
| PATCH | `/api/auth/usuarios/:id/empresas/:empresaId` | `ativo=1` reativa; senão inativa |
| DELETE | `/api/auth/usuarios/:id/empresas/:empresaId` | inativa (não apaga) |

Duplicado ativo: `VINCULO_EMPRESA_DUPLICADO` (409).

Não foi criada estrutura nova de permissões.

---

## 8. Frontend

`cds-empresa-contexto.js` consome **empresas permitidas**.

| Quantidade permitida | UI |
|---|---|
| 0 | “Você não possui empresa disponível.” + limpa storage |
| 1 | seleciona automaticamente via `POST /contexto` |
| N | `<select>` |

Empresa inativa nunca entra na lista. Troca só persiste após 200. Falha reverte o select e notifica.

Logout continua limpando `cds_empresa_id` / `cds_empresa`.

---

## 9. JWT

**Não alterado.** Token continua identificando o usuário. `empresaId` **não** entra no JWT nesta Sprint.

Contexto: `X-Empresa-Id` → `req.empresaId`, com autorização no vínculo.

---

## 10. Compatibilidade

`COMPAT_*` das Sprints 02.x permanece. Módulos operacionais ainda podem funcionar sem `empresaId`. A 03.3 só autoriza o contexto empresarial da sessão.

Produto continua GLOBAL. Estoque continua em `produtos`.

---

## 11. Limitações

- Sem `ADMIN vê todas` no seletor (documentado de propósito).
- Cadastro `GET /api/empresas` (03.1) ainda lista empresas do cadastro para usuário autenticado; o **seletor** é que ficou autorizado.
- Módulos operacionais ainda não exigem `empresaId`.
- Sem isolamento de estoque.

---

## 12. Próxima etapa

03.4 — contexto empresarial obrigatório em operações novas (ainda sem `estoque_empresa`).
