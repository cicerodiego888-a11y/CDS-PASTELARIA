# MANIFESTO — Sprint 04A Upgrade Schema Cozinha v2 → v3

| Arquivo | Descrição |
|---|---|
| RELATORIO-EXECUTIVO.md | Resumo e condição de encerramento |
| DIAGNOSTICO-V2-V3.md | Diferença exata v2 vs v3 |
| ESTRATEGIA-MIGRACAO.md | Estratégia transacional implementada |
| AUDITORIA-PRESERVACAO-DADOS.md | Evidência de preservação |
| AUDITORIA-INTEGRIDADE-SQLITE.md | PRAGMAs e constraints |
| AUDITORIA-INICIALIZACAO-ERP.md | Falha Cozinha ≠ falha ERP |
| DIFF-SPRINT04A.patch | Código alterado integral |
| TESTES-MIGRACAO.md | Cenários A–F e resultados |
| LOG-TESTES-SPRINT04A.txt | Log dos testes 04A |
| LOG-REGRESSAO-S01-S03.txt | Regressão S01–S03 |
| RELATORIO-CORRECOES-AUDITORIA-S04A.md | Correções FK + backup residual |
| DIFF-CORRECOES-AUDITORIA-S04A.patch | Diff das correções |
| LOG-CORRECOES-AUDITORIA-S04A.txt | Log correções anteriores |
| RELATORIO-CORRECAO-FINAL-TECHLEAD-S04A.md | Correção final restauração FK |
| DIFF-CORRECAO-FINAL-TECHLEAD-S04A.patch | Diff correção final |
| LOG-CORRECAO-FINAL-TECHLEAD-S04A.txt | Log correção Tech Lead |
| RELATORIO-VALIDACAO-FINAL-DBRUN-S04A.md | Validação rejeições reais db.run |
| DIFF-VALIDACAO-FINAL-DBRUN-S04A.patch | Diff testes db.run |
| LOG-VALIDACAO-FINAL-DBRUN-S04A.txt | Log 108/108 |
| MANIFESTO.md | Este índice |

## Código

- `backend/utils/cozinhaSchema.js` — migração `migrarCozinhaV2paraV3`
- `tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js`

**Sprint 05:** não iniciada.  
**Banco oficial:** não acessado / sem migration.
