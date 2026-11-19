# RELATÓRIO EXECUTIVO — Sprint 05 Cozinha

**Projeto:** CDS Sistemas — Pastelaria  
**Módulo:** Cozinha  
**Sprint:** 05 — Operações e Transições dos Itens  
**Data:** 2026-11-16  
**Responsável implementação:** Cursor  
**Status:** ÚLTIMA CORREÇÃO DE HOMOLOGAÇÃO APLICADA — aguardando nova auditoria do Tech Lead  
**Sprint 06:** NÃO INICIADA

---

## 1. Resumo

As três operações do ciclo de preparação (`iniciarPreparacao`, `marcarItemPronto`, `entregarBebida`) reutilizam o motor S03 (idempotência central, hash, outbox, `BEGIN IMMEDIATE`). A Sprint 05 reforçou integridade item↔rodada↔comanda↔unidade. A **correção de homologação** tornou a unidade operacional **obrigatória e autenticada** via JWT. A **última correção** valida operador↔unidade **no login**, antes de assinar o JWT — sem confiar só no `unidade_cozinha_id` do cliente.

**Testes (execução final):** login-auth **7/7** · S05 **23/23** · regressão S01–S04A **108/108** (`TOTAL_FAIL=0`)  
**Banco:** exclusivamente temporário (`os.tmpdir` + `CDS_BLOQUEAR_BANCO_OFICIAL=1`). Banco oficial do cliente **não acessado**.

Pacote última correção: `RELATORIO-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.md` · `DIFF-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.patch` · `LOG-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.txt`.

---

## 2. Diagnóstico inicial (síntese)

| Achado | Decisão |
|---|---|
| Motor S03 já implementa as 3 ops + `PREPARACAO_INICIADA` / `ITEM_PRONTO` / `BEBIDA_ENTREGUE` | Reutilizar |
| Schema v3 (S04A) já possui tabelas e CHECKs de idempotência | Sem migration |
| Lacuna: validação explícita unidade/comanda↔rodada nas ops | `validarIntegridadeOperacional` |
| Lacuna: cobertura S05 dedicada + falha mid-TX | Suite + `simularFalha: 'antes_commit'` |

Detalhe: `DIAGNOSTICO-INICIAL.md`.

---

## 3. Arquivos

### Criados
| Arquivo | Função |
|---|---|
| `tests/cozinha/sprint05-operacoes-itens.test.js` | Cobertura obrigatória S05 |
| `Agent/auditoria-sprint05-operacoes/*` | Pacote de auditoria |

### Modificados
| Arquivo | Função |
|---|---|
| `backend/services/cozinha/CozinhaPreparacaoService.js` | Integridade operacional + hook de falha TX (teste) |
| `backend/rotas/cozinha.js` | Propaga `unidade_id` opcional nas 3 rotas |

### Removidos
Nenhum.

### Intactos (escopo)
PDV, estoque, fiscal, TEF, PIX, impressão, KDS, WebSocket — sem alteração.

---

## 4. Diff

`DIFF-SPRINT05.patch` — suite S05 integral + delta documentado do serviço/rotas.

---

## 5. Contratos de serviços e endpoints

Ver `CONTRATOS-SERVICOS-ENDPOINTS.md`.

---

## 6. Regras de transição

Ver `REGRAS-TRANSICAO.md`.

---

## 7. Evidência de idempotência

Ver `EVIDENCIA-IDEMPOTENCIA.md` e `LOG-TESTES-S05.txt` (casos `*-dup`, `*-idem`, `hash-reuse`).

---

## 8. Evidência de transações e rollback

Ver `EVIDENCIA-TRANSACOES-ROLLBACK.md` e testes `simularFalha` / `FALHA_SIMULADA`.

---

## 9–10. Logs e regressão

| Artefato | Resultado |
|---|---|
| `LOG-TESTES-S05.txt` | 23/23 pass |
| `LOG-REGRESSAO-S01-S04A.txt` | 108/108 pass · TOTAL_FAIL=0 |

---

## 11. Declaração de banco

- Testes usam `fs.mkdtempSync(os.tmpdir()…)` e `process.env.DB_DIR` local.  
- `CDS_BLOQUEAR_BANCO_OFICIAL=1`, `CDS_FORCAR_LOCAL=1`, `CDS_TEST_ISOLATION=1`.  
- Nenhuma migration em produção. Nenhuma alteração na instalação do cliente.

---

## 12. Riscos e limitações

| Risco / limitação | Mitigação / nota |
|---|---|
| Cliente informa `unidade_cozinha_id` no login | **Mitigado:** `validarUnidadeCozinhaNoLogin` consulta cadastro (`cozinha_unidades` + `usuario_empresas` + `cozinha_operador_unidades`) **antes** de `jwt.sign`; rejeita inexistente/inativa/outra empresa/sem vínculo |
| Token sem claim de unidade nas ops de cozinha | `UNIDADE_OBRIGATORIA` — ops exigem JWT com unidade validada |
| Body/query tentando outra unidade na sessão | `UNIDADE_ISOLAMENTO` — sessão JWT é autoritativa |
| Hook `opts.simularFalha` existe só para testes | Não exposto em HTTP |
| Conclusão do item ≠ retirada/entrega ao cliente | Mantido: `retirada_estado` / `entrega_estado` inalterados por S05 |
| Entrega de bebida não altera estoque/financeiro | Confirmado no escopo |
| Tabela auxiliar `cozinha_operador_unidades` | `CREATE IF NOT EXISTS` no path de auth (sem bump schema v3 / sem migration de produção) |

---

## Condição de encerramento

**ÚLTIMA CORREÇÃO DE HOMOLOGAÇÃO S05 ENTREGUE — AGUARDANDO NOVA AUDITORIA DO TECH LEAD.**

Não aprovada automaticamente. Sprint 06 não iniciada.
