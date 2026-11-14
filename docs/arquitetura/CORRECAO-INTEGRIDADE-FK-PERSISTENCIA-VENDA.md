# Correção da integridade referencial na persistência da venda

**ID:** CDS-PDV-PERSISTENCIA-FK-01  
**Erro visto no PDV:** `Integridade do banco na etapa "persistencia_venda" (FOREIGN KEY).`  
**Referências exibidas:** `caixa_sessao_id=8`, `caixa_id=8`, `terminal_id=3`, `operador_id=2`.  
**Banco oficial:** não foi consultado nem alterado.

## FOREIGN KEY que falha

`vendas.caixa_id` → `caixa(id)`.

O SQLite só responde `FOREIGN KEY constraint failed`. A mensagem do PDV lista os quatro IDs enviados ao `INSERT`, sem nomear a coluna. No esquema, essas colunas apontam para tabelas diferentes:

| Coluna em `vendas` | Tabela referenciada |
|---|---|
| `caixa_id` | `caixa(id)` — turno |
| `caixa_sessao_id` | `caixa_sessoes(id)` |
| `terminal_id` | `terminais(id)` |
| `operador_id` | `usuarios(id)` |
| `cliente_id` | `clientes(id)` |
| `empresa_id` | `empresas(id)` |

`caixa_sessoes.caixa_id` aponta para `caixas(id)`, o cadastro. Não é a mesma tabela de `vendas.caixa_id`.

## Causa raiz

`obterCaixaTurnoId` devolvia `sessao.caixa_id` quando `caixa_turno_id` estava vazio. No multi-caixa, `sessao.caixa_id` é o cadastro (`caixas`). Esse número era gravado em `vendas.caixa_id`, que só aceita o turno (`caixa`).

A reprodução em memória usou os números do erro sem tratar sessão e caixa como o mesmo registro:

- cadastro `caixas.id = 8`
- sessão `caixa_sessoes.id = 8`, com `caixa_id = 8` e `caixa_turno_id` vazio
- turno real `caixa.id = 15`
- terminal `3` e operador `2` existentes

O `INSERT` com `caixa_id = 8` falhou. O mesmo `INSERT` com `caixa_id` nulo e os outros três IDs passou. A sessão, o terminal e o operador existiam. O id `8` existia em `caixas` e não existia em `caixa`. A chave que quebrou foi `vendas.caixa_id`.

Sessão `9` com turno `15` grava `caixa_id = 15`. Os números da sessão e do turno não precisam ser iguais.

## Correção

`obterCaixaTurnoId` passa a devolver somente `caixa_turno_id`. Sem turno, devolve vazio. O cadastro não entra no lugar do turno.

Antes dos dois `INSERT` de `vendas` em `VendaPagamentoService`, `validarReferenciasPersistenciaVenda` confere a sessão, o turno, o terminal, o operador, a empresa e o cliente. A sessão sem turno, a sessão de outro turno e o terminal de outra sessão recebem código e mensagem próprios. A venda não é inserida. `PRAGMA foreign_keys` permanece ligado. Nenhum registro foi criado para satisfazer chave.

A transação exclusiva já faz `ROLLBACK` se a operação falha. O teste isolado confirmou: uma venda inserida e desfeita não permanece, e a tentativa seguinte grava uma única venda com o turno `15`.

## Arquivos

- `backend/utils/caixaSessaoHelpers.js`
- `backend/services/vendas/VendaReferenciaIntegridade.js`
- `backend/services/vendas/VendaPagamentoService.js`
- `tests/vendas/integridade-fk-persistencia-venda.test.js`

## Testes

`node --test --test-concurrency=1 tests/vendas/integridade-fk-persistencia-venda.test.js tests/vendas/entrega-caixa-turno-fk.test.js`

7 testes, 7 aprovações. Cobrem referências válidas, caixa ausente, sessão ausente, terminal ausente, operador ausente, sessão de outro turno, terminal de outra sessão, rollback e repetição depois da falha.

## O que não mudou

Composição, distribuição comercial e fiscal, tolerância de 20%, classificação fiscal e não fiscal, estoque, pagamentos, TEF, PIX e emissor fiscal não foram alterados. O banco oficial não foi lido nem modificado.
