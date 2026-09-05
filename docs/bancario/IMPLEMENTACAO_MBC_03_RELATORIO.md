# IMPLEMENTAÇÃO MBC-03

STATUS: CONCLUÍDA

## 1. STATUS

CONCLUÍDA

## 2. Arquitetura

EMPRESA → CONTA_BANCARIA → INSTITUICAO_FINANCEIRA (catálogo) e TRANSACAO_BANCARIA ligada à conta, com `empresa_id` persistido igual ao da conta.

Fachada: `MotorBancarioService` (`registrarTransacaoBancaria`, `listarTransacoes`, `obterTransacao`, `calcularSaldoConceitual`). Persistência: `TransacaoBancariaService`. DTO: `TransacaoBancariaNormalizada` (evoluído; sem DTO paralelo).

## 3. Tabela `transacao_bancaria`

Campos mínimos da sprint + índice único parcial de idempotência. Sem credenciais. Sem tabelas de conciliação.

## 4. Campos

Valor positivo; direção MBC-01 (`entrada` / `saida` / `transferencia`); `data_transacao` obrigatória; `data_processamento` e `saldo_apos_transacao` opcionais.

## 5. Idempotência

Chave `empresa_id + conta_bancaria_id + external_source + external_id`. Retorno `CRIADA` / `JA_EXISTENTE`. Sem mutação silenciosa. Sem `external_id`: persiste, `idempotencia: false`.

## 6. Isolamento

`BancarioEmpresaContextoService` + conta no contexto. Sem fallback empresa 1.

## 7. APIs

`GET/POST /api/bancario/transacoes`, `GET /api/bancario/transacoes/:id`, `GET /api/bancario/contas/:id/transacoes`, `GET /api/bancario/contas/:id/saldo`. SQL só no service.

## 8. Saldo conceitual

Entradas − saídas. Sem saldo inicial automático. Sem usar `saldo_apos_transacao`. Transferência não vira receita/despesa nem altera o saldo conceitual nesta sprint.

## 9. Diferença conceitual × bancário

Documentada na spec e na UI: **Saldo conceitual** ≠ saldo atual do banco.

## 10. Imutabilidade

Sem PUT de transação.

## 11. Conta inativa

409 `Conta bancária está inativa.` na criação.

## 12. Exclusão

409 `Conta bancária possui transações e não pode ser excluída.`

## 13. Segurança

Permissão `financeiro`. Query `empresa_id` ignorada. Body `empresa_id` sobrescrito. `raw_reference` sem segredos.

## 14. O que NÃO foi implementado

Open Finance, OAuth, OFX, sync, conciliação, vínculos automáticos, DRE, MIS, MUC, PDV, vendas, compras, caixa, PIX, TEF, transferência entre contas.

## 15. Testes MBC-03

31/31 em `tests/bancario/motor-bancario-03.test.js` (T01–T30 + invariante).

## 16. Regressão

MBC-01 11/11. MBC-02 22/22. Financeiro 05.38.D 20/20. 05.41 14/14. Caixa 05.38.C 17/17. Vendas 05.40 13/13. Compras 05.64 T01–T08 OK.

## 17. Arquivos alterados

- `backend/motores/bancario/schema/bancarioSchema.js`
- `backend/motores/bancario/contracts/constantes.js`
- `backend/motores/bancario/contracts/TransacaoBancariaNormalizada.js`
- `backend/motores/bancario/services/TransacaoBancariaService.js` (novo)
- `backend/motores/bancario/services/ContaBancariaService.js`
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/motores/bancario/index.js`
- `backend/motores/bancario/version.js`
- `backend/rotas/bancario.js`
- `frontend/erp/pages/contas-bancarias.html`
- `frontend/erp/js/contas-bancarias.js`
- `tests/bancario/motor-bancario-02.test.js` (T25 alinhado à tabela real)
- `tests/bancario/motor-bancario-03.test.js` (novo)
- `docs/bancario/MBC-03-TRANSACOES-IDEMPOTENCIA-SALDOS.md`
- `docs/bancario/IMPLEMENTACAO_MBC_03_RELATORIO.md`

`database.js` já chamava `garantirSchemaBancario` (MBC-02); o schema passou a incluir a tabela de transações.

## 18. Pendências

Homologação visual no browser (não executada nesta entrega). Provider/Open Finance. Conciliação. Saldo inicial oficial.

## 19. Riscos

Duplicidade operacional sem `external_id`. Histórico incompleto até existir importação. Transferência ainda é um único registro, não um par entre contas.

## 20. Recomendação

MBC-04 — Conciliação bancária manual.
