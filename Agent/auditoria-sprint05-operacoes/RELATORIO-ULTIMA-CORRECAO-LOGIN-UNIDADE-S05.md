# ÚLTIMA CORREÇÃO DE HOMOLOGAÇÃO — S05
## Autorização operador ↔ unidade no login

**Data:** 2026-11-16  
**Status:** CORREÇÃO IMPLEMENTADA E TESTADA — aguardando nova auditoria do Tech Lead  
**Sprint 06:** NÃO INICIADA  
**Banco oficial:** intocado (sem migration versionada; CREATE IF NOT EXISTS apenas em banco de teste/login path)

---

## 1. Diff real

[`DIFF-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.patch`](./DIFF-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.patch)

| Arquivo | Alteração |
|---|---|
| `backend/services/cozinha/cozinhaAuthUnidade.js` | **Novo** — `validarUnidadeCozinhaNoLogin` + `garantirTabelaOperadorUnidades` |
| `backend/rotas/auth.js` | Valida unidade no cadastro **antes** de `jwt.sign` via `concluirLogin` |
| `backend/utils/cozinhaSchema.js` | DROP auxiliar em recreate de schema vazio (testes) |

---

## 2. Validação no login (antes do JWT)

1. Identifica operador autenticado (`usuario.id`).
2. Identifica empresa da sessão (`empresa_id` / `empresaId` do body, se informado).
3. Se `unidade_cozinha_id` **não** for solicitado → login segue (PDV / demais fluxos).
4. Se solicitado:
   - unidade existe em `cozinha_unidades`;
   - unidade ativa (`ativo = 1`);
   - empresa da unidade bate com a sessão (quando informada);
   - operador autorizado na empresa (`usuario_empresas`);
   - operador não-admin: vínculo ativo em `cozinha_operador_unidades`;
   - admin operacional: qualquer unidade ativa da empresa autorizada.
5. Só então assina o JWT com a unidade **validada**.

Códigos: `UNIDADE_INEXISTENTE` · `UNIDADE_INATIVA` · `UNIDADE_EMPRESA_ISOLAMENTO` · `UNIDADE_NAO_AUTORIZADA`.

---

## 3. Segurança

- Não confia exclusivamente no `unidade_cozinha_id` do cliente.
- Bloqueia unidade de outra empresa.
- Não altera permissões gerais do usuário (`permissoes` / role intactos).
- Novo token **não** contorna a autorização: toda emissão passa por `validarUnidadeCozinhaNoLogin`.
- Login sem unidade permanece válido.
- Sem bump de schema Cozinha (v3); tabela auxiliar via `CREATE IF NOT EXISTS` após inspeção das estruturas existentes.

---

## 4. Testes

| Suite | Resultado |
|---|---|
| `sprint05-login-unidade-auth.test.js` | **7/7** |
| `sprint05-operacoes-itens.test.js` | **23/23** |
| Regressão S01–S04A | **108/108** · `TOTAL_FAIL=0` |

Casos cobertos: autorizado · não autorizado · outra empresa · inexistente/inativa · JWT com unidade validada · middleware token inválido · HTTP real nas 3 ops.

Log completo: [`LOG-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.txt`](./LOG-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.txt)

---

## 5. Condição de encerramento

**ÚLTIMA CORREÇÃO DE HOMOLOGAÇÃO S05 ENTREGUE — AGUARDANDO NOVA AUDITORIA DO TECH LEAD.**

Sprint 06 não iniciada.
