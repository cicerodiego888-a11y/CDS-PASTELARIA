# EVIDÊNCIA DE TRANSAÇÕES E ROLLBACK — Sprint 05

## Padrão

Todas as três operações:

1. `PRAGMA foreign_keys = ON`  
2. `BEGIN IMMEDIATE`  
3. claim idempotência → carga item/rodada → integridade → mutação → outbox → concluir claim  
4. `COMMIT`  
5. Em qualquer erro: `ROLLBACK` e rethrow

## Falha mid-TX (hook de teste)

`opts.simularFalha === 'antes_commit'` lança `FALHA_SIMULADA` **depois** de mutar estado/idempotência/outbox e **antes** do commit.

| Teste | Estado residual esperado |
|---|---|
| iniciar + falha | item permanece `AGUARDANDO`; 0 claim; 0 outbox |
| pronto + falha | item permanece `EM_PREPARACAO`; 0 claim da chave de pronto |
| bebida + falha | 0 linhas em `cozinha_bebida_entregas`; 0 claim |

Confirmado em `LOG-TESTES-S05.txt` (`falha durante a transação`, `rollback integral em falha de bebida`).

## Isolamento

- Empresa: item de empresa 1 inacessível com `empresaId=2`.  
- Unidade: `unidade_id` divergente → `UNIDADE_ISOLAMENTO`.  
- Relações: comanda órfã / atendimento divergente / unidade item≠rodada rejeitados sem commit parcial.
