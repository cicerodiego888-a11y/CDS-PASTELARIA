# CORREÇÃO DE HOMOLOGAÇÃO — Sprint 05
## Isolamento operacional por unidade

**Data:** 2026-11-16  
**Status:** CORREÇÃO IMPLEMENTADA E TESTADA — aguardando nova auditoria do Tech Lead  
**Sprint 06:** NÃO INICIADA

---

## 1. Diff real de produção

[`DIFF-CORRECAO-HOMOLOGACAO-S05.patch`](./DIFF-CORRECAO-HOMOLOGACAO-S05.patch)

Arquivos:

| Arquivo | Alteração |
|---|---|
| `backend/services/cozinha/cozinhaUnidadeOperacional.js` | **Novo** — resolução autenticada da unidade |
| `backend/services/cozinha/CozinhaPreparacaoService.js` | Unidade **obrigatória** nas 3 ops |
| `backend/rotas/cozinha.js` | Usa `resolverUnidadeOperacionalReq(req)` |
| `backend/rotas/auth.js` | Emite `unidade_cozinha_id` no JWT |

---

## 2. Origem autenticada da unidade

| Etapa | Mecanismo |
|---|---|
| Login | `finalizarLoginComUsuario` lê `unidade_cozinha_id` do body (inteiro positivo) e **assina no JWT** — mesmo padrão de `terminal_id` / `caixa_sessao_id` |
| Request | `verificarToken` popula `req.user` a partir do JWT verificado |
| Rota Cozinha | `resolverUnidadeOperacionalReq(req)` usa **somente** `req.user.unidade_cozinha_id` como fonte autoritativa |
| Body/query | Se informados e não vazios, **devem coincidir** com a sessão; senão `UNIDADE_ISOLAMENTO`. Campo vazio → `UNIDADE_OBRIGATORIA` |
| Serviço | `exigirUnidadeOperacional` + comparação com `item.unidade_id` |

O cliente **não** escolhe livremente outra unidade: omitir body não abre a empresa; a sessão fixa a unidade. Manipular body para outra unidade é rejeitado.

Evidência: [`EVIDENCIA-ORIGEM-UNIDADE-AUTENTICADA.md`](./EVIDENCIA-ORIGEM-UNIDADE-AUTENTICADA.md)

---

## 3. Regras aplicadas (3 operações iguais)

| Situação | Código |
|---|---|
| Sessão sem unidade / inválida | `UNIDADE_OBRIGATORIA` (400) |
| Body/query vazia | `UNIDADE_OBRIGATORIA` (400) |
| Body/query ≠ sessão | `UNIDADE_ISOLAMENTO` (409) |
| Sessão ≠ unidade do item | `UNIDADE_ISOLAMENTO` (409) |

Operações: `iniciarPreparacao`, `marcarItemPronto`, `entregarBebida`.

---

## 4. Testes e logs

| Suite | Resultado |
|---|---|
| S05 ops (`sprint05-operacoes-itens.test.js`) | **23/23** |
| Regressão S01–S04A | **108/108** · `TOTAL_FAIL=0` |

Log integral: [`LOG-CORRECAO-HOMOLOGACAO-S05.txt`](./LOG-CORRECAO-HOMOLOGACAO-S05.txt)

Cenários de homologação cobertos (iniciar/pronto/bebida + resolver de sessão):

1. Operador na própria unidade — ok  
2. Item de outra unidade — `UNIDADE_ISOLAMENTO`  
3. Sem unidade — `UNIDADE_OBRIGATORIA`  
4. Unidade vazia — `UNIDADE_OBRIGATORIA`  
5–6. Sessão ausente / vazia / body divergente / manipulada  
7. Mesmas regras nas 3 ops  
8. Rollback (estado/claim/outbox intactos nas rejeições)  
9. Idempotência preservada (replay)

---

## 5. Preservação

- Motor S03 não duplicado; transições inalteradas.  
- Idempotência central + outbox + TX/rollback preservados.  
- PDV / estoque / fiscal / TEF / PIX não alterados (exceto claim JWT opcional no login, sem impacto nesses fluxos).  
- Sem migration.  
- **Banco oficial não acessado** (`CDS_BLOQUEAR_BANCO_OFICIAL=1`, `DB_DIR` temporário).

---

## 6. Relatório executivo

Contagem S05 na execução final desta correção: **23/23** (suite consolidou o bloco de homologação em um caso abrangente + demais cenários).  
Regressão S01–S04A: **108/108**.

Ver também atualização em `RELATORIO-EXECUTIVO.md` e `ISOLAMENTO-OPERACIONAL-UNIDADE.md`.

---

**Aguardando nova auditoria do Tech Lead.**  
Sprint 06 não iniciada.
