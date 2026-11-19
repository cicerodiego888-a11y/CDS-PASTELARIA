# ISOLAMENTO OPERACIONAL POR UNIDADE — Sprint 05 (pós-correção)

**Atualizado:** 2026-11-16 — correção de homologação

---

## 1. Como o servidor identifica a unidade autorizada?

`req.user.unidade_cozinha_id` no JWT autenticado (emitido no login).

Fluxo: login assina o claim → `verificarToken` → `resolverUnidadeOperacionalReq` nas rotas das 3 ops.

Detalhe: `EVIDENCIA-ORIGEM-UNIDADE-AUTENTICADA.md`.

---

## 2. Sem `unidade_id` no body/query?

Se a sessão tem `unidade_cozinha_id`, a operação usa a unidade da sessão.

Se a sessão **não** tem → `UNIDADE_OBRIGATORIA`.

---

## 3. Operador consegue acessar item de outra unidade (mesma empresa)?

| Cenário | Resultado |
|---|---|
| Sessão = unidade A, item = unidade B | `UNIDADE_ISOLAMENTO` |
| Body tenta unidade B com sessão A | `UNIDADE_ISOLAMENTO` |
| Sem sessão de unidade | `UNIDADE_OBRIGATORIA` |

---

## 4. Mesma validação nas três operações?

**Sim.** Rotas e serviço aplicam o mesmo resolver + `validarIntegridadeOperacional` com unidade obrigatória.

---

## 5. Limitação residual

Login ainda aceita `unidade_cozinha_id` informado no body (assinado em seguida). Não há tabela `operador↔unidade` validada no login. Proposta futura: validar contra cadastro no login — fora desta correção.
