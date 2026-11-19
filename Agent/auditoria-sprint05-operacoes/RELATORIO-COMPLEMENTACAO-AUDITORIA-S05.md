# COMPLEMENTAÇÃO DA AUDITORIA — Sprint 05

**Data:** 2026-11-16  
**Motivo:** pedido do Tech Lead antes da aprovação definitiva  
**Status:** ENTREGUE — aguardando nova auditoria do Tech Lead  
**Sprint 06:** não iniciada

---

## 1. Diff real do código de produção

Arquivo: [`DIFF-CODIGO-PRODUCAO-S05.patch`](./DIFF-CODIGO-PRODUCAO-S05.patch)

Unified diff (baseline S03 → atual) contendo **apenas**:

- `backend/services/cozinha/CozinhaPreparacaoService.js`
  - função `validarIntegridadeOperacional`
  - chamadas nas 3 operações
  - hook `opts.simularFalha === 'antes_commit'` (teste)
- `backend/rotas/cozinha.js`
  - propagação de `unidade_id` (body/query) nas rotas iniciar / pronto / bebida

Não é descrição textual: hunks `@@` com contexto suficiente para revisão.

Gerador reproduzível (opcional): `_build-diff-s05.js`.

---

## 2. Isolamento operacional por unidade

Documento completo: [`ISOLAMENTO-OPERACIONAL-UNIDADE.md`](./ISOLAMENTO-OPERACIONAL-UNIDADE.md)

Síntese:

| Pergunta | Resposta |
|---|---|
| Como o servidor identifica a unidade autorizada do operador? | **Não identifica** — sessão só expõe `operadorId` + empresa |
| Sem `unidade_id`? | Checagem de unidade **omitida**; demais integridades seguem |
| Item de outra unidade (mesma empresa)? | **Aceito** se `unidade_id` não for enviado |
| Mesma validação nas 3 ops? | **Sim** — mesmo helper |

**Limitação:** ausência de vínculo operador↔unidade.  
**Solução mínima proposta:** documentada no §6 do isolamento — **não implementada** nesta complementação.

---

## 3. Teste adicional

Caso: `sem unidade_id + item de outra unidade (mesma empresa) — limitação e defesa com unidade declarada`

Arquivo: `tests/cozinha/sprint05-operacoes-itens.test.js`

Cobertura:

1. Sem `unidade_id`: iniciar / pronto / bebida em item da unidade B → **sucesso** (limitação atual).  
2. Com `unidade_id` = unidade A do operador e item na B → **`UNIDADE_ISOLAMENTO`** nas três ops.

Log: [`LOG-COMPLEMENTO-AUDITORIA-S05.txt`](./LOG-COMPLEMENTO-AUDITORIA-S05.txt)

---

## 4. Restrições respeitadas

- Motor S03 não refatorado (apenas reforços S05 já existentes + teste/docs).  
- S01–S04A / PDV / estoque / fiscal intocados.  
- Banco oficial não acessado.  
- Sprint 06 não iniciada.

---

**Aguardando nova auditoria do Tech Lead.**
