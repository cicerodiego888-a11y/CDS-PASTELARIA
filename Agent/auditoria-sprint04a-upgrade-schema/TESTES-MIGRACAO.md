# TESTES — Sprint 04A

Arquivo: `tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js`  
Comando: `node --test --test-concurrency=1 tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js`  
Log: `LOG-TESTES-SPRINT04A.txt`

## Cenários

| Cenário | Caso | Resultado |
|---|---|---|
| A | v2 vazio → v3, meta=3, CHECK atualizado | PASS |
| B | v2 populado: contagens/IDs/conteúdo + novos tipos | PASS |
| C | Falha simulada: ROLLBACK, Cozinha off, dados intactos, recuperação OK | PASS |
| D | Init repetida: sem remigração indevida | PASS |
| E | Versão 99 incompatível | PASS |
| E | v1 populado bloqueado sem perda | PASS |

**04A: 6/6 PASS**

## Cenário F — Regressão

```
node --test --test-concurrency=1 \
  tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js \
  tests/cozinha/sprint01-*.test.js \
  tests/cozinha/sprint02-*.test.js \
  tests/cozinha/sprint03-*.test.js
```

Log: `LOG-REGRESSAO-S01-S03.txt`  
**99 tests, 99 pass, 0 fail**

Inclui: S01 fundação + isolamento, S02 despacho/FIFO/correções/HTTP, S03 preparação + correções auditoria, S04A migração.
