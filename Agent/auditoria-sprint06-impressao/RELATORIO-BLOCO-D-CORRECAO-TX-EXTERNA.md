# RELATÓRIO — Sprint 06 · Correção final Bloco D (TX externa) — confirmação

**Data:** 2026-11-17  
**Status:** CORREÇÃO FINAL BLOCO D CONFIRMADA — aguardando auditoria do Tech Lead  
**Bloco E:** NÃO INICIADO  
**Schema:** **v3**  
**Banco oficial:** intocado (`CDS_BLOQUEAR_BANCO_OFICIAL=1`)

---

## Verificação de `msg`

No código de produção, `msg` **está declarado** no `catch` antes do uso. Trecho completo atual:

```js
async function comTransacaoImediata(db, fn) {
  try {
    await dbExec(db, 'BEGIN IMMEDIATE');
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/within a transaction/i.test(msg)) {
      throw erroImpressao(
        'Claim exige BEGIN IMMEDIATE próprio; conexão já está em transação externa.',
        409,
        'IMPRESSAO_CLAIM_TX_EXTERNA',
        { detalhes: { causa: msg } }
      );
    }
    throw err;
  }

  try {
    const out = await fn();
    await dbExec(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbExec(db, 'ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  }
}
```

Comportamento preservado:
- `BEGIN IMMEDIATE` obrigatório.
- TX externa → `IMPRESSAO_CLAIM_TX_EXTERNA` (sem adesão silenciosa).
- `COMMIT`/`ROLLBACK` só da TX iniciada aqui.

## Teste 21

Valida explicitamente:
- `claimErro.codigo === 'IMPRESSAO_CLAIM_TX_EXTERNA'`
- `claimErro.statusCode === 409`
- mensagem do worker (não SQLITE cru)
- `detalhes.causa` contém `within a transaction`
- job permanece `PENDENTE`; TX externa sob controle do chamador (`ROLLBACK`)

## Arquivos

| Arquivo | Ação |
|---|---|
| `backend/services/cozinha/CozinhaImpressaoWorkerService.js` | Função completa com `const msg` |
| `tests/cozinha/sprint06-bloco-d-worker-falhas.test.js` | Teste 21 reforçado |

## Testes

| Suite | Resultado |
|---|---|
| Bloco D | **21/21** |
| Bloco C | **34/34** |
| B1 | **10/10** |
| B2 | **14/14** |
| Bloco A | **14/14** |
| S01+S05 | **52/52** |
| `TOTAL_FAIL` | **0** |

Artefatos:  
- `DIFF-BLOCO-D-CORRECAO-TX-EXTERNA.patch`  
- `LOG-BLOCO-D-CORRECAO-TX-EXTERNA.txt`

---

**CONFIRMADO — AGUARDANDO AUDITORIA. NÃO INICIAR BLOCO E.**
