# IMPLEMENTAÇÃO MBC-04

STATUS: CONCLUÍDA

## 1. STATUS

CONCLUÍDA

## 2. Arquitetura

Conciliação manual no Motor Bancário existente. `ConciliacaoBancariaService` + fachada em `MotorBancarioService`. Sem segundo motor. Sem escrita no financeiro.

## 3. Conceito

Vínculo explícito transação ↔ registro existente. PENDENTE derivado.

## 4. Tabela

`conciliacao_bancaria` + índice único parcial por transação ativa.

## 5. Estados

pendente (derivado), conciliada, ignorada, divergente. Desfazer: `ativo = 0`.

## 6. Empresa

Contexto oficial. Pagamento CR herda empresa da parcela.

## 7. Valor

Integral em FINANCEIRO e pagamento CR. Parcial só em `contas_receber.valor_restante`.

## 8. Direção

Receita/entrada, despesa/saída. Transferência recusada.

## 9. Desconciliação

Histórico preservado.

## 10. Histórico

Reconciliação com outro título após desfazer.

## 11. APIs

`/api/bancario/conciliacoes` (+ ignorar/divergente na transação).

## 12. UI

Seção Conciliação no extrato conceitual da conta.

## 13. Segurança

Permissão financeiro. Sem empresa por body/query.

## 14. Integração

Somente leitura do financeiro/CR.

## 15. Não implementado

Matching, Open Finance, OFX, PIX/TEF auto, DRE, alterações MIS/MUC/PDV/vendas/compras/caixa.

## 16. Testes

`tests/bancario/motor-bancario-04.test.js` T01–T35 + invariante (33/33).

## 17. Regressão

MBC-01, MBC-02, MBC-03, Financeiro 05.38.D / 05.41, Caixa 05.38.C, Vendas 05.40, Compras 05.64.

## 18. Arquivos

- `backend/motores/bancario/schema/bancarioSchema.js`
- `backend/motores/bancario/contracts/constantes.js`
- `backend/motores/bancario/services/ConciliacaoBancariaService.js` (novo)
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/motores/bancario/index.js`
- `backend/motores/bancario/version.js`
- `backend/rotas/bancario.js`
- `frontend/erp/pages/contas-bancarias.html`
- `frontend/erp/js/contas-bancarias.js`
- `tests/bancario/motor-bancario-04.test.js`
- `docs/bancario/MBC-04-CONCILIACAO-MANUAL.md`
- `docs/bancario/IMPLEMENTACAO_MBC_04_RELATORIO.md`

## 19. Pendências

Homologação visual no browser. Provider (MBC-05). Conciliação PIX/TEF. Transferência entre contas.

## 20. Riscos

FINANCEIRO sem saldo restante: não há parcial. `valor_restante` de CR pode divergir do total já vinculado no MBC se pagamentos forem baixados noutro módulo. Caixa não entra.

## 21. Recomendação

MBC-05 — Provider/Adaptador Bancário + Política de Secrets.
