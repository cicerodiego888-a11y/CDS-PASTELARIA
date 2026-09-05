# IMPLEMENTAÇÃO MBC-02

STATUS: CONCLUÍDA

## 1. STATUS

CONCLUÍDA

## 2. O que foi implementado

Persistência e CRUD de instituições financeiras e contas bancárias por empresa, via Motor Bancário existente.

## 3. Estrutura de banco

Tabelas `instituicao_financeira` e `conta_bancaria` em `backend/motores/bancario/schema/bancarioSchema.js`, garantidas em `database.js`.

## 4. APIs

`GET/POST/PUT/DELETE /api/bancario/instituicoes`  
`GET/POST/PUT/PATCH/DELETE /api/bancario/contas...`

## 5. Regras multiempresa

`resolverEmpresaIdParaBancario` + `UsuarioEmpresaService`. Sem `empresa_id = 1`. Conta de outra empresa = 404.

## 6. Conta principal

Uma por empresa, transação SQLite + índice único parcial. Desativar remove principal.

## 7. Segurança

Nenhum campo de token/senha/OAuth. Permissão `financeiro`.

## 8. O que NÃO foi implementado

Open Finance, OFX, extrato, transações, conciliação, PIX/TEF bancário, DRE, alteração de financeiro/vendas/compras/caixa/MIS/MUC/PDV.

## 9. Testes MBC-02

22/22 em `tests/bancario/motor-bancario-02.test.js` (T01–T25 cobertos).

## 10. Testes de regressão

MBC-01 11/11. Financeiro 05.38.D 20/20, 05.41 14/14. Caixa 05.38.C 17/17. Vendas 05.40 13/13. Compras 05.64 OK.

Ajuste pontual no MBC-01: deixou de proibir `/api/bancario` (a MBC-02 exige a API). Continua proibindo OAuth.

## 11. Arquivos

Ver relatório de implementação abaixo (lista completa).

## 12. Pendências

Homologação visual no browser. Catálogo grande de bancos (não seedado).

## 13. Riscos

Cadastro de instituição é compartilhado (qualquer usuário com permissão financeiro). Secrets continuam no TEF/PIX legado (fora desta sprint).

## 14. Conclusão

APTO PARA MBC-03

## 15. Recomendação

MBC-03 — Transações bancárias + idempotência + saldos conceituais.
