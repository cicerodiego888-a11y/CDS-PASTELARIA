# MBC-05 — Fundação da Conciliação Financeira

**Status:** CONCLUÍDO  
**Sprint:** MBC-05  
**Data:** 2026-09-07

## 1. Objetivo

Consolidar a fundação oficial do motor de conciliação financeira sobre o MBC existente, de forma **provider-agnóstica**, permitindo relacionar uma `transacao_bancaria` a um ou mais objetos financeiros do CDS com rastreabilidade, multiempresa e controle de valor.

**Fora de escopo (respeitado):** IA, matching automático novo, conciliação automática, scheduler, webhook, score, categorização, regras por banco, E2E Itaú real.

## 2. Auditoria prévia

| Área | Achado |
|------|--------|
| `transacao_bancaria` | Já existe; fonte única de movimentações do MBC |
| `MotorBancarioService` | Já expõe conciliação via `ConciliacaoBancariaService` |
| `ConciliacaoBancariaService` | Já existia (MBC-04); **evoluído**, não recriado |
| Tabela `conciliacao_bancaria` | Já existia — **reutilizada** (não criar `conciliacao_financeira` paralela) |
| Matching (MBC-08) | Mantido; aceite passa a gravar `origem_conciliacao=SISTEMA` |
| Contas a pagar | Não há tabela `contas_pagar`; AP = `financeiro` tipo `despesa` |
| Vendas / compras | Não são alvos diretos de conciliação neste sprint |
| Multiempresa | `empresa_id` em TX, conciliação e alvos |

## 3. Entidades financeiras existentes (conciliáveis)

| ENTIDADE | TABELA | ID | TIPO | PODE SER CONCILIADA? | OBSERVAÇÃO |
|----------|--------|----|------|----------------------|------------|
| Lançamento financeiro | `financeiro` | `id` | receita/despesa | Sim | `ORIGEM_FINANCEIRA.FINANCEIRO` |
| Conta a receber | `contas_receber` | `id` | título | Sim (entrada) | Parcial permitido |
| Pagamento CR | `contas_receber_pagamentos` | `id` | recebimento | Sim (entrada) | Via join com `contas_receber.empresa_id` |
| Conta a pagar | — | — | — | Não (tabela) | Usar `financeiro` despesa |
| Venda | — | — | — | Não direto | Fora deste sprint |
| Compra | — | — | — | Não direto | Fora deste sprint |
| Transferência bancária | `transacao_bancaria` | — | transferência | Não conciliável | Bloqueada no service |

## 4. Nova estrutura

**Decisão:** evoluir `conciliacao_bancaria` (não criar tabela paralela).

Campos relevantes:

- `id`, `empresa_id`, `transacao_bancaria_id`
- `origem_financeira` + `registro_financeiro_id` (alvo polimórfico)
- `valor_conciliado`, `status`, `origem_conciliacao` (**novo**)
- `observacao`, `ativo`, `conciliado_em`, `desconciliado_em`, timestamps
- FK: `transacao_bancaria_id` → `transacao_bancaria`
- Alvo: validado no service (sem FK polimórfica impossível)

## 5. Estados

Reutilizados os status oficiais já existentes:

| Conceito do sprint | Status CDS |
|--------------------|------------|
| NÃO CONCILIADA | `pendente` (derivado: valor disponível > 0 e sem marcação ignorada/divergente) |
| CONCILIADA | `conciliada` quando `sum(valor_conciliado ativo) >= valor da TX` |
| CANCELADA | soft: `ativo=0` + `desconciliado_em` (histórico preservado) |
| — | `ignorada` / `divergente` (já existiam; mantidos) |

**Decisão:** não adicionar `EM_ANALISE`. Status da TX **não** ganhou coluna nova — derivado das conciliações.

## 6. Origem

`origem_conciliacao`:

- `MANUAL` (API/UI)
- `SISTEMA` (ex.: aceite de matching)

Futuro (`AUTOMATICA`, `IA`) **não** implementado.

## 7. Múltiplos alvos

Removido índice único `idx_conciliacao_bancaria_ativa_por_transacao`.

Novo único parcial: `idx_conciliacao_bancaria_vinculo_ativo` em  
`(empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id)` onde ativo + conciliada.

Permite 1 TX → N vínculos ativos distintos.

## 8. Regra de valor

`sum(valor_conciliado ativo) <= valor(transacao_bancaria)`.

Excesso → `MBC_VALORES_INCOMPATIVEIS` (“excede o disponível”).  
Disponível zero → `MBC_JA_CONCILIADA`.

## 9. Multiempresa

Validação obrigatória:

`transacao.empresa_id == conciliacao.empresa_id == alvo.empresa_id`

Empresa do contexto da API; `empresa_id` do body não é autoridade.

## 10. Service

`ConciliacaoBancariaService` (nome existente; equivalente a ConciliaçãoFinanceiraService):

- `listarPendentes` / `listar`
- `obterPorTransacao` / `obterNoContexto`
- `conciliar` / `desconciliar`
- `calcularValorConciliado` / `calcularValorDisponivel`
- validação empresa, direção, alvo, excesso, idempotência de vínculo
- auditoria via `registrarOperacaoMbc`

## 11. API

| Método | Rota | Função |
|--------|------|--------|
| GET | `/api/bancario/conciliacoes` | lista (incl. `?status=pendente`) |
| GET | `/api/bancario/conciliacoes/:id` | detalhe |
| GET | `/api/bancario/transacoes/:id/conciliacoes` | **novo** resumo por TX |
| POST | `/api/bancario/conciliacoes` | criar (MANUAL) |
| POST | `/api/bancario/transacoes/:id/conciliacoes` | **novo** criar no contexto da TX |
| POST | `/api/bancario/conciliacoes/:id/desconciliar` | cancelar soft |
| POST | `/api/bancario/conciliacoes/:id/cancelar` | **alias** cancelar |

## 12. Frontend

Contas Bancárias — UI mínima:

- Status **NÃO CONCILIADA** / **CONCILIADA**
- Quando conciliada/parcial: valor, alvo, origem, data; ação Cancelar
- Botão **Conciliar** quando ainda há disponível
- Modal usa valor disponível (não força TX inteira)

Sem dashboard completo de conciliação.

## 13. Banco

Migration embutida em `garantirSchemaBancario`:

- coluna `origem_conciliacao`
- DROP índice antigo por TX
- CREATE `idx_conciliacao_bancaria_vinculo_ativo`
- CREATE `idx_conciliacao_bancaria_alvo`
- índices empresa / status / transação mantidos
- `foreign_keys` respeitadas no padrão do projeto

## 14. Testes

Arquivo: `tests/bancario/motor-bancario-05.test.js`

Cobertura: criar, consultar, cancelar, disponível, excesso, multi-alvo, soma, multiempresa, alvo inexistente, direção, duplicidade, TX inexistente, rollback, auditoria, status, MP como TX, Itaú mock, schema.

`motor-bancario-04.test.js` T33 atualizado para o novo índice.

## 15. Mercado Pago

Validado como `transacao_bancaria` com `external_source` de provider — **sem ramo especial** no service de conciliação.

## 16. Itaú mock

Mesmo fluxo: TX com `external_source=ITAU` → `conciliar` — sem chamada E2E real.

## 17. Segurança

- Empresa só do contexto autenticado
- Alvo validado no backend
- Sem confiança em `empresa_id` do frontend
- Sem `if provider === …` na conciliação

## 18. Decisões arquiteturais

1. Reutilizar `conciliacao_bancaria` em vez de nova tabela.
2. Status da TX derivado, sem coluna duplicada.
3. Cancelamento soft (`ativo=0`), não hard delete.
4. Alvo polimórfico sem FK de banco.
5. Idempotência: mesmo vínculo + mesmo valor retorna o existente.
6. Provider fora do motor de conciliação.

## 19. Limitações

- Sem matching automático novo / IA / score
- Sem contas a pagar dedicadas
- Sem conciliação de transferência
- Matching legado ainda exige valor candidato = valor total da TX (não expandido)
- Filtros avançados (provider na listagem de pendentes) não adicionados além do suporte já existente (empresa, conta, período, direção)

## 20. Próximo sprint recomendado

**MBC-05.1 / MBC-17 — Conciliação assistida na UI + parcial no matching**

- Enriquecer tela de pendentes com filtros e detalhe multi-alvo
- Ajustar matching para respeitar `valor_disponivel` em TX parcialmente conciliada
- Avaliar alvo formal para contas a pagar se o ERP criar a entidade
