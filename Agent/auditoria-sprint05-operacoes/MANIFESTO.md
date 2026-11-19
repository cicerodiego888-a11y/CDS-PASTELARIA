# MANIFESTO — Sprint 05 Operações dos Itens da Cozinha

| Arquivo | Descrição |
|---|---|
| RELATORIO-EXECUTIVO.md | Resumo e condição de encerramento (§12 atualizada) |
| RELATORIO-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.md | **Última correção** — validação no login |
| DIFF-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.patch | **Diff real** login operador↔unidade |
| LOG-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.txt | login 7/7 · S05 23/23 · S01–S04A 108/108 |
| EVIDENCIA-ORIGEM-UNIDADE-AUTENTICADA.md | Cadeia login→validação→JWT→ops |
| DIAGNOSTICO-INICIAL.md | Etapa Zero / inspeção |
| CONTRATOS-SERVICOS-ENDPOINTS.md | Serviços e rotas |
| REGRAS-TRANSICAO.md | Transições de estado |
| EVIDENCIA-IDEMPOTENCIA.md | Claim central + hash |
| EVIDENCIA-TRANSACOES-ROLLBACK.md | TX + rollback |
| DIFF-SPRINT05.patch | Diff (suite + delta documentado) |
| DIFF-CODIGO-PRODUCAO-S05.patch | Diff real produção (entrega inicial S05) |
| DIFF-CORRECAO-HOMOLOGACAO-S05.patch | Diff real isolamento unidade (JWT) |
| ISOLAMENTO-OPERACIONAL-UNIDADE.md | Unidade autenticada (pós-correção JWT) |
| RELATORIO-COMPLEMENTACAO-AUDITORIA-S05.md | Complemento pré-correção |
| RELATORIO-CORRECAO-HOMOLOGACAO-S05.md | Correção de homologação (JWT) |
| LOG-TESTES-S05.txt | 23/23 (entrega inicial) |
| LOG-COMPLEMENTO-AUDITORIA-S05.txt | 24/24 (pré-correção) |
| LOG-CORRECAO-HOMOLOGACAO-S05.txt | S05 23/23 + regressão 108/108 |
| LOG-REGRESSAO-S01-S04A.txt | 108/108 · TOTAL_FAIL=0 |
| MANIFESTO.md | Este índice |
| INDEX.md | Atalho de leitura |

## Código (última correção)

- `backend/services/cozinha/cozinhaAuthUnidade.js` — validação operador↔unidade no login
- `backend/rotas/auth.js` — `concluirLogin` → valida antes de `jwt.sign`
- `backend/utils/cozinhaSchema.js` — DROP auxiliar em recreate vazio
- `backend/services/cozinha/cozinhaUnidadeOperacional.js` — unidade autenticada nas ops
- `backend/services/cozinha/CozinhaPreparacaoService.js` — unidade obrigatória nas 3 ops
- `backend/rotas/cozinha.js` — `resolverUnidadeOperacionalReq`
- `tests/cozinha/sprint05-login-unidade-auth.test.js`
- `tests/cozinha/sprint05-operacoes-itens.test.js`

**Sprint 06:** não iniciada.  
**Banco oficial:** não acessado / sem migration versionada.
