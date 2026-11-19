# RESULTADO DOS TESTES — Auditoria Sprint 02

**Data de reexecução (auditoria):** 2026-11-16  
**Banco:** exclusivamente temporário (`DB_DIR` em `%TEMP%`, `CDS_BLOQUEAR_BANCO_OFICIAL=1`, sem `CDS_ALLOW_OFFICIAL_DB`)  
**Modo:** sequencial (`--test-concurrency=1`)

Logs brutos:

- `logs/sprint02-testes.log`
- `logs/sprint01-regressao.log`
- `logs/reproducoes-auditoria.log`
- `reproducoes/RESULTADO-REPRODUCOES.json`

---

## Comandos exatos

```bat
node --test --test-concurrency=1 tests/cozinha/sprint02-despacho-fifo.test.js
```

```bat
node --test --test-concurrency=1 tests/cozinha/sprint01-fundacao-persistencia.test.js tests/cozinha/sprint01-correcao-isolamento-empresa.test.js
```

```bat
node Agent/auditoria-sprint02-cozinha/reproducoes/reproducoes-auditoria-sprint02.js
```

---

## Sprint 02 — 21 testes (todos PASS)

| # | Caso | Resultado | ms (auditoria) |
|---|---|---|---|
| 1 | uma comanda gera uma rodada | PASS | ~47 |
| 2 | duas comandas → uma rodada | PASS | ~20 |
| 3 | item vinculado à sua comanda | PASS | ~15 |
| 4 | personalizações preservadas | PASS | ~13 |
| 5 | estados iniciais corretos | PASS | ~13 |
| 6 | sequências FIFO crescem | PASS | ~18 |
| 7 | concorrência chaves distintas | PASS | ~1023 |
| 8 | FIFO não reinicia por atendimento | PASS | ~25 |
| 9 | replay mesma chave/payload | PASS | ~24 |
| 10 | mesma chave payload diferente → 409 | PASS | ~22 |
| 11 | mesma chave outro tipo → 409 | PASS | ~13 |
| 12 | pedido outra empresa | PASS | ~16 |
| 13 | atendimento ≠ mesa | PASS | ~14 |
| 14 | unidade inativa | PASS | ~19 |
| 15 | qty > saldo sem consumir FIFO | PASS | ~16 |
| 16 | despacho parcial + restante | PASS | ~21 |
| 17 | alteração silenciosa não eleva teto | PASS | ~27 |
| 18 | >3 casas decimais | PASS | ~16 |
| 19 | milésimos inteiros | PASS | ~17 |
| 20 | rollback após claim | PASS | ~17 |
| 21 | CONCLUIDA na tabela central | PASS | ~17 |

Resumo runner: `tests 21 / pass 21 / fail 0 / duration_ms ~1742`

---

## Sprint 01 — 22 verificações (regressão, todos PASS)

Correção isolamento (8) + fundação (5) + hash (5) + milésimos (4) = **22**.

| Bloco | Resultado |
|---|---|
| Isolamento FK composta (1–6) | PASS |
| Falha init Cozinha (7–8) | PASS |
| Fundação tabelas/idempotência/concorrência | PASS |
| Hash determinístico | PASS |
| Precisão milésimos | PASS |

Resumo runner: `tests 22 / pass 22 / fail 0 / duration_ms ~2624`

---

## Cobertura pedida na auditoria vs suite oficial

| Cenário | Suite S02 | Reprodução auditoria |
|---|---|---|
| Duas req simultâneas mesma unidade, chaves diferentes | Sim (7) | R1 PASS |
| Duas req simultâneas mesma chave | Não | R2 PASS (1 rodada; 2 fulfilled via replay) |
| Replay após alteração do pedido | Sim (9) | R3 PASS |
| Falha após incremento FIFO | Não (validação pré-FIFO) | R4 PASS (trigger artificial) |
| Falha após itens parciais | Não | R5 PASS (trigger artificial) |
| Item repetido no payload | Não | R6 PASS `ITEM_DUPLICADO_NO_LOTE` |
| Item de unidade diferente | N/A modelo | R7 INFO — ausência de unidade por item |
| Comanda outro atendimento | Não | R8 PASS |
| Qty > teto | Sim (15) | R9 PASS |
| Mesma chave payload diferente | Sim (10) | R10 PASS |

---

## Falhas durante o desenvolvimento e correções (histórico da Sprint)

Com base na sessão de implementação (não há CI histórico versionado desta Sprint):

1. Serviço `CozinhaDespachoService` escrito antes da rota e dos testes.
2. Hash `DESPACHO_LOTE` ajustado para incluir `empresa_id` e `pedido_id` por item.
3. Rota + mount em `server.js`.
4. Suite de 21 testes criada e executada em banco temporário — **primeira execução da suite oficial: 21/21 pass** (sem falhas registradas no log de auditoria; não há log de “red→green” separado além do desenvolvimento).
5. Validação `COMANDA_PEDIDO_INCOMPATIVEL` adicionada quando `comanda.pedido_id` está preenchido.

Nenhuma falha foi omitida: a reexecução da auditoria confirma verde atual.

---

## Confirmações

- Execução **sequencial** (`--test-concurrency=1`): **sim**.
- Banco oficial acessado: **não**.
- Resultados inventados: **não** — logs anexados.
