# Relatório — Implementação 03.3
## Vínculo usuário ↔ empresa + contexto empresarial

**Data:** 2026-08-14 · **Status:** concluída (critérios da Sprint)

---

## 1. Resumo

A 03.2 listava todas as empresas ativas para qualquer usuário autenticado. A 03.3 substitui essa regra por **autorização explícita** em `usuario_empresas`. O seletor e o `POST /contexto` passam a exigir vínculo ativo + empresa ativa. `X-Empresa-Id` continua sendo só solicitação de contexto. JWT, login, motores, estoque e COMPAT não foram alterados.

---

## 2. Auditoria

Não existia tabela ou serviço de vínculo usuário ↔ empresa. `exigirAdmin` já governa cadastro de usuários (`role` / `perfil`); **não** foi reutilizado como “ADMIN vê todas as empresas”. Sem essa regra oficial, nenhuma exceção global foi inventada.

---

## 3. Arquivos criados

- `backend/services/empresas/usuarioEmpresasSchema.js`
- `backend/services/empresas/UsuarioEmpresaService.js`
- `tests/empresas/usuario-empresa-03-3.test.js`
- `docs/arquitetura/IMPLEMENTACAO_03_3_USUARIO_EMPRESA.md`
- `docs/arquitetura/IMPLEMENTACAO_03_3_RELATORIO.md` (este)

## 4. Arquivos alterados

- `backend/database.js` — `garantirSchemaUsuarioEmpresas`
- `backend/services/empresas/EmpresaService.js` — disponíveis/seleção exigem vínculo
- `backend/services/empresas/index.js` — reexporta o serviço de vínculo
- `backend/services/fiscalNaoFiscal/empresaContexto.js` — middleware valida vínculo quando há `X-Empresa-Id` (sem alterar `validarEmpresaId`)
- `backend/rotas/empresas.js` — contexto recebe `req.user`
- `backend/rotas/auth.js` — CRUD admin de vínculos em `/api/auth/usuarios/:id/empresas`
- `frontend/shared/js/cds-empresa-contexto.js` — lista permitida; falha de troca não persiste
- `tests/empresas/contexto-empresarial-03-2.test.js` — fixtures de vínculo (03.2 continua válida sob a nova regra)

Não alterados: JWT, login, tabela `usuarios`, MTS, MUC, MIIP, Central, TEF, motores Fiscal/Não Fiscal/Comercial, mutadores de saldo, `COMPAT_*`.

---

## 5. Testes 03.3

`node tests/empresas/usuario-empresa-03-3.test.js` → **16/16 OK**

Cobertura: criar vínculo, duplicado, listar, vinculada ativa, não vinculada, inativa, seleção ok/falha, inexistente, header sem bypass, troca autorizada/não autorizada, usuário sem empresas, logout, COMPAT.

03.1 cadastro: **17/17 OK**  
03.2 contexto (adaptada): **11/11 OK**

---

## 6. Regressão

| Suíte | Resultado |
|---|---|
| 03.1 cadastro | 17/17 |
| 03.2 contexto | 11/11 |
| 03.3 vínculo | 16/16 |
| 02.1 ajuste | 15/15 |
| 02.2 recálculo | 15/15 |
| 02.3 crédito compra | 11/11 |
| 02.4 débito compra | 12/12 |
| 02.5 crédito venda | 12/12 |
| 02.6 débito venda | 12/12 |
| 02.7 reservas PDV | 11/11 |
| Porta pública | 17/17 |
| MTS | homologado |
| MUC contrato | 20/20 |
| Motor Comercial RC3.16.1 | homologado |

---

## 7. Critérios

| Critério | Status |
|---|---|
| Usuário pode ter empresas vinculadas | sim |
| Vínculo único | sim |
| Seletor só com permitidas | sim |
| Inativa / não vinculada fora | sim |
| `X-Empresa-Id` não bypassa | sim |
| Backend valida vínculo | sim |
| Troca autorizada | sim |
| Contexto oficial `empresaContexto` | sim |
| JWT sem `empresaId` | sim |
| COMPAT / produto global / `produtos` | sim |
| `estoque_empresa` / motores | não alterados |
| Testes 03.1, 03.2 e 02.1–02.7 | passam |

---

## 8. Próxima sprint

03.4 — contexto empresarial obrigatório em operações novas (ainda sem `estoque_empresa`).
